"""Serveur de transcription compatible OpenAI (/v1/audio/transcriptions) pour IATrano.

faster-whisper (CTranslate2) : CPU int8 par défaut, GPU CUDA si WHISPER_DEVICE=cuda.
Réponse verbose_json : segments horodatés avec avg_logprob et no_speech_prob (signalement des passages incertains).
Aucune dépendance web : http.server de la bibliothèque standard, une requête traitée à la fois.

Variables : WHISPER_MODEL (small), WHISPER_DEVICE (cpu|cuda|auto), WHISPER_COMPUTE (int8), WHISPER_HOST (127.0.0.1),
WHISPER_PORT (8090), WHISPER_MAX_MB (200), WHISPER_LANGUAGE (vide = détection automatique).
"""

import json
import os
import tempfile
import threading
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from faster_whisper import WhisperModel

MODEL = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
MAX_BYTES = int(os.environ.get("WHISPER_MAX_MB", "200")) * 1024 * 1024
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None

model = WhisperModel(MODEL, device=DEVICE, compute_type=COMPUTE)
lock = threading.Lock()


def parse_multipart(content_type, body):
    """Champs d'un formulaire multipart (nom → octets), via le parseur MIME de la bibliothèque standard."""
    if not content_type.lower().startswith("multipart/form-data"):
        return {}
    message = BytesParser(policy=policy.default).parsebytes(b"Content-Type: " + content_type.encode("latin-1") + b"\r\n\r\n" + body)
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            fields[name] = part.get_payload(decode=True) or b""
    return fields


class Handler(BaseHTTPRequestHandler):
    server_version = "iatrano-whisper/1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/v1/models"):
            return self._json(200, {"status": "ok", "model": MODEL, "device": DEVICE, "data": [{"id": MODEL}]})
        return self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
            return self._json(404, {"error": {"message": "not found"}})
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BYTES:
            return self._json(413, {"error": {"message": "fichier absent ou trop volumineux"}})
        fields = parse_multipart(self.headers.get("content-type", ""), self.rfile.read(length))
        if not fields.get("file"):
            return self._json(400, {"error": {"message": "champ « file » requis (multipart/form-data)"}})
        language = (fields.get("language") or b"").decode("utf-8", "ignore").strip() or LANGUAGE
        with tempfile.NamedTemporaryFile(suffix=".audio") as tmp:
            tmp.write(fields["file"])
            tmp.flush()
            try:
                with lock:
                    segments, info = model.transcribe(tmp.name, language=language, vad_filter=True, beam_size=5)
                    segments = list(segments)
            except Exception as err:  # fichier illisible, format inconnu
                return self._json(400, {"error": {"message": f"transcription impossible : {err}"}})
        text = " ".join(s.text.strip() for s in segments)
        return self._json(200, {
            "task": "transcribe",
            "language": info.language,
            "duration": info.duration,
            "text": text,
            "segments": [
                {"id": i, "start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(), "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob}
                for i, s in enumerate(segments)
            ],
        })


if __name__ == "__main__":
    host = os.environ.get("WHISPER_HOST", "127.0.0.1")
    port = int(os.environ.get("WHISPER_PORT", "8090"))
    print(f"iatrano-whisper : modèle {MODEL} ({DEVICE}/{COMPUTE}) sur http://{host}:{port}", flush=True)
    ThreadingHTTPServer((host, port), Handler).serve_forever()
