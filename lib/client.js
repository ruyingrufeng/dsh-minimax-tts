// dsh-minimax-tts/client — 前端 read-aloud 按钮 + 自动播放工具返回的 mp3
// 策略:
//   1. 监听工具调用结果(出现 tts_* 输出里含 audio_base64)→ 自动 <audio> 弹窗播放
//   2. 在每条助手消息加一个"🔊 朗读"按钮 → 点击 → fetch 当前文本到 server → 播放
//   3. server API 用插件 webServer 注入 /api/tts/synthesize
//      (由于 cordis 启动期已锁定,这里复用同进程 fetch 走 /api/tts/*)

(() => {
  if (window.__DSH_TTS_LOADED__) return;
  window.__DSH_TTS_LOADED__ = true;

  const STYLE_ID = 'dsh-minimax-tts-style';
  if (!document.getElementById(STYLE_ID)) {
    const css = document.createElement('style');
    css.id = STYLE_ID;
    css.textContent = `
      .tts-read-btn {
        margin-left: 8px;
        padding: 2px 10px;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 6px;
        background: linear-gradient(135deg, #ff7eb9 0%, #b27cff 100%);
        color: #fff;
        font-size: 12px;
        cursor: pointer;
        user-select: none;
        opacity: 0.85;
        transition: opacity .15s;
      }
      .tts-read-btn:hover { opacity: 1; }
      .tts-read-btn[data-playing="true"] { background: linear-gradient(135deg, #2ed573 0%, #1abc9c 100%); }
      .tts-read-btn[data-loading="true"] { background: linear-gradient(135deg, #f6c453 0%, #ff9f43 100%); }
      .tts-audio-fab {
        position: fixed; right: 24px; bottom: 24px;
        width: 56px; height: 56px; border-radius: 50%;
        background: linear-gradient(135deg, #ff7eb9 0%, #b27cff 100%);
        color: #fff; font-size: 22px;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; box-shadow: 0 6px 24px rgba(178,124,255,0.45);
        z-index: 9999; opacity: 0; pointer-events: none;
        transition: opacity .25s, transform .25s;
      }
      .tts-audio-fab[data-show="true"] { opacity: 1; pointer-events: auto; }
      .tts-audio-fab[data-playing="true"] { transform: scale(1.08); }
      .tts-settings-native { max-width: 680px; padding: 8px 2px 20px; }
      .tts-settings-native h2 { margin: 0 0 6px; font-size: 18px; }
      .tts-settings-native .tts-settings-desc { margin: 0 0 18px; opacity: .65; font-size: 13px; }
      .tts-settings-native .tts-settings-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 24px; min-height: 46px; padding: 7px 0;
        border-bottom: 1px solid rgba(127,127,127,.16);
      }
      .tts-settings-native .tts-settings-copy { display: flex; flex-direction: column; gap: 3px; }
      .tts-settings-native .tts-settings-copy small { opacity: .58; }
      .tts-settings-native select {
        min-width: 190px; border: 1px solid rgba(127,127,127,.32);
        border-radius: 7px; padding: 7px 9px; color: inherit;
        background: color-mix(in srgb, currentColor 6%, transparent); font: inherit;
      }
      .tts-settings-native input[type="checkbox"] { width: 36px; height: 20px; accent-color: #7c5cff; }
      .tts-settings-native .tts-voice-control { display: flex; align-items: center; gap: 10px; }
      .tts-settings-native .tts-voice-select { min-width: 230px; max-width: 260px; }
      .tts-settings-native .tts-preview-btn {
        padding: 7px 14px; border: 1px solid rgba(127,127,127,.32); border-radius: 7px;
        background: linear-gradient(135deg, #ff7eb9 0%, #b27cff 100%);
        color: #fff; font-size: 12px; cursor: pointer; white-space: nowrap; line-height: 1.2;
        transition: opacity .15s;
      }
      .tts-settings-native .tts-preview-btn:hover { opacity: .9; }
      .tts-settings-native .tts-preview-btn:disabled { opacity: .5; cursor: default; }
      .tts-settings-native .tts-preview-btn.tts-playing { background: linear-gradient(135deg, #2ed573 0%, #1abc9c 100%); }
      .tts-settings-native .tts-settings-status { margin-top: 12px; min-height: 18px; opacity: .68; font-size: 12px; }
      .tts-settings-native .tts-slider-control { display: flex; align-items: center; gap: 10px; min-width: 260px; }
      .tts-settings-native .tts-slider-control input[type="range"] {
        flex: 1; min-width: 160px; accent-color: #7c5cff; cursor: pointer;
      }
      .tts-settings-native .tts-slider-control input[type="range"]:disabled { opacity: .4; cursor: default; }
      .tts-settings-native .tts-row-muted { opacity: .5; }
      .tts-settings-native .tts-slider-value {
        min-width: 62px; text-align: right; font-variant-numeric: tabular-nums; font-size: 12px; opacity: .8;
      }
      .tts-settings-native .tts-select-control {
        min-width: 220px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
        border: 1px solid rgba(128, 128, 148, .35); background: rgba(128, 128, 148, .08);
        color: inherit; font-size: 13px;
      }
    `;
    document.head.appendChild(css);
  }

  let currentAudio = null;
  let autoPlayAudio = null;
  let assistantScanQueued = false;
  let autoSpeakTimer = null;
  let autoSpeakRevision = 0;
  let autoSpeakArmed = false;
  let lastAutoSpokenSignature = '';

  // ===== 本地朗读分段参数(2026-09-13) =====
  // 本地 Qwen3-TTS(9893)生成速度≈实时:150 字约 20-30s 才会出音。
  // 旧实现把正文截到 1100 字一次发给本地服务 → 需 3-5 分钟,而这里超时只有 60s,
  // 结果每次点朗读都必然超时;被放弃的请求还会占满单 worker,把后续短句一起堵死。
  // 现在改为按句分段 + 边合成边播:首段 20s 左右出声,后续段在播放期间已开始合成。
  const LOCAL_SEG_CHARS = 150;        // 每段字数(≈一段 20-30s 生成)
  // 动态情绪模式的段长: 段切太碎时规划器没有腾挪空间(每段只剩一两句就谈不上语气流动),
  // 放大到 300 字让每段有 3-5 句, 服务端才能在段内规划出有意义的情绪曲线。(2026-09-14)
  const LOCAL_SEG_CHARS_EMOTION = 300;
  const LOCAL_SEG_TIMEOUT = 180_000;  // 单段超时,留足排队余量
  const LOCAL_MAX_SEGMENTS = 20;      // 单次朗读最多合成段数(≈3000 字),防超长回复无限占用
  let speakSession = 0;               // 朗读会话号:新朗读/停止都会 ++,旧流水线据此退出
  let speakAbort = null;              // 当前朗读的 AbortController(停合成用)

  function resetReadButton(btn) {
    if (!btn) return;
    btn.setAttribute('data-playing', 'false');
    btn.setAttribute('data-loading', 'false');
    btn.textContent = '🔊 朗读';
    btn.title = '朗读本条回复';
  }

  function hideFab() {
    const fab = document.querySelector('.tts-audio-fab');
    if (!fab) return;
    fab.setAttribute('data-show', 'false');
    fab.setAttribute('data-playing', 'false');
  }

  function stopAll() {
    speakSession += 1;                 // 让正在排队/合成的本地分段立即退出
    if (speakAbort) {
      try { speakAbort.abort(); } catch {}
      speakAbort = null;
    }
    if (currentAudio) {
      try { currentAudio.pause(); currentAudio.currentTime = 0; } catch {}
      currentAudio = null;
    }
    if (autoPlayAudio) {
      try { autoPlayAudio.pause(); autoPlayAudio.currentTime = 0; } catch {}
      autoPlayAudio = null;
    }
    document.querySelectorAll('.tts-read-btn[data-playing="true"]')
      .forEach(resetReadButton);
    hideFab();
  }

  // 按句切成 ≤maxChars 的小段(手写扫描,不用 lookbehind,兼容旧浏览器)
  function splitForLocal(text, maxChars) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    const parts = [];
    let cur = '';
    for (const ch of clean) {
      cur += ch;
      const isEnd = /[。！？!?；;]/.test(ch);
      if (cur.length >= maxChars || (isEnd && cur.length >= maxChars * 0.6)) {
        parts.push(cur);
        cur = '';
      }
    }
    if (cur) parts.push(cur);
    return parts.filter((s) => s.trim());
  }

  async function localSynth(text, voice, speed, volume, signal, emotionMode) {
    // 克隆音色打 9894，预设音色打 9893 —— 两个服务加载的模型不同，端点不通用
    const isClone = CLONE_VOICE_IDS.has(voice);
    const body = { input: text, voice, speed, volume };
    // 动态情绪: 服务端按语境分段规划语气与快慢再拼接。
    // 预设音色(9893)能真正改语气; 克隆音色(9894)只有语速 —— 服务端会如实回 X-Emotion-Supported。
    if (emotionMode === 'auto') body.emotion = 'auto';
    const r = await fetch(isClone ? CLONE_TTS_API : LOCAL_TTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    });
    if (!r.ok) {
      // 读响应体：真正原因（未知音色 / 服务未启动）在 body 里，别只报状态码
      const detail = (await r.text()).slice(0, 200);
      const hint = isClone ? '（9894 克隆服务没起？执行 `qwen3-tts-clone start`）' : '';
      throw new Error((isClone ? '克隆服务' : '本地服务') + ' HTTP ' + r.status + hint + ': ' + detail);
    }
    return URL.createObjectURL(await r.blob());
  }

  // 播放一段音频;用户按停止时会触发 pause,同样视为结束
  function playLocalAudio(url) {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      currentAudio = audio;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        audio.removeEventListener('ended', finish);
        audio.removeEventListener('pause', finish);
        audio.removeEventListener('error', finish);
        if (currentAudio === audio) currentAudio = null;
        resolve();
      };
      audio.addEventListener('ended', finish);
      audio.addEventListener('pause', finish);
      audio.addEventListener('error', finish);
      showFab(audio);
      audio.play().catch(() => finish());
    });
  }

  // 分段流式朗读:合成第 i+1 段 与 播放第 i 段 并行,首段出声后基本连贯
  async function speakLocalSegments(segments, btn, voice, speed, volume, options) {
    const session = ++speakSession;
    const controller = new AbortController();
    speakAbort = controller;
    const urls = [];
    let timedOut = false;
    const stale = () => session !== speakSession || (options.isCurrent && !options.isCurrent());
    const fetchSeg = (i) => {
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`合成超时:单段超过 ${Math.round(LOCAL_SEG_TIMEOUT / 1000)}s`));
          try { controller.abort(); } catch {}
        }, LOCAL_SEG_TIMEOUT);
      });
      return Promise.race([localSynth(segments[i], voice, speed, volume, controller.signal,
                                      options.emotionMode), timeout])
        .finally(() => clearTimeout(timer));
    };
    try {
      let pending = fetchSeg(0);
      for (let i = 0; i < segments.length; i++) {
        if (btn) btn.textContent = segments.length > 1 ? `⏳ 合成中 ${i + 1}/${segments.length}` : '⏳ 合成中';
        const url = await pending;
        urls.push(url);
        if (stale()) return;
        // 播放本段的同时开始合成下一段(服务端单 worker 串行,提前排队正好衔接)
        if (i + 1 < segments.length) pending = fetchSeg(i + 1);
        if (btn) {
          btn.setAttribute('data-loading', 'false');
          btn.setAttribute('data-playing', 'true');
          btn.textContent = segments.length > 1 ? `⏹ 停止 ${i + 1}/${segments.length}` : '⏹ 停止';
          btn.title = '停止朗读';
        }
        await playLocalAudio(url);
        if (stale()) return;
      }
    } catch (e) {
      if (timedOut) throw e;
      if (e && e.name === 'AbortError') return;   // 用户停止/新朗读接管:静默退出
      throw e;
    } finally {
      if (speakAbort === controller) speakAbort = null;
      urls.forEach((u) => { try { URL.revokeObjectURL(u); } catch {} });
      if (btn) {
        btn.setAttribute('data-playing', 'false');
        btn.setAttribute('data-loading', 'false');
        resetReadButton(btn);
      }
      if (!currentAudio && session === speakSession) hideFab();
    }
  }

  const API_BASE = (typeof window !== 'undefined' && window.location && window.location.origin) || 'http://127.0.0.1:3080';
  // 本地 Qwen3-TTS 服务直连地址(2026-08-30):本地后端朗读/试听直连 9893,
  // 绕过网关的云端音色校验(旧网关会把本地音色名全部替换成默认音色 → 所有音色听起来一样)
  const LOCAL_TTS_API = 'http://127.0.0.1:9893/v1/audio/speech';
  // 声音克隆服务（2026-09-14 接入）：Qwen3-TTS Base 模型 @9894，只有克隆音色走这里。
  // 两个端口加载的是不同模型（CustomVoice / Base），端点不可互串——串了会 400。
  // 9894 非常驻，要用克隆音色朗读前先 `qwen3-tts-clone start`（模型加载约 2 分钟）。
  const CLONE_TTS_API = 'http://127.0.0.1:9894/v1/audio/speech';
  // 百灵克隆音色(CosyVoice3 @9877)已于 2026-09-13 按阿杰要求从插件移除。

  // ===== 后端能力表(与 server TTS_BACKENDS 同构;server 未重启前用它渲染设置页) =====
  // 2026-09-13:MiniMax 已停用移除,现役引擎只有 本地 Qwen3-TTS / Edge TTS / 百灵克隆。
  // 设置页的「播放属性」由 props 驱动:每个后端只显示它真正支持的属性。
  const p = (key, label, range, unit, note, extra = {}) => ({ key, label, ...range, unit, note, ...extra });
  const TTS_BACKENDS_FALLBACK = [
    {
      id: 'local',
      label: '本地 Qwen3-TTS（离线免费）',
      desc: '本机 MLX 引擎 · 9 预设 + 克隆音色 · 约 1× 实时，长回复分段连播',
      voiceSource: 'localVoices',
      defaultVoice: 'serena',
      props: [
        p('speed', '语速', { min: 0.6, max: 1.6, step: 0.05 }, '×', 'ffmpeg atempo 保音高变速', { default: 0.9 }),
        // 动态情绪(2026-09-14): 与服务端能力表同构,服务端未重启前用这份渲染
        {
          key: 'emotionMode', label: '朗读情绪', type: 'select', default: 'off',
          options: [
            { value: 'off', label: '关闭 · 整段一种语气' },
            { value: 'auto', label: '自动 · 按语境配情绪（较慢）' }
          ],
          note: '自动：先读语境再决定每段的语气与快慢（报错沉着、结论轻快、警告放慢）。预设音色可改语气，克隆音色只有语速'
        },
        p('volume', '音量', { min: 0.4, max: 1.6, step: 0.05 }, '×', 'ffmpeg volume 增益', { default: 1.0 })
      ],
      unsupported: { pitch: '本地引擎没有音高参数（ffmpeg 未编译 rubberband）' }
    },
    {
      id: 'edge',
      label: 'Edge TTS（免费云端 · 快）',
      desc: '整句约 1–2 秒出音频 · 14 个中文音色 · 需联网',
      voiceSource: 'edgeVoices',
      defaultVoice: 'zh-CN-XiaoxiaoNeural',
      props: [
        p('speed', '语速', { min: 0.6, max: 1.6, step: 0.05 }, '×', '--rate 百分比', { default: 1.0 }),
        p('pitch', '语调（音高）', { min: -50, max: 50, step: 5 }, 'Hz', '--pitch，正数更高更亮', { default: 0 }),
        p('volume', '音量', { min: 0.4, max: 1.6, step: 0.05 }, '×', '--volume 百分比', { default: 1.0 })
      ]
    }
  ];
  // 各后端音色清单(与 server 同构,server 未重启前用它渲染下拉)
  const LOCAL_VOICE_LIST_FALLBACK = [
    { id: 'vivian', label: '明亮女声', desc: '中文女声 · 本地 Qwen3' },
    { id: 'serena', label: '温柔女声', desc: '中文女声 · 本地 Qwen3' },
    { id: 'uncle_fu', label: '大叔男声', desc: '中文男声 · 本地 Qwen3' },
    { id: 'ryan', label: '稳重男声', desc: '中文男声 · 本地 Qwen3' },
    { id: 'aiden', label: '英文男声', desc: '英文男声 · 本地 Qwen3' },
    { id: 'ono_anna', label: '日文女声', desc: '日文女声 · 本地 Qwen3' },
    { id: 'sohee', label: '韩文女声', desc: '韩文女声 · 本地 Qwen3' },
    { id: 'eric', label: '英文男声', desc: '英文男声 · 本地 Qwen3' },
    { id: 'dylan', label: '英文男声', desc: '英文男声 · 本地 Qwen3' },
    // 克隆音色（2026-09-14）：来自 9894 克隆服务，走独立端点（见 CLONE_TTS_API）。
    // 必须列在这里，否则 pickVoiceForBackend 会把它当非法音色替换成默认音色，
    // 表现就是"选了克隆音色，读出来还是 serena"。
    // ⚠️ 与 lib/index.js 的 LOCAL_CLONE_VOICE_LIST 保持同步，新增克隆音色两处都要加。
    { id: 'bailing', label: '百灵（克隆）', desc: '声音克隆 · ref_p3 样本' },
    { id: 'yunxi', label: '云希（克隆）', desc: '声音克隆 · edge 云希样本' }
  ];
  // 需要打 9894 端点的音色（其余走 9893 预设音色服务）
  const CLONE_VOICE_IDS = new Set(['bailing', 'yunxi']);
  const EDGE_VOICE_LIST_FALLBACK = [
    { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温暖女声', desc: 'zh-CN · 默认' },
    { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 活泼少女', desc: 'zh-CN · 清亮' },
    { id: 'zh-CN-YunxiNeural', label: '云希 · 阳光青年', desc: 'zh-CN · 男声' },
    { id: 'zh-CN-YunyangNeural', label: '云扬 · 新闻男声', desc: 'zh-CN · 专业稳重' },
    { id: 'zh-CN-YunjianNeural', label: '云健 · 激情男声', desc: 'zh-CN · 解说感' },
    { id: 'zh-CN-YunxiaNeural', label: '云夏 · 可爱少年', desc: 'zh-CN · 男声' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', label: '晓北 · 东北女声', desc: 'zh-CN 辽宁 · 方言' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西女声', desc: 'zh-CN 陕西 · 方言' },
    { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 粤语女声', desc: 'zh-HK' },
    { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语女声', desc: 'zh-HK' },
    { id: 'zh-HK-WanLungNeural', label: '雲龍 · 粤语男声', desc: 'zh-HK' },
    { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾女声', desc: 'zh-TW' },
    { id: 'zh-TW-HsiaoYuNeural', label: '曉雨 · 台湾女声', desc: 'zh-TW' },
    { id: 'zh-TW-YunJheNeural', label: '雲哲 · 台湾男声', desc: 'zh-TW' }
  ];
  function voiceFallbackFor(source) {
    if (source === 'localVoices') return LOCAL_VOICE_LIST_FALLBACK;
    if (source === 'edgeVoices') return EDGE_VOICE_LIST_FALLBACK;
    return [];
  }
  // 后端默认音色 + 音色归属校正(旧配置/localStorage 里可能残留已移除引擎的音色名)
  const BACKEND_DEFAULT_VOICE = { local: 'serena', edge: 'zh-CN-XiaoxiaoNeural' };
  function pickVoiceForBackend(backend, wanted) {
    const list = backend === 'edge' ? EDGE_VOICE_LIST_FALLBACK : LOCAL_VOICE_LIST_FALLBACK;
    if (wanted && list.some((v) => v.id === wanted)) return wanted;
    return BACKEND_DEFAULT_VOICE[backend] || list[0].id;
  }
  // 试听固定文案(短,合成快;同时也展示中英文混读效果)
  const PREVIEW_TEXT = '你好，我是你的语音朗读助手。这是一段音色试听，你可以切换不同的声线，找到自己喜欢的声音。';

  // 音色选择先落 localStorage(server 重启前即可生效持久),dsh 重启后由 server config 接管
  const VOICE_STORAGE_KEY = 'dsh-tts.voice';
  function getStoredVoice() {
    try { return localStorage.getItem(VOICE_STORAGE_KEY) || ''; } catch { return ''; }
  }
  function setStoredVoice(v) {
    try { localStorage.setItem(VOICE_STORAGE_KEY, v); } catch {}
  }

  // 读配置(带内存缓存,避免每次请求)
  let cfgCache = null;
  async function getConfig(force) {
    if (cfgCache && !force) return cfgCache;
    try {
      const r = await fetch(API_BASE + '/api/minimax-tts/config');
      if (!r.ok) return cfgCache || { autoSpeak: false, backend: 'local', voice: 'serena', emotion: 'neutral', speed: 0.9, pitch: 0, volume: 1.0 };
      const j = await r.json();
      cfgCache = j.config || {};
      return cfgCache;
    } catch {
      return cfgCache || { autoSpeak: false, backend: 'local', voice: 'serena', emotion: 'neutral', speed: 0.9, pitch: 0, volume: 1.0 };
    }
  }
  async function setConfig(patch) {
    try {
      const r = await fetch(API_BASE + '/api/minimax-tts/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      });
      const j = await r.json();
      if (j.ok && j.config) cfgCache = j.config;
      if (patch.autoSpeak === false) {
        autoSpeakRevision += 1;
        autoSpeakArmed = false;
        clearTimeout(autoSpeakTimer);
        autoSpeakTimer = null;
      }
      return j;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function fetchAndPlay(text, btn, options = {}) {
    let audio = null;
    let audioSrc = null;
    if (btn) {
      btn.setAttribute('data-loading', 'true');
      btn.textContent = '⏳ 合成中';
    }
    try {
      // 朗读用设置里选的音色:localStorage 优先(即时生效),但必须属于当前引擎;
      // 旧云端音色名(如 female-chengshu)会被替换成该引擎的默认音色,避免"所有音色听起来一样"。
      const cfg = await getConfig();
      const isLocal = cfg.backend !== 'edge';   // 默认走本地;edge 走网关
      const voice = pickVoiceForBackend(cfg.backend, getStoredVoice() || cfg.voice);
      const emotion = cfg.emotion || 'neutral';
      const speed = typeof cfg.speed === 'number' ? cfg.speed : 0.9;
      const pitch = typeof cfg.pitch === 'number' ? cfg.pitch : 0;     // 仅 edge 生效
      const volume = typeof cfg.volume === 'number' ? cfg.volume : 1.0; // 本地/edge 生效
      // 动态情绪(2026-09-14): auto 时服务端按语境分段配语气, 插件这层就不该把文本切太碎,
      // 否则每段只剩一两句, 规划器没有腾挪空间。150 -> 300 字, 让每段有 3-5 句。
      const emotionMode = cfg.emotionMode === 'auto' ? 'auto' : 'off';
      const segChars = emotionMode === 'auto' ? LOCAL_SEG_CHARS_EMOTION : LOCAL_SEG_CHARS;
      let sendText = text;

      if (isLocal) {
        // 本地 Qwen3-TTS:分段流式朗读(旧版一次发 1100 字必然超时,见上方 LOCAL_SEG_CHARS 注释)
        let segments = splitForLocal(text, segChars);
        if (!segments.length) throw new Error('没有可朗读的正文');
        let truncated = false;
        if (segments.length > LOCAL_MAX_SEGMENTS) {
          segments = segments.slice(0, LOCAL_MAX_SEGMENTS);
          truncated = true;
        }
        stopAll();
        if (truncated && btn) btn.title = `回复较长,只朗读前 ${LOCAL_MAX_SEGMENTS} 段`;
        await speakLocalSegments(segments, btn, voice, speed, volume,
                                 { ...options, emotionMode });
        return;
      }

      {
        const r = await fetch(API_BASE + '/api/minimax-tts/synthesize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'  // 让 dsh same-origin 校验通过
          },
          credentials: 'same-origin',
          body: JSON.stringify({ text: sendText, voice, emotion, speed, pitch, volume, backend: cfg.backend }),
          // 超时保护:本地服务繁忙/卡死时避免按钮永久转圈(2026-08-29)
          // 2026-09-14:服务端重试窗口变长(4 次尝试),客户端上限同步放宽到 90s,
          // 让"服务端报出的真实原因"能显示出来,而不是被浏览器 abort 成"合成超时"。
          signal: AbortSignal.timeout(90_000)
        });
        // 失败时也要读响应体:真正原因(如 edge-tts 连不上端点)在服务端 error 字段里。
        // 2026-09-14 之前这里只抛 'HTTP 500',把诊断信息丢了,导致误判成 CORS / shell 拦截。
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error('HTTP ' + r.status + (j?.error ? ' — ' + j.error : ''));
        if (!j?.ok) throw new Error(j?.error || 'TTS 失败');
        // 优先 audio_url(普通 HTTP,避开 data URL 沙箱拦截);fallback 才用 base64
        audioSrc = j.audio_url
          ? (j.audio_url.startsWith('http') ? j.audio_url : (API_BASE + j.audio_url))
          : (j.audio_base64 ? `data:audio/mpeg;base64,${j.audio_base64}` : null);
        if (!audioSrc) throw new Error('服务端未返回 audio_url/audio_base64');
      }
      // 回复流式渲染期间可能出现新版正文；过期请求只丢弃，不抢占当前播放器。
      if (options.isCurrent && !options.isCurrent()) return;

      stopAll();
      audio = new Audio(audioSrc);
      currentAudio = audio;
      if (btn) {
        btn.setAttribute('data-playing', 'true');
        btn.textContent = '⏹ 停止';
        btn.title = '停止朗读';
      }
      showFab(audio);
      audio.addEventListener('ended', () => {
        if (currentAudio === audio) currentAudio = null;
        resetReadButton(btn);
        hideFab();
      }, { once: true });
      audio.addEventListener('error', () => {
        if (currentAudio === audio) currentAudio = null;
        resetReadButton(btn);
        hideFab();
        alert('音频播放失败');
      }, { once: true });
      await audio.play();
    } catch (e) {
      if (options.isCurrent && !options.isCurrent()) return;
      // 用户在 play() 完成前按下停止会产生 AbortError，这是正常取消，不应弹错。
      if (e?.name === 'AbortError' && !e?.message?.includes('timeout')) return;
      if (audio && currentAudio !== audio) return;
      // 错误直接显示在按钮上(PWA 里 alert 可能不弹),同时保留 alert 兜底
      const timeoutErr = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      const msg = timeoutErr
        ? '合成超时:本地服务繁忙或卡死,已自动报错。可稍等 1-2 分钟(服务会自愈)再试'
        : (e?.message || String(e));
      if (btn) {
        btn.setAttribute('data-loading', 'false');
        btn.setAttribute('data-playing', 'false');
        btn.textContent = '⚠️ 失败';
        btn.title = msg;
        setTimeout(() => resetReadButton(btn), 4000);
      }
      const diag = [
        '朗读失败: ' + msg,
        'API: ' + API_BASE,
        '可能原因: TTS 端点网络不通 / 后端服务未启动(真实原因见第一行)'
      ].join('\n');
      try { alert(diag); } catch {}
      console.error('[dsh-minimax-tts] fetchAndPlay failed:', e);
      resetReadButton(btn);
      hideFab();
    } finally {
      if (btn) {
        btn.setAttribute('data-loading', 'false');
        if (btn.getAttribute('data-playing') !== 'true') resetReadButton(btn);
      }
    }
  }

  function cleanAssistantText(s) {
    return (s || '').replace(/🔊 朗读/g, '').replace(/复制/g, '').replace(/\s+/g, ' ').trim();
  }

  // 不属于"回复正文"的块:思考过程、工具调用/结果、回合过程、上下文、重试等。
  // [data-variant="think"] 是 dsh ReasoningRow 组件写死的语义标记(源码 client.js:
  // `"data-variant": "think"`),比哈希类名(lcKema_root 之类)稳定,升级不会失效。
  const NON_CONTENT_SELECTOR = [
    '[data-variant="think"]',                 // 思考过程 —— 不要念出来
    '[data-chat-flow-kind="tool-call"]',
    '[data-chat-flow-kind="tool-result"]',
    '[data-chat-flow-kind="turn-process"]',
    '[data-chat-flow-kind="context"]',
    '[data-chat-flow-kind="model-retry"]'
  ].join(',');

  // 离屏渲染取文本:innerText 依赖布局,节点脱离文档时会退化成 textContent
  // (丢段落换行)。挂在文档外但可见的位置(移出视口)才能拿到正确的 innerText。
  function offscreenInnerText(node) {
    const holder = document.createElement('div');
    holder.setAttribute('aria-hidden', 'true');
    holder.style.cssText =
      'position:absolute;left:-99999px;top:0;width:auto;height:auto;overflow:hidden;pointer-events:none;';
    holder.appendChild(node);
    document.body.appendChild(holder);
    try {
      return holder.innerText || holder.textContent || '';
    } finally {
      holder.remove();
    }
  }

  // 从 assistant-step 节点取正文(优先 markdown body 容器)
  // 注意:思考块就嵌在正文容器里(body 下是「思考块 + markdown」两个兄弟节点),
  // 直接读 innerText 会把思考内容一起念出来 —— 必须先在副本里剔除。
  function getAssistantText(msg) {
    const body = msg.querySelector('[class*="_body"]');
    const src = body || msg;
    const clone = src.cloneNode(true);
    clone.querySelectorAll(NON_CONTENT_SELECTOR).forEach(el => el.remove());
    clone.querySelectorAll('.tts-read-btn, button').forEach(el => el.remove());
    return cleanAssistantText(offscreenInnerText(clone));
  }

  // 从 turn-tail 节点找对应回复文本:
  // dsh 0.1.1 起操作条移到独立的 turn-tail 节点,正文在它前面最近的 assistant-step 里
  function getAssistantTextFor(tail) {
    const steps = Array.from(document.querySelectorAll('[data-chat-flow-kind="assistant-step"]'));
    let step = null;
    for (const s of steps) {
      // 文档顺序:tail 之前最后一个 assistant-step 就是本回合的最终回复
      if (s.compareDocumentPosition(tail) & Node.DOCUMENT_POSITION_FOLLOWING) step = s;
      else break;
    }
    return step ? getAssistantText(step) : '';
  }

  // 在节点内找操作条:老版本 class 是 [class*="_action_"],新版是 [class*="_actions"]。
  // 可靠判据:包含复制按钮(aria-label=复制/copy)的容器。
  function findActionsStrip(host) {
    const candidates = host.querySelectorAll('[class*="_actions"], [class*="_action_"]');
    let best = null;
    for (const el of candidates) {
      if (el.querySelector('button[aria-label*="复制"], button[aria-label*="copy"], button[aria-label*="Copy"]')) return el;
      if (el.querySelector('button') && !best) best = el;
    }
    return best;
  }

  function attachReadButtons() {
    // 老版本(0.1.0):动作条在 assistant-step 内部;新版(0.1.1):在 turn-tail 节点里
    document.querySelectorAll('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="turn-tail"]').forEach(host => {
      const strip = findActionsStrip(host);
      if (!strip) return; // 未完成渲染(流式生成中)或版本结构又变了
      if (strip.querySelector('.tts-read-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tts-read-btn';
      btn.textContent = '🔊 朗读';
      btn.title = '用 MiniMax TTS 朗读本条回复';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (btn.getAttribute('data-playing') === 'true') { stopAll(); return; }
        if (btn.getAttribute('data-loading') === 'true') return;
        const hostEl = btn.closest('[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="turn-tail"]');
        if (!hostEl) return;
        const text = hostEl.getAttribute('data-chat-flow-kind') === 'assistant-step'
          ? getAssistantText(hostEl)
          : getAssistantTextFor(hostEl);
        if (!text) { alert('未取到回复正文'); return; }
        fetchAndPlay(text, btn);
      });
      strip.appendChild(btn);
    });
  }

  function scheduleAutoSpeak(text) {
    autoSpeakArmed = true;
    const revision = ++autoSpeakRevision;
    clearTimeout(autoSpeakTimer);
    autoSpeakTimer = setTimeout(async () => {
      autoSpeakTimer = null;
      if (revision !== autoSpeakRevision) return;
      if (!text) return;
      const signature = text;
      if (signature === lastAutoSpokenSignature) return;
      const cfg = await getConfig();
      if (!cfg?.autoSpeak || revision !== autoSpeakRevision) return;
      autoSpeakArmed = false;
      lastAutoSpokenSignature = signature;
      fetchAndPlay(text, null, { isCurrent: () => revision === autoSpeakRevision });
    }, 1200);
  }

  // 自动朗读:新 turn-tail 出现 = 回合结束(回复定稿),此时才触发 TTS。
  // 页面初次加载时历史回合已带 turn-tail,只标记已处理,避免误播历史。
  function scanAssistantReplies() {
    document.querySelectorAll('[data-chat-flow-kind="turn-tail"]').forEach((tail) => {
      if (tail.dataset.ttsAutoHandled) return;
      const text = getAssistantTextFor(tail);
      if (!text) return;
      tail.dataset.ttsAutoHandled = '1';
      scheduleAutoSpeak(text);
    });
  }

  function watchAssistantReplies() {
    scanAssistantReplies();
    const obs = new MutationObserver(() => {
      if (assistantScanQueued) return;
      assistantScanQueued = true;
      requestAnimationFrame(() => {
        assistantScanQueued = false;
        scanAssistantReplies();
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // 监听工具结果中出现的 tts_*.play_url → 自动播放
  function watchToolResults() {
    const obs = new MutationObserver(() => {
      document.querySelectorAll('[data-chat-flow-kind="tool-result"]').forEach(node => {
        if (node.dataset.ttsHandled) return;
        const txt = node.textContent || '';
        // 优先 audio_url(普通 HTTP);fallback data URL
        let m = txt.match(/"audio_url":"([^"]+)"/);
        let audioSrc = null;
        if (m) {
          audioSrc = m[1].startsWith('http') ? m[1] : (API_BASE + m[1]);
        } else {
          m = txt.match(/"play_url":"(data:[^"]+)"/);
          if (m) audioSrc = m[1];
        }
        // 工具结果可能先挂载空壳、稍后才流入 audio_url；没有 URL 时不能提前标记。
        if (!audioSrc) return;
        node.dataset.ttsHandled = '1';
        // 自动播报开关:配置 autoSpeak=false 时不自动播放(只标记已处理)
        getConfig().then(cfg => {
          if (!cfg || !cfg.autoSpeak) return;
          try {
            stopAll();
            const audio = new Audio(audioSrc);
            autoPlayAudio = audio;
            // 浮窗提示
            showFab(audio);
            audio.play().catch((e) => console.warn('[dsh-minimax-tts] 自动播放被浏览器阻止:', e));
          } catch {}
        });
      });
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function showFab(audio) {
    let fab = document.querySelector('.tts-audio-fab');
    if (!fab) {
      fab = document.createElement('div');
      fab.className = 'tts-audio-fab';
      fab.setAttribute('role', 'button');
      fab.setAttribute('aria-label', '停止朗读');
      fab.title = '停止朗读';
      fab.textContent = '⏹';
      fab.addEventListener('click', stopAll);
      document.body.appendChild(fab);
    }
    fab.setAttribute('data-show', 'true');
    fab.setAttribute('data-playing', 'true');
    audio.addEventListener('ended', hideFab, { once: true });
    audio.addEventListener('error', hideFab, { once: true });
  }

  // 启动
  const boot = () => {
    attachReadButtons();
    watchAssistantReplies();
    watchToolResults();
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
  // dsh 对话流是动态渲染,定时兜底
  setInterval(attachReadButtons, 1500);

  // ===== DSH 原生系统设置页 =====
  // settings.section 需要在模块清单声明 settings 依赖，并等待 slots 服务注入后注册。
  window.__ModuleLoader__.load({
    id: 'dsh-minimax-tts',
    factory: (require) => {
      const React = require('react');

      function TTSSettingsSection() {
        const [config, setConfigState] = React.useState({
          autoSpeak: false, backend: 'local', voice: 'serena', emotion: 'neutral',
          speed: 0.9, pitch: 0, volume: 1.0
        });
        const [status, setStatus] = React.useState('正在读取设置…');
        const [preview, setPreview] = React.useState('idle'); // idle | loading | playing
        const previewAudioRef = React.useRef(null);

        React.useEffect(() => {
          let alive = true;
          getConfig(true).then((next) => {
            if (!alive) return;
            // 后端能力表 + 各后端音色清单(server 未重启时用同构 fallback)
            const backends = (Array.isArray(next.backends) && next.backends.length) ? next.backends : TTS_BACKENDS_FALLBACK;
            const voicesBySource = {
              localVoices: (Array.isArray(next.localVoices) && next.localVoices.length) ? next.localVoices : LOCAL_VOICE_LIST_FALLBACK,
              edgeVoices: (Array.isArray(next.edgeVoices) && next.edgeVoices.length) ? next.edgeVoices : EDGE_VOICE_LIST_FALLBACK
            };
            const backend = backends.some((b) => b.id === next.backend) ? next.backend : backends[0].id;
            const caps = backends.find((b) => b.id === backend);
            const list = voicesBySource[caps.voiceSource] || [];
            // 音色:localStorage 优先(即时生效),但必须属于当前后端,否则用该后端默认音色
            let voice = getStoredVoice() || next.voice || caps.defaultVoice;
            if (!list.some((v) => v.id === voice)) voice = caps.defaultVoice;
            setConfigState({
              autoSpeak: !!next.autoSpeak,
              backend,
              voice,
              emotion: next.emotion || 'neutral',
              // 注意: 这里是白名单式构造, 新增配置项必须在这里也补一行,
              // 否则 UI 永远显示默认值(emotionMode 就踩过这个坑 —— 服务端存了 auto, 界面还是"关闭")
              emotionMode: next.emotionMode === 'auto' ? 'auto' : 'off',
              speed: typeof next.speed === 'number' ? next.speed : 0.9,
              pitch: typeof next.pitch === 'number' ? next.pitch : 0,
              volume: typeof next.volume === 'number' ? next.volume : 1.0,
              backends,
              voicesBySource
            });
            setStatus('设置已同步');
          });
          return () => { alive = false; };
        }, []);

        const update = async (patch, message) => {
          setConfigState((prev) => ({ ...prev, ...patch }));
          setStatus('正在保存…');
          const result = await setConfig(patch);
          if (result.ok && result.config) {
            // server 回包不带 backends/voicesBySource,保留本地清单;voice 也用 prev 兜底
            setConfigState((prev) => ({
              ...prev, ...result.config,
              backends: prev.backends, voicesBySource: prev.voicesBySource, voice: prev.voice
            }));
            setStatus(message);
          } else {
            setStatus('保存失败：' + (result.error || '未知错误'));
            const latest = await getConfig(true);
            setConfigState((prev) => ({ ...prev, ...latest, backends: prev.backends, voicesBySource: prev.voicesBySource }));
          }
        };

        const row = (title, desc, control) => React.createElement('label', { className: 'tts-settings-row' },
          React.createElement('span', { className: 'tts-settings-copy' },
            React.createElement('span', null, title),
            React.createElement('small', null, desc)
          ),
          control
        );

        // ===== 当前后端能力(决定显示哪些播放属性) =====
        const backends = (Array.isArray(config.backends) && config.backends.length) ? config.backends : TTS_BACKENDS_FALLBACK;
        const caps = backends.find((b) => b.id === config.backend) || backends[0];
        const voicesBySource = config.voicesBySource || {
          localVoices: LOCAL_VOICE_LIST_FALLBACK,
          edgeVoices: EDGE_VOICE_LIST_FALLBACK
        };
        const voiceList = voicesBySource[caps.voiceSource] || voiceFallbackFor(caps.voiceSource);
        const propByKey = {};
        for (const item of (caps.props || [])) propByKey[item.key] = item;

        // 一条播放属性 = 滑杆或下拉,由后端 props 声明驱动
        const propControl = (item) => {
          const val = typeof config[item.key] === 'number' ? config[item.key]
            : (config[item.key] != null ? config[item.key] : item.default);
          if (item.type === 'select') {
            // options 支持两种写法: 字符串数组, 或 {value,label} 对象
            // (后者才能"值是 off/auto、显示是中文" —— 情绪模式走这种)
            const opts = (item.options || []).map((o) => (
              o && typeof o === 'object'
                ? { value: o.value, label: o.label || o.value }
                : { value: o, label: o }
            ));
            const cur = opts.find((o) => o.value === val) || opts[0] || { value: val, label: String(val) };
            return React.createElement('select', {
              value: cur.value,
              'aria-label': item.label,
              className: 'tts-select-control',
              onChange: (e) => {
                const picked = opts.find((o) => o.value === e.target.value) || { label: e.target.value };
                update({ [item.key]: e.target.value }, '已保存' + item.label + '：' + picked.label);
              }
            }, opts.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)));
          }
          const shown = item.unit === 'Hz'
            ? ((val > 0 ? '+' : '') + val + ' Hz')
            : (Number(val).toFixed(2) + (item.unit || ''));
          return React.createElement('div', { className: 'tts-slider-control' },
            React.createElement('input', {
              type: 'range', min: item.min, max: item.max, step: item.step, value: val,
              'aria-label': item.label,
              onChange: (e) => setConfigState((prev) => ({ ...prev, [item.key]: parseFloat(e.target.value) })),
              onMouseUp: (e) => update({ [item.key]: parseFloat(e.target.value) }, '已保存' + item.label + '：' + shown),
              onTouchEnd: (e) => update({ [item.key]: parseFloat(e.target.value) }, '已保存' + item.label),
              onKeyUp: (e) => update({ [item.key]: parseFloat(e.target.value) }, '已保存' + item.label)
            }),
            React.createElement('span', { className: 'tts-slider-value' }, shown)
          );
        };

        // 试听:用当前后端/音色/属性合成一段固定文案;播放中再点一次停止
        const handlePreview = async () => {
          if (preview === 'playing') {
            if (previewAudioRef.current) {
              try { previewAudioRef.current.pause(); previewAudioRef.current = null; } catch {}
            }
            setPreview('idle');
            return;
          }
          setPreview('loading');
          try {
            let src;
            const speed = typeof config.speed === 'number' ? config.speed : 0.9;
            const pitch = typeof config.pitch === 'number' ? config.pitch : 0;
            const volume = typeof config.volume === 'number' ? config.volume : 1.0;
            if (caps.id === 'local') {
              // 试听也要分流端点，否则选克隆音色试听会 400
              const isClone = CLONE_VOICE_IDS.has(config.voice);
              const previewBody = { input: PREVIEW_TEXT, voice: config.voice, speed, volume };
              if (config.emotionMode === 'auto') previewBody.emotion = 'auto';
              const lr = await fetch(isClone ? CLONE_TTS_API : LOCAL_TTS_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(previewBody),
                signal: AbortSignal.timeout(150_000)   // 本地 TTS 串行:朗读进行中时试听要排队
              });
              if (!lr.ok) {
                const detail = (await lr.text()).slice(0, 200);
                throw new Error((isClone ? '克隆服务' : '本地服务') + ' HTTP ' + lr.status +
                  (isClone ? '（9894 没起？qwen3-tts-clone start）' : '') + ': ' + detail);
              }
              src = URL.createObjectURL(await lr.blob());
            } else {
              const r = await fetch(API_BASE + '/api/minimax-tts/synthesize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'same-origin',
                body: JSON.stringify({ text: PREVIEW_TEXT, voice: config.voice, backend: caps.id, speed, pitch, volume, emotion: config.emotion }),
                signal: AbortSignal.timeout(60_000)
              });
              const j = await r.json();
              if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
              src = j.audio_url
                ? (j.audio_url.startsWith('http') ? j.audio_url : API_BASE + j.audio_url)
                : null;
              if (!src) throw new Error('服务端未返回音频');
            }
            stopAll(); // 不抢占正在播放的朗读
            const audio = new Audio(src);
            previewAudioRef.current = audio;
            const finish = () => {
              if (previewAudioRef.current === audio) previewAudioRef.current = null;
              setPreview('idle');
            };
            audio.addEventListener('ended', finish, { once: true });
            audio.addEventListener('error', finish, { once: true });
            setPreview('playing');
            await audio.play();
          } catch (e) {
            setPreview('idle');
            alert('试听失败：' + (e?.message || e));
          }
        };

        const onVoiceChange = (e) => {
          const v = e.target.value;
          setStoredVoice(v);
          setConfigState((prev) => ({ ...prev, voice: v }));
          const label = (voiceList.find((x) => x.id === v) || {}).label || v;
          setStatus('已保存音色：' + label);
          update({ voice: v }, '已保存音色：' + label);
        };

        // 切换后端:各后端音色/属性互不通用,切过去时换成该后端的默认音色,属性用该后端默认值
        const onBackendChange = async (e) => {
          const backend = e.target.value;
          const nextCaps = backends.find((b) => b.id === backend) || backends[0];
          const list = voicesBySource[nextCaps.voiceSource] || voiceFallbackFor(nextCaps.voiceSource);
          const cur = config.voice || '';
          const nextVoice = list.some((v) => v.id === cur) ? cur : nextCaps.defaultVoice;
          const patch = { backend, voice: nextVoice };
          for (const item of (nextCaps.props || [])) {
            if (typeof config[item.key] !== 'number') patch[item.key] = item.default;
          }
          setStoredVoice(nextVoice);
          setConfigState((prev) => ({ ...prev, ...patch }));
          const result = await setConfig(patch);
          if (result.ok && result.config) {
            setConfigState((prev) => ({ ...prev, ...result.config, backends: prev.backends, voicesBySource: prev.voicesBySource, voice: nextVoice }));
            setStatus('已切换引擎：' + nextCaps.label);
          } else {
            setStatus('保存失败：' + (result.error || '未知错误'));
          }
        };

        const previewLabel = preview === 'playing' ? '⏹ 停止' : (preview === 'loading' ? '⏳ 合成中…' : '▶ 试听');
        const voiceControl = React.createElement('div', { className: 'tts-voice-control' },
          React.createElement('select', {
            className: 'tts-voice-select',
            value: config.voice || caps.defaultVoice,
            onChange: onVoiceChange,
            'aria-label': '选择音色'
          },
            voiceList.map((v) => React.createElement('option', { key: v.id, value: v.id }, v.label + '（' + v.id + '）'))),
          React.createElement('button', {
            type: 'button',
            className: 'tts-preview-btn' + (preview === 'playing' ? ' tts-playing' : ''),
            onClick: handlePreview,
            disabled: preview === 'loading',
            title: preview === 'playing' ? '停止试听' : '用当前音色与属性试听一段'
          }, previewLabel)
        );

        return React.createElement('section', { className: 'tts-settings-native' },
          React.createElement('h2', null, 'TTS 语音朗读'),
          React.createElement('p', { className: 'tts-settings-desc' }, '控制对话朗读的引擎、音色和播放属性；属性按各引擎的能力显示。'),
          row('自动播报', '每条回复结束后自动朗读（关闭时只在点「🔊 朗读」时出声）',
            React.createElement('input', { type: 'checkbox', checked: !!config.autoSpeak,
              onChange: (e) => update({ autoSpeak: e.target.checked }, '已保存自动播报设置') })),
          row('TTS 引擎', caps.desc || '',
            React.createElement('select', { value: config.backend, onChange: onBackendChange },
              backends.map((b) => React.createElement('option', { key: b.id, value: b.id }, b.label)))),
          // 音色行:不用 label 包裹,避免点试听按钮时误触 select
          React.createElement('div', { className: 'tts-settings-row' },
            React.createElement('span', { className: 'tts-settings-copy' },
              React.createElement('span', null, '音色'),
              React.createElement('small', null, voiceList.length + ' 个可选，点「试听」感受效果，点「停止」结束')
            ),
            voiceControl
          ),
          // 播放属性:由当前引擎的能力表渲染(语速/音量/语调/情绪…)
          ...(caps.props || []).map((item) => row(item.label, item.note || '',
            propControl(item))),
          // 该引擎不支持的属性:灰字说明,避免用户以为坏了
          ...Object.entries(caps.unsupported || {}).map(([key, why]) =>
            React.createElement('div', { className: 'tts-settings-row tts-row-muted', key: 'unsupported-' + key },
              React.createElement('span', { className: 'tts-settings-copy' },
                React.createElement('span', null, key === 'pitch' ? '语调（音高）· 当前引擎不支持' : key + ' · 当前引擎不支持'),
                React.createElement('small', null, why)
              ),
              React.createElement('span', { className: 'tts-slider-value' }, '—')
            )),
          React.createElement('div', { className: 'tts-settings-status', role: 'status' }, status)
        );
      }

      return {
        name: 'dsh-minimax-tts',
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'tts',
            order: 35,
            label: () => '语音朗读'
          }, () => React.createElement(TTSSettingsSection)));
        }
      };
    }
  });

})();
