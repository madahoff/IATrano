# SearXNG avec la configuration d'IATrano intégrée à l'image (API JSON, réseau interne uniquement).
# Intégrer settings.yml évite un montage de fichier du dépôt, que Dokploy déconseille (dépôt recloné à chaque déploiement).
# Le secret n'est pas dans l'image : SEARXNG_SECRET, fourni à l'exécution, remplace server.secret_key.
ARG SEARXNG_IMAGE=searxng/searxng:2026.10.23-629368e40
FROM ${SEARXNG_IMAGE}
COPY settings.yml /etc/searxng/settings.yml
