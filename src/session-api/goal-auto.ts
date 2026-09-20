/**
 * Shared `/goal` auto-loop fields and stop rules.
 *
 * Slash parse, hub postMessage, and chat processChatLine must use this
 * module — one idle streak, one optional maxTurns, one Impossible/error
 * classification. Do not add StopReason values.
 */
import type { AnthropicNativeMessage, RunResult } from "../harness/index.js";
import { errorMessage } from "../harness/errors.js";
import type { GoalState, SessionFileV1 } from "./store/schema.js";
import { CURRENT_SCHEMA_VERSION } from "./store/schema.js";
import type { VerifyLoopOutcome } from "../harness/verify/index.js";

/** Idle = 3 consecutive `completed` turns with no `tool_use`. */
export const IDLE_COMPLETED_STOP = 3;

export type ParseGoalPinResult =
  | { readonly ok: true; readonly text: string; readonly maxTurns?: number }
  | { readonly ok: false; readonly error: string };

export type AutoGoalTurnInput = {
  readonly maxTurns?: number;
  readonly autoTurnsRan: number;
  readonly idleCompletedStreak: number;
  readonly stopReason: string;
  readonly roundHadToolUse: boolean;
  readonly verifyOutcome?: VerifyLoopOutcome | string;
  readonly judgeReason?: string;
  readonly judgeMissing?: readonly string[];
  readonly errorText?: string;
  readonly errorName?: string;
};

export type AutoGoalDecision = {
  readonly continueAuto: boolean;
  readonly clearGoal: boolean;
  readonly autoTurnsRan: number;
  readonly idleCompletedStreak: number;
};

const TRANSIENT_ERR = /rate\s*limit|\b429\b|overload(?:ed)?|\b529\b|\b503\b/i;
const UNRECOVERABLE_ERR =
  /auth(?:entication|orization)?\s+fail|invalid api key|\b401\b|\b403\b|unauthorized|quota(?:\s+(?:exhaust|exceed)\w*)?|billing|prompt.?too.?long|context.?length|overflowing context|ENOTFOUND|ECONNREFUSED|unreachable|model (?:not found|unavailable)/i;
const IMPOSSIBLE_JUDGE = /\bimpossible\b|cannot fix|unrecoverable completion/i;

/**
 * `/goal` and `## GOAL:` pin body: optional prefix `--max-turns <n>`, rest is
 * goal text. Omit the flag = no host-loop hard cap. Only prefix flags so a
 * goal that mentions `--max-turns` in prose is unchanged.
 */
export function parseGoalPinInput(raw: string): ParseGoalPinResult {
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((p) => p.length > 0);
  let i = 0;
  let maxTurns: number | undefined;
  while (i < parts.length) {
    if (parts[i] !== "--max-turns") break;
    const rawN = parts[i + 1];
    if (rawN === undefined) {
      return {
        ok: false,
        error: "/goal --max-turns requires a positive integer",
      };
    }
    const n = Number(rawN);
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: `Invalid --max-turns: ${rawN}` };
    }
    if (maxTurns !== undefined) {
      return { ok: false, error: "duplicate --max-turns" };
    }
    maxTurns = n;
    i += 2;
  }
  const text = parts.slice(i).join(" ").trim();
  if (text.length === 0) {
    return {
      ok: false,
      error: "Usage: /goal [--max-turns <n>] <text>",
    };
  }
  return maxTurns === undefined
    ? { ok: true, text }
    : { ok: true, text, maxTurns };
}

export function turnHadToolUse(
  messages: ReadonlyArray<AnthropicNativeMessage>,
  priorCount: number
): boolean {
  for (const msg of messages.slice(priorCount)) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type === "tool_use") return true;
    }
  }
  return false;
}

export function lastJudgeSignal(
  records: ReadonlyArray<{
    readonly reason?: string;
    readonly missing?: readonly string[];
  }>
): {
  readonly judgeReason?: string;
  readonly judgeMissing?: readonly string[];
} {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    if (rec === undefined) continue;
    if (rec.reason !== undefined || rec.missing !== undefined) {
      return {
        ...(rec.reason !== undefined ? { judgeReason: rec.reason } : {}),
        ...(rec.missing !== undefined ? { judgeMissing: rec.missing } : {}),
      };
    }
  }
  return {};
}

function classifyError(
  input: AutoGoalTurnInput
): "transient" | "unrecoverable" | undefined {
  const blob = `${input.errorName ?? ""} ${input.errorText ?? ""}`;
  if (input.errorName === "PromptTooLongError") return "unrecoverable";
  if (TRANSIENT_ERR.test(blob)) return "transient";
  if (UNRECOVERABLE_ERR.test(blob)) return "unrecoverable";
  return undefined;
}

function isImpossible(input: AutoGoalTurnInput): boolean {
  if (
    input.judgeReason !== undefined &&
    IMPOSSIBLE_JUDGE.test(input.judgeReason)
  ) {
    return true;
  }
  if (
    input.judgeMissing !== undefined &&
    input.judgeMissing.some((m) => IMPOSSIBLE_JUDGE.test(m))
  ) {
    return true;
  }
  return false;
}

function makeResponse(
  continueAuto: boolean,
  clearGoal: boolean,
  autoTurnsRan: number,
  idleCompletedStreak: number
): AutoGoalDecision {
  return { continueAuto, clearGoal, autoTurnsRan, idleCompletedStreak };
}

/** Streak advances only on completed turns that issued no tool_use. */
function computeNextIdleStreak(input: AutoGoalTurnInput): number {
  return input.stopReason === "completed" && !input.roundHadToolUse
    ? input.idleCompletedStreak + 1
    : 0;
}

/**
 * Stop classes that do not depend on the recomputed idle streak — they fire
 * before we burn cycles computing it. Returns undefined when none match.
 */
function earlyStopDecision(
  input: AutoGoalTurnInput,
  autoTurnsRan: number
): AutoGoalDecision | undefined {
  if (input.stopReason === "cancelled") {
    return makeResponse(false, false, autoTurnsRan, input.idleCompletedStreak);
  }
  const errClass = classifyError(input);
  if (errClass === "unrecoverable") {
    return makeResponse(false, true, autoTurnsRan, input.idleCompletedStreak);
  }
  if (errClass === "transient") {
    return makeResponse(false, false, autoTurnsRan, input.idleCompletedStreak);
  }
  if (isImpossible(input)) {
    return makeResponse(false, true, autoTurnsRan, input.idleCompletedStreak);
  }
  if (input.verifyOutcome === "passed") {
    return makeResponse(false, false, autoTurnsRan, 0);
  }
  if (
    input.verifyOutcome === "aborted" ||
    input.verifyOutcome === "escalated"
  ) {
    return makeResponse(false, false, autoTurnsRan, input.idleCompletedStreak);
  }
  return undefined;
}

export function decideAutoGoalAfterTurn(
  input: AutoGoalTurnInput
): AutoGoalDecision {
  const autoTurnsRan = input.autoTurnsRan + 1;
  const idleStreakNext = computeNextIdleStreak(input);
  const early = earlyStopDecision(input, autoTurnsRan);
  if (early !== undefined) return early;
  if (idleStreakNext >= IDLE_COMPLETED_STOP) {
    return makeResponse(false, false, autoTurnsRan, idleStreakNext);
  }
  if (input.maxTurns !== undefined && autoTurnsRan >= input.maxTurns) {
    return makeResponse(false, false, autoTurnsRan, idleStreakNext);
  }
  return makeResponse(true, false, autoTurnsRan, idleStreakNext);
}

export function nextGoalAfterDecision(
  goal: GoalState,
  decision: AutoGoalDecision
): GoalState | undefined {
  if (decision.clearGoal) return undefined;
  return {
    ...goal,
    autoTurnsRan: decision.autoTurnsRan,
    idleCompletedStreak: decision.idleCompletedStreak,
    ...(goal.maxTurns !== undefined ? { maxTurns: goal.maxTurns } : {}),
  };
}

/** Injected store for auto-loop persist; hosts pass SessionStore. */
export type GoalAutoStore = {
  load(id: string): Promise<SessionFileV1>;
  save(opts: {
    readonly id: string;
    readonly file: SessionFileV1;
  }): Promise<void>;
};

/** Host I/O on typed load fault: writeErr, skip, or rethrow. */
export type GoalAutoLoadErrorHandler = (err: unknown) => void;

/**
 * Render a store-load typed error in the chat `/goal` contract form:
 * `${kind}: ${conversation_id}`. Used by both hub and chat hosts so the
 * stderr wire is byte-identical between the two entry points.
 *
 * Why a stderr-only render (no rethrow, no save): the auto-loop is best-effort
 * — a load fault on the persist side must not change the continue/stop
 * decision. The helper discriminates by `kind` (per the code-quality.md
 * typed-error catch contract):
 * `not_found` = silent (no goal state to persist on a missing file), all other
 * kinds → render. Non-typed throws fall through unchanged so the store contract
 * remains authoritative (defensive — store is contracted to throw only typed).
 */
export function reportGoalAutoStoreLoadErr(
  err: unknown,
  conversationId: string
): void {
  if (!isTypedStoreLoadError(err)) return;
  const kind = (err as { kind: string }).kind;
  if (kind === "not_found") return;
  process.stderr.write(`${kind}: ${conversationId}\n`);
}

/** Narrow to typed SessionStoreError-like shape (kind + conversation_id). */
function isTypedStoreLoadError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  if (err instanceof Error) return false;
  const kind = (err as { kind?: unknown }).kind;
  return (
    kind === "not_found" ||
    kind === "parse_failed" ||
    kind === "schema_invalid" ||
    kind === "io_error" ||
    kind === "write_failed" ||
    kind === "concurrent_write"
  );
}

export async function persistGoalDecision(
  store: GoalAutoStore,
  conversationId: string,
  decision: AutoGoalDecision
): Promise<void> {
  const existing = await store.load(conversationId);
  if (existing.goal === undefined) return;
  const now = new Date().toISOString();
  await store.save({
    id: conversationId,
    file: {
      ...existing,
      goal: nextGoalAfterDecision(existing.goal, decision),
      updatedAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    },
  });
}

function activePinnedGoal(session: SessionFileV1): GoalState | undefined {
  const goal = session.goal;
  if (goal === undefined || goal.text.length === 0) return undefined;
  return goal;
}

async function loadSessionForAutoLoop(
  store: GoalAutoStore,
  conversationId: string,
  onLoadError: GoalAutoLoadErrorHandler
): Promise<SessionFileV1 | undefined> {
  try {
    return await store.load(conversationId);
  } catch (err) {
    onLoadError(err);
    return undefined;
  }
}

function decideFromPinnedGoal(
  goal: GoalState,
  rest: Omit<
    AutoGoalTurnInput,
    "maxTurns" | "autoTurnsRan" | "idleCompletedStreak"
  >
): AutoGoalDecision {
  return decideAutoGoalAfterTurn({
    ...(goal.maxTurns !== undefined ? { maxTurns: goal.maxTurns } : {}),
    autoTurnsRan: goal.autoTurnsRan ?? 0,
    idleCompletedStreak: goal.idleCompletedStreak ?? 0,
    ...rest,
  });
}

/**
 * Run-side payload for `applyGoalAutoContinue`. Composed so the public opts
 * stays ≤4 fields (max-params soft cap); the host passes this instead of
 * `{result, priorCount, verifyOutcome, records}` individually.
 */
export type RunResultSummary = {
  readonly result: Pick<RunResult, "stopReason" | "messages">;
  readonly priorCount: number;
  readonly verifyOutcome?: VerifyLoopOutcome | string;
  readonly records: ReadonlyArray<{
    readonly reason?: string;
    readonly missing?: readonly string[];
  }>;
};

/**
 * Shared auto-loop pipeline (load → activePinnedGoal → buildInput →
 * decide → persist). `applyGoalAutoContinue` and `applyGoalAutoError`
 * delegate here; only the `buildInput` callback differs. Returns the
 * decision when one was made, or `undefined` on load fault / no active goal.
 */
async function withActiveGoal(
  store: GoalAutoStore,
  conversationId: string,
  onLoadError: GoalAutoLoadErrorHandler,
  buildInput: (
    goal: GoalState
  ) => Omit<
    AutoGoalTurnInput,
    "maxTurns" | "autoTurnsRan" | "idleCompletedStreak"
  >
): Promise<AutoGoalDecision | undefined> {
  const session = await loadSessionForAutoLoop(
    store,
    conversationId,
    onLoadError
  );
  if (session === undefined) return undefined;
  const goal = activePinnedGoal(session);
  if (goal === undefined) return undefined;
  const decision = decideFromPinnedGoal(goal, buildInput(goal));
  await persistGoalDecision(store, conversationId, decision);
  return decision;
}

export async function applyGoalAutoContinue(opts: {
  readonly store: GoalAutoStore;
  readonly conversationId: string;
  readonly summary: RunResultSummary;
  readonly onLoadError: GoalAutoLoadErrorHandler;
}): Promise<boolean> {
  const decision = await withActiveGoal(
    opts.store,
    opts.conversationId,
    opts.onLoadError,
    () => {
      const judge = lastJudgeSignal(opts.summary.records);
      return {
        stopReason: opts.summary.result.stopReason,
        roundHadToolUse: turnHadToolUse(
          opts.summary.result.messages,
          opts.summary.priorCount
        ),
        ...(opts.summary.verifyOutcome !== undefined
          ? { verifyOutcome: opts.summary.verifyOutcome }
          : {}),
        ...judge,
      };
    }
  );
  return decision?.continueAuto ?? false;
}

export async function applyGoalAutoError(opts: {
  readonly store: GoalAutoStore;
  readonly conversationId: string;
  readonly err: unknown;
  readonly onLoadError: GoalAutoLoadErrorHandler;
}): Promise<void> {
  await withActiveGoal(
    opts.store,
    opts.conversationId,
    opts.onLoadError,
    () => ({
      stopReason: "protocolError",
      roundHadToolUse: false,
      errorText: errorMessage(opts.err),
      errorName: opts.err instanceof Error ? opts.err.name : undefined,
    })
  );
}

/**
 * /goal auto-loop skeleton. Shared by `hub.postMessage` and the chat REPL;
 * each host supplies its own `run` / `persist` / `buildStop` /
 * `decideContinue` / `reloadSession`. Errors stay in the host (hub: rethrow;
 * chat: convert to error result); reload is an explicit parameter choice —
 * hub passes `() => store.load(id)` (refresh session between iterations);
 * chat passes a no-op (in-memory `ctx.state.messages` already mutated
 * inside `run`).
 *
 * `buildStop` runs BEFORE `decideContinue` so the stop response (hub's
 * dto.session = the just-persisted file; chat's outputs accumulator) sees
 * the post-persist state but the load it performs cannot shadow the
 * `decideContinue` load (matters when load faults — hub's `applyAutoContinue`
 * uses store.load too; building dto first lets decideContinue's load-fault
 * propagate cleanly without re-loading).
 */
export async function runAutoLoopSteps<R, S>(opts: {
  readonly run: () => Promise<R>;
  readonly persist: (result: R) => Promise<void>;
  readonly buildStop: (result: R) => Promise<S>;
  readonly decideContinue: (result: R) => Promise<boolean>;
  readonly reloadSession: () => Promise<void>;
}): Promise<S> {
  let last: R;
  let lastStop: S;
  for (;;) {
    last = await opts.run();
    await opts.persist(last);
    lastStop = await opts.buildStop(last);
    const more = await opts.decideContinue(last);
    if (!more) return lastStop;
    await opts.reloadSession();
  }
}
