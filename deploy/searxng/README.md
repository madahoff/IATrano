# SearXNG sur le serveur 100.121.17.90

IATrano utilise SearXNG comme moteur de recherche principal, et l'API Brave Search en secours. Ce dossier installe SearXNG sur le serveur Ubuntu, **joignable uniquement par Tailscale**, de préférence avec Dokploy. Rien n'est exécuté automatiquement.

| Fichier | Rôle |
|---|---|
| `compose.yaml` | Service SearXNG, publié uniquement sur `100.121.17.90:8888`. |
| `settings.yml` | Configuration : API JSON activée, limiteur désactivé (instance privée). |
| `.env.example` | Variables : `SEARXNG_SECRET`, adresse d'écoute, image. |

## 1. Avec Dokploy (recommandé)

1. Dans Dokploy, ouvrez **Project → Create Service → Compose**, puis nommez le service `searxng`.
2. Dans **Provider**, choisissez *Raw* et collez le contenu de `compose.yaml`. Vous pouvez aussi pointer vers ce dépôt Git, chemin `deploy/searxng/compose.yaml`.
3. Dans **Environment**, renseignez :

   ```
   SEARXNG_SECRET=<openssl rand -hex 32>
   SEARXNG_HOST=100.121.17.90
   SEARXNG_PORT=8888
   ```

4. Dans **Advanced → Mounts**, ajoutez un **File Mount** :
   - chemin : `settings.yml` ;
   - contenu : celui de `settings.yml`.

   Dokploy le place dans `../files/settings.yml`, que `compose.yaml` monte déjà.
5. **Ne configurez aucun domaine** : SearXNG ne doit pas passer par Traefik, ni être exposé sur Internet.
6. Cliquez sur **Deploy**.

## 1 bis. Sans Dokploy

```bash
scp -r deploy/searxng utilisateur@100.121.17.90:~/searxng
ssh utilisateur@100.121.17.90
cd ~/searxng
cp .env.example .env
sed -i "s/^SEARXNG_SECRET=.*/SEARXNG_SECRET=$(openssl rand -hex 32)/" .env
echo "SEARXNG_SETTINGS=./settings.yml" >> .env
docker compose up -d
```

## 2. Sécurité réseau

- **Docker contourne ufw** pour les ports publiés : une règle `ufw deny 8888` n'aurait aucun effet. La protection vient de l'adresse d'écoute, `100.121.17.90:8888`, qui n'existe que sur l'interface Tailscale. Ne remplacez jamais `SEARXNG_HOST` par `0.0.0.0`.
- **Au redémarrage du serveur**, Docker peut démarrer avant que Tailscale ait attribué l'IP. La publication du port échoue alors et le conteneur ne démarre pas. Pour l'éviter, autorisez l'écoute sur une IP pas encore présente :

  ```bash
  echo 'net.ipv4.ip_nonlocal_bind = 1' | sudo tee /etc/sysctl.d/99-tailscale-bind.conf
  sudo sysctl --system
  ```

  Autre solution : faites démarrer Docker après Tailscale (`sudo systemctl edit docker`, puis `[Unit]` et `After=tailscaled.service`).
- **ACL Tailscale** (facultatif) : vous pouvez limiter `100.121.17.90:8888` à la seule machine qui fait tourner IATrano.

## 3. Vérifications

Depuis le PC où tourne IATrano, avec Tailscale connecté :

```bash
curl -s "http://100.121.17.90:8888/search?q=test&format=json" | head -c 300   # JSON attendu
nc -zv 100.121.17.90 8888                                                     # doit réussir
```

Depuis une machine du réseau local qui n'utilise **pas** Tailscale, `nc -zv <IP-locale-du-serveur> 8888` doit échouer.

## 4. Côté IATrano

1. Dans *Administration → Recherche Web*, renseignez l'adresse SearXNG : `http://100.121.17.90:8888`. Vous pouvez aussi définir `SEARXNG_URL=http://100.121.17.90:8888` dans le `.env` et laisser le champ vide.
2. **Secours Brave** :
   - activez « Basculer sur Brave si SearXNG échoue » (activé par défaut) ;
   - renseignez la clé de l'API Brave Search, obtenue sur <https://api.search.brave.com>.

   Sans clé, aucun secours n'est actif, et le test de connexion l'indique.
3. Lancez le test dans *Administration → Connexion JEV → Service de recherche Web*. Il affiche, étape par étape, la joignabilité, une requête réelle sur SearXNG seul, puis le secours Brave.

**Fonctionnement du basculement** : si SearXNG est injoignable, trop lent, renvoie une erreur ou **aucun résultat**, la même requête part vers Brave. Ce dernier cas arrive quand les moteurs amont bloquent temporairement l'instance. Le basculement est indiqué dans le détail de la recherche, sous la forme « N résultat(s) via Brave Search (secours) », ainsi que dans les limites affichées.

## 5. Message d'erreur → que faire

| Message dans IATrano | Cause probable | Que faire |
|---|---|---|
| *Impossible d'ouvrir 100.121.17.90:8888 (ECONNREFUSED)* | Conteneur arrêté, ou port publié ailleurs. | `docker ps`, puis vérifiez `SEARXNG_HOST` et `SEARXNG_PORT` et redéployez. |
| *Impossible d'ouvrir … (ETIMEDOUT)* | Tailscale déconnecté. | `tailscale status` sur les deux machines. |
| *SearXNG refuse le format JSON (403)* | `settings.yml` absent ou sans `json`. | Vérifiez le File Mount (`../files/settings.yml`) et redéployez. |
| *SearXNG limite le nombre de requêtes (429)* | Limiteur actif. | `server.limiter: false` dans `settings.yml`. |
| *Aucun résultat renvoyé* | Moteurs amont bloqués (captcha, quota). | Patientez ou ajustez la liste des moteurs. Le secours Brave prend le relais s'il est configuré. |
| *Clé Brave Search refusée* | Clé invalide ou révoquée. | Ressaisissez la clé dans *Administration → Recherche Web*. |
| *Quota Brave Search atteint (429)* | Offre gratuite épuisée. | Patientez ou changez d'offre. |
| Le conteneur ne démarre pas après un redémarrage du serveur | IP Tailscale absente au démarrage de Docker. | Appliquez `net.ipv4.ip_nonlocal_bind = 1` (section 2). |
