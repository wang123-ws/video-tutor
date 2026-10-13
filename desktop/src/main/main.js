/**
 * 主进程。
 * 职责：本地静态服务（渲染进程走 http，ES module 才能加载）、窗口管理、
 *       系统音源枚举、离线语音转写调度（并发 worker 池）、IPC 路由。
 * 助教核心（知识点提炼 / 图谱）复用 extension/src/core，平台无关。
 */
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell,
        Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { Updater } = require('./updater');

const isDev = !app.isPackaged;
/* 固定应用名 = 数据目录名，dev 与安装版一致；
 * 不固定的话 Electron 会拿 productName 当目录名，出现中文路径不好排查。 */
app.setName('video-tutor');
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// 纯文本界面，不需要 GPU；部分机器（远程桌面 / 无显卡驱动环境）下 GPU 进程会崩，直接关掉
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
/* 无独显 / 驱动异常的机器上，独立 GPU 子进程会以 0xC0000005 访问冲突崩掉，
 * Chromium 重试几次后直接 FATAL「GPU process isn't usable. Goodbye.」把整个应用带走
 * ——用户侧看到的就是：App 莫名退出，或窗口还在但所有按钮点不动（渲染进程已死）。
 * in-process-gpu 把 GPU 工作并入浏览器进程，配合上面的软渲染开关可稳定运行（已实测）。 */
app.commandLine.appendSwitch('in-process-gpu');

// 少数环境（无显卡驱动 / 受限沙箱）下连 GPU 进程都起不来，用 npm run start:safe 启动
if (process.argv.includes('--vt-safe') || process.env.VT_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

let mainWindow = null;
let floatWindow = null;
let serverPort = 0;
app.isQuitting = false;

/* ---------------- 本地静态服务 ----------------
 * 渲染进程从 http://127.0.0.1:<port> 加载，而不是 file://。
 * 原因：Chromium 对 file:// 下的 ES module 有 CORS 限制，
 *       助教核心是 ESM，走本地 http 才能直接 import。
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      const rel = urlPath === '/' ? '/index.html' : urlPath;
      const file = path.join(RENDERER_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (!file.startsWith(RENDERER_DIR)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      serverPort = srv.address().port;
      resolve(serverPort);
    });
  });
}

/* ---------------- 语音引擎路径 ---------------- */

/* Windows 上安装目录含非 ASCII 字符（中文等）时，Node 通过 spawn 传给原生 exe 的
 * 命令行参数会被 C 运行时按 ANSI 代码页转换而乱码：sherpa-onnx 找不到模型/tokens
 * 文件，配置校验失败，以退出码 4294967295 崩溃（表现为「转写失败」）。
 * 对策：把 asr 目录 junction 到一个纯 ASCII 的临时目录，之后所有路径都是 ASCII，
 * 任何代码页下都不会被破坏。junction 对目录、零复制，模型文件不用搬。 */
function ensureAsciiAsrDir(dir) {
  if (!/[^\x20-\x7f]/.test(dir)) return dir;      // 本来就干净，直接用
  const cands = [
    path.join(os.tmpdir(), 'vt-asr-link'),
    path.join(process.env.windir || 'C:\\Windows', 'Temp', 'vt-asr-link'),
  ];
  const link = cands.find((d) => !/[^\x20-\x7f]/.test(d)) || cands[0];
  try {
    try { if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link); } catch (_) {}
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(dir, link, 'junction');
    dbg('asr 目录含非 ASCII 字符，已 junction 到 ' + link);
    return link;
  } catch (e) {
    dbg('asr junction 失败，继续用原路径：' + e.message);
    return dir;
  }
}

const ASR_DIR = ensureAsciiAsrDir(isDev
  ? path.join(__dirname, '..', '..', 'resources', 'asr')
  : path.join(process.resourcesPath, 'asr'));

/** 递归找 exe（解包目录名带版本号，不写死） */
function findTool(name) {
  const walk = (dir, depth) => {
    if (depth > 3 || !fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; }
      else if (f.name.toLowerCase() === name.toLowerCase() + '.exe') return p;
    }
    return null;
  };
  return walk(ASR_DIR, 0);
}

function findModel() {
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return null;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { const r = walk(p, depth + 1); if (r) return r; }
      else if (/^model(\.int8)?\.onnx$/.test(f.name) && fs.existsSync(path.join(dir, 'tokens.txt'))) {
        return { model: p, tokens: path.join(dir, 'tokens.txt') };
      }
    }
    return null;
  };
  return walk(ASR_DIR, 0);
}

/* ---------------- 转写 worker 池 ---------------- */

/* wav 临时目录同理：用户名含中文时 os.tmpdir() 也会带上中文，换到 Windows\Temp */
const TMP = (() => {
  const d = path.join(os.tmpdir(), 'vt-asr');
  if (!/[^\x20-\x7f]/.test(d)) return d;
  return path.join(process.env.windir || 'C:\\Windows', 'Temp', 'vt-asr');
})();
if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

let seq = 0;

function writeWav(pcm) {                       // pcm: Int16Array, 16kHz mono
  const dataLen = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);   // PCM
  buf.writeUInt16LE(1, 22);   // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataLen).copy(buf, 44);
  const f = path.join(TMP, `c_${process.pid}_${seq++}.wav`);
  fs.writeFileSync(f, buf);
  return f;
}

/** 跑一次 sherpa-onnx-offline，返回 {text, ms} */
function runOnce(wav, lang, threads) {
  return new Promise((resolve, reject) => {
    const exe = findTool('sherpa-onnx-offline');
    const m = findModel();
    if (!exe || !m) return reject(new Error('语音引擎不完整'));
    const args = [
      `--sense-voice-model=${m.model}`,
      `--tokens=${m.tokens}`,
      `--sense-voice-language=${lang || 'zh'}`,
      '--sense-voice-use-itn=true',
      `--num-threads=${threads}`,
      wav,
    ];
    const t0 = Date.now();
    const p = spawn(exe, args, { windowsHide: true, cwd: path.dirname(exe) });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => {
      // 启动失败也要把 wav 删掉，否则 %TEMP%\vt-asr 会一直堆积
      fs.unlink(wav, () => {});
      reject(new Error('启动语音引擎失败：' + e.message));
    });
    p.on('close', (code) => {
      fs.unlink(wav, () => {});
      if (code !== 0 && !out.trim()) {
        /* stderr 首行是构建机路径转储（D:\a\sherpa-onnx\...），没有信息量，滤掉；
         * 保留 "does not exist" / "Errors in config" 这类真正有意义的行。 */
        const detail = err.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          .filter((l) => !/^[A-Z]:\\/.test(l))
          .slice(0, 3).join('；');
        const hint = /does not exist|Errors in config/i.test(err)
          ? '（引擎文件缺失，或安装目录含特殊字符导致路径乱码）' : '';
        return reject(new Error(`语音引擎启动失败（退出码 ${code}）${hint}：${detail || '未知错误'}`));
      }
      // 末行是 JSON：{"lang":"...","text":"...","emotion":...}
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      let text = '';
      try {
        text = String(JSON.parse(last).text || '').trim();
      } catch (_) {
        text = last;
      }
      resolve({ text, ms: Date.now() - t0 });
    });
  });
}

/** 并发池：默认 2 路，把进程启动开销摊掉 */
class AsrPool {
  constructor(size = 2) { this.size = size; this.active = 0; this.queue = []; }
  submit(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.pump();
    });
  }
  pump() {
    while (this.active < this.size && this.queue.length) {
      const { task, resolve, reject } = this.queue.shift();
      this.active++;
      Promise.resolve().then(task).then(resolve, reject)
        .finally(() => { this.active--; this.pump(); });
    }
  }
  get pending() { return this.queue.length + this.active; }
}

const pool = new AsrPool(2);

ipcMain.handle('asr:transcribe', async (_e, payload) => {
  const pcm = new Int16Array(payload.pcm);
  if (!pcm.length) return { text: '', ms: 0 };
  const wav = writeWav(pcm);
  // num-threads=2 + 池大小 2：瓶颈是模型加载（单线程），4 核机器上这样最不容易互相抢 CPU
  return pool.submit(() => runOnce(wav, payload.lang || 'zh', payload.threads || 2));
});

ipcMain.handle('asr:status', () => {
  const m = findModel();
  const exe = findTool('sherpa-onnx-offline');
  return { ready: !!(exe && m), exe, model: m && m.model, dir: ASR_DIR, pending: pool.pending };
});

/* ---------------- 系统音源 ---------------- */

ipcMain.handle('audio:sources', async () => {
  const srcs = await desktopCapturer.getSources({
    types: ['screen'],        // Windows 上只有「整个屏幕」源带音频
    thumbnailSize: { width: 150, height: 92 },
  });
  return srcs.map((s) => ({ id: s.id, name: s.name }));
});

/* ---------------- 窗口 ---------------- */

/** 开发模式下把渲染进程日志打到终端，方便排查 */
function forwardConsole(win) {
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['log', 'warn', 'error'][level] || level;
    console.log(`[renderer:${tag}] ${message}  (${String(sourceId || '').split('/').pop()}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log('[renderer] 进程崩溃：', details.reason);
    /* 渲染进程死了不能只打日志：窗口框架还在，但页面全是死的，
     * 用户看到的就是「所有按钮点了没反应」。自动重载恢复界面；
     * 采集中的会话有草稿救援（rescueDraft）兜底，转写和笔记不会丢。 */
    if (!app.isQuitting && !win.isDestroyed()) {
      setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.webContents.reload();
        } catch (_) {}
      }, 800);
    }
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log('[renderer] 加载失败：', code, desc);
  });
}

function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1060, Math.round(width * 0.8)),
    height: Math.min(700, Math.round(height * 0.85)),
    minWidth: 840,
    minHeight: 540,
    frame: false,
    backgroundColor: '#f5f5f5',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 关键：开始陪学后主窗口会隐藏，被隐藏的页面会被 Chromium 后台节流
      // （定时器降到 1 分钟一次），悬浮条就再也收不到更新了。
      backgroundThrottling: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${serverPort}/index.html`);
  if (isDev) forwardConsole(mainWindow);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.VT_SHOT) {
      setTimeout(async () => {
        // 排查用：VT_SHOT_VIEW=settings 可以指定截图前切到哪个页面
        const view = process.env.VT_SHOT_VIEW;
        if (view) {
          try {
            await mainWindow.webContents.executeJavaScript(
              `document.querySelector('.rail-item[data-view="${view}"]').click(); 'ok'`);
            await new Promise((r) => setTimeout(r, 500));
            if (process.env.VT_SHOT_CLICK) {
              await mainWindow.webContents.executeJavaScript(
                `document.querySelector('${process.env.VT_SHOT_CLICK}').click(); 'ok'`);
              await new Promise((r) => setTimeout(r, 900));
            }
          } catch (_) {}
        }
        mainWindow.capturePage().then((img) => {
          const p = path.join(app.getPath('userData'), 'shot.png');
          fs.writeFileSync(p, img.toPNG());
          console.log('[shot] ' + p);
        }).catch((e) => console.log('[shot] 失败', e.message));
      }, 2500);
    }
  });
  mainWindow.on('close', (e) => {
    // Alt+F4 / 任务栏关闭也走同一套：默认收进托盘，不直接退出
    if (!app.isQuitting && closeToTray) { e.preventDefault(); hideToTray('close'); }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (floatWindow && !floatWindow.isDestroyed()) floatWindow.close();
  });
}

function createFloatWindow() {
  if (floatWindow && !floatWindow.isDestroyed()) { floatWindow.show(); floatWindow.focus(); return; }
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  floatWindow = new BrowserWindow({
    width: 430, height: 150,
    x: width - 450, y: 84,
    frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  floatWindow.loadURL(`http://127.0.0.1:${serverPort}/float.html`);
  floatWindow.on('closed', () => { floatWindow = null; });
}

/* 最小化就是最小化：收任务栏，点任务栏图标即可找回。
 * （早期版本主窗口点 □ 会直接收进托盘，任务栏上看不到入口，用户以为程序消失了；
 *  现在只有点 × 才按「关闭时行为」设置决定收托盘还是退出。） */
ipcMain.on('win:min', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.minimize();
});
ipcMain.on('win:max', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('win:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w === floatWindow) { w.hide(); return; }   // 悬浮条只是收起，陪学继续
  if (closeToTray) { hideToTray('close'); return; }
  app.isQuitting = true;
  w.close();
});
ipcMain.handle('win:isMax', (e) => !!BrowserWindow.fromWebContents(e.sender)?.isMaximized());

/* 关闭行为由设置页决定：hide = 收进托盘（默认），quit = 直接退出。
 * 托盘不可用时强制 quit，避免窗口被藏起来却找不回。 */
ipcMain.on('win:setCloseBehavior', (_e, v) => {
  closeToTray = v !== 'quit' && !!(tray && !tray.isDestroyed());
});
ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });
ipcMain.on('win:showMain', () => showMainWindow());
ipcMain.handle('win:state', () => ({
  closeToTray,
  tray: !!(tray && !tray.isDestroyed()),
  floatVisible: !!(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()),
}));

ipcMain.handle('float:open', () => { createFloatWindow(); if (mainWindow) mainWindow.hide(); return true; });
ipcMain.handle('float:toggle', () => {
  if (floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()) {
    floatWindow.hide();
    return false;
  }
  createFloatWindow();
  return true;
});
ipcMain.handle('float:visible', () => !!(floatWindow && !floatWindow.isDestroyed() && floatWindow.isVisible()));
ipcMain.handle('float:close', () => {
  if (floatWindow && !floatWindow.isDestroyed()) floatWindow.close();
  if (mainWindow) showMainWindow();
  return true;
});

/* 悬浮条读取主窗口最新状态 */
let busState = null;
ipcMain.on('bus:pub', (_e, payload) => { busState = payload; });
ipcMain.handle('bus:get', () => busState);

/* ---------------- 本地持久化 ----------------
 * 为什么不直接用 localStorage：渲染进程从 http://127.0.0.1:<随机端口> 加载，
 * 端口每次启动都变，而 localStorage 按 origin 隔离 —— 换个端口就是全新空存储，
 * 所以配置和陪学记录重启后全部消失。一律落到主进程文件，与端口无关。
 */
const STORE_FILE = path.join(app.getPath('userData'), 'store.json');
let storeCache = null;

function readStore() {
  if (storeCache) return storeCache;
  try {
    storeCache = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (!storeCache || typeof storeCache !== 'object') storeCache = {};
  } catch (_) {
    storeCache = {};
  }
  return storeCache;
}

function flushStore() {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(storeCache || {}), 'utf8');
  } catch (e) {
    dbg('store 写入失败：' + e.message);
  }
}

ipcMain.handle('store:get', (_e, key) => readStore()[key] ?? null);
ipcMain.handle('store:set', (_e, key, value) => {
  readStore()[key] = value;
  flushStore();
  return true;
});
ipcMain.handle('store:path', () => STORE_FILE);

/* ---------------- 托盘 ----------------
 * 关掉窗口就退出，会让用户「关闭后什么记录都没了」；最小化后又容易以为程序崩了。
 * 统一收进托盘，任何状态下都能把窗口找回来。
 */
let tray = null;
let closeToTray = true;

function trayIconPath() {
  const p = isDev
    ? path.join(__dirname, '..', '..', 'resources', 'icon.ico')
    : path.join(process.resourcesPath, 'icon.ico');
  if (fs.existsSync(p)) return p;
  return process.execPath;   // 兜底：从 exe 里取图标
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideToTray(why) {
  const w = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (w) w.hide();
  dbg('hideToTray: ' + why);
  if (tray && !tray.isDestroyed()) {
    try {
      tray.displayBalloon({
        title: '视频陪学 AI 助教',
        content: why === 'close'
          ? '已最小化到托盘，陪学仍在后台继续。双击托盘图标可以找回窗口。'
          : '已最小化到托盘，双击托盘图标可以找回窗口。',
        iconType: 'info',
      });
    } catch (_) {}
  }
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  try {
    tray = new Tray(nativeImage.createFromPath(trayIconPath()));
  } catch (e) {
    dbg('托盘创建失败：' + e.message);
    // 没有托盘就绝对不能把窗口藏起来，否则用户再也找不回来
    closeToTray = false;
    return;
  }
  tray.setToolTip('视频陪学 AI 助教');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { label: '检查更新…', click: () => {
        showMainWindow();
        setTimeout(() => sendToRenderer('update:checkNow', {}), 600);
      } },
    { label: '显示 / 隐藏悬浮条', click: () => {
        if (floatWindow && !floatWindow.isDestroyed()) {
          floatWindow.isVisible() ? floatWindow.hide() : floatWindow.show();
        } else {
          createFloatWindow();
        }
      } },
    { type: 'separator' },
    { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showMainWindow);
  tray.on('click', showMainWindow);
}

/* ---------------- 其它 ---------------- */

ipcMain.handle('file:save', async (_e, { defaultName, content }) => {
  const win = mainWindow || floatWindow;
  if (!win) return { ok: false };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, filePath };
});

/** 自带的 Key：开发目录或安装目录下存在 devkey.json 时自动填一次，之后以设置页为准 */
function readDevKey() {
  const candidates = [
    path.join(__dirname, '..', '..', 'devkey.json'),
    isDev ? null : path.join(process.resourcesPath, 'devkey.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) {}
  }
  return null;
}

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  isDev,
  asrDir: ASR_DIR,
  electron: process.versions.electron,
  node: process.versions.node,
  devKey: readDevKey(),
}));

ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));

/* ---------------- 自动更新 ----------------
 * 流程：拉清单 → 比版本 → 推公告 → 下载 → 调安装包静默覆盖安装 → 退出旧进程。
 * 安装包是同一个 appId 的 NSIS 包，装的时候会卸掉旧版本再写新的，用户数据保留，
 * 所以不需要手动卸载。更新源用软件自带的（随包 update.json），设置页只保留自动检查开关。
 */

/** 默认更新源：随包的 update.json（owner / repo / branch / feedUrl） */
function readUpdateDefaults() {
  const candidates = [
    isDev ? path.join(__dirname, '..', '..', 'update.json') : null,
    isDev ? null : path.join(process.resourcesPath, 'update.json'),
  ].filter(Boolean);
  for (const f of candidates) {
    try { if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  }
  return {};
}

function sendToRenderer(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (w.isDestroyed()) continue;
      const wc = w.webContents;
      if (!wc || wc.isDestroyed()) continue;   // 关窗后 frame 已销毁，别再往里发
      wc.send(channel, payload);
    } catch (_) {}
  }
}

const updater = new Updater({
  app, isDev, dbg,
  send: sendToRenderer,
  storeGet: (k) => readStore()[k],
  storeSet: (k, v) => { readStore()[k] = v; flushStore(); },
  defaults: readUpdateDefaults(),
});

ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', async () => {
  try {
    const r = await updater.download(null, (p) => sendToRenderer('update:progress', p));
    if (r && r.ok) {
      sendToRenderer('update:progress', { phase: 'done', received: r.size, total: r.size, file: r.file });
    }
    return r;
  } catch (e) {
    sendToRenderer('update:progress', { phase: 'error', error: e.message || String(e) });
    return { ok: false, error: e.message || String(e) };
  }
});
ipcMain.handle('update:install', async () => {
  /* 先让渲染进程把草稿落盘再退出。
   * app.quit() 不会等渲染进程的异步 store 写入完成 —— 正在陪学时点更新，
   * 最后一段转写/笔记会跟着进程一起蒸发。这里主动发一次保存信号并等它写完。 */
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('vt:before-quit'); } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, 1200));

  const r = await updater.install().catch((e) => ({ ok: false, error: e.message || String(e) }));
  // 安装包被安排 3 秒后启动，这边必须先把位置让出来，否则旧进程占着文件、安装会卡住
  if (r && r.ok && r.via !== 'shell') {
    setTimeout(() => { app.isQuitting = true; app.quit(); }, 300);
  }
  return r;
});
ipcMain.handle('update:config', () => {
  const c = updater.cfg();
  const d = readUpdateDefaults();
  return {
    ...c,
    defaultFeed: (d.owner && d.repo) ? `github.com/${d.owner}/${d.repo}` : '',
  };
});
ipcMain.handle('update:setConfig', (_e, patch) => updater.setCfg(patch || {}));
ipcMain.handle('update:openDir', () => updater.openDir());

/* ---------------- 启动 ---------------- */

/* 排查用的启动日志：设 VT_DEBUG=1 后写到 <userData>/launch.log */
const DEBUG = !!process.env.VT_DEBUG;
function dbg(msg) {
  if (!DEBUG) return;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'launch.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}
app.on('will-quit', () => dbg('will-quit'));
app.on('before-quit', () => dbg('before-quit'));
process.on('exit', (c) => dbg('process exit ' + c));

app.whenReady().then(async () => {
  dbg('ready, starting static server');
  await startStaticServer();
  dbg('server on ' + serverPort);
  createMainWindow();
  createTray();
  updater.cleanup();          // 清掉下载目录里过期的旧安装包（每个 250MB）
  dbg('main window + tray created');

  /* 心跳：主窗口收成悬浮条后处于隐藏状态，Chromium 可能节流隐藏窗口里的定时器，
   * 计时器和缓冲显示会变陈旧（用户看到「计数不动 / 两个窗口数字不一致」）。
   * 主进程的定时器不受窗口可见性影响，用它驱动两个窗口的时钟。 */
  setInterval(() => {
    try { sendToRenderer('vt:tick', Date.now()); } catch (_) {}
  }, 1000);

  if (process.env.VT_SELFTEST_AUDIO === '1') selfTestAudio();
  if (process.env.VT_SELFTEST_UPDATE === '1') selfTestUpdate();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

/**
 * 系统声音链路自检（仅排查用）：
 * VT_SELFTEST_AUDIO=1 启动，脚本会自动开始陪学并在终端汇报
 * 「采集峰值 / 已转写段数 / 已提炼笔记」。峰值 > 0.01 说明整屏回环音频能抓到。
 * 想验证转写效果，可以在自检期间用外部播放器放一段有人说话的音频。
 */
async function selfTestAudio() {
  const log = (s) => console.log('[selftest] ' + s);
  const q = (js) => mainWindow.webContents.executeJavaScript(js);
  try {
    await new Promise((r) => mainWindow.webContents.once('did-finish-load', r));
    await new Promise((r) => setTimeout(r, 1500));

    log('点击开始陪学…');
    await q("document.querySelector('#btnStart').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 2500));
    log('采集状态：' + await q(
      `(async () => JSON.stringify({
        capturing: window.__vtApp.capturing,
        inRate: window.__vtApp.inRate,
        tracks: (window.__vtApp.stream || { getAudioTracks: () => [] }).getAudioTracks().length,
        floatVisible: await window.vt.floatVisible(),
        mainHidden: document.hidden
      }))()`));

    log('播放 2 秒测试音（440Hz）验证回环…');
    await q(`(() => {
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      osc.type = 'sine'; osc.frequency.value = 440;
      const g = ac.createGain(); g.gain.value = 0.3;
      osc.connect(g); g.connect(ac.destination); osc.start();
      setTimeout(() => { try { osc.stop(); ac.close(); } catch (e) {} }, 2000);
      return 'tone';
    })()`);

    log('用系统语音合成朗读一段中文讲解（验证「有语音 → 能转写出文字」）…');
    await q(`(async () => {
      const text = ('TCP 三次握手是建立连接的过程。第一步，客户端发送同步报文，请求建立连接。'
        + '第二步，服务器收到后回复同步确认报文。第三步，客户端再发送一个确认报文。'
        + '注意，三次握手的目的不是保证数据不丢失，而是确认双方的初始序列号，防止历史重复连接造成混乱。'
        + '另外还要小心同步泛洪攻击，它是利用了半连接状态来耗尽服务器资源。').repeat(2);
      await new Promise((r) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN'; u.rate = 1.05;
        u.onend = () => r('end'); u.onerror = (e) => r('err:' + (e.error || ''));
        window.__vtSpoken = 'pending';
        setTimeout(() => r('timeout'), 40000);
        speechSynthesis.speak(u);
      }).then((r) => { window.__vtSpoken = r; });
      return 'speak-done:' + window.__vtSpoken;
    })()`);

    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 6000));
      const s = await q(`JSON.stringify({
        peak: window.__vtApp.maxPeakSeen,
        segs: window.__vtApp.tutor.transcript.length,
        notes: window.__vtApp.tutor.notes.length,
        lastMs: window.__vtApp.lastFlushMs,
        buf: +(window.__vtApp.rawLen / (window.__vtApp.inRate || 48000)).toFixed(1)
      })`);
      log(`第 ${i} 次巡检：` + s);
    }

    const final = await q("JSON.stringify({texts: window.__vtApp.tutor.transcript.map(t => t.text), notes: window.__vtApp.tutor.notes.map(n => '【' + n.tag + '】' + n.title)})");
    log('最终转写与笔记：' + final);

    log('验证「暂停 → 继续」：暂停后按钮要变成「继续」，点一下要能接着听…');
    await q(`document.querySelector('#btnPause').click(); 'ok'`);
    await new Promise((r) => setTimeout(r, 12000));
    log('暂停后：按钮=' + await q(`document.querySelector('#btnPause').textContent`)
      + ' · 禁用=' + await q(`document.querySelector('#btnPause').disabled`)
      + ' · 音频=' + await q(`document.querySelector('#stAudio').textContent`)
      + ' · 小节数=' + await q(`window.__vtApp.tutor.sections.length`));
    await q(`document.querySelector('#btnPause').click(); 'ok'`);
    await new Promise((r) => setTimeout(r, 3000));
    log('点继续后：按钮=' + await q(`document.querySelector('#btnPause').textContent`)
      + ' · 音频=' + await q(`document.querySelector('#stAudio').textContent`)
      + ' · 计时=' + await q(`document.querySelector('#stTime').textContent`));

    log('点击结束陪学（顺便验证「结束前把剩余缓冲也转写」和落盘）…');
    await q("document.querySelector('#btnEnd').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 20000));
    log('笔记库记录：' + await q(
      "JSON.stringify(window.__vtApp.sessions.map(s => ({t: s.title, notes: (s.notes||[]).length, segs: (s.transcript||[]).length, graph: !!(s.graph && s.graph.mermaid)})))"));
    log('数据文件：' + STORE_FILE);

    log('验证窗口行为：点关闭 → 按设置收进托盘（不退出）；点最小化 → 正常最小化到任务栏 …');
    await q("document.querySelector('#btnClose').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 900));
    log('点关闭后 → 主窗口可见=' + mainWindow.isVisible()
      + ' · 窗口数=' + BrowserWindow.getAllWindows().length
      + ' · 托盘=' + !!(tray && !tray.isDestroyed()));
    showMainWindow();
    await new Promise((r) => setTimeout(r, 500));
    await q("document.querySelector('#btnMin').click(); 'ok'");
    await new Promise((r) => setTimeout(r, 900));
    log('点最小化后 → 已最小化=' + mainWindow.isMinimized()
      + ' · 窗口数=' + BrowserWindow.getAllWindows().length);
    log(mainWindow.isMinimized()
      ? '✓ 已最小化到任务栏，进程仍存活，点任务栏图标可找回'
      : '✗ 窗口没有被最小化');
    showMainWindow();
  } catch (e) {
    log('自检失败：' + e.message);
  }
}

/**
 * 自动更新链路自检（仅排查用）：
 *   VT_SELFTEST_UPDATE=1 启动。可选 VT_UPDATE_FEED=<latest.json 地址> 临时指定更新源
 * （设置页已不暴露该功能，此环境变量留给发布前自检；不填则用软件自带源）。
 * 会自动完成：造一条历史记录 → 切设置页 → 检查更新 → 读公告 → 点更新 →
 * 等下载安装 → 旧进程退出。日志写到 <userData>/update-selftest.log。
 * 装完新版会自动启动，看日志最后几行 + 新版关于页的版本号即可确认。
 */
async function selfTestUpdate() {
  const file = path.join(app.getPath('userData'), 'update-selftest.log');
  const log = (s) => {
    console.log('[updtest] ' + s);
    try { fs.appendFileSync(file, `[${new Date().toISOString()}] ${s}\n`); } catch (_) {}
  };
  const q = (js) => mainWindow.webContents.executeJavaScript(js);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    fs.writeFileSync(file, '');
    await new Promise((r) => mainWindow.webContents.once('did-finish-load', r));
    await sleep(2000);

    log('版本 ' + app.getVersion() + ' · isDev=' + isDev);

    // 造一条历史记录，用来验证「更新后数据还在不在」
    await q(`(async () => {
      const old = (await window.vt.store.get('vt_sessions')) || [];
      await window.vt.store.set('vt_sessions', old.concat([{
        id: 'updtest', title: '更新验证课程', startedAt: Date.now(), endedAt: Date.now(),
        notes: [{ tag: '重点', title: '这条笔记用来验证更新后数据不丢' }], transcript: ['测试转写'],
      }]));
      return 'seeded';
    })()`);
    log('已写入 1 条测试记录');

    await q(`document.querySelector('.rail-item[data-view="settings"]').click(); 'ok'`);
    await sleep(400);
    log('更新源 = ' + (process.env.VT_UPDATE_FEED || '软件自带源'));

    await q("document.querySelector('#btnCheckUpdate').click(); 'ok'");
    await sleep(5000);
    log('检查结果：' + await q("document.querySelector('#checkUpdateResult').textContent"));
    log('公告：hidden=' + await q("document.querySelector('#updBanner').hidden")
      + ' · 版本=' + await q("document.querySelector('#updVer').textContent")
      + ' · 说明=' + await q("document.querySelector('#updNotes').textContent"));

    if (await q("document.querySelector('#updBanner').hidden")) {
      log('✗ 没有检测到新版，流程到此结束');
      return;
    }

    log('点击「立即更新」…');
    await q(`document.querySelector('#updGo').click(); 'ok'`);
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      const t = await q(`document.querySelector('#updGo').textContent`);
      const toast = await q(`document.querySelector('#toast').textContent`);
      if (i % 5 === 0 || /安装|失败|重试|手动|开发模式/.test(t + toast)) {
        log(`进度 ${i}s：按钮=${t} · 提示=${toast}`);
      }
      // 开发模式下 install 会被刻意跳过（不真装），看到提示就收尾
      if (/开发模式|安装中|失败|重试|手动/.test(t + toast)) break;
    }
    log('流程结束（正式安装包会在这里退出旧进程、交给安装程序）');
  } catch (e) {
    log('自检失败：' + (e.message || e));
  }
}

/* 退出前把渲染进程还没落盘的草稿抢救一下 */
app.on('before-quit', () => {
  app.isQuitting = true;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('vt:before-quit'); } catch (_) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && app.isQuitting) app.quit();
});
