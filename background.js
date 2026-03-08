const OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const MIN_TRANSCRIPTION_BYTES = 1500;

const DEFAULT_SETTINGS = {
  gptModel: "gpt-4o",
  whisperModel: "whisper-1"
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: "Invalid message payload." });
    return false;
  }

  if (message.type === "GET_SETTINGS") {
    getSettings()
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "PROCESS_AUDIO_CHUNK") {
    processAudioChunk(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  sendResponse({ ok: false, error: `Unsupported message type: ${message.type}` });
  return false;
});

async function getSettings() {
  const stored = await chrome.storage.local.get([
    "openaiApiKey",
    "gptModel",
    "whisperModel"
  ]);

  return {
    hasApiKey: Boolean(stored.openaiApiKey),
    openaiApiKey: stored.openaiApiKey || "",
    gptModel: stored.gptModel || DEFAULT_SETTINGS.gptModel,
    whisperModel: stored.whisperModel || DEFAULT_SETTINGS.whisperModel
  };
}

async function processAudioChunk(message) {
  const {
    sessionId,
    audioData,
    mimeType,
    fileExtension,
    timestampSeconds,
    recentNotes = []
  } = message;

  if (!sessionId) {
    throw new Error("Missing sessionId.");
  }
  if (!audioData) {
    throw new Error("Missing audioData.");
  }

  const settings = await getSettings();
  if (!settings.openaiApiKey) {
    throw new Error("Missing OpenAI API key. Add one from the extension popup.");
  }

  const transcript = await transcribeChunk({
    apiKey: settings.openaiApiKey,
    whisperModel: settings.whisperModel,
    audioData,
    mimeType: mimeType || "audio/webm",
    fileExtension: fileExtension || ""
  });

  if (!transcript || !transcript.trim()) {
    return { sessionId, note: null, transcript: "", timestampSeconds };
  }

  const note = await generateRealtimeNote({
    apiKey: settings.openaiApiKey,
    model: settings.gptModel,
    timestampSeconds,
    transcriptChunk: transcript,
    recentNotes
  });

  return {
    sessionId,
    timestampSeconds,
    transcript,
    note
  };
}

async function transcribeChunk({
  apiKey,
  whisperModel,
  audioData,
  mimeType,
  fileExtension
}) {
  const normalized = normalizeWhisperFileInfo({ mimeType, fileExtension });
  const audioBuffer = base64ToArrayBuffer(audioData);
  if (audioBuffer.byteLength < MIN_TRANSCRIPTION_BYTES) {
    return "";
  }
  const audioBlob = new Blob([audioBuffer], { type: normalized.mimeType });
  const formData = new FormData();
  formData.append("model", whisperModel);
  formData.append("file", audioBlob, `audio-chunk.${normalized.fileExtension}`);
  formData.append("response_format", "json");

  const response = await fetch(OPENAI_TRANSCRIPTION_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`Whisper API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  return (data.text || "").trim();
}

function normalizeWhisperFileInfo({ mimeType, fileExtension }) {
  const mimeByExtension = {
    flac: "audio/flac",
    m4a: "audio/mp4",
    mp3: "audio/mpeg",
    mp4: "audio/mp4",
    mpeg: "audio/mpeg",
    mpga: "audio/mpeg",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    webm: "audio/webm"
  };
  const extensionByMime = {
    "audio/flac": "flac",
    "audio/mp4": "mp4",
    "video/mp4": "mp4",
    "audio/m4a": "m4a",
    "audio/mpeg": "mp3",
    "audio/mpga": "mpga",
    "audio/ogg": "ogg",
    "video/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/webm": "webm",
    "video/webm": "webm"
  };

  const normalizedExtension = String(fileExtension || "")
    .replace(/^\./, "")
    .trim()
    .toLowerCase();
  const normalizedMimeCandidate = String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (mimeByExtension[normalizedExtension]) {
    return {
      mimeType: mimeByExtension[normalizedExtension],
      fileExtension: normalizedExtension
    };
  }

  const mappedExtension = extensionByMime[normalizedMimeCandidate];
  if (mappedExtension) {
    return {
      mimeType: mimeByExtension[mappedExtension] || "audio/webm",
      fileExtension: mappedExtension
    };
  }

  return {
    mimeType: "audio/webm",
    fileExtension: "webm"
  };
}

async function generateRealtimeNote({
  apiKey,
  model,
  timestampSeconds,
  transcriptChunk,
  recentNotes
}) {
  const payload = {
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are an assistant that creates concise, accurate real-time study notes from video transcript chunks. Use only the provided transcript. Return valid JSON with keys: note (string), tags (array of short strings), confidence (number between 0 and 1)."
      },
      {
        role: "user",
        content: JSON.stringify({
          instruction:
            "Generate one short note (1-2 sentences) that captures the key idea from this chunk. Keep it factual.",
          timestampSeconds,
          transcriptChunk,
          previousNotes: recentNotes.slice(-5)
        })
      }
    ]
  };

  const response = await fetch(OPENAI_CHAT_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await safeReadBody(response);
    throw new Error(`GPT API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  const messageContent = data.choices?.[0]?.message?.content || "{}";
  const parsed = safeJsonParse(messageContent);

  return {
    text: parsed.note || transcriptChunk,
    tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : [],
    confidence:
      typeof parsed.confidence === "number"
        ? Math.max(0, Math.min(1, parsed.confidence))
        : null
  };
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function base64ToArrayBuffer(base64) {
  if (typeof base64 !== "string" || !base64.length) {
    throw new Error("Missing audioData.");
  }

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    throw new Error("Invalid base64 audio payload.");
  }
}

async function safeReadBody(response) {
  try {
    const text = await response.text();
    return text || "No response body.";
  } catch {
    return "Unable to read response body.";
  }
}
