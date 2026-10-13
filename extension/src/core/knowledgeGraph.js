/**
 * Mermaid 知识图谱生成。
 * 层级固定：主课题 → 一级知识点 → 子要点
 */

function safe(text) {
  return String(text || '')
    .replace(/[()（）]/g, ' ')
    .replace(/["'`]/g, '')
    .replace(/[{}[\]|]/g, ' ')
    .replace(/[;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '未命名';
}

/** nodes: [{name, children:[{name}]}] */
export function buildMindmap(graph) {
  const root = safe(graph.root || '课程主题');
  const lines = ['mindmap', `  root((${root}))`];
  (graph.nodes || []).forEach((n) => {
    lines.push(`    ${safe(n.name)}`);
    (n.children || []).forEach((c) => {
      lines.push(`      ${safe(c.name)}`);
    });
  });
  return lines.join('\n');
}

export function buildFlowchart(graph) {
  const root = safe(graph.root || '课程主题');
  const lines = ['flowchart LR', `  R["${root}"]`];
  let i = 0;
  (graph.nodes || []).forEach((n) => {
    const id = `N${i++}`;
    lines.push(`  R --> ${id}["${safe(n.name)}"]`);
    let j = 0;
    (n.children || []).forEach((c) => {
      lines.push(`  ${id} --> ${id}_${j++}["${safe(c.name)}"]`);
    });
  });
  return lines.join('\n');
}

export function buildMermaid(graph, style = 'mindmap') {
  return style === 'flowchart' ? buildFlowchart(graph) : buildMindmap(graph);
}

/** 从图谱中收集所有知识点名称，供交互查询用 */
export function collectTopics(graph) {
  const out = [];
  if (graph && graph.root) out.push(graph.root);
  (graph?.nodes || []).forEach((n) => {
    if (n.name) out.push(n.name);
    (n.children || []).forEach((c) => { if (c.name) out.push(c.name); });
  });
  return Array.from(new Set(out));
}

/** 导出 Markdown 版课程笔记 */
export function toMarkdown(state) {
  const L = [];
  L.push(`# ${state.topic || state.graph?.root || '课程笔记'}`);
  L.push('');
  L.push(`> 生成时间：${new Date().toLocaleString()}　|　笔记条数：${state.notes.length}　|　小节数：${state.sections.length}`);
  L.push('');
  state.sections.forEach((s, i) => {
    L.push(`## 第 ${i + 1} 节　${s.title || ''}`);
    if (s.summary) L.push(`\n**本小节小结：** ${s.summary}\n`);
    s.noteIds.forEach((id) => {
      const n = state.notes.find((x) => x.id === id);
      if (!n) return;
      L.push(`- 【${n.tag}】**${n.title}** — ${n.body}`);
    });
    L.push('');
  });
  const sectioned = new Set(state.sections.flatMap((s) => s.noteIds));
  const rest = state.notes.filter((n) => !sectioned.has(n.id));
  if (rest.length) {
    L.push('## 其他笔记');
    rest.forEach((n) => L.push(`- 【${n.tag}】**${n.title}** — ${n.body}`));
    L.push('');
  }
  if (state.graph) {
    L.push('## 知识图谱（Mermaid）');
    L.push('');
    L.push('```mermaid');
    L.push(state.graph.mermaid);
    L.push('```');
  }
  return L.join('\n');
}
