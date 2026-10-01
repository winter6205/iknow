/**
 * ACI capability layer: type contracts.
 *
 * After the three permission layers graduated: pass_through was deleted
 * (decisions are now allow/deny/ask), and AciMeta.isReadOnly /
 * isDestructive were deleted (category is already the single authority).
 * Retained: category / isConcurrencySafe / interruptBehavior
 * (interruption & timeout semantics) plus timeoutTier — static per-tool
 * timeout tiers.
 *
 * Decision / rule / policy objects now live in `src/harness/permission/`;
 * see permission/index.ts for the public surface.
 */

import type { ToolDef } from "../tools/types.js";

/** The four safety categories (category is the source of truth for read-only / write / execute / collaborate). */
export type AciCategory = "read-only" | "write" | "execute" | "collaborate";

/**
 * ADR-0134: the default runtime deadline of a finite FOREGROUND Bash
 * invocation, in milliseconds, used when the model omits `timeout_ms`.
 *
 * This is a runtime deadline, not a frontend wait: the process group is torn
 * down when it expires. It lives here, next to `TIMEOUT_TIER_MS`, because it
 * is the Bash replacement for the retired `build` tier — a value read by both
 * the handler (the enforcement site) and its tests.
 */
export const DEFAULT_FOREGROUND_BASH_TIMEOUT_MS = 10_000;

/**
 * ADR-0134: why a `timeout_ms` value was rejected, as a closed set.
 *
 * A caller branches on the code (and the executor's `validation_failed`
 * classification comes from the error's class identity) instead of matching an
 * arbitrary message substring. `unrepresentable` is a representation limit,
 * not a command-category runtime policy: the host timer cannot express the
 * requested deadline, so the value is rejected rather than silently shortened
 * into a different contract.
 */
export const BASH_FOREGROUND_DEADLINE_ERROR_CODES = Object.freeze([
  "not_a_number",
  "not_finite",
  "not_whole",
  "not_positive",
  "unrepresentable",
] as const);

export type BashForegroundDeadlineErrorCode =
  (typeof BASH_FOREGROUND_DEADLINE_ERROR_CODES)[number];

/**
 * Why a supplied deadline is a non-starter: the message the model reads.
 * One table so the code and its wording cannot drift apart.
 */
export const BASH_FOREGROUND_DEADLINE_ERROR_REASONS: Readonly<
  Record<BashForegroundDeadlineErrorCode, string>
> = Object.freeze({
  not_a_number: "must be a number of milliseconds",
  not_finite: "must be a finite number",
  not_whole: "must be a whole number of milliseconds",
  not_positive: "must be greater than 0",
  unrepresentable: "exceeds the host timer limit of 2147483647 ms",
});

/**
 * Timeout tiers: static per-tool timeout levels.
 *
 *   fast       = 5 s       single file read / glob listing (light atomic ops)
 *   default    = 30 s      writes / grep over a large repo (regular IO + subprocess)
 *   build      = 5 min     long bash commands (build / test / deploy)
 *   long       = 30 min    rare large jobs (MCP etc.)
 *   unbounded  = 0         no ACI-layer timer (createAciExecutor's
 *                          `tierTimeoutMs > 0` guard); lifetime is governed
 *                          by the tool's own clock. spawn_subagent wait:true
 *                          must use this tier: `long` (30min) < PER_TASK (2h)
 *                          would abort too early.
 *
 * Millisecond values come from `TIMEOUT_TIER_MS`; `createAciExecutor` treats
 * the tool's tier as authoritative, overriding the timeoutMs passed in by
 * the Loop Engine.
 */
export type TimeoutTier = "fast" | "default" | "build" | "long" | "unbounded";

/** Milliseconds per tier (frozen — shared by implementation and tests). */
export const TIMEOUT_TIER_MS: Readonly<Record<TimeoutTier, number>> =
  Object.freeze({
    fast: 5_000,
    default: 30_000,
    build: 300_000,
    long: 1_800_000,
    unbounded: 0,
  });

/** ACI safety/scheduling metadata (lazy loading / concurrency safety / interrupt behavior / timeout tier / overflow candidacy). */
export interface AciMeta {
  readonly category: AciCategory;
  readonly isConcurrencySafe: boolean;
  readonly interruptBehavior: "cancel" | "block";
  /** true = lazy: stays out of the prompt schema by default and needs a
   *  discover() lookup to be injected (calling an undiscovered lazy tool
   *  directly also hydrates it — gateOne reads this field, so the
   *  permission-executor's catalog projection must keep it). Default false
   *  (core, resident). */
  readonly lazy?: boolean;
  /**
   * ADR-0043: overflow candidacy marker — true = joins the deferrable pool
   * (when the first-turn assembly-time countTokens measurement exceeds 10%
   * of the context window, it may be retired to the index tier: name +
   * description). Distinct from `lazy`: `lazy` = stays out until loaded
   * (schema may still sit in the visible prefix), `deferrable` = may be
   * retired to the index tier under overflow. **The core seven never
   * retire** (bash / read_file / edit_file / write_file / grep / glob /
   * spawn_subagent) — the decision layer ignores deferrable on them; see
   * `CORE_TOOL_NAMES` in `tool-overflow.ts`.
   * Default false (resident). MCP tools are naturally deferrable; builtin
   * low-frequency candidates are preset as the trace read-side three +
   * web_search / web_fetch.
   */
  readonly deferrable?: boolean;
  /** Static timeout tier; createAciExecutor derives a per-call timeout from it (overriding the engine-passed timeoutMs). */
  readonly timeoutTier: TimeoutTier;
}

/** ACI tool definition = frozen ToolDef + aci metadata (an extension; the protocol is unchanged). */
export interface AciToolDef extends ToolDef {
  readonly aci: AciMeta;
}

/** ACI catalog: lookup AciToolDef by name (shared by the permission layer and lazy loading). */
export interface AciCatalog {
  readonly get: (name: string) => AciToolDef | undefined;
  readonly all: () => ReadonlyArray<AciToolDef>;
  /**
   * ADR-0043: check whether a name has been marked "retrieved by the model"
   * via `discover()`. Absent (`undefined`) → the gate lets the call through
   * (paths not assembled via an ACI registry, e.g. a hub runDeps using a
   * registry outside build-engine, behave as before this gate existed).
   */
  readonly isDiscovered?: (name: string) => boolean;
  /**
   * ADR-0046: hydrate side-effect entry — gateOne calls this for undiscovered
   * lazy tools (`mcp__`-prefixed defs and schema-retired builtins) to add the
   * name to the discovered set (next round's visibleSchemas appends the
   * schema at the tail). Absent (`undefined`) → the gate treats it as a "not
   * an ACI-registry path" and behaves as before (hands the call directly to
   * inner).
   */
  readonly discover?: (name: string) => void;
}

/**
 * ⚠️ Compatibility re-exports — the prototype layer used PermissionDecision,
 * PermissionOutcome, PermissionRule, AciPermissionPolicy. Those shapes live in
 * `src/harness/permission/` now (graduated there). Re-exporting them
 * here avoids breaking any prototype-importing tests while the new module
 * (the new home of these symbols) is the canonical source.
 */
export type {
  PermissionDecision,
  PermissionOutcome,
  AskUser,
  PreHookBlock,
  PreToolUseHook,
  PostToolUseHook,
} from "../permission/types.js";
export type { NormalRuleSpec as PermissionRule } from "../permission/types.js";
export type { PermissionPolicy as AciPermissionPolicy } from "../permission/policy.js";
