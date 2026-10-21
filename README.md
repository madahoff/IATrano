# IATrano

Plateforme de chat IA **locale et auto-hébergée** : une interface moderne inspirée de ChatGPT et Claude, branchée sur **vos propres modèles** (Ollama, LM Studio, llama.cpp, vLLM…), avec comptes utilisateurs, conversations persistantes, mode Thinking, questions de précision et administration sécurisée. Aucune API payante n'est nécessaire.

- Next.js 16 (App Router) · TypeScript strict · Tailwind CSS 4 · shadcn/ui (Radix) · Lucide
- PostgreSQL + Prisma · Zod · Vitest
- Docker / Docker Compose, compatible **Dokploy**

---

## Sommaire

1. [Fonctionnalités](#fonctionnalités)
2. [Prérequis](#prérequis)
3. [Architecture](#architecture)
4. [Démarrage local avec pnpm](#démarrage-local-avec-pnpm)
5. [Connecter votre Qwen existant](#connecter-votre-qwen-existant)
6. [Variables d'environnement](#variables-denvironnement)
7. [Super-administrateur initial](#super-administrateur-initial)
8. [Démarrage avec Docker Compose](#démarrage-avec-docker-compose)
9. [Déploiement avec Dokploy](#déploiement-avec-dokploy)
10. [Réseau : quelle adresse pour le serveur IA ?](#réseau--quelle-adresse-pour-le-serveur-ia-)
11. [Modèles, Thinking et capacités des fournisseurs](#modèles-thinking-et-capacités-des-fournisseurs)
12. [Questions de précision](#questions-de-précision)
13. [Sécurité](#sécurité)
14. [Migrations et maintenance](#migrations-et-maintenance)
15. [Tests](#tests)
16. [Dépannage](#dépannage)
17. [Limites connues](#limites-connues)

---

## Fonctionnalités

**Chat**
- Réponses en streaming, Markdown (GFM, tableaux), blocs de code colorés avec bouton de copie.
- Annulation d'une génération (la partie déjà reçue est conservée), régénération de la dernière réponse, modification d'un ancien message avec régénération de la suite.
- Zone de saisie auto-extensible (Entrée envoie, Maj+Entrée = nouvelle ligne ; sur écran tactile, Entrée = nouvelle ligne).
- Sélecteur de modèle dans l'en-tête, qui n'affiche que les modèles **réellement détectés**, avec un état explicite si un modèle ou le serveur est indisponible. Le modèle est mémorisé par conversation et par réponse.
- **Thinking** activable par message, uniquement si le modèle le prend en charge. Le raisonnement renvoyé par le fournisseur s'affiche dans une zone repliable, séparée de la réponse et conservée en base.
- **Questions de précision** contextuelles (non systématiques), avec réponses à choisir ou réponse libre.
- Gestion des erreurs : serveur injoignable, modèle absent, réponse vide, coupure réseau. Chaque cas affiche un message clair et une piste de résolution.

**Conversations** : barre latérale groupée par date, recherche **côté serveur** (titres et contenu des messages, index trigrammes), renommage, archivage, suppression confirmée, titres générés automatiquement. Sur mobile, la barre devient un panneau coulissant.

**Comptes** : authentification réelle (mots de passe scrypt, sessions en base, cookies `httpOnly`), profil, changement de mot de passe, sessions actives révocables, rôles `USER` / `ADMIN` / `SUPERADMIN`, isolation stricte des données.

**Administration** (`/admin`) : état de l'application (base, serveur IA, compteurs), configuration et test du serveur IA, détection automatique, modèles disponibles, modèle et Thinking par défaut, instructions système, gestion des utilisateurs et des rôles, journal technique.

**Design** : surfaces unies, sans dégradé, ombre ni bordure ; coins très arrondis ; noir, blanc et gris, avec des accents rouge, vert et jaune réservés aux états ; modes clair et sombre ; navigation au clavier avec indicateurs de focus. Les jetons sont centralisés dans [`src/app/globals.css`](src/app/globals.css).

---

## Prérequis

| Outil | Version testée | Usage |
|---|---|---|
| Node.js | 22.x (24 compatible) | développement local |
| pnpm | 10.x | gestionnaire de paquets |
| Docker + Compose v2 | 29 / v5 | base de développement, production |
| Un moteur IA | Ollama 0.30.7 testé | Ollama, LM Studio, llama.cpp, vLLM… |

---

## Architecture

```
navigateur ──HTTP──▶ Next.js (UI + routes /api) ──▶ PostgreSQL (Prisma)
                           │
                           └──HTTP (côté serveur uniquement)──▶ moteur IA (Ollama / API OpenAI)
```

Le navigateur ne contacte **jamais** directement le moteur IA : c'est le serveur Next.js qui le joint. Il n'y a pas de backend séparé, car les route handlers de Next.js suffisent, y compris pour le streaming.

```
prisma/                 schéma + migrations SQL
src/
  app/
    (chat)/             interface de chat (/, /c/[id]) + barre latérale
    admin/              administration (layout protégé côté serveur)
    settings/           paramètres utilisateur
    login/              connexion
    api/                routes : auth, chat (streaming), conversations, models, me, admin/*
  components/
    ui/                 composants shadcn/ui adaptés au design system (sans bordure ni ombre)
    chat/               vue de chat, saisie, messages, Thinking, clarifications, Markdown
    layout/ admin/ settings/ common/
  lib/
    auth/               mots de passe (scrypt), sessions, permissions, gardes
    llm/                couche fournisseurs : types, ollama, openai-compatible, registry,
                        discovery, analyse <think>/<clarify>, prompts, URL et diagnostics réseau
    chat/               protocole de streaming, accès aux conversations, orchestration de la génération
    settings/ users/    paramètres globaux et utilisateurs, administration des comptes
    bootstrap.ts        initialisation idempotente (super-admin, configuration)
  instrumentation.ts    lance le bootstrap au démarrage du serveur
  proxy.ts              redirection rapide vers /login (le contrôle réel reste côté serveur)
tests/unit              tests unitaires (sans base)
tests/integration       tests sur une vraie base PostgreSQL + tests optionnels contre un vrai LLM
```

**Choix notables**
- **Abstraction des fournisseurs** ([`src/lib/llm/types.ts`](src/lib/llm/types.ts)) : `listModels`, `chatStream` (fragments `thinking` / `text` / `done`), `complete`, `completeJson`, `testConnection`. Pour ajouter un fournisseur, il suffit d'implémenter `LlmProvider` et de l'enregistrer dans [`registry.ts`](src/lib/llm/registry.ts).
- **Protocole de streaming** ([`src/lib/chat/protocol.ts`](src/lib/chat/protocol.ts)) : NDJSON, un événement JSON par ligne (`start`, `thinking`, `text`, `clarification`, `notice`, `done`, `error`, `title`). Le raisonnement n'est jamais mélangé à la réponse, et une ligne corrompue est ignorée sans interrompre la conversation.
- **Persistance pendant la génération** : la réponse est enregistrée progressivement (toutes les secondes) puis finalisée avec l'état `COMPLETE`, `CANCELLED` ou `ERROR`. Une coupure réseau ou un redémarrage ne corrompt pas l'historique.
- **Cache Components désactivé** (`next.config.ts`) : l'application est entièrement authentifiée et dynamique, un shell statique n'apporterait rien.
- **Sortie `standalone`** pour une image Docker légère.

---

## Démarrage local avec pnpm

```bash
pnpm install
cp .env.example .env            # puis éditez .env (voir ci-dessous)
pnpm db:up                      # PostgreSQL de développement (compose.dev.yaml, port 127.0.0.1:5442)
pnpm db:deploy                  # applique les migrations
pnpm dev                        # http://localhost:3000
```

Dans `.env`, renseignez au minimum :

```dotenv
DATABASE_URL=postgresql://iatrano:iatrano@localhost:5442/iatrano
AUTH_SECRET=<openssl rand -base64 48>
SUPERADMIN_EMAIL=vous@example.com
SUPERADMIN_PASSWORD=<au moins 12 caractères>
AI_PROVIDER=ollama
AI_BASE_URL=http://localhost:11434
```

- Si le port 3000 est déjà pris : `PORT=3110 pnpm dev`.
- Si le port 5442 est pris : `DEV_DB_PORT=5443 pnpm db:up`, puis adaptez `DATABASE_URL`.
- En développement, après une modification de `prisma/schema.prisma` : `pnpm db:migrate`.

---

## Connecter votre Qwen existant

1. **Vérifiez que le modèle est visible par le moteur** :
   ```bash
   ollama list                               # doit afficher votre modèle, ex. qwen2.5:3b
   curl http://localhost:11434/api/tags      # même liste via l'API
   ```
   Si `ollama list` est vide alors que le modèle « existe », il a été installé par un autre utilisateur ou dans un autre dossier `OLLAMA_MODELS`. Le service systemd `ollama` cherche par défaut dans `/usr/share/ollama/.ollama/models`.
2. Démarrez IATrano, connectez-vous avec le super-administrateur, puis ouvrez **Administration → Serveur IA**.
3. Cliquez sur **Détecter automatiquement**, ou saisissez l'adresse (`http://localhost:11434` hors Docker), puis **Tester la connexion** et **Enregistrer**.
4. Dans **Modèles disponibles**, votre Qwen apparaît avec ses métadonnées (taille, quantification, contexte) et ses capacités. Choisissez-le comme **modèle par défaut**.
5. Revenez au chat : le sélecteur affiche le modèle et vous pouvez discuter.

Avec LM Studio ou llama.cpp, choisissez le type **Compatible OpenAI** et l'adresse `http://localhost:1234/v1` (LM Studio) ou `http://localhost:8080/v1` (llama-server).

---

## Variables d'environnement

| Variable | Obligatoire | Description |
|---|---|---|
| `DATABASE_URL` | oui (hors Docker) | URL PostgreSQL. En Compose, elle est construite automatiquement. |
| `POSTGRES_PASSWORD` | oui (Docker) | Mot de passe PostgreSQL ; lettres et chiffres uniquement (`openssl rand -hex 24`). |
| `POSTGRES_USER`, `POSTGRES_DB` | non | `iatrano` par défaut. |
| `AUTH_SECRET` | oui en production | ≥ 32 caractères, clé HMAC des jetons de session (`openssl rand -base64 48`). |
| `SUPERADMIN_EMAIL` | oui | E-mail du super-administrateur initial. |
| `SUPERADMIN_PASSWORD` | oui | ≥ 12 caractères ; utilisé **uniquement** à la création initiale. |
| `SUPERADMIN_NAME` | non | Nom affiché. |
| `AI_PROVIDER` | non | `ollama` (défaut) ou `openai` (serveur compatible OpenAI). Valeur initiale. |
| `AI_BASE_URL` | non | Adresse du moteur IA **vue depuis le serveur**. Valeur initiale, modifiable dans l'administration. |
| `AI_API_KEY` | non | Clé pour un serveur compatible OpenAI protégé. |
| `AI_URL_ALLOWLIST` | non | Liste blanche d'hôtes autorisés pour le serveur IA (`10.0.0.5,host.docker.internal`). |
| `COOKIE_SECURE` | non | `auto` (défaut : `Secure` si HTTPS détecté), `true` ou `false`. |
| `TRUST_PROXY` | non | `true` derrière un reverse proxy (IP client via `X-Forwarded-For`). `true` par défaut en Compose. |
| `RATE_LIMIT_GENERATIONS_PER_MINUTE` | non | 20 par défaut, par utilisateur. |
| `APP_PORT`, `APP_BIND` | non | Port et interface publiés par Docker Compose (`3000`, `0.0.0.0`). |
| `NODE_VERSION` | non | Image Node du build Docker (`22-alpine` par défaut). |

`AI_PROVIDER`, `AI_BASE_URL` et `AI_API_KEY` ne servent qu'à **initialiser** la configuration lors du premier démarrage. Elle est ensuite stockée en base et se modifie dans l'administration.

---

## Super-administrateur initial

Au démarrage du serveur ([`src/lib/bootstrap.ts`](src/lib/bootstrap.ts), appelé par `instrumentation.ts`) :

- si **aucun** super-administrateur n'existe et que `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` (≥ 12 caractères) sont définis, le compte est créé avec un mot de passe haché (scrypt) ;
- dans tous les autres cas, rien n'est modifié : un redémarrage ne recrée pas le compte et **ne réinitialise jamais** le mot de passe ;
- si l'e-mail appartient déjà à un compte non administrateur, il n'est **pas** élevé automatiquement (un avertissement est journalisé).

Aucun identifiant n'est codé en dur. Après la première connexion, changez le mot de passe dans **Paramètres → Compte**. Vous pouvez ensuite retirer `SUPERADMIN_PASSWORD` de l'environnement.

---

## Démarrage avec Docker Compose

```bash
cp .env.example .env
# Renseignez POSTGRES_PASSWORD, AUTH_SECRET, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD
# et AI_BASE_URL=http://host.docker.internal:11434 si Ollama tourne sur la machine hôte
docker compose up --build -d
docker compose ps        # app : healthy, migrate : exited (0), db : healthy
```

Services de [`compose.yaml`](compose.yaml) :

| Service | Rôle |
|---|---|
| `db` | PostgreSQL 17, volume persistant `iatrano-db`, **aucun port publié** (joignable uniquement par les autres services). |
| `migrate` | Exécute `prisma migrate deploy` (migrations en attente uniquement, jamais de reset), puis s'arrête. |
| `app` | Next.js en mode production (`node server.js`, écoute sur `0.0.0.0:3000`), utilisateur non-root, healthcheck sur `/api/health`. Démarre après la réussite de `migrate`. |

L'application est accessible sur `http://<IP-de-la-machine>:${APP_PORT}` (3000 par défaut), y compris depuis un smartphone du même réseau.

> **Important pour Ollama sur l'hôte Linux :** par défaut, Ollama n'écoute que sur `127.0.0.1`, donc le conteneur ne peut pas le joindre (l'application affiche alors « Connexion refusée par host.docker.internal:11434 » avec la solution). Voir [la section réseau](#ollama-sur-la-machine-hôte-et-application-dans-docker).

---

## Déploiement avec Dokploy

1. **Créer le service** : *Project → Create Service → Compose*, source Git (ce dépôt), *Compose Path* : `./compose.yaml`.
2. **Environment** : collez les variables (au minimum `POSTGRES_PASSWORD`, `AUTH_SECRET`, `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`, `AI_BASE_URL`). Gardez `COOKIE_SECURE=auto` et `TRUST_PROXY=true`.
3. **Domaine** : *Domains → Add Domain*, service `app`, port `3000`, HTTPS (Let's Encrypt) si le domaine est public, ou HTTP pour un nom local.
   - Le reverse proxy Traefik de Dokploy suffit. Pour ne pas publier aussi un port sur l'hôte, supprimez le bloc `ports:` du service `app`, ou réglez `APP_PORT` sur un port libre.
4. **Deploy**. À chaque déploiement, `migrate` applique les migrations en attente puis `app` démarre. Le volume nommé `iatrano-db` est conservé entre les redéploiements et les redémarrages.
5. **Topologie IA** :
   - moteur IA sur **le même serveur** que Dokploy : `AI_BASE_URL=http://host.docker.internal:11434`. `extra_hosts: host-gateway` est déjà configuré ; Ollama doit écouter sur `0.0.0.0` (voir ci-dessous) ;
   - moteur IA sur **une autre machine** : `AI_BASE_URL=http://192.168.x.y:11434`, et le moteur doit accepter les connexions réseau.
6. **Vérification** : *Administration → État* doit afficher PostgreSQL et le serveur IA en vert.

> Si `docker compose build` échoue sur Dokploy avec une erreur DNS sur `registry-1.docker.io`, c'est le démon Docker de la machine qui n'a pas accès à Internet ou au DNS. Corrigez la configuration réseau du démon, ou pré-téléchargez `node:22-alpine` et `postgres:17-alpine`.

---

## Réseau : quelle adresse pour le serveur IA ?

Il y a **deux adresses distinctes** :

- celle que **votre navigateur** utilise pour ouvrir IATrano (`http://192.168.1.10:3000`, un domaine…) ;
- celle que **le serveur IATrano** utilise pour joindre le moteur IA (Administration → Serveur IA).

L'application ne déduit jamais la seconde de la première. Un navigateur ne peut pas non plus détecter les modèles d'une autre machine ni parcourir son disque : la détection est faite **par le serveur**, qui sonde les adresses usuelles (`localhost` et `host.docker.internal` sur les ports 11434, 1234 et 8080) ainsi que l'adresse configurée.

| Situation | Adresse à configurer |
|---|---|
| `pnpm dev` et Ollama sur la même machine | `http://localhost:11434` |
| IATrano dans Docker, Ollama installé sur l'hôte | `http://host.docker.internal:11434` + Ollama écoutant sur `0.0.0.0` |
| IATrano (Docker ou Dokploy) et Ollama sur une autre machine | `http://IP-de-la-machine-IA:11434` |
| LM Studio | `http://hôte:1234/v1` (activez *Serve on Local Network* si distant) |
| llama.cpp (`llama-server --host 0.0.0.0 --port 8080`) | `http://hôte:8080/v1` |
| Vous ouvrez IATrano depuis un smartphone | rien à changer : seul le serveur joint le moteur IA |

Dans un conteneur, `localhost` désigne **le conteneur lui-même**, pas votre ordinateur.

### Ollama sur la machine hôte et application dans Docker

Ollama écoute par défaut sur `127.0.0.1:11434` et n'est donc pas joignable depuis un conteneur. Avec le service systemd :

```bash
sudo systemctl edit ollama
# ajoutez dans la section [Service] (à côté de vos variables CUDA existantes) :
#   Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl daemon-reload
sudo systemctl restart ollama
ss -ltn | grep 11434        # doit afficher 0.0.0.0:11434 (ou *:11434)
```

`localhost:11434` continue de fonctionner sur la machine. Ollama n'a **pas d'authentification** : limitez l'accès au port avec le pare-feu, par exemple avec ufw :

```bash
sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp   # réseaux Docker
sudo ufw allow from 192.168.1.0/24 to any port 11434 proto tcp  # (facultatif) votre réseau local
sudo ufw deny 11434/tcp
```

Pour vérifier depuis le conteneur : `docker compose exec app node -e "fetch('http://host.docker.internal:11434/api/version').then(r=>r.text()).then(console.log)"`.

---

## Modèles, Thinking et capacités des fournisseurs

| Capacité | Ollama | Compatible OpenAI (LM Studio, llama.cpp, vLLM) |
|---|---|---|
| Découverte des modèles | `/api/tags` + `/api/show` (taille, quantification, contexte) | `/v1/models` (identifiants seulement) |
| Détection du Thinking | déclarée par le modèle (`capabilities: ["thinking"]`) | **non déclarée** : affichée comme « non vérifiée » |
| Activation / désactivation | paramètre natif `think: true/false` | `chat_template_kwargs.enable_thinking` (gabarits Qwen3 / DeepSeek ; nouvel essai sans ce champ si le serveur le refuse) |
| Flux de raisonnement | champ `message.thinking` | `delta.reasoning_content` / `delta.reasoning` |
| Balises `<think>` dans le texte | extraites vers la zone de réflexion | extraites vers la zone de réflexion |
| Sorties JSON structurées | `format` (schéma JSON) | `response_format: json_schema`, repli `json_object` |

Règles appliquées :
- le bouton **Thinking** est désactivé, avec une explication, pour un modèle qui déclare ne pas le prendre en charge. Avec Ollama, **`qwen2.5:3b` ne le prend pas en charge** : c'est le cas de votre modèle actuel ;
- si le Thinking est demandé mais qu'aucun raisonnement distinct n'est renvoyé, un message l'indique. Aucune réflexion n'est jamais simulée ;
- pour profiter du Thinking avec Ollama, utilisez un modèle qui le prend en charge, par exemple `ollama pull qwen3:4b` (≈ 2,5 Go, adapté à une RTX 4060 de 8 Go) ou `qwen3:1.7b` (≈ 1,4 Go). Ce point a été validé de bout en bout avec `qwen3:1.7b`.

Gestion : **Administration → Serveur IA** pour actualiser la liste, définir le modèle et le Thinking par défaut, et modifier les instructions système. Chaque utilisateur peut remplacer ces défauts dans **Paramètres → IA**, puis par conversation (sélecteur) et par message (bouton Thinking).

---

## Questions de précision

Lorsque la demande est trop vague (« conçois-moi une application »), l'IA peut proposer des questions avec des réponses à choisir. Pour une question précise, elle répond directement. Le mécanisme ne dépend d'aucune capacité propriétaire :

1. Les instructions système demandent au modèle, **seulement si nécessaire**, de terminer par un bloc `<clarify>{"questions":[{"question":"…","options":["…"]}]}</clarify>`.
2. Pendant le streaming, le bloc est retiré du texte affiché (même s'il est coupé entre deux fragments), puis validé côté serveur (Zod). Les écarts courants des petits modèles sont tolérés (blocs ```` ```json ````, clés au singulier, balise fermante mal formée) et les options génériques (« Option 1 ») sont écartées.
3. Un bloc invalide est **ignoré** : la réponse principale s'affiche normalement, accompagnée d'une note discrète.
4. **Repli pour les petits modèles** (constaté avec `qwen2.5:3b`, qui pose parfois ses questions en texte) : une heuristique stricte et déterministe repère une réponse courte composée de questions. Le modèle structure alors ces questions en JSON contraint par schéma (sorties structurées). C'est l'heuristique qui décide, pas le modèle, ce qui évite les faux positifs.
5. Dans l'interface, une seule question se répond en un clic ; pour plusieurs questions, on sélectionne puis on envoie. **Répondre librement** place le curseur dans la zone de saisie. Les questions posées sont rappelées au modèle au tour suivant.

La fonctionnalité se désactive globalement (administration) ou par utilisateur (paramètres).

---

## Sécurité

- Mots de passe hachés avec **scrypt** (N=2¹⁵, r=8, p=1, sel aléatoire) ; temps de réponse identique, que l'e-mail existe ou non.
- Sessions en base : jeton aléatoire de 256 bits ; seul son **HMAC-SHA256** (clé `AUTH_SECRET`) est stocké. Cookie `httpOnly`, `SameSite=Lax`, `Secure` en HTTPS. Les sessions sont glissantes (30 jours) et révocables, et révoquées automatiquement en cas de désactivation, de changement de rôle ou de mot de passe.
- Autorisations **vérifiées côté serveur** dans chaque page et chaque route (`requireApiUser` / `requirePagePermission`). Les pages d'administration renvoient une 404 aux non-administrateurs. Un administrateur ne peut ni gérer un compte de rang égal ou supérieur, ni créer d'administrateur ; le dernier super-administrateur est protégé.
- Isolation : toutes les requêtes de conversation filtrent par `userId` (couverte par des tests).
- CSRF : cookies `SameSite=Lax`, vérification de l'en-tête `Origin` sur les mutations, corps JSON obligatoire.
- Validation Zod de toutes les entrées ; erreurs internes journalisées sans détails exposés au client ; secrets masqués dans le journal.
- Limitation de débit : connexion (10 essais / 15 min par IP et e-mail), générations (20/min par utilisateur), tests et détection IA.
- URL du serveur IA : `http`/`https` uniquement, sans identifiants, services de métadonnées cloud bloqués, redirections refusées, liste blanche facultative (`AI_URL_ALLOWLIST`). La clé d'API n'est jamais renvoyée au navigateur.
- En-têtes : `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`. Markdown rendu sans HTML brut.
- PostgreSQL n'est jamais exposé au navigateur ni publié par le `compose.yaml` de production.

---

## Migrations et maintenance

```bash
# Développement
pnpm db:migrate                         # crée et applique une migration après modification du schéma
pnpm db:deploy                          # applique les migrations existantes
pnpm db:studio                          # explorateur de données Prisma

# Docker / Dokploy (le service migrate le fait à chaque démarrage)
docker compose run --rm migrate         # appliquer manuellement les migrations en attente
docker compose logs -f app              # journaux de l'application

# Sauvegarde / restauration
docker compose exec -T db pg_dump -U iatrano -Fc iatrano > iatrano-$(date +%F).dump
docker compose exec -T db pg_restore -U iatrano -d iatrano --clean < iatrano-AAAA-MM-JJ.dump

# Mise à jour
git pull && docker compose up --build -d
```

Le journal technique (Administration → Journal) conserve les erreurs du serveur IA, les échecs de connexion et les modifications de configuration. Il peut être vidé depuis l'interface.

---

## Tests

```bash
pnpm typecheck && pnpm lint             # vérifications statiques
pnpm test                               # tests unitaires (sans base, fetch simulé)

# Tests d'intégration sur une vraie base (créez-la une fois) :
docker exec iatrano-dev-db-1 psql -U iatrano -c "CREATE DATABASE iatrano_test"
TEST_DATABASE_URL=postgresql://iatrano:iatrano@localhost:5442/iatrano_test pnpm test:integration

# + tests contre un vrai moteur IA (ignorés si LLM_TEST_URL est absent) :
TEST_DATABASE_URL=… LLM_TEST_URL=http://localhost:11434 LLM_TEST_MODEL=qwen2.5:3b \
  [LLM_TEST_THINKING_MODEL=qwen3:1.7b] pnpm test:integration
```

- **Unitaires** : analyse `<think>` et `<clarify>` en streaming, heuristique de clarification, protocole NDJSON, construction du contexte et des titres, scrypt, jetons, permissions, limitation de débit, validation d'URL, diagnostics réseau, adaptateurs Ollama et OpenAI (découverte, capacités, raisonnement, erreurs, annulation, délai d'inactivité, sorties structurées).
- **Intégration** (vraie base, vrais handlers de routes ; seul le contexte de requête Next.js est simulé) : isolation des conversations, recherche, authentification, désactivation, limitation des connexions, CSRF, autorisations d'administration, protection du dernier super-administrateur, URL et clé d'API, orchestration du streaming avec un fournisseur factice (Thinking, clarifications valides et invalides, repli structuré, annulation, erreurs, modèle absent, réponse vide, édition et régénération, limitation de débit), bootstrap idempotent, cohérence schéma/migrations.
- La base de test doit avoir un nom contenant « test » : elle est vidée entre les tests.

---

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| « Connexion refusée par host.docker.internal:11434 » | Ollama n'écoute que sur 127.0.0.1 | `OLLAMA_HOST=0.0.0.0:11434` (voir [section réseau](#ollama-sur-la-machine-hôte-et-application-dans-docker)) |
| « Connexion refusée par localhost:11434 » dans Docker | `localhost` désigne le conteneur | Utilisez `http://host.docker.internal:11434` ou l'IP de la machine |
| « Hôte host.docker.internal introuvable » | Hors Docker, ou `extra_hosts` absent | Hors Docker : `localhost` ; dans Docker : gardez `extra_hosts: host-gateway` |
| « Hôte injoignable » vers une autre machine | IP erronée, pare-feu, moteur limité à localhost | Vérifiez l'IP, le pare-feu, et que le moteur écoute sur le réseau |
| Délai dépassé au premier message | Chargement du modèle en mémoire (VRAM) | Réessayez, ou augmentez le délai (Administration → Serveur IA) |
| « Ollama répond mais aucun modèle n'est installé » | Modèles installés pour un autre utilisateur ou dossier | `ollama list` doit afficher le modèle ; sinon `ollama pull …` ou corrigez `OLLAMA_MODELS` |
| Bouton Thinking grisé | Le modèle ne déclare pas cette capacité | Normal pour `qwen2.5:3b` ; utilisez `qwen3:*` |
| « Le fournisseur n'a renvoyé aucun flux de réflexion » | Serveur compatible OpenAI sans séparation du raisonnement | llama.cpp : `--reasoning-format deepseek` ; LM Studio : activez la séparation du raisonnement |
| Déconnecté en boucle derrière un proxy HTTPS | `COOKIE_SECURE=false` forcé ou en-têtes manquants | `COOKIE_SECURE=auto` et `X-Forwarded-Proto` transmis (Dokploy/Traefik le fait) |
| Connexion impossible en HTTP sur le réseau local | `COOKIE_SECURE=true` | Utilisez `auto` (ou `false` en HTTP) |
| Aucun super-administrateur | Variables absentes ou mot de passe trop court | Définissez-les (≥ 12 caractères) et redémarrez ; voir Administration → Journal ou les logs |
| `migrate` en erreur | Base injoignable ou mot de passe avec caractères spéciaux | `POSTGRES_PASSWORD` uniquement hexadécimal ; `docker compose logs migrate` |
| Port 3000 déjà utilisé | Autre service | `APP_PORT=3100` (Docker) ou `PORT=3100 pnpm dev` |
| Build Docker : `lookup registry-1.docker.io … permission denied` | Le démon Docker n'a pas d'accès DNS (constaté avec Docker installé en snap) | Corrigez le DNS du démon, ou utilisez une image Node déjà présente : `NODE_VERSION=lts-alpine docker compose build` |
| Copier ne fonctionne pas sur mobile en HTTP | API presse-papiers réservée aux contextes sécurisés | Un repli est intégré ; HTTPS recommandé |

---

## Limites connues

- **Limitation de débit en mémoire** : adaptée à une instance unique (cas par défaut). Avec plusieurs réplicas, il faudrait un stockage partagé (Redis).
- **Serveurs compatibles OpenAI** : capacités non déclarées par l'API (Thinking « non vérifié »), métadonnées de modèle absentes ; l'activation du raisonnement dépend du gabarit et du serveur.
- **Questions de précision avec les petits modèles** : un modèle de 3B ne suit pas toujours le format ; le repli structuré couvre le cas courant (questions posées en texte), mais une demande ambiguë peut recevoir une réponse directe.
- **Historique linéaire** : modifier un ancien message remplace la suite de la conversation (pas d'arborescence de versions).
- **Contexte** : l'historique envoyé est tronqué (40 messages et un budget de caractères adapté au contexte du modèle).
- **Formules LaTeX** : non rendues (affichées en texte brut).
- **Génération liée à la connexion** : fermer l'onglet arrête la génération ; la partie reçue est conservée (état « interrompue »).
- Pas d'inscription publique : les comptes sont créés par un administrateur.
