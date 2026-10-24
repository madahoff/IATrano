#!/usr/bin/env sh
# Restauration d'IATrano depuis une sauvegarde de scripts/backup.sh. À exécuter SUR LE SERVEUR.
#
#   sh scripts/restore.sh -d backups/AAAA-MM-JJ_HHMMSS [-p PROJET_COMPOSE] --yes
#
# Opération DESTRUCTIVE : remplace le contenu actuel de la base et des documents. Elle commence donc par une
# sauvegarde de sécurité de l'état actuel (dans <dossier de la sauvegarde>/../pre-restore_*), arrête le conteneur
# app pendant la restauration (aucune écriture concurrente) puis le redémarre.
# La base doit être au même niveau de migrations que l'image déployée (voir migrations.txt) ; sinon redéployez la
# version correspondante de l'application, ou laissez le service migrate appliquer les migrations plus récentes.
set -eu

PROJECT=iatrano
DIR=
CONFIRM=no
while [ $# -gt 0 ]; do
  case "$1" in
    -p) PROJECT=$2; shift 2 ;;
    -d) DIR=$2; shift 2 ;;
    --yes) CONFIRM=yes; shift ;;
    *) sed -n '2,11p' "$0"; exit 2 ;;
  esac
done
[ -n "$DIR" ] || { echo "Indiquez la sauvegarde avec -d." >&2; exit 2; }
for f in db.dump documents.tar.gz SHA256SUMS; do
  [ -f "$DIR/$f" ] || { echo "Fichier manquant : $DIR/$f" >&2; exit 1; }
done
(cd "$DIR" && sha256sum -c --quiet SHA256SUMS) || { echo "Sauvegarde corrompue (SHA256SUMS)." >&2; exit 1; }
if [ "$CONFIRM" != yes ]; then
  echo "La restauration remplace la base et les documents du projet « $PROJECT ». Relancez avec --yes pour confirmer." >&2
  exit 2
fi

container() {
  id=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -n 1)
  [ -n "$id" ] || { echo "Conteneur « $1 » du projet « $PROJECT » introuvable (option -p ?)." >&2; exit 1; }
  echo "$id"
}
DB=$(container db)
APP=$(container app)
IMAGE=$(docker inspect -f '{{.Config.Image}}' "$APP")

echo "→ Sauvegarde de sécurité de l'état actuel…"
sh "$(dirname "$0")/backup.sh" -p "$PROJECT" -o "$(dirname "$DIR")/pre-restore_$(date +%Y-%m-%d_%H%M%S)"

echo "→ Arrêt de l'application…"
docker stop -t 30 "$APP" > /dev/null
restart_app() { docker start "$APP" > /dev/null && echo "→ Application redémarrée."; }
trap restart_app EXIT

echo "→ Restauration de la base…"
docker exec -i "$DB" sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --single-transaction' < "$DIR/db.dump"

echo "→ Restauration des documents…"
docker run --rm -i --network none --user 1001:1001 --volumes-from "$APP" --entrypoint sh "$IMAGE" \
  -c 'find /app/data/documents -mindepth 1 -maxdepth 1 -exec rm -rf {} + && tar -xzf - -C /app/data' < "$DIR/documents.tar.gz"

echo "✓ Restauration terminée depuis $DIR."
