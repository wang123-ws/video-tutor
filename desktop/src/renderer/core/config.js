/**
 * 全局配置。
 * 优先级：chrome.storage(用户在设置页填写) > config.local.js > 本文件默认值
 * 说明：本文件会随仓库公开，请勿把密钥写在 DEFAULT_CONFIG 里。
 *      私有密钥请写入同目录 config.local.js（已在 .gitignore 中忽略）。
 */

/**
 * 服务商预设：设置页可一键切换。
 * 关键经验：SiliconFlow 的免费额度用尽后，账户下**所有**模型（含标注免费的）都会返回 402，
 *          所以零成本方案应转向「永久免费模型」型服务商（如智谱 GLM-4-Flash）。
 */
export const PROVIDER_PRESETS = {
  modelscope: {
    label: 'ModelScope 魔搭（每日免费额度，模型新）★ 已验证 Key',
    apiBase: 'https://api-inference.modelscope.cn/v1',
    chatModel: 'Qwen/Qwen3.8-Flash-Next',
    chatModelFallback: 'ZhipuAI/GLM-4.7-Flash',
    asrModel: '',
    note: '阿里的模型社区，API-Inference 每天有免费调用额度。⚠ 新账户必须先完成邮箱验证才能调用：https://modelscope.cn/my/settings/account （未验证会报 "Magicubes is only available to verified accounts"）。',
  },
  zhipu: {
    label: '智谱 AI · GLM-4-Flash（永久免费，国内直连）★ 零成本首选',
    apiBase: 'https://open.bigmodel.cn/api/paas/v4',
    chatModel: 'glm-4-flash',
    chatModelFallback: 'glm-4-flash',
    asrModel: '',
    note: '注册送 2000 万 token，且 glm-4-flash 永久免费不限 token（30 并发）。注册后创建 API Key 填入即可。地址：https://open.bigmodel.cn',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow（国内直连，模型最全）',
    apiBase: 'https://api.siliconflow.cn/v1',
    chatModel: 'Qwen/Qwen3-8B',
    chatModelFallback: 'Qwen/Qwen3.5-9B',
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
    note: '新用户送 2000 万 token（约 14 元）。⚠ 余额用尽后整个账户所有模型都会 402，需充值最低额度解锁。',
  },
  dashscope: {
    label: '阿里云百炼 · 通义千问（新用户大额免费额度）',
    apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatModel: 'qwen-flash',
    chatModelFallback: 'qwen-plus',
    asrModel: '',
    note: '新用户各模型有独立免费额度。地址：https://bailian.console.aliyun.com',
  },
  deepseek: {
    label: 'DeepSeek 官方（质量高，按量付费）',
    apiBase: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-chat',
    chatModelFallback: 'deepseek-chat',
    asrModel: '',
    note: '无免费额度，但单价低。地址：https://platform.deepseek.com',
  },
  openrouter: {
    label: 'OpenRouter（含 :free 免费模型，需可访问外网）',
    apiBase: 'https://openrouter.ai/api/v1',
    chatModel: 'deepseek/deepseek-chat-v3.1:free',
    chatModelFallback: 'meta-llama/llama-3.3-70b-instruct:free',
    asrModel: '',
    note: '带 :free 后缀的模型免费，每天有请求数上限。地址：https://openrouter.ai',
  },
  custom: {
    label: '自定义（任意 OpenAI 兼容接口）',
    apiBase: '',
    chatModel: '',
    chatModelFallback: '',
    asrModel: '',
    note: '需自行填写 Base URL 与模型名，并确保已授予该域名的访问权限。',
  },
};

export const DEFAULT_CONFIG = {
  /* ---------- 大模型（OpenAI 兼容接口） ---------- */
  provider: 'modelscope',
  apiBase: 'https://api-inference.modelscope.cn/v1',
  apiKey: '',
  chatModel: 'Qwen/Qwen3.8-Flash-Next',
  chatModelFallback: 'ZhipuAI/GLM-4.7-Flash',
  temperature: 0.25,
  maxTokens: 2048,
  enableThinking: false,      // Qwen3 系列关闭思考过程，输出更快更省 token

  /* ---------- 语音转写 ---------- */
  // webspeech = 浏览器内置识别（零成本，默认）
  // cloud     = 捕获页面音频 + 云端 ASR（需额度）
  // manual    = 手动粘贴文本（兜底 / 测试）
  asrMode: 'webspeech',
  asrModel: '',
  asrLang: 'zh-CN',
  // 分片时长（秒）。桌面端实测：本地引擎每次转写包含 ~4s 的模型加载开销，
  // 所以 10 秒一片比较稳（约 5 秒出结果，不会积压）；插件端的云端 ASR 同样适用。
  chunkSeconds: 10,

  /* ---------- 助教节奏 ---------- */
  engine: 'auto',             // auto | llm | local
  extractChars: 240,          // 累积多少字触发一次增量知识点提取
  extractIntervalMs: 15000,   // 或距上次提取超过多少毫秒
  dedupThreshold: 0.62,       // 笔记去重相似度阈值（0~1）
  maxNotesPerSection: 60,

  /* ---------- 输出 ---------- */
  graphStyle: 'mindmap',      // mindmap | flowchart
  autoOpenSidePanel: true,
  saveHistory: true,
};

const STORAGE_KEY = 'vt_config';

let LOCAL_CONFIG = {};
try {
  LOCAL_CONFIG = (await import('./config.local.js')).LOCAL_CONFIG || {};
} catch (_) {
  // 未创建本地私有配置文件，忽略
}

async function getStore() {
  // 桌面端（Electron）注入的存储：走主进程文件。
  // 必须优先于 localStorage —— 桌面端渲染进程的 origin 是 http://127.0.0.1:<随机端口>，
  // 端口每次启动都会变，localStorage 会整体失效，配置和记录都会「重启即丢」。
  if (typeof window !== 'undefined' && window.vt && window.vt.store) {
    return {
      async get() {
        try { return (await window.vt.store.get(STORAGE_KEY)) || {}; } catch (_) { return {}; }
      },
      async set(v) {
        try { await window.vt.store.set(STORAGE_KEY, v); } catch (_) {}
      },
    };
  }
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    return {
      async get() {
        const obj = await chrome.storage.local.get(STORAGE_KEY);
        return obj[STORAGE_KEY] || {};
      },
      async set(v) {
        await chrome.storage.local.set({ [STORAGE_KEY]: v });
      },
    };
  }
  if (typeof localStorage !== 'undefined') {
    return {
      async get() {
        try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (_) { return {}; }
      },
      async set(v) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v)); } catch (_) {}
      },
    };
  }
  return { async get() { return {}; }, async set() {} };
}

export async function loadConfig() {
  const store = await getStore();
  const saved = await store.get();
  return { ...DEFAULT_CONFIG, ...LOCAL_CONFIG, ...saved };
}

export async function saveConfig(patch) {
  const store = await getStore();
  const saved = await store.get();
  const next = { ...saved, ...patch };
  await store.set(next);
  return { ...DEFAULT_CONFIG, ...LOCAL_CONFIG, ...next };
}

export function hasApiKey(cfg) {
  return !!(cfg && cfg.apiKey && String(cfg.apiKey).trim());
}
