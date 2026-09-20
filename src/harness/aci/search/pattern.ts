/**
 * Main pattern compilation.
 *
 // (ADR-0089)
 *
 * After the contract narrowed, this module has only two responsibilities:
 *   - compile `pattern` + `ignoreCase` into a JS `RegExp`; bad regex → typed
 *     rejection;
 *   - decide "should the Node side add the `u` flag" (`keepsUnicodeMode`).
 *
 * This module **covers the Node path only**. The rg path reads none of its
 * tests: rg runs its own default Unicode semantics, with no `--no-unicode`-
 * style mode switches to force agreement with JS — such alignment levers are
 *
 // (ADR-0089)
 * prohibited. The two engines may therefore return different hit sets for the
 * same pattern; that is an accepted contract, not a missing test.
 *
 * The engines no longer attempt to judge identically: with rg present, matches
 * come from rg only and rg's own pattern errors are reported by the rg
 * subprocess as rc=2; with rg absent, Node scans files via `RegExp`, the call
 * still succeeds, and the hit set may differ from rg's — Node does **not**
 * imitate rg's default-engine rejection set. The release gate is the
 * production handler `createGrepTool`, not any "both engines agree" fuzz.
 *
 * The `u`-flag test remains because JS without `u` matches by code unit, so
 * `.`, counted quantifiers, and character classes misread lines containing
 * multi-byte characters (verified: `a.c` does not match `aéc`, `^.{3}$` does
 * not match `e`+combining+`x`). When the test is true we try adding `u` first:
 * a **semantic fix** on the Node side, not cross-engine alignment.
 */

import { ToolExecutionError } from "../../errors.js";

/**
 * Compile the main pattern; bad regex → typed rejection (message includes the
 * raw pattern).
 *
 * The `u` flag is added only when the pattern contains multi-byte-sensitive
 * constructs (`keepsUnicodeMode`) — only then do JS's `.` / counted
 * quantifiers / character classes match by code point. This is the Node path's
 *
 // (ADR-0089)
 * own semantic fix; the rg path neither reads this test nor gets any
 * corresponding switch.
 *
 * Add it only if it compiles: `u` tightens the grammar, so `{` / `]` / `\A` /
 * `\q` / `\u` fail to compile under it — hence **try with `u` first, fall back
 * to without `u`** on failure. The accepted set only grows, never shrinks; no
 * pattern exists that compiled yesterday but is rejected today.
 */
export function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  const base = ignoreCase ? "i" : "";
  if (keepsUnicodeMode(pattern)) {
    const unicode = tryCompile(pattern, `${base}u`);
    if (unicode !== null) return unicode;
  }
  const plain = tryCompile(pattern, base);
  if (plain !== null) return plain;
  throw new ToolExecutionError(`grep: invalid pattern: ${pattern}`);
}

/** Return it if it compiles; null otherwise (the caller picks the fallback). */
function tryCompile(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Whether Node-side compilation should add the `u` flag — this module's
 * **only** mode test, applying solely to `compilePattern`.
 *
 * `true` (contains multi-byte-sensitive constructs: `.` / `\s` / `\S` / `\u` /
 * `\x` / non-ASCII / negated classes) → Node compilation **adds** `u`,
 * otherwise `.` / counted quantifiers stay on code units (verified: `a.c` does
 * not match `aéc`).
 * `false` → Node does not add `u` (adding it would fold in KELVIN / LONG S,
 * see below).
 *
 * There is **no corresponding switch on the rg side**: this test is no longer
 * projected onto rg argv. rg always runs its own default Unicode semantics
 * (`\w` / `\d` / `\b` recognize non-ASCII word chars) while Node runs JS
 *
 // (ADR-0089)
 * semantics — hit sets for the same pattern may differ; that is the accepted
 * contract.
 *
 * Err conservative: **better not add than add wrongly** (`u` tightens the
 * grammar; see the fallback rule in `compilePattern`).
 *
 * ignoreCase boundary (verified, pure Node side):
 *   - `i` × `u` folds U+212A KELVIN / U+017F LONG S into `k` / `s` (verified:
 *     `new RegExp("k","iu").test("\u212A")` is true) — rg's default simple
 *     case folding also folds (verified: `rg -i k` hits `Kx`), so adding `u`
 *     when the test is true agrees with rg under ignoreCase.
 *     When the test is false, Node does not add `u`, and `-i k` does not fold
 *     KELVIN — here Node is narrower than rg, an accepted hit-set difference.
 *
 * This test applies **only** to the Node-side `u` flag; the rg path does not
 * read it — the rg subprocess handles its own pattern errors with its default
 * Unicode semantics (rc=2). The two engines may therefore return different hit
 *
 // (ADR-0089)
 * sets for the same pattern; an accepted contract.
 */
export function keepsUnicodeMode(pattern: string): boolean {
  return hasMultiByteSensitiveConstruct(pattern);
}

/**
 * Scan the pattern for constructs whose match unit may be a multi-byte
 * character — a hit means Node compilation gets `u`.
 *
 * Two **unrelated** tests:
 *   - escape class (`hasSensitiveEscape`): `\s` / `\S` / `\u` / `\x` change
 *     meaning without `u`; `\d` / `\w` / `\b` **do not count** (JS already
 *     treats them as ASCII without `u`, and adding `u` would fold in KELVIN /
 *     LONG S). Escapes are orthogonal to brackets (`[\s]` is equally
 *     sensitive), so this is a separate pass;
 *   - literal class (`hasSensitiveLiteral`): `.` and non-ASCII literals
 *     (without `u`, `.` eats a single code unit), `[^...]` / `[!...]` (negated
 *     classes judge by code unit without `u`), non-ASCII members inside
 *     `[...]`.
 */
function hasMultiByteSensitiveConstruct(pattern: string): boolean {
  return hasSensitiveEscape(pattern) || hasSensitiveLiteral(pattern);
}

/** Any `\s` / `\S` / `\u` / `\x` is sensitive (including inside classes). Strip paired backslashes first; `\\s` does not count. */
function hasSensitiveEscape(pattern: string): boolean {
  return /\\[sSux]/.test(pattern.replace(/\\\\/g, ""));
}

/** Char-by-char walk over `.` / non-ASCII / negated class / non-ASCII in class; the `[...]` state is maintained by this pass. */
function hasSensitiveLiteral(pattern: string): boolean {
  const chars = [...pattern];
  let inClass = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === "\\") {
      i += 1; // skip the escape pair as a whole; `\.` does not count as "dot"
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      else if (isMultiByte(ch)) return true;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      const opened = openClass(chars, i);
      if (opened.sensitive) return true;
      i += opened.skip;
      continue;
    }
    if (isSensitiveLiteral(ch)) return true;
  }
  return false;
}

/**
 * At the start of `[...]`: a negated class (`[^` / `[!`) matches by code unit
 * without `u` → sensitive; in `[]]` the first `]` is a literal member (rg
 * syntax, same rationale as glob-match), so it must be skipped.
 */
function openClass(
  chars: ReadonlyArray<string>,
  i: number
): { sensitive: boolean; skip: number } {
  if (chars[i + 1] === "^" || chars[i + 1] === "!") {
    return { sensitive: true, skip: 0 };
  }
  return { sensitive: false, skip: chars[i + 1] === "]" ? 1 : 0 };
}

function isSensitiveLiteral(ch: string): boolean {
  return ch === "." || isMultiByte(ch);
}

function isMultiByte(ch: string): boolean {
  return (ch.codePointAt(0) ?? 0) > 0x7f;
}
