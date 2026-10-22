#!/usr/bin/env bash
# Installation de JEV (jevos) sur le serveur Ubuntu 100.121.17.90.
# À exécuter EN TANT QUE root sur le serveur : sudo bash install.sh
# Le script est idempotent : on peut le relancer pour mettre à jour le code et le modèle.
set -euo pipefail

# --- Paramètres (surchargeables : sudo JEV_THREADS=8 bash install.sh) -------------------
JEV_REPO_URL="${JEV_REPO_URL:-https://github.com/feder-cr/jev.git}"
JEV_REF="${JEV_REF:-}"                         # tag ou commit à épingler (recommandé), vide = branche par défaut
JEV_DIR="${JEV_DIR:-/opt/jev}"
JEV_USER="${JEV_USER:-jev}"
JEV_GGUF="${JEV_GGUF:-jevos-1b-q4_k_m.gguf}"
# Vérifiez le nom exact de l'asset sur la page des releases avant la première installation.
JEV_GGUF_URL="${JEV_GGUF_URL:-https://github.com/feder-cr/jev/releases/latest/download/${JEV_GGUF}}"
JEV_GGUF_SHA256="${JEV_GGUF_SHA256:-}"         # empreinte attendue (fortement recommandé)
JEV_HOST="${JEV_HOST:-100.121.17.90}"          # IP Tailscale : jamais 0.0.0.0
JEV_PORT="${JEV_PORT:-8017}"
JEV_THREADS="${JEV_THREADS:-12}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mErreur : %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "lancez ce script avec sudo."
[[ "$JEV_HOST" != "0.0.0.0" ]] || die "JEV_HOST ne doit pas valoir 0.0.0.0 (exposition sur toutes les interfaces)."

log "Vérification de Tailscale"
command -v tailscale >/dev/null || die "tailscale n'est pas installé."
tailscale ip -4 | grep -qx "$JEV_HOST" || die "l'IP Tailscale de cette machine n'est pas $JEV_HOST (tailscale ip -4 : $(tailscale ip -4 | tr '\n' ' '))."

log "Paquets système"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates openssl >/dev/null

log "Installation de uv (gestionnaire Python) dans /usr/local/bin"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
fi
uv --version

log "Utilisateur système « $JEV_USER »"
id "$JEV_USER" >/dev/null 2>&1 || useradd --system --home-dir "$JEV_DIR" --shell /usr/sbin/nologin "$JEV_USER"

log "Code source dans $JEV_DIR"
if [[ -d "$JEV_DIR/.git" ]]; then
  sudo -u "$JEV_USER" git -C "$JEV_DIR" fetch --tags --quiet
  sudo -u "$JEV_USER" git -C "$JEV_DIR" pull --ff-only --quiet || true
else
  install -d -o "$JEV_USER" -g "$JEV_USER" "$JEV_DIR"
  sudo -u "$JEV_USER" git clone --quiet "$JEV_REPO_URL" "$JEV_DIR"
fi
[[ -n "$JEV_REF" ]] && sudo -u "$JEV_USER" git -C "$JEV_DIR" checkout --quiet "$JEV_REF"

export UV_CACHE_DIR="$JEV_DIR/.cache/uv"
run_as_jev() { sudo -u "$JEV_USER" env UV_CACHE_DIR="$UV_CACHE_DIR" HOME="$JEV_DIR" bash -c "cd '$JEV_DIR' && $*"; }

log "Dépendances Python (uv sync)"
run_as_jev "uv sync"

log "Runtime d'inférence (uv run jev download --only runtime)"
run_as_jev "uv run jev download --only runtime"

log "Modèle $JEV_GGUF"
if [[ ! -s "$JEV_DIR/$JEV_GGUF" ]]; then
  run_as_jev "curl -fL --retry 3 -o '$JEV_GGUF.part' '$JEV_GGUF_URL' && mv '$JEV_GGUF.part' '$JEV_GGUF'"
fi
if [[ -n "$JEV_GGUF_SHA256" ]]; then
  echo "$JEV_GGUF_SHA256  $JEV_DIR/$JEV_GGUF" | sha256sum -c - || die "empreinte SHA-256 du modèle incorrecte."
else
  echo "Empreinte du modèle (à conserver) : $(sha256sum "$JEV_DIR/$JEV_GGUF" | cut -d' ' -f1)"
fi

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
sed -e "s#@JEV_DIR@#$JEV_DIR#g" -e "s#@JEV_USER@#$JEV_USER#g" -e "s#@JEV_GGUF@#$JEV_GGUF#g" \
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
