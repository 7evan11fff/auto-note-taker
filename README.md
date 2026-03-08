# Auto Note-Taker (Chrome Extension, Manifest V3)

Auto Note-Taker detects HTML5 videos on any website and generates timestamped real-time notes using OpenAI Whisper + GPT-4.

## Features

- **Universal video detection** for HTML5 players (YouTube, Vimeo, embeds, etc.)
- **In-page prompt badge** that asks whether to start AI notes
- **Whisper transcription** on rolling audio chunks captured from the active video
- **GPT-4 note generation** for each chunk as the video plays
- **Timestamped notes** aligned to playback position
- **Live side panel UI** that updates in real time
- **API key stored in Chrome extension storage** (`chrome.storage.local`)
- **Clean modern interface** for both the notes panel and settings popup

## Project Structure

- `manifest.json` - Manifest V3 configuration
- `background.js` - Service worker; OpenAI API orchestration (Whisper + GPT)
- `contentScript.js` - Video detection, audio capture, queue, and in-page panel
- `contentStyles.css` - Prompt/panel styling
- `popup.html`, `popup.css`, `popup.js` - API key + model settings UI

## Setup

1. Clone the repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Click the extension icon.
6. Enter your OpenAI API key and save.
7. Open any page with a video and click **Start notes** when prompted.

## How It Works

1. Content script continuously detects visible `<video>` elements.
2. When a valid video is found, it shows a small prompt.
3. On start:
   - The script captures video audio via `captureStream()`.
   - Audio is split into short chunks with `MediaRecorder`.
   - Chunks are sent to the service worker.
4. The service worker:
   - Sends each chunk to OpenAI Whisper for transcription.
   - Sends transcript + context to GPT-4 for concise notes.
5. Notes are returned and rendered in the side panel with timestamps.

## Notes and Limitations

- This extension relies on browser support for `video.captureStream()` and `MediaRecorder`.
- Some sites or stream types may restrict audio capture.
- OpenAI usage incurs API cost based on your account pricing.
