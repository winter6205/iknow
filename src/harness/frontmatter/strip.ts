/**
 * `---` fence slicing for frontmatter (ADR-0123).
 *
 * Contract (the frontmatter fence strip contract in docs/CONTEXT.md): content-independent, never
 * throws, and returns the body as an exact byte slice of the input — an invalid
 * YAML block is stripped anyway, because `skill()` body assembly, third-party
 * skill-load envelope parsing and KV-cache prefix stability depend on those
 * bytes. No YAML parser is used here on purpose.
 */

/**
 * Fence shape shared by the three hand-rolled copies it replaces (skill
 * scanner, skill body, subagent user-catalog). Not `/g`: a sticky lastIndex
 * would make repeated calls disagree about the same text.
 */
const FENCE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** Result of one fence slice; `found` separates "no fence" from "empty fence". */
export interface FenceStrip {
  /** Whether a `---` fence was matched at the start of the text. */
  readonly found: boolean;
  /** Text between the fences (`""` when the fence is empty or absent). */
  readonly block: string;
  /** Body after the fence; the whole input when `found` is false. */
  readonly body: string;
}

/** Cut the leading `---` fence out of `raw`; never throws. */
export function stripFence(raw: string): FenceStrip {
  const match = FENCE.exec(raw);
  // EXIT: no fence at the start → `found: false`, empty block, body = the whole
  // input, so a caller that needs the bytes still gets them.
  if (!match) return { found: false, block: "", body: raw };
  return { found: true, block: match[1], body: raw.slice(match[0].length) };
}
