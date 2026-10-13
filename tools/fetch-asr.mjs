#!/usr/bin/env node
/**
 * 下载并装配本地离线语音引擎（sherpa-onnx + SenseVoice 中文模型）。
 * 装好后桌面端可以完全离线转写：不联网、不花钱、无额度限制。
 *
 *   node tools/fetch-asr.mjs
 *
 * 产出：
 *   desktop/resources/asr/sensevoice/model.int8.onnx   （约 226 MB）
 *   desktop/resources/asr/sensevoice/tokens.txt
 *   desktop/resources/asr/sherpa-onnx-<版本>/bin/sherpa-onnx-offline.exe
 * 注意：注释里不要出现「星号斜杠」，会把块注释提前闭合，整个脚本语法崩掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASR = path.join(root, 'desktop', 'resources', 'asr');
fs.mkdirSync(ASR, { recursive: true });

const RUNTIME_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-no-tts.tar.bz2';
// 国内镜像：GitHub Release 直连经常断，hf-mirror 稳定
const MODEL_BASE = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main';

const has = (p) => fs.existsSync(p);

function curl(url, out, label) {
  console.log(`下载 ${label} …`);
  for (let i = 1; i <= 6; i++) {
    try {
      execFileSync('curl', ['-sL', '-C', '-', '--retry', '3', '--retry-all-errors', '-m', '900', '-o', out, url], { stdio: 'pipe' });
    } catch (_) { /* 继续重试 */ }
    if (has(out) && fs.statSync(out).size > 0) {
      const size = fs.statSync(out).size;
      console.log(`  ${label} 当前 ${(size / 1048576).toFixed(1)} MB`);
      if (size > (label.includes('模型') ? 100 : 5) * 1048576) return true;
    }
    console.log(`  第 ${i} 次未完整，重试`);
  }
  return false;
}

/* ---------- 1. 运行库 ---------- */
const rtTar = path.join(ASR, 'runtime.tar.bz2');
let rtDir = fs.readdirSync(ASR).find((d) => d.startsWith('sherpa-onnx-') && fs.statSync(path.join(ASR, d)).isDirectory());

if (!rtDir) {
  if (!has(rtTar) && !curl(RUNTIME_URL, rtTar, '运行库')) {
    console.error('运行库下载失败，可手动下载放到：' + rtTar);
    process.exit(1);
  }
  console.log('解压运行库…');
  execFileSync('tar', ['-xjf', rtTar, '-C', ASR], { stdio: 'pipe' });
  rtDir = fs.readdirSync(ASR).find((d) => d.startsWith('sherpa-onnx-'));
}
console.log('运行库：', path.join(ASR, rtDir, 'bin'));

/* ---------- 2. 模型 ---------- */
const modelDir = path.join(ASR, 'sensevoice');
fs.mkdirSync(modelDir, { recursive: true });
const modelFile = path.join(modelDir, 'model.int8.onnx');
const tokens = path.join(modelDir, 'tokens.txt');

if (!has(tokens)) {
  execFileSync('curl', ['-sL', '-m', '120', '-o', tokens, `${MODEL_BASE}/tokens.txt`], { stdio: 'pipe' });
}
if (!has(modelFile) || fs.statSync(modelFile).size < 100 * 1024 * 1024) {
  if (!curl(`${MODEL_BASE}/model.int8.onnx`, modelFile, '中文模型')) {
    console.error('模型下载失败。备选：手动从 https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09 下载 model.int8.onnx 放到 ' + modelDir);
    process.exit(1);
  }
}

/* ---------- 3. 自检 ---------- */
const exe = path.join(ASR, rtDir, 'bin', 'sherpa-onnx-offline.exe');
if (!has(exe)) { console.error('未找到 sherpa-onnx-offline.exe'); process.exit(1); }

const tmp = path.join(os.tmpdir(), 'vt-asr-selftest.wav');
const sr = 16000, dur = 1;
const n = sr * dur;
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8, 'ascii');
buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36, 'ascii');
buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / sr)), 44 + i * 2);
fs.writeFileSync(tmp, buf);

const t0 = Date.now();
const out = execFileSync(exe, [
  `--sense-voice-model=${modelFile}`,
  `--tokens=${tokens}`,
  '--sense-voice-language=zh',
  '--sense-voice-use-itn=true',
  '--num-threads=4',
  tmp,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: path.dirname(exe) });
fs.unlink(tmp, () => {});

const line = out.trim().split('\n').filter(Boolean).pop();
let ok = false;
try { ok = typeof JSON.parse(line).text === 'string'; } catch (_) {}

console.log('');
console.log(ok
  ? `✓ 本地语音引擎就绪（自检耗时 ${Date.now() - t0} ms）`
  : '✗ 自检未通过，引擎可能不完整');
console.log('  模型：' + modelFile);
console.log('  引擎：' + exe);
