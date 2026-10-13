/**
 * 本地规则引擎：没有 API Key / 余额不足时的兜底方案，零成本、离线可用。
 * 目标：从讲课口播中挑出关键句，剥掉口播套话，提炼成可读的短句笔记。
 */

/* ---------- 触发规则 ---------- */
const RULES = [
  {
    tag: '易错点',
    re: /(容易(错|搞混|混淆|弄错)|易错|是个?误区|常见错误|不要(把|误以为|误认为|以为)|千万别|误以为|误认为|很多人会错|不要(搞|弄)(错|混)|注意(不|别))/,
  },
  {
    tag: '拓展',
    re: /(拓展一下|补充(一点|一下|说明)|延伸|举一反三|顺便(说|提)|另外(还有|补充|要注意)|进阶|课外|感兴趣|补充一句)/,
  },
  {
    tag: '重点',
    re: /(考点|必考|常考|考试(会|常)|重点(掌握|记住|记|来了)|一定要(记住|掌握|会)|关键是|核心是|要记住|必须掌握)/,
  },
  {
    tag: '重点',
    re: /(定义(为|是|:)|所谓|指的是|就是指|就是说|叫做|称为|是指)/,
  },
  {
    tag: '重点',
    re: /(因此|所以|结论(是|就是)?|由此可见|可见|总之|总的来说|这说明|也就是说|总结一下)/,
  },
  {
    tag: '重点',
    re: /(区别于|不同于|不一样|而不是|相反|对比(来看|一下)|相比之下|前者|后者|这两个的?区别)/,
  },
];

const FORMULA_RE = /[＝=≈≡≤≥≠±×÷∑∫√∝∞∂∇]|(?<![\u4e00-\u9fa5])[a-zA-Z][_a-zA-Z0-9]*\s*(?:=|＝)|\^|²|³|\d+\s*[+\-*/×÷]\s*\d+\s*(?:=|＝)/;

/** 纯口播套话：标题与正文都要去掉 */
const FILLER = [
  /^(那么|所以|因此|然后|接着|而且|并且|其实|当然|也就是说|换句话说|总的来说|总结一下|可见|总之|这样的话|这时候|这样一来)+/,
  /^(同学们?|大家|各位|我们|我|你们)(?=[，,、：:]|$)/,
  /^(这里|这个地方|下面|接下来|现在|首先|其次|最后|还有一点|有一点|注意一下|要注意的是|需要注意?的是|大家注意|你(要|得|必须)(注意|记住)|千万要|一定要|记得|记住)/,
  /^(考点来了?|重点来了?|敲黑板|划重点|这(里)?(是|有)(个)?(重点|考点|易错点|误区)|易错点来了?)/,
  /^(我(们)?(再|来)?(说|讲|看|提|补充|拓展)(一下|一点)?|再(来|说|看)(一下|一点)?|我们(再|来)?(看|讲)(看|一下)?|让我(们)?(来)?(看|看|讲)(看|一下)?)/,
  /^(再)?(拓展一下|补充(一下|一点|一句)|延伸一下|举一反三|顺便(说|提)(一下|一句)?)/,
  /^(对比一下|比较一下|区分一下)/,
  /^(所谓)/,
  /^(这|那|它)(就是|也?是|指的是?)/,
  /^(需要|要|用|使用|采用|通过|进行|做|有|存在|包括|分为|分成)(?=[\s\S]{5,})/,
];

/** 只用于标题提取的额外剥离（这些词带有重要语义，正文要保留） */
const TITLE_ONLY = [
  /^(很多(同学|人)(会)?|有些同学|有的人)(误以为|以为|认为|觉得|觉得是)?/,
  /^(不要|别)(误以为|以为|认为|觉得)?/,
  /^(其实|实际上|事实上)/,
  /^(所谓)/,
  /^(如果|假如)/,
];

const META_WORDS = /(重点|考点|易错点|误区|注意|拓展|补充|延伸|小结|总结|问题|情况|时候|地方|东西|这个|那个|一下|一点|为什么|为何|如何|怎样|所谓|需要)/;

/** 疑问句式：整句即标题 */
const QUESTION_RE = /^(为什么|为何|怎么|怎样|如何).{4,}?[？?]/;

function stripOnce(s) {
  let out = s;
  for (let i = 0; i < 4; i++) {
    let hit = false;
    for (const re of FILLER) {
      const m = out.match(re);
      if (m && m[0]) { out = out.slice(m[0].length); hit = true; break; }
    }
    out = out.replace(/^[\s，,、：:。.；;！!？?]+/, '');
    if (!hit) break;
  }
  return out.trim();
}

function stripTitleOnly(s) {
  let out = s;
  for (let i = 0; i < 3; i++) {
    let hit = false;
    for (const re of TITLE_ONLY) {
      const m = out.match(re);
      if (m && m[0]) { out = out.slice(m[0].length); hit = true; break; }
    }
    if (!hit) break;
  }
  return out.trim();
}

/** 把一段文本切成句子 */
export function splitSentences(text) {
  const out = [];
  const src = String(text || '').replace(/\s+/g, ' ');
  let buf = '';
  for (const ch of src) {
    buf += ch;
    if ('。！？；!?;'.includes(ch)) { if (buf.trim().length >= 6) out.push(buf.trim()); buf = ''; }
  }
  if (buf.trim().length >= 6) out.push(buf.trim());
  return mergeShort(out);
}

/** 口播里大量“这是面试常考的题。”这类短句，信息量不足，并入上一句 */
function mergeShort(sentences) {
  const out = [];
  for (const s of sentences) {
    const prev = out[out.length - 1];
    if (prev && (s.length < 15 || prev.length < 15) && prev.length + s.length < 110) {
      out[out.length - 1] = prev + s;
    } else {
      out.push(s);
    }
  }
  return out;
}

/** 标题提取：优先抓“X 是 Y / X 指的是 Y”里的 X */
function makeTitle(sentence) {
  let t = stripOnce(sentence);
  t = stripTitleOnly(t);

  // 疑问句：整句作为标题
  const q = t.match(QUESTION_RE);
  if (q) return q[0].replace(/[？?]$/, '').slice(0, 18);

  // 定义/判断结构：取分隔符之前的主语
  const def = t.match(/^(.{2,16}?)[，,、]?\s*(是|就是|指的是|就是说|也就是|定义为|叫做|称为|即)(.+)$/);
  if (def) {
    const head = def[1].replace(/[，,、]$/, '').trim();
    if (head.length >= 2 && !META_WORDS.test(head)) return head.slice(0, 18);
  }
  const colon = t.match(/^(.{2,16}?)[：:](.+)$/);
  if (colon) {
    const head = colon[1].trim();
    if (head.length >= 2 && !META_WORDS.test(head)) return head.slice(0, 18);
    return makeTitle(colon[2]); // 冒号前是“易错点”这类元话语，用后半段继续提
  }
  const comma = t.split(/[，,。！？；;]/)[0].trim();
  return (comma || t).slice(0, 18);
}

function makeBody(sentence, cut = 66) {
  let s = stripOnce(sentence).replace(/[。！？；,，]+$/, '').trim();
  // 类别已由标签表达，正文里不再重复“易错点：”这类前缀
  s = s.replace(/^[个一两]?\s*(易错点|重点|考点|误区|拓展|补充|注意点?|小结)\s*[：:，,]?\s*/, '');
  // 优先保留“不是…而是 / 其实不是”这类辨析尾巴
  return s.length > cut ? s.slice(0, cut) + '…' : s;
}

const STOP = new Set(['我们','你们','他们','大家','同学','老师','这个','那个','然后','就是','可以','因为','但是','如果','这样','那么','现在','这里','那里','什么','怎么','一下','一个','没有','不是','所以','而且','还是','并且','其实','当然','比如','例如','进行','通过','需要','应该','时候','问题','地方','东西','之后','之前']);

/** 虚词/元话语：不该作为知识点的关键词 */
const VIRTUAL = /(重点|考点|易错点|误区|注意|拓展|补充|延伸|小结|总结|这个|那个|一下|一点|所以|需要|因此|然后|就是|可以|我们|大家|同学|通过|应该|所谓|分别|还有|另外|其实|实际|事实|为什么|如何|怎样|不是|而是|如果|假如|因为|而且|并且|接着|接下来|现在|首先|其次|最后|常考|必考|面试|题目|考试)/;

function keywordsOf(text) {
  const set = new Set();
  // 英文 / 数字类专业词优先，无条件保留
  (text.match(/[A-Za-z][A-Za-z0-9_-]{1,}|[A-Z]{2,}/g) || [])
    .forEach((w) => { if (w.length >= 2) set.add(w); });
  String(text).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ')
    .split(/\s+/)
    .forEach((w) => {
      if (w.length < 2 || w.length > 4) return;
      if (/^\d+$/.test(w)) return;
      if (STOP.has(w) || VIRTUAL.test(w)) return;
      set.add(w);
    });
  return Array.from(set).slice(0, 6);
}

/** 本地增量提取 */
export function localExtract(text) {
  const sentences = splitSentences(text);
  const items = [];
  const seen = new Set();

  for (const s of sentences) {
    if (FORMULA_RE.test(s)) {
      const key = s.slice(0, 22);
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ tag: '重点', title: makeTitle(s) || '公式', body: makeBody(s, 72), keywords: keywordsOf(s) });
      }
      continue;
    }
    for (const rule of RULES) {
      if (rule.re.test(s)) {
        const key = s.slice(0, 22);
        if (seen.has(key)) break;
        seen.add(key);
        items.push({ tag: rule.tag, title: makeTitle(s), body: makeBody(s), keywords: keywordsOf(s) });
        break;
      }
    }
  }
  return { items, topicHint: null };
}

/** 本地知识图谱：按高频关键词聚类成一级知识点 */
export function localGraph(notes, topic = '') {
  if (!notes || !notes.length) return { root: topic || '课程知识图谱', nodes: [] };
  const freq = new Map();
  notes.forEach((n) => (n.keywords || []).forEach((k) => freq.set(k, (freq.get(k) || 0) + 1)));

  const top = Array.from(freq.entries())
    .filter(([k]) => k.length >= 2 && !/^\d+$/.test(k))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  const used = new Set();
  const nodes = [];
  for (const [k] of top) {
    const children = notes
      .filter((n) => (n.keywords || []).includes(k) || n.title.includes(k) || n.body.includes(k))
      .slice(0, 4)
      .map((n) => { used.add(n.id); return { name: n.title.slice(0, 14) }; });
    if (children.length) nodes.push({ name: k.slice(0, 14), children });
  }
  const rest = notes.filter((n) => !used.has(n.id));
  if (rest.length) {
    nodes.push({
      name: nodes.length ? '其他要点' : '核心知识',
      children: rest.slice(0, 6).map((n) => ({ name: n.title.slice(0, 14) })),
    });
  }
  return { root: topic || '课程知识图谱', nodes: nodes.slice(0, 8) };
}

/** 本地小结 */
export function localSectionSummary(notes) {
  if (!notes.length) return { title: '本小节', summary: '本小节暂无笔记。' };
  const count = { 重点: 0, 易错点: 0, 拓展: 0 };
  notes.forEach((n) => { if (count[n.tag] != null) count[n.tag]++; });
  const titles = notes.slice(0, 6).map((n) => n.title).join('、');
  return {
    title: notes[0].title.slice(0, 12) || '本小节',
    summary: `本小节共 ${notes.length} 条笔记（重点 ${count.重点}／易错点 ${count.易错点}／拓展 ${count.拓展}）。核心内容：${titles}。`,
  };
}

/** 本地知识点详情 */
export function localTopicDetail(topic, notes) {
  const hit = notes.filter(
    (n) => n.title.includes(topic) || n.body.includes(topic) ||
           (n.keywords || []).some((k) => topic.includes(k) || k.includes(topic))
  );
  const related = Array.from(new Set(hit.flatMap((n) => n.keywords || [])))
    .filter((k) => k !== topic && !topic.includes(k)).slice(0, 4);
  return {
    topic,
    definition: hit[0] ? hit[0].body : '（本地模式）暂无该知识点定义。配置 API Key 后由大模型生成完整详情。',
    example: hit[1] ? hit[1].body : '（本地模式）未识别到示例。',
    examPoints: hit.filter((n) => n.tag === '易错点').map((n) => n.title).join('、') || '注意概念辨析与公式适用条件。',
    related: related.length ? related : ['（无）'],
  };
}
