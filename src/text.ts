/** 编辑距离(Levenshtein),用于"你是不是想写 X"的拼写建议 */
export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j]!;
      prev[j] = Math.min(above + 1, prev[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[b.length]!;
}

/**
 * 在候选里找与 input 最接近的一个(忽略大小写)。
 * 距离阈值:长度 ≤4 时为 1,否则为 2。找不到足够接近的返回 undefined。
 * input 本身就在候选中时返回 undefined(调用方应先判断是否存在)。
 */
export function closestMatch(input: string, candidates: Iterable<string>): string | undefined {
  const lower = input.toLowerCase();
  const maxDistance = input.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    if (candidate === input) continue;
    if (Math.abs(candidate.length - input.length) > maxDistance) continue;
    const distance = levenshtein(lower, candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
      if (distance === 0) break;
    }
  }
  return best;
}
