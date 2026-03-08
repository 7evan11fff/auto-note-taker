# Auto Note-Taker

Chrome extension that automatically detects videos on any website and takes real-time notes using OpenAI.

## Features

- 🎥 **Universal Video Detection** - Works on YouTube, Vimeo, embedded videos, and any HTML5 video
- 📝 **Real-Time Notes** - Notes sync with video playback so you know exactly what part each note references
- 🤖 **AI-Powered** - Uses OpenAI GPT-4 for intelligent summarization
- ⏱️ **Timestamped** - Each note includes the video timestamp for easy reference
- 🎯 **Non-Intrusive** - Small popup asks if you want to take notes, stays out of your way

## Setup

1. Clone this repo
2. Go to `chrome://extensions/`
3. Enable "Developer mode"
4. Click "Load unpacked" and select this folder
5. Click the extension icon and enter your OpenAI API key

## How It Works

1. Browse to any page with a video
2. A small popup appears asking if you want to take notes
3. Click "Yes" to start
4. Notes appear in real-time as you watch
5. Each note shows the timestamp it references

## Tech Stack

- Chrome Extension Manifest V3
- OpenAI GPT-4 API (Whisper for transcription)
- Vanilla JS for lightweight performance
