# dsh-minimax-tts

> DeepSeek Harness 语音合成插件 — 本地 + 云端双引擎，带前端朗读按钮

**dsh-minimax-tts** 是 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的 TTS 插件，提供两种核心能力：

1. **Agent 工具**（`tts_synthesize`、`tts_synthesize_long`、`tts_list_voices`）— AI 可以编程调用语音合成
2. **前端朗读按钮** — 点击即可播放任意助手消息的音频

## 特性

- 🎙️ **双引擎路由**：本地 Qwen3-TTS（离线免费）+ Edge TTS（云端快速）
- 🔊 **自动播放**：Agent 合成音频后自动在 UI 播放
- 🎚️ **音色控制面板**：按后端选择音色、语速、语调、音量
- 📖 **长文支持**：自动分段合成，适合播客、有声书
- 🎭 **多语言**：中文（9 预设音色 + 克隆）、英文、日文、韩文
- ⚡ **低延迟**：Edge TTS 每句约 1-2 秒出音频

## 引擎对比

| 引擎 | 速度 | 质量 | 离线 | 语言 |
|------|------|------|------|------|
| **本地 Qwen3-TTS** | ~1× 实时 | 高 (MLX) | ✅ | 中文、英文、日文、韩文 |
| **Edge TTS** | ~0.1× 实时 | 良好 | ❌ | 14 个 zh-CN 音色 |

## 安装

```bash
# 添加到 DSH 插件目录
cd ~/.dsh/plugins
git clone https://github.com/ruyingrufeng/dsh-minimax-tts.git
```

然后重启 DSH 或重新加载插件。

## Agent 工具 API

### `tts_synthesize` — 短文合成（< 2KB）

```json
{
  "text": "你好，世界",
  "voice": "serena",
  "speed": 0.9,
  "volume": 1.0
}
```

返回：`audio_url` + 元数据（时长、字节数、使用的引擎）

### `tts_synthesize_long` — 长文分段合成

同上参数，> 500 字的文本自动拆分为 1KB 分段并拼接。

### `tts_list_voices` — 列出可用音色

返回完整的音色目录和后端能力表。

## 前端功能

- **🔊 朗读按钮**：每条助手消息旁的点击播放
- **浮动播放器**：后台持续播放
- **设置页面**：DSH 设置 → TTS
- **自动播报模式**：自动播放所有回复

## 配置

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

- `backend`：`"local"`（Qwen3-TTS）或 `"edge"`（Edge TTS）
- `autoSpeak`：自动播放每条回复
- 音色选项取决于后端 — 见 `tts_list_voices`

## 本地音色列表（Qwen3-TTS）

| ID | 说明 |
|----|------|
| `vivian` | 明亮女声 |
| `serena` | 温柔女声（默认） |
| `uncle_fu` | 成熟男声 |
| `ryan` | 稳重男声 |
| `aiden` | 英文男声 |
| `ono_anna` | 日文女声 |
| `sohee` | 韩文女声 |
| `eric` | 英文男声 |
| `dylan` | 英文男声 |
| `bailing` | 克隆音色（百灵） |
| `yunxi` | 克隆音色（云希） |

## Edge TTS 音色列表

14 个 zh-CN 音色包括：
- XiaoxiaoNeural（晓晓）— 温暖女声
- XiaoyiNeural（晓伊）— 活泼少女
- YunxiNeural（云希）— 阳光青年
- YunyangNeural（云扬）— 新闻专业
- 方言音色：辽宁、陕西、香港、台湾

## 架构

```
┌─────────────────┐    HTTP API     ┌─────────────────┐
│   DSH 前端       │ ◄────────────► │  dsh-minimax-tts │
│  (朗读按钮、     │                │     服务端        │
│   浮动播放器)     │                │  (/api/minimax-   │
└─────────────────┘                │   tts/*)          │
                                   └────────┬────────┘
                                            │
                       ┌────────────────────┼────────────────────┐
                       ▼                    ▼                    ▼
              ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
              │ 本地 Qwen3   │    │   Edge TTS   │    │  声音克隆     │
              │   -TTS MLX   │    │  (Bing API)  │    │   服务        │
              │   (端口 9893) │    │              │    │   (端口 9894) │
              └──────────────┘    └──────────────┘    └──────────────┘
```

## 要求

- DeepSeek Harness 已安装
- Node.js 18+
- 可选：[Qwen3-TTS MLX](https://github.com/QwenLM/Qwen3-TTS) 用于本地合成
- 可选：[edge-tts](https://github.com/rany2/edge-tts) 用于云端合成

## 开发

```bash
# 安装依赖
npm install

# 构建（ESM 模块，无操作）
npm run build

# 本地测试
npm link
```

## 许可证

MIT License

---

如果这个项目对你有帮助，欢迎 Star ⭐，也欢迎提交 Issue 和 PR。
