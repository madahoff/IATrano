# Transcription audio pour IATrano (faster-whisper)

Les vidéos et fichiers audio importés dans un projet sont transcrits par un service **compatible OpenAI**
(`POST /v1/audio/transcriptions`, `response_format=verbose_json`). Ce dossier fournit un serveur minimal
fondé sur [faster-whisper](https://github.com/SYSTRAN/faster-whisper) ; tout autre service compatible
(speaches, LocalAI, whisper.cpp server…) convient aussi.

## Installation (machine hôte, sans droits administrateur)

```bash
./deploy/whisper/install.sh                       # modèle small, CPU int8, 127.0.0.1:8090
WHISPER_MODEL=medium WHISPER_DEVICE=cuda ./deploy/whisper/install.sh   # GPU NVIDIA (bibliothèques CUDA requises)
```

- Le modèle est téléchargé au premier démarrage dans `~/.local/share/iatrano-whisper/models`
  (small ≈ 480 Mo, medium ≈ 1,5 Go).
- Service : `systemctl --user status iatrano-whisper` · journaux : `journalctl --user -u iatrano-whisper -f`.
- Pour qu'il démarre sans session ouverte : `loginctl enable-linger $USER` (une fois, avec sudo si nécessaire).
- Vérification : `curl http://127.0.0.1:8090/health`.

## Raccordement à IATrano

Administration → **Documents** → « Service de transcription » : `http://127.0.0.1:8090`
(depuis le conteneur Docker : `http://host.docker.internal:8090` et `WHISPER_HOST=0.0.0.0`).
Variable d'environnement équivalente au premier démarrage : `DOCUMENT_TRANSCRIPTION_URL`.

## Performances indicatives (CPU, int8)

| Modèle | Vitesse (8 cœurs) | Mémoire |
| --- | --- | --- |
| base | ≈ 15× temps réel | ≈ 0,5 Go |
| small | ≈ 5× temps réel | ≈ 1 Go |
| medium | ≈ 1,5× temps réel | ≈ 2,5 Go |

Les passages dont la confiance est faible (`avg_logprob`) sont marqués « transcription incertaine »
dans le texte indexé ; ils ne sont jamais présentés comme certains.
