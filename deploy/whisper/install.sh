#!/usr/bin/env bash
# Installe le service de transcription d'IATrano (faster-whisper, API compatible OpenAI) pour l'utilisateur courant :
#   ~/.local/share/iatrano-whisper (venv + server.py) et service systemd utilisateur « iatrano-whisper ».
# Variables : WHISPER_MODEL (small), WHISPER_DEVICE (cpu|cuda), WHISPER_PORT (8090), WHISPER_HOST (127.0.0.1).
# Aucun droit administrateur requis. Le modèle est téléchargé au premier démarrage (small ≈ 480 Mo).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${IATRANO_WHISPER_DIR:-$HOME/.local/share/iatrano-whisper}"
MODEL="${WHISPER_MODEL:-small}"
DEVICE="${WHISPER_DEVICE:-cpu}"
COMPUTE="${WHISPER_COMPUTE:-$([ "$DEVICE" = cuda ] && echo float16 || echo int8)}"
HOST="${WHISPER_HOST:-127.0.0.1}"
PORT="${WHISPER_PORT:-8090}"

command -v python3 >/dev/null || { echo "python3 est requis." >&2; exit 1; }
mkdir -p "$DEST"
cp "$HERE/server.py" "$DEST/server.py"
if [ ! -x "$DEST/venv/bin/python" ]; then
  python3 -m venv "$DEST/venv"
fi
"$DEST/venv/bin/pip" install --quiet --upgrade pip
"$DEST/venv/bin/pip" install --quiet "faster-whisper>=1.1,<2"

cat > "$DEST/whisper.env" <<ENV
WHISPER_MODEL=$MODEL
WHISPER_DEVICE=$DEVICE
WHISPER_COMPUTE=$COMPUTE
WHISPER_HOST=$HOST
WHISPER_PORT=$PORT
HF_HOME=$DEST/models
ENV

mkdir -p "$HOME/.config/systemd/user"
sed "s#@DEST@#$DEST#g" "$HERE/iatrano-whisper.service" > "$HOME/.config/systemd/user/iatrano-whisper.service"
systemctl --user daemon-reload
systemctl --user enable --now iatrano-whisper
echo "Service iatrano-whisper démarré sur http://$HOST:$PORT (premier démarrage : téléchargement du modèle $MODEL)."
echo "Dans IATrano : Administration → Documents → Service de transcription = http://$HOST:$PORT"
