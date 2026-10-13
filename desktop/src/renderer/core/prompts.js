/** 助教提示词：全部围绕“提炼骨架、精简短句、禁止复述”设计 */

export const SYSTEM_TUTOR = `你是【视频陪学AI助教】。你只接收课程讲课的转写文本，实时提炼知识点，维护结构化笔记。

工作规则：
1. 只从文本中抓取：核心定义、关键结论、公式、考点、对比辨析、易错点。
2. 笔记必须是精简短句，提炼骨架，禁止大段复述原文，禁止客套话。
3. 每条笔记打且只打一个标签，取值范围严格为：重点、易错点、拓展。
   - 重点：核心定义、关键结论、公式、考点
   - 易错点：易混淆、易踩坑、常见错误
   - 拓展：延伸补充、背景知识、举一反三
4. 与“已有笔记”语义重复的知识点必须丢弃，不要重复记录。
5. 没有值得记的内容就返回空数组，不要硬凑。
6. 输出必须是合法 JSON，不要输出任何解释、不要输出 markdown 代码块标记。`;

export function buildExtractPrompt(text, existingTitles, courseTopic) {
  const exist = existingTitles && existingTitles.length
    ? `\n已有笔记标题（这些知识点不要再重复输出）：\n- ${existingTitles.slice(-40).join('\n- ')}`
    : '';
  const topic = courseTopic ? `\n本课程主题：${courseTopic}` : '';
  return `${topic}${exist}

以下是最新一段讲课转写文本，请提炼其中的知识点：

"""
${text}
"""

严格按如下 JSON 格式输出：
{"items":[{"tag":"重点|易错点|拓展","title":"不超过18字的知识点标题","body":"不超过60字的要点说明","keywords":["关键词1","关键词2"]}]}`;
}

export function buildSectionSummaryPrompt(sectionNotes) {
  const list = sectionNotes
    .map((n, i) => `${i + 1}. [${n.tag}] ${n.title}：${n.body}`)
    .join('\n');
  return `以下是本小节已记录的笔记，请输出本小节小结（80~150字，讲清本小节讲了什么、重点是什么、需要注意什么）：

${list}

严格按如下 JSON 格式输出：
{"title":"小节标题（不超过15字）","summary":"本小节小结正文"}`;
}

export function buildGraphPrompt(allNotes, courseTopic) {
  const list = allNotes
    .map((n) => `[${n.tag}] ${n.title}：${n.body}`)
    .join('\n');
  return `${courseTopic ? `课程主题：${courseTopic}\n` : ''}以下是整门课程的全部笔记：

${list}

请把它们组织成知识图谱，层级严格固定为三层：主课题 → 一级知识点 → 子要点。
- 主课题：整门课程的主题，1 个
- 一级知识点：3~8 个，是课程的主要模块
- 每个一级知识点下 2~5 个子要点，子要点必须是具体的知识点（定义、结论、公式、考点、易错点）
- 名称全部使用简短中文，不超过 14 字，不要带标签符号

严格按如下 JSON 格式输出：
{"root":"主课题名称","nodes":[{"name":"一级知识点","children":[{"name":"子要点"},{"name":"子要点"}]}]}`;
}

export function buildTopicDetailPrompt(topic, notes, related) {
  const ctx = notes.map((n) => `- [${n.tag}] ${n.title}：${n.body}`).join('\n');
  const rel = related && related.length ? related.join('、') : '（无）';
  return `课程笔记中与「${topic}」相关的记录：
${ctx || '（无直接记录，请依据课程主题合理说明）'}

关联知识点：${rel}

请单独展开「${topic}」的详情，包含：定义、例子、考点、关联知识点。
每项 1~2 句，精简短句，不要复述原文。

严格按如下 JSON 格式输出：
{"topic":"${topic}","definition":"定义","example":"例子","examPoints":"考点","related":["关联知识点1","关联知识点2"]}`;
}
