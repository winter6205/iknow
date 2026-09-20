/**
 * src/harness/permission/secrets-guard.ts
 *
 * Deny-only PreToolUseHook factory (built-in pattern set + custom patterns).
 *
 * Blocks secret-shaped strings carried in tool input before the call reaches
 * the permission layer (the executor wraps PreHookBlock.reason as
 * `[hook_blocked] ...` back to the model).
 *
 * Design decisions:
 *  - Placeholder shapes only: built-in patterns are regex placeholders, never real keys.
 *  - Case-sensitive throughout: no `i` flag, to avoid widening false positives.
 *  - Compile each pattern at construction; invalid regex entries are dropped
 *    with a guard-init warning while the rest stay active — a broken pattern
 *    must never block every call.
 *  - At runtime `JSON.stringify(input)` is truncated to 20000 chars before
 *    scanning; secret shapes in the tail of an over-long input are not
 *    matched — prefer a miss over a false block, never throw.
 *  - The returned hook is pure and stateless: compiled artifacts are frozen
 *    at construction, read-only at runtime → concurrency-safe.
 */

import type { PreToolUseHook } from "./types.js";
import type { HookErrorEvent } from "./permission-executor.js";
import { DEFAULT_SECRET_PATTERNS } from "../secret-roundtrip/index.js";

// Pattern SSOT lives in src/harness/secret-roundtrip/patterns.ts; this file
// keeps the `mode:"block"` compatibility path (creating the deny-only
// preToolUse hook). The 7 default placeholder patterns were moved verbatim.
export { DEFAULT_SECRET_PATTERNS };

/** stringify truncation cap. Shared: user-hooks (hooks) pattern scanning
 *  follows the same truncation discipline from this single constant. */
export const MAX_SCAN_LENGTH = 20_000;

/** guard-init warning payload (phase is always "guard-init", no tool attribution). */
export interface SecretsGuardHookOpts {
  readonly patterns?: ReadonlyArray<string>;
  readonly enabled?: boolean;
  readonly onHookError?: (e: HookErrorEvent) => void;
}

/**
 * Build the secrets-guard PreToolUseHook.
 *
 *  - enabled defaults to true; false → transparent hook (always undefined,
 *    no compiling/scanning at all).
 *  - At construction `[...DEFAULT_SECRET_PATTERNS, ...(opts.patterns ?? [])]`
 *    is compiled one by one; invalid regexes are dropped with a guard-init
 *    warning, the rest stay active.
 *  - At runtime: stringify input, truncate to MAX_SCAN_LENGTH, match each
 *    pattern; hit → `{ reason: "secret pattern matched: <pattern source>" }`,
 *    miss → undefined.
 *  - stringify failure (cycles, BigInt...) counts as "nothing to scan" →
 *    pass through, never throw.
 */
export function createSecretsGuardHook(
  opts?: SecretsGuardHookOpts
): PreToolUseHook {
  if (opts?.enabled === false) {
    return Object.freeze(() => undefined);
  }

  // Compiled artifacts are frozen at construction; the source string is kept
  // for the reason + warning (RegExp.toString would add /delimiters/).
  const compiled: ReadonlyArray<{
    readonly source: string;
    readonly re: RegExp;
  }> = Object.freeze(
    [...DEFAULT_SECRET_PATTERNS, ...(opts?.patterns ?? [])].flatMap(
      (source) => {
        try {
          return [{ source, re: new RegExp(source) }];
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          opts?.onHookError?.({
            phase: "guard-init",
            message: `invalid secret pattern dropped: ${JSON.stringify(source)}: ${message}`,
          });
          return [];
        }
      }
    )
  );

  const hook: PreToolUseHook = Object.freeze(({ input }) => {
    if (compiled.length === 0) return undefined;

    let scanned: string;
    try {
      const raw = JSON.stringify(input);
      scanned =
        raw.length > MAX_SCAN_LENGTH ? raw.slice(0, MAX_SCAN_LENGTH) : raw;
    } catch {
      // stringify failed → nothing to scan; pass through without throwing.
      return undefined;
    }

    for (const { source, re } of compiled) {
      if (re.test(scanned)) {
        return { reason: `secret pattern matched: ${source}` };
      }
    }
    return undefined;
  });

  return hook;
}
