/**
 * Subsequence fuzzy match for the @-mention file picker. Returns null when
 * `query` is not a subsequence of `path`; otherwise a score where higher is
 * better — contiguous runs, path-segment starts, and basename matches rank up,
 * longer paths rank slightly down. Empty query scores 0 (caller keeps its own
 * ordering for the unfiltered list).
 */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  if (!q) return 0;
  const basenameStart = p.lastIndexOf("/") + 1;
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let pi = 0; pi < p.length && qi < q.length; pi += 1) {
    if (p[pi] !== q[qi]) {
      streak = 0;
      continue;
    }
    streak += 1;
    score += 1 + streak * 2;
    if (pi === 0 || p[pi - 1] === "/" || p[pi - 1] === "-" || p[pi - 1] === "_" || p[pi - 1] === ".") score += 5;
    if (pi >= basenameStart) score += 3;
    qi += 1;
  }
  if (qi < q.length) return null;
  return score - p.length * 0.01;
}
