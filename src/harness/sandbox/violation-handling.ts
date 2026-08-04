/**
 * src/harness/sandbox/violation-handling.ts
 *
 * Three-tier violation handling (T6 / #123 Q4 / ticket #169).
 *
 * Spec / Q4 decisions:
 *  - low  (e.g. permission_denied non-dangerous, user_denied) — one-shot deny,
 *         counter does NOT accumulate.
 *  - mid  (sensitive path, dangerous command, network denied without escape
 *         attempt) — reject + count; on Nth occurrence the session is killed.
 *  - high (escape attempt, secret env access) — kill immediately.
 *  - ask path does NOT count — `[user_denied]` is recorded as low only.
 *
 * The counter is a closure (no class) so the rule "count state and N default
 * live in the same factory" (spec §Complexity Budgets) holds without surface
 * leaks. The kill hook is a `PostToolUseHook`-compatible function: it inspects
 * each tool result and categorizes by substring matching the permission-
 * executor prefixes.
 */

import type { PostToolUseHook } from "../permission/types.js";
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";

export type ViolationTier = "low" | "mid" | "high";

export interface ViolationEvent {
  readonly tier: ViolationTier;
  readonly tool: string;
  readonly input: unknown;
  readonly message: string;
  readonly ts?: number;
}

export interface ViolationCounterRecordResult {
  readonly count: number;
  readonly shouldKill: boolean;
}

export interface ViolationCounter {
  /** Record an event; returns the current count and whether the session
   *  should be killed (mid: count >= threshold; high: immediate). */
  readonly record: (event: ViolationEvent) => ViolationCounterRecordResult;
  /** Clear mid-tier accumulator (low/high counters are stateless). */
  readonly reset: () => void;
  /** Snapshot of the current count for diagnostics / tests. */
  readonly snapshot: () => number;
}

export interface CreateViolationCounterOpts {
  /** Mid-tier escalation threshold. Default 3 per #123 Q4. */
  readonly midEscalationThreshold?: number;
}

const DEFAULT_MID_THRESHOLD = 3;

export function createViolationCounter(
  opts: CreateViolationCounterOpts = {}
): ViolationCounter {
  const threshold = opts.midEscalationThreshold ?? DEFAULT_MID_THRESHOLD;
  let midCount = 0;

  const record = (event: ViolationEvent): ViolationCounterRecordResult => {
    if (event.tier === "low") {
      // Low-tier is one-shot: doesn't accumulate.
      return { count: midCount, shouldKill: false };
    }
    if (event.tier === "high") {
      return { count: midCount, shouldKill: true };
    }
    // mid: accumulate; kill at threshold.
    midCount += 1;
    return {
      count: midCount,
      shouldKill: midCount >= threshold,
    };
  };

  const reset = (): void => {
    midCount = 0;
  };

  const snapshot = (): number => midCount;

  return Object.freeze({ record, reset, snapshot });
}

/* -----------------------------------------------------------------------------
 * Categorize tool results → violation tier
 * -------------------------------------------------------------------------- */

export interface CategorizedResult {
  readonly tier: ViolationTier | undefined;
  readonly detail: string;
}

/**
 * Inspect a PostToolUseHook result and decide which violation tier it
 * represents (if any). Returns `tier: undefined` when the result is not a
 * tracked violation (e.g. an `ok` result).
 *
 * Substring policy (matches the prefixes emitted by `permission-executor.ts`
 * and `network-policy.ts`). Prefixes are consumed from
 * `permission/prefixes.ts` (SSOT) so the recognize side cannot drift from
 * the emit side:
 *   - `[hard_wall] dangerous command`            → mid (sensitive / dangerous)
 *   - `[hard_wall] sensitive path`               → mid
 *   - `[permission_denied] dangerous`            → mid (dangerous command variant)
 *   - `[network_denied]`                         → mid (network denial)
 *   - `[permission_denied]` (non-dangerous)      → low
 *   - `[user_denied]`                            → low
 *   - `[fs_denied]`                              → mid
 *   - other                                      → undefined
 */
export function categorizeResult(result: {
  readonly name: string;
  readonly input: unknown;
  readonly kind: string;
  readonly message?: string;
}): CategorizedResult {
  if (result.kind !== "execution_failed") {
    return { tier: undefined, detail: "non-failure result" };
  }
  const msg = result.message ?? "";

  const { hardWall, permissionDenied, userDenied, networkDenied, fsDenied } =
    VIOLATION_PREFIXES;

  // Order matters: check the more specific dangerous patterns first so
  // "[permission_denied] dangerous command" doesn't fall through to generic
  // permission_denied → low.
  const hardWallRe = new RegExp(`\\${hardWall}\\s+(dangerous|sensitive)`);
  if (hardWallRe.test(msg)) {
    return { tier: "mid", detail: msg };
  }
  const permDangerousRe = new RegExp(`\\${permissionDenied}\\s+dangerous`);
  if (permDangerousRe.test(msg)) {
    return { tier: "mid", detail: msg };
  }
  if (msg.includes(networkDenied)) {
    return { tier: "mid", detail: msg };
  }
  if (msg.includes(fsDenied)) {
    return { tier: "mid", detail: msg };
  }
  if (msg.includes(userDenied)) {
    return { tier: "low", detail: msg };
  }
  if (msg.includes(permissionDenied)) {
    return { tier: "low", detail: msg };
  }
  return { tier: undefined, detail: "untracked failure" };
}

/* -----------------------------------------------------------------------------
 * Kill-session hook factory
 * -------------------------------------------------------------------------- */

export interface CreateKillSessionHookOpts {
  readonly counter: ViolationCounter;
  /** Called when shouldKill transitions to true. The string carries the
   *  JSON-formatted violation details for the trace. */
  readonly onKill: (reason: string) => void;
}

export function createKillSessionHook(
  opts: CreateKillSessionHookOpts
): PostToolUseHook {
  const { counter, onKill } = opts;
  return (result) => {
    const cat = categorizeResult(result);
    if (cat.tier === undefined) return;
    const { shouldKill } = counter.record({
      tier: cat.tier,
      tool: result.name,
      input: result.input,
      message: cat.detail,
    });
    if (shouldKill) {
      onKill(
        JSON.stringify({
          kind: "violation",
          tier: cat.tier === "high" ? "high" : "mid-escalation",
          tool: result.name,
          message: cat.detail,
        })
      );
    }
  };
}

/* -----------------------------------------------------------------------------
 * Chat-layer wiring helper
 *
 * `wireKillSessionNotification` returns an `onKill` callback suitable for
 * `createKillSessionHook`. It writes a single stderr line and toggles
 * `process.exitCode = 1` so the CLI exits with a non-zero code after the
 * current turn completes.
 * -------------------------------------------------------------------------- */

export interface WireKillSessionNotificationOpts {
  /** Where to write the violation line (typically process.stderr). */
  readonly sink: (line: string) => void;
  /** Optional formatter; default emits `[violation] session killed: <detail>`. */
  readonly format?: (event: ViolationEvent) => string;
}

export function wireKillSessionNotification(
  opts: WireKillSessionNotificationOpts
): (reason: string) => void {
  const format =
    opts.format ??
    ((event: ViolationEvent): string =>
      `[violation] session killed: tier=${event.tier} tool=${event.tool} message=${event.message}`);
  let fired = false;
  return (reason: string): void => {
    if (fired) return;
    fired = true;
    let event: ViolationEvent;
    try {
      const parsed = JSON.parse(reason) as Partial<ViolationEvent>;
      // M3 fix: read `tier` if present and validate against the known union
      // ("low" | "mid" | "high"). Unknown → fall through to the parser
      // branches below (default = "mid" for valid but unrecognized tier).
      const parsedTier = parsed.tier;
      const tier: ViolationTier =
        parsedTier === "low" || parsedTier === "mid" || parsedTier === "high"
          ? parsedTier
          : "mid";
      event = {
        tier,
        tool: typeof parsed.tool === "string" ? parsed.tool : "",
        input: undefined,
        message: typeof parsed.message === "string" ? parsed.message : reason,
      };
    } catch {
      // Fail-safe: a kill reason that isn't even JSON is treated as the
      // worst tier ("high"). We do NOT silently downgrade to "mid" — the
      // previous behavior masked severity for malformed payloads.
      event = {
        tier: "high",
        tool: "",
        input: undefined,
        message: reason,
      };
    }
    opts.sink(format(event));
    process.exitCode = 1;
  };
}
