#!/usr/bin/env sh
# Sauvegarde d'IATrano : base PostgreSQL (pg_dump, format custom) + fichiers des documents (volume iatrano-documents).
# À exécuter SUR LE SERVEUR (là où tournent les conteneurs), par un utilisateur ayant accès à Docker.
# L'application reste en service pendant la sauvegarde (pg_dump est cohérent ; les documents en cours d'import
# — dossier .incoming — et le cache OCR sont exclus).
#
#   sh scripts/backup.sh [-p PROJET_COMPOSE] [-o DOSSIER] [-k NOMBRE_A_GARDER]
#
#   -p  nom du projet Docker Compose (défaut : iatrano). Avec Dokploy, c'est le « App Name » du service Compose :
#         docker ps --format '{{.Label "com.docker.compose.project"}}  {{.Names}}' | grep -- -app-
#   -o  dossier de destination (défaut : ./backups) ; une sous-arborescence AAAA-MM-JJ_HHMMSS y est créée.
#   -k  ne garde que les N sauvegardes les plus récentes de ce dossier (défaut : 0 = aucune suppression).
set -eu

PROJECT=iatrano
OUT=./backups
KEEP=0
while getopts "p:o:k:h" opt; do
  case "$opt" in
    p) PROJECT=$OPTARG ;;
    o) OUT=$OPTARG ;;
    k) KEEP=$OPTARG ;;
    *) sed -n '2,13p' "$0"; exit 2 ;;
  esac
done

container() {
  id=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -n 1)
  if [ -z "$id" ]; then
    echo "Conteneur « $1 » du projet « $PROJECT » introuvable ou arrêté (option -p ?)." >&2
    exit 1
  fi
  echo "$id"
}

DB=$(container db)
APP=$(container app)
STAMP=$(date +%Y-%m-%d_%H%M%S)
DEST="$OUT/$STAMP"
mkdir -p "$DEST"
chmod 700 "$OUT" "$DEST"
umask 077

echo "→ Base de données (pg_dump)…"
docker exec "$DB" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$DEST/db.dump"
docker exec "$DB" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name"' > "$DEST/migrations.txt"

echo "→ Documents (/app/data/documents)…"
docker exec "$APP" tar -czf - -C /app/data --exclude=documents/.incoming --exclude=documents/.ocr-cache documents > "$DEST/documents.tar.gz"

# Contrôles : archive lisible et dump reconnu par pg_restore.
gzip -t "$DEST/documents.tar.gz"
docker exec -i "$DB" pg_restore --list < "$DEST/db.dump" > /dev/null

(cd "$DEST" && sha256sum db.dump documents.tar.gz migrations.txt > SHA256SUMS)
{
  echo "projet=$PROJECT"
  echo "date=$STAMP"
  echo "migrations=$(wc -l < "$DEST/migrations.txt" | tr -d ' ')"
  echo "derniere_migration=$(tail -n 1 "$DEST/migrations.txt")"
} > "$DEST/info.txt"

echo "✓ Sauvegarde terminée : $DEST ($(du -sh "$DEST" | cut -f1))"

if [ "$KEEP" -gt 0 ] 2>/dev/null; then
  # Rotation limitée aux dossiers créés par ce script (nom AAAA-MM-JJ_HHMMSS contenant un info.txt).
  ls -1d "$OUT"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" |
    while read -r old; do
      [ -f "$old/info.txt" ] && rm -rf "$old" && echo "  ancienne sauvegarde supprimée : $old"
    done
fi
echo "Copiez ce dossier hors du serveur (autre disque, NAS, stockage S3) : une sauvegarde sur le même disque ne protège pas d'une panne."
