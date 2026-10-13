/**
 * 生成自动更新用的清单 latest.json。
 *
 * 用法：
 *   node tools/make-latest.mjs
 *   node tools/make-latest.mjs --notes "修了悬浮条不自动弹出；新增自动更新"
 *   node tools/make-latest.mjs --base https://myserver.com/dl   # 自定义下载根地址
 *
 * 产物：
 *   latest.json              （仓库根目录，推到 GitHub 后由 jsDelivr / raw 分发）
 *   desktop/dist/latest.json （便于一起上传）
 *
 * 客户端逻辑：拉清单 → 比版本 → 下载 url → 校验 sha512 → 调安装包 /S 覆盖安装。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(root, 'desktop', 'dist');

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'package.json'), 'utf8'));
const version = opt('version', pkg.version);

/* 找安装包：优先指定版本，其次目录里最新的 Setup exe */
function findInstaller() {
  const given = opt('file');
  if (given && fs.existsSync(given)) return given;
  if (!fs.existsSync(dist)) return null;
  const files = fs.readdirSync(dist)
    .filter((f) => /\.exe$/.test(f) && /Setup/i.test(f))
    .map((f) => ({ f, m: fs.statSync(path.join(dist, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const exact = files.find((x) => x.f.includes(version));
  const picked = exact || files[0];
  return picked ? path.join(dist, picked.f) : null;
}

const exe = findInstaller();
if (!exe) {
  console.error('没找到安装包。先跑一次：cd desktop && npm run dist');
  process.exit(1);
}

const name = opt('name') || path.basename(exe);
const size = fs.statSync(exe).size;
const sha512 = crypto.createHash('sha512').update(fs.readFileSync(exe)).digest('hex');

/* 下载地址：默认用 GitHub Release 的永久最新链接（releases/latest/download/），
 * 这样以后发新版不用改客户端，只要把同名的安装包传上去即可。
 * --base 可以换成任意静态目录地址。 */
const cfg = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'desktop', 'update.json'), 'utf8')); }
  catch (_) { return {}; }
})();
const base = opt('base') || (cfg.downloadBase
  || (cfg.owner && cfg.repo
    ? `https://github.com/${cfg.owner}/${cfg.repo}/releases/latest/download`
    : `https://github.com/__OWNER__/__REPO__/releases/latest/download`));
const url = `${base.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;

const notes = opt('notes', '修复已知问题，提升稳定性');

const manifest = {
  version,
  notes,
  pubDate: new Date().toISOString().slice(0, 10),
  url,
  size,
  sha512,
  fileName: name,
};

const out1 = path.join(root, 'latest.json');
const out2 = path.join(dist, 'latest.json');
fs.writeFileSync(out1, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
fs.mkdirSync(dist, { recursive: true });
fs.writeFileSync(out2, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log('已生成更新清单：');
console.log('  ' + out1);
console.log('  ' + out2);
console.log(JSON.stringify(manifest, null, 2));
console.log('\n发布步骤：');
console.log('  1) 把安装包和 latest.json 一起传到 GitHub Release（tag 用 v' + version + '）');
console.log('  2) 把仓库里的 latest.json 提交并推送到 main 分支（客户端默认从这个文件读）');
