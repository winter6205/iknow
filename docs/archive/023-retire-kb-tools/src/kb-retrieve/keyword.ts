/** Lightweight keyword scorer (standalone; not BM25 full port). */

/** Common Chinese bigrams that should not alone justify a hit. */
const CJK_STOP_BIGRAMS = new Set([
  "公司",
  "我们",
  "你们",
  "他们",
  "什么",
  "怎么",
  "如何",
  "可以",
  "需要",
  "进行",
  "如果",
  "因为",
  "所以",
  "一个",
  "没有",
  "有没",
  "一份",
  "这个",
  "那个",
  "以及",
  "或者",
  "还是",
  "是否",
  "关于",
  "根据",
  "相关",
  "内容",
  "问题",
  "工作",
  "使用",
  "通过",
  "之后",
  "之前",
  "目前",
  "现在",
  "已经",
  "可能",
  "应该",
  "必须",
  "不能",
  "不是",
  "就是",
  "还是",
  "自己",
  "其他",
  "部分",
  "全部",
  "所有",
  "任何",
  "根本",
  "存在",
  "不存",
  "在的",
  "有一",
  "们公",
  "司有",
]);

/**
 * Tokenize for mixed Chinese/English:
 * - whitespace / latin tokens
 * - CJK bigrams + trigrams + 4-grams
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const cleaned = lower.replace(/[^\p{L}\p{N}\s]+/gu, " ");
  for (const t of cleaned.split(/\s+/)) {
    if (t.length === 0) continue;
    // Skip pure-Han mega-tokens from continuous runs (covered by n-grams)
    if (/^\p{Script=Han}+$/u.test(t) && t.length > 4) continue;
    tokens.push(t);
  }
  const hans = lower.match(/\p{Script=Han}+/gu) ?? [];
  for (const run of hans) {
    for (let i = 0; i < run.length - 1; i++) {
      tokens.push(run.slice(i, i + 2));
    }
    if (run.length >= 3) {
      for (let i = 0; i < run.length - 2; i++) {
        tokens.push(run.slice(i, i + 3));
      }
    }
    if (run.length >= 4) {
      for (let i = 0; i < run.length - 3; i++) {
        tokens.push(run.slice(i, i + 4));
      }
    }
  }
  return tokens;
}

export type IdfFn = (term: string) => number;

/**
 * Build a simple IDF lookup from a corpus of texts.
 * idf(t) = log(1 + N / (1 + df(t)))
 */
export function buildIdf(corpusTexts: string[]): IdfFn {
  const N = Math.max(1, corpusTexts.length);
  const df = new Map<string, number>();
  for (const text of corpusTexts) {
    const seen = new Set(tokenize(text));
    for (const t of seen) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return (term: string) => {
    const d = df.get(term) ?? 0;
    return Math.log(1 + N / (1 + d));
  };
}

function isStopTerm(term: string): boolean {
  return CJK_STOP_BIGRAMS.has(term);
}

export function scoreKeyword(
  query: string,
  documentText: string,
  idf: IdfFn = () => 1,
): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const d = tokenize(documentText);
  if (d.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const t of d) {
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }

  let score = 0;
  let contentHits = 0;
  for (const term of q) {
    if (isStopTerm(term)) continue;
    const f = freq.get(term) ?? 0;
    if (f <= 0) continue;
    const lenW = term.length >= 4 ? 3.5 : term.length >= 3 ? 2.2 : 1;
    const idfW = idf(term);
    score += lenW * idfW * (1 + Math.log(1 + f));
    // Content hit: multi-char non-stop, with reasonable rarity or length
    if (term.length >= 2 && (term.length >= 3 || idfW >= 1.4)) {
      contentHits += 1;
    }
  }
  if (contentHits === 0) return 0;
  return score;
}

/** Pseudo-vector arm: weighted Jaccard preferring rare content terms. */
export function scoreOverlap(
  query: string,
  documentText: string,
  idf: IdfFn = () => 1,
): number {
  const q = new Set(tokenize(query));
  const d = new Set(tokenize(documentText));
  if (q.size === 0 || d.size === 0) return 0;
  let interW = 0;
  let qW = 0;
  let contentInter = 0;
  for (const t of q) {
    if (isStopTerm(t)) continue;
    const w = idf(t) * (t.length >= 3 ? 1.5 : 1);
    qW += w;
    if (d.has(t)) {
      interW += w;
      contentInter += 1;
    }
  }
  if (contentInter === 0) return 0;
  const unionApprox = qW + d.size * 0.3;
  return unionApprox === 0 ? 0 : interW / unionApprox;
}
