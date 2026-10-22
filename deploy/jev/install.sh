#!/usr/bin/env bash
# Installation de jevos (JEV) sur le serveur Ubuntu 100.121.17.90.
# Le dépôt amont distribue un binaire Linux et un modèle OpenVINO, pas un paquet Python.
set -euo pipefail

# --- Paramètres (surchargeables : sudo JEV_THREADS=8 bash install.sh) -------------------
JEV_RELEASE="${JEV_RELEASE:-jevos-v5}"
JEV_DIR="${JEV_DIR:-/opt/jev}"
JEV_USER="${JEV_USER:-jev}"
JEV_HOST="${JEV_HOST:-100.121.17.90}"          # IP Tailscale : jamais 0.0.0.0
JEV_PORT="${JEV_PORT:-8017}"
JEV_THREADS="${JEV_THREADS:-12}"
JEV_MODEL_ARCHIVE="${JEV_MODEL_ARCHIVE:-jevos-v5-openvino-int8.zip}"
JEV_BINARY_URL="${JEV_BINARY_URL:-https://github.com/feder-cr/jev/releases/download/${JEV_RELEASE}/jev-linux-x64.tar.gz}"
JEV_MODEL_URL="${JEV_MODEL_URL:-https://github.com/feder-cr/jev/releases/download/${JEV_RELEASE}/${JEV_MODEL_ARCHIVE}}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "lancez ce script avec sudo."
[[ "$JEV_HOST" != "0.0.0.0" ]] || die "JEV_HOST ne doit pas valoir 0.0.0.0 (exposition sur toutes les interfaces)."

log "Vérification de Tailscale"
command -v tailscale >/dev/null || die "tailscale n'est pas installé."
tailscale ip -4 | grep -qx "$JEV_HOST" || die "l'IP Tailscale de cette machine n'est pas $JEV_HOST (tailscale ip -4 : $(tailscale ip -4 | tr '\n' ' '))."

log "Paquets système"
apt-get update -qq
apt-get install -y -qq curl ca-certificates openssl unzip >/dev/null

log "Utilisateur système « $JEV_USER »"
id "$JEV_USER" >/dev/null 2>&1 || useradd --system --home-dir "$JEV_DIR" --shell /usr/sbin/nologin "$JEV_USER"

install -d -o "$JEV_USER" -g "$JEV_USER" "$JEV_DIR"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/model"
log "Téléchargement du binaire JEV ($JEV_RELEASE)"
curl -fL --retry 3 -o "$tmp/jev-linux-x64.tar.gz" "$JEV_BINARY_URL"
tar -xzf "$tmp/jev-linux-x64.tar.gz" -C "$tmp/bin"
binary="$(find "$tmp/bin" -type f -name jev -perm -u+x -print -quit)"
[[ -n "$binary" ]] || die "le binaire jev est absent de l'archive."
# L'archive contient l'exécutable et les bibliothèques OpenVINO nécessaires
# (notamment libopenvino.so.*) dans le même dossier. Ils doivent rester ensemble.
runtime_dir="$(dirname "$binary")"
cp -a "$runtime_dir"/. "$JEV_DIR"/
chmod 0755 "$JEV_DIR/jev"

log "Téléchargement du modèle ($JEV_MODEL_ARCHIVE)"
curl -fL --retry 3 -o "$tmp/model.zip" "$JEV_MODEL_URL"
unzip -q "$tmp/model.zip" -d "$tmp/model"
model_dir="$(find "$tmp/model" -type d -name model -print -quit)"
[[ -n "$model_dir" ]] || die "le dossier model est absent de l'archive."
rm -rf "$JEV_DIR/model"
install -d "$JEV_DIR/model"
cp -a "$model_dir"/. "$JEV_DIR/model"/
chown -R "$JEV_USER:$JEV_USER" "$JEV_DIR"

log "Fichier d'environnement /etc/jev/jev.env (droits 600)"
install -d -m 750 -o root -g "$JEV_USER" /etc/jev
if [[ ! -f /etc/jev/jev.env ]]; then
  umask 077
  printf 'JEV_API_KEY=%s\n' "$(openssl rand -hex 32)" > /etc/jev/jev.env
  echo "Clé générée. Pour l'afficher (à recopier dans IATrano) : sudo cat /etc/jev/jev.env"
fi
chown root:root /etc/jev/jev.env
chmod 600 /etc/jev/jev.env

log "Service systemd « jev »"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sed -e "s#@JEV_DIR@#$JEV_DIR#g" -e "s#@JEV_USER@#$JEV_USER#g" \
    -e "s#@JEV_HOST@#$JEV_HOST#g" -e "s#@JEV_PORT@#$JEV_PORT#g" -e "s#@JEV_THREADS@#$JEV_THREADS#g" \
    "$SCRIPT_DIR/jev.service" > /etc/systemd/system/jev.service
systemctl daemon-reload
systemctl enable --now jev
systemctl restart jev

log "Attente du chargement du modèle (GET /health)"
for _ in $(seq 60); do
  if curl -fsS "http://$JEV_HOST:$JEV_PORT/health" 2>/dev/null | grep -q '"ready"'; then
    echo "JEV est prêt sur http://$JEV_HOST:$JEV_PORT"
    break
  fi
  sleep 2
done
curl -sS "http://$JEV_HOST:$JEV_PORT/health" || echo "Pas encore prêt : consultez « journalctl -u jev -f »."

cat <<MSG

Étapes suivantes :
  1. Pare-feu (voir README) :
       sudo ufw allow in on tailscale0 to any port $JEV_PORT proto tcp comment 'JEV via Tailscale'
       sudo ufw deny $JEV_PORT/tcp
  2. Recopiez la clé (sudo cat /etc/jev/jev.env) dans IATrano → Administration → Connexion JEV.
  3. Cliquez sur « Enregistrer et tester ».
MSG
