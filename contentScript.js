(() => {
  const CHUNK_DURATION_MS = 12000;
  const MIN_CHUNK_BYTES = 1500;
  const DETECTION_INTERVAL_MS = 2000;

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
    shouldPromptAgain: true
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
    state.shouldPromptAgain = false;

    removePrompt();
    buildPanel();
    bindVideoStateListeners(state.activeVideo);

    try {
      await setupRecorder(state.activeVideo);
      setStatus("Listening to video audio...");
    } catch (error) {
      stopSession();
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
    panelEl.innerHTML = `
      <div class="auto-note-panel__header">
        <div>
          <div class="auto-note-panel__title">Real-Time Notes</div>
          <div class="auto-note-panel__subtitle">Synced to video timestamps</div>
        </div>
        <div class="auto-note-panel__controls">
          <button class="auto-note-panel__close" data-action="minimize" aria-label="Minimize" title="Minimize">─</button>
          <button class="auto-note-panel__close" data-action="stop" aria-label="Stop notes" title="Close">✕</button>
        </div>
      </div>
      <div class="auto-note-panel__status" id="auto-note-status">Starting...</div>
      <div class="auto-note-panel__notes" id="auto-note-notes">
        <div class="auto-note-panel__empty">Notes will appear here as you watch.</div>
      </div>
    `;

    // Drag functionality
    const header = panelEl.querySelector(".auto-note-panel__header");
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      isDragging = true;
      const rect = panelEl.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      panelEl.style.transition = "none";
    });

    document.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const x = e.clientX - dragOffsetX;
      const y = e.clientY - dragOffsetY;
      panelEl.style.left = `${Math.max(0, x)}px`;
      panelEl.style.top = `${Math.max(0, y)}px`;
      panelEl.style.right = "auto";
    });

    document.addEventListener("mouseup", () => {
      isDragging = false;
      panelEl.style.transition = "";
    });

    panelEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.dataset.action === "minimize") {
        panelEl.classList.toggle("auto-note-panel--minimized");
        target.textContent = panelEl.classList.contains("auto-note-panel--minimized") ? "□" : "─";
        target.title = panelEl.classList.contains("auto-note-panel--minimized") ? "Expand" : "Minimize";
        return;
      }

      if (target.dataset.action === "stop") {
        stopSession();
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
  }

  function teardownPanel() {
    if (state.panelEl) {
      state.panelEl.remove();
    }
    state.panelEl = null;
    state.notesContainerEl = null;
    state.statusEl = null;
    state.emptyStateEl = null;
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
    const mimeType = getSupportedMimeType();
    const recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = async (event) => {
      if (!state.isSessionRunning) {
        return;
      }
      const data = event.data;
      if (!data || data.size < MIN_CHUNK_BYTES) {
        return;
      }

      const audioBuffer = await data.arrayBuffer();
      enqueueChunk({
        audioBuffer,
        mimeType: data.type || mimeType || "audio/webm",
        timestampSeconds: video.currentTime
      });
    };

    recorder.onerror = (event) => {
      const message = event?.error?.message || "Unknown recorder error.";
      setStatus(`Recorder error: ${message}`);
    };

    recorder.start(CHUNK_DURATION_MS);

    if (video.paused) {
      recorder.pause();
      setStatus("Waiting for playback...");
    }

    state.recorder = recorder;
  }

  function bindVideoStateListeners(video) {
    const onPlay = () => {
      if (state.recorder?.state === "paused") {
        state.recorder.resume();
      }
      setStatus("Recording audio chunk...");
    };

    const onPause = () => {
      if (state.recorder?.state === "recording") {
        state.recorder.pause();
      }
      setStatus("Playback paused.");
    };

    const onEnded = () => {
      setStatus("Video ended.");
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);

    state.videoListeners = { onPlay, onPause, onEnded };
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
          audioBuffer: chunk.audioBuffer,
          mimeType: chunk.mimeType,
          timestampSeconds: chunk.timestampSeconds,
          recentNotes: state.notes.map((note) => note.text).slice(-5)
        });

        if (!response?.ok) {
          throw new Error(response?.error || "Unknown processing error.");
        }

        if (response.note?.text) {
          const note = {
            timestampSeconds: response.timestampSeconds ?? chunk.timestampSeconds,
            text: response.note.text,
            tags: response.note.tags || []
          };
          state.notes.push(note);
          appendNote(note);
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

  function stopSession() {
    state.isSessionRunning = false;
    state.chunkQueue = [];

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

    if (state.activeVideo) {
      unbindVideoStateListeners(state.activeVideo);
    }

    teardownPanel();
    state.sessionId = null;
    state.notes = [];
    state.shouldPromptAgain = true;

    detectAndHandleVideos();
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
      "audio/mp4"
    ];
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
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
