/**
 * ADR-0043 — overflow-governance decision layer (pure logic).
 *
 * Decided once at assembly time (`buildHarnessEngine`, after
 * `await mcpManager.start()`): when the deferrable tool pool (MCP tools are
 * naturally deferrable, plus builtins explicitly marked deferrable) exceeds
 * 10% of the endpoint model's context window in total schema size, retire
 * tools one by one down to the index tier (name + description only),
 * following the fixed retirement order, until the total is back under the
 * threshold or the pool is empty. **First turn only** — never recomputed
 * within a session.
 *
 * Retirement mechanism = stamp `aci.lazy: true` (a lazy tool's schema stays
 * out of visibleSchemas; retired tools appear in the
 * `<deferred_internal_tools>` section as **name + description**, and the
 * model hydrates by calling the tool directly — no prior `tool_search`
 * needed; see permission-executor gateOne).
 *
 * Retirement order (SSOT, pinned by ADR-0043): the three trace read-side
 * tools (query_trace / list_sessions / get_record) → web_search / web_fetch
 * → other low-frequency tools ordered by measured footprint. **The core
 * seven never retire** (bash / read_file / edit_file / write_file / grep /
 * glob / spawn_subagent) — they do not participate in the decision even if
 * marked deferrable.
 *
 * countTokens call failure / absent → skip the judgment for this session
 * (all deferrable builtins stay resident); no first-turn throw, no retry;
 * the caller records it via `console.warn`.
 *
 * This module is **pure logic**: no build-engine / ACI executor coupling;
 * inputs are tools + a countTokens closure + a threshold, outputs are the
 * retire list + a reason. The assembly layer walks the returned list and
 * stamps `aci.lazy: true` (this field is written nowhere else, honoring the
 * "assembly-time consts are immutable" contract — AciToolDefs are frozen
 * once the registry is built, but **this module runs before registry
 * construction**, so writing lazy:true into the factory-produced defs is a
 * one-time construction-phase side effect equivalent to stamping inside the
 * factories themselves).
 */

import type { AciToolDef } from "./types.js";

/**
 * Retirement order for builtins (SSOT, preset per ADR-0043).
 *
 *   - trace read-side three: query_trace / list_sessions / get_record
 *     (largest footprint × lowest frequency first; query_trace's row axis is
 *     the biggest, get_record's content axis is usually the smallest)
 *   - web_search / web_fetch: network egress + low frequency
 *
 * Extending this order with "other low-frequency tools by measured
 * footprint" requires human confirmation, so this constant stays put — if
 * implementation finds an obvious candidate, list the evidence in the
 * report instead of editing the array.
 */
export const DEFERRABLE_BUILTIN_RETIRE_ORDER: ReadonlyArray<string> =
  Object.freeze([
    "query_trace",
    "list_sessions",
    "get_record",
    "web_search",
    "web_fetch",
  ] as const);

/** Core seven SSOT — never retired, even if marked deferrable. */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "read_file",
  "edit_file",
  "write_file",
  "grep",
  "glob",
  "spawn_subagent",
]);

/** countTokens closure contract — minimal projection of the SDK's
 *  `client.messages.countTokens` call site: a measured value (>= 0) or a
 *  throw. */
export type CountTokensFn = () => Promise<number>;

/** The deferrable pool handed over by the assembly layer = builtins marked
 *  deferrable + MCP tools (the caller filters by the mcp__ prefix per its
 *  register list). **Core tools are already removed by the caller** (SSOT
 *  guard), so this function trusts the input holds none. */
export interface OverflowJudgeOpts {
  readonly tools: ReadonlyArray<AciToolDef>;
  /** Threshold = contextWindow * 0.1 (computed by the caller at assembly;
   *  this function never reads env — pure logic). */
  readonly threshold: number;
  readonly countTokens: CountTokensFn;
}

export type OverflowJudgeResult =
  | { readonly reason: "no_overflow"; readonly retire: ReadonlyArray<string> }
  | { readonly reason: "retired"; readonly retire: ReadonlyArray<string> }
  | {
      readonly reason: "countTokens_failed";
      readonly retire: ReadonlyArray<string>;
      readonly cause: unknown;
    };

/**
 * First-turn overflow judgment — one pass, with an internal retirement
 * loop.
 *
 * Steps:
 *   1. Collect the candidate retirement list = tool names marked deferrable
 *      and not in the core set (ordered by
 *      `DEFERRABLE_BUILTIN_RETIRE_ORDER`; remaining deferrable candidates
 *      follow after the preset order, see `extraOrder`).
 *   2. First `countTokens` measurement: success → compare with threshold;
 *      failure → skip this session (return `countTokens_failed`, caller
 *      warns + leaves the tool set untouched).
 *   3. Total ≤ threshold → `no_overflow` (caller does nothing).
 *   4. Total > threshold → retire candidates one by one in order,
 *      re-measuring countTokens after each; exit the loop when the total is
 *      back ≤ threshold or the pool is empty.
 *   5. Still over threshold after retiring everything → `retired` still
 *      carries all candidates (best effort; the core seven never retire —
 *      this is the hard ceiling); the caller does not warn (not an error,
 *      just insufficient savings).
 *
 * Candidate list derivation:
 *   - low-frequency builtins = tools present in
 *     `DEFERRABLE_BUILTIN_RETIRE_ORDER` and marked deferrable, in preset
 *     order
 *   - other deferrable (MCP tools naturally + future builtins) = in
 *     catalog.all() registration order (original order), listed after the
 *     preset order
 *
 * Note: the `tools` received by `runOverflowJudge` are the
 * **assembly-time frozen def list**, with no builtin/MCP distinction —
 * registry.all() / reg.catalog.all() never reorder (this function sorts
 * only by `name` internally).
 */
export async function runOverflowJudge(
  opts: OverflowJudgeOpts
): Promise<OverflowJudgeResult> {
  const candidateOrder = deriveCandidateOrder(opts.tools);
  if (candidateOrder.length === 0) {
    // Empty pool → skip the judgment, straight no_overflow (no error)
    return { reason: "no_overflow", retire: [] };
  }
  // First measurement
  let total: number;
  try {
    total = await opts.countTokens();
  } catch (cause) {
    return { reason: "countTokens_failed", retire: [], cause };
  }
  if (!Number.isFinite(total) || total < 0) {
    // Invalid value → same semantics as failure (failure = skip, empty retire list)
    return {
      reason: "countTokens_failed",
      retire: [],
      cause: new Error(`countTokens returned non-finite: ${total}`),
    };
  }
  if (total <= opts.threshold) {
    return { reason: "no_overflow", retire: [] };
  }
  // Retirement loop: re-measure after each retirement
  const retired: string[] = [];
  for (const name of candidateOrder) {
    retired.push(name);
    let next: number;
    try {
      next = await opts.countTokens();
    } catch (cause) {
      // A mid-loop countTokens failure makes the retire list advisory only —
      // under the caller's skip semantics it must not be applied (all
      // deferrable tools stay resident); tools retired before the failure
      // stay retired (already latched) and nothing more is appended. Return
      // countTokens_failed + the current retire; caller warns.
      return { reason: "countTokens_failed", retire: retired, cause };
    }
    if (next <= opts.threshold) {
      return { reason: "retired", retire: retired };
    }
  }
  // Pool exhausted but still over threshold (rare: all core tools present +
  // a large deferrable pool) → best-effort retirement; retire carries every
  // candidate; reason = "retired" (best effort done, not an error)
  return { reason: "retired", retire: retired };
}

/**
 * Candidate retirement list derivation:
 *   - deferrable builtins present in `DEFERRABLE_BUILTIN_RETIRE_ORDER` →
 *     preset order
 *   - other deferrable (MCP tools naturally + future builtins) → the
 *     registry's original order, listed after the preset order
 *
 * Core tools are already removed by callers (no second filtering here —
 * the caller strips bash & co. before passing in, so the same call can
 * also measure the core tools' schema footprint inside countTokens, i.e.
 * "simulating the full first-turn request surface").
 */
function deriveCandidateOrder(
  tools: ReadonlyArray<AciToolDef>
): ReadonlyArray<string> {
  const defSet = new Set<string>();
  for (const t of tools) {
    // The core seven never participate (even if marked deferrable) — hard
    // ceiling pinned by ADR-0043. This filter runs once at the candidate
    // derivation layer; retire writes stay guarded downstream by
    // retireBuiltin (core tools are absent from the preset order and
    // already stripped by deriveCandidateOrder).
    if (CORE_TOOL_NAMES.has(t.name)) continue;
    if (t.aci.deferrable === true) defSet.add(t.name);
  }
  const ordered: string[] = [];
  for (const name of DEFERRABLE_BUILTIN_RETIRE_ORDER) {
    if (defSet.has(name)) ordered.push(name);
  }
  // Other deferrable tools keep the registry's original order (this function
  // trusts the input tools order = registry registration order)
  for (const t of tools) {
    if (
      t.aci.deferrable === true &&
      !CORE_TOOL_NAMES.has(t.name) &&
      !DEFERRABLE_BUILTIN_RETIRE_ORDER.includes(t.name)
    ) {
      ordered.push(t.name);
    }
  }
  return ordered;
}
