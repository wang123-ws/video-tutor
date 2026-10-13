#!/usr/bin/env node
/**
 * 把平台无关的助教核心（extension/src/core）同步到桌面端渲染进程。
 * 不复制 config.local.js —— 桌面端的配置走设置页 + localStorage，避免密钥被打进安装包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension', 'src', 'core');
const dst = path.join(root, 'desktop', 'src', 'renderer', 'core');

fs.mkdirSync(dst, { recursive: true });
let n = 0;
for (const f of fs.readdirSync(src)) {
  if (!f.endsWith('.js')) continue;
  if (f === 'config.local.js') continue;   // 私有密钥文件，不外带
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  n++;
}
console.log(`core synced: ${n} files → desktop/src/renderer/core`);
