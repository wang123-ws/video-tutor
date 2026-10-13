import { DEFAULT_CONFIG, PROVIDER_PRESETS } from '../core/config.js';

const $ = (s) => document.querySelector(s);
const FIELDS = [
  'provider', 'apiBase', 'apiKey', 'chatModel', 'chatModelFallback', 'temperature', 'maxTokens',
  'asrMode', 'asrModel', 'asrLang', 'chunkSeconds',
  'extractChars', 'extractIntervalMs', 'dedupThreshold', 'graphStyle',
];

function send(msg) {
  return new Promise((r) => chrome.runtime.sendMessage(msg, (v) => r(v || {})));
}

function fill(cfg) {
  FIELDS.forEach((k) => { if ($('#' + k)) $('#' + k).value = cfg[k] ?? ''; });
  $('#enableThinking').checked = cfg.enableThinking === false;
  $('#saveHistory').checked = !!cfg.saveHistory;
}

function collect() {
  const patch = {};
  FIELDS.forEach((k) => {
    const el = $('#' + k);
    if (!el) return;
    patch[k] = (el.type === 'number') ? Number(el.value) : el.value.trim();
  });
  patch.enableThinking = !$('#enableThinking').checked ? false : true;
  patch.saveHistory = $('#saveHistory').checked;
  return patch;
}

$('#btnSave').addEventListener('click', async () => {
  const r = await send({ action: 'vt:save-config', patch: collect() });
  const el = $('#saveResult');
  if (r?.ok) { el.textContent = '已保存'; el.className = 'res'; }
  else { el.textContent = '保存失败：' + (r.error || '未知错误'); el.className = 'res err'; }
});

$('#btnReset').addEventListener('click', async () => {
  const r = await send({ action: 'vt:save-config', patch: { ...DEFAULT_CONFIG } });
  if (r?.ok) fill(r.config);
  $('#saveResult').textContent = '已恢复默认';
});

$('#btnTest').addEventListener('click', async () => {
  const el = $('#testResult');
  el.textContent = '测试中…'; el.className = 'res';
  await send({ action: 'vt:save-config', patch: collect() });
  const r = await send({ action: 'vt:test-connection' });
  if (r?.ok) { el.textContent = '连接成功：' + r.text.slice(0, 30); el.className = 'res'; }
  else { el.textContent = '失败：' + (r.error || '未知错误'); el.className = 'res err'; }
});

/* ---------- 服务商预设 ---------- */
const sel = $('#provider');
Object.entries(PROVIDER_PRESETS).forEach(([k, v]) => {
  const o = document.createElement('option');
  o.value = k; o.textContent = v.label;
  sel.appendChild(o);
});

function applyPreset(key, fillKey = false) {
  const p = PROVIDER_PRESETS[key];
  if (!p) return;
  if (p.apiBase) $('#apiBase').value = p.apiBase;
  if (p.chatModel) $('#chatModel').value = p.chatModel;
  if (p.chatModelFallback) $('#chatModelFallback').value = p.chatModelFallback;
  $('#asrModel').value = p.asrModel || '';
  if (fillKey) $('#apiKey').value = '';
  $('#providerNote').innerHTML = p.note || '';
  $('#provider').value = key;
}

sel.addEventListener('change', () => {
  applyPreset(sel.value, true);
  $('#testResult').textContent = '已套用预设，请填写该服务商的 API Key';
});

$('#btnGrant').addEventListener('click', async () => {
  const el = $('#testResult');
  try {
    const u = new URL($('#apiBase').value.trim());
    const origin = u.origin + '/*';
    const ok = await chrome.permissions.request({ origins: [origin] });
    el.textContent = ok ? `已授权 ${origin}` : '未授权（扩展将无法访问该域名）';
    el.className = 'res' + (ok ? '' : ' err');
  } catch (e) {
    el.textContent = '地址不合法：' + e.message;
    el.className = 'res err';
  }
});

(async () => {
  const r = await send({ action: 'vt:get-config' });
  const cfg = r.config || DEFAULT_CONFIG;
  fill(cfg);
  const key = cfg.provider && PROVIDER_PRESETS[cfg.provider] ? cfg.provider : 'custom';
  applyPreset(key);
  $('#provider').value = key;
})();
