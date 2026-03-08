const STORAGE_SESSIONS_KEY = "savedNoteSessions";
const form = document.getElementById("settings-form");
const apiKeyInput = document.getElementById("api-key");
const gptModelInput = document.getElementById("gpt-model");
const whisperModelInput = document.getElementById("whisper-model");
const clearButton = document.getElementById("clear-key");
const refreshHistoryButton = document.getElementById("refresh-history");
const historyEl = document.getElementById("session-history");
const statusEl = document.getElementById("status");

init().catch((error) => {
  setStatus(`Failed to load popup: ${error.message}`, true);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const openaiApiKey = apiKeyInput.value.trim();
  const gptModel = gptModelInput.value.trim() || "gpt-4o";
  const whisperModel = whisperModelInput.value.trim() || "whisper-1";

  if (!openaiApiKey) {
    setStatus("API key cannot be empty.", true);
    return;
  }

  await chrome.storage.local.set({
    openaiApiKey,
    gptModel,
    whisperModel
  });

  setStatus("Settings saved.");
});

clearButton.addEventListener("click", async () => {
  await chrome.storage.local.remove("openaiApiKey");
  apiKeyInput.value = "";
  setStatus("API key removed.");
});

refreshHistoryButton.addEventListener("click", () => {
  void renderSessionHistory();
});

historyEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const exportId = target.dataset.exportId;
  if (!exportId) {
    return;
  }
  void exportSessionById(exportId);
});

async function init() {
  const { openaiApiKey, gptModel, whisperModel } = await chrome.storage.local.get([
    "openaiApiKey",
    "gptModel",
    "whisperModel"
  ]);

  if (openaiApiKey) {
    apiKeyInput.value = openaiApiKey;
  }
  if (gptModel) {
    gptModelInput.value = gptModel;
  }
  if (whisperModel) {
    whisperModelInput.value = whisperModel;
  }

  await renderSessionHistory();
}

async function renderSessionHistory() {
  const stored = await chrome.storage.local.get(STORAGE_SESSIONS_KEY);
  const sessions = Array.isArray(stored[STORAGE_SESSIONS_KEY]) ? stored[STORAGE_SESSIONS_KEY] : [];

  historyEl.replaceChildren();
  if (!sessions.length) {
    const emptyEl = document.createElement("p");
    emptyEl.className = "history__empty";
    emptyEl.textContent = "No saved note sessions yet.";
    historyEl.appendChild(emptyEl);
    return;
  }

  for (const session of sessions.slice(0, 20)) {
    const itemEl = document.createElement("article");
    itemEl.className = "history-item";

    const titleEl = document.createElement("h3");
    titleEl.className = "history-item__title";
    titleEl.textContent = session.pageTitle || "Untitled page";

    const metaEl = document.createElement("div");
    metaEl.className = "history-item__meta";
    const notesCount = Array.isArray(session.notes) ? session.notes.length : 0;
    const summaryLine = document.createElement("div");
    summaryLine.textContent = `${notesCount} note${notesCount === 1 ? "" : "s"} · ${formatSessionDate(
      session.updatedAt || session.startedAt
    )}`;
    const statusLine = document.createElement("div");
    statusLine.textContent = `Status: ${session.status || "unknown"}`;
    const urlLine = document.createElement("div");
    urlLine.textContent = `URL: ${session.videoUrl || session.pageUrl || "Unknown"}`;
    metaEl.append(summaryLine, statusLine, urlLine);

    const actionsEl = document.createElement("div");
    actionsEl.className = "history-item__actions";
    const exportButton = document.createElement("button");
    exportButton.type = "button";
    exportButton.className = "btn btn-ghost btn-small";
    exportButton.dataset.exportId = session.id || "";
    exportButton.textContent = "Export";
    exportButton.disabled = !session.id || !notesCount;
    actionsEl.appendChild(exportButton);

    itemEl.append(titleEl, metaEl, actionsEl);
    historyEl.appendChild(itemEl);
  }
}

async function exportSessionById(sessionId) {
  const stored = await chrome.storage.local.get(STORAGE_SESSIONS_KEY);
  const sessions = Array.isArray(stored[STORAGE_SESSIONS_KEY]) ? stored[STORAGE_SESSIONS_KEY] : [];
  const session = sessions.find((item) => item?.id === sessionId);
  if (!session) {
    setStatus("Session not found. Refresh history and try again.", true);
    return;
  }
  if (!Array.isArray(session.notes) || !session.notes.length) {
    setStatus("This session has no notes to export.", true);
    return;
  }

  const markdown = buildExportMarkdown(session);
  const safeTitle = String(session.pageTitle || "video-notes")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "video-notes";
  const datePart = new Date().toISOString().slice(0, 10);
  downloadTextFile(markdown, `${safeTitle}-${datePart}.md`);
  setStatus("Session exported.");
}

function buildExportMarkdown(session) {
  const lines = [
    "# Auto Note-Taker Export",
    "",
    `- Video Title: ${session.pageTitle || "Unknown"}`,
    `- Video URL: ${session.videoUrl || session.pageUrl || "Unknown"}`,
    `- Page URL: ${session.pageUrl || "Unknown"}`,
    `- Started: ${session.startedAt || "Unknown"}`,
    `- Ended: ${session.endedAt || session.updatedAt || "Unknown"}`,
    "",
    "## Timestamped Notes",
    ""
  ];

  for (const note of session.notes) {
    const timestamp = formatTimestamp(note.timestampSeconds);
    const tags = Array.isArray(note.tags) && note.tags.length ? ` _(tags: ${note.tags.join(", ")})_` : "";
    lines.push(`- [${timestamp}] ${note.text}${tags}`);
  }

  lines.push("");
  return lines.join("\n");
}

function downloadTextFile(contents, filename) {
  const blob = new Blob([contents], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatSessionDate(value) {
  if (!value) {
    return "unknown time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }
  return date.toLocaleString();
}

function formatTimestamp(seconds) {
  const value = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(value / 3600);
  const mins = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(
      secs
    ).padStart(2, "0")}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff9f9f" : "#96a9ff";
}
