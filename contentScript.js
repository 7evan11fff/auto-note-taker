(() => {
  const CHUNK_DURATION_MS = 12000;
  const MIN_CHUNK_BYTES = 1500;
  const DETECTION_INTERVAL_MS = 2000;
  const STORAGE_SESSIONS_KEY = "savedNoteSessions";
  const MAX_STORED_SESSIONS = 75;

  const state = {
    activeVideo: null,
    sessionId: null,
    promptEl: null,
    panelEl: null,
    notesContainerEl: null,
    statusEl: null,
    emptyStateEl: null,
    recorder: null,
    isSessionRunning: false,
    chunkQueue: [],
    isProcessingQueue: false,
    notes: [],
    settings: null,
    shouldPromptAgain: true,
    videoListeners: null,
    panelDragAbortController: null,
    isPanelMinimized: false,
    capturedStream: null,
    audioStream: null,
    segmentTimerId: null,
    sessionRecord: null,
    stopButtonEl: null
  };

  init();

  function init() {
    if (!chrome?.runtime?.id) {
      return;
    }

    detectAndHandleVideos();
    setInterval(detectAndHandleVideos, DETECTION_INTERVAL_MS);

    const observer = new MutationObserver(() => detectAndHandleVideos());
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  function detectAndHandleVideos() {
    if (state.isSessionRunning) {
      return;
    }

    const videos = [...document.querySelectorAll("video")].filter((video) =>
      isCandidateVideo(video)
    );

    if (!videos.length) {
      removePrompt();
      return;
    }

    const bestVideo = pickBestVideo(videos);
    state.activeVideo = bestVideo;

    if (state.shouldPromptAgain && !state.promptEl) {
      showPrompt();
    }
  }

  function isCandidateVideo(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return false;
    }
    if (!video.isConnected) {
      return false;
    }
    const rect = video.getBoundingClientRect();
    return rect.width >= 200 && rect.height >= 120;
  }

  function pickBestVideo(videos) {
    const scored = videos.map((video) => {
      const rect = video.getBoundingClientRect();
      const area = rect.width * rect.height;
      const score = area + (video.paused ? 0 : 1_000_000);
      return { video, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].video;
  }

  function showPrompt() {
    removePrompt();

    const promptEl = document.createElement("div");
    promptEl.className = "auto-note-prompt";
    promptEl.innerHTML = `
      <div class="auto-note-prompt__title">Video detected</div>
      <div class="auto-note-prompt__text">Generate real-time AI notes for this video?</div>
      <div class="auto-note-prompt__actions">
        <button class="auto-note-btn auto-note-btn--primary" data-action="start">Start notes</button>
        <button class="auto-note-btn auto-note-btn--ghost" data-action="dismiss">Later</button>
      </div>
    `;

    promptEl.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const action = target.dataset.action;
      if (action === "start") {
        await startSession();
      }
      if (action === "dismiss") {
        state.shouldPromptAgain = false;
        removePrompt();
      }
    });

    document.body.appendChild(promptEl);
    state.promptEl = promptEl;
  }

  function removePrompt() {
    if (state.promptEl) {
      state.promptEl.remove();
      state.promptEl = null;
    }
  }

  async function startSession() {
    if (!state.activeVideo || state.isSessionRunning) {
      return;
    }

    const response = await sendMessage({ type: "GET_SETTINGS" });
    if (!response?.ok || !response.settings?.hasApiKey) {
      showInlineError("Open the extension popup and save your OpenAI API key first.");
      return;
    }

    state.settings = response.settings;
    state.sessionId = crypto.randomUUID();
    state.isSessionRunning = true;
    state.chunkQueue = [];
    state.notes = [];
    state.sessionRecord = null;
    state.shouldPromptAgain = false;

    removePrompt();
    await startSessionPersistence();
    buildPanel();
    bindVideoStateListeners(state.activeVideo);

    try {
      await setupRecorder(state.activeVideo);
      setStatus("Listening to video audio...");
    } catch (error) {
      await closeSessionPanel("error");
      showInlineError(error.message || "Unable to access video audio.");
    }
  }

  function showInlineError(message) {
    removePrompt();
    const promptEl = document.createElement("div");
    promptEl.className = "auto-note-prompt auto-note-prompt--error";
    promptEl.innerHTML = `
      <div class="auto-note-prompt__title">Auto Note-Taker</div>
      <div class="auto-note-prompt__text">${escapeHtml(message)}</div>
      <div class="auto-note-prompt__actions">
        <button class="auto-note-btn auto-note-btn--ghost" data-action="close">Close</button>
      </div>
    `;
    promptEl.addEventListener("click", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.dataset.action === "close") {
        promptEl.remove();
      }
    });
    document.body.appendChild(promptEl);
    state.promptEl = promptEl;
  }

  function buildPanel() {
    teardownPanel();

    const panelEl = document.createElement("aside");
    panelEl.className = "auto-note-panel";
    if (state.isPanelMinimized) {
      panelEl.classList.add("auto-note-panel--minimized");
    }
    panelEl.innerHTML = `
      <div class="auto-note-panel__header">
        <div>
          <div class="auto-note-panel__title">Real-Time Notes</div>
          <div class="auto-note-panel__subtitle">Synced to video timestamps</div>
        </div>
        <div class="auto-note-panel__controls">
          <button class="auto-note-panel__close" data-action="minimize" aria-label="Minimize" title="Minimize">─</button>
          <button class="auto-note-panel__close" data-action="close" aria-label="Close notes panel" title="Close panel">✕</button>
        </div>
      </div>
      <div class="auto-note-panel__body">
        <div class="auto-note-panel__actions">
          <button class="auto-note-btn auto-note-btn--danger auto-note-panel__action-btn" data-action="stop-transcribing">Stop Transcribing</button>
          <button class="auto-note-btn auto-note-btn--ghost auto-note-panel__action-btn" data-action="export-notes">Export Notes</button>
        </div>
        <div class="auto-note-panel__status" id="auto-note-status">Starting...</div>
        <div class="auto-note-panel__notes" id="auto-note-notes">
          <div class="auto-note-panel__empty">Notes will appear here as you watch.</div>
        </div>
      </div>
    `;

    setupPanelDragging(panelEl);

    panelEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.dataset.action === "minimize") {
        state.isPanelMinimized = !panelEl.classList.contains("auto-note-panel--minimized");
        panelEl.classList.toggle("auto-note-panel--minimized", state.isPanelMinimized);
        target.textContent = state.isPanelMinimized ? "□" : "─";
        target.title = state.isPanelMinimized ? "Expand" : "Minimize";
        return;
      }

      if (target.dataset.action === "close") {
        void closeSessionPanel("closed");
        return;
      }

      if (target.dataset.action === "stop-transcribing") {
        void stopTranscriptionSession("stopped");
        return;
      }

      if (target.dataset.action === "export-notes") {
        exportNotes();
        return;
      }

      const timestamp = target.dataset.seekTo;
      if (timestamp && state.activeVideo) {
        state.activeVideo.currentTime = Number(timestamp);
        if (state.activeVideo.paused) {
          state.activeVideo.play().catch(() => {});
        }
      }
    });

    document.body.appendChild(panelEl);

    state.panelEl = panelEl;
    state.notesContainerEl = panelEl.querySelector("#auto-note-notes");
    state.statusEl = panelEl.querySelector("#auto-note-status");
    state.emptyStateEl = panelEl.querySelector(".auto-note-panel__empty");
    state.stopButtonEl = panelEl.querySelector('[data-action="stop-transcribing"]');
    const minimizeButton = panelEl.querySelector('[data-action="minimize"]');
    if (minimizeButton instanceof HTMLElement && state.isPanelMinimized) {
      minimizeButton.textContent = "□";
      minimizeButton.title = "Expand";
    }
    syncSessionButtons();
  }

  function teardownPanel() {
    if (state.panelDragAbortController) {
      state.panelDragAbortController.abort();
      state.panelDragAbortController = null;
    }
    if (state.panelEl) {
      state.panelEl.remove();
    }
    state.panelEl = null;
    state.notesContainerEl = null;
    state.statusEl = null;
    state.emptyStateEl = null;
    state.stopButtonEl = null;
  }

  async function setupRecorder(video) {
    if (!video.captureStream) {
      throw new Error("This page does not allow stream capture for the selected video.");
    }
    if (typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder is not available in this browser context.");
    }

    const capturedStream = video.captureStream();
    const audioTracks = capturedStream.getAudioTracks();
    if (!audioTracks.length) {
      throw new Error("No audio track detected on this video.");
    }

    const audioOnlyStream = new MediaStream(audioTracks);
    const mimeType = getSupportedRecorderMimeType();
    const recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : undefined);
    state.capturedStream = capturedStream;
    state.audioStream = audioOnlyStream;

    recorder.ondataavailable = async (event) => {
      if (!state.isSessionRunning) {
        return;
      }
      const data = event.data;
      if (!data || data.size < MIN_CHUNK_BYTES) {
        return;
      }

      try {
        const audioBuffer = await data.arrayBuffer();
        const audioData = arrayBufferToBase64(audioBuffer);
        const normalizedMimeType = normalizeWhisperMimeType(data.type || recorder.mimeType || mimeType);
        enqueueChunk({
          audioData,
          mimeType: normalizedMimeType,
          fileExtension: getWhisperFileExtension(normalizedMimeType),
          timestampSeconds: video.currentTime
        });
      } catch {
        setStatus("Skipped malformed audio segment.");
      }
    };

    recorder.onerror = (event) => {
      const message = event?.error?.message || "Unknown recorder error.";
      setStatus(`Recorder error: ${message}`);
    };

    recorder.onstop = () => {
      clearSegmentTimer();
      if (!state.isSessionRunning || !state.activeVideo || state.activeVideo.paused || state.activeVideo.ended) {
        return;
      }
      startRecorderSegment();
    };

    state.recorder = recorder;
    if (video.paused) {
      setStatus("Waiting for playback...");
      return;
    }
    startRecorderSegment();
  }

  function bindVideoStateListeners(video) {
    const onPlay = () => {
      startRecorderSegment();
    };

    const onPause = () => {
      if (state.recorder?.state === "recording") {
        try {
          state.recorder.stop();
        } catch {
          // Best-effort pause handling.
        }
      }
      clearSegmentTimer();
      setStatus("Playback paused.");
    };

    const onEnded = () => {
      if (state.recorder?.state === "recording") {
        try {
          state.recorder.stop();
        } catch {
          // Best-effort shutdown.
        }
      }
      clearSegmentTimer();
      setStatus("Video ended.");
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);

    state.videoListeners = { onPlay, onPause, onEnded };
  }

  function startRecorderSegment() {
    if (!state.isSessionRunning || !state.recorder || state.recorder.state !== "inactive") {
      return;
    }
    try {
      state.recorder.start();
      scheduleSegmentStop();
      setStatus("Recording audio chunk...");
    } catch (error) {
      setStatus(`Recorder start failed: ${error.message || "Unknown error."}`);
    }
  }

  function scheduleSegmentStop() {
    clearSegmentTimer();
    state.segmentTimerId = window.setTimeout(() => {
      state.segmentTimerId = null;
      if (!state.isSessionRunning || !state.recorder || state.recorder.state !== "recording") {
        return;
      }
      try {
        state.recorder.stop();
      } catch {
        // Best-effort segment boundary.
      }
    }, CHUNK_DURATION_MS);
  }

  function clearSegmentTimer() {
    if (state.segmentTimerId !== null) {
      window.clearTimeout(state.segmentTimerId);
      state.segmentTimerId = null;
    }
  }

  function unbindVideoStateListeners(video) {
    if (!video || !state.videoListeners) {
      return;
    }
    video.removeEventListener("play", state.videoListeners.onPlay);
    video.removeEventListener("pause", state.videoListeners.onPause);
    video.removeEventListener("ended", state.videoListeners.onEnded);
    state.videoListeners = null;
  }

  function enqueueChunk(chunk) {
    state.chunkQueue.push(chunk);
    processChunkQueue();
  }

  async function processChunkQueue() {
    if (state.isProcessingQueue || !state.isSessionRunning) {
      return;
    }
    state.isProcessingQueue = true;

    while (state.chunkQueue.length && state.isSessionRunning) {
      const chunk = state.chunkQueue.shift();
      setStatus("Transcribing and generating note...");
      try {
        const response = await sendMessage({
          type: "PROCESS_AUDIO_CHUNK",
          sessionId: state.sessionId,
          audioData: chunk.audioData,
          mimeType: chunk.mimeType,
          fileExtension: chunk.fileExtension,
          timestampSeconds: chunk.timestampSeconds,
          recentNotes: state.notes.map((note) => note.text).slice(-5)
        });

        if (!response?.ok) {
          throw new Error(response?.error || "Unknown processing error.");
        }
        if (!state.isSessionRunning) {
          break;
        }

        if (response.note?.text) {
          const note = {
            timestampSeconds: response.timestampSeconds ?? chunk.timestampSeconds,
            text: response.note.text,
            tags: response.note.tags || []
          };
          state.notes.push(note);
          appendNote(note);
          void persistSessionSnapshot(state.isSessionRunning ? "running" : "stopped");
          setStatus("Listening to video audio...");
        } else {
          setStatus("No speech detected in this chunk.");
        }
      } catch (error) {
        setStatus(`Error: ${error.message || "Failed to process chunk."}`);
      }
    }

    state.isProcessingQueue = false;
  }

  function appendNote(note) {
    if (!state.notesContainerEl) {
      return;
    }
    if (state.emptyStateEl) {
      state.emptyStateEl.remove();
      state.emptyStateEl = null;
    }

    const item = document.createElement("article");
    item.className = "auto-note-item";
    const timestampLabel = formatTimestamp(note.timestampSeconds);
    item.innerHTML = `
      <button class="auto-note-item__timestamp" data-seek-to="${String(
        note.timestampSeconds
      )}" title="Jump to ${timestampLabel}">
        ${timestampLabel}
      </button>
      <div class="auto-note-item__text">${escapeHtml(note.text)}</div>
      ${
        note.tags?.length
          ? `<div class="auto-note-item__tags">${note.tags
              .slice(0, 4)
              .map((tag) => `<span class="auto-note-item__tag">${escapeHtml(tag)}</span>`)
              .join("")}</div>`
          : ""
      }
    `;

    state.notesContainerEl.appendChild(item);
    state.notesContainerEl.scrollTop = state.notesContainerEl.scrollHeight;
  }

  function setStatus(message) {
    if (state.statusEl) {
      state.statusEl.textContent = message;
    }
  }

  async function stopTranscriptionSession(status = "stopped") {
    if (!state.isSessionRunning && !state.recorder) {
      return;
    }

    state.isSessionRunning = false;
    state.chunkQueue = [];
    clearSegmentTimer();

    if (state.recorder) {
      try {
        if (state.recorder.state !== "inactive") {
          state.recorder.stop();
        }
      } catch {
        // Best-effort shutdown.
      }
      state.recorder = null;
    }
    stopStreamTracks(state.audioStream);
    stopStreamTracks(state.capturedStream);
    state.audioStream = null;
    state.capturedStream = null;

    if (state.activeVideo) {
      unbindVideoStateListeners(state.activeVideo);
    }

    await persistSessionSnapshot(status);
    setStatus("Transcription stopped. Notes were saved.");
    syncSessionButtons();
  }

  async function closeSessionPanel(status = "stopped") {
    await stopTranscriptionSession(status);
    teardownPanel();
    state.sessionId = null;
    state.sessionRecord = null;
    state.notes = [];
    state.shouldPromptAgain = true;

    detectAndHandleVideos();
  }

  function stopStreamTracks(stream) {
    if (!stream) {
      return;
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  function formatTimestamp(seconds) {
    const value = Math.max(0, Math.floor(seconds || 0));
    const hrs = Math.floor(value / 3600);
    const mins = Math.floor((value % 3600) / 60);
    const secs = value % 60;

    if (hrs > 0) {
      return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(
        2,
        "0"
      )}:${String(secs).padStart(2, "0")}`;
    }
    return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  function getSupportedMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
      "audio/mp4"
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  }

  function getSupportedRecorderMimeType() {
    return getSupportedMimeType();
  }

  function normalizeWhisperMimeType(rawMimeType) {
    const baseMimeType = String(rawMimeType || "audio/webm")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const normalizedMimeMap = {
      "audio/webm": "audio/webm",
      "video/webm": "audio/webm",
      "audio/ogg": "audio/ogg",
      "video/ogg": "audio/ogg",
      "audio/mp4": "audio/mp4",
      "video/mp4": "audio/mp4",
      "audio/mpeg": "audio/mpeg",
      "audio/mpga": "audio/mpeg",
      "audio/wav": "audio/wav",
      "audio/x-wav": "audio/wav",
      "audio/flac": "audio/flac",
      "audio/m4a": "audio/mp4"
    };
    return normalizedMimeMap[baseMimeType] || "audio/webm";
  }

  function getWhisperFileExtension(mimeType) {
    const extensionByMime = {
      "audio/webm": "webm",
      "audio/ogg": "ogg",
      "audio/mp4": "mp4",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/flac": "flac"
    };
    return extensionByMime[mimeType] || "webm";
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    const binaryChunks = [];

    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binaryChunks.push(String.fromCharCode(...chunk));
    }

    return btoa(binaryChunks.join(""));
  }

  function setupPanelDragging(panelEl) {
    const headerEl = panelEl.querySelector(".auto-note-panel__header");
    if (!(headerEl instanceof HTMLElement)) {
      return;
    }

    const abortController = new AbortController();
    state.panelDragAbortController = abortController;

    let pointerId = null;
    let offsetX = 0;
    let offsetY = 0;

    headerEl.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button !== 0) {
          return;
        }
        const eventTarget = event.target;
        if (eventTarget instanceof Element && eventTarget.closest("button")) {
          return;
        }

        pointerId = event.pointerId;
        const rect = panelEl.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        panelEl.style.left = `${rect.left}px`;
        panelEl.style.top = `${rect.top}px`;
        panelEl.style.right = "auto";
        panelEl.style.bottom = "auto";
        headerEl.setPointerCapture(pointerId);
      },
      { signal: abortController.signal }
    );

    headerEl.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== pointerId) {
          return;
        }

        const panelRect = panelEl.getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - panelRect.width);
        const maxTop = Math.max(0, window.innerHeight - panelRect.height);
        const nextLeft = Math.min(maxLeft, Math.max(0, event.clientX - offsetX));
        const nextTop = Math.min(maxTop, Math.max(0, event.clientY - offsetY));

        panelEl.style.left = `${nextLeft}px`;
        panelEl.style.top = `${nextTop}px`;
      },
      { signal: abortController.signal }
    );

    const releaseDragState = (event) => {
      if (event.pointerId !== pointerId) {
        return;
      }
      if (headerEl.hasPointerCapture(pointerId)) {
        headerEl.releasePointerCapture(pointerId);
      }
      pointerId = null;
    };

    headerEl.addEventListener("pointerup", releaseDragState, { signal: abortController.signal });
    headerEl.addEventListener("pointercancel", releaseDragState, { signal: abortController.signal });
  }

  function syncSessionButtons() {
    if (!(state.stopButtonEl instanceof HTMLButtonElement)) {
      return;
    }
    state.stopButtonEl.disabled = !state.isSessionRunning;
    state.stopButtonEl.textContent = state.isSessionRunning
      ? "Stop Transcribing"
      : "Transcription Stopped";
  }

  async function startSessionPersistence() {
    const nowIso = new Date().toISOString();
    const session = {
      id: state.sessionId,
      pageUrl: window.location.href,
      pageTitle: document.title || "Untitled page",
      videoUrl: getVideoSource(state.activeVideo) || window.location.href,
      startedAt: nowIso,
      updatedAt: nowIso,
      endedAt: null,
      status: "running",
      notes: []
    };
    state.sessionRecord = session;
    await upsertStoredSession(session);
  }

  async function persistSessionSnapshot(status = "running") {
    if (!state.sessionRecord || !state.sessionRecord.id) {
      return;
    }

    const nowIso = new Date().toISOString();
    const persisted = {
      ...state.sessionRecord,
      notes: state.notes.map((note) => ({ ...note })),
      status,
      updatedAt: nowIso,
      endedAt: status === "running" ? null : state.sessionRecord.endedAt || nowIso
    };
    state.sessionRecord = persisted;
    await upsertStoredSession(persisted);
  }

  async function upsertStoredSession(session) {
    try {
      const existing = await chrome.storage.local.get(STORAGE_SESSIONS_KEY);
      const sessions = Array.isArray(existing[STORAGE_SESSIONS_KEY])
        ? [...existing[STORAGE_SESSIONS_KEY]]
        : [];
      const index = sessions.findIndex((item) => item?.id === session.id);
      if (index >= 0) {
        sessions[index] = session;
      } else {
        sessions.unshift(session);
      }
      sessions.sort((a, b) => {
        const aTime = Date.parse(a?.updatedAt || a?.startedAt || 0);
        const bTime = Date.parse(b?.updatedAt || b?.startedAt || 0);
        return bTime - aTime;
      });
      await chrome.storage.local.set({
        [STORAGE_SESSIONS_KEY]: sessions.slice(0, MAX_STORED_SESSIONS)
      });
    } catch {
      setStatus("Could not persist notes to extension storage.");
    }
  }

  function getVideoSource(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return "";
    }
    return video.currentSrc || video.src || "";
  }

  function exportNotes() {
    const session = state.sessionRecord
      ? {
          ...state.sessionRecord,
          notes: state.notes.map((note) => ({ ...note }))
        }
      : null;
    if (!session || !Array.isArray(session.notes) || !session.notes.length) {
      setStatus("No notes yet. Keep watching to generate notes.");
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
    setStatus("Exported notes.");
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
      const tagSuffix = Array.isArray(note.tags) && note.tags.length
        ? ` _(tags: ${note.tags.join(", ")})_`
        : "";
      lines.push(`- [${timestamp}] ${note.text}${tagSuffix}`);
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

  function escapeHtml(raw) {
    return String(raw)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function sendMessage(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response);
      });
    });
  }
})();
