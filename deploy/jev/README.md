# JEV sur le serveur 100.121.17.90

JEV (implémentation *jevos*) répond à des questions fermées en anglais et renvoie la probabilité d'un « oui » entre 0 et 1. IATrano l'interroge via Tailscale. Ce dossier contient de quoi l'installer sur le serveur Ubuntu. **Rien n'est exécuté automatiquement.**

| Fichier | Rôle |
|---|---|
| `install.sh` | Installe et met à jour jevos : clone, `uv sync`, runtime, modèle GGUF, clé, service. |
| `jev.service` | Gabarit du service systemd `jev`, complété par `install.sh`. |
| `jev.env.example` | Modèle de `/etc/jev/jev.env`, qui contient `JEV_API_KEY` (droits 600). |

## 1. Installation

Copiez le dossier sur le serveur, puis lancez le script :

```bash
scp -r deploy/jev utilisateur@100.121.17.90:~/jev-deploy
ssh utilisateur@100.121.17.90
cd ~/jev-deploy
sudo bash install.sh
```

Le script effectue ces opérations dans l'ordre :

1. Il vérifie que l'IP Tailscale de la machine est bien `100.121.17.90`.
2. Il installe `uv` dans `/usr/local/bin` et crée l'utilisateur système `jev`.
3. Il clone le dépôt dans `/opt/jev`, puis exécute `uv sync` et `uv run jev download --only runtime`.
4. Il télécharge `jevos-1b-q4_k_m.gguf` depuis la release GitHub.
5. Il génère une clé dans `/etc/jev/jev.env` (`root:root`, droits `600`).
6. Il installe le service, le démarre et attend que `/health` réponde `ready`.

Tous les paramètres se surchargent par variable d'environnement :

```bash
sudo JEV_REF=v1.2.0 JEV_GGUF_SHA256=<empreinte> JEV_THREADS=8 bash install.sh
```

> ⚠️ **Avant la première installation, vérifiez le nom exact de l'asset GGUF** sur la page des releases du dépôt. Si l'URL par défaut ne convient pas, passez-la avec `JEV_GGUF_URL=…`. Épinglez aussi une version précise avec `JEV_REF` et l'empreinte du modèle avec `JEV_GGUF_SHA256`. Sans `JEV_GGUF_SHA256`, le script affiche l'empreinte du fichier téléchargé : notez-la.

Commande lancée par le service :

```
uv run --no-sync jev serve --gguf jevos-1b-q4_k_m.gguf --device cpu --threads 12 --host 100.121.17.90 --port 8017
```

Commandes utiles :

```bash
systemctl status jev                         # état du service
journalctl -u jev -f                         # journaux en direct
sudo systemctl restart jev                   # après un changement de clé ou de modèle
sudo cat /etc/jev/jev.env                    # afficher la clé, à recopier dans IATrano
curl http://100.121.17.90:8017/health        # {"status":"ready",...} une fois le modèle chargé
```

Pour **changer la clé** : modifiez `/etc/jev/jev.env`, lancez `sudo systemctl restart jev`, puis saisissez la nouvelle clé dans IATrano (*Administration → Connexion JEV*).

## 2. Exposition réseau : Tailscale uniquement

Le service écoute **uniquement sur l'IP Tailscale** (`--host 100.121.17.90`), jamais sur `0.0.0.0`. Il est donc injoignable depuis le réseau local et depuis Internet, même sans pare-feu. Ajoutez tout de même une règle ufw, par défense en profondeur :

```bash
# 1) autoriser le port 8017 uniquement sur l'interface Tailscale…
sudo ufw allow in on tailscale0 to any port 8017 proto tcp comment 'JEV via Tailscale'
# 2) …et le refuser partout ailleurs (ufw applique la première règle qui correspond)
sudo ufw deny 8017/tcp
sudo ufw status numbered
```

Si `ufw` n'est pas encore actif, autorisez SSH **avant** de l'activer, sinon vous perdrez l'accès : `sudo ufw allow OpenSSH && sudo ufw enable`.

Vous pouvez aller plus loin et n'autoriser que la machine qui fait tourner IATrano. Remplacez la règle 1 par :

```bash
sudo ufw allow in on tailscale0 from <IP-Tailscale-du-PC> to any port 8017 proto tcp comment 'JEV ← IATrano'
```

L'IP Tailscale du PC s'obtient avec `tailscale ip -4` sur le PC. Les ACL Tailscale peuvent ajouter la même restriction côté réseau, par exemple `"dst": ["100.121.17.90:8017"]` pour le seul tag ou appareil d'IATrano.

**Vérifications.** Depuis le PC, `nc -zv 100.121.17.90 8017` doit réussir. Depuis une machine du réseau local qui n'utilise **pas** Tailscale, la même commande vers l'IP locale du serveur doit échouer.

## 3. Côté IATrano

1. Dans le `.env` d'IATrano, renseignez `JEV_HOST=100.121.17.90` et `JEV_PORT=8017`. Vous pouvez aussi y mettre `JEV_API_KEY`, ou saisir la clé dans l'administration, où elle est chiffrée en base avec `AUTH_SECRET`.
2. Ouvrez *Administration → Connexion JEV* et cliquez sur **Enregistrer et tester**.
3. La pastille en haut de l'administration et du chat passe au vert quand JEV est prêt.

Si IATrano tourne **dans Docker** sur le PC, le conteneur passe par la table de routage de l'hôte. Il joint donc `100.121.17.90` dès que Tailscale est connecté sur le PC : aucune configuration supplémentaire n'est nécessaire.

## 4. Message d'erreur → que faire

| Message dans IATrano | Cause probable | Que faire |
|---|---|---|
| *Serveur injoignable : vérifier que Tailscale est connecté…* | Tailscale arrêté sur l'une des deux machines, pare-feu, mauvaise IP. | `tailscale status` sur les deux machines, puis `sudo ufw status` sur le serveur et `nc -zv 100.121.17.90 8017` depuis le PC. |
| *Connexion refusée sur 100.121.17.90:8017* | La machine répond, mais rien n'écoute sur ce port. | `systemctl status jev`. Vérifiez `--host` et `--port` dans `/etc/systemd/system/jev.service`. |
| *Hôte « … » introuvable* | Nom d'hôte non résolu. | Utilisez l'IP Tailscale (`tailscale ip -4`) ou activez MagicDNS. |
| *Service JEV arrêté ou modèle en cours de chargement* | Statut `/health` différent de `ready`, ou pas de réponse. | Attendez la fin du chargement, puis `journalctl -u jev -f`. |
| *Clé API refusée : vérifier JEV_API_KEY sur le serveur* | La clé saisie ne correspond pas à `/etc/jev/jev.env`. | `sudo cat /etc/jev/jev.env`, puis recopiez la clé dans l'administration. Après toute modification du fichier, lancez `sudo systemctl restart jev`. |
| *JEV exige une clé API et aucune n'est configurée* | Aucune clé côté IATrano. | Saisissez la clé dans l'administration, ou définissez `JEV_API_KEY` dans le `.env` d'IATrano. |
| ⚠ *Le serveur accepte les requêtes SANS clé* | `JEV_API_KEY` absent de l'environnement du service. | Vérifiez `/etc/jev/jev.env` et la ligne `EnvironmentFile=` du service, puis redémarrez. |
| *La clé enregistrée est illisible (AUTH_SECRET a changé)* | `AUTH_SECRET` d'IATrano a été modifié. | Ressaisissez la clé dans l'administration. |
| *JEV n'a pas répondu dans le délai de … s* | Serveur saturé (CPU) ou délai trop court. | Augmentez le délai d'attente, ou réduisez la charge et `--threads`. |
| *Réponse mal formée sur …* / *Route … introuvable (404)* | Le port correspond à un autre service, ou la version de jevos est incompatible. | Vérifiez le port, puis mettez à jour jevos (`sudo bash install.sh`). |
| *Requête refusée par JEV (422)* | Question de type `choice` ou `score`. | Seules les questions oui/non (`noul`) sont prises en charge. |
| *L'alias « jev-latest » n'est pas exposé* | Version de jevos sans cet alias. | Mettez jevos à jour. |
| *Probabilité trop basse pour un exemple dont la réponse attendue est « oui »* | Modèle incorrect ou corrompu. | Comparez l'empreinte du fichier GGUF (`sha256sum /opt/jev/jevos-1b-q4_k_m.gguf`), puis retéléchargez-le si besoin. |
| *Erreur TLS avec JEV* | `https` choisi alors que JEV sert en `http`. | Choisissez `http`. Le trafic Tailscale est déjà chiffré de bout en bout. |
