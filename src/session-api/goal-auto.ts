/**
 * Plan T3 / issue 574: shared `/goal` auto-loop fields and stop rules.
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

/** Frozen plan: idle = 3 consecutive `completed` turns with no `tool_use`. */
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

export function decideAutoGoalAfterTurn(
  input: AutoGoalTurnInput
): AutoGoalDecision {
  const autoTurnsRan = input.autoTurnsRan + 1;

  if (input.stopReason === "cancelled") {
    return {
      continueAuto: false,
      clearGoal: false,
      autoTurnsRan,
      idleCompletedStreak: input.idleCompletedStreak,
    };
  }

  const errClass = classifyError(input);
  if (errClass === "unrecoverable") {
    return {
      continueAuto: false,
      clearGoal: true,
      autoTurnsRan,
      idleCompletedStreak: input.idleCompletedStreak,
    };
  }
  if (errClass === "transient") {
    return {
      continueAuto: false,
      clearGoal: false,
      autoTurnsRan,
      idleCompletedStreak: input.idleCompletedStreak,
    };
  }

  if (isImpossible(input)) {
    return {
      continueAuto: false,
      clearGoal: true,
      autoTurnsRan,
      idleCompletedStreak: input.idleCompletedStreak,
    };
  }

  if (input.verifyOutcome === "passed") {
    return {
      continueAuto: false,
      clearGoal: false,
      autoTurnsRan,
      idleCompletedStreak: 0,
    };
  }

  if (
    input.verifyOutcome === "aborted" ||
    input.verifyOutcome === "escalated"
  ) {
    return {
      continueAuto: false,
      clearGoal: false,
      autoTurnsRan,
      idleCompletedStreak: input.idleCompletedStreak,
    };
  }

  const idleCompletedStreak =
    input.stopReason === "completed" && !input.roundHadToolUse
      ? input.idleCompletedStreak + 1
      : 0;

  if (idleCompletedStreak >= IDLE_COMPLETED_STOP) {
    return {
      continueAuto: false,
      clearGoal: false,
      autoTurnsRan,
      idleCompletedStreak,
    };
  }

  if (input.maxTurns !== undefined && autoTurnsRan >= input.maxTurns) {
    return {
      continueAuto: false,
      clearGoal: false,
      autoTurnsRan,
      idleCompletedStreak,
    };
  }

  return {
    continueAuto: true,
    clearGoal: false,
    autoTurnsRan,
    idleCompletedStreak,
  };
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

export async function applyGoalAutoContinue(opts: {
  readonly store: GoalAutoStore;
  readonly conversationId: string;
  readonly result: Pick<RunResult, "stopReason" | "messages">;
  readonly priorCount: number;
  readonly verifyOutcome?: VerifyLoopOutcome | string;
  readonly records: ReadonlyArray<{
    readonly reason?: string;
    readonly missing?: readonly string[];
  }>;
  readonly onLoadError: GoalAutoLoadErrorHandler;
}): Promise<boolean> {
  const session = await loadSessionForAutoLoop(
    opts.store,
    opts.conversationId,
    opts.onLoadError
  );
  if (session === undefined) return false;
  const goal = activePinnedGoal(session);
  if (goal === undefined) return false;
  const judge = lastJudgeSignal(opts.records);
  const decision = decideFromPinnedGoal(goal, {
    stopReason: opts.result.stopReason,
    roundHadToolUse: turnHadToolUse(opts.result.messages, opts.priorCount),
    ...(opts.verifyOutcome !== undefined
      ? { verifyOutcome: opts.verifyOutcome }
      : {}),
    ...judge,
  });
  await persistGoalDecision(opts.store, opts.conversationId, decision);
  return decision.continueAuto;
}

export async function applyGoalAutoError(opts: {
  readonly store: GoalAutoStore;
  readonly conversationId: string;
  readonly err: unknown;
  readonly onLoadError: GoalAutoLoadErrorHandler;
}): Promise<void> {
  const session = await loadSessionForAutoLoop(
    opts.store,
    opts.conversationId,
    opts.onLoadError
  );
  if (session === undefined) return;
  const goal = activePinnedGoal(session);
  if (goal === undefined) return;
  const decision = decideFromPinnedGoal(goal, {
    stopReason: "protocolError",
    roundHadToolUse: false,
    errorText: errorMessage(opts.err),
    errorName: opts.err instanceof Error ? opts.err.name : undefined,
  });
  await persistGoalDecision(opts.store, opts.conversationId, decision);
}
