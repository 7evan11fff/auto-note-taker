const form = document.getElementById("settings-form");
const apiKeyInput = document.getElementById("api-key");
const gptModelInput = document.getElementById("gpt-model");
const whisperModelInput = document.getElementById("whisper-model");
const clearButton = document.getElementById("clear-key");
const statusEl = document.getElementById("status");

init().catch((error) => {
  setStatus(`Failed to load settings: ${error.message}`, true);
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
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff9f9f" : "#96a9ff";
}
