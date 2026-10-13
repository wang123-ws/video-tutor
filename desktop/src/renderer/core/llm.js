/**
 * OpenAI 兼容接口客户端（聊天 + 语音转写）。
 * 适配 SiliconFlow / OpenAI / 各类自建转发端点。
 */

function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

/** 从模型输出中稳健地抠出 JSON（模型可能包```json```或夹杂思考过程） */
export function extractJson(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const tryParse = (t) => {
    try { return JSON.parse(t); } catch (_) { return null; }
  };
  const direct = tryParse(s);
  if (direct) return direct;
  // 截取第一个 { 到最后一个 }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const obj = tryParse(s.slice(a, b + 1));
    if (obj) return obj;
  }
  // 数组形态
  const a2 = s.indexOf('[');
  const b2 = s.lastIndexOf(']');
  if (a2 !== -1 && b2 > a2) {
    const arr = tryParse(s.slice(a2, b2 + 1));
    if (arr) return arr;
  }
  return null;
}

/**
 * 把各家平台的报错翻译成人话 + 给出可执行动作。
 * 返回的 code 供上层决定是否停用大模型（避免空烧请求）。
 *   fatal  = 重试无意义，应永久停用直到用户改配置
 *   retry  = 可能是临时故障
 */
export function explainError(msg) {
  const s = String(msg || '');
  if (/email verification|verified accounts/i.test(s)) {
    return {
      code: 'fatal',
      text: '魔搭账户未完成邮箱验证，已被风控拦截。请到 modelscope.cn/my/settings/account 完成验证后重试。',
    };
  }
  if (/402|balance is insufficient|insufficient balance/i.test(s)) {
    return { code: 'fatal', text: '账户余额不足（402）。请充值或改用永久免费的服务商（如智谱 glm-4-flash）。' };
  }
  if (/401|Token is invalid|令牌已过期|Invalid API key|Unauthorized/i.test(s)) {
    return { code: 'fatal', text: 'API Key 无效或已过期（401）。请检查设置页填写的 Key。' };
  }
  if (/has no provider supported|does not exist|model_not_found/i.test(s)) {
    return { code: 'fatal', text: '模型名不被该服务商支持。请在设置页核对模型 ID（区分大小写）。' };
  }
  if (/429|rate limit|Too Many Requests/i.test(s)) {
    return { code: 'retry', text: '请求过于频繁（429），稍后自动重试。' };
  }
  if (/Failed to fetch|NetworkError|CORS|net::ERR/i.test(s)) {
    return { code: 'retry', text: '网络不可达或被跨域拦截。请检查网络，或在设置页确认已授权该域名。' };
  }
  return { code: 'retry', text: s.slice(0, 160) };
}

export class LLMClient {
  constructor(cfg) {
    this.cfg = cfg || {};
  }

  get ready() {
    return !!(this.cfg.apiKey && this.cfg.apiBase);
  }

  async chat(messages, opts = {}) {
    if (!this.ready) throw new Error('未配置 API Key');
    const model = opts.model || this.cfg.chatModel;
    const body = {
      model,
      messages,
      temperature: opts.temperature ?? this.cfg.temperature ?? 0.25,
      max_tokens: opts.maxTokens || this.cfg.maxTokens || 2048,
      stream: false,
    };
    if (this.cfg.enableThinking === false) body.enable_thinking = false;

    const res = await fetch(joinUrl(this.cfg.apiBase, '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const raw = `LLM ${res.status}: ${t.slice(0, 200)}`;
      const exp = explainError(raw);
      const err = new Error(exp.text);
      err.code = exp.code;
      err.raw = raw;
      throw err;
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    // Qwen3 等模型会返回 reasoning_content（思考过程），只取正式回答
    const content = msg.content ?? msg.reasoning_content ?? '';
    return { text: String(content).trim(), raw: data };
  }

  /** 结构化 JSON 调用，失败返回 fallback */
  async chatJson(messages, opts = {}) {
    const r = await this.chat(messages, opts);
    const obj = extractJson(r.text);
    if (!obj) throw new Error('模型未返回合法 JSON');
    return obj;
  }

  /**
   * 语音转写（OpenAI /audio/transcriptions 兼容）。
   * blob: Blob；fileName 需带扩展名
   */
  async transcribe(blob, opts = {}) {
    if (!this.ready) throw new Error('未配置 API Key');
    const model = opts.model || this.cfg.asrModel;
    const fd = new FormData();
    fd.append('file', blob, opts.fileName || 'chunk.webm');
    fd.append('model', model);
    if (opts.language) fd.append('language', opts.language);
    if (opts.prompt) fd.append('prompt', opts.prompt);

    const res = await fetch(joinUrl(this.cfg.apiBase, '/audio/transcriptions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
      body: fd,
      signal: opts.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`ASR ${res.status}: ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    return String(data?.text || '').trim();
  }
}
