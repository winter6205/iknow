/**
 * Shared text invariants the pad tests assert on, in the conventions the pad
 * reader itself uses (`pad-inspect.ts` owns the window/budget pair and the
 * code-point boundary rule). Kept in one module so a change to the reader's
 * counting convention has exactly one test-side mirror to update.
 */

/**
 * Content-line count in the pad reader's convention: a trailing newline is a
 * line terminator, not an extra empty line.
 */
export function padLineCount(text: string): number {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/**
 * True when `text` contains a surrogate that lost its pair — the corruption a
 * byte/char-count-based cut would introduce. Both the pad write ("without
 * dropped, duplicated, or split Unicode content") and the page boundary must
 * never produce one: a split code point is unreadable at the consumer and
 * cannot be re-joined by the reader.
 */
export function hasLoneSurrogate(text: string): boolean {
  for (let idx = 0; idx < text.length; idx += 1) {
    const code = text.charCodeAt(idx);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(idx + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      idx += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** UTF-16 code units — the measure both the IPC fold and the page budget use. */
export function utf16Units(text: string): number {
  return text.length;
}
