/**
 * 侧边栏：陪学主界面。
 * 负责转写采集（字幕 / 麦克风语音识别 / 手动 / 云端ASR）、笔记与图谱渲染、控制指令下发。
 */

const $ = (s) => document.querySelector(s);
const state = { snap: null, cfg: null, listening: false, charTotal: 0 };

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false }));
  });
}
function toast(text, ms = 1900) {
  const el = $('#toast');
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, ms);
}
const STATE_TEXT = { idle: '待命', listening: '听课中', paused: '已暂停', ended: '已结束' };

/* ============ 麦克风语音识别（浏览器内置，零成本） ============ */
class MicRecognizer {
  constructor({ onFinal, onInterim, onError, onState }) {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.onFinal = onFinal;
    this.onInterim = onInterim;
    this.onError = onError;
    this.onState = onState;
    this.rec = null;
    this.running = false;
    this.buf = '';
    this.lastPush = 0;
    this.pushTimer = null;
  }

  get supported() { return !!this.SR; }

  start(lang = 'zh-CN') {
    if (!this.SR) { this.onError('当前浏览器不支持内置语音识别，请改用「手动粘贴文本」或「云端 ASR」'); return false; }
    if (this.running) return true;
    const rec = new this.SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.buf += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.onInterim?.(interim);
      this._maybePush();
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.onError?.(`语音识别出错：${e.error}${e.error === 'network' ? '（内置识别需访问 Google 服务，国内网络可能不通，建议改用手动粘贴或云端 ASR）' : ''}`);
    };
    rec.onend = () => {
      this._maybePush(true);
      if (this.running) setTimeout(() => { try { rec.start(); } catch (_) {} }, 400);
    };

    try { rec.start(); } catch (e) { this.onError?.('无法启动麦克风：' + e.message); return false; }
    this.rec = rec;
    this.running = true;
    this.onState?.(true);
    return true;
  }

  _maybePush(force = false) {
    const now = Date.now();
    if (force || this.buf.length >= 50 || (this.buf && now - this.lastPush >= 10000)) {
      const text = this.buf.trim();
      if (text) { this.onFinal?.(text); this.buf = ''; this.lastPush = now; }
    }
  }

  stop() {
    this.running = false;
    clearTimeout(this.pushTimer);
    this._maybePush(true);
    try { this.rec?.stop(); } catch (_) {}
    this.onState?.(false);
  }
}

const mic = new MicRecognizer({
  onFinal: (text) => pushText(text),
  onInterim: (text) => renderInterim(text),
  onError: (m) => { toast(m, 4000); stopAll(); },
  onState: () => {},
});

/* ============ 转写推送 ============ */
const fmtPos = (ms) => {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
};

async function pushText(text) {
  const t = String(text || '').trim();
  if (!t) return;
  await send({ action: 'vt:segment', text: t });
  appendSeg(t);
}

/** posMs 有值时显示视频位置时间戳（字幕/云端通道带回）；麦克风/手动通道没有位置 */
function appendSeg(text, posMs) {
  state.charTotal += text.length;
  $('#charCount').textContent = `${state.charTotal} 字`;
  const box = $('#transcript');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const d = document.createElement('div');
  d.className = 'seg';
  if (posMs != null) {
    const t = document.createElement('span');
    t.className = 'ts';
    t.textContent = fmtPos(posMs);
    d.appendChild(t);
  }
  d.appendChild(document.createTextNode(text));
  box.appendChild(d);
  const i = box.querySelector('.interim');
  if (i) box.insertBefore(d, i);
  box.scrollTop = box.scrollHeight;
}

function renderInterim(text) {
  const box = $('#transcript');
  let i = box.querySelector('.interim');
  if (!i) { i = document.createElement('div'); i.className = 'interim'; box.appendChild(i); }
  i.textContent = text || '';
  box.scrollTop = box.scrollHeight;
}

/* ============ 采集源控制 ============ */
async function startCapture() {
  const mode = $('#srcMode').value;
  if (mode === 'manual') { $('#manualRow').style.display = 'block'; return; }
  $('#manualRow').style.display = 'none';

  if (mode === 'cloud') {
    await send({ action: 'vt:start-cloud' });
    toast('开始捕获页面音频，云端转写中…');
    return;
  }
  if (mode === 'auto') {
    const ok = await probeSubtitle();
    if (ok) { toast('已接管页面字幕流'); return; }
  }
  if (!mic.start(state.cfg?.asrLang || 'zh-CN')) return;
  toast('麦克风已开启，助教开始听课');
}

function stopAll() {
  mic.stop();
  send({ action: 'vt:stop-cloud' }).catch(() => {});
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs?.[0]?.id;
    if (id) chrome.tabs.sendMessage(id, { action: 'vt:stop-subtitle' }).catch(() => {});
  });
}

async function probeSubtitle() {
  const tab = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => r(t?.[0])));
  if (!tab?.id) return false;
  const res = await new Promise((r) => {
    chrome.tabs.sendMessage(tab.id, { action: 'vt:start-subtitle' }, (v) => r(v));
  }).catch(() => null);
  return !!(res && res.active);
}

/* ============ 渲染 ============ */
function renderState(snap) {
  if (!snap) return;
  state.snap = snap;
  const b = $('#stateBadge');
  b.textContent = STATE_TEXT[snap.state] || snap.state;
  b.className = 'badge ' + (snap.state === 'idle' ? '' : snap.state);
  $('#topicLine').textContent = snap.topic
    ? `${snap.topic} · ${snap.usingLLM ? '大模型提炼' : '本地引擎'}`
    : (snap.usingLLM ? '大模型提炼已就绪' : '未配置 API Key · 本地引擎兜底');
  $('#noteCount').textContent = `${snap.notes.length} 条`;
  renderNotes(snap);
  if (snap.graph) renderGraph(snap.graph);
}

function renderNotes(snap) {
  const box = $('#notes');
  if (!snap.notes.length) {
    box.innerHTML = '<div class="empty">开始听课后，知识点会自动出现在这里</div>';
    return;
  }
  const byId = new Map(snap.notes.map((n) => [n.id, n]));
  let html = '';
  snap.sections.forEach((sec, idx) => {
    const notes = sec.noteIds.map((id) => byId.get(id)).filter(Boolean);
    if (!notes.length && !sec.summary) return;
    html += `<div class="sec"><div class="sec-hd">第 ${idx + 1} 节　${esc(sec.title || '')}</div>`;
    if (sec.summary) html += `<div class="sec-sum">${esc(sec.summary)}</div>`;
    notes.forEach((n) => { html += noteHtml(n); });
    html += '</div>';
  });
  const sectioned = new Set(snap.sections.flatMap((s) => s.noteIds));
  const rest = snap.notes.filter((n) => !sectioned.has(n.id));
  if (rest.length) {
    html += `<div class="sec"><div class="sec-hd">当前小节（未小结）</div>`;
    rest.forEach((n) => { html += noteHtml(n); });
    html += '</div>';
  }
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

function noteHtml(n) {
  const kws = (n.keywords || []).map((k) => `<span>${esc(k)}</span>`).join('');
  return `<div class="note">
    <div class="nt"><span class="tag ${esc(n.tag)}">${esc(n.tag)}</span><span class="nb"><b>${esc(n.title)}</b> — ${esc(n.body)}</span></div>
    ${kws ? `<div class="nk">${kws}</div>` : ''}
  </div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let currentMmd = '';
async function renderGraph(graph) {
  $('#graphPanel').style.display = 'block';
  currentMmd = graph.mermaid || '';
  const box = $('#graph');
  const chips = (graph.topics || []).slice(0, 60)
    .map((t) => `<span class="chip" data-topic="${esc(t)}">${esc(t)}</span>`).join('');
  $('#topics').innerHTML = chips;
  $('#topics').querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => openTopic(c.dataset.topic));
  });

  const mmd = window.mermaid;
  if (!mmd) {
    box.innerHTML = `<div class="mmd">${esc(currentMmd)}</div>`;
    return;
  }
  try {
    mmd.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose', mindmap: { padding: 12 } });
    const { svg } = await mmd.render('vtg' + Date.now(), currentMmd);
    box.innerHTML = svg;
    box.querySelectorAll('g').forEach((g) => {
      g.style.cursor = 'pointer';
      g.addEventListener('click', () => {
        const t = g.textContent?.trim();
        if (t && t.length <= 20) openTopic(t);
      });
    });
  } catch (e) {
    box.innerHTML = `<div class="mmd">${esc(currentMmd)}</div>`;
  }
}

async function openTopic(topic) {
  openModal(`知识点：${topic}`, '<div class="empty">正在展开…</div>');
  const r = await send({ action: 'vt:query', topic });
  const d = r?.data;
  if (!d) { $('#modalBody').innerHTML = '<div class="empty">未找到该知识点</div>'; return; }
  $('#modalBody').innerHTML = `
    <h4>定义</h4><p>${esc(d.definition || '—')}</p>
    <h4>例子</h4><p>${esc(d.example || '—')}</p>
    <h4>考点</h4><p>${esc(d.examPoints || '—')}</p>
    <h4>关联知识点</h4><p>${(d.related || []).map(esc).join('、') || '—'}</p>`;
}

function openModal(title, bodyHtml) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#mask').style.display = 'flex';
}
function closeModal() { $('#mask').style.display = 'none'; }

/* ============ 事件绑定 ============ */
$('#btnStart').addEventListener('click', async () => {
  const tab = await new Promise((r) => chrome.tabs.query({ active: true, currentWindow: true }, (t) => r(t?.[0])));
  const topic = (tab?.title || '').replace(/\s*[-_|｜]\s*[^|-]*$/, '').slice(0, 40);
  const r = await send({ action: 'vt:start', meta: { topic, url: tab?.url } });
  if (r?.ok) {
    await startCapture();
    state.charTotal = 0;
    $('#transcript').innerHTML = '<div class="empty">等待课程音频…</div>';
    renderState(r.data);
  }
});

$('#btnPause').addEventListener('click', async () => {
  stopAll();
  const r = await send({ action: 'vt:command', cmd: 'pause' });
  if (r?.ok) { renderState(r.data); toast('已暂停，本小节小结已生成'); }
});

$('#btnEnd').addEventListener('click', async () => {
  stopAll();
  toast('正在生成总笔记与知识图谱…', 6000);
  const r = await send({ action: 'vt:command', cmd: 'end' });
  if (r?.ok) { renderState(r.data); toast('课程结束，图谱已生成'); }
});

$('#btnSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('#srcMode').addEventListener('change', async () => {
  $('#manualRow').style.display = $('#srcMode').value === 'manual' ? 'block' : 'none';
});

$('#btnPush').addEventListener('click', async () => {
  const v = $('#manualInput').value;
  if (!v.trim()) return;
  await pushSegments(v);
  $('#manualInput').value = '';
});

$('#btnPushFile').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  await pushSegments(text);
});

/** 把长文本切成小段，模拟流式推送 */
async function pushSegments(text) {
  const clean = String(text)
    .replace(/^\d+\s*$/gm, '')
    .replace(/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const parts = clean.match(/[^。！？；\n]{0,120}[。！？；]?/g)?.filter((s) => s.trim()) || [clean];
  for (let i = 0; i < parts.length; i++) {
    await pushText(parts[i]);
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 60));
  }
  toast(`已推送 ${parts.length} 段文本`);
}

$('#btnExport').addEventListener('click', async () => {
  const r = await send({ action: 'vt:export' });
  if (!r?.markdown) return toast('暂无可导出内容');
  const name = `课程笔记_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  const url = URL.createObjectURL(new Blob([r.markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已导出 ' + name);
});

$('#btnCopyMmd').addEventListener('click', async () => {
  if (!currentMmd) return;
  await navigator.clipboard.writeText(currentMmd).catch(() => {});
  toast('Mermaid 源码已复制');
});

$('#btnHistory').addEventListener('click', async () => {
  const r = await send({ action: 'vt:history' });
  const list = r?.data || [];
  if (!list.length) return openModal('历史课程', '<div class="empty">还没有保存的课程</div>');
  openModal('历史课程', list.map((c) => `
    <div class="hist-item">
      <div>
        <div class="ht">${esc(c.title)}</div>
        <div class="hm">${new Date(c.createdAt).toLocaleString()} · ${c.stats?.notes || 0} 条笔记</div>
      </div>
      <button class="btn tiny" data-id="${c.id}">查看</button>
    </div>`).join(''));
  $('#modalBody').querySelectorAll('button[data-id]').forEach((b) => {
    b.addEventListener('click', async () => {
      const rr = await send({ action: 'vt:history-open', id: b.dataset.id });
      const c = rr?.data;
      if (!c) return;
      const url = URL.createObjectURL(new Blob([c.markdown], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = `${c.title}.md`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    });
  });
});

$('#btnClear').addEventListener('click', async () => {
  stopAll();
  await send({ action: 'vt:clear' });
  state.charTotal = 0;
  $('#transcript').innerHTML = '<div class="empty">等待课程音频…</div>';
  $('#graphPanel').style.display = 'none';
  const r = await send({ action: 'vt:get-state' });
  renderState(r.data);
  toast('已清空');
});

$('#modalClose').addEventListener('click', closeModal);
$('#mask').addEventListener('click', (e) => { if (e.target === $('#mask')) closeModal(); });

/* ============ 订阅广播 ============ */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action !== 'vt:broadcast') return;
  const p = msg.payload;
  switch (msg.type) {
    case 'state': renderState(p); break;
    /* 字幕 / 云端通道的转写段由助教核心经广播推来——以前没接这个分支，
     * 侧边栏转写框永远停在「等待课程音频…」，用户以为按钮没反应。 */
    case 'transcript': appendSeg(p.text, p.tStart); break;
    case 'notes':
    case 'section':
    case 'graph':
    case 'ended':
      send({ action: 'vt:get-state' }).then((r) => { if (r?.ok) renderState(r.data); });
      break;
    case 'error': toast('⚠ ' + p.message, 5000); break;
    case 'log': toast(p.text, 2500); break;
    case 'config': state.cfg = p; break;
    default: break;
  }
});

/* ============ 启动 ============ */
(async function init() {
  const r = await send({ action: 'vt:get-state' });
  state.cfg = r.config;
  renderState(r.data);
  if (state.cfg?.asrMode) $('#srcMode').value = state.cfg.asrMode;
  $('#manualRow').style.display = state.cfg?.asrMode === 'manual' ? 'block' : 'none';
})();
