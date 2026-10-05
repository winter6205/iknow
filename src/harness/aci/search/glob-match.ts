/**
 * Node-engine implementation of `--glob`.
 *
 * Semantics pinned against real ripgrep behaviour (not invented):
 *   - **A pattern containing `/` anchors to the search root**: `src/*.ts`
 *     matches only one level inside `src/`.
 *   - **A pattern without `/` matches the basename at any depth**: `*.ts`
 *     matches `a.ts` and `x/y/a.ts`.
 *   - **A `!` prefix negates**; when mixed with positives, collect then remove.
 *   - `**` crosses segments; `*` / `?` are within-segment wildcards.
 *
 * This layer and the `--glob` handling in `argv.ts` are two implementations of
 * one contract: the rg engine defers to rg itself, the Node engine goes here.
 * If the two diverge, cross-engine equivalence fails.
 */

import { ToolExecutionError } from "../../errors.js";

/**
 * Glob syntax validation (**shared by both engines**, hence called at the
 * parsing layer, see `options.ts`).
 *
 * Rationale: rg fails the whole run with rc=2 on a malformed glob, it does not
 * degrade to "no match". If only the Node engine treated a bad glob as a
 * literal, the outcome of the same `glob` argument would depend on which
 * engine is running — error with the shipped engine, silently empty when it
 * cannot start.
 *
 * Rules verified against rg 15.0.0: `[` must close; and the `]` immediately
 * after `[` (or `[!` / `[^`) **is a literal member**, not the closing
 * bracket — hence `[]]` is legal while `[]` and `[!]` report `unclosed
 * character class`.
 * `{` must close too (`{a,b` reports unclosed alternate group); a stray `}`
 * reports unopened alternate group; `\{` / `\}` are literals.
 *
 * Validation and expansion share one scanner (`expandGlob`) — otherwise "what
 * validation admits" and "what matching understands" would drift apart and
 * nothing would guard cross-engine equivalence.
 */
export function assertValidGlob(glob: string): void {
  expandGlob(glob);
}

/**
 * Decide whether a relative path is accepted by a glob set.
 *
 * A bare `!` (nothing left after stripping the negation marker) **selects no
 * files**, it does not mean "accept everything": verified against rg 15.0.0,
 * a lone `--glob '!'` gives rc=1, same as `--glob '!*'` (negate all). An
 * empty pattern can only match an empty path, and candidate paths are never
 * empty — so as a negation it removes nothing and as a positive it selects
 * nothing. The old implementation stripped `!` to an empty positive pattern;
 * `matchOne` never hit with an empty-segment pattern against real paths, yet
 * at the **set level** it degenerated into "no positive pattern → accept
 * all", so `glob: "!"` listed the whole repo via Node while rg returned
 * empty.
 */
export function matchesGlobSet(
  relPath: string,
  globs: ReadonlyArray<string>
): boolean {
  // A bare `!` makes the whole set accept nothing: it is an **empty pattern**,
  // verified against rg 15.0.0 where a lone `--glob '!'` gives rc=1 (same as
  // `--glob '!*'` on the same tree). We cannot rely on "empty pattern matches
  // empty string" to fall through to false inside `matchOne` — at the set
  // level, no positive pattern defaults to accept-all, so a bare `!` would
  // invert into "list the whole repo".
  // Reachability: the tool surface exposes a single `glob` argument, so
  // "bare `!` alongside other globs" is not reachable from the tool face; it
  // stays here because `matchesGlobSet` is the general set implementation
  // (`node-scan` also feeds it sets).
  if (globs.some((g) => g === "!")) return false;
  const positives = globs.filter((g) => !isNegation(g));
  const negatives = globs.filter((g) => isNegation(g)).map((g) => g.slice(1));
  if (positives.length > 0 && !positives.some((g) => matchOne(relPath, g))) {
    return false;
  }
  return !negatives.some((g) => matchesNegation(relPath, g));
}

/**
 * Negation-pattern matching (**differs from positive patterns**, do not reuse
 * `matchOne`).
 *
 * The only difference is the trailing `/`: positive `sub/` selects no file
 * (an empty segment only matches an empty name), while `!sub/` removes the
 * **entire subtree** of directory `sub` (verified against rg 15.0.0:
 * `--glob '!sub/'` drops `sub/c.ts` and `sub/deep/d.ts`). Same lineage as
 * gitignore's "directory qualification" — rg prunes directories for negative
 * globs rather than matching file by file.
 *
 * Ancestor prefixes (all but the last segment = the file itself) are each run
 * through the matcher, therefore
 *   - a single-star trailing slash removes only paths with at least one
 *     directory level (root-level files survive),
 *   - a double-star trailing slash removes every non-root path,
 *   - `!a.ts/` removes nothing (no ancestor directory named `a.ts/`).
 * All three match verified rg behaviour.
 */
function matchesNegation(relPath: string, glob: string): boolean {
  if (!glob.endsWith("/")) return matchOne(relPath, glob);
  const dirGlob = glob.slice(0, -1);
  // `!/` → empty directory pattern, removes nothing (verified with rg: result
  // identical to no glob at all).
  if (dirGlob.length === 0) return false;
  const segments = relPath.split("/").filter((s) => s.length > 0);
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (matchOne(segments.slice(0, depth).join("/"), dirGlob)) return true;
  }
  return false;
}

/**
 * Negation form starting with `!`; `\!` is an escaped literal `!` and stays a
 * positive pattern.
 *
 * Verified against rg 15.0.0: `--glob '!bang.ts'` does not remove `!bang.ts`
 * (returns the whole repo), while `--glob '\!bang.ts'` returns only
 * `!bang.ts` — the escaped `!` is a literal character.
 */
export function isNegation(glob: string): boolean {
  return glob.startsWith("!") && !glob.startsWith("\\!");
}

/** Match one glob (`!` already stripped by `matchesGlobSet`; positives only). */
export function matchOne(relPath: string, glob: string): boolean {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  const base = segments[segments.length - 1];
  if (base === undefined) return false;
  // Anchoring is a property of the **whole pattern**: any `/` in the raw text
  // (even inside a brace alternative, or a single leading `/`) anchors to the
  // search root; otherwise match by basename at any depth. Verified:
  //   `zz.ts` hits sub/zz.ts; `{sub/nope,zz}.ts` does not (pattern anchored);
  //   `{a,sub/only}.ts` hits both root a.ts and sub/only.ts (the `/` sits in
  //   an alternative, which is still interpreted under whole-pattern
  //   anchoring).
  const anchored = glob.includes("/");
  // A single leading `/` means "from the search root" and is **only honored
  // as the first character of the whole pattern**: `/*.ts` hits root .ts
  // files, `//a.ts` hits nothing (the second `/` is an empty segment matching
  // no real name); the `/` inside `{sub,/}z.ts` is not first, just a literal
  // separator, so the `/z.ts` alternative demands a real empty segment in the
  // path — verified rc=1.
  const normalized = glob.startsWith("/") ? glob.slice(1) : glob;
  for (const expanded of expandGlob(normalized)) {
    // Empty segments are kept and are always "unmatchable": a trailing `/`
    // (`sub/`, `*/`, `a.ts/`) selects **no file at all** in rg (verified
    // 15.0.0, same for lone and negated forms), for the same reason as a
    // middle empty segment (`a//b`) — an empty segment only matches an empty
    // name. The old implementation popped the trailing empty segment, so
    // `sub/` degenerated to `sub` and `*/` to `*`, and the Node path took the
    // whole repo while rg returned empty.
    const pattern = expanded.split("/");
    const matched = anchored
      ? matchSegments(pattern, 0)(segments, 0)
      : matchSegments(pattern, 0)([base], 0);
    if (matched) return true;
  }
  return false;
}

/**
 * Brace expansion: `{a,b}` yields one alternative; nesting and multiple
 * groups produce a cartesian product.
 *
 * Semantics verified against rg 15.0.0; scanning and validation share this
 * function (`assertValidGlob` calls it, malformed input → typed rejection):
 *   - `{a,b}` alternation; `{ts}` with one element also expands (≡ `ts`);
 *     `{}` expands to the empty string, i.e. matches the empty pattern and
 *     produces no file (verified: `{}` rc=1, `a{}b` hits `ab`).
 *   - Empty alternatives are dropped: `{a,}` ≡ `{a}`, `{,}` ≡ no alternative
 *     (the whole pattern matches nothing).
 *   - **Not** shell range expansion: `{1..3}` / `{a..c}` are literals
 *     (verified: hit no file, rc=1).
 *   - Nesting: `{a,{b,c}}` → a / b / c.
 *   - `\` escaping: `\{` / `\}` / `\,` are literal chars (`a\{b` hits `a{b`).
 *   - Braces inside a character class are **literal members**: `[{]` is not
 *     an alternation group.
 *   - `{` without `}` → unclosed alternate group; `}` without `{` → unopened.
 *
 * Returns candidates **before segment splitting** (may still contain `/`);
 * an empty array = the pattern matches nothing.
 */
export function expandGlob(glob: string): string[] {
  const out: string[] = [];
  expandInto(glob, 0, "", out);
  return out;
}

/** Result of one scan step: either a literal chunk or an alternation group. */
type ScanStep =
  | { readonly kind: "literal"; readonly text: string; readonly next: number }
  | {
      readonly kind: "group";
      readonly alternatives: ReadonlyArray<string>;
      readonly tailFrom: number;
    };

/**
 * One-level scan: append the expansion of `glob[from..]` to `prefix`.
 *
 * Each character is classified once (classification lives in `scanStep`); this
 * function only accumulates literals and expands alternation groups into the
 * cartesian product. Syntax errors are thrown by `scanStep`.
 */
function expandInto(
  glob: string,
  from: number,
  prefix: string,
  out: string[]
): void {
  let literal = prefix;
  let i = from;
  while (i < glob.length) {
    const step = scanStep(glob, i);
    if (step.kind === "literal") {
      literal += step.text;
      i = step.next;
      continue;
    }
    for (const alt of step.alternatives) {
      // Alternatives expand **recursively** (nested braces); the tail
      // continues at this level (cartesian product across groups).
      const heads: string[] = [];
      expandInto(literal + alt, 0, "", heads);
      for (const head of heads) expandInto(glob, step.tailFrom, head, out);
    }
    return;
  }
  out.push(literal);
}

/** One scan step: escape / character class / alternation group / single literal char (`{` unclosed and stray `}` are rejected here). */
function scanStep(glob: string, i: number): ScanStep {
  const ch = glob[i]!;
  if (ch === "\\") return escapeStep(glob, i);
  if (ch === "[") return classStep(glob, i);
  if (ch === "}") {
    throw new ToolExecutionError(
      `grep: invalid glob: ${glob} (unopened alternate group; missing '{')`
    );
  }
  if (ch === "{") return groupStep(glob, i);
  return { kind: "literal", text: ch, next: i + 1 };
}

/**
 * Escapes are **kept verbatim** (`\{` stays `\{`): the within-segment matcher
 * must distinguish a literal `*` from a wildcard `*` — `star\*` hits a file
 * named `star*`, `star*` does not. The expansion layer only ensures escaped
 * chars are not mistaken for group / class boundaries.
 */
function escapeStep(glob: string, i: number): ScanStep {
  const next = glob[i + 1];
  return next === undefined
    ? { kind: "literal", text: "\\", next: i + 1 }
    : { kind: "literal", text: `\\${next}`, next: i + 2 };
}

function classStep(glob: string, i: number): ScanStep {
  const cls = classAt(glob, i);
  if (cls === undefined) {
    throw new ToolExecutionError(
      `grep: invalid glob: ${glob} (unclosed character class; missing ']')`
    );
  }
  return { kind: "literal", text: glob.slice(i, cls.next), next: cls.next };
}

function groupStep(glob: string, i: number): ScanStep {
  const close = matchingBrace(glob, i);
  if (close === -1) {
    throw new ToolExecutionError(
      `grep: invalid glob: ${glob} (unclosed alternate group; missing '}')`
    );
  }
  // Empty alternatives are **kept** (they stand for the empty string, not
  // "dropped"): `a{}b` hits `ab` and `a{,}b` also hits `ab`; `{}` expands to
  // the empty pattern, hence it matches no real filename.
  return {
    kind: "group",
    alternatives: splitAlternatives(glob.slice(i + 1, close)),
    tailFrom: close + 1,
  };
}

/**
 * Index of the `}` matching a `{` (skipping `\` escapes and character
 * classes); -1 if unpaired. Nesting is tracked by depth, so the outer group
 * of `{a,{b,c}}` takes the last `}`.
 */
function matchingBrace(glob: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      const cls = classAt(glob, i);
      i = cls === undefined ? i + 1 : cls.next;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Split on top-level `,` (skipping escapes / character classes / nested braces). */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      const cls = classAt(body, i);
      i = cls === undefined ? i + 1 : cls.next;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(body.slice(start));
  return parts;
}

/** `**` crosses segments; others match within a segment. Returns "can pattern[p..] consume segs[s..]". */
function matchSegments(
  pattern: ReadonlyArray<string>,
  p: number
): (segs: ReadonlyArray<string>, s: number) => boolean {
  return (segs, s) => {
    let pi = p;
    let si = s;
    while (pi < pattern.length) {
      const tok = pattern[pi]!;
      if (tok === "**") {
        while (pattern[pi] === "**") pi += 1;
        if (pi === pattern.length) return true;
        const rest = matchSegments(pattern, pi);
        for (let at = si; at <= segs.length; at += 1) {
          if (rest(segs, at)) return true;
        }
        return false;
      }
      if (si >= segs.length) return false;
      if (!matchToken(tok, segs[si]!)) return false;
      pi += 1;
      si += 1;
    }
    return si === segs.length;
  };
}

/** Within-segment `*` / `?` / `[...]`. Character classes are case-sensitive (same as rg). */
function matchToken(token: string, segment: string): boolean {
  let ti = 0;
  let si = 0;
  while (ti < token.length) {
    if (token[ti] === "*") return matchStar(token, ti, segment, si);
    const next = stepToken(token, ti, segment, si);
    if (next === null) return false;
    ti = next.ti;
    si = next.si;
  }
  return si === segment.length;
}

/** Consume one non-`*` token unit; returns new indices, `null` = no match here. */
function stepToken(
  token: string,
  ti: number,
  segment: string,
  si: number
): { readonly ti: number; readonly si: number } | null {
  const ch = token[ti]!;
  if (ch === "\\") return escapeTokenStep(token, ti, segment, si);
  if (ch === "?") return consumeOne(ti + 1, si, segment);
  if (ch === "[") {
    const cls = classAt(token, ti);
    // A `[` without `]` is not a character class; fall through to the literal
    // comparison below.
    if (cls !== undefined) {
      const hit = si < segment.length && inClass(segment[si]!, cls.body);
      return hit ? { ti: cls.next, si: si + 1 } : null;
    }
  }
  const hit = si < segment.length && segment[si] === ch;
  return hit ? { ti: ti + 1, si: si + 1 } : null;
}

/** Escape: compare the next char literally (`\*` eats only a literal `*`, `\[` only a literal `[`). */
function escapeTokenStep(
  token: string,
  ti: number,
  segment: string,
  si: number
): { readonly ti: number; readonly si: number } | null {
  const next = token[ti + 1];
  if (next === undefined) {
    const hit = si < segment.length && segment[si] === "\\";
    return hit ? { ti: ti + 1, si: si + 1 } : null;
  }
  const hit = si < segment.length && segment[si] === next;
  return hit ? { ti: ti + 2, si: si + 1 } : null;
}

/** Advance one position; out of bounds (segment exhausted) → `null`. */
function consumeOne(
  ti: number,
  si: number,
  segment: string
): { readonly ti: number; readonly si: number } | null {
  return si < segment.length ? { ti, si: si + 1 } : null;
}

/** `*`: collapse consecutive `*`, then match the suffix against the remaining segment. */
function matchStar(
  token: string,
  ti: number,
  segment: string,
  si: number
): boolean {
  let at = ti;
  while (token[at] === "*") at += 1;
  if (at === token.length) return true;
  for (let from = si; from <= segment.length; from += 1) {
    if (matchToken(token.slice(at), segment.slice(from))) return true;
  }
  return false;
}

/**
 * Read a character class at `[`; missing closing `]` → `undefined`.
 *
 * The `]` immediately after `[` (or `[!` / `[^`) **is a literal member**, not
 * the terminator — that is rg's syntax: `[]]` is legal (class of just `]`),
 * while `[]` and `[!]` report unclosed.
 */
function classAt(
  token: string,
  ti: number
): { readonly body: string; readonly next: number } | undefined {
  let i = ti + 1;
  if (token[i] === "!" || token[i] === "^") i += 1;
  if (token[i] === "]") i += 1;
  while (i < token.length && token[i] !== "]") i += 1;
  if (i === token.length) return undefined;
  // body includes the `!` / `^` prefix: negation is interpreted by `inClass`.
  return { body: token.slice(ti + 1, i), next: i + 1 };
}

/** Character class: `[abc]` / `[a-z]` / `[!a-z]`. */
function inClass(ch: string, cls: string): boolean {
  const negated = cls.startsWith("!") || cls.startsWith("^");
  const body = negated ? cls.slice(1) : cls;
  let hit = false;
  let i = 0;
  while (i < body.length) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (ch >= body[i]! && ch <= body[i + 2]!) hit = true;
      i += 3;
      continue;
    }
    if (body[i] === ch) hit = true;
    i += 1;
  }
  return negated ? !hit : hit;
}
