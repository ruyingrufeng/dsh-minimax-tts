// dsh-minimax-tts/server — MiniMax TTS plugin for DeepSeek Harness
// API: POST https://api.minimaxi.com/v1/t2a_v2  → base64 mp3
// 提供两个 agent 工具：
//   - tts_synthesize       短文(≤2KB)合成,直接返回 base64
//   - tts_synthesize_long  长文自动分段,按 1KB 切句并顺序拼接
// 不提供 webServer 自挂路由(避免 dsh-cron 那种状态路由顺序坑)

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';

export const name = 'dsh-minimax-tts';
export const inject = ['tools', 'webServer'];
// 让 cordis Loader 直接拿到 apply
export default { name, inject, apply };

// 默认声线:本地 Qwen3-TTS 的温柔女声(2026-09-13 MiniMax 停用后,默认后端改为本地)
export const DEFAULT_VOICE = 'serena';
export const DEFAULT_EMOTION = 'neutral';
export const DEFAULT_SPEED = 0.9;
export const DEFAULT_PITCH = 0;     // Hz,仅 edge 支持
export const DEFAULT_VOLUME = 1.0;  // 倍率

// 合成后 mp3 临时目录(供 /api/minimax-tts/audio/:id 取文件)
import { statSync, unlinkSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const AUDIO_CACHE_DIR = '/Users/jacky/.dsh/storage/dsh-minimax-tts/audio';
mkdirSync(AUDIO_CACHE_DIR, { recursive: true });
// 启动时清理超过 1 小时的旧文件,防止磁盘累积
for (const f of readdirSync(AUDIO_CACHE_DIR)) {
  try {
    const p = `${AUDIO_CACHE_DIR}/${f}`;
    const age = (Date.now() - statSync(p).mtimeMs) / 1000;
    if (age > 3600) unlinkSync(p);
  } catch {}
}

// ===== 配置存储(JSON 文件,~/.dsh/storage/dsh-minimax-tts/config.json) =====
const CONFIG_DIR = '/Users/jacky/.dsh/storage/dsh-minimax-tts';
mkdirSync(CONFIG_DIR, { recursive: true });
const CONFIG_PATH = `${CONFIG_DIR}/config.json`;
const DEFAULT_CONFIG = {
  autoSpeak: false,           // 自动播报:每条回复结束后自动朗读
  backend: 'local',           // local | edge(MiniMax/auto/bailing 已于 2026-09-13 移除)
  voice: DEFAULT_VOICE,       // 音色(须属于当前后端)
  emotion: DEFAULT_EMOTION,   // 情绪(现役引擎均不使用,保留字段兼容历史配置)
  speed: DEFAULT_SPEED,       // 语速 0.6-1.6(本地 atempo / edge --rate / 克隆 speed)
  emotionMode: 'off',         // 朗读情绪: off=整段统一语气 | auto=按上下文分段自动配情绪(2026-09-14)
  pitch: DEFAULT_PITCH,       // 语调 Hz ±50(仅 edge)
  volume: DEFAULT_VOLUME      // 音量 0.4-1.6(本地 ffmpeg volume / edge --volume)
};
let cachedConfig = null;
function loadConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    cachedConfig = normalizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
  } catch {
    cachedConfig = { ...DEFAULT_CONFIG };
  }
  return cachedConfig;
}
// 历史配置迁移:auto/minimax 后端已移除 → 落回 local;音色不属于当前后端 → 用该后端默认音色。
// 旧云端音色名(female-chengshu 等)按 MINIMAX_TO_LOCAL_VOICE 映射到本地音色,保住用户原来的声线偏好。
function normalizeConfig(cfg) {
  const next = { ...cfg };
  // 已移除的后端(historical):auto/minimax → local;bailing(百灵克隆) → local(温柔女声最接近)
  if (!BACKEND_IDS.includes(next.backend)) next.backend = 'local';
  // 已移除的字段:fallback(降级链随 MiniMax 一并去掉)
  delete next.fallback;
  if (typeof next.pitch !== 'number') next.pitch = DEFAULT_PITCH;
  if (typeof next.volume !== 'number') next.volume = DEFAULT_VOLUME;
  if (typeof next.speed !== 'number') next.speed = DEFAULT_SPEED;
  // 朗读情绪模式: 只认 off/auto, 其它值(含旧配置里残留的)一律回落到 off
  if (next.emotionMode !== 'auto') next.emotionMode = 'off';
  if (!isValidVoiceFor(next.backend, next.voice)) {
    const mapped = MINIMAX_TO_LOCAL_VOICE[next.voice];
    if (mapped && isValidVoiceFor(next.backend, mapped)) {
      next.voice = mapped;
    } else {
      const caps = backendCaps(next.backend);
      next.voice = caps ? caps.defaultVoice : DEFAULT_VOICE;
    }
  }
  return next;
}
function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  cachedConfig = next;
  return next;
}

// 真实 API 参数 schema(给前端 UI / agent 直查用)
// 音色清单:单一数据源,前端设置页下拉 + 试听 + tts_list_voices 都从这里来
// 2026-09-13:MiniMax 已停用(未续费),其音色表 VOICE_LIST/VOICES 一并移除;
// 现役引擎只有 本地 Qwen3-TTS / Edge TTS / 百灵克隆 三个。
const EMOTIONS = ['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'];

// 本地 Qwen3-TTS(MLX 服务,端口 9893)音色清单 —— 与云端音色互不通用
const LOCAL_PRESET_VOICE_LIST = [
  { id: 'vivian', label: '明亮女声', desc: '中文女声 · 本地 Qwen3' },
  { id: 'serena', label: '温柔女声', desc: '中文女声 · 本地 Qwen3' },
  { id: 'uncle_fu', label: '大叔男声', desc: '中文男声 · 本地 Qwen3' },
  { id: 'ryan', label: '稳重男声', desc: '中文男声 · 本地 Qwen3' },
  { id: 'aiden', label: '英文男声', desc: '英文男声 · 本地 Qwen3' },
  { id: 'ono_anna', label: '日文女声', desc: '日文女声 · 本地 Qwen3' },
  { id: 'sohee', label: '韩文女声', desc: '韩文女声 · 本地 Qwen3' },
  { id: 'eric', label: '英文男声', desc: '英文男声 · 本地 Qwen3' },
  { id: 'dylan', label: '英文男声', desc: '英文男声 · 本地 Qwen3' }
];

// 声音克隆音色（2026-09-14 接入）—— 由独立的 9894 克隆服务提供，**不是同一个端点**。
// 参考音频库：~/voice-tools/clone-voices/<id>/（ref.wav + ref.txt + meta.json）
// 管理命令：qwen3-tts-clone voice-add / voice-list / voice-rm
//
// ⚠️ 新增克隆音色后必须把 id/label 同步加到这里，否则插件不认识它，
//    会被 pickVoiceForBackend 当成非法音色替换成默认音色（听起来"选了没变"）。
// clone:true 是给前端的分流标记：这些音色要打 9894，其余打 9893。
const LOCAL_CLONE_VOICE_LIST = [
  { id: 'bailing', label: '百灵（克隆）', desc: '声音克隆 · ref_p3 样本', clone: true },
  { id: 'yunxi', label: '云希（克隆）', desc: '声音克隆 · edge 云希样本', clone: true }
];

const LOCAL_VOICE_LIST = [...LOCAL_PRESET_VOICE_LIST, ...LOCAL_CLONE_VOICE_LIST];
const LOCAL_VOICE_IDS = LOCAL_VOICE_LIST.map(v => v.id);
// 克隆音色 id 集合：前端口径要与之一致（见 client.js 的 CLONE_VOICE_IDS）
const LOCAL_CLONE_VOICE_IDS = LOCAL_CLONE_VOICE_LIST.map(v => v.id);

// Edge TTS(免费云端)音色清单 —— 与 MiniMax/本地音色互不通用。
// 之前设置页在 backend=edge 时仍显示 MiniMax 音色名,再经 EDGE_VOICE_MAP 硬映射,
// 结果 10 个选项里有两个落到同一音色、两个落成方言("声音选项不太对")。
// 现在直接列 edge 真实音色,并支持 --rate(语速) / --pitch(语调)。
// 来源:`edge-tts --list-voices` 实测(2026-09-13),共 14 个中文音色。
const EDGE_VOICE_LIST = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温暖女声', desc: 'zh-CN · News/Novel · 默认', gender: 'female' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼少女', desc: 'zh-CN · Cartoon/Novel · 清亮', gender: 'female' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光青年', desc: 'zh-CN · Novel · 男声', gender: 'male' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 新闻男声', desc: 'zh-CN · News · 专业稳重', gender: 'male' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 激情男声', desc: 'zh-CN · Sports · 解说感', gender: 'male' },
  { id: 'zh-CN-YunxiaNeural', label: '云夏 · 可爱少年', desc: 'zh-CN · Cartoon · 男声', gender: 'male' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女声', desc: 'zh-CN 辽宁 · 方言', gender: 'female' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西女声', desc: 'zh-CN 陕西 · 方言', gender: 'female' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 粤语女声', desc: 'zh-HK · 粤语', gender: 'female' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声', desc: 'zh-HK · 粤语', gender: 'female' },
  { id: 'zh-HK-WanLungNeural', label: '雲龍 · 粤语男声', desc: 'zh-HK · 粤语', gender: 'male' },
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声', desc: 'zh-TW · 台湾腔', gender: 'female' },
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨 · 台湾女声', desc: 'zh-TW · 台湾腔', gender: 'female' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲 · 台湾男声', desc: 'zh-TW · 台湾腔', gender: 'male' }
];
const EDGE_VOICE_IDS = EDGE_VOICE_LIST.map(v => v.id);
// 语速/语调/音量可调范围(前端滑杆与 server 校验共用)
const SPEED_RANGE = { min: 0.6, max: 1.6, step: 0.05 };
const PITCH_RANGE = { min: -50, max: 50, step: 5 };   // Hz,仅 edge-tts 支持
const VOLUME_RANGE = { min: 0.4, max: 1.6, step: 0.05 };

// ===== 后端能力表(2026-09-13) =====
// 设置页按这张表渲染「播放属性」:每个后端只显示它真正支持的属性,
// 并在 note 里写明底层实现(edge --rate/--pitch/--volume;本地 ffmpeg atempo/volume)。
// id 顺序 = 设置页下拉顺序;unsupported 会在 UI 里作为灰色说明行列出。
const prop = (key, label, range, unit, note, extra = {}) => ({ key, label, ...range, unit, note, ...extra });
const TTS_BACKENDS = [
  {
    id: 'local',
    label: '本地 Qwen3-TTS（离线免费）',
    desc: '本机 MLX 引擎 · 9 预设 + 克隆音色 · 约 1× 实时，长回复会分段连播',
    voiceSource: 'localVoices',
    defaultVoice: 'serena',
    props: [
      prop('speed', '语速', SPEED_RANGE, '×', 'ffmpeg atempo 保音高变速', { default: 0.9 }),
      // 动态情绪(2026-09-14): 由 9893/9894 的 emotion=auto 实现, 规划器按语境分段配语气。
      // 预设音色能真正改语气(instruct), 克隆音色只有语速 —— 服务端用 X-Emotion-Supported 如实标注。
      {
        key: 'emotionMode', label: '朗读情绪', type: 'select', default: 'off',
        options: [
          { value: 'off', label: '关闭 · 整段一种语气' },
          { value: 'auto', label: '自动 · 按语境配情绪（较慢）' }
        ],
        note: '自动：先读语境再决定每段的语气与快慢（报错沉着、结论轻快、警告放慢）。预设音色可改语气，克隆音色只有语速'
      },
      prop('volume', '音量', VOLUME_RANGE, '×', 'ffmpeg volume 增益', { default: 1.0 })
    ],
    unsupported: { pitch: '本地引擎没有音高参数（ffmpeg 未编译 rubberband 滤镜）' }
  },
  {
    id: 'edge',
    label: 'Edge TTS（免费云端 · 快）',
    desc: '整句约 1–2 秒出音频 · 14 个中文音色 · 需联网',
    voiceSource: 'edgeVoices',
    defaultVoice: 'zh-CN-XiaoxiaoNeural',
    props: [
      prop('speed', '语速', SPEED_RANGE, '×', '--rate 百分比', { default: 1.0 }),
      prop('pitch', '语调（音高）', PITCH_RANGE, 'Hz', '--pitch，正数更高更亮', { default: 0 }),
      prop('volume', '音量', VOLUME_RANGE, '×', '--volume 百分比', { default: 1.0 })
    ]
  }
];
const BACKEND_IDS = TTS_BACKENDS.map(b => b.id);
function backendCaps(id) { return TTS_BACKENDS.find(b => b.id === id) || null; }
// 音色归属校验:voice 必须在所属后端的清单里
function voiceListOf(backendId) {
  const caps = backendCaps(backendId);
  if (!caps) return [];
  if (caps.voiceSource === 'localVoices') return LOCAL_VOICE_LIST;
  if (caps.voiceSource === 'edgeVoices') return EDGE_VOICE_LIST;
  return [];
}
function isValidVoiceFor(backendId, voice) {
  return voiceListOf(backendId).some(v => v.id === voice);
}
// 该后端支持的属性表(key → prop)
function propsOf(backendId) {
  const caps = backendCaps(backendId);
  const map = {};
  for (const p of (caps?.props || [])) map[p.key] = p;
  return map;
}
// MiniMax 音色名 → 本地音色(agent 用云端音色名调本地后端时兜底映射)
const MINIMAX_TO_LOCAL_VOICE = {
  'female-chengshu': 'serena',
  'female-shaonv': 'vivian',
  'female-yujie': 'serena',
  'presenter_female': 'serena',
  'audiobook_female_1': 'serena',
  'male-qn-qingse': 'ryan',
  'male-qn-jingying': 'ryan',
  'male-qn-badao': 'uncle_fu',
  'presenter_male': 'ryan',
  'audiobook_male_1': 'ryan'
};

// 长文按 1KB 切句(中文 ≈ 500 字 / 段),避免单次请求 body 过大
function chunkText(text, maxLen = 1000) {
  const out = [];
  let buf = '';
  for (const line of text.split(/(?<=[。！？!?\n])/)) {
    if (buf.length + line.length > maxLen && buf) {
      out.push(buf); buf = line;
    } else {
      buf += line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function readJsonBody(request, maxBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) return reject(new Error('body too large'));
      chunks.push(c);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(e); }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, obj) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(obj));
}

// MiniMax(MiniMax TTS)通道已于 2026-09-13 随「不再续费」整体移除。
// ===== edge-tts fallback(2026-08-21, MiniMax 额度烧穿时自动切换) =====
import { execFile } from 'node:child_process';
const EDGE_TTS_BIN = '/Users/jacky/voice-tools/venv/bin/edge-tts';
// 重试策略(2026-09-14):公共端点会成簇抖动——连续数十秒全部 "Connection reset by peer"。
// 原来只重试 2 次、退避 0.8s/1.6s(总窗口约 3s)扛不住,提到 4 次、退避 1s/2s/4s。
const EDGE_MAX_ATTEMPTS = 4;
const EDGE_RETRY_BACKOFF_MS = 1000;

// 把 execFile 的报错压成一句可读的话:err.message 会回显整条命令(含待朗读全文),
// 直接透传前端既看不清真实原因、又可能几 KB 长(2026-09-14)。
function describeEdgeError(err, stderr) {
  const raw = `${err?.message || ''}\n${stderr || ''}`;
  if (/Connection reset by peer|Cannot connect to host|ClientConnectorError/i.test(raw)) {
    return `edge-tts 连不上语音端点 speech.platform.bing.com(连接被重置)。已重试 ${EDGE_MAX_ATTEMPTS} 次仍失败,多为网络线路抖动,可稍后重试;或改用「本地 Qwen3-TTS」后端(完全离线)。`;
  }
  if (/timed? ?out|ETIMEDOUT|killed by signal/i.test(raw)) {
    return `edge-tts 超时(已重试 ${EDGE_MAX_ATTEMPTS} 次)。文本越长端点越慢,可缩短文本或改用「本地 Qwen3-TTS」后端。`;
  }
  const tail = raw.split('\n').map((s) => s.trim()).filter(Boolean).slice(-2).join(' ');
  return `edge-tts 失败: ${tail.slice(0, 300) || '未知错误'}`;
}
// MiniMax 声线 → edge-tts 声线映射。
// 注意:当前 edge-tts 公共端点只暴露 8 个 zh-CN 声线(4 女 4 男):
//   女: Xiaoxiao(成熟温暖) / Xiaoyi(活泼少女) / Xiaobei(东北口音) / Xiaoni(陕西口音)
//   男: Yunxi(阳光青年) / Yunyang(新闻专业) / Yunjian(激情) / Yunxia(可爱)
// 所以 10 个音色选项只能尽量区分;女主播/御姐会落到方言声线,有声书复用默认声线。
const EDGE_VOICE_MAP = {
  'female-chengshu': 'zh-CN-XiaoxiaoNeural',           // 温柔成熟女声(默认)
  'female-shaonv': 'zh-CN-XiaoyiNeural',               // 甜美少女声
  'female-yujie': 'zh-CN-shaanxi-XiaoniNeural',        // 御姐女声(明亮,陕西口音)
  'presenter_female': 'zh-CN-liaoning-XiaobeiNeural',  // 女主播(活泼,东北口音)
  'audiobook_female_1': 'zh-CN-XiaoxiaoNeural',        // 有声书女声(与默认复用)
  'male-qn-qingse': 'zh-CN-YunxiaNeural',              // 青涩青年男声(可爱声线)
  'male-qn-jingying': 'zh-CN-YunxiNeural',             // 精英男声(阳光青年)
  'male-qn-badao': 'zh-CN-YunjianNeural',              // 霸道男声(激情)
  'presenter_male': 'zh-CN-YunyangNeural',             // 男主播(新闻腔)
  'audiobook_male_1': 'zh-CN-YunyangNeural'            // 有声书男声(沉稳播报,复用)
};

function callEdgeTTS({ text, voice, speed, pitch, volume }, _attempt = 0) {
  return new Promise((resolve, reject) => {
    // voice 既可以是 edge 真实音色 id(推荐,设置页现在就列这些),也可以是旧的 MiniMax 音色名(向后兼容映射)
    const edgeVoice = EDGE_VOICE_IDS.includes(voice) ? voice : (EDGE_VOICE_MAP[voice] || 'zh-CN-XiaoxiaoNeural');
    const tmpOut = `${AUDIO_CACHE_DIR}/edge-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp3`;
    const args = ['--text', text, '--voice', edgeVoice, '--write-media', tmpOut];
    if (speed != null && Math.abs(speed - 1) > 0.01) {
      const pct = Math.round((speed - 1) * 100);
      args.push('--rate', `${pct >= 0 ? '+' : ''}${pct}%`);
    }
    if (pitch != null && Math.abs(pitch) >= 1) {
      const hz = Math.round(pitch);
      args.push('--pitch', `${hz >= 0 ? '+' : ''}${hz}Hz`);
    }
    if (volume != null && Math.abs(volume - 1) > 0.01) {
      const vp = Math.round((volume - 1) * 100);
      args.push('--volume', `${vp >= 0 ? '+' : ''}${vp}%`);
    }
    execFile(EDGE_TTS_BIN, args, { timeout: 30_000, maxBuffer: 50 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) {
          try { unlinkSync(tmpOut); } catch {}
          // 公共端点偶发连接重置(Connection reset by peer),退避重试吸收抖动
          if (_attempt < EDGE_MAX_ATTEMPTS - 1) {
            return setTimeout(() => {
              callEdgeTTS({ text, voice, speed, pitch, volume }, _attempt + 1)
                .then(resolve, reject);
            }, EDGE_RETRY_BACKOFF_MS * 2 ** _attempt);
          }
          return reject(new Error(describeEdgeError(err, stderr)));
        }
        let bytes;
        try { bytes = readFileSync(tmpOut); }
        catch (e) {
          try { unlinkSync(tmpOut); } catch {}
          return reject(new Error(`edge-tts 输出读取失败: ${e.message}`));
        }
        try { unlinkSync(tmpOut); } catch {}
        if (!bytes || !bytes.length) return reject(new Error('edge-tts 返回空音频'));
        resolve({ bytes, b64: bytes.toString('base64'), mime: 'audio/mpeg', duration: null, backend: 'edge' });
      });
  });
}

// ===== 本地 Qwen3-TTS backend(2026-08-29,本机 MLX 服务,零成本/全离线) =====
// 服务: /Users/jacky/voice-tools/qwen3tts_server.py (端口 9893, OpenAI 兼容 /v1/audio/speech)
// 音色与云端(MiniMax/edge)互不通用;传云端音色名时映射到本地近似音色
const LOCAL_TTS_URL = 'http://127.0.0.1:9893/v1/audio/speech';
async function callLocalTTS({ text, voice, speed, volume }) {
  let localVoice = 'vivian';
  if (voice) {
    if (LOCAL_VOICE_IDS.includes(voice)) localVoice = voice;
    else if (MINIMAX_TO_LOCAL_VOICE[voice]) localVoice = MINIMAX_TO_LOCAL_VOICE[voice];
  }
  const r = await fetch(LOCAL_TTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: text, voice: localVoice, speed: speed ?? 1.0, volume: volume ?? 1.0 }),
    signal: AbortSignal.timeout(300_000)
  });
  if (!r.ok) throw new Error(`local Qwen3-TTS HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('local Qwen3-TTS 返回空音频');
  const dur = parseFloat(r.headers.get('x-tts-duration') || '0') * 1000;
  return { bytes: buf, b64: buf.toString('base64'), mime: 'audio/mpeg', duration: dur || null, backend: 'local' };
}

// 百灵克隆音色(CosyVoice3 @9877)通道已于 2026-09-13 按阿杰要求移除;
// 如需恢复:在 TTS_BACKENDS 里加回 bailing 后端 + 恢复这里的 callBailingTTS。

// 统一入口(2026-09-13 起只路由三个现役引擎,无云端聚合/降级链):
//   local → 本机 Qwen3-TTS(9893)  edge → Edge TTS(免费云端)
// speed/volume 按后端能力传参; pitch 仅 edge 生效。
async function synthesize({ text, voice = DEFAULT_VOICE, emotion = DEFAULT_EMOTION, speed = DEFAULT_SPEED, pitch = DEFAULT_PITCH, volume = DEFAULT_VOLUME, backend }) {
  const cfg = loadConfig();
  const want = backend || cfg.backend || 'local';
  if (want === 'edge') {
    const edge = await callEdgeTTS({ text, voice, speed, pitch, volume });
    edge.backend = 'edge';
    return edge;
  }
  // 默认(含任何未知/历史值)走本地 Qwen3-TTS:本地引擎不支持 pitch,忽略
  return await callLocalTTS({ text, voice, speed, volume });
}

// 工具注册模板
function defineTool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: spec.outputSchema,
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      try {
        return await spec.execute(args, exec);
      } catch (e) {
        return `TTS 失败: ${e?.message || e}`;
      }
    }
  };
}

export function apply(ctx) {
  // HTTP 路由(给前端 🔊 朗读按钮用)
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const dispose = hostCtx.webServer.register({
        kind: 'exact',
        path: '/api/minimax-tts/synthesize',
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          try {
            const body = await readJsonBody(request);
            const cfg = loadConfig();
            let { text } = body || {};
            // 后端决定可用属性:未显式传参时用配置值,超出该后端能力/范围的回落到默认
            const wantBackend = (typeof body?.backend === 'string' && BACKEND_IDS.includes(body.backend)) ? body.backend : cfg.backend;
            const caps = propsOf(wantBackend);
            let voice = body?.voice ?? cfg.voice ?? DEFAULT_VOICE;
            let emotion = body?.emotion ?? cfg.emotion ?? DEFAULT_EMOTION;
            let speed = body?.speed ?? cfg.speed ?? DEFAULT_SPEED;
            let pitch = body?.pitch ?? cfg.pitch ?? DEFAULT_PITCH;
            let volume = body?.volume ?? cfg.volume ?? DEFAULT_VOLUME;
            // 音色必须属于目标后端,否则用该后端默认音色(旧云端音色名再走一次映射兜底)
            if (!isValidVoiceFor(wantBackend, voice)) {
              const mapped = MINIMAX_TO_LOCAL_VOICE[voice];
              voice = (mapped && isValidVoiceFor(wantBackend, mapped)) ? mapped : (backendCaps(wantBackend)?.defaultVoice || DEFAULT_VOICE);
            }
            if (!caps.emotion || !EMOTIONS.includes(emotion)) emotion = DEFAULT_EMOTION;
            if (!caps.speed || typeof speed !== 'number' || speed < caps.speed.min || speed > caps.speed.max) speed = caps.speed?.default ?? DEFAULT_SPEED;
            if (!caps.pitch || typeof pitch !== 'number' || pitch < caps.pitch.min || pitch > caps.pitch.max) pitch = DEFAULT_PITCH;
            if (!caps.volume || typeof volume !== 'number' || volume < caps.volume.min || volume > caps.volume.max) volume = DEFAULT_VOLUME;
            if (typeof text !== 'string' || !text.trim()) {
              return sendJson(response, 400, { ok: false, error: 'text 必填且非空' });
            }
            // 必须把校验用的 wantBackend 传下去:否则引擎由配置决定,前端显式指定的后端会被忽略
            const r = await synthesize({ text: text.slice(0, 8000), voice, emotion, speed, pitch, volume, backend: wantBackend });
            // 写文件 + 返回 URL(避免 data URL 在某些 dsh 沙箱被禁)
            const id = `${Date.now()}-${randomUUID().slice(0, 8)}.mp3`;
            const filePath = `${AUDIO_CACHE_DIR}/${id}`;
            writeFileSync(filePath, r.bytes);
            sendJson(response, 200, {
              ok: true,
              audio_url: `/api/minimax-tts/audio/${id}`,
              bytes: r.bytes.length,
              duration_ms: r.duration,
              mime: r.mime,
              backend: r.backend || wantBackend,
              applied: { voice, speed, pitch, volume, emotion }   // 便于前端/agent 核对实际生效的属性
            });
          } catch (e) {
            sendJson(response, 500, { ok: false, error: e?.message || String(e) });
          }
        }
      });
      // 配置读取/保存 API
      const disposeConfigGet = hostCtx.webServer.register({
        kind: 'exact',
        path: '/api/minimax-tts/config',
        handler: async (request, response) => {
          if (request.method === 'GET') {
            // backends: 后端能力表(设置页按它渲染「播放属性」:只显示该 TTS 真正支持的项)
            // localVoices/edgeVoices: 各后端音色清单
            return sendJson(response, 200, {
              ok: true,
              config: {
                ...loadConfig(),
                backends: TTS_BACKENDS,
                localVoices: LOCAL_VOICE_LIST,
                edgeVoices: EDGE_VOICE_LIST
              }
            });
          }
          if (request.method === 'POST') {
            try {
              const body = await readJsonBody(request);
              const allowed = {};
              if (typeof body?.autoSpeak === 'boolean') allowed.autoSpeak = body.autoSpeak;
              const targetBackend = (typeof body?.backend === 'string' && BACKEND_IDS.includes(body.backend))
                ? body.backend
                : loadConfig().backend;
              if (typeof body?.backend === 'string' && BACKEND_IDS.includes(body.backend)) allowed.backend = body.backend;
              // 音色须属于目标后端(切后端时前端也会一并提交对应音色)
              if (typeof body?.voice === 'string' && isValidVoiceFor(targetBackend, body.voice)) allowed.voice = body.voice;
              // 属性按后端能力校验:不支持的属性直接丢弃(如 local 的 pitch)
              const caps = propsOf(targetBackend);
              if (caps.emotion && typeof body?.emotion === 'string' && EMOTIONS.includes(body.emotion)) allowed.emotion = body.emotion;
              // 朗读情绪模式(2026-09-14): 只认 off/auto。漏了这行的后果是"设置页选了自动、
              // 存下去又变回关闭" —— 白名单会静默丢弃未声明字段。
              if (caps.emotionMode && (body?.emotionMode === 'auto' || body?.emotionMode === 'off')) {
                allowed.emotionMode = body.emotionMode;
              }
              if (caps.speed && typeof body?.speed === 'number' && body.speed >= caps.speed.min && body.speed <= caps.speed.max) allowed.speed = body.speed;
              if (caps.pitch && typeof body?.pitch === 'number' && body.pitch >= caps.pitch.min && body.pitch <= caps.pitch.max) allowed.pitch = Math.round(body.pitch);
              if (caps.volume && typeof body?.volume === 'number' && body.volume >= caps.volume.min && body.volume <= caps.volume.max) allowed.volume = body.volume;
              const next = normalizeConfig(saveConfig(allowed));
              return sendJson(response, 200, { ok: true, config: next });
            } catch (e) {
              return sendJson(response, 500, { ok: false, error: e?.message || String(e) });
            }
          }
          response.writeHead(405, { allow: 'GET, POST' });
          response.end();
        }
      });
      // 静态 GET 路由:返回已合成 mp3(浏览器用 audio src 直接消费,避开 data URL 沙箱拦截)
      const disposeAudio = hostCtx.webServer.register({
        kind: 'prefix',
        path: '/api/minimax-tts/audio',
        handler: async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' });
            response.end();
            return;
          }
          // open-sea-skin 同款解析:用 URL 对象取完整 pathname,再切掉前缀
          let pathname;
          try { pathname = decodeURIComponent(new URL(request.url ?? '', 'http://dsh.local').pathname); }
          catch { pathname = request.url ?? ''; }
          let id = pathname.split('?')[0];
          // 兼容:完整路径 或 剩余段
          const PREFIX = '/api/minimax-tts/audio/';
          id = id.includes(PREFIX) ? id.slice(id.indexOf(PREFIX) + PREFIX.length) : id.replace(/^\//, '');
          if (!id || /[^a-zA-Z0-9._-]/.test(id) || !id.endsWith('.mp3')) {
            response.writeHead(400);
            response.end('bad id: ' + id);
            return;
          }
          const filePath = `${AUDIO_CACHE_DIR}/${id}`;
          try {
            const buf = readFileSync(filePath);
            response.writeHead(200, {
              'content-type': 'audio/mpeg',
              'content-length': String(buf.length),
              'cache-control': 'no-store'
            });
            response.end(request.method === 'HEAD' ? undefined : buf);
          } catch {
            response.writeHead(404);
            response.end('not found');
          }
        }
      });
      return async () => {
        try { dispose(); } catch {}
        try { disposeConfigGet(); } catch {}
        try { disposeAudio(); } catch {}
      };
    }, 'dsh-minimax-tts.http');
  });

  // Register agent-callable TTS tools on the host tool layer. Presets that use
  // dynamic capability routing can now hide them until a voice task arrives;
  // other presets keep seeing the same tools as before.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => {
      const disposers = [];
          // 工具 1: 短文合成(返回 base64 mp3,前端可直接 <audio src=data:> 播)
          disposers.push(toolCtx.tools.register(defineTool({
            name: 'tts_synthesize',
            description: '合成短文语音(<2KB 中文)。后端按配置路由,现役两个:本地 Qwen3-TTS(离线免费,voice=serena/vivian/ryan 等,支持 speed+volume)/edge(免费云端,voice=zh-CN-XiaoxiaoNeural 等,支持 speed+pitch+volume);传了后端不支持的属性会被忽略。返回 base64 mp3,前端会自动播放。常用场景:数字人配音、关键回复朗读、播客片段。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', description: '要朗读的文本(中文优先,英文也行)' },
                voice: { type: 'string', enum: [...LOCAL_VOICE_IDS, ...EDGE_VOICE_IDS], description: '声音 ID:本地后端 vivian/serena/ryan 等;edge 后端 zh-CN-XiaoxiaoNeural 等' },
                emotion: { type: 'string', enum: EMOTIONS, description: '情绪(现役引擎不使用,保留兼容)' },
                speed: { type: 'number', description: `语速 ${SPEED_RANGE.min}-${SPEED_RANGE.max},默认 0.9(本地 atempo / edge --rate / 克隆 speed)` },
                pitch: { type: 'number', description: `语调/音高 ${PITCH_RANGE.min}~${PITCH_RANGE.max} Hz,默认 0(仅 edge 支持)` },
                volume: { type: 'number', description: `音量 ${VOLUME_RANGE.min}-${VOLUME_RANGE.max} 倍,默认 1.0(本地 ffmpeg volume / edge --volume)` }
              },
              required: ['text']
            },
            outputSchema: { type: 'string' },
            execute: async ({ text, voice = DEFAULT_VOICE, emotion = DEFAULT_EMOTION, speed = DEFAULT_SPEED, pitch = DEFAULT_PITCH, volume = DEFAULT_VOLUME }) => {
              const r = await synthesize({ text, voice, emotion, speed, pitch, volume });
              const id = `${Date.now()}-${randomUUID().slice(0, 8)}.mp3`;
              writeFileSync(`${AUDIO_CACHE_DIR}/${id}`, r.bytes);
              return JSON.stringify({
                ok: true,
                format: 'mp3',
                mime: r.mime,
                duration_ms: r.duration,
                bytes: r.bytes.length,
                audio_url: `/api/minimax-tts/audio/${id}`,
                backend: r.backend || 'local'
              });
            }
          })));

          // 工具 2: 长文分段合成(每段 ≤1KB,顺序拼接,返回总 base64)
          disposers.push(toolCtx.tools.register(defineTool({
            name: 'tts_synthesize_long',
            description: '长文(>500 字)自动分段合成,适合整段播客/有声书/讲解。返回拼接后的 base64 mp3。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                text: { type: 'string', description: '长文本,会自动按 1KB 切分' },
                voice: { type: 'string', enum: [...LOCAL_VOICE_IDS, ...EDGE_VOICE_IDS], description: '本地后端用本地音色,edge 后端用 edge 音色,默认取配置值' },
                emotion: { type: 'string', enum: EMOTIONS, description: '情绪(现役引擎不使用,保留兼容)' },
                speed: { type: 'number', description: `语速 ${SPEED_RANGE.min}-${SPEED_RANGE.max},默认 0.9` },
                pitch: { type: 'number', description: `语调/音高 ${PITCH_RANGE.min}~${PITCH_RANGE.max} Hz,默认 0(仅 edge 支持)` },
                volume: { type: 'number', description: `音量 ${VOLUME_RANGE.min}-${VOLUME_RANGE.max} 倍,默认 1.0` }
                              },
                              required: ['text']
                            },
                            outputSchema: { type: 'string' },
            execute: async ({ text, voice = DEFAULT_VOICE, emotion = DEFAULT_EMOTION, speed = DEFAULT_SPEED, pitch = DEFAULT_PITCH, volume = DEFAULT_VOLUME }) => {
              const chunks = chunkText(text);
              const frames = [];
              let totalMs = 0;
              let lastBackend = 'local';
              let fallbackFrom = null;
              for (const c of chunks) {
                const r = await synthesize({ text: c, voice, emotion, speed, pitch, volume });
                // 简单拼接:MP3 拼接需要 ID3 处理,这里去 ID3 后直拼(ffmpeg 可重封)
                const buf = r.bytes;
                // 跳过首帧 ID3(v2)头
                let start = 0;
                if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
                  // ID3v2 + 同步 + size
                  const sz = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
                  start = 10 + sz;
                }
                frames.push(buf.subarray(start));
                totalMs += r.duration || 0;
                lastBackend = r.backend || lastBackend;
                fallbackFrom ||= r.fallback_from || null;
              }
              const merged = Buffer.concat(frames);
              // 长文拼接结果落盘,返回 audio_url(避免超大 base64 塞进 agent 上下文)
              const id = `${Date.now()}-${randomUUID().slice(0, 8)}.mp3`;
              writeFileSync(`${AUDIO_CACHE_DIR}/${id}`, merged);
              return JSON.stringify({
                ok: true, format: 'mp3',
                mime: 'audio/mpeg',
                chunks: chunks.length,
                duration_ms: totalMs,
                bytes: merged.length,
                audio_url: `/api/minimax-tts/audio/${id}`,
                backend: lastBackend,
                fallback_from: fallbackFrom,
                _note: '多段拼接,如需无损建议每段单独播放'
              });
            }
          })));

          // 工具 3: 列出声线与各后端可调属性(让 agent 知道当前引擎能调什么)
          disposers.push(toolCtx.tools.register(defineTool({
            name: 'tts_list_voices',
            description: '列出 TTS 现役引擎、各自音色清单与可调播放属性(speed/volume/pitch/emotion)。MiniMax 已停用移除。',
            parameters: { type: 'object', additionalProperties: false, properties: {} },
            outputSchema: { type: 'string' },
            execute: async () => JSON.stringify({
              backend: loadConfig().backend,
              backends: TTS_BACKENDS,
              local_voices: LOCAL_VOICE_LIST,
              local_voice_ids: LOCAL_VOICE_IDS,
              edge_voices: EDGE_VOICE_LIST,
              edge_voice_ids: EDGE_VOICE_IDS,
              emotions: EMOTIONS,
              speed_range: SPEED_RANGE,
              pitch_range: PITCH_RANGE,
              volume_range: VOLUME_RANGE,
              note: 'backend=local 用 local_voice_ids(如 serena)+speed/volume;backend=edge 用 edge_voice_ids(如 zh-CN-XiaoxiaoNeural)+speed/pitch/volume。传后端不支持的属性会被忽略。'
            })
          })));
      return () => {
        for (const dispose of disposers.reverse()) {
          try { dispose(); } catch {}
        }
      };
    }, 'dsh-minimax-tts.tools');
  });
}
