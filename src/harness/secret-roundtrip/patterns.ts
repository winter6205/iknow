/**
 * src/harness/secret-roundtrip/patterns.ts — SSOT for secret patterns.
 *
 * #406 secret-roundtrip: replaces a destructive mask with a
 * placeholder + restore table. Patterns here are the SINGLE place secret
 * shapes live — secrets-guard.ts (#126 legacy `mode:"block"` path) and
 * recognize.ts (roundtrip default) both consume them, so adding a pattern
 * here automatically extends both layers.
 *
 * 占位形态 only (never real keys): 7 placeholders lifted from secrets-guard.ts
 *   1. Private key blocks (RSA/EC/OPENSSH/DSA/PGP, prefix optional)
 *   2. sk- prefixed API keys (≥20 base64url chars)
 *   3. AWS access keys (AKIA + 16 uppercase alphanum)
 *   4. GitHub tokens (ghp_ + 36 / github_pat_ + ≥50)
 *   5. Slack tokens (xoxb/xoxa/xoxp/xoxr/xoxs + ≥10)
 *   6. Private-key file exfil (cat/head/tail/curl/scp/rsync → id_<name>)
 *
 * Case-sensitive (no `i` flag) — secrets-guard's existing posture; lowering
 * the bar would over-match plain English ("aws" / "gh" in prose).
 */

/** Built-in secret regex sources. Always frozen; never mutate. */
export const DEFAULT_SECRET_PATTERNS: ReadonlyArray<string> = Object.freeze([
  "-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----",
  "sk-[A-Za-z0-9_-]{20,}",
  "AKIA[0-9A-Z]{16}",
  "ghp_[A-Za-z0-9]{36}",
  "github_pat_[A-Za-z0-9_]{50,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  "(cat|head|tail|curl|scp|rsync)\\b.*\\bid_[a-z]+\\b",
]);

export interface CompiledSecretPattern {
  readonly source: string;
  readonly re: RegExp;
}

/**
 * Compile regex source strings into reusable patterns with the `g` flag
 * (recognize uses iterative `re.exec` scanning).
 *
 * Returns `{ compiled, dropped }` mirroring secrets-guard.ts:82 flatMap
 * error-drop semantics (Constraints (a)): ONE bad pattern must not poison
 * the whole set. Surviving patterns still go into `compiled`; failed
 * sources land in `dropped` for caller-side telemetry. This module does
 * NOT log drops itself — composition over coupling (secrets-guard.ts
 * keeps its own onHookError; recognize is silent).
 */
export function compilePatterns(sources: ReadonlyArray<string>): {
  readonly compiled: ReadonlyArray<CompiledSecretPattern>;
  readonly dropped: ReadonlyArray<string>;
} {
  const compiled: CompiledSecretPattern[] = [];
  const dropped: string[] = [];
  for (const source of sources) {
    try {
      compiled.push({ source, re: new RegExp(source, "g") });
    } catch {
      dropped.push(source);
    }
  }
  return Object.freeze({
    compiled: Object.freeze(compiled),
    dropped: Object.freeze(dropped),
  });
}

/**
 * Factory: compile DEFAULT_SECRET_PATTERNS + optional extras in one shot.
 * Returns a frozen compiled array the registry can hold directly (no
 * per-call compile cost). Extras are appended after defaults — first-match
 * wins in scanning, so defaults keep priority ordering.
 */
export function createCompiledPatterns(
  extras?: ReadonlyArray<string>
): ReadonlyArray<CompiledSecretPattern> {
  return compilePatterns([...DEFAULT_SECRET_PATTERNS, ...(extras ?? [])])
    .compiled;
}
