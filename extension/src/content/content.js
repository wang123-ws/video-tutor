/**
 * 页面端捕获助手入口：检测视频 → 悬浮「陪学」按钮 → 唤起侧边栏开始陪学。
 * 只负责触发与状态显示，不处理音频（音频由侧边栏 / offscreen 处理）。
 */
(() => {
  if (window.__vtInjected) return;
  window.__vtInjected = true;

  const BTN_ID = 'vt-fab-btn';
  let active = false;

  function toast(text, ms = 1800) {
    const el = document.createElement('div');
    el.className = 'vt-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function hasVideo() {
    return !!document.querySelector('video');
  }

  function makeButton() {
    if (document.getElementById(BTN_ID)) return document.getElementById(BTN_ID);
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'vt-fab';
    btn.innerHTML = '<span class="vt-dot" style="display:none"></span><span class="vt-label">陪学</span>';
    btn.title = '视频陪学 AI 助教：开始听这节课';
    btn.addEventListener('click', onToggle);
    document.body.appendChild(btn);
    return btn;
  }

  function render() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.classList.toggle('vt-active', active);
    btn.querySelector('.vt-dot').style.display = active ? 'block' : 'none';
    btn.querySelector('.vt-label').textContent = active ? '陪学中' : '陪学';
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(r));
      } catch (_) { resolve(null); }
    });
  }

  async function onToggle() {
    if (!active) {
      const topic = (document.title || '').replace(/\s*[-_|].*$/, '').slice(0, 40);
      await send({ action: 'vt:start', meta: { topic, url: location.href } });
      active = true;
      toast('助教开始听课，请在侧边栏查看笔记');
    } else {
      await send({ action: 'vt:command', cmd: 'pause' });
      active = false;
      toast('已暂停，本小节小结已生成');
    }
    render();
    try { await chrome.runtime.sendMessage({ action: 'vt:open-panel' }); } catch (_) {}
  }

  /* ---------- 字幕捕获通道（零成本、准确，优先于语音识别） ---------- */
  let subTrack = null;
  let subHandler = null;
  let subBuf = '';
  let subLastCue = '';
  let subLastPos = null;      // 当前缓冲对应的视频位置（毫秒），随段落一起推给助教
  let subTimer = null;

  function flushSub(force) {
    const t = subBuf.trim();
    if (force || t.length >= 40) {
      if (t) {
        chrome.runtime.sendMessage({ action: 'vt:segment', text: t, tStart: subLastPos, tEnd: subLastPos }).catch(() => {});
        subBuf = '';
        subLastPos = null;
      }
    }
  }

  function startSubtitle() {
    stopSubtitle(false);
    const v = document.querySelector('video');
    if (!v || !v.textTracks) return false;
    const list = Array.from(v.textTracks);
    let track = list.find((t) => t.mode !== 'disabled' && t.cues && t.cues.length);
    if (!track) {
      track = list.find((t) => t.cues && t.cues.length);
      if (track) { try { track.mode = 'hidden'; } catch (_) {} }
    }
    if (!track) return false;
    subTrack = track;
    subHandler = () => {
      const cues = Array.from(subTrack.activeCues || []);
      const text = cues.map((c) => c.text).join(' ');
      if (text && text !== subLastCue) {
        subLastCue = text;
        subBuf += (subBuf ? ' ' : '') + text.replace(/<[^>]+>/g, '');
        if (cues[0] && cues[0].startTime != null) subLastPos = cues[0].startTime * 1000;
        flushSub(false);
      }
    };
    subTrack.addEventListener('cuechange', subHandler);
    subTimer = setInterval(() => flushSub(true), 8000);
    return true;
  }

  function stopSubtitle(notify = true) {
    if (subTrack && subHandler) subTrack.removeEventListener('cuechange', subHandler);
    clearInterval(subTimer);
    flushSub(true);
    subTrack = subHandler = null; subBuf = ''; subLastCue = ''; subLastPos = null;
    if (notify) return true;
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg?.action === 'vt:start-subtitle') respond({ active: startSubtitle() });
    else if (msg?.action === 'vt:stop-subtitle') respond({ ok: stopSubtitle() });
    else if (msg?.action === 'vt:probe-video') respond({ hasVideo: hasVideo(), title: document.title });
    return true;
  });

  // 视频出现后再显示按钮
  const boot = () => {
    if (!hasVideo()) return false;
    makeButton();
    render();
    return true;
  };
  if (!boot()) {
    const ob = new MutationObserver(() => { if (boot()) ob.disconnect(); });
    ob.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => ob.disconnect(), 30000);
  }
})();
