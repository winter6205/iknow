/**
 * Line-window filtering for the `also` term: `also` + `within_lines`.
 *
 * The semantics are **filtering**, not display — after a primary-pattern hit,
 * the second term must be found inside the closed window centred on that line
 * with radius `within_lines`; no second term in the window → the hit does not
 * count. Nearby raw text is not brought into the result (that is `context`'s
 * job), and no bare cross-line regex is attempted.
 *
 * Engine-decoupled: the input is hit lines plus a "give me all lines of this
 * path" callback. Both the rg engine and the Node fallback share this layer —
 * pipeline.applyAlsoFilter feeds the normalised hits of either engine through
 * it (running `also` as a JS RegExp). The two engines may hit different sets,
 *
 // (ADR-0089)
 * and the surviving count after filtering may differ accordingly — that is an
 * accepted contract of the dual-engine design; this layer only decides whether
 * the second term exists inside the window, it does not pick an engine.
 *
 * Note the **asymmetric acceptance sets** of `also` vs the main pattern: on
 * the rg path the main pattern's legality is judged by rg itself (constructs
 * rg accepts but JS rejects can still work; see the lazy compile in grep.ts),
 * but `also` is always run here with a JS `RegExp` regardless of engine — it
 * is the second-term predicate and has no rg-side counterpart. So an
 * uncompilable `also` means a typed rejection even when the main pattern went
 * through rg.
 */

import { ToolExecutionError } from "../../errors.js";
import { compilePattern } from "./pattern.js";
import type { LineHit } from "./types.js";

export interface AlsoWindowInput {
  readonly matches: ReadonlyArray<LineHit>;
  readonly also: RegExp;
  readonly withinLines: number;
  /** All lines of the file (1-based line number = index + 1); unreadable → null. */
  readonly readLines: (path: string) => ReadonlyArray<string> | null;
}

/** Keep primary hits whose window contains a second-term match; input order preserved. */
export function filterHitsByAlsoWindow(input: AlsoWindowInput): LineHit[] {
  const cache = new Map<string, ReadonlyArray<string> | null>();
  const linesFor = (path: string): ReadonlyArray<string> | null => {
    if (!cache.has(path)) cache.set(path, input.readLines(path));
    return cache.get(path) ?? null;
  };

  return input.matches.filter((hit) => {
    const lines = linesFor(hit.path);
    if (lines === null) return false;
    const from = Math.max(1, hit.line - input.withinLines);
    const to = Math.min(lines.length, hit.line + input.withinLines);
    for (let line = from; line <= to; line++) {
      const text = lines[line - 1];
      if (text !== undefined && input.also.test(text)) return true;
    }
    return false;
  });
}

/**
 * Compile the `also` text into a regex (same conventions as the main
 * `pattern`: case-sensitive by default, `ignoreCase` shared, mode decision
 * from the same source).
 *
 * `also` is a **literal second term**, not a wide regex like the main pattern:
 * it is only `test()`ed inside also-window.ts, shared by both engines, so no
 * rg argv switch is involved (this module's decisions are not projected onto
 * rg). The window check runs only on the Node side (rg emits hits for the main
 * pattern alone), so using the same compilation as the main pattern —
 *
 // (ADR-0089)
 * including the `u` rules and fallback — suffices; any difference from rg's
 * hit set is the accepted dual-engine contract.
 *
 * A bad regex → typed rejection whose message names `also` — distinct from the
 * main pattern's error, and from the unknown-`type` error (the two error kinds
 * must not be conflated).
 */
export function expandAlsoNeedle(also: string, ignoreCase: boolean): RegExp {
  try {
    return compilePattern(also, ignoreCase);
  } catch {
    throw new ToolExecutionError(
      `grep: invalid also pattern: ${also} (the main pattern was fine; fix the also expression)`
    );
  }
}
