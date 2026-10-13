/**
 * 后台编排：会话调度、转写通道管理、消息路由、课程存档。
 * 助教核心逻辑全部在 core/tutor.js，本文件只做“管道”。
 */

import { loadConfig, saveConfig } from '../core/config.js';
import { Tutor } from '../core/tutor.js';
import { LLMClient } from '../core/llm.js';
import { CMD } from '../core/protocol.js';

let cfg = await loadConfig();
let llm = new LLMClient(cfg);

const emitter = {
  emit(type, payload) {
    broadcast({ type, payload });
  },
};

let tutor = new Tutor(cfg, emitter);
let offscreenReady = false;
let cloudSession = { active: false, tabId: null };

/* ---------------- 广播 ---------------- */
function broadcast(msg) {
  chrome.runtime.sendMessage({ action: 'vt:broadcast', ...msg }).catch(() => {});
}

/* ---------------- 会话调度 ---------------- */

function broadcastState() {
  broadcast({ type: 'state', payload: tutor.snapshot() });
}

function startSession(meta = {}) {
  const snap = tutor.start(meta);
  if (cfg.asrMode === 'cloud') startCloudCapture(meta.tabId);
  return snap;
}

/* ---------------- 云端 ASR 通道：捕获标签页音频 ---------------- */

async function ensureOffscreen() {
  if (offscreenReady) return;
  const existing = await chrome.offscreen.hasDocument?.().catch(() => false);
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('src/offscreen/offscreen.html'),
      reasons: ['AUDIO_PLAYBACK'],
      justification: '捕获当前标签页视频音频并分段编码，用于课程语音转写',
    });
  }
  offscreenReady = true;
}

async function startCloudCapture(tabId) {
  try {
    const tab = tabId || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (!tab) throw new Error('未找到活动标签页');
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab });
    cloudSession = { active: true, tabId: tab };
    chrome.runtime.sendMessage({
      action: 'vt:offscreen-start',
      streamId,
      chunkSeconds: cfg.chunkSeconds || 20,
    }).catch(() => {});
    broadcast({ type: 'log', payload: { level: 'info', text: '已开始捕获页面音频（云端转写）' } });
  } catch (e) {
    broadcast({ type: 'error', payload: { message: `音频捕获失败：${e.message}` } });
  }
}

function stopCloudCapture() {
  cloudSession.active = false;
  chrome.runtime.sendMessage({ action: 'vt:offscreen-stop' }).catch(() => {});
}

/* ---------------- 转写上屏 ---------------- */

async function handleAsrChunk(b64, posMs) {
  try {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    const blob = new Blob([buf], { type: 'audio/wav' });
    const text = await llm.transcribe(blob, { fileName: 'chunk.wav' });
    if (text) {
      tutor.pushSegment({ text, tStart: posMs, tEnd: posMs });
    }
  } catch (e) {
    broadcast({ type: 'error', payload: { message: `语音转写失败：${e.message}` } });
  }
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    try {
      switch (msg?.action) {
        case 'vt:get-state':
          return respond({ ok: true, data: tutor.snapshot(), config: cfg });

        case 'vt:get-config':
          return respond({ ok: true, config: cfg });

        case 'vt:save-config': {
          cfg = await saveConfig(msg.patch || {});
          llm = new LLMClient(cfg);
          tutor.setConfig(cfg);
          broadcast({ type: 'config', payload: cfg });
          return respond({ ok: true, config: cfg });
        }

        case 'vt:test-connection': {
          const r = await new LLMClient(cfg).chat(
            [{ role: 'user', content: '只回复两个字：可用' }],
            { maxTokens: 16 }
          );
          return respond({ ok: true, text: r.text });
        }

        case 'vt:start':
          return respond({ ok: true, data: startSession(msg.meta || {}) });

        case 'vt:segment':
          tutor.pushSegment({ text: msg.text, tStart: msg.tStart, tEnd: msg.tEnd });
          return respond({ ok: true });

        case 'vt:command': {
          if (msg.cmd === CMD.PAUSE) await tutor.pause();
          else if (msg.cmd === CMD.RESUME) tutor.resume();
          else if (msg.cmd === CMD.END) {
            stopCloudCapture();
            await tutor.end();
            await saveCourse();
          } else if (msg.cmd === CMD.SUMMARY_NOW) {
            await tutor.pause();
            tutor.resume(true);
          }
          broadcastState();
          return respond({ ok: true, data: tutor.snapshot() });
        }

        case 'vt:query': {
          const d = await tutor.queryTopic(msg.topic);
          return respond({ ok: true, data: d });
        }

        case 'vt:chat': {
          // 自由提问：基于当前课程上下文作答
          const ctx = tutor.transcript.slice(-12).map((t) => t.text).join('\n');
          const r = await llm.chat([
            { role: 'system', content: '你是视频陪学AI助教，基于课程转写内容回答学生问题，回答精简，不超过150字。' },
            { role: 'user', content: `课程近期内容：\n${ctx}\n\n学生问题：${msg.text}` },
          ], { maxTokens: 600 });
          return respond({ ok: true, text: r.text });
        }

        case 'vt:export':
          return respond({ ok: true, markdown: tutor.toMarkdown() });

        case 'vt:asr-chunk':
          await handleAsrChunk(msg.data, msg.posMs);
          return respond({ ok: true });

        case 'vt:start-cloud':
          await startCloudCapture(msg.tabId || sender.tab?.id);
          return respond({ ok: true });

        case 'vt:stop-cloud':
          stopCloudCapture();
          return respond({ ok: true });

        case 'vt:clear':
          stopCloudCapture();
          tutor.reset();
          broadcastState();
          return respond({ ok: true });

        case 'vt:open-panel':
          if (sender.tab?.windowId != null) {
            chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
          }
          return respond({ ok: true });

        case 'vt:history':
          return respond({ ok: true, data: await listCourses() });

        case 'vt:history-open':
          return respond({ ok: true, data: await getCourse(msg.id) });

        case 'vt:history-delete':
          return respond({ ok: true, data: await deleteCourse(msg.id) });

        default:
          return respond({ ok: false, error: '未知指令' });
      }
    } catch (e) {
      return respond({ ok: false, error: String(e.message || e) });
    }
  })();
  return true; // 保持消息通道
});

/* ---------------- 课程存档 ---------------- */

async function saveCourse() {
  if (!cfg.saveHistory) return;
  const snap = tutor.snapshot();
  if (!snap.notes.length) return;
  const rec = {
    id: snap.sessionId,
    title: snap.topic || snap.graph?.root || '未命名课程',
    createdAt: Date.now(),
    stats: snap.stats,
    markdown: tutor.toMarkdown(),
    graph: snap.graph,
    notes: snap.notes,
  };
  const obj = await chrome.storage.local.get('vt_courses');
  const list = obj.vt_courses || [];
  list.unshift(rec);
  await chrome.storage.local.set({ vt_courses: list.slice(0, 50) });
}

async function listCourses() {
  const obj = await chrome.storage.local.get('vt_courses');
  return (obj.vt_courses || []).map(({ markdown, notes, ...r }) => r);
}
async function getCourse(id) {
  const obj = await chrome.storage.local.get('vt_courses');
  return (obj.vt_courses || []).find((c) => c.id === id) || null;
}
async function deleteCourse(id) {
  const obj = await chrome.storage.local.get('vt_courses');
  const list = (obj.vt_courses || []).filter((c) => c.id !== id);
  await chrome.storage.local.set({ vt_courses: list });
  return list.map(({ markdown, notes, ...r }) => r);
}

/* ---------------- 扩展入口 ---------------- */

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (cloudSession.active && cloudSession.tabId === tabId) stopCloudCapture();
});

// 供 sidepanel 首次拉取状态
broadcastState();
