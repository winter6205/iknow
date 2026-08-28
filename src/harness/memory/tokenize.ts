const TOKEN_RUN =
  /[a-z0-9_]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_RUN =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

/**
 * Tokenize memory text using the BM25 and ingest-neighbor rules.
 *
 * ASCII words keep the original lowercased, two-character minimum. Each
 * maximal CJK run emits overlapping bigrams, except a one-character run,
 * which emits that character.
 */
export function tokenize(s: string): readonly string[] {
  if (!s) return [];

  const out: string[] = [];
  for (const match of s.toLowerCase().matchAll(TOKEN_RUN)) {
    const run = match[0];
    if (!CJK_RUN.test(run)) {
      if (run.length >= 2) out.push(run);
      continue;
    }

    const chars = Array.from(run);
    if (chars.length === 1) {
      out.push(chars[0]!);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      out.push(`${chars[i]}${chars[i + 1]}`);
    }
  }
  return out;
}
