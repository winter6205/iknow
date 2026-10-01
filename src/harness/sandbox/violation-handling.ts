/**
 * src/harness/sandbox/violation-handling.ts
 *
 * Three-tier violation handling (T6 / #123 Q4 / ticket #169), scoped to the
 * current user turn by ADR-0135 / spec #1170.
 *
 * Spec / Q4 decisions:
 *  - low  (e.g. permission_denied non-dangerous, user_denied) — one-shot deny,
 *         counter does NOT accumulate.
 *  - mid  (sensitive path, dangerous command, network denied without escape
 *         attempt) — reject + count; on Nth occurrence the turn is interrupted.
 *  - high (escape attempt, secret env access) — kill immediately.
 *  - ask path does NOT count — `[user_denied]` is recorded as low only.
 *
 * ADR-0135 refinements:
 *  - The counter instance IS the turn scope. A host creates one per user turn
 *    and discards it, so there is no cross-turn lifetime accumulator; a new
 *    turn therefore starts at zero by construction rather than by a reset
 *    call someone can forget.
 *  - Only an admitted call that finished successfully resets the streak.
 *    Routine denials, reviewer unavailability, timeouts, cleanup failures and
 *    every other unsuccessful non-violation outcome are neutral: they neither
 *    increment nor reset.
 *  - Reviewer *unavailability* is not confirmed unsafe intent and is
 *    therefore neutral, not a mid-tier violation. The typed deny it produces
 *    still reaches the model and still requires a fresh review; it just cannot
 *    drive the turn to an interruption on its own.
 *
 * The counter is a closure (no class) so the rule "count state and N default
 * live in the same factory" (spec §Complexity Budgets) holds without surface
 * leaks. The kill hook is a `PostToolUseHook`-compatible function: it inspects
 * each tool result and categorizes by substring matching the permission-
 * executor prefixes.
 */

import type { PostToolUseHook } from "../permission/types.js";
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";
import {
  createTurnWorkRegistry,
  type TurnOwnedWorkCleanup,
  type TurnWorkCancelRoutes,
  type TurnWorkRegistry,
} from "./turn-work-registry.js";

export type ViolationTier = "low" | "mid" | "high";

/**
 * The tier a producer MAY name on an interruption payload, plus the one label
 * that is not a severity at all.
 *
 * `mid-escalation` is kept because it is genuinely produced: `createKillSessionHook`
 * writes it to `onKill` at the moment the threshold is reached, and dropping it
 * from the union would leave the operator line reading a severity nobody
 * emitted. It describes a STAGE (the threshold was just crossed, no cleanup
 * collected yet), not a severity, which is why `ViolationEvent` below keeps
 * the two apart through `stage` instead of overloading one field.
 */
export type ViolationReportTier = ViolationTier | "mid-escalation";

/** Whether the payload is the escalation notice or the structured report. */
export type ViolationStage = "notification" | "report";

export interface ViolationEvent {
  readonly tier: ViolationTier | undefined;
  readonly tool: string;
  readonly input: unknown;
  readonly message: string;
  readonly ts?: number;
}

/**
 * The validated payload every host reads, and the single answer about it.
 *
 * One parser for three consumers (the trace reader, the serve hub's durable
 * projection, the CLI's operator line) exists because they previously disagreed:
 * the same escalation read as `tier=mid` in the trace, was dropped entirely by
 * the hub (so the turn's cause could not be joined back to the trace, which is
 * what SC12 asks the evidence to support), and was rendered as `tier=mid` at
 * the CLI. A payload read three ways is a payload whose meaning is whatever
 * the reader felt like.
 *
 * `tier` is ABSENT for a payload that named none or named one this build does
 * not recognize, never defaulted. Rewriting an unknown severity to `"mid"`
 * asserts the counter escalated on the mid threshold when the producer may
 * have meant something else — a fabricated fact, and the opposite of the
 * posture `cleanup-result.ts` states in its own header ("Nothing here
 * converts a failure into a stop"). The raw payload is carried verbatim on
 * `detail`, so a consumer needing a field this shape has not grown reads it
 * there rather than losing it.
 */
export interface ParsedViolationEvent {
  /** The severity the producer named; absent when it named none. */
  readonly tier?: ViolationReportTier;
  readonly tool: string;
  readonly message: string;
  /** The engine turn id, when the payload carried one. */
  readonly turnId?: string;
  /** The offending call's own id, when the payload carried one. */
  readonly toolUseId?: string;
  /** Consecutive confirmed violations; absent on the notification stage. */
  readonly confirmedViolations?: number;
  /**
   * Well-formed per-item bounded cleanup. Items whose cleanup is not one of
   * the three states are DROPPED, never defaulted: a fabricated
   * `confirmed_stopped` is the one failure mode this contract exists to
   * prevent. An empty array is not a claim that nothing needed stopping.
   */
  readonly cleanup?: ReadonlyArray<ParsedViolationCleanupItem>;
  /** The producer's payload verbatim, so this projection is never lossy. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export type ParsedViolationCleanupItem = {
  readonly kind: "subagent" | "background_task";
  readonly id: string;
  readonly state: "stop_requested" | "confirmed_stopped" | "unconfirmed";
  readonly reason?: string;
  readonly cleanup: ParsedCleanupEvidence;
};

export type ParsedCleanupEvidence =
  | { readonly state: "not_started" }
  | { readonly state: "confirmed_stopped"; readonly pgid: number; readonly task_id?: string }
  | {
      readonly state: "unconfirmed";
      readonly reason: "observation_expired" | "teardown_failed";
      readonly pgid: number;
      readonly detail: string;
      readonly task_id?: string;
    };

/** The tiers a producer may name, and the payload stage each implies. */
const REPORT_TIERS: ReadonlySet<string> = new Set([
  "low",
  "mid",
  "high",
  "mid-escalation",
]);

const CLEANUP_BODIES: Readonly<
  Record<string, (body: Record<string, unknown>) => ParsedCleanupEvidence | undefined>
> = {
  confirmed_stopped: (body) => ({
    state: "confirmed_stopped",
    pgid: body["pgid"] as number,
    ...optionalTaskId(body),
  }),
  unconfirmed: (body) => {
    const reason = body["reason"];
    const detail = body["detail"];
    if (
      typeof reason !== "string" ||
      reason !== "observation_expired" &&
        reason !== "teardown_failed" ||
      typeof detail !== "string"
    ) {
      return undefined;
    }
    return {
      state: "unconfirmed",
      reason,
      pgid: body["pgid"] as number,
      detail,
      ...optionalTaskId(body),
    };
  },
};

/** The owner id, when the payload named one; a body never requires it. */
function optionalTaskId(
  body: Readonly<Record<string, unknown>>
): { readonly task_id?: string } {
  const taskId = body["task_id"];
  return typeof taskId === "string" ? { task_id: taskId } : {};
}

/**
 * The three-state cleanup body, or undefined when the shape is not one of them.
 * Never a default: an unknown shape is an absent claim, not a stop.
 */
function readCleanupBody(
  value: unknown
): ParsedCleanupEvidence | undefined {
  if (!isPlainRecord(value)) return undefined;
  const state = value["state"];
  if (state === "not_started") return { state: "not_started" };
  const build =
    typeof state === "string" ? CLEANUP_BODIES[state] : undefined;
  if (build === undefined) return undefined;
  const pgid = value["pgid"];
  if (typeof pgid !== "number" || !Number.isFinite(pgid)) return undefined;
  return build(value);
}

/**
 * The owner kinds a cleanup item may name, and the per-item stop states it may
 * report. Enumerated as tables (the same shape as `REPORT_TIERS`) so adding a
 * state is one entry rather than another branch in the reader, and so the
 * recognized set and the projected union below cannot drift apart.
 */
const CLEANUP_ITEM_KINDS: ReadonlySet<string> = new Set([
  "subagent",
  "background_task",
]);

const CLEANUP_ITEM_STATES: ReadonlySet<string> = new Set([
  "stop_requested",
  "confirmed_stopped",
  "unconfirmed",
]);

/** Narrowing reads of the two enumerated fields, off the same tables above. */
function isCleanupItemKind(
  value: unknown
): value is ParsedViolationCleanupItem["kind"] {
  return typeof value === "string" && CLEANUP_ITEM_KINDS.has(value);
}

function isCleanupItemState(
  value: unknown
): value is ParsedViolationCleanupItem["state"] {
  return typeof value === "string" && CLEANUP_ITEM_STATES.has(value);
}

/**
 * Project one interruption cleanup item, or undefined when it does not carry
 * a well-formed owner identity plus a recognized cleanup verdict.
 */
export function parseViolationCleanupItem(
  value: unknown
): ParsedViolationCleanupItem | undefined {
  if (!isPlainRecord(value)) return undefined;
  const kind = value["kind"];
  const id = value["id"];
  const state = value["state"];
  if (
    !isCleanupItemKind(kind) ||
    typeof id !== "string" ||
    id.length === 0 ||
    !isCleanupItemState(state)
  ) {
    return undefined;
  }
  const cleanup = readCleanupBody(value["cleanup"]);
  if (cleanup === undefined) return undefined;
  return {
    kind,
    id,
    state,
    ...(typeof value["reason"] === "string" ? { reason: value["reason"] } : {}),
    cleanup,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The well-formed items of the payload's `cleanup` array, if it is one. */
function readCleanupItems(
  raw: unknown
): ReadonlyArray<ParsedViolationCleanupItem> | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map(parseViolationCleanupItem)
    .filter((item): item is ParsedViolationCleanupItem => item !== undefined);
}

/** `{ [key]: value }` when the payload holds a string there, `{}` otherwise. */
function optionalString(
  parsed: Readonly<Record<string, unknown>>,
  key: string
): Record<string, string> {
  const value = parsed[key];
  return typeof value === "string" ? { [key]: value } : {};
}

/**
 * The one parser for a `createKillSessionHook` payload.
 *
 * Returns undefined only for a payload that is not a violation record at all
 * (unparseable, not an object, or not tagged `kind: "violation"`). Every
 * field INSIDE a recognized payload is optional and validated independently,
 * so a partially malformed record still yields a readable answer rather than
 * vanishing — losing the whole row is what broke the hub's join.
 */
export function parseViolationEvent(
  raw: unknown
): ParsedViolationEvent | undefined {
  if (typeof raw !== "string") {
    if (!isPlainRecord(raw)) return undefined;
    return readViolationPayload(raw);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) return undefined;
  return readViolationPayload(parsed);
}

function readViolationPayload(
  parsed: Record<string, unknown>
): ParsedViolationEvent | undefined {
  if (parsed["kind"] !== "violation") return undefined;
  const tier = parsed["tier"];
  const confirmed = parsed["confirmedViolations"];
  const cleanup = readCleanupItems(parsed["cleanup"]);
  return {
    // Present only when the producer named a tier this build recognizes.
    // An absent or unrecognized value leaves the field absent — never
    // rewritten, because a reader that renames a severity is asserting a fact
    // the payload does not carry.
    ...(typeof tier === "string" && REPORT_TIERS.has(tier)
      ? { tier: tier as ViolationReportTier }
      : {}),
    tool: typeof parsed["tool"] === "string" ? parsed["tool"] : "",
    message: typeof parsed["message"] === "string" ? parsed["message"] : "",
    ...optionalString(parsed, "turnId"),
    ...optionalString(parsed, "toolUseId"),
    ...(typeof confirmed === "number" && Number.isFinite(confirmed)
      ? { confirmedViolations: confirmed }
      : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
    detail: parsed,
  };
}

/** Which report stage a payload represents, given the tier it named. */
export function violationStageOf(
  tier: ViolationReportTier | undefined
): ViolationStage {
  return tier === "mid-escalation" ? "notification" : "report";
}

export interface ViolationCounterRecordResult {
  readonly count: number;
  readonly shouldKill: boolean;
}

export interface ViolationCounter {
  /** Record an event; returns the current count and whether the turn
   *  should be interrupted (mid: count >= threshold; high: immediate). */
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
    // mid: accumulate; interrupt at threshold. Repeated hits of one rule
    // count — there is no same-rule de-duplication (ADR-0135).
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
 *   - `[fs_denied]`                              → mid
 *   - `[security_review_unavailable]`            → neutral (ADR-0135; see header)
 *   - `[permission_denied]` (non-dangerous)      → low
 *   - `[user_denied]`                            → low
 *   - cancellation (`message: "cancelled"`)      → neutral; an interrupted
 *     call is the consequence of a decision, not evidence of unsafe intent
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

  const {
    hardWall,
    permissionDenied,
    userDenied,
    networkDenied,
    fsDenied,
  } = VIOLATION_PREFIXES;

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
 * Violation hook factory
 * -------------------------------------------------------------------------- */

/**
 * One user turn's escalation state (ADR-0135).
 *
 * Grouped into a single object because the three pieces must share a
 * lifetime: a fresh scope per user turn is what makes "the streak starts at
 * zero in a new turn" and "work from an earlier turn is not cancelled here"
 * true without either being a rule someone has to remember. Hosts that can
 * rebuild their executor per turn may skip this and pass the parts directly;
 * hosts that wrap once and run many turns (the chat REPL) resolve one of
 * these per turn.
 */
export interface ViolationTurnScope {
  readonly counter: ViolationCounter;
  /** Work this turn owns; cancelled only on this turn's interruption. */
  readonly ownedWork: TurnWorkRegistry;
  /** Aborted on escalation to stop in-flight tools and later waves. */
  readonly interrupt: AbortController;
  /** One-shot latch: the turn is interrupted at most once. */
  interrupted: boolean;
}

/** Build a fresh turn scope. `routes` are the owned-work cancel routes. */
export function createViolationTurnScope(
  routes: TurnWorkCancelRoutes = {}
): ViolationTurnScope {
  return {
    counter: createViolationCounter(),
    ownedWork: createTurnWorkRegistry(routes),
    interrupt: new AbortController(),
    interrupted: false,
  };
}

/** The structured interruption payload, as it reaches the trace (ADR-0135). */
export interface ViolationInterruption {
  readonly kind: "violation";
  /** `high` keeps its existing immediate-handling label; `mid` escalates. */
  readonly tier: "high" | "mid";
  readonly tool: string;
  readonly message: string;
  /**
   * The engine turn id the violation was observed under, when the host's
   * executor call carried one. Carried so a reviewer can bind the cause to a
   * specific trace `turn` row rather than by ordering (see
   * `SecurityInterruptionRecord.turnId`).
   */
  readonly turnId?: string;
  /** Consecutive confirmed violations that produced this interruption. */
  readonly confirmedViolations: number;
  /** Per-item bounded cleanup evidence for this turn's owned work. */
  readonly cleanup: ReadonlyArray<TurnOwnedWorkCleanup>;
}

export interface CreateKillSessionHookOpts {
  readonly counter: ViolationCounter;
  /**
   * Notification seam, unchanged in shape: the string carries the
   * JSON-formatted violation details for the trace and the operator line.
   */
  readonly onKill: (reason: string) => void;
  /**
   * Synchronous escalation signal, fired the instant the threshold is
   * reached. The host aborts the turn here: in-flight tools and every later
   * wave must stop before any awaited cleanup pass runs, so this seam
   * carries no payload and does no work.
   */
  readonly onEscalate?: () => void;
  /**
   * The turn interruption report (ADR-0135). Fired at most once per counter,
   * after owned work has been cancelled and its bounded cleanup evidence
   * collected, so the reason string already carries the cleanup report. The
   * host persists / reports it and retains the session.
   */
  readonly onInterrupt?: (reason: string) => void;
  /**
   * Bounded cleanup for the work this turn owns. Absent → the interruption
   * still fires, with an empty cleanup list (nothing is claimed to be
   * stopped). Must not throw; a throw is reported, never swallowed.
   */
  readonly cleanupOwnedWork?: () => Promise<
    ReadonlyArray<TurnOwnedWorkCleanup>
  >;
  /**
   * The engine turn id for the call being observed, when known. The executor
   * reads it per call and feeds it through the hook's result, so a turn that
   * escalates names itself in the report.
   */
  readonly currentTurnId?: () => string | undefined;
}

export function createKillSessionHook(
  opts: CreateKillSessionHookOpts
): PostToolUseHook {
  const {
    counter,
    onKill,
    onEscalate,
    onInterrupt,
    cleanupOwnedWork,
    currentTurnId,
  } = opts;
  // One interruption per turn: the counter keeps counting past the threshold
  // (a later wave may still observe one), and re-firing would re-report the
  // same interruption with a second cleanup pass.
  let interrupted = false;
  return (result) => {
    const cat = categorizeResult(result);
    // A successful admitted call clears the streak; a neutral outcome is
    // simply not an event, so it reaches neither branch.
    if (cat.tier === undefined) {
      if (result.kind === "ok") counter.reset();
      return;
    }
    const { count, shouldKill } = counter.record({
      tier: cat.tier,
      tool: result.name,
      input: result.input,
      message: cat.detail,
    });
    if (!shouldKill) return;
    const turnId = currentTurnId?.();
    const base = {
      kind: "violation" as const,
      tier: cat.tier === "high" ? ("high" as const) : ("mid" as const),
      tool: result.name,
      message: cat.detail,
      ...(turnId !== undefined ? { turnId } : {}),
      confirmedViolations: count,
    };
    onKill(
      JSON.stringify({
        ...base,
        tier: cat.tier === "high" ? "high" : "mid-escalation",
      })
    );
    // Stop scheduling first, report second. The synchronous seam fires before
    // any await, so in-flight tools are cancelled while the cleanup pass runs
    // rather than after it.
    onEscalate?.();
    if (interrupted) return undefined;
    interrupted = true;
    // The returned promise is the report's settle point: the hook is awaited
    // by the observing executor, so a caller that awaits its executeAll knows
    // the cleanup evidence is complete without polling.
    //
    // Cleanup is awaited before the host is told, so the interruption payload
    // is complete: a reviewer reading it sees which items were signalled and
    // which teardown was unconfirmed. A failing cleanup pass is reported as
    // an unconfirmed item rather than being allowed to hide the interruption.
    //
    // The cleanup pass runs whether or not a report sink was supplied: the
    // turn's own work must be cancelled because the turn stopped, not
    // because someone is listening. Gating it on `onInterrupt` would let a
    // host with no sink leave this turn's workers and background jobs
    // running — the exact failure this contract exists to prevent.
    return (async () => {
      let cleanup: ReadonlyArray<TurnOwnedWorkCleanup> = [];
      if (cleanupOwnedWork !== undefined) {
        try {
          cleanup = await cleanupOwnedWork();
        } catch (err) {
          cleanup = [
            {
              kind: "background_task",
              id: "<turn-owned-work>",
              state: "unconfirmed",
              reason: err instanceof Error ? err.message : String(err),
              cleanup: { state: "not_started" },
            },
          ];
        }
      }
      onInterrupt?.(
        JSON.stringify({ ...base, cleanup } satisfies ViolationInterruption)
      );
    })();
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
      `[violation] session killed: tier=${
        event.tier ?? "unrecorded"
      } tool=${event.tool} message=${event.message}`);
  let fired = false;
  return (reason: string): void => {
    if (fired) return;
    fired = true;
    // The shared parser, so this line cannot disagree with the trace row or
    // the hub's durable record about what one payload said. A payload it
    // rejects is a kill reason that is not a violation record at all; the
    // fail-safe is the worst tier, because a reason that arrived here DID stop
    // a session and downgrading its severity would mask that.
    const parsed = parseViolationEvent(reason);
    const event: ViolationEvent = {
      // `mid-escalation` is a stage label rather than a counter severity, and
      // `ViolationEvent.tier` is the counter's own union — the notification is
      // by construction a mid-tier threshold crossing, so the counter tier is
      // `mid` and the stage travels on the parsed payload, not here.
      tier:
        parsed === undefined
          ? "high"
          : parsed.tier === "mid-escalation"
            ? "mid"
            : parsed.tier,
      tool: parsed?.tool ?? "",
      input: undefined,
      message: parsed?.message ?? reason,
    };
    opts.sink(format(event));
    process.exitCode = 1;
  };
}
