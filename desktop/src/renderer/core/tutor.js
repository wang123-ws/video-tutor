/**
 * 视频陪学 AI 助教 —— 核心状态机。
 * 职责：接收分段流式转写文本 → 增量提炼知识点 → 维护结构化笔记 → 响应控制指令 → 生成知识图谱。
 * 平台无关：浏览器插件、桌面悬浮端、网页、微信内嵌端都可直接复用本模块。
 */

import { STATE, TAGS } from './protocol.js';
import { LLMClient, explainError } from './llm.js';
import * as LE from './localEngine.js';
import { isDuplicate } from './similarity.js';
import { buildMermaid, collectTopics, toMarkdown } from './knowledgeGraph.js';
import {
  SYSTEM_TUTOR,
  buildExtractPrompt,
  buildSectionSummaryPrompt,
  buildGraphPrompt,
  buildTopicDetailPrompt,
} from './prompts.js';

let _uid = 0;
const uid = (p = 'n') => `${p}_${Date.now().toString(36)}_${(++_uid).toString(36)}`;

export class Tutor {
  constructor(config, emitter) {
    this.cfg = config || {};
    this.emitter = emitter || { emit() {} };
    this.llm = new LLMClient(this.cfg);
    this.reset();
  }

  reset() {
    this.sessionId = uid('s');
    this.state = STATE.IDLE;
    this.topic = '';
    this.transcript = [];      // [{seq, text, tStart, tEnd, ts}]
    this.notes = [];           // [{id, tag, title, body, keywords, section, seq, ts}]
    this.sections = [];        // [{index, title, summary, noteIds}]
    this.graph = null;         // {root, nodes, mermaid}
    this.pending = '';         // 未提取的文本缓冲
    this.seq = 0;
    this.lastExtractAt = 0;
    this.extracting = false;
    this._clearExtractTimer();
    this.startedAt = 0;
    this.llmBroken = false;   // 额度不足 / 鉴权失败后置位，避免无意义重试
  }

  emit(type, payload) {
    try { this.emitter.emit(type, payload); } catch (_) {}
  }

  setConfig(cfg) {
    this.cfg = { ...this.cfg, ...cfg };
    this.llm = new LLMClient(this.cfg);
  }

  get usingLLM() {
    if (this.cfg.engine === 'local') return false;
    if (this.llmBroken) return false;
    if (this.cfg.engine === 'llm') return !!this.cfg.apiKey;
    return !!this.cfg.apiKey;
  }

  /**
   * 处理大模型调用失败：
   * - fatal 类（额度耗尽 / Key 无效 / 账户未验证 / 模型名错误）→ 永久停用大模型，转本地引擎
   * - retry 类（限流 / 网络抖动）→ 仅本次降级，下次继续尝试
   */
  _handleLlmError(e) {
    const m = String(e?.message || e);
    const exp = explainError(e?.raw || m);
    if (e?.code === 'fatal' || exp.code === 'fatal') {
      if (!this.llmBroken) {
        this.llmBroken = true;
        this.emit('error', { message: `${exp.text} 已切换为本地引擎（零成本，仍可提炼笔记与图谱）` });
      }
      return true;
    }
    this.emit('log', { level: 'warn', text: `大模型调用失败，本次降级本地引擎：${m.slice(0, 80)}` });
    return false;
  }

  /* ---------------- 会话 ---------------- */

  start(meta = {}) {
    this.reset();
    this.state = STATE.LISTENING;
    this.startedAt = Date.now();
    if (meta.topic) this.topic = meta.topic;
    this.sections.push({ index: 0, title: '', summary: '', noteIds: [] });
    this.emit('state', { state: this.state, sessionId: this.sessionId });
    this.emit('log', { level: 'info', text: '开始陪学，助教进入听课状态' });
    return this.snapshot();
  }

  /** 接收一段流式转写文本 */
  pushSegment({ text, tStart, tEnd } = {}) {
    const t = String(text || '').trim();
    if (!t) return;
    // 过滤与上一段完全重复的推送
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.text === t) return;

    if (this.state === STATE.ENDED) this.start();
    if (this.state === STATE.PAUSED) {
      // 继续收到流式文本 → 自动恢复听课记录
      this.resume(true);
    }
    if (this.state === STATE.IDLE) {
      this.state = STATE.LISTENING;
      if (!this.sections.length) this.sections.push({ index: 0, title: '', summary: '', noteIds: [] });
      this.emit('state', { state: this.state });
    }

    const seg = { seq: this.seq++, text: t, tStart, tEnd, ts: Date.now() };
    this.transcript.push(seg);
    this.pending += (this.pending ? ' ' : '') + t;
    this.emit('transcript', seg);

    const reachedChars = this.pending.length >= (this.cfg.extractChars || 240);
    const reachedTime = this.lastExtractAt &&
      Date.now() - this.lastExtractAt >= (this.cfg.extractIntervalMs || 15000);
    if (reachedChars || reachedTime) this.scheduleExtract(0);
    else this.scheduleExtract(this.cfg.extractIntervalMs || 15000);
  }

  /**
   * 安排下一次增量提取。
   *
   * 这里有个很容易踩的坑：如果每次收到新文本都无条件 clearTimeout 再重设，
   * 那么当「分片间隔 < 提取间隔」时（桌面端 10 秒分片 vs 15 秒提取间隔），
   * 定时器会被无限推迟，提取永远不触发 —— 表现就是转写一直在滚，笔记一条都没有。
   * 所以：已经有在等的定时器时就不重置，到点必触发。
   */
  scheduleExtract(delay) {
    const d = Math.max(0, Number(delay) || 0);
    if (d > 0 && this.timer) return;          // 已有等待中的任务，别推迟它
    this._clearExtractTimer();
    if (d === 0) { this.extract(); return; }  // 字数够了 → 立刻提取
    this.timer = setTimeout(() => { this.timer = null; this.extract(); }, d);
  }

  _clearExtractTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** 增量知识点提取 */
  async extract() {
    if (this.extracting) { this.scheduleExtract(1500); return; }   // 正在提取：稍后重试，别把这段内容丢了
    const text = this.pending.trim();
    if (!text || this.state === STATE.ENDED) return;
    this.extracting = true;
    this.pending = '';
    this.lastExtractAt = Date.now();
    try {
      const items = await this._extractItems(text);
      const added = [];
      for (const it of items) {
        const tag = TAGS.includes(it.tag) ? it.tag : '重点';
        const title = String(it.title || '').trim().slice(0, 40);
        const body = String(it.body || '').trim().slice(0, 200);
        if (!title) continue;
        const cand = {
          id: uid(),
          tag,
          title,
          body,
          keywords: Array.isArray(it.keywords) ? it.keywords.slice(0, 6) : [],
          section: this.sections.length - 1,
          seq: this.seq,
          ts: Date.now(),
        };
        // 同标签内按相似度去重；跨标签（如“重点”与“易错点”）视为不同视角，只有完全相同才丢弃
        const sameTag = this.notes.filter((n) => n.tag === tag);
        const identical = this.notes.some((n) => n.title === cand.title && n.body === cand.body);
        if (identical) continue;
        if (isDuplicate(cand, sameTag, this.cfg.dedupThreshold ?? 0.62)) continue;
        if (this.notes.length >= (this.cfg.maxNotesPerSection || 60) * (this.sections.length || 1)) continue;
        this.notes.push(cand);
        const cur = this.sections[this.sections.length - 1];
        if (cur) cur.noteIds.push(cand.id);
        added.push(cand);
      }
      if (added.length) this.emit('notes', added);
    } catch (e) {
      this.emit('error', { message: String(e.message || e) });
    } finally {
      this.extracting = false;
      // 提取期间又攒进来的内容，接着安排下一次，不要漏掉
      if (this.pending.trim() && this.state !== STATE.ENDED && this.state !== STATE.PAUSED) {
        this.scheduleExtract(this.cfg.extractIntervalMs || 15000);
      }
    }
  }

  async _extractItems(text) {
    if (this.usingLLM) {
      try {
        const titles = this.notes.map((n) => n.title);
        const data = await this.llm.chatJson([
          { role: 'system', content: SYSTEM_TUTOR },
          { role: 'user', content: buildExtractPrompt(text, titles, this.topic) },
        ], { maxTokens: 1200 });
        const items = Array.isArray(data.items) ? data.items : (Array.isArray(data) ? data : []);
        if (items.length || !text) return items.slice(0, 8);
      } catch (e) {
        this._handleLlmError(e);
      }
    }
    return LE.localExtract(text).items.slice(0, 8);
  }

  /* ---------------- 控制指令 ---------------- */

  /** 指令【暂停】：停止增量提取 + 汇总本小节 + 进入待命 */
  async pause() {
    if (this.state === STATE.ENDED) return this.snapshot();
    this._clearExtractTimer();
    await this.extract();
    await this._closeSection();
    this.state = STATE.PAUSED;
    this.emit('state', { state: this.state });
    const sec = this.sections[this.sections.length - 1];
    this.emit('section', sec);
    return this.snapshot();
  }

  /** 恢复听课（收到新文本也会自动恢复） */
  resume(silent = false) {
    if (this.state === STATE.ENDED) return this.snapshot();
    this.sections.push({ index: this.sections.length, title: '', summary: '', noteIds: [] });
    this.state = STATE.LISTENING;
    this.emit('state', { state: this.state });
    if (!silent) this.emit('log', { level: 'info', text: '已恢复听课' });
    return this.snapshot();
  }

  /** 指令【课程结束】：输出总笔记 + Mermaid 知识图谱 */
  async end() {
    this._clearExtractTimer();
    await this.extract();
    await this._closeSection();
    this.state = STATE.ENDED;
    try {
      await this._buildGraph();
    } catch (e) {
      this.emit('error', { message: `图谱生成失败：${e.message}` });
      this.graph = this._fallbackGraph();
    }
    this.emit('state', { state: this.state });
    this.emit('graph', this.graph);
    this.emit('ended', this.snapshot());
    return this.snapshot();
  }

  async _closeSection() {
    const sec = this.sections[this.sections.length - 1];
    if (!sec) return;
    const notes = sec.noteIds.map((id) => this.notes.find((n) => n.id === id)).filter(Boolean);
    if (!notes.length) return;
    let title = sec.title;
    let summary = sec.summary;
    try {
      if (this.usingLLM) {
        const data = await this.llm.chatJson([
          { role: 'system', content: SYSTEM_TUTOR },
          { role: 'user', content: buildSectionSummaryPrompt(notes) },
        ], { maxTokens: 600 });
        title = data.title || title;
        summary = data.summary || summary;
      } else {
        const r = LE.localSectionSummary(notes);
        title = r.title; summary = r.summary;
      }
    } catch (e) {
      const r = LE.localSectionSummary(notes);
      title = title || r.title; summary = summary || r.summary;
    }
    sec.title = title || `第 ${sec.index + 1} 节`;
    sec.summary = summary || '';
  }

  async _buildGraph() {
    let g;
    if (this.usingLLM && this.notes.length) {
      try {
        g = await this.llm.chatJson([
          { role: 'system', content: SYSTEM_TUTOR },
          { role: 'user', content: buildGraphPrompt(this.notes, this.topic) },
        ], { maxTokens: 1600 });
      } catch (e) {
        this._handleLlmError(e);
        g = null;
      }
    }
    if (!g || !g.nodes || !g.nodes.length) g = LE.localGraph(this.notes, this.topic);
    g.mermaid = buildMermaid(g, this.cfg.graphStyle || 'mindmap');
    g.topics = collectTopics(g);
    this.graph = g;
    if (!this.topic) this.topic = g.root || '';
    return g;
  }

  _fallbackGraph() {
    const g = LE.localGraph(this.notes, this.topic);
    g.mermaid = buildMermaid(g, this.cfg.graphStyle || 'mindmap');
    g.topics = collectTopics(g);
    return g;
  }

  /* ---------------- 知识图谱交互 ---------------- */

  /** 输入图谱内任意知识点名称 → 展开详情 */
  async queryTopic(topic) {
    const name = String(topic || '').trim();
    if (!name) return null;
    const notes = this.notes.filter(
      (n) => n.title.includes(name) || name.includes(n.title) || n.body.includes(name) ||
             (n.keywords || []).some((k) => name.includes(k) || k.includes(name))
    ).slice(0, 8);
    let detail;
    try {
      if (this.usingLLM) {
        detail = await this.llm.chatJson([
          { role: 'system', content: SYSTEM_TUTOR },
          { role: 'user', content: buildTopicDetailPrompt(name, notes, this.graph?.topics || []) },
        ], { maxTokens: 800 });
      } else {
        detail = LE.localTopicDetail(name, notes);
      }
    } catch (e) {
      detail = LE.localTopicDetail(name, notes);
    }
    detail.sourceNotes = notes.map((n) => n.id);
    this.emit('topic', detail);
    return detail;
  }

  /* ---------------- 输出 ---------------- */

  toMarkdown() {
    return toMarkdown({
      topic: this.topic,
      notes: this.notes,
      sections: this.sections,
      graph: this.graph,
    });
  }

  snapshot() {
    return {
      sessionId: this.sessionId,
      state: this.state,
      topic: this.topic,
      usingLLM: this.usingLLM,
      transcript: this.transcript,
      notes: this.notes,
      sections: this.sections,
      graph: this.graph,
      stats: {
        chars: this.transcript.reduce((s, x) => s + x.text.length, 0),
        notes: this.notes.length,
        sections: this.sections.length,
        elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      },
    };
  }
}
