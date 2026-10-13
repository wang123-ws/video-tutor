/** 轻量中文文本相似度：基于字符二元组(bigram)的 Jaccard 系数，无需分词库 */

const PUNCT = /[\s，。、；：？！“”"''（）()《》〈〉【】\[\]…—\-—_,.;:?!\/\\|]+/g;

export function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(PUNCT, '')
    .trim();
}

export function bigrams(text) {
  const s = normalize(text);
  const set = new Set();
  if (s.length < 2) {
    if (s) set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 0~1，越大越相似 */
export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  small.forEach((g) => { if (large.has(g)) inter++; });
  return inter / (A.size + B.size - inter);
}

/** 判断 candidate 是否与已有条目列表重复 */
export function isDuplicate(candidate, existing, threshold = 0.62) {
  const cText = `${candidate.title || ''} ${candidate.body || ''}`;
  for (const e of existing) {
    const eText = `${e.title || ''} ${e.body || ''}`;
    if (similarity(cText, eText) >= threshold) return true;
    // 标题高度重合也视为重复
    if (similarity(candidate.title || '', e.title || '') >= 0.8) return true;
  }
  return false;
}
