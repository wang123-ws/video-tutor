/**
 * 预加载：只暴露白名单 API，渲染进程无 Node 权限。
 * 注意 store：桌面端的配置与陪学记录一律存主进程文件，
 * 因为渲染进程走 http://127.0.0.1:<随机端口>，localStorage 会随端口变化而失效。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vt', {
  /* 窗口 */
  min: () => ipcRenderer.send('win:min'),
  max: () => ipcRenderer.send('win:max'),
  close: () => ipcRenderer.send('win:close'),
  isMax: () => ipcRenderer.invoke('win:isMax'),
  showMain: () => ipcRenderer.send('win:showMain'),
  quit: () => ipcRenderer.send('app:quit'),
  setCloseBehavior: (v) => ipcRenderer.send('win:setCloseBehavior', v),
  winState: () => ipcRenderer.invoke('win:state'),

  /* 悬浮条 */
  openFloat: () => ipcRenderer.invoke('float:open'),
  toggleFloat: () => ipcRenderer.invoke('float:toggle'),
  closeFloat: () => ipcRenderer.invoke('float:close'),
  floatVisible: () => ipcRenderer.invoke('float:visible'),

  /* 音频 / 转写 */
  sources: () => ipcRenderer.invoke('audio:sources'),
  transcribe: (pcm, lang) => ipcRenderer.invoke('asr:transcribe', { pcm, lang }),
  asrStatus: () => ipcRenderer.invoke('asr:status'),

  /* 持久化（主进程文件，重启不丢） */
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    path: () => ipcRenderer.invoke('store:path'),
  },

  /* 其他 */
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openPath: (p) => ipcRenderer.invoke('shell:open', p),

  /* 主窗口状态广播（给悬浮条取用） */
  busPub: (payload) => ipcRenderer.send('bus:pub', payload),
  busGet: () => ipcRenderer.invoke('bus:get'),

  /* 自动更新 */
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    config: () => ipcRenderer.invoke('update:config'),
    setConfig: (patch) => ipcRenderer.invoke('update:setConfig', patch),
    openDir: () => ipcRenderer.invoke('update:openDir'),
    onProgress: (fn) => {
      const h = (_e, p) => fn(p);
      ipcRenderer.on('update:progress', h);
      return () => ipcRenderer.removeListener('update:progress', h);
    },
    onAvailable: (fn) => {
      const h = (_e, p) => fn(p);
      ipcRenderer.on('update:available', h);
      return () => ipcRenderer.removeListener('update:available', h);
    },
    /** 托盘菜单「检查更新」→ 渲染进程收到后弹主窗口并立即查一次 */
    onCheckNow: (fn) => {
      const h = () => fn();
      ipcRenderer.on('update:checkNow', h);
      return () => ipcRenderer.removeListener('update:checkNow', h);
    },
  },

  /* 退出前的抢救信号 */
  onBeforeQuit: (fn) => {
    const h = () => fn();
    ipcRenderer.on('vt:before-quit', h);
    return () => ipcRenderer.removeListener('vt:before-quit', h);
  },

  /* 主进程心跳（每秒）：隐藏窗口里的定时器可能被 Chromium 节流，
   * 时钟、缓冲、状态栏统一由主进程驱动，保证两个窗口数字一致。 */
  onTick: (fn) => {
    const h = (_e, t) => fn(t);
    ipcRenderer.on('vt:tick', h);
    return () => ipcRenderer.removeListener('vt:tick', h);
  },
});
