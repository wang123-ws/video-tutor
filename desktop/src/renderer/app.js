/**
 * 渲染进程主逻辑。
 * 音频捕获（系统声音）→ 16k PCM 分片 → 离线转写 → 推给助教核心 → 渲染笔记 / 图谱。
 *
 * 几个必须记住的坑（改代码前先读）：
 * 1) 配置与记录一律走 window.vt.store（主进程文件）。渲染进程 origin 是随机端口，
 *    localStorage 每次启动都是空的，用它存东西 = 重启即丢。
 * 2) 分片要短（默认 6 秒）且暂停/结束时必须把剩余缓冲也转写，否则用户等到最后什么都没有。
 * 3) 页面上要有「实时电平」，否则用户没法区分「没收到声音」和「在缓冲」。
 */
import { Tutor } from './core/tutor.js';
import { loadConfig, saveConfig, PROVIDER_PRESETS, DEFAULT_CONFIG } from './core/config.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* ============================ 状态 ============================ */

const app = {
  cfg: null,
  tutor: null,
  session: null,          // {id, title, startedAt}
  sessions: [],           // 历史记录
  capturing: false,
  stream: null,
  ac: null,
  tap: null,
  inRate: 48000,
  rawBuf: [],             // 原始采样率 Float32 片段
  rawLen: 0,
  audioPosMs: 0,          // 已采集音频的总时长（毫秒）——转写时间戳按视频位置显示，不用挂钟
  startedAt: 0,
  elapsedMs: 0,           // 暂停前累计的上课时长（暂停不清零，恢复后接着走）
  asrReady: false,
  chunkSecondsNow: 10,
  lastFlushMs: 0,
  lastFlushAt: 0,
  draftTimer: null,
  asrFail: 0,               // 本次陪学转写失败次数（ASR 崩了要让用户看见，而不是只闪 6 秒 toast）
  asrDropped: 0,            // 排队过长被丢弃的最旧切片数（保实时，宁可丢旧的也不无限堆积）
};

/* ---------- 转写队列 ----------
 * 以前的写法是「这一片转写完才收下一片」（busyFlush 门控）：转写慢的机器上，
 * 转写期间新音频不停堆积 → 下一片更大 → 转写更慢 → 间隔越拖越大（38 秒、71 秒…），
 * 时间戳离视频真实位置越来越远。
 * 现在：累积音频按固定时长切片入队，后台逐片转写，采集线程永不等待；
 * 队列有长度上限，超过就丢最旧的切片保实时。 */
const asrQueue = [];        // [{pcm: Float32Array, posMs}] 待转写切片（16kHz）
let asrRunning = false;
const ASR_QUEUE_MAX = 24;   // 最多排 24 片（10s/片 ≈ 4 分钟），超过丢最旧的

const K_SESSIONS = 'vt_sessions';
const K_DRAFT = 'vt_draft';
const ASR_LANGS = ['zh', 'auto', 'en', 'yue', 'ja', 'ko'];

/* ============================ 初始化 ============================ */

async function boot() {
  app.cfg = await loadConfig();

  // asrLang 兼容：核心默认值是给浏览器识别用的 'zh-CN'，本地 SenseVoice 只认 'zh'
  if (!ASR_LANGS.includes(app.cfg.asrLang)) app.cfg.asrLang = 'zh';

  // 开发/自带 Key：只在尚未配置过时写入一次，之后以设置页为准
  const info = await window.vt.appInfo();
  if (info.devKey && !app.cfg.apiKey) {
    app.cfg = await saveConfig({
      provider: info.devKey.provider,
      apiBase: info.devKey.apiBase,
      apiKey: info.devKey.apiKey,
      chatModel: info.devKey.chatModel,
      chatModelFallback: info.devKey.chatModelFallback,
    });
  }

  app.tutor = new Tutor(app.cfg, { emit: onTutorEvent });
  app.sessions = await loadSessions();
  await rescueDraft();

  bindWindowButtons();
  bindNav();
  bindStudy();
  bindLib();
  bindUpdate();
  await bindSettings();
  await refreshSources();
  await checkAsr();
  renderSessionList();

  // 启动后静默查一次更新，有新版才弹公告，没网/没新版就什么都不显示
  setTimeout(() => doCheckUpdate(true), 4000);

  /* 时钟走主进程心跳：主窗口收成悬浮条后是隐藏状态，Chromium 可能节流隐藏窗口的
   * setInterval（表现为「计时器不走 / 和悬浮条数字不一致」）。主进程定时器不受影响。 */
  window.vt.onTick(() => tickClock());

  console.log('[boot] 就绪 · 语音引擎=' + (app.asrReady ? '就绪' : '缺失')
    + ' · 提炼引擎=' + (app.tutor.usingLLM ? '大模型' : '本地')
    + ' · 记录=' + app.sessions.length + ' 条');

  if (!app.tutor.usingLLM) {
    setTimeout(() => {
      flash(app.cfg.apiKey
        ? '大模型暂不可用，当前用本地规则引擎提炼（笔记仍可用）'
        : '还没填 API Key，当前用本地规则引擎提炼。填 Key 后笔记质量会明显更好。',
        'warn');
    }, 900);
  }
}

/* ============================ 提示条 ============================ */

let toastTimer = null;
/**
 * 全局提示。之前用的是页面底部状态栏，而状态栏只存在于陪学页，
 * 在设置页点保存根本看不到 → 现在改成浮在最上层的提示条。
 */
function flash(msg, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'err' ? 6500 : 3600);
}

/* ============================ 窗口按钮 ============================ */

function bindWindowButtons() {
  $('#btnMin').onclick = () => window.vt.min();
  $('#btnMax').onclick = () => window.vt.max();
  $('#btnClose').onclick = () => window.vt.close();
}

function bindNav() {
  $$('.rail-item').forEach((b) => {
    b.onclick = () => {
      $$('.rail-item').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $$('.view').forEach((v) => v.classList.remove('active'));
      $('#view-' + b.dataset.view).classList.add('active');
      $('#listTitle').textContent = b.dataset.view === 'lib' ? '笔记库' : (b.dataset.view === 'settings' ? '设置' : '课程');
    };
  });
}

/* ============================ 音源与引擎 ============================ */

async function refreshSources() {
  const sel = $('#srcSelect');
  try {
    const srcs = await window.vt.sources();
    sel.innerHTML = srcs.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    if (!srcs.length) sel.innerHTML = '<option value="">未检测到屏幕音源</option>';
    console.log('[audio] 音源：', srcs.map((s) => s.id + '/' + s.name).join(' | '));
  } catch (e) {
    sel.innerHTML = '<option value="">获取音源失败</option>';
  }
}

async function checkAsr() {
  const s = await window.vt.asrStatus();
  app.asrReady = s.ready;
  renderAsrState();
  const box = $('#asrStatusBox');
  if (box) {
    box.innerHTML = s.ready
      ? `本地语音引擎已就绪。<br/>模型：<span class="mono">${escapeHtml(s.model || '')}</span><br/>完全离线运行，不联网、不消耗额度。`
      : `未找到本地语音引擎，无法进行语音转写。<br/>期望目录：<span class="mono">${escapeHtml(s.dir)}</span><br/>运行 <span class="mono">node tools/fetch-asr.mjs</span> 下载。`;
  }
  return s;
}

/* ============================ 陪学 ============================ */

function bindStudy() {
  $('#btnStart').onclick = startStudy;
  // 暂停 / 继续 是同一个按钮：暂停只是停下采集，随时能接着听
  $('#btnPause').onclick = async () => { app.capturing ? await pauseStudy() : await resumeStudy(); };
  $('#btnEnd').onclick = endStudy;
  $('#btnFloat').onclick = async () => {
    const visible = await window.vt.toggleFloat();
    flash(visible ? '悬浮条已显示，主窗口已让位' : '悬浮条已收起');
  };
  $('#btnNewSession').onclick = async () => {
    if (app.capturing) { flash('先结束当前陪学', 'warn'); return; }
    app.tutor.setConfig(app.cfg);
    app.tutor.reset();
    app.session = null;
    await clearDraft();
    resetStudyUI();
  };
}

function resetStudyUI() {
  $('#transcript').innerHTML = '<div class="empty">点「开始陪学」，然后切到 B站 / 网页 / 微信里的视频。<br/>软件会听系统声音，实时转写并提炼知识点。</div>';
  $('#notes').innerHTML = '<div class="empty">还没有知识点</div>';
  $('#liveCount').textContent = '0 段';
  $('#noteCount').textContent = '0 条';
  $('#studyTitle').textContent = '未开始';
  $('#studyMeta').textContent = '';
  $('#btnStart').disabled = false;
  $('#btnPause').disabled = true;
  $('#btnEnd').disabled = true;
  app.startedAt = 0;
  app.elapsedMs = 0;
  app.audioPosMs = 0;
  app.asrFail = 0;
  app.asrDropped = 0;
  $('#btnPause').textContent = '暂停';
  $('#stTime').textContent = '00:00';
  setBuf('0.0s', false);
  renderAsrState();
}

async function startStudy() {
  if (app.capturing) return;
  const sourceId = $('#srcSelect').value;
  if (!sourceId) { flash('没有可用的屏幕音源', 'err'); return; }
  if (!app.asrReady) { await checkAsr(); if (!app.asrReady) { flash('语音引擎未就绪，无法转写', 'err'); return; } }

  /* 先把音频链路建好，再启动助教。
   * 以前的顺序是反的：音频一失败，助教已经 start 过、session 也建了，
   * 留下一个"在听但什么都没采"的半启动状态，用户再点开始还会把之前的笔记顶掉。 */
  if (!(await startCapture())) return;

  app.tutor.setConfig(app.cfg);
  const title = '陪学 ' + timeStr();
  app.tutor.start({ title });
  app.session = { id: app.tutor.sessionId, title, startedAt: Date.now() };

  app.startedAt = Date.now();
  app.elapsedMs = 0;
  app.audioPosMs = 0;
  app.asrFail = 0;
  app.asrDropped = 0;
  app.chunkSecondsNow = Math.min(4, Number(app.cfg.chunkSeconds) || 10);   // 首片短一点，尽快出结果
  app.lastFlushMs = 0;
  app.maxPeakSeen = 0;
  app.lastSoundAt = 0;

  $('#dotAudio').className = 'st-dot on';
  $('#stAudio').textContent = '捕获中';
  $('#btnStart').disabled = true;
  $('#btnPause').disabled = false;
  $('#btnPause').textContent = '暂停';
  $('#btnEnd').disabled = false;
  $('#studyTitle').textContent = app.session.title;
  $('#studyMeta').textContent = '每 ' + (app.cfg.chunkSeconds || 10) + ' 秒转写一次';
  $('#transcript').innerHTML = '<div class="empty">正在听…首条转写约 4 秒后出现。</div>';
  $('#notes').innerHTML = '';

  publishBus();
  saveDraft();

  // 自动收成悬浮条，用户直接切去播视频就行
  setTimeout(async () => {
    try { await window.vt.openFloat(); } catch (_) {}
  }, 450);
}

/** 建立系统音频采集。成功返回 true；失败会清干净现场并提示，不留半启动状态。 */
async function startCapture() {
  const sourceId = $('#srcSelect').value;
  if (!sourceId) { flash('没有可用的屏幕音源', 'err'); return false; }
  let stream;
  try {
    stream = await openSystemAudio(sourceId);
  } catch (e) {
    flash('无法捕获系统声音：' + (e.message || e.name) + '（详情见控制台）', 'err');
    console.error('[audio] 捕获失败', e);
    return false;
  }
  app.stream = stream;

  try {
    await buildAudioGraph(stream);
  } catch (e) {
    flash('音频处理初始化失败：' + (e.message || e.name), 'err');
    stopCapture();
    return false;
  }
  app.capturing = true;
  return true;
}

/** 本次陪学已经进行了多少毫秒（暂停时间不计入） */
function studyElapsed() {
  return app.elapsedMs + (app.startedAt ? Date.now() - app.startedAt : 0);
}

/**
 * Windows 只允许按「整个屏幕」抓系统声音，Chromium 拿不到单个应用的音频。
 * 这里按兼容性依次尝试两种约束写法（Electron 文档推荐 audio 不带 ID）。
 */
async function openSystemAudio(sourceId) {
  const videoMandatory = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: sourceId,
    maxWidth: 2, maxHeight: 2, maxFrameRate: 1,
  };
  const attempts = [
    { name: 'audio桌面源（不带ID）', audio: { mandatory: { chromeMediaSource: 'desktop' } } },
    { name: 'audio桌面源（带ID）', audio: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } } },
    { name: 'audio仅desktopId', audio: { mandatory: { chromeMediaSourceId: sourceId } } },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: a.audio,
        video: { mandatory: videoMandatory },
      });
      const at = s.getAudioTracks();
      if (!at.length) {
        s.getTracks().forEach((t) => t.stop());
        lastErr = new Error(a.name + ' 没有返回音轨');
        continue;
      }
      console.log('[audio] 采用约束：' + a.name + ' · audio track=' + at[0].label
        + ' · settings=' + JSON.stringify(at[0].getSettings()));
      return s;
    } catch (e) {
      lastErr = e;
      console.warn('[audio] 约束失败：' + a.name + ' → ' + (e.message || e.name));
    }
  }
  throw lastErr || new Error('所有音频约束都失败了');
}

/* ---------- 音频图：AudioWorklet 优先，回退 ScriptProcessor ---------- */

async function buildAudioGraph(stream) {
  const AC = window.AudioContext || window.webkitAudioContext;
  app.ac = new AC();     // 用设备默认采样率采集，自己降采样到 16k（更兼容）
  if (app.ac.state === 'suspended') { try { await app.ac.resume(); } catch (_) {} }
  app.inRate = app.ac.sampleRate || 48000;

  const src = app.ac.createMediaStreamSource(stream);
  app.rawBuf = [];
  app.rawLen = 0;

  const onBlock = (block) => {
    trackPeak(block);
    app.rawBuf.push(block);
    app.rawLen += block.length;
    app.audioPosMs += (block.length / app.inRate) * 1000;
    const sec = app.rawLen / app.inRate;
    if (sec >= app.chunkSecondsNow) flushChunk(false);
  };

  // 输出必须接上：否则节点不会被拉取。用极小的增益而不是 0，
  // 避免整条链路被判定为静音而被跳过（这样也就不会外放产生回声）。
  const mute = app.ac.createGain();
  mute.gain.value = 0.0001;

  let ok = false;
  if (app.ac.audioWorklet) {
    try {
      await app.ac.audioWorklet.addModule('./pcm-tap.js');
      const node = new AudioWorkletNode(app.ac, 'pcm-tap', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      });
      node.port.onmessage = (e) => onBlock(new Float32Array(e.data));
      src.connect(node); node.connect(mute); mute.connect(app.ac.destination);
      app.tap = node;
      ok = true;
      console.log('[audio] 采集管线：AudioWorklet · 采样率 ' + app.inRate);
    } catch (e) {
      console.warn('[audio] AudioWorklet 不可用，回退 ScriptProcessor：' + (e.message || e));
    }
  }
  if (!ok) {
    const node = app.ac.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => onBlock(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(node); node.connect(mute); mute.connect(app.ac.destination);
    app.tap = node;
    console.log('[audio] 采集管线：ScriptProcessor · 采样率 ' + app.inRate);
  }

  // 3 秒后如果电平一直是 0，直接告诉用户「没收到声音」，别让他干等
  setTimeout(() => {
    if (app.capturing && app.maxPeakSeen < 0.002) {
      flash('还没收到任何声音。确认视频在播放、系统音量没静音；Windows 只支持整屏抓声，'
        + '若用的是蓝牙耳机，切回扬声器再试。', 'warn');
    }
  }, 3000);
}

function stopCapture() {
  app.capturing = false;
  try { if (app.tap) { app.tap.port && (app.tap.port.onmessage = null); app.tap.disconnect(); } } catch (_) {}
  app.tap = null;
  try { if (app.ac) app.ac.close(); } catch (_) {}
  app.ac = null;
  try { if (app.stream) app.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  app.stream = null;
  app.rawBuf = [];
  app.rawLen = 0;
  $('#dotAudio').className = 'st-dot';
  $('#stAudio').textContent = '未连接';
  setBuf('0.0s', false);
}

/* ---------- 分片转写 ---------- */

function setBuf(text, active) {
  const el = $('#stBuf');
  if (!el) return;
  el.textContent = text;
  el.className = 'mono' + (active ? ' active' : '');
}

/** 48000/44100 → 16000，整数比走分组平均，非整数比走线性插值 */
function downsample(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  if (Number.isInteger(ratio)) {
    for (let i = 0; i < outLen; i++) {
      let s = 0;
      const base = i * ratio;
      for (let j = 0; j < ratio; j++) s += input[base + j];
      out[i] = s / ratio;
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio;
      const i0 = Math.floor(p);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const t = p - i0;
      out[i] = input[i0] * (1 - t) + input[i1] * t;
    }
  }
  return out;
}

/**
 * 把当前缓冲转写掉。
 * force=true 用于暂停/结束：哪怕不足一片也要转写，否则最后一段话会被直接丢掉。
 */
/**
 * 把当前缓冲切片入队（不在这里干等转写）。
 * force=true 用于暂停/结束：哪怕不足一片也要转写，并且等队列排干，否则最后一段话会被直接丢掉。
 */
async function flushChunk(force) {
  const frames = app.rawBuf;
  const rawLen = app.rawLen;
  app.rawBuf = [];
  app.rawLen = 0;
  if (!rawLen) { setBuf('0.0s', false); return; }

  const merged = new Float32Array(rawLen);
  let off = 0;
  for (const f of frames) { merged.set(f, off); off += f.length; }
  const down = downsample(merged, app.inRate, 16000);

  const seconds = rawLen / app.inRate;
  if (seconds < 0.8 && !force) return;              // 太短，转写没有意义

  // 这段音频覆盖的起始位置（毫秒）——时间戳按视频位置显示，不用挂钟
  const startPos = Math.max(0, app.audioPosMs - seconds * 1000);

  const chunkSec = Number(app.cfg.chunkSeconds) || 10;
  const sliceLen = Math.max(1, Math.round(16000 * chunkSec));

  for (let i = 0; i < down.length; i += sliceLen) {
    const slice = down.subarray(i, Math.min(i + sliceLen, down.length));
    if (slice.length < 0.8 * 16000 && !force) continue;   // 尾片太短没意义
    let peak = 0;
    for (let j = 0; j < slice.length; j++) {
      const a = slice[j] < 0 ? -slice[j] : slice[j];
      if (a > peak) peak = a;
    }
    if (peak < 0.004) continue;                    // 静音切片，不浪费一次转写
    asrQueue.push({ pcm: slice, posMs: startPos + (i / 16000) * 1000 });
  }

  // 队列过长：丢最旧的切片保实时（转写速度跟不上采集速度时的取舍）
  while (asrQueue.length > ASR_QUEUE_MAX) {
    asrQueue.shift();
    app.asrDropped++;
  }
  if (asrQueue.length >= ASR_QUEUE_MAX) {
    flash(`转写排队已满，丢弃最旧音频保实时（已丢 ${app.asrDropped} 片）`, 'warn');
  }

  if (force) await drainAsr();     // 暂停/结束：等队列排干，别丢最后一段
  else pumpAsr();
}

/** 后台逐片转写：采集线程不等待，切片大小恒定，不会再越转越慢 */
function pumpAsr() {
  if (asrRunning) return;
  asrRunning = true;
  setBuf('转写中…', true);
  (async () => {
    while (asrQueue.length) {
      await transcribeOne(asrQueue.shift());
    }
    asrRunning = false;
    setBuf((app.rawLen / (app.inRate || 48000)).toFixed(1) + 's', false);
  })();
}

async function drainAsr() {
  pumpAsr();
  while (asrRunning || asrQueue.length) {
    await new Promise((r) => setTimeout(r, 60));
  }
}

async function transcribeOne({ pcm, posMs }) {
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = pcm[i];
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const seconds = pcm.length / 16000;
  setBuf(`转写中 ${fmtPos(posMs)}…`, true);
  const t0 = Date.now();
  try {
    const r = await window.vt.transcribe(out.buffer, app.cfg.asrLang || 'zh');
    const text = String(r.text || '').trim();
    app.lastFlushMs = Date.now() - t0;
    app.lastFlushAt = Date.now();
    if (!text || isNoise(text)) {
      console.log(`[asr] ${fmtPos(posMs)} ${seconds.toFixed(1)}s → 无有效文本（${app.lastFlushMs}ms）`);
    } else {
      console.log(`[asr] ${fmtPos(posMs)} ${seconds.toFixed(1)}s → ${app.lastFlushMs}ms · ${text.slice(0, 60)}`);
      app.tutor.pushSegment({ text, tStart: posMs, tEnd: posMs + seconds * 1000 });
      publishBus();
      saveDraft();
    }
  } catch (e) {
    /* ASR 崩了不能只闪一条 6 秒的 toast：状态栏持续显示失败次数，
     * 转写区留一条错误记录，用户一眼能看出「0 段」是因为引擎坏了，不是在缓冲。 */
    app.asrFail++;
    appendTranscript({ text: '⚠ 转写失败：' + (e.message || e), tStart: posMs, failed: true });
    flash('转写失败：' + (e.message || e), 'err');
    console.error('[asr] 失败', e);
  } finally {
    renderAsrState();
  }
}

/** 静音 / 噪声时常被识别成这类无意义内容 */
const NOISE = /^[\s　。，、,.!！?？…~～嗯啊呃哦嗷呵嘿哈]*$/;
function isNoise(t) {
  const s = String(t).replace(/\s/g, '');
  if (s.length < 2) return true;
  if (NOISE.test(s)) return true;
  if (/^(谢谢|thank you|请不吝点赞|订阅|字幕由|字幕志愿者|www\.)/i.test(s)) return true;
  return false;
}

async function pauseStudy() {
  if (!app.capturing) return;
  await flushChunk(true);      // 关键：把最后不足一片的话也转写出来
  stopCapture();
  app.elapsedMs += Date.now() - app.startedAt;
  app.startedAt = 0;
  app.tutor.pause();
  // 按钮变成「继续」：以前暂停后按钮直接禁用，课就再也接不回去了
  const btn = $('#btnPause');
  btn.disabled = false;
  btn.textContent = '继续';
  flash('已暂停，输出本小节小结。点「继续」接着听课。', 'ok');
  publishBus();
  saveDraft();
}

/** 暂停后接着听：重新采集 + 助教恢复，时长接着之前走 */
async function resumeStudy() {
  if (app.capturing || !app.session) return;
  if (!(await startCapture())) return;
  app.startedAt = Date.now();
  app.chunkSecondsNow = Math.min(4, Number(app.cfg.chunkSeconds) || 10);
  app.maxPeakSeen = 0;
  app.lastSoundAt = 0;
  app.tutor.resume();

  $('#btnPause').textContent = '暂停';
  $('#dotAudio').className = 'st-dot on';
  $('#stAudio').textContent = '捕获中';
  $('#studyMeta').textContent = '已继续 · 每 ' + (app.cfg.chunkSeconds || 10) + ' 秒转写一次';
  flash('已继续听课', 'ok');
  publishBus();
  saveDraft();
}

async function endStudy() {
  if (app.capturing) {
    await flushChunk(true);    // 关键：结束前抢救最后一段
    stopCapture();
  }
  await app.tutor.end();

  const snap = app.tutor.snapshot();
  const rec = {
    id: (app.session && app.session.id) || String(Date.now()),
    title: (app.session && app.session.title) || '陪学 ' + timeStr(),
    startedAt: (app.session && app.session.startedAt) || Date.now(),
    endedAt: Date.now(),
    notes: snap.notes || [],
    transcript: (snap.transcript || []).map((t) => (typeof t === 'string' ? t : t.text)),
    graph: snap.graph || null,
    sections: snap.sections || [],
  };
  app.sessions.unshift(rec);
  // 条数上限统一在 saveSessions() 里管（60 条），这里不再写第二套
  await saveSessions();
  await clearDraft();
  app.session = null;
  currentSessionId = rec.id;
  renderSessionList();

  $('#btnEnd').disabled = true;
  $('#btnPause').disabled = true;
  $('#btnStart').disabled = false;
  $('#studyMeta').textContent = '';
  flash(`已结束，${rec.notes.length} 条笔记已存入笔记库`, 'ok');
  publishBus();
}

/* ============================ 助教事件 ============================ */

function onTutorEvent(type, payload) {
  switch (type) {
    case 'transcript':
      appendTranscript(payload);
      break;
    case 'notes':
      renderNotes(app.tutor.notes);
      break;
    case 'section':
      flash('本小节小结：' + (payload.summary || '').slice(0, 60), 'ok');
      break;
    case 'ended':
      renderNotes(payload.notes || []);
      break;
    case 'error':
      flash(payload.message || '出错', 'err');
      break;
    case 'log':
      if (payload.level === 'warn') flash(payload.text, 'warn');
      break;
  }
  if (type === 'transcript' || type === 'notes') { publishBus(); saveDraft(); }
}

function appendTranscript(seg) {
  const box = $('#transcript');
  if (!box) return;
  if (box.querySelector('.empty')) box.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'seg' + (seg.failed ? ' failed' : '');
  const ts = document.createElement('span');
  ts.className = 'ts';
  // 有音频位置就按视频位置显示（00:05 这种），用户能直接对回视频；兜底才用挂钟
  ts.textContent = seg.tStart != null ? fmtPos(seg.tStart) : clockOf(seg.ts || Date.now());
  const tx = document.createElement('span');
  tx.className = 'tx';
  tx.textContent = seg.text;
  el.appendChild(ts);
  el.appendChild(tx);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  $('#liveCount').textContent = app.tutor.transcript.length + ' 段';
}

function renderNotes(notes) {
  const box = $('#notes');
  if (!box) return;
  if (!notes.length) { box.innerHTML = '<div class="empty">还没有知识点</div>'; $('#noteCount').textContent = '0 条'; return; }
  box.innerHTML = notes.map((n) => {
    const tag = n.tag || '重点';
    return `<div class="note">
      <div class="nh"><span class="tag tag-${tag}">${escapeHtml(tag)}</span><span class="ttl">${escapeHtml(n.title || '')}</span></div>
      ${n.body ? `<div class="body">${escapeHtml(n.body)}</div>` : ''}
      <div class="ft">${clockOf(n.ts || Date.now())}</div>
    </div>`;
  }).join('');
  $('#noteCount').textContent = notes.length + ' 条';
  box.scrollTop = box.scrollHeight;
}

/* ============================ 笔记库 ============================ */

function bindLib() {
  $$('.tab[data-libtab]').forEach((t) => {
    t.onclick = () => {
      $$('.tab[data-libtab]').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      renderLib();
    };
  });
  $('#btnExportMd').onclick = exportMd;
  $('#btnCopyGraph').onclick = copyGraph;
}

let currentSessionId = null;

function renderSessionList() {
  const box = $('#sessionList');
  if (!box) return;
  if (!app.sessions.length) {
    box.innerHTML = '<div class="empty">还没有记录<br/>陪学一次就会存到这里</div>';
    renderLib();
    return;
  }
  if (!currentSessionId || !app.sessions.some((s) => s.id === currentSessionId)) {
    currentSessionId = app.sessions[0].id;
  }
  box.innerHTML = app.sessions.map((s) => {
    const active = s.id === currentSessionId ? ' active' : '';
    const d = new Date(s.startedAt);
    const sub = `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())} · ${(s.notes || []).length} 条笔记`;
    return `<div class="listitem${active}" data-id="${s.id}">
      <div class="t">${escapeHtml(s.title)}</div>
      <div class="s">${escapeHtml(sub)}</div>
    </div>`;
  }).join('');
  $$('#sessionList .listitem').forEach((el) => {
    el.onclick = () => {
      currentSessionId = el.dataset.id;
      renderSessionList();
    };
  });
  renderLib();
}

function renderLib() {
  const s = app.sessions.find((x) => x.id === currentSessionId);
  const body = $('#libBody');
  if (!body) return;
  if (!s) { body.innerHTML = '<div class="empty">选择一条记录</div>'; return; }
  const tab = ($('.tab.active[data-libtab]') || {}).dataset?.libtab || 'notes';
  $('#libTitle').textContent = s.title;

  if (tab === 'notes') {
    body.innerHTML = (s.notes || []).map((n) => {
      const tag = n.tag || '重点';
      return `<div class="note">
        <div class="nh"><span class="tag tag-${tag}">${escapeHtml(tag)}</span><span class="ttl">${escapeHtml(n.title || '')}</span></div>
        ${n.body ? `<div class="body">${escapeHtml(n.body)}</div>` : ''}
      </div>`;
    }).join('') || '<div class="empty">这次没有笔记</div>';
  } else {
    const g = s.graph;
    if (!g || !g.mermaid) { body.innerHTML = '<div class="empty">这次没有生成图谱</div>'; return; }
    body.innerHTML = `<pre class="mermaid-src">${escapeHtml(g.mermaid)}</pre>`;
  }
}

function exportMd() {
  const s = app.sessions.find((x) => x.id === currentSessionId);
  if (!s) { flash('先选一条记录', 'warn'); return; }
  const md = [
    `# ${s.title}`,
    '',
    `时间：${new Date(s.startedAt).toLocaleString('zh-CN')} — ${new Date(s.endedAt || Date.now()).toLocaleString('zh-CN')}`,
    '',
    '## 知识点',
    '',
    ...(s.notes || []).map((n) => `- **【${n.tag || '重点'}】${n.title}** — ${n.body || ''}`),
    '',
    '## 知识图谱',
    '',
    '```mermaid',
    s.graph ? s.graph.mermaid : '(无)',
    '```',
  ].join('\n');
  window.vt.saveFile({ defaultName: s.title.replace(/[\\/:*?"<>|]/g, '_') + '.md', content: md })
    .then((r) => flash(r.ok ? '已导出到 ' + r.filePath : '已取消', r.ok ? 'ok' : ''))
    .catch((e) => flash('导出失败：' + e.message, 'err'));
}

function copyGraph() {
  const s = app.sessions.find((x) => x.id === currentSessionId);
  if (!s || !s.graph) { flash('没有图谱', 'warn'); return; }
  navigator.clipboard.writeText(s.graph.mermaid).then(() => flash('图谱已复制', 'ok'));
}

/* ============================ 设置 ============================ */

async function bindSettings() {
  const sel = $('#cfgProvider');
  sel.innerHTML = Object.entries(PROVIDER_PRESETS)
    .map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join('');

  fillSettings(app.cfg);
  window.vt.setCloseBehavior(app.cfg.closeBehavior || 'hide');

  sel.onchange = () => {
    const p = PROVIDER_PRESETS[sel.value];
    if (!p) return;
    $('#cfgModel').value = p.chatModel || '';
    $('#cfgModelFb').value = p.chatModelFallback || '';
    $('#providerNote').textContent = p.note || '';
  };

  $('#cfgClose').onchange = () => window.vt.setCloseBehavior($('#cfgClose').value);

  $('#btnSaveCfg').onclick = async () => {
    const btn = $('#btnSaveCfg');
    const raw = $('#btnSaveCfg').textContent;
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      app.cfg = await saveConfig({
        provider: sel.value,
        apiKey: $('#cfgApiKey').value.trim(),
        chatModel: $('#cfgModel').value.trim(),
        chatModelFallback: $('#cfgModelFb').value.trim(),
        engine: $('#cfgEngine').value,
        extractChars: Number($('#cfgChars').value) || 240,
        extractIntervalMs: Number($('#cfgInterval').value) || 15000,
        asrLang: $('#cfgAsrLang').value,
        chunkSeconds: Math.max(3, Number($('#cfgChunkSec').value) || 10),
        closeBehavior: $('#cfgClose').value,
      });
      app.tutor.setConfig(app.cfg);
      updateEngineStatus();
      btn.textContent = '已保存';
      flash('设置已保存并生效' + (app.tutor.usingLLM ? '（提炼引擎：大模型）' : '（提炼引擎：本地规则）'), 'ok');
    } catch (e) {
      btn.textContent = raw;
      btn.disabled = false;
      flash('保存失败：' + (e.message || e), 'err');
      return;
    }
    setTimeout(() => { btn.textContent = raw; btn.disabled = false; }, 1500);
  };

  $('#btnTestLlm').onclick = async () => {
    $('#testLlmResult').textContent = '测试中…';
    try {
      const { LLMClient } = await import('./core/llm.js');
      const cfg = { ...app.cfg, apiKey: $('#cfgApiKey').value.trim(), chatModel: $('#cfgModel').value.trim() };
      const r = await new LLMClient(cfg).chat([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 16 });
      $('#testLlmResult').textContent = '可用（' + r.text.slice(0, 12) + '）';
      flash('大模型可用', 'ok');
    } catch (e) {
      $('#testLlmResult').textContent = String(e.message || e).slice(0, 80);
      flash('连接失败：' + String(e.message || e).slice(0, 90), 'err');
    }
  };

  // 更新设置
  const uc = await window.vt.update.config();
  $('#cfgAutoUpdate').value = uc.autoCheck ? 'on' : 'off';
  // 更新源只读展示：软件自带、自动检查，用户不需要配置（自定义源能力保留在后端）
  $('#feedInfo').textContent = uc.defaultFeed
    ? '更新源：' + uc.defaultFeed + '（软件自带，自动检查，无需设置）'
    : '更新源：软件自带（自动检查）';

  const info = await window.vt.appInfo();
  const storePath = await window.vt.store.path();
  $('#storePath').textContent = storePath;
  $('#btnOpenData').onclick = () => window.vt.openPath(storePath.replace(/[\\/][^\\/]+$/, ''));
  $('#aboutBox').innerHTML = `版本 ${info.version} · Electron ${info.electron} · ${info.isDev ? '开发模式' : '已安装'}
    <br/>语音引擎目录：<span class="mono">${escapeHtml(info.asrDir)}</span>
    <br/>配置与记录保存在上面的数据文件里，重启、换端口都不会丢。`;
  updateEngineStatus();
}

function fillSettings(c) {
  $('#cfgProvider').value = c.provider || 'modelscope';
  $('#cfgApiKey').value = c.apiKey || '';
  $('#cfgModel').value = c.chatModel || '';
  $('#cfgModelFb').value = c.chatModelFallback || '';
  $('#cfgEngine').value = c.engine || 'auto';
  $('#cfgChars').value = c.extractChars || 240;
  $('#cfgInterval').value = c.extractIntervalMs || 15000;
  $('#cfgAsrLang').value = ASR_LANGS.includes(c.asrLang) ? c.asrLang : 'zh';
  $('#cfgChunkSec').value = c.chunkSeconds || 10;
  $('#cfgClose').value = c.closeBehavior === 'quit' ? 'quit' : 'hide';
  const p = PROVIDER_PRESETS[c.provider];
  $('#providerNote').textContent = p ? p.note : '';
}

function updateEngineStatus() {
  const dot = $('#dotLlm');
  const using = app.tutor && app.tutor.usingLLM;
  dot.className = 'st-dot ' + (using ? 'on' : 'warn');
  $('#stLlm').textContent = using
    ? (app.cfg.chatModel || '大模型')
    : (app.cfg.apiKey ? '大模型不可用·本地引擎' : '本地引擎');
}

/* ============================ 持久化 ============================ */

async function loadSessions() {
  try {
    const v = await window.vt.store.get(K_SESSIONS);
    return Array.isArray(v) ? v : [];
  } catch (_) { return []; }
}

async function saveSessions() {
  /* 只保留最近 60 条。这个文件是「整份重写」，记录无限增长会让每次保存越来越慢、
   * store.json 越来越大；单条的转写也截到 300 段，防止某一次特别长的陪学把文件撑爆。 */
  if (app.sessions.length > 60) app.sessions = app.sessions.slice(0, 60);
  app.sessions = app.sessions.map((s) => (
    s.transcript && s.transcript.length > 300
      ? { ...s, transcript: s.transcript.slice(-300) }
      : s
  ));
  try { await window.vt.store.set(K_SESSIONS, app.sessions); } catch (_) {}
}

/** 每次有新内容就落一次草稿（节流），程序被强杀也不会丢 */
function saveDraft() {
  if (!app.session || !app.tutor) return;
  clearTimeout(app.draftTimer);
  app.draftTimer = setTimeout(saveDraftNow, 1500);
}

/** 立即落盘（退出前用） */
async function saveDraftNow() {
  if (!app.session || !app.tutor) return;
  clearTimeout(app.draftTimer);
  const snap = app.tutor.snapshot();
  const hasContent = (snap.transcript || []).length || (snap.notes || []).length;
  if (!hasContent) return;
  try {
    await window.vt.store.set(K_DRAFT, {
      id: app.session.id,
      title: app.session.title,
      startedAt: app.session.startedAt,
      savedAt: Date.now(),
      notes: snap.notes || [],
      transcript: (snap.transcript || []).map((t) => (typeof t === 'string' ? t : t.text)),
      graph: snap.graph || null,
      sections: snap.sections || [],
    });
  } catch (_) {}
}

async function clearDraft() {
  clearTimeout(app.draftTimer);
  try { await window.vt.store.set(K_DRAFT, null); } catch (_) {}
}

/** 启动时发现上次没正常结束的草稿，抢救进笔记库 */
async function rescueDraft() {
  let d = null;
  try { d = await window.vt.store.get(K_DRAFT); } catch (_) {}
  if (!d || !d.id) return;
  if (app.sessions.some((s) => s.id === d.id)) { await clearDraft(); return; }
  const hasContent = (d.notes || []).length || (d.transcript || []).length;
  if (!hasContent) { await clearDraft(); return; }
  app.sessions.unshift({
    id: d.id,
    title: (d.title || '陪学') + '（未正常结束）',
    startedAt: d.startedAt || Date.now(),
    endedAt: d.savedAt || Date.now(),
    notes: d.notes || [],
    transcript: d.transcript || [],
    graph: d.graph || null,
    sections: d.sections || [],
  });
  await saveSessions();
  await clearDraft();
  setTimeout(() => flash(`上次陪学没正常结束，已把 ${(d.notes || []).length} 条笔记抢救回笔记库`, 'ok'), 1200);
}

/* ============================ 电平与时钟 ============================ */

/** 语音引擎状态：正常 / 缺失 / 本次陪学已失败 N 次。
 *  失败次数持续显示在状态栏，不随 toast 消失——否则用户只看到「0 段」不知道原因。 */
function renderAsrState() {
  const dot = $('#dotAsr');
  if (!dot) return;
  if (app.asrFail > 0) {
    dot.className = 'st-dot err';
    $('#stAsr').textContent = '转写失败×' + app.asrFail;
    $('#stAsr').title = '本地语音引擎启动失败。重启软件试试；若仍失败，把安装目录改成纯英文路径。';
  } else if (app.asrDropped > 0) {
    dot.className = 'st-dot warn';
    $('#stAsr').textContent = `离线 SenseVoice · 丢片×${app.asrDropped}`;
    $('#stAsr').title = '转写速度跟不上播放速度，已丢弃最旧音频保实时。可在设置中加大分片秒数。';
  } else {
    dot.className = 'st-dot ' + (app.asrReady ? 'on' : 'err');
    $('#stAsr').textContent = app.asrReady ? '离线 SenseVoice' : '引擎缺失';
    $('#stAsr').title = '';
  }
}

let lvlPeak = 0;
app.maxPeakSeen = 0;

function trackPeak(block) {
  let p = 0;
  for (let i = 0; i < block.length; i++) {
    const a = block[i] < 0 ? -block[i] : block[i];
    if (a > p) p = a;
  }
  if (p > lvlPeak) lvlPeak = p;
  if (p > app.maxPeakSeen) app.maxPeakSeen = p;
  app.lastSoundAt = p > 0.004 ? Date.now() : app.lastSoundAt;
}

function renderLevel() {
  const bar = $('#lvlBar');
  const box = $('.statusbar .lvl');
  if (bar) bar.style.width = Math.min(100, Math.round(lvlPeak * 140)) + '%';
  if (box) box.classList.toggle('hot', lvlPeak > 0.92);
  lvlPeak *= 0.82;
}
// 用定时器而不是 requestAnimationFrame：主窗口收成悬浮条后是隐藏状态，
// rAF 不会触发，电平条就冻住了。
setInterval(renderLevel, 60);

function publishBus() {
  const snap = app.tutor ? app.tutor.snapshot() : {};
  const last = (snap.transcript || []).slice(-2).map((t) => (typeof t === 'string' ? t : t.text)).join(' ');
  const notes = (snap.notes || []).slice(-3).map((n) => `【${n.tag}】${n.title}`);
  window.vt.busPub({
    capturing: app.capturing,
    title: app.session ? app.session.title : '',
    last,
    notes,
    noteCount: (snap.notes || []).length,
    elapsed: app.capturing || app.session ? studyElapsed() : 0,
    level: Math.min(1, lvlPeak * 1.4),
    buffered: app.inRate ? app.rawLen / app.inRate : 0,
    chunkSeconds: Number(app.cfg && app.cfg.chunkSeconds) || 10,
    busy: asrRunning,
    queued: asrQueue.length,
    lastFlushMs: app.lastFlushMs,
  });
}

function tickClock() {
  if (app.session && (app.capturing || app.startedAt === 0 && app.elapsedMs)) {
    $('#stTime').textContent = durStr(studyElapsed());
  }
  if (app.capturing) {
    if (asrQueue.length) setBuf(`排队 ${asrQueue.length} 片 · 缓冲 ${(app.rawLen / (app.inRate || 48000)).toFixed(1)}s`, true);
    else if (asrRunning) setBuf('转写中…', true);
    else setBuf((app.rawLen / (app.inRate || 48000)).toFixed(1) + 's / ' + (app.cfg.chunkSeconds || 10) + 's', true);
    publishBus();
  }
  updateEngineStatus();
  renderAsrState();
}

/* ============================ 自动更新 ============================
 * 目标：主流软件那样 —— 有新版就在顶部弹公告，点一下自己下载覆盖安装，
 * 不用手动卸载旧版（安装包是同一个 appId 的 NSIS 包，装时会卸旧写新，用户数据保留）。
 */

const upd = { available: null, downloading: false };

function bindUpdate() {
  window.vt.update.onProgress(onUpdateProgress);
  window.vt.update.onAvailable((r) => { if (r && r.hasUpdate) showUpdateBanner(r); });
  // 托盘菜单「检查更新」→ 主进程会先把窗口唤回来，这里紧接着查一次
  window.vt.update.onCheckNow(() => doCheckUpdate(false));

  $('#updGo').onclick = () => startDownload();
  $('#updLater').onclick = () => { $('#updBanner').hidden = true; };
  $('#updIgnore').onclick = async () => {
    if (upd.available && upd.available.latest) {
      await window.vt.update.setConfig({ skipVersion: upd.available.latest.version });
    }
    $('#updBanner').hidden = true;
    flash('已忽略这个版本，以后不再提示', 'ok');
  };
  $('#btnCheckUpdate').onclick = () => doCheckUpdate(false);
  $('#cfgAutoUpdate').onchange = () => window.vt.update.setConfig({ autoCheck: $('#cfgAutoUpdate').value });
}

function showUpdateBanner(r) {
  upd.available = r;
  const m = r.latest || {};
  $('#updVer').textContent = 'v' + m.version + (r.current ? `（当前 v${r.current}）` : '');
  $('#updNotes').textContent = String(m.notes || '').replace(/\s*[\r\n]+\s*/g, ' · ').slice(0, 140);
  $('#updNotes').title = String(m.notes || '');
  $('#updProg').hidden = true;
  $('#updGo').disabled = false;
  $('#updGo').textContent = '立即更新';
  $('#updBanner').hidden = false;
}

function setUpdateBar(pct) {
  $('#updBar').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

function onUpdateProgress(p) {
  if (!p) return;
  const mb = (n) => (Number(n) / 1048576).toFixed(1) + ' MB';
  if (p.phase === 'downloading') {
    const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
    setUpdateBar(pct);
    $('#updGo').textContent = p.total
      ? `下载中 ${pct}%（${mb(p.received)} / ${mb(p.total)}）`
      : `下载中 ${mb(p.received)}`;
  } else if (p.phase === 'done') {
    setUpdateBar(100);
  } else if (p.phase === 'error') {
    flash('更新出错：' + (p.error || '未知原因'), 'err');
  }
}

async function startDownload() {
  if (upd.downloading) return;
  upd.downloading = true;
  const btn = $('#updGo');
  btn.disabled = true;
  btn.textContent = '准备中…';
  $('#updProg').hidden = false;
  setUpdateBar(0);

  const r = await window.vt.update.download();
  upd.downloading = false;
  if (!r || !r.ok) {
    btn.disabled = false;
    btn.textContent = '重试';
    flash('下载失败：' + ((r && r.error) || '未知原因') + '。也可以去官网手动下载。', 'err');
    return;
  }

  btn.textContent = '安装中…';
  flash('下载完成，正在安装新版…（装完会自动打开新版）', 'ok');
  const ins = await window.vt.update.install();
  if (ins && ins.dev) {
    btn.disabled = false;
    btn.textContent = '立即更新';
    flash('开发模式不自动安装，安装包已下载到：' + ins.file, 'warn');
    return;
  }
  if (!ins || !ins.ok) {
    btn.disabled = false;
    btn.textContent = '手动安装';
    flash('自动安装失败：' + ((ins && ins.error) || '') + '，已打开安装包目录', 'err');
    window.vt.update.openDir();
  }
  // 成功的情况：主进程会启动安装包并退出自己，这里不用管
}

async function doCheckUpdate(silent) {
  const r = await window.vt.update.check().catch((e) => ({ ok: false, error: String(e) }));
  if (!r || !r.ok) {
    const noFeed = r && r.reason === 'nofeed';
    const msg = noFeed ? '还没有配置更新源，请在「更新源地址」里填一个' : ((r && r.error) || '未知原因');
    $('#checkUpdateResult').textContent = noFeed ? '未配置更新源' : '检查失败：' + msg;
    if (!silent) flash(msg, noFeed ? 'warn' : 'err');
    return r;
  }
  $('#checkUpdateResult').textContent =
    `当前 v${r.current} · 最新 v${(r.latest && r.latest.version) || '-'}`;
  if (r.hasUpdate) {
    showUpdateBanner(r);
    if (!silent) flash('发现新版本 v' + r.latest.version, 'ok');
  } else {
    $('#updBanner').hidden = true;
    if (!silent) {
      flash(r.reason === 'skipped'
        ? `当前已是最新版 v${r.current}（你忽略过 v${r.latest.version}）`
        : `已经是最新版 v${r.current}`, 'ok');
    }
  }
  return r;
}

/* ============================ 工具 ============================ */

const pad = (n) => String(n).padStart(2, '0');
const timeStr = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const clockOf = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const durStr = (ms) => { const s = Math.floor(ms / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
/** 音频位置（毫秒）→ 00:05 / 1:02:03。转写条目按视频位置显示，方便对回视频进度 */
const fmtPos = (ms) => {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 退出前抢救草稿（不等节流，直接写） */
window.vt.onBeforeQuit(() => { saveDraftNow(); });

/* 调试/自检用：控制台可以直接查看内部状态 */
window.__vtApp = app;

boot().catch((e) => {
  console.error(e);
  flash('启动异常：' + (e.message || e), 'err');
});
