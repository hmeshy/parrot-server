# Pirate Parrot Voice Booth

Web app flow:
1. Tap once to start hands-free parrot mode.
2. Browser continuously listens and auto-detects speech start/end from mic audio levels.
3. Backend transcribes with Whisper (`whisper-large-v3`).
4. Backend rewrites text into a pirate-parrot response.
5. Backend synthesizes speech using Kokoro (`am_santa`) via Navigator Toolkit base URL.
6. Browser plays reply audio, then plays an exaggerated Pixabay squawk sequence, then listens again.

## Requirements

- Node.js 18+
- Navigator Toolkit API key

## Setup

```bash
npm install
copy .env.example .env
```

Edit `.env` and set `NAVIGATOR_TOOLKIT_API_KEY`.

## Run

```bash
npm start
```

Open `http://localhost:3000`.

## Notes

- The app uses `base_url` from `NAVIGATOR_BASE_URL`, defaulting to `https://api.ai.it.ufl.edu/v1`.
- Generated MP3 files are written to `public/generated/`.
- Default rewrite model is `llama-3.1-8b-instruct` (cheap/simple choice).
- If desired, change models/voice in `.env` (`CHAT_MODEL`, `WHISPER_MODEL`, `KOKORO_MODEL`, `KOKORO_VOICE`, `KOKORO_SPEED`, `SQUAWK_URL`).
- Squawk audio is loaded from `SQUAWK_URL` (default: local `public/assets/parrot-squawk.ogg`).
