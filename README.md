# Parrot Conversation Controller

This app is now a lightweight conversation controller for the parrot project.

Browser jobs:
- capture microphone audio
- send audio to the backend for speech-to-text
- show the user transcript
- show the AI response text
- send control commands to the ESP32

Backend jobs:
- speech-to-text with Whisper
- LLM response generation
- text-to-speech generation
- WAV hosting from `public/generated/`
- optional ESP32 command proxy routes

## Audio Target

Generated reply audio is normalized to:

- WAV
- mono
- 16-bit PCM
- 16000 Hz

That is the output contract returned by the backend and included in the `play_url` command payload sent to the ESP32.

## Setup

```bash
npm install
copy .env.example .env
```

Set at least:

- `NAVIGATOR_TOOLKIT_API_KEY`

Recommended for ESP32 playback:

- `PUBLIC_BASE_URL=http://YOUR-LAN-IP:3000`

If `PUBLIC_BASE_URL` is left empty, the app builds audio URLs from the incoming request host. That works for some setups, but it often produces `localhost` URLs that an ESP32 cannot reach.

## Run

```bash
npm start
```

Open the site from your phone or browser at the same reachable host that the ESP32 will use.

## Frontend State

The page keeps and displays these fields:

- `esp32Ip`
- `masterVolume`
- `sessionState`
- `lastTranscript`
- `lastResponse`
- `lastAudioUrl`

## Website Routes

Conversation:

- `POST /conversation/turn`
- `POST /api/conversation/turn`

ESP32 proxy routes:

- `POST /session/start`
- `POST /session/end`
- `POST /set-volume`
- `POST /play`
- `POST /esp32/command`

Config and contract:

- `GET /api/config`
- `GET /api/esp32/contract`

## Conversation Response Contract

`POST /conversation/turn` returns:

```json
{
  "transcript": "Hello parrot",
  "response_text": "Ahoy there, matey. I hear ye loud and clear.",
  "audio_url": "http://192.168.1.20:3000/generated/reply_001.wav",
  "audio_path": "/generated/reply_001.wav",
  "audio_spec": {
    "format": "wav",
    "encoding": "pcm_s16le",
    "sample_rate_hz": 16000,
    "channels": 1,
    "bits_per_sample": 16
  }
}
```

## Exact JSON Commands For The ESP32

Recommended firmware endpoint:

- `POST /command`

Command envelope:

```json
{
  "version": 1,
  "request_id": "req_play_001",
  "timestamp": "2026-04-16T18:00:12.000Z",
  "session_id": "session_abc123",
  "command": "play_url",
  "payload": {}
}
```

Commands:

### `start_session`

```json
{
  "version": 1,
  "request_id": "req_start_001",
  "timestamp": "2026-04-16T18:00:00.000Z",
  "session_id": "session_abc123",
  "command": "start_session",
  "payload": {
    "volume": 0.85,
    "play_intro": false
  }
}
```

### `play_intro`

```json
{
  "version": 1,
  "request_id": "req_intro_001",
  "timestamp": "2026-04-16T18:00:04.000Z",
  "session_id": "session_abc123",
  "command": "play_intro",
  "payload": {}
}
```

### `set_volume`

```json
{
  "version": 1,
  "request_id": "req_volume_001",
  "timestamp": "2026-04-16T18:00:08.000Z",
  "session_id": "session_abc123",
  "command": "set_volume",
  "payload": {
    "volume": 0.65
  }
}
```

### `play_url`

```json
{
  "version": 1,
  "request_id": "req_play_001",
  "timestamp": "2026-04-16T18:00:12.000Z",
  "session_id": "session_abc123",
  "command": "play_url",
  "payload": {
    "url": "http://192.168.1.20:3000/generated/reply_001.wav",
    "volume": 0.85,
    "audio_spec": {
      "format": "wav",
      "encoding": "pcm_s16le",
      "sample_rate_hz": 16000,
      "channels": 1,
      "bits_per_sample": 16
    }
  }
}
```

### `end_session`

```json
{
  "version": 1,
  "request_id": "req_end_001",
  "timestamp": "2026-04-16T18:00:20.000Z",
  "session_id": "session_abc123",
  "command": "end_session",
  "payload": {
    "play_outro": true
  }
}
```

Recommended ESP32 acknowledgement:

```json
{
  "ok": true
}
```

## Notes

- The website no longer stores show intro or outro audio. Those are expected to remain on the ESP32 if you want local intro/outro playback.
- The browser can still preview the generated reply audio, but the primary output path is the ESP32 `play_url` command.
- The server exposes the same command examples programmatically at `GET /api/esp32/contract`.
