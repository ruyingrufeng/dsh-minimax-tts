# dsh-minimax-tts

> DeepSeek Harness TTS plugin — local & cloud voice synthesis with frontend playback

**dsh-minimax-tts** is a voice synthesis plugin for [DeepSeek Harness](https://github.com/deepseek-ai/dsh). It adds two core capabilities:

1. **Agent tools** (`tts_synthesize`, `tts_synthesize_long`, `tts_list_voices`) — let AI agents synthesize speech programmatically
2. **Frontend read-aloud button** — click-to-play audio on any assistant message

## Features

- 🎙️ **Dual backend routing**: Local Qwen3-TTS (offline, free) + Edge TTS (cloud, fast)
- 🔊 **Auto-play on tool results**: Agent-synthesized audio plays automatically in the UI
- 🎚️ **Voice control panel**: Select voice, speed, pitch, volume per backend
- 📖 **Long text support**: Automatic chunking for books, podcasts, long-form content
- 🎭 **Multi-language**: Chinese (9 preset voices + clone), English, Japanese, Korean
- ⚡ **Low latency**: Edge TTS returns audio in ~1-2 seconds per sentence

## Backend Comparison

| Backend | Speed | Quality | Offline | Languages |
|---------|-------|---------|---------|-----------|
| **Local Qwen3-TTS** | ~1× realtime | High (MLX) | ✅ | CN, EN, JP, KR |
| **Edge TTS** | ~0.1× realtime | Good | ❌ | 14 zh-CN voices |

## Installation

```bash
# Add to your DSH plugins directory
cd ~/.dsh/plugins
git clone https://github.com/ruyingrufeng/dsh-minimax-tts.git
```

Then restart DSH or reload plugins.

## Agent Tool API

### `tts_synthesize` — Short text synthesis (< 2KB)

```json
{
  "text": "你好，世界",
  "voice": "serena",
  "speed": 0.9,
  "volume": 1.0
}
```

Returns: `audio_url` + metadata (duration, bytes, backend used).

### `tts_synthesize_long` — Long text with auto-chunking

Same parameters, text > 500 chars auto-splits into 1KB chunks and concatenates.

### `tts_list_voices` — List available voices

Returns full voice catalog with backend capabilities.

## Frontend Features

- **🔊 Read-aloud button** on each assistant message
- **Floating audio player** for background playback
- **Settings page** under DSH settings → TTS
- **Auto-speak mode**: Automatically play every response

## Configuration

```json
{
  "autoSpeak": false,
  "backend": "local",
  "voice": "serena",
  "speed": 0.9,
  "pitch": 0,
  "volume": 1.0
}
```

- `backend`: `"local"` (Qwen3-TTS) or `"edge"` (Edge TTS)
- `autoSpeak`: Auto-play every response
- Voice options depend on backend — see `tts_list_voices`

## Local Voice List (Qwen3-TTS)

| ID | Description |
|----|-------------|
| `vivian` | Bright female voice |
| `serena` | Gentle female voice (default) |
| `uncle_fu` | Mature male voice |
| `ryan` | Steady male voice |
| `aiden` | English male voice |
| `ono_anna` | Japanese female voice |
| `sohee` | Korean female voice |
| `eric` | English male voice |
| `dylan` | English male voice |
| `bailing` | Cloned voice (百灵) |
| `yunxi` | Cloned voice (云希) |

## Edge TTS Voice List

14 zh-CN voices including:
- XiaoxiaoNeural (晓晓) — warm female
- XiaoyiNeural (晓伊) — lively girl
- YunxiNeural (云希) — sunny boy
- YunyangNeural (云扬) — news professional
- Plus regional dialects: Liaoning, Shaanxi, Hong Kong, Taiwan

## Architecture

```
┌─────────────────┐    HTTP API     ┌─────────────────┐
│   DSH Frontend   │ ◄────────────► │  dsh-minimax-   │
│  (read-aloud btn,│                │     tts server  │
│   audio player)  │                │  (/api/minimax- │
└─────────────────┘                │   tts/*)         │
                                   └────────┬────────┘
                                            │
                       ┌────────────────────┼────────────────────┐
                       ▼                    ▼                    ▼
              ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
              │ Local Qwen3  │    │   Edge TTS   │    │ Voice Clone  │
              │   -TTS MLX   │    │  (Bing API)  │    │   Service    │
              │   (port 9893)│    │              │    │   (port 9894)│
              └──────────────┘    └──────────────┘    └──────────────┘
```

## Requirements

- DeepSeek Harness installed
- Node.js 18+ (for DSH runtime)
- Optional: [Qwen3-TTS MLX](https://github.com/QwenLM/Qwen3-TTS) for local synthesis
- Optional: [edge-tts](https://github.com/rany2/edge-tts) for cloud synthesis

## Development

```bash
# Install dependencies
npm install

# Build (no-op, this is an ESM module)
npm run build

# Test locally by linking to DSH plugins dir
npm link
```

## License

MIT License
