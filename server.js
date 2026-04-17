import "dotenv/config";
import crypto from "node:crypto";
import express from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TMP_DIR = path.join(__dirname, "tmp");
const GENERATED_DIR = path.join(__dirname, "public", "generated");

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(GENERATED_DIR, { recursive: true });

const app = express();
const upload = multer({ dest: TMP_DIR });

const requiredKey = process.env.NAVIGATOR_TOOLKIT_API_KEY;
if (!requiredKey) {
  console.warn("NAVIGATOR_TOOLKIT_API_KEY is not set.");
}

const openai = new OpenAI({
  apiKey: process.env.NAVIGATOR_TOOLKIT_API_KEY,
  baseURL: process.env.NAVIGATOR_BASE_URL || "https://api.ai.it.ufl.edu/v1",
});

const ALLOWED_CHAT_MODELS = new Set([
  "llama-3.1-70b-instruct",
  "llama-3.1-8b-instruct",
  "llama-3.1-nemotron-nano-8B-v1",
  "llama-3.3-70b-instruct",
  "mistral-7b-instruct",
  "mistral-small-3.1",
  "codestral-22b",
  "gemma-3-27b-it",
  "gpt-oss-20b",
  "gpt-oss-120b",
  "granite-3.3-8b-instruct",
]);
const ALLOWED_WHISPER_MODELS = new Set(["whisper-large-v3"]);
const ALLOWED_KOKORO_MODELS = new Set(["kokoro"]);

const CHAT_MODEL = process.env.CHAT_MODEL || "llama-3.1-8b-instruct";
const WHISPER_MODEL = process.env.WHISPER_MODEL || "whisper-large-v3";
const KOKORO_MODEL = process.env.KOKORO_MODEL || "kokoro";
const KOKORO_VOICE = process.env.KOKORO_VOICE || "am_santa";
const KOKORO_SPEED = parseNumber(process.env.KOKORO_SPEED, 1.02);
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_BASE_URL = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || "");
const DEFAULT_ESP32_IP = String(process.env.DEFAULT_ESP32_IP || "").trim();
const DEFAULT_MASTER_VOLUME = parseVolume(process.env.DEFAULT_MASTER_VOLUME, 0.85);
const ESP32_COMMAND_PATH = normalizePathPrefix(process.env.ESP32_COMMAND_PATH || "/command");
const MAX_TRANSCRIPT_CHARS = 700;

const AUDIO_SPEC = Object.freeze({
  format: "wav",
  encoding: "pcm_s16le",
  sample_rate_hz: 16000,
  channels: 1,
  bits_per_sample: 16,
});

const PARROT_SYSTEM_PROMPT =
  process.env.PARROT_SYSTEM_PROMPT ||
  [
    "You are the voice of a friendly pirate parrot animatronic.",
    "Reply in 1 to 3 short sentences that sound natural when spoken aloud.",
    "Keep responses family-friendly, clear, and concise.",
    "Do not use markdown, bullet lists, stage directions, or emojis.",
  ].join(" ");

const TTS_INSTRUCTIONS =
  "Perform as a warm, playful pirate parrot animatronic. Speak clearly, confidently, and in short phrases that are easy to understand in a noisy room.";

const CONTRACT_EXAMPLES = buildContractExamples();

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (req, res) => {
  res.json({
    default_esp32_ip: DEFAULT_ESP32_IP,
    default_master_volume: DEFAULT_MASTER_VOLUME,
    public_base_url: PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`,
    esp32_command_path: ESP32_COMMAND_PATH,
    audio_spec: AUDIO_SPEC,
    esp32_contract_url: "/api/esp32/contract",
  });
});

app.get("/api/esp32/contract", (_req, res) => {
  res.json({
    esp32_endpoint: {
      method: "POST",
      path: ESP32_COMMAND_PATH,
      content_type: "application/json",
    },
    website_proxy_routes: [
      "POST /session/start",
      "POST /session/end",
      "POST /set-volume",
      "POST /play",
      "POST /conversation/turn",
    ],
    audio_spec: AUDIO_SPEC,
    commands: CONTRACT_EXAMPLES,
    notes: [
      "The ESP32 should acknowledge accepted commands with JSON such as {\"ok\":true}.",
      "The WAV URL must be reachable from the ESP32 over the local network or public internet.",
      "Set PUBLIC_BASE_URL to a LAN-reachable address if localhost URLs are not usable by the ESP32.",
    ],
  });
});

app.post(
  ["/conversation/turn", "/api/conversation/turn", "/api/parrot"],
  upload.single("audio"),
  async (req, res) => {
    const tempPath = req.file?.path;
    if (!tempPath) {
      return res.status(400).json({ error: "No audio file was uploaded." });
    }

    const volume = parseVolume(req.body?.volume, DEFAULT_MASTER_VOLUME);
    const sessionId = sanitizeSessionId(req.body?.session_id);

    try {
      validateModelConfig();

      const transcription = await transcribeAudio(tempPath);
      const transcript = sanitizeTranscript(transcription.text || "").slice(0, MAX_TRANSCRIPT_CHARS);
      if (!transcript) {
        throw new Error("Speech-to-text returned empty text.");
      }

      const responseText = await generateParrotReply(transcript);
      const synthesized = await synthesizeSpeech({
        inputText: responseText,
        filePrefix: "reply",
      });
      const audioUrl = buildPublicFileUrl(req, synthesized.relativeUrl);

      res.json({
        transcript,
        response_text: responseText,
        audio_url: audioUrl,
        audio_path: synthesized.relativeUrl,
        audio_spec: synthesized.audioSpec,
        play_command: createEsp32Command({
          command: "play_url",
          sessionId,
          payload: {
            url: audioUrl,
            volume,
            audio_spec: synthesized.audioSpec,
          },
        }),
      });
    } catch (error) {
      console.error(error);
      res.status(500).json({
        error: "Failed to process conversation turn.",
        details: error?.message || "Unknown error",
      });
    } finally {
      cleanupTemp(tempPath);
    }
  }
);

app.post(["/session/start", "/api/session/start"], async (req, res) => {
  try {
    const esp32Ip = req.body?.esp32Ip ?? req.body?.esp32_ip;
    const sessionId = sanitizeSessionId(req.body?.sessionId ?? req.body?.session_id) || makeSessionId();
    const command = createEsp32Command({
      command: "start_session",
      sessionId,
      payload: {
        volume: parseVolume(req.body?.volume, DEFAULT_MASTER_VOLUME),
        play_intro: Boolean(req.body?.playIntro ?? req.body?.play_intro ?? false),
      },
    });
    const forwarded = await forwardCommandToEsp32({ esp32Ip, command });
    res.json({
      ok: true,
      session_id: sessionId,
      command,
      ...forwarded,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to start ESP32 session.",
      details: error?.message || "Unknown error",
    });
  }
});

app.post(["/session/end", "/api/session/end"], async (req, res) => {
  try {
    const esp32Ip = req.body?.esp32Ip ?? req.body?.esp32_ip;
    const sessionId = sanitizeSessionId(req.body?.sessionId ?? req.body?.session_id);
    if (!sessionId) {
      return res.status(400).json({ error: "session_id is required." });
    }

    const command = createEsp32Command({
      command: "end_session",
      sessionId,
      payload: {
        play_outro: Boolean(req.body?.playOutro ?? req.body?.play_outro ?? true),
      },
    });
    const forwarded = await forwardCommandToEsp32({ esp32Ip, command });
    res.json({
      ok: true,
      session_id: sessionId,
      command,
      ...forwarded,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to end ESP32 session.",
      details: error?.message || "Unknown error",
    });
  }
});

app.post(["/set-volume", "/api/set-volume"], async (req, res) => {
  try {
    const esp32Ip = req.body?.esp32Ip ?? req.body?.esp32_ip;
    const sessionId = sanitizeSessionId(req.body?.sessionId ?? req.body?.session_id);
    if (!sessionId) {
      return res.status(400).json({ error: "session_id is required." });
    }

    const command = createEsp32Command({
      command: "set_volume",
      sessionId,
      payload: {
        volume: parseVolume(req.body?.volume, DEFAULT_MASTER_VOLUME),
      },
    });
    const forwarded = await forwardCommandToEsp32({ esp32Ip, command });
    res.json({
      ok: true,
      session_id: sessionId,
      command,
      ...forwarded,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to set ESP32 volume.",
      details: error?.message || "Unknown error",
    });
  }
});

app.post(["/play", "/api/play"], async (req, res) => {
  try {
    const esp32Ip = req.body?.esp32Ip ?? req.body?.esp32_ip;
    const sessionId = sanitizeSessionId(req.body?.sessionId ?? req.body?.session_id);
    if (!sessionId) {
      return res.status(400).json({ error: "session_id is required." });
    }

    const url = String(req.body?.url || "").trim();
    if (!url) {
      return res.status(400).json({ error: "url is required." });
    }

    const command = createEsp32Command({
      command: "play_url",
      sessionId,
      payload: {
        url,
        volume: parseVolume(req.body?.volume, DEFAULT_MASTER_VOLUME),
        audio_spec: AUDIO_SPEC,
      },
    });
    let forwarded = null;
    let forwardError = null;

    try {
      forwarded = await forwardCommandToEsp32({ esp32Ip, command });
    } catch (error) {
      forwardError = error;
    }

    res.json({
      ok: true,
      session_id: sessionId,
      command,
      forwarded: Boolean(forwarded),
      forwarded_to: forwarded?.forwarded_to || null,
      esp32_status: forwarded?.esp32_status || null,
      esp32_response: forwarded?.esp32_response || null,
      forward_error: forwardError ? (forwardError?.message || "Unknown error") : null,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to send play command to ESP32.",
      details: error?.message || "Unknown error",
    });
  }
});

app.post(["/esp32/command", "/api/esp32/command"], async (req, res) => {
  try {
    const esp32Ip = req.body?.esp32Ip ?? req.body?.esp32_ip;
    const commandName = String(req.body?.command || "").trim();
    if (!commandName) {
      return res.status(400).json({ error: "command is required." });
    }

    const command = createEsp32Command({
      command: commandName,
      sessionId: sanitizeSessionId(req.body?.sessionId ?? req.body?.session_id),
      payload: isPlainObject(req.body?.payload) ? req.body.payload : {},
    });
    const forwarded = await forwardCommandToEsp32({ esp32Ip, command });
    res.json({
      ok: true,
      command,
      ...forwarded,
    });
  } catch (error) {
    res.status(502).json({
      error: "Failed to forward command to ESP32.",
      details: error?.message || "Unknown error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Parrot controller running at http://localhost:${PORT}`);
});

function validateModelConfig() {
  if (!process.env.NAVIGATOR_TOOLKIT_API_KEY) {
    throw new Error("Missing NAVIGATOR_TOOLKIT_API_KEY.");
  }
  if (!ALLOWED_CHAT_MODELS.has(CHAT_MODEL)) {
    throw new Error(`Unsupported CHAT_MODEL. Allowed: ${Array.from(ALLOWED_CHAT_MODELS).join(", ")}`);
  }
  if (!ALLOWED_WHISPER_MODELS.has(WHISPER_MODEL)) {
    throw new Error(
      `Unsupported WHISPER_MODEL. Allowed: ${Array.from(ALLOWED_WHISPER_MODELS).join(", ")}`
    );
  }
  if (!ALLOWED_KOKORO_MODELS.has(KOKORO_MODEL)) {
    throw new Error(`Unsupported KOKORO_MODEL. Allowed: ${Array.from(ALLOWED_KOKORO_MODELS).join(", ")}`);
  }
}

async function transcribeAudio(filePath) {
  return openai.audio.transcriptions.create({
    model: WHISPER_MODEL,
    file: fs.createReadStream(filePath),
    language: "en",
    temperature: 0,
  });
}

async function generateParrotReply(transcript) {
  const completion = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.6,
    max_tokens: 140,
    messages: [
      {
        role: "system",
        content: PARROT_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: `User transcript: """${transcript}"""`,
      },
    ],
  });

  const text = sanitizeSpeechText(completion.choices?.[0]?.message?.content || "");
  if (!text) {
    throw new Error("Language model returned empty text.");
  }

  return enforceSentenceLimit(text, 3);
}

async function synthesizeSpeech({ inputText, filePrefix }) {
  const safePrefix = String(filePrefix || "audio").replace(/[^a-zA-Z0-9-_]/g, "-");
  const fileName = `${safePrefix}-${Date.now()}.wav`;
  const absolutePath = path.join(GENERATED_DIR, fileName);

  const speechResponse = await openai.audio.speech.create({
    model: KOKORO_MODEL,
    voice: KOKORO_VOICE,
    input: inputText,
    instructions: TTS_INSTRUCTIONS,
    speed: KOKORO_SPEED,
    response_format: "wav",
  });

  const contentType = speechResponse.headers?.get?.("content-type") || "";
  const originalAudio = Buffer.from(await speechResponse.arrayBuffer());
  let normalizedWav;

  try {
    normalizedWav = normalizeWavToTarget(originalAudio, AUDIO_SPEC);
  } catch (error) {
    const audioSignature = describeAudioSignature(originalAudio);
    throw new Error(
      `Unable to normalize TTS audio. content-type=${contentType || "unknown"}, signature=${audioSignature}, details=${
        error?.message || "Unknown error"
      }`
    );
  }

  fs.writeFileSync(absolutePath, normalizedWav);

  return {
    relativeUrl: `/generated/${fileName}`,
    audioSpec: readWavMetadata(normalizedWav),
  };
}

async function forwardCommandToEsp32({ esp32Ip, command }) {
  const baseUrl = normalizeEsp32BaseUrl(esp32Ip);
  if (!baseUrl) {
    throw new Error("esp32Ip is required.");
  }

  const targetUrl = new URL(ESP32_COMMAND_PATH, `${baseUrl}/`).toString();
  console.log("ESP32 command outbound:", JSON.stringify({ targetUrl, command }, null, 2));
  let response;
  try {
    response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
  } catch (error) {
    const details = [error?.message, error?.cause?.message].filter(Boolean).join(" | ");
    throw new Error(`Could not reach ESP32 at ${targetUrl}${details ? `: ${details}` : ""}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const esp32Response = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    console.warn("ESP32 command rejected:", JSON.stringify({ targetUrl, status: response.status, response: esp32Response }, null, 2));
    throw new Error(
      `ESP32 returned ${response.status}${response.statusText ? ` ${response.statusText}` : ""}: ${stringifyForError(
        esp32Response
      )}`
    );
  }

  console.log("ESP32 command accepted:", JSON.stringify({ targetUrl, status: response.status, response: esp32Response }, null, 2));

  return {
    forwarded_to: targetUrl,
    esp32_status: response.status,
    esp32_response: esp32Response,
  };
}

function createEsp32Command({ command, sessionId, payload }) {
  return {
    version: 1,
    request_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    session_id: sessionId || null,
    command: String(command || "").trim(),
    payload: isPlainObject(payload) ? payload : {},
  };
}

function makeSessionId() {
  return `session_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

function buildContractExamples() {
  return [
    {
      name: "start_session",
      body: {
        version: 1,
        request_id: "req_start_001",
        timestamp: "2026-04-16T18:00:00.000Z",
        session_id: "session_abc123",
        command: "start_session",
        payload: {
          volume: 0.85,
          play_intro: false,
        },
      },
    },
    {
      name: "play_intro",
      body: {
        version: 1,
        request_id: "req_intro_001",
        timestamp: "2026-04-16T18:00:04.000Z",
        session_id: "session_abc123",
        command: "play_intro",
        payload: {},
      },
    },
    {
      name: "set_volume",
      body: {
        version: 1,
        request_id: "req_volume_001",
        timestamp: "2026-04-16T18:00:08.000Z",
        session_id: "session_abc123",
        command: "set_volume",
        payload: {
          volume: 0.65,
        },
      },
    },
    {
      name: "play_url",
      body: {
        version: 1,
        request_id: "req_play_001",
        timestamp: "2026-04-16T18:00:12.000Z",
        session_id: "session_abc123",
        command: "play_url",
        payload: {
          url: "http://192.168.1.20:3000/generated/reply_001.wav",
          volume: 0.85,
          audio_spec: AUDIO_SPEC,
        },
      },
    },
    {
      name: "end_session",
      body: {
        version: 1,
        request_id: "req_end_001",
        timestamp: "2026-04-16T18:00:20.000Z",
        session_id: "session_abc123",
        command: "end_session",
        payload: {
          play_outro: true,
        },
      },
    },
  ];
}

function normalizeWavToTarget(sourceBuffer, targetSpec) {
  const decoded = decodeWav(sourceBuffer);
  const mono = downmixToMono(decoded.samples, decoded.channels);
  const resampled = resampleLinear(mono, decoded.sampleRate, targetSpec.sample_rate_hz);
  return encodePcm16MonoWav(resampled, targetSpec.sample_rate_hz);
}

function decodeWav(buffer) {
  const normalizedBuffer = trimToWavStart(buffer);
  if (normalizedBuffer.length < 44) {
    throw new Error("WAV response is too small.");
  }
  if (!hasWaveContainerSignature(normalizedBuffer)) {
    throw new Error("TTS did not return a RIFF/RIFX/RF64 WAVE file.");
  }

  const littleEndian = normalizedBuffer.toString("ascii", 0, 4) !== "RIFX";
  const readUInt16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  const readUInt32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;

  const scanned = scanWavChunks(normalizedBuffer, { readUInt16, readUInt32 });
  const fallback = scanned.fmt && scanned.dataOffset >= 0
    ? scanned
    : fallbackLocateWavChunks(normalizedBuffer, { readUInt16, readUInt32 });

  const { fmt, dataOffset, dataSize } = fallback;
  if (!fmt || dataOffset < 0) {
    throw new Error("WAV response is missing fmt or data chunks.");
  }

  const bytesPerSample = Math.ceil(fmt.bitsPerSample / 8);
  const blockAlign = fmt.blockAlign || fmt.channels * bytesPerSample;
  if (!blockAlign) {
    throw new Error("WAV block alignment is invalid.");
  }

  const frameCount = Math.floor(dataSize / blockAlign);
  const samples = new Float32Array(frameCount * fmt.channels);

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      const sampleOffset = dataOffset + frame * blockAlign + channel * bytesPerSample;
      samples[frame * fmt.channels + channel] = decodeSample(
        normalizedBuffer,
        sampleOffset,
        fmt.audioFormat,
        fmt.bitsPerSample,
        littleEndian
      );
    }
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    samples,
  };
}

function scanWavChunks(buffer, readers) {
  const { readUInt16, readUInt32 } = readers;
  if (buffer.length < 44) {
    return { fmt: null, dataOffset: -1, dataSize: 0 };
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = readUInt32.call(buffer, offset + 4);
    const chunkStart = offset + 8;
    const nextOffset = chunkStart + chunkSize + (chunkSize % 2);

    if (chunkStart + chunkSize > buffer.length) {
      break;
    }

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: readUInt16.call(buffer, chunkStart),
        channels: readUInt16.call(buffer, chunkStart + 2),
        sampleRate: readUInt32.call(buffer, chunkStart + 4),
        blockAlign: readUInt16.call(buffer, chunkStart + 12),
        bitsPerSample: readUInt16.call(buffer, chunkStart + 14),
      };
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }

    offset = nextOffset;
  }

  return {
    fmt,
    dataOffset,
    dataSize,
  };
}

function fallbackLocateWavChunks(buffer, readers) {
  const { readUInt16, readUInt32 } = readers;
  const fmtIndex = indexOfAsciiChunk(buffer, "fmt ", 12, Math.min(buffer.length, 64 * 1024));
  const dataIndex = indexOfAsciiChunk(buffer, "data", 12, buffer.length);

  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  if (fmtIndex >= 0 && fmtIndex + 24 <= buffer.length) {
    const fmtSize = readUInt32.call(buffer, fmtIndex + 4);
    const chunkStart = fmtIndex + 8;
    if (chunkStart + Math.max(fmtSize, 16) <= buffer.length) {
      fmt = {
        audioFormat: readUInt16.call(buffer, chunkStart),
        channels: readUInt16.call(buffer, chunkStart + 2),
        sampleRate: readUInt32.call(buffer, chunkStart + 4),
        blockAlign: readUInt16.call(buffer, chunkStart + 12),
        bitsPerSample: readUInt16.call(buffer, chunkStart + 14),
      };
    }
  }

  if (dataIndex >= 0 && dataIndex + 8 <= buffer.length) {
    const declaredSize = readUInt32.call(buffer, dataIndex + 4);
    dataOffset = dataIndex + 8;
    dataSize = Math.min(declaredSize, buffer.length - dataOffset);
  }

  return {
    fmt,
    dataOffset,
    dataSize,
  };
}

function decodeSample(buffer, offset, audioFormat, bitsPerSample, littleEndian = true) {
  if (audioFormat === 1) {
    if (bitsPerSample === 8) {
      return clampSample((buffer.readUInt8(offset) - 128) / 128);
    }
    if (bitsPerSample === 16) {
      return clampSample((littleEndian ? buffer.readInt16LE(offset) : buffer.readInt16BE(offset)) / 32768);
    }
    if (bitsPerSample === 24) {
      let value;
      if (littleEndian) {
        value =
          buffer[offset] |
          (buffer[offset + 1] << 8) |
          (buffer[offset + 2] << 16);
      } else {
        value =
          buffer[offset + 2] |
          (buffer[offset + 1] << 8) |
          (buffer[offset] << 16);
      }
      if (value & 0x800000) {
        value |= 0xff000000;
      }
      return clampSample(value / 8388608);
    }
    if (bitsPerSample === 32) {
      return clampSample((littleEndian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset)) / 2147483648);
    }
  }

  if (audioFormat === 3) {
    if (bitsPerSample === 32) {
      return clampSample(littleEndian ? buffer.readFloatLE(offset) : buffer.readFloatBE(offset));
    }
    if (bitsPerSample === 64) {
      return clampSample(littleEndian ? buffer.readDoubleLE(offset) : buffer.readDoubleBE(offset));
    }
  }

  throw new Error(`Unsupported WAV format: audioFormat=${audioFormat}, bitsPerSample=${bitsPerSample}`);
}

function downmixToMono(samples, channels) {
  if (channels === 1) {
    return samples;
  }

  const mono = new Float32Array(Math.floor(samples.length / channels));
  for (let frame = 0; frame < mono.length; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      sum += samples[frame * channels + channel];
    }
    mono[frame] = clampSample(sum / channels);
  }
  return mono;
}

function resampleLinear(samples, sourceRate, targetRate) {
  if (sourceRate === targetRate) {
    return samples;
  }

  const targetLength = Math.max(1, Math.round(samples.length * targetRate / sourceRate));
  const result = new Float32Array(targetLength);
  const step = sourceRate / targetRate;

  for (let i = 0; i < targetLength; i += 1) {
    const sourceIndex = i * step;
    const leftIndex = Math.floor(sourceIndex);
    const rightIndex = Math.min(leftIndex + 1, samples.length - 1);
    const fraction = sourceIndex - leftIndex;
    const left = samples[leftIndex] ?? 0;
    const right = samples[rightIndex] ?? left;
    result[i] = clampSample(left + (right - left) * fraction);
  }

  return result;
}

function encodePcm16MonoWav(samples, sampleRate) {
  const dataBuffer = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = clampSample(samples[i]);
    const scaled = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
    dataBuffer.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBuffer.length, 40);

  return Buffer.concat([header, dataBuffer]);
}

function readWavMetadata(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("File is not a WAV.");
  }

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === "fmt ") {
      const audioFormat = buffer.readUInt16LE(chunkStart);
      const channels = buffer.readUInt16LE(chunkStart + 2);
      const sampleRate = buffer.readUInt32LE(chunkStart + 4);
      const bitsPerSample = buffer.readUInt16LE(chunkStart + 14);

      return {
        format: "wav",
        encoding: audioFormat === 1 ? "pcm_s16le" : `wav_format_${audioFormat}`,
        sample_rate_hz: sampleRate,
        channels,
        bits_per_sample: bitsPerSample,
      };
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  throw new Error("fmt chunk not found in WAV.");
}

function sanitizeTranscript(text) {
  return String(text)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function sanitizeSpeechText(text) {
  return String(text)
    .replace(/[`*_#>\[\]]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function enforceSentenceLimit(text, maxSentences) {
  const parts = String(text)
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((part) => part.trim())
    .filter(Boolean);

  if (!parts?.length) {
    return String(text).trim();
  }

  return parts.slice(0, maxSentences).join(" ");
}

function cleanupTemp(filePath) {
  if (!filePath) {
    return;
  }

  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore temp cleanup errors.
  }
}

function buildPublicFileUrl(req, relativeUrl) {
  const baseUrl = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return new URL(relativeUrl, baseUrl).toString();
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    console.warn("PUBLIC_BASE_URL is invalid and will be ignored.");
    return "";
  }
}

function normalizeEsp32BaseUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const withProtocol = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  url.hash = "";
  url.search = "";
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function normalizePathPrefix(value) {
  const text = String(value || "/command").trim();
  if (!text) {
    return "/command";
  }
  return text.startsWith("/") ? text : `/${text}`;
}

function parseVolume(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, parsed));
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeSessionId(value) {
  const text = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "");
  return text || "";
}

function clampSample(value) {
  return Math.max(-1, Math.min(1, value));
}

function stringifyForError(value) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasWaveContainerSignature(buffer) {
  const riffType = buffer.toString("ascii", 0, 4);
  const waveType = buffer.toString("ascii", 8, 12);
  return ["RIFF", "RIFX", "RF64"].includes(riffType) && waveType === "WAVE";
}

function trimToWavStart(buffer) {
  if (hasWaveContainerSignature(buffer)) {
    return buffer;
  }

  const candidates = ["RIFF", "RIFX", "RF64"];
  for (const token of candidates) {
    const index = indexOfAsciiChunk(buffer, token, 0, Math.min(buffer.length, 1024));
    if (index >= 0 && index + 12 <= buffer.length && buffer.toString("ascii", index + 8, index + 12) === "WAVE") {
      return buffer.subarray(index);
    }
  }

  return buffer;
}

function indexOfAsciiChunk(buffer, token, start, end) {
  const needle = Buffer.from(token, "ascii");
  const limit = Math.max(start, end - needle.length + 1);

  for (let i = start; i < limit; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (buffer[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return i;
    }
  }

  return -1;
}

function describeAudioSignature(buffer) {
  if (!buffer?.length) {
    return "empty";
  }

  const asciiHead = buffer
    .subarray(0, Math.min(buffer.length, 16))
    .toString("ascii")
    .replace(/[^\x20-\x7E]/g, ".");
  const hexHead = buffer
    .subarray(0, Math.min(buffer.length, 12))
    .toString("hex");

  if (hasWaveContainerSignature(trimToWavStart(buffer))) {
    return `wave-like(ascii=${asciiHead},hex=${hexHead})`;
  }
  if (buffer.toString("ascii", 0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return `mp3-like(ascii=${asciiHead},hex=${hexHead})`;
  }
  if (buffer.toString("ascii", 0, 4) === "OggS") {
    return `ogg-like(ascii=${asciiHead},hex=${hexHead})`;
  }
  if (buffer.toString("ascii", 0, 4) === "fLaC") {
    return `flac-like(ascii=${asciiHead},hex=${hexHead})`;
  }
  if (buffer.toString("ascii", 0, 1) === "{" || buffer.toString("ascii", 0, 1) === "[") {
    return `json-like(ascii=${asciiHead},hex=${hexHead})`;
  }

  return `unknown(ascii=${asciiHead},hex=${hexHead})`;
}
