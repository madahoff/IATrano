# Déploiement en production — IATrano sur le serveur Dokploy

Ce guide part du dépôt Git et va jusqu'à l'application en service sur le **PC serveur**, géré par **Dokploy**. Il
fonctionne sans que le PC de développement reste allumé : le serveur clone le dépôt, construit les images et
conserve les données dans ses propres volumes Docker.

Chaque commande indique **où** l'exécuter :

- 💻 **PC de développement** (votre portable) ;
- 🖥️ **PC serveur**, dans un terminal (SSH ou session locale) ;
- 🌐 **interface Dokploy** (navigateur).

---

## 1. Architecture déployée

```
                         navigateur / smartphone
                                   │  http(s)://<domaine>
                                   ▼
                ┌──────── PC serveur ───────────────────────────────────────────┐
                │  Traefik (Dokploy) :80 / :443      Dokploy UI :3000            │
                │        │ dokploy-network                                       │
                │        ▼                                                       │
                │  ┌─ projet Compose « iatrano » (réseau interne) ─────────────┐ │
                │  │ app :3000  ──► db :5432 (PostgreSQL 17, volume iatrano-db)│ │
                │  │   │        ──► searxng :8080 (recherche Web)              │ │
                │  │   │ volume iatrano-documents (/app/data/documents)        │ │
                │  │ migrate (prisma migrate deploy, puis s'arrête)            │ │
                │  └───┼───────────────────────────────────────────────────────┘ │
                │      ├──► Ollama :11434 (hôte, GPU : qwen3:32b, embeddinggemma)│
                │      └──► JEV :8017 (hôte)                                     │
                └────────────────────────────────────────────────────────────────┘
```

| Service | Image | Port interne | Port publié sur l'hôte | Données persistantes |
|---|---|---|---|---|
| `app` | construite (`Dockerfile`, cible `runner`) | 3000 | **aucun** (Traefik) | volume `iatrano-documents` |
| `db` | `postgres:17-alpine` | 5432 | **aucun** | volume `iatrano-db` |
| `searxng` | construite (`searxng/Dockerfile`) | 8080 | **aucun** | — |
| `migrate` | construite (cible `migrator`) | — | — | — |

Choix : **un seul service Compose Dokploy**. Les quatre services forment une seule application (la base et
SearXNG ne servent qu'à IATrano, `migrate` doit s'exécuter avant `app` à chaque déploiement) ; les séparer en
applications Dokploy distinctes compliquerait l'ordre de démarrage sans rien apporter. Ollama et JEV restent
**hors** du Compose : ils sont déjà installés sur le serveur et peuvent servir d'autres applications.

Adresses à ne pas confondre :

| Usage | Adresse |
|---|---|
| Navigateur → IATrano | `https://<votre-domaine>` ou `http://<nom-tailscale>` (voir §5) — jamais `:3000` (Dokploy) |
| Traefik → app | `http://app:3000` sur `dokploy-network` (géré par Dokploy) |
| app → base | `db:5432` (nom DNS Docker, construit par `compose.yaml`) |
| app → SearXNG | `http://searxng:8080` |
| app → Ollama / JEV (sur l'hôte) | `http://100.121.17.90:11434` / `100.121.17.90:8017` (IP Tailscale du serveur) ou `host.docker.internal` (§3.3) |

Dans un conteneur, `localhost` désigne le conteneur lui-même : ne l'utilisez pour aucun de ces services.

**GPU** : seul Ollama l'utilise, sur l'hôte. Les conteneurs IATrano n'en ont pas besoin (OCR, PDF et vidéo
tournent sur CPU).

---

## 2. Sur le PC de développement 💻

### 2.1 Vérifications avant de pousser

```bash
pnpm install --frozen-lockfile
pnpm check                       # typecheck + lint + tests unitaires
pnpm build                       # build de production (attention : réécrit .next si un `next start` tourne)
docker compose config --quiet    # syntaxe de compose.yaml (avec un .env rempli, voir 2.3)
```

Tests d'intégration (base PostgreSQL de test requise, voir README § Tests) : `pnpm test:integration`.

### 2.2 Ce qui est versionné… ou pas

Versionnés : le code, `Dockerfile`, `compose.yaml`, `compose.ports.yaml`, `searxng/`, `prisma/migrations/`,
`.env.example`, `.env.production.example`, `scripts/`.

Jamais versionnés (`.gitignore`) : `.env*` réels, `data/` (documents de dev), `backups/`, `node_modules`, `.next`.
`.dockerignore` exclut aussi ces fichiers du contexte de build : aucun secret ni document local n'entre dans une image.

Contrôle des secrets avant de pousser :

```bash
git status --short                                   # aucun .env, aucun dump, aucun data/
git ls-files | grep -E '(^|/)\.env($|\.)' | grep -vE '\.env(\.production)?\.example$'   # doit être vide
git grep -nE '(AUTH_SECRET|POSTGRES_PASSWORD|SEARXNG_SECRET|JEV_API_KEY)=[^_ ]' -- ':!*.example' ':!*.md' ':!deploy'   # doit être vide
```

### 2.3 Préparer le fichier d'environnement de production

```bash
cp .env.production.example ~/iatrano-prod.env        # HORS du dépôt
chmod 600 ~/iatrano-prod.env
# Générer les secrets (copier chaque valeur dans le fichier) :
openssl rand -hex 24        # POSTGRES_PASSWORD  (lettres/chiffres uniquement)
openssl rand -base64 48     # AUTH_SECRET
openssl rand -hex 32        # SEARXNG_SECRET
openssl rand -base64 18     # SUPERADMIN_PASSWORD (ou votre propre mot de passe ≥ 12 caractères)
# JEV_API_KEY : recopier la valeur existante de /etc/jev/jev.env sur le serveur (ne PAS la régénérer).
node scripts/check-env.mjs ~/iatrano-prod.env        # doit afficher « Configuration valide »
```

Rangez ces secrets dans votre gestionnaire de mots de passe : **perdre `AUTH_SECRET` déconnecte tout le monde et
rend illisible la clé JEV enregistrée en base ; perdre `POSTGRES_PASSWORD` empêche l'application de se connecter
à la base existante.**

### 2.4 Livrer le code

```bash
git add -A && git commit -m "…" && git push origin main
```

Le serveur récupère le code depuis le dépôt distant (GitHub/GitLab/Gitea configuré dans Dokploy). Rien n'est
copié depuis le PC de développement.

---

## 3. Sur le PC serveur 🖥️

### 3.1 État vérifié à distance (2026-10-24, depuis le PC de développement via Tailscale)

| Élément | Constat |
|---|---|
| Adresse Tailscale | `100.121.17.90` (`sgdm-server-x870-aorus-elite-wifi7-ice.tailb8c39e.ts.net`) |
| Dokploy | interface sur le port **3000** de l'hôte (d'où l'absence de port publié par `compose.yaml`) |
| Traefik | ports 80 et 443 ouverts (404 par défaut) |
| Ollama | 0.40.6 sur `:11434`, modèles `qwen3:32b` et `embeddinggemma` |
| JEV | `:8017`, `/health` : `ready`, modèle `jevos-v5`, **clé API exigée** |
| SearXNG | rien sur `:8888` → le service `searxng` du Compose est nécessaire |
| Whisper (transcription) | rien sur `:8090` → transcription vidéo désactivée tant qu'il n'est pas installé |
| SSH | accès refusé depuis le PC de développement (pas de clé autorisée) : l'intérieur du serveur **n'a pas pu être inspecté** |

### 3.2 Diagnostic à exécuter sur le serveur (lecture seule)

```bash
uname -m && cat /etc/os-release | head -3           # architecture (x86_64 attendu : images amd64) et OS
docker version --format 'Docker {{.Server.Version}}' && docker compose version
nproc && free -h && df -h / /var/lib/docker          # prévoir ≥ 10 Go libres pour les images et le cache de build
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv   # GPU utilisé par Ollama
sudo ss -ltnp | grep -E ':(80|443|3000|5432|8017|8080|11434)\b'      # qui écoute où
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker network ls | grep dokploy-network
systemctl cat ollama | grep -i OLLAMA_HOST           # adresse d'écoute d'Ollama
sudo ufw status verbose 2>/dev/null || sudo nft list ruleset | head -50
docker run --rm busybox nslookup registry-1.docker.io   # le démon Docker résout-il le DNS ? (sinon le build échoue)
```

Points à confirmer avec ce diagnostic :

- **Architecture** `x86_64` : les images de base (`node`, `postgres`, `searxng`) sont multi-architecture, aucun
  changement nécessaire sur `aarch64` non plus.
- **Espace disque** : images finales ≈ 2,1 Go (app 560 Mo, migrate 1,3 Go, SearXNG 265 Mo, PostgreSQL 300 Mo) +
  cache de build ; plus le volume des documents (jusqu'à 300 Mo par fichier importé, réglable).
- **Ollama** : s'il écoute sur `127.0.0.1` seulement, les conteneurs ne le joignent pas (voir 3.3).

### 3.3 Accès des conteneurs à Ollama et JEV

Les deux tournent sur l'hôte. Deux adresses possibles depuis le conteneur `app` :

1. **IP Tailscale** `100.121.17.90` (valeur par défaut de `.env.production.example`) : fonctionne si le service
   écoute sur `0.0.0.0` ou sur cette IP — c'est le cas aujourd'hui puisqu'ils répondent depuis le tailnet.
   Dépend de Tailscale actif sur le serveur.
2. **`host.docker.internal`** (déjà déclaré par `extra_hosts: host-gateway`) : nécessite une écoute sur `0.0.0.0`
   et un pare-feu qui accepte les réseaux Docker (`172.16.0.0/12`).

Ollama et JEV n'ont pas d'authentification réseau forte (Ollama : aucune). S'ils écoutent sur `0.0.0.0`, limitez
l'accès au pare-feu : réseaux Docker + Tailscale seulement, pas le LAN ni Internet :

```bash
sudo ufw allow in on tailscale0 to any port 11434 proto tcp
sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp
sudo ufw deny 11434/tcp
# idem pour 8017 (JEV)
```

Vérification **depuis le conteneur**, après le premier déploiement (§4.4).

### 3.4 Prérequis réseau du serveur

- Sortie Internet en 80/443 pour : le build (Docker Hub, registre npm, dépôts Alpine), SearXNG (moteurs de
  recherche) et l'application (lecture des pages des résultats). Pas de proxy sortant prévu par l'application.
- Résolution DNS fonctionnelle **dans le démon Docker** (dernière commande du §3.2). Sur le PC de
  développement (Docker snap), elle échoue : les moteurs SearXNG n'ont donc pas pu être testés jusqu'à Internet ici.

---

## 4. Configuration dans Dokploy 🌐

### 4.1 Créer le service

1. *Projects → Create Project* : `iatrano`.
2. *Create Service → Compose* : nom `iatrano` (Dokploy en dérive un **App Name**, ex. `iatrano-a1b2c3` : c'est le
   nom du projet Docker Compose, à utiliser avec les scripts de sauvegarde).
3. *General → Provider* : dépôt Git, **branche `main`**, *Compose Path* `./compose.yaml`, type *Docker Compose*.
4. Laissez *Isolated Deployment* désactivé (inutile : aucun nom de service n'entre en conflit avec d'autres
   applications, chaque projet Compose a son propre réseau interne).

### 4.2 Variables d'environnement

*Environment* : collez le contenu du fichier préparé en 2.3. Dokploy l'écrit dans un `.env` à côté de
`compose.yaml` ; `compose.yaml` transmet ensuite à chaque conteneur uniquement ce dont il a besoin :

| Variable | db | migrate | app | searxng | build |
|---|:-:|:-:|:-:|:-:|:-:|
| `POSTGRES_PASSWORD`, `POSTGRES_USER`, `POSTGRES_DB` | ✔ | ✔ (via `DATABASE_URL`) | ✔ (via `DATABASE_URL`) | | |
| `AUTH_SECRET`, `SUPERADMIN_*`, `COOKIE_SECURE`, `TRUST_PROXY`, `RATE_LIMIT_*` | | | ✔ | | |
| `AI_*`, `JEV_*`, `DOCUMENT_*`, `SEARCH_PROVIDER`, `SEARXNG_URL`, `BRAVE_SEARCH_API_KEY`, `NODE_OPTIONS` | | | ✔ | | |
| `SEARXNG_SECRET` | | | | ✔ | |
| `SEARXNG_IMAGE` | | | | | ✔ (searxng) |
| `NODE_VERSION`, `WITH_FFMPEG`, `WITH_TESSERACT` | | | | | ✔ (app, migrate) |
| `APP_MEMORY_LIMIT`, `APP_CPU_LIMIT`, `DB_MEMORY_LIMIT` | limites | | limites | | |

Aucune variable n'est destinée au navigateur (pas de `NEXT_PUBLIC_*`) : aucune n'est figée dans le JavaScript
client, et changer une variable d'exécution ne demande qu'un redéploiement, pas de modification du code.

### 4.3 Domaine

*Domains → Add Domain* : **Service** `app`, **Container port** `3000`, chemin `/`. Dokploy ajoute les labels
Traefik et le réseau `dokploy-network` au service `app` au moment du déploiement (*Preview Compose* pour vérifier).
Choix du nom : §5.

### 4.4 Premier déploiement et vérifications

*Deploy*. Ordre : `db` (healthy) → `migrate` (applique les 11 migrations, s'arrête avec le code 0) → `app`.
`searxng` démarre en parallèle. Dans *Logs*, `app` doit afficher `Super-administrateur … créé.`

Vérifications 🖥️ (remplacez `P` par l'App Name Dokploy ; préfixez chaque commande `docker` par `sudo` si votre
compte n'appartient pas au groupe `docker` — erreur « permission denied … docker.sock ») :

```bash
P=iatrano-a1b2c3
docker ps --filter label=com.docker.compose.project=$P --format 'table {{.Names}}\t{{.Status}}'
APP=$(docker ps -q --filter label=com.docker.compose.project=$P --filter label=com.docker.compose.service=app)
docker exec $APP node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
docker exec $APP node -e "fetch('http://100.121.17.90:11434/api/version').then(r=>r.text()).then(console.log)"
docker exec $APP node -e "fetch('http://100.121.17.90:8017/health').then(r=>r.text()).then(console.log)"
docker exec $APP node -e "fetch('http://searxng:8080/search?q=test&format=json').then(r=>r.json()).then(d=>console.log(d.results.length,'résultats',d.unresponsive_engines))"
docker logs --tail 50 $APP
```

Puis dans IATrano 🌐 (compte super-admin) :

1. *Administration → État* : PostgreSQL et serveur IA en vert.
2. *Administration → Serveur IA* : choisir le modèle par défaut **`qwen3:32b`** (non défini par l'environnement).
3. *Administration → Recherche Web → Tester* : des résultats doivent revenir (sinon : DNS/sortie Internet).
4. *Administration → Connexion JEV → Tester* : toutes les étapes en vert (sinon : `JEV_API_KEY`).
5. *Administration → Documents* : embeddings `embeddinggemma`, OCR « tesseract » détecté.
6. Changer le mot de passe du super-administrateur (*Paramètres*), puis retirer `SUPERADMIN_PASSWORD` des
   variables Dokploy (il ne sert qu'à la création initiale ; `compose.yaml` l'exige encore : remplacez-le par une
   valeur aléatoire `openssl rand -base64 18`).
7. Envoyer un message dans le chat, importer un PDF dans un projet.

---

## 5. Accès à l'application : domaine, HTTPS

Aucun domaine public n'a été communiqué ; choisissez une option.

### Option A — Accès par Tailscale uniquement (aucune exposition Internet)

- Domaine Dokploy : `sgdm-server-x870-aorus-elite-wifi7-ice.tailb8c39e.ts.net` (nom MagicDNS existant), **HTTP**,
  sans certificat. URL : `http://sgdm-server-x870-aorus-elite-wifi7-ice.tailb8c39e.ts.net`.
- Le trafic est chiffré par WireGuard (Tailscale) ; seuls les appareils de votre tailnet y accèdent (smartphone
  compris, avec l'application Tailscale).
- Variables : `COOKIE_SECURE=auto`, `TRUST_PROXY=true`.
- Let's Encrypt ne fonctionne pas sur un nom `.ts.net` via Traefik ; pour du HTTPS, utilisez les certificats
  Tailscale (`tailscale cert`) importés dans Traefik — facultatif.

### Option B — Domaine public (Internet)

Prérequis à vérifier : IP publique fixe ou DNS dynamique, **pas de CGNAT** chez le fournisseur d'accès, et accès
à la box/au routeur.

1. DNS : enregistrement `A` `iatrano.<votre-domaine>` → IP publique du site.
2. Routeur : redirection TCP 80 et 443 → IP LAN du serveur (uniquement ces deux ports ; jamais 3000, 5432, 11434, 8017).
3. Dokploy : domaine `iatrano.<votre-domaine>`, **HTTPS** activé, certificat **Let's Encrypt**.
4. Variables : `COOKIE_SECURE=true`, `TRUST_PROXY=true`.
5. Protégez l'interface Dokploy (port 3000) : ne la redirigez pas sur Internet ; accès par Tailscale/LAN.

### Option C — Réseau local uniquement

Domaine local (ex. `iatrano.lan`) résolu par votre DNS local ou `/etc/hosts` des postes vers l'IP LAN du serveur,
en HTTP. `COOKIE_SECURE=auto`.

### Gros imports et délais du reverse proxy

Les imports de documents (jusqu'à 300 Mo par défaut) sont envoyés en un seul flux. Traefik v3 coupe par défaut la
lecture d'une requête après **60 s** (`respondingTimeouts.readTimeout`, à vérifier dans la configuration Traefik de
Dokploy : *Settings → Traefik*). Si de gros fichiers échouent sur une connexion lente, augmentez ce délai pour les
entrypoints `web`/`websecure` (ex. `readTimeout: 30m`). Les réponses longues en streaming (chat) ne sont pas
concernées.

---

## 6. Migrations

- Le service `migrate` exécute `prisma migrate deploy` à **chaque** déploiement : il applique uniquement les
  migrations en attente, dans l'ordre, et **ne réinitialise jamais** la base. `app` ne démarre que s'il réussit.
- Créer une migration : 💻 `pnpm db:migrate` (base de développement), commiter `prisma/migrations/…`, pousser.
- Échec d'une migration : `app` reste sur l'ancien conteneur arrêté → consultez *Logs → migrate*, corrigez, redéployez.
  N'utilisez jamais `prisma migrate reset` ni `db push` en production.
- État : `docker exec <db> sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select migration_name, finished_at from _prisma_migrations order by 1"'`.
- Les migrations `20261024000100_memory_v2_project_merge` (fusion ProjectMemory → Memory) modifient des données :
  faites une sauvegarde avant le premier déploiement sur une base existante.

---

## 7. Exploitation

### Journaux

- 🌐 Dokploy : *Logs* de chaque service ; *Administration → Journal* dans IATrano (erreurs IA, échecs de connexion).
- 🖥️ `docker logs -f --tail 100 <conteneur>`. Rotation configurée : 5 × 10 Mo par service (1 Mo pour SearXNG).
- Les secrets sont masqués dans le journal applicatif ; `check-env.mjs` n'affiche aucune valeur.

### Santé et redémarrage

- Healthchecks : `app` (`/api/health` : processus + base), `db` (`pg_isready`), `searxng` (`/healthz`).
- `restart: unless-stopped` partout (sauf `migrate`) : redémarrage après crash ou reboot du serveur.
- Arrêt propre : tini en PID 1 transmet SIGTERM ; Next.js termine puis sort (code 143, normal). Une réponse
  interrompue est marquée comme telle à la reprise ; un traitement de document interrompu est repris après 2 min.

### Ressources

Mesuré au repos : app ≈ 60 Mo, SearXNG ≈ 100 Mo, PostgreSQL ≈ 30 Mo. Les limites (`APP_MEMORY_LIMIT=4g`,
`APP_CPU_LIMIT=4`, `DB_MEMORY_LIMIT=2g`, SearXNG 512 Mo) bornent les pics (OCR, rendu de PDF, ffmpeg) pour
préserver Ollama, qui consomme l'essentiel (qwen3:32b ≈ 20 Go). Observez `docker stats` sous charge réelle et
ajustez. Le pool de connexions Prisma par défaut (nombre de CPU × 2 + 1) est suffisant pour une instance unique.
Concurrence des documents : *Administration → Documents* (1 par défaut ; l'analyse est limitée par le LLM).

Une seule instance de `app` est prévue : la limitation de débit est en mémoire du processus. Ne mettez pas de
réplicas sans adapter ce point.

### Mise à jour

1. 💻 `pnpm check`, commit, `git push origin main`.
2. 🖥️ Sauvegarde : `sh scripts/backup.sh -p $P -o /srv/backups/iatrano` (§8).
3. 🌐 *Deploy* (ou *Auto Deploy* par webhook). Les volumes sont conservés.
4. Vérifier *Logs* (`migrate` code 0, `app` healthy) et §4.4.

### Retour arrière (rollback)

- Code sans nouvelle migration : 🌐 redéployer le commit précédent (*Deployments* → version précédente, ou
  `git revert` + push).
- Code avec migration déjà appliquée : Prisma ne « défait » pas une migration. Restaurez la sauvegarde prise avant
  la mise à jour (§8) **puis** redéployez l'ancien commit.

---

## 8. Sauvegardes et restauration

Données à protéger :

| Donnée | Emplacement | Sauvegardée par |
|---|---|---|
| Base (comptes, conversations, mémoire, index, réglages, clé JEV chiffrée) | volume `<P>_iatrano-db` | `scripts/backup.sh` (pg_dump) |
| Fichiers des documents et dérivés | volume `<P>_iatrano-documents` | `scripts/backup.sh` (tar) |
| Secrets (`AUTH_SECRET`, `POSTGRES_PASSWORD`…) | variables Dokploy | **vous** (gestionnaire de mots de passe) |

Le cache OCR et les imports en cours ne sont pas sauvegardés (régénérables).

```bash
# 🖥️ dans une copie du dépôt sur le serveur (ou en copiant le dossier scripts/)
sudo mkdir -p /srv/backups/iatrano && sudo chown $USER /srv/backups/iatrano
sh scripts/backup.sh -p $P -o /srv/backups/iatrano -k 14      # garde les 14 plus récentes

# Tous les jours à 3 h (crontab -e de l'utilisateur ayant accès à Docker) :
0 3 * * * cd /chemin/IATrano && sh scripts/backup.sh -p iatrano-a1b2c3 -o /srv/backups/iatrano -k 14 >> /srv/backups/iatrano/backup.log 2>&1
```

Copiez ensuite `/srv/backups/iatrano` hors du serveur (autre disque, NAS, `rclone` vers S3). Dokploy propose aussi
des *Volume Backups* vers S3 pour les volumes nommés.

Restauration (remplace la base et les documents actuels ; une sauvegarde de sécurité est prise automatiquement
avant, l'application est arrêtée pendant l'opération puis relancée) :

```bash
sh scripts/restore.sh -p $P -d /srv/backups/iatrano/AAAA-MM-JJ_HHMMSS --yes
```

Sur un **serveur neuf** : déployez d'abord (§4, mêmes `AUTH_SECRET` et version du code ou plus récente), puis
restaurez. Sans le même `AUTH_SECRET`, les sessions sont invalidées et la clé JEV doit être ressaisie.

Ces scripts ont été testés (2026-10-24) : sauvegarde à chaud, suppression d'un projet, restauration (fichier
identique à l'octet près, session conservée), et restauration dans une pile vierge.

---

## 9. Sécurité — récapitulatif

- Aucun port publié par `compose.yaml` : PostgreSQL, SearXNG et l'application ne sont joignables que par le réseau
  Docker ; l'application uniquement via Traefik. `TRUST_PROXY=true` est donc sûr (X-Forwarded-For réécrit par
  Traefik ; un accès direct permettrait de le falsifier et de contourner la limitation des connexions).
- Conteneur `app` non root (uid 1001), `searxng` sans capacités superflues ; `migrate` s'exécute brièvement.
- Secrets uniquement dans les variables Dokploy, jamais dans Git ni dans les images (`.dockerignore`).
- `AUTH_SECRET` < 32 caractères en production : l'application refuse de démarrer (message `[config]`).
- Pas de CORS ouvert : l'API n'est utilisée que par la même origine ; les mutations vérifient l'en-tête `Origin`.
- Interfaces d'administration : rôles vérifiés côté serveur (404 pour les non-administrateurs). L'interface
  Dokploy (port 3000) ne doit pas être exposée sur Internet.
- `pnpm audit` à lancer régulièrement sur le PC de développement ; mettez à jour `NODE_VERSION`, `postgres:17-alpine`
  et `SEARXNG_IMAGE` volontairement, après test.
