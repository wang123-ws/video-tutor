/**
 * 轻量自动更新器（不用 electron-updater）。
 *
 * 为什么自己写：
 * - electron-updater 在 Windows 上依赖代码签名才顺，且它只认 GitHub / 自建服务器的固定布局；
 *   本项目「零成本 + 国内网络」是硬约束，需要能随时换源、换镜像、换清单地址。
 * - 更新包是 NSIS 安装包，装一次就是覆盖安装：同 appId 的旧版本会被安装程序卸掉再写新的，
 *   不需要用户手动卸载，用户数据（userData/store.json）会保留。
 *
 * 流程：
 *   拉 latest.json 清单 → 比版本号 → 有新版就推公告 → 用户点更新 → 流式下载（进度/校验）
 *   → 调安装包 /S 静默安装 → 旧进程退出 → 安装完自动启动新版。
 *
 * 清单格式（发布脚本 tools/make-latest.mjs 生成）：
 * {
 *   "version": "0.3.0",
 *   "notes": "更新说明，支持 \\n 换行",
 *   "pubDate": "2026-10-12",
 *   "url": "https://github.com/<owner>/<repo>/releases/latest/download/xxx Setup 0.3.0.exe",
 *   "size": 123456,
 *   "sha512": "..."
 * }
 */
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { shell } = require('electron');

const UA = 'video-tutor-updater';

/* GitHub 直连在国内经常超时，下载时按前缀逐个试镜像。
 * 前缀直接拼在完整 URL 前面即可（ghfast / gh-proxy 这类加速服务的通用用法）。
 * 国内用户为主，ghfast 放第一位：直连失败要等满超时才切，白白多等 20 秒。 */
const MIRRORS = [
  'https://ghfast.top/',
  '',
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
];

/* ---------------- 通用 HTTP ---------------- */

function request(url, opts = {}) {
  const { timeout = 12000, headers = {} } = opts;
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http:') ? http : https;
    let req;
    try {
      req = mod.get(url, { headers: { 'User-Agent': UA, ...headers }, timeout }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).href;
          resolve(request(next, opts));
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: code, headers: res.headers, body: Buffer.concat(chunks) }));
      });
    } catch (e) { return reject(e); }
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

function decompress(buf, enc) {
  const e = String(enc || '');
  try {
    if (e.includes('gzip')) return zlib.gunzipSync(buf);
    if (e.includes('br')) return zlib.brotliDecompressSync(buf);
    if (e.includes('deflate')) return zlib.inflateSync(buf);
  } catch (_) {}
  return buf;
}

function getJson(url, timeout = 10000) {
  return request(url, {
    timeout,
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  }).then((r) => {
    if (r.status !== 200) throw new Error('HTTP ' + r.status);
    const text = decompress(r.body, r.headers['content-encoding']).toString('utf8');
    try { return JSON.parse(text); } catch (_) { throw new Error('清单不是合法 JSON'); }
  });
}

/* ---------------- 版本比较 ---------------- */

/** 只比数字段：0.10.0 > 0.9.0，忽略预发布后缀 */
function cmpVersion(a, b) {
  const norm = (v) => String(v || '0').replace(/^[vV]/, '').split(/[.\-+]/)
    .map((n) => parseInt(n, 10) || 0);
  const pa = norm(a); const pb = norm(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/* ---------------- 更新器主体 ---------------- */

class Updater {
  /**
   * @param {object} ctx { app, isDev, dbg, send, storeGet, storeSet, defaults }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.manifest = null;        // 最近一次查到的新版清单
    this.lastError = null;
    this.downloading = false;
    this.dir = path.join(ctx.app.getPath('temp'), 'vt-update');
  }

  /* ---- 配置 ---- */

  cfg() {
    const s = this.ctx.storeGet('vt_update_cfg') || {};
    return {
      autoCheck: s.autoCheck !== 'off',      // 默认开
      feedUrl: s.feedUrl || '',              // 用户自定义清单地址，优先级最高
      skipVersion: s.skipVersion || '',
    };
  }

  setCfg(patch) {
    const next = { ...this.cfg(), ...patch };
    this.ctx.storeSet('vt_update_cfg', next);
    return next;
  }

  /** 候选清单地址：自定义 > 仓库默认源（jsDelivr 加速优先，国内可直连） */
  feedCandidates() {
    const c = this.cfg();
    const d = this.ctx.defaults || {};
    const branch = d.branch || 'main';
    /* jsDelivr 对 GitHub 文件有最长 12 小时的 CDN 缓存：发了新版、客户端却还读到旧清单，
     * 公告就一直不出现。加个随机查询参数按不同 key 缓存，绕开这一层。 */
    const bust = `_=${Date.now()}`;
    const list = [];
    /* 设置页已不暴露自定义更新源；这个环境变量留给发布前自检：
     * VT_UPDATE_FEED=<latest.json 地址> 可指向本地/预发布清单做验证。 */
    const envFeed = process.env.VT_UPDATE_FEED;
    if (envFeed) list.push(envFeed + (envFeed.includes('?') ? '&' : '?') + bust);
    if (c.feedUrl) {
      list.push(c.feedUrl + (c.feedUrl.includes('?') ? '&' : '?') + bust);
    }
    if (d.owner && d.repo) {
      list.push(
        `https://cdn.jsdelivr.net/gh/${d.owner}/${d.repo}@${branch}/latest.json?${bust}`,
        `https://raw.githubusercontent.com/${d.owner}/${d.repo}/${branch}/latest.json?${bust}`,
        `https://ghfast.top/https://raw.githubusercontent.com/${d.owner}/${d.repo}/${branch}/latest.json?${bust}`,
      );
    }
    if (d.feedUrl && !list.includes(d.feedUrl)) list.push(d.feedUrl);
    return list;
  }

  configured() { return this.feedCandidates().length > 0; }

  /* ---- 检查 ---- */

  /**
   * @returns {Promise<{ok:boolean, hasUpdate?:boolean, current?:string,
   *                    latest?:object, reason?:string, error?:string}>}
   */
  async check() {
    const current = this.ctx.app.getVersion();
    const feeds = this.feedCandidates();
    if (!feeds.length) {
      return { ok: false, current, reason: 'nofeed', error: '还没有配置更新源' };
    }
    // 连点保护：5 秒内不重复查
    const now = Date.now();
    if (this._checking && now - (this._lastCheckAt || 0) < 5000) {
      return { ok: false, current, reason: 'busy', error: '刚查过，稍等一下' };
    }
    this._checking = true;
    this._lastCheckAt = now;
    try {
      let lastErr = '无法连接更新源';
      for (const url of feeds) {
        try {
          const m = await getJson(url);
          if (!m || !m.version) throw new Error('清单里没有版本号');
          this.lastError = null;
          if (cmpVersion(m.version, current) <= 0) {
            this.manifest = null;
            return { ok: true, hasUpdate: false, current, latest: m };
          }
          this.manifest = m;
          const c = this.cfg();
          if (c.skipVersion === m.version) {
            return { ok: true, hasUpdate: false, current, latest: m, reason: 'skipped' };
          }
          return { ok: true, hasUpdate: true, current, latest: m };
        } catch (e) {
          lastErr = e.message || String(e);
          this.ctx.dbg('update feed 失败 ' + url + ' → ' + lastErr);
        }
      }
      this.lastError = lastErr;
      return { ok: false, current, error: lastErr };
    } finally {
      this._checking = false;
    }
  }

  /* ---- 下载 ---- */

  async download(manifest, onProgress) {
    const m = manifest || this.manifest;
    if (!m || !m.url) throw new Error('清单里没有下载地址');
    if (this.downloading) throw new Error('正在下载中');
    this.downloading = true;
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      const name = `Setup-${String(m.version).replace(/[^\w.]/g, '_')}.exe`;
      const dest = path.join(this.dir, name);
      if (fs.existsSync(dest)) { try { fs.unlinkSync(dest); } catch (_) {} }

      const urls = MIRRORS.map((p) => p + m.url).filter((u, i, a) => a.indexOf(u) === i);
      let lastErr = '下载失败';
      for (const url of urls) {
        try {
          await this._fetch(url, dest, m, onProgress);
          if (m.sha512) {
            const ok = await this._sha512(dest) === m.sha512;
            if (!ok) { lastErr = '文件校验不一致，换下一个地址重试'; continue; }
          }
          return { ok: true, file: dest, size: fs.statSync(dest).size };
        } catch (e) {
          lastErr = e.message || String(e);
          this.ctx.dbg('update 下载失败 ' + url + ' → ' + lastErr);
        }
      }
      throw new Error(lastErr);
    } finally {
      this.downloading = false;
    }
  }

  _fetch(url, dest, m, onProgress) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('http:') ? http : https;
      let settled = false;
      const fail = (e) => {
        if (settled) return; settled = true;
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      const req = mod.get(url, { headers: { 'User-Agent': UA }, timeout: 20000 }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          settle(this._fetch(new URL(res.headers.location, url).href, dest, m, onProgress));
          return;
        }
        if (code !== 200) { res.resume(); return fail(new Error('HTTP ' + code)); }

        const total = Number(res.headers['content-length'] || m.size || 0);
        const ws = fs.createWriteStream(dest);
        let got = 0; let last = 0;
        res.on('data', (c) => {
          got += c.length;
          const now = Date.now();
          if (now - last > 150 || got === total) {
            last = now;
            if (onProgress) onProgress({ phase: 'downloading', received: got, total });
          }
        });
        res.on('error', fail);
        ws.on('error', fail);
        ws.on('finish', () => {
          if (settled) return; settled = true;
          resolve({ size: got, total });
        });
        res.pipe(ws);
      });
      req.on('timeout', () => req.destroy(new Error('下载超时')));
      req.on('error', fail);

      function settle(p) { p.then((r) => { if (!settled) { settled = true; resolve(r); } }, fail); }
    });
  }

  _sha512(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha512');
      const rs = fs.createReadStream(file);
      rs.on('data', (c) => h.update(c));
      rs.on('error', reject);
      rs.on('end', () => resolve(h.digest('hex')));
    });
  }

  /* ---- 安装 ---- */

  /**
   * 调用 NSIS 安装包静默覆盖安装，然后退出旧进程。
   * 安装程序会自动处理旧版本（同 appId 会被卸掉重写），用户数据保留。
   */
  async install(file) {
    const exe = file || path.join(this.dir, `Setup-${String((this.manifest || {}).version || '').replace(/[^\w.]/g, '_')}.exe`);
    if (!exe || !fs.existsSync(exe)) throw new Error('安装包不存在：' + exe);
    if (this.ctx.isDev) return { ok: false, dev: true, file: exe };

    /* 顺序是坑点，别改：
     * 本应用自己正在跑的时候（尤其是收在托盘里），NSIS 会检测到并一直等它关闭，
     * 安装就卡死不动了。所以不能直接 spawn 安装包，而是：
     *   1) 拉一个 detached 的 cmd，让它等 3 秒再启动安装包（/S 静默，--force-run 装完自启）
     *   2) 本进程立刻退出（调用方负责 app.quit()）
     * 3 秒足够 Electron 干净退出，安装包起来时已经没有文件占用、没有运行中的旧进程。 */
    const cmd = `timeout /t 3 /nobreak >nul & start "" "${exe}" /S --force-run`;
    try {
      const child = spawn('cmd.exe', ['/c', cmd], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.on('error', (e) => this.ctx.dbg('update 启动安装包失败：' + e.message));
      child.unref();
    } catch (e) {
      // 极端情况下（没有 cmd / 权限异常）退回系统打开，让用户手动过一遍
      const err = await shell.openPath(exe);
      if (err) throw new Error('启动安装包失败：' + (e.message || e) + '；' + err);
      return { ok: true, via: 'shell' };
    }
    return { ok: true, via: 'deferred', file: exe };
  }

  /** 打开下载目录（安装失败时给用户手动兜底） */
  openDir() {
    return shell.openPath(this.dir);
  }

  /** 清理下载目录里超过 3 天的旧安装包（每个都 250MB，不清理会把临时盘撑爆） */
  cleanup(maxAgeMs = 3 * 24 * 3600 * 1000) {
    try {
      if (!fs.existsSync(this.dir)) return;
      const now = Date.now();
      for (const f of fs.readdirSync(this.dir)) {
        const p = path.join(this.dir, f);
        try {
          if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
        } catch (_) {}
      }
    } catch (_) {}
  }
}

module.exports = { Updater, cmpVersion };
