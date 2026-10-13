/**
 * Offscreen 文档：捕获标签页音频 → 分段编码为 16kHz 单声道 WAV → 回传后台做云端转写。
 * （Web Speech 通道不需要本文件，它在侧边栏中直接运行）
 */

let ctx = null;
let source = null;
let processor = null;
let stream = null;
let buffers = [];
let frames = 0;
let posMs = 0;          // 已捕获音频的总时长（毫秒）——分片带上起始位置，转写框按视频位置显示
let timer = null;
let chunkSeconds = 20;

function encodeWav(floatChunks, sampleRate) {
  const total = floatChunks.reduce((s, c) => s + c.length, 0);
  const out = new ArrayBuffer(44 + total * 2);
  const view = new DataView(out);
  const w = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  w(0, 'RIFF');
  view.setUint32(4, 36 + total * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, 1, true);       // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, total * 2, true);
  let off = 44;
  for (const chunk of floatChunks) {
    for (let i = 0; i < chunk.length; i++) {
      let s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(out);
}

function toBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

function flush() {
  if (!frames) return;
  const pcm = encodeWav(buffers, ctx.sampleRate);
  const startPos = Math.max(0, posMs - (frames / ctx.sampleRate) * 1000);
  buffers = [];
  frames = 0;
  chrome.runtime.sendMessage({ action: 'vt:asr-chunk', data: toBase64(pcm), posMs: startPos }).catch(() => {});
}

async function start({ streamId, chunkSeconds: cs }) {
  stop();
  chunkSeconds = cs || 20;
  posMs = 0;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
      video: false,
    });
  } catch (e) {
    chrome.runtime.sendMessage({
      action: 'vt:broadcast', type: 'error',
      payload: { message: `无法捕获页面音频：${e.message}` },
    }).catch(() => {});
    return;
  }
  ctx = new AudioContext({ sampleRate: 16000 });
  source = ctx.createMediaStreamSource(stream);
  processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (e) => {
    const ch = e.inputBuffer.getChannelData(0);
    buffers.push(new Float32Array(ch));
    frames += ch.length;
    posMs += (ch.length / ctx.sampleRate) * 1000;
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  timer = setInterval(flush, chunkSeconds * 1000);
}

function stop() {
  clearInterval(timer);
  timer = null;
  try { processor && processor.disconnect(); } catch (_) {}
  try { source && source.disconnect(); } catch (_) {}
  try { ctx && ctx.close(); } catch (_) {}
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  if (frames) flush();
  processor = source = ctx = stream = null;
  buffers = [];
  frames = 0;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === 'vt:offscreen-start') start(msg);
  else if (msg?.action === 'vt:offscreen-stop') stop();
});
