const OPENAI_TRANSCRIPTION_ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

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
    audioBuffer,
    mimeType,
    timestampSeconds,
    recentNotes = []
  } = message;

  if (!sessionId) {
    throw new Error("Missing sessionId.");
  }
  if (!audioBuffer) {
    throw new Error("Missing audioBuffer.");
  }

  const settings = await getSettings();
  if (!settings.openaiApiKey) {
    throw new Error("Missing OpenAI API key. Add one from the extension popup.");
  }

  const transcript = await transcribeChunk({
    apiKey: settings.openaiApiKey,
    whisperModel: settings.whisperModel,
    audioBuffer,
    mimeType: mimeType || "audio/webm"
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
  audioBuffer,
  mimeType
}) {
  // Normalize mimeType - strip codecs and map to Whisper-supported format
  const baseMime = (mimeType || "audio/webm").split(";")[0].trim();
  const extensionMap = {
    "audio/webm": "webm",
    "audio/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/flac": "flac"
  };
  const extension = extensionMap[baseMime] || "webm";
  const cleanMime = baseMime || "audio/webm";
  
  const audioBlob = new Blob([audioBuffer], { type: cleanMime });
  const formData = new FormData();
  formData.append("model", whisperModel);
  formData.append("file", audioBlob, `audio-chunk.${extension}`);
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

async function safeReadBody(response) {
  try {
    const text = await response.text();
    return text || "No response body.";
  } catch {
    return "Unable to read response body.";
  }
}
