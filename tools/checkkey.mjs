#!/usr/bin/env node
/**
 * API Key / 服务商连通性诊断工具。
 *
 * 用法：
 *   node tools/checkkey.mjs                      # 用 config.local.js 里的配置测
 *   node tools/checkkey.mjs --key ms-xxx         # 只给 Key，自动识别服务商
 *   node tools/checkkey.mjs --provider modelscope --key ms-xxx
 *   node tools/checkkey.mjs --list               # 列出该服务商支持的模型
 */

import { PROVIDER_PRESETS, DEFAULT_CONFIG } from '../extension/src/core/config.js';
import { LLMClient, explainError } from '../extension/src/core/llm.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const has = (n) => argv.includes('--' + n);

/** 按 Key 前缀猜服务商 */
function guessProvider(key) {
  if (/^ms-/.test(key)) return 'modelscope';
  if (/^sk-/.test(key)) return 'siliconflow';
  if (/^sk-or-v1-/.test(key)) return 'openrouter';
  if (/^[0-9a-f]{32}\./.test(key)) return 'zhipu';
  return null;
}

let cfg;
try {
  cfg = { ...DEFAULT_CONFIG, ...(await import('../extension/src/core/config.local.js')).LOCAL_CONFIG };
} catch {
  cfg = { ...DEFAULT_CONFIG };
}

const key = arg('key');
const providerKey = arg('provider') || (key ? guessProvider(key) : null);

if (providerKey && PROVIDER_PRESETS[providerKey]) {
  const p = PROVIDER_PRESETS[providerKey];
  cfg = { ...cfg, provider: providerKey, apiBase: p.apiBase, chatModel: p.chatModel };
}
if (key) cfg.apiKey = key;

console.log('服务商   :', cfg.provider);
console.log('Base URL :', cfg.apiBase);
console.log('Key      :', cfg.apiKey ? cfg.apiKey.slice(0, 6) + '…' + cfg.apiKey.slice(-4) : '(未设置)');
console.log('模型     :', cfg.chatModel);
console.log('');

if (!cfg.apiKey) {
  console.log('✗ 未设置 API Key。用 --key 传入，或在 extension/src/core/config.local.js 中填写。');
  process.exit(1);
}

const client = new LLMClient(cfg);

if (has('list')) {
  try {
    const res = await fetch(String(cfg.apiBase).replace(/\/+$/, '') + '/models', {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    });
    const data = await res.json();
    const ids = (data?.data || []).map((m) => m.id || m.name).filter(Boolean);
    console.log(`✓ 可用模型 ${ids.length} 个：`);
    ids.forEach((i) => console.log('   ', i));
  } catch (e) {
    console.log('✗ 列出模型失败：', e.message);
  }
  process.exit(0);
}

try {
  const t0 = Date.now();
  const r = await client.chat([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 16 });
  console.log(`✓ 调用成功（${Date.now() - t0}ms）：`, r.text.slice(0, 60));
  console.log('\n可以正常使用。在扩展设置页确认服务商已切到「' + cfg.provider + '」即可。');
} catch (e) {
  const exp = explainError(e.raw || e.message);
  console.log('✗ 调用失败 [' + exp.code + ']');
  console.log('  原因：', exp.text);
  if (e.raw) console.log('  原始：', e.raw.slice(0, 240));
  process.exit(2);
}
