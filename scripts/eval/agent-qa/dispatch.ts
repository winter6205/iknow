/**
 * Dispatch: assemble the FULL production engine for one attempt and run it against
 * the scripted provider — the only seam that is faked.
 *
 * Composition mirrors the production `ask` entry (src/cli.ts:380-540): a minted
 * conversation id, `buildHarnessEngine(...)` with the ask-surface switches, a
 * production `createJsonlTraceService` writing inside the attempt directory, then
 * the loop through `run`. It calls `src/harness/build-engine.ts` directly instead
 * of the `src/cli/runtime.ts` wrapper because that wrapper's only extra work is
 * `initIknowWorkspaceSafe()` + `runHostInitScriptSafe()`, which seed and execute
 * files under the operator's real `~/.iknow`. An evaluation must not write the
 * operator's persona or spawn their init script, and everything that actually
 * builds the engine is identical.
 *
 * The env and settings are built explicitly here and injected through the
 * assembly's own seams, so `loadIknowEnv` / `loadIknowSettings` never run: no
 * operator settings, no real credential, no real endpoint is reachable.
 */
import { join } from "node:path";

import { buildHarnessEngine } from "../../../src/harness/build-engine.ts";
import { MaxTurnsExceeded } from "../../../src/harness/errors.ts";
import { createFailClosedAskUser } from "../../../src/harness/permission/ask-user.ts";
import { createPermissionModeContext } from "../../../src/harness/permission/modes.ts";
import type { PermissionMode } from "../../../src/harness/permission/modes.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createJsonlTraceReader } from "../../../src/traceserver/reader.ts";
import type { TraceRecordRow } from "../../../src/traceserver/types.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type { IknowSettings } from "../../../src/config/settings.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";

import { makeDir } from "./artifacts.ts";
import { SYNTHETIC_API_KEY } from "./provider.ts";
import { assertScriptConsumed, startScriptedProvider } from "./provider.ts";
import type { ScriptedProvider } from "./provider.ts";
import { isEvalFailure } from "./failures.ts";
import type { CleanupStatus, FailureRef } from "./failures.ts";
import { declaredLimits } from "./plan.ts";
import type {
  Budget,
  LimitName,
  LimitState,
  ScriptedStep,
  UsageRecord,
  Validity,
} from "./types.ts";

/** How long teardown may take before cleanup is reported as unconfirmed. */
const CLEANUP_GRACE_MS = 2_000;

/** The surfaces this capability can dispatch on; production owns the full union. */
export type EngineSurface = "ask" | "chat";

/**
 * Where the session ledger base sits, relative to the scratch workspace. It is a
 * workspace path on purpose: a `workspace-bytes` oracle is confined to the sandbox root
 * by construction, and the attempt's ledger is evidence that oracle must be able to read.
 */
export const SESSION_LEDGER_BASE = ".session";

/**
 * Slots whose behavior is a capability the ask inlet deliberately does not assemble
 * (`todo_write`, `run_graph`): dispatching them on `ask` would measure the absent seam
 * rather than the behavior their locked fixture owns. Everything else runs on `ask`.
 */
const CHAT_SURFACE_CASE_IDS: ReadonlySet<string> = new Set<string>([
  "task-03",
  "tool-03",
  "turn-01",
  "recovery-03",
]);

/** The production entry surface one slot dispatches on, as one explicit lookup. */
export function surfaceFor(caseId: string): EngineSurface {
  return CHAT_SURFACE_CASE_IDS.has(caseId) ? "chat" : "ask";
}

export type DispatchInput = {
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly traceDir: string;
  readonly conversationId: string;
  readonly turns: readonly string[];
  readonly scripted: readonly ScriptedStep[];
  /** The frozen budget: every limit it declares gets a state in the result. */
  readonly budget: Budget;
  readonly permissionMode?: PermissionMode;
  /**
   * Production entry surface for this attempt. The default is `ask`, the entry this
   * capability mirrors; `chat` is offered because several catalog slots exercise
   * capabilities the ask inlet deliberately does not assemble (todo_write, run_graph):
   * scripting those against ask would measure the missing seam, not the behavior.
   */
  readonly surface?: EngineSurface;
  /** `absent` makes the scripted provider state no usage, the unknown-usage arm. */
  readonly providerUsage?: "reported" | "absent";
};

export type DispatchResult = {
  readonly conversationId: string;
  readonly tracePath: string;
  readonly turnsRun: number;
  readonly stopReason: string;
  readonly observedWallMs: number;
  readonly providerRequests: number;
  readonly limits: readonly LimitState[];
  readonly usage: UsageRecord;
  readonly validity: Validity;
  readonly cleanup: {
    readonly status: CleanupStatus;
    readonly owned: readonly string[];
  };
  readonly failure: FailureRef | null;
};

/**
 * Synthetic env — the shape the production env loader would hand back, written out
 * here so no settings file is ever read. `stream: "off"` pins the non-streaming
 * arm, which is the arm this provider can prove offline.
 */
function syntheticEnv(baseUrl: string): IknowEnv {
  return {
    llm: {
      baseUrl,
      model: "test-model",
      fallback: [],
      apiKey: SYNTHETIC_API_KEY,
      maxOutputTokens: 1024,
      // The SDK refuses a non-streaming create whose output budget could outrun a
      // 10-minute request; a budget over that ceiling is a hard client error, so the
      // synthetic route states a small, real one and keeps the offline arm provable.
      routeMaxTokens: 1024,
      timeoutMs: 30_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "off",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 150 },
    subagent: { taskTimeoutMs: undefined },
    workspaceRoot: undefined,
    productRoot: undefined,
  };
}

function syntheticSettings(): IknowSettings {
  return { llm: { model: "test-model", apiKey: SYNTHETIC_API_KEY } };
}

/** Rows large enough to page: the reader caps one query at 200 records. */
const TRACE_PAGE_ROWS = 200;

/**
 * Every `llm_call` row of the attempt's own trace, or `null` when the trace cannot be
 * read whole. A truncated read or a line that failed to parse is not a smaller trace:
 * the rows after the cut exist and would carry cost the sum never saw.
 */
function llmCallRows(
  tracePath: string,
  maxBytes?: number
): readonly TraceRecordRow[] | null {
  try {
    const reader = createJsonlTraceReader({ filePath: tracePath, maxBytes });
    const rows: TraceRecordRow[] = [];
    for (;;) {
      const page = reader.query({
        recordType: "llm_call",
        limit: TRACE_PAGE_ROWS,
        offset: rows.length,
      });
      // EXIT: rows exist past a truncated page or a line the reader skipped, so the sum
      // would omit cost; the total is unknown, nothing is summed, dispatch may continue.
      if (page.truncated || page.skippedLines > 0) return null;
      rows.push(...page.records);
      // EXIT: every row the reader counted is in hand; the caller sums exactly what it sees.
      if (rows.length >= page.total) return rows;
      // EXIT: the reader promises more rows yet returns none, so paging cannot advance;
      // the total is unknown, nothing is summed, dispatch may continue.
      if (page.records.length === 0) return null;
    }
  } catch {
    // EXIT: any throw from the production reader — a trace it cannot open, a torn line it
    // refuses to parse, an fs fault on the way in — leaves the attempt's cost unobserved;
    // the record states null, the caller decides nothing from it, and dispatch may continue.
    return null;
  }
}

/**
 * One usage counter summed over the calls that stated it. A call that stated no usage —
 * an error row omits the keys, because the writer never guesses zeros — makes the whole
 * total unknown rather than partly known: a sum that skipped a call is not that call's
 * cost, and `null` is the only reading that does not claim one.
 */
function sumUsage(
  rows: readonly TraceRecordRow[] | null,
  key: string
): number | null {
  if (rows === null || rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

/**
 * What the attempt cost, read from the evidence a reviewer re-reads rather than from the
 * loop's last model call: the trace rows are one per call, while a run result names only
 * its final call's usage, and a record that reports that as the attempt's total
 * understates every run that called the model more than once.
 */
/**
 * Token totals for one retained trace. `null` means the trace was not read whole
 * (a byte-window cut, a line the reader skipped, or a page that would not advance)
 * or a call omitted its usage. A partial sum is never returned in those cases.
 * `maxBytes` is the production reader's own cap, exposed so a short file can
 * stand in for a trace that does not fit the window.
 */
export function traceTokenTotals(
  tracePath: string,
  options?: { readonly maxBytes?: number }
): {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
} {
  const rows = llmCallRows(tracePath, options?.maxBytes);
  return {
    inputTokens: sumUsage(rows, "input_tokens"),
    outputTokens: sumUsage(rows, "output_tokens"),
  };
}

function usageOf(
  rows: readonly TraceRecordRow[] | null,
  observedWallMs: number
): UsageRecord {
  const inputTokens = sumUsage(rows, "input_tokens");
  const outputTokens = sumUsage(rows, "output_tokens");
  return {
    inputTokens,
    outputTokens,
    wallMs: observedWallMs,
    usageComplete: inputTokens !== null && outputTokens !== null,
  };
}

async function stopProvider(provider: ScriptedProvider): Promise<boolean> {
  try {
    await provider.stop();
  } catch {
    // EXIT: the loopback server refused to close — the caller must not report a
    // confirmed cleanup; nothing further is attempted.
    return false;
  }
  return true;
}

/** Bounded teardown: an owned resource that never confirms a stop is a fault, not a success. */
async function withGrace<T>(work: Promise<T>, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), CLEANUP_GRACE_MS);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One turn's production call. `priorMessages` is the production continuation seam,
 * so a multi-turn case stays one run of the same loop with the same frozen history.
 */
async function runTurn(
  text: string,
  deps: Parameters<typeof run>[1],
  signal: AbortSignal,
  priorMessages: readonly AnthropicNativeMessage[]
) {
  return run(text, deps, signal, {
    ...(priorMessages.length > 0 ? { priorMessages } : {}),
  });
}

type Engine = Awaited<ReturnType<typeof buildHarnessEngine>>;

/**
 * What the run has observed so far. One object rather than five locals so the turn
 * driver and the fault classifier can each settle a part of it without the entry
 * point having to thread the pieces back together.
 */
type RunState = {
  turnsRun: number;
  stopReason: string;
  validity: Validity;
  failure: FailureRef | null;
  history: readonly AnthropicNativeMessage[];
};

function initialState(): RunState {
  return {
    turnsRun: 0,
    stopReason: "not-run",
    validity: "valid",
    failure: null,
    history: [],
  };
}

/**
 * The production assembly for one attempt. Kept out of `dispatchAttempt` because it is
 * the only part that touches the operator's home: the isolated `HOME` under the attempt's
 * own state directory is what keeps the persona and init files of the real `~/.iknow`
 * out of the run.
 */
async function assembleEngine(
  input: DispatchInput,
  baseUrl: string
): Promise<Engine> {
  const homeRoot = join(input.dataDir, "home");
  makeDir(homeRoot, "dispatch");
  return buildHarnessEngine({
    env: syntheticEnv(baseUrl),
    askUser: createFailClosedAskUser(),
    surface: input.surface ?? "ask",
    memory: { enabled: false },
    permissionMode: createPermissionModeContext(
      input.permissionMode ?? "full_auto"
    ),
    settings: syntheticSettings(),
    cwd: input.workspaceRoot,
    userHome: homeRoot,
    sandboxRoot: input.workspaceRoot,
    workspaceRoot: input.workspaceRoot,
    productRoot: input.workspaceRoot,
    sessionRootDir: input.dataDir,
    sessionConversationId: () => input.conversationId,
    subagentDiagnosticsDir: input.traceDir,
    mcpFirstTurnReadyTimeoutMs: 150,
    skipCountTokens: true,
    // The session ledger stays inside the disposable workspace: a `workspace-bytes`
    // oracle is confined to the sandbox root by construction, so a ledger written
    // outside it could only ever be read as an absence. Host-injection is the
    // product's own seam for this directory, and ask never registers `todo_write`.
    todoDir: join(input.workspaceRoot, SESSION_LEDGER_BASE),
  });
}

/** The declared turns, in order, until one of them stops short of completion. */
async function driveTurns(
  state: RunState,
  deps: Parameters<typeof run>[1],
  signal: AbortSignal,
  turns: readonly string[]
): Promise<void> {
  for (const text of turns) {
    if (signal.aborted) {
      // EXIT: the wall clock already fired — dispatching another turn would measure a
      // run the declared limit forbade; the caller still stops the owned resources.
      state.stopReason = "cancelled";
      return;
    }
    const outcome = await runTurn(text, deps, signal, state.history);
    state.turnsRun += outcome.result.turnCount;
    state.stopReason = outcome.result.stopReason;
    state.history = outcome.result.messages;
    // EXIT: a turn that did not complete is the run's last observable turn — sending
    // the next scripted turn to a loop that stopped would measure a run nobody declared.
    if (state.stopReason !== "completed") return;
  }
}

/**
 * Why the run did not settle, named from the fault rather than guessed: the turn cap,
 * an evaluation fault, the declared wall clock, the scripted provider running out of
 * script, and everything else are five different claims about the product.
 */
function applyFault(
  state: RunState,
  error: unknown,
  wallAborted: boolean,
  provider: ScriptedProvider
): void {
  if (error instanceof MaxTurnsExceeded) {
    state.stopReason = "maxTurns";
    // The cap throws out of the loop, so the run never hands back a result. The
    // engine's own count is the authoritative one: the provider served one extra
    // summary call that the loop deliberately does not charge to the cap.
    state.turnsRun = error.turnsRan;
    return;
  }
  if (isEvalFailure(error)) {
    state.validity = "invalid";
    state.failure = { kind: error.kind, phase: error.phase };
    return;
  }
  if (wallAborted) {
    // EXIT: the loop surfaces the abort as a throw on some paths — the wall clock is
    // still the cause, so it is never re-labelled a provider fault; teardown follows.
    state.stopReason = "cancelled";
    state.validity = "interrupted";
    return;
  }
  if (provider.scriptExhausted) {
    // EXIT: a call arrived with no scripted step left, so the loop faulted on the one
    // seam this capability fakes; teardown still runs in the caller's `finally`.
    state.validity = "provider-error";
    state.stopReason = "provider-error";
    state.failure = { kind: "provider-failure", phase: "dispatch" };
    return;
  }
  // EXIT: no boundary of this capability claims the fault, so saying "provider" would be
  // a guess about the product. It is recorded as unattributed measurement and torn down.
  state.validity = "unknown";
  state.stopReason = "unattributed";
  state.failure = { kind: "unattributed", phase: "dispatch" };
}

/**
 * Teardown of both owned resources. `false` is the answer when the loopback server
 * never confirms its stop, and that answer is what keeps cleanup honest.
 */
async function teardown(
  engine: Engine | undefined,
  provider: ScriptedProvider
): Promise<boolean> {
  if (engine?.shutdown !== undefined) {
    await withGrace(engine.shutdown(), () => undefined);
  }
  // EXIT: the grace window is the whole wait — an unconfirmed stop is reported, never
  // retried, because a second attempt would outrun the cleanup the case owns.
  return await withGrace(stopProvider(provider), () => false);
}

/**
 * Each limit the plan froze, against what this run applied and observed. The names come
 * from the budget itself, so a declared limit can never go unreported: an absent entry
 * would read as "no such cap was frozen" rather than "this run never said".
 */
function limitStates(
  input: DispatchInput,
  state: RunState,
  wallAborted: boolean,
  observedWallMs: number,
  usage: UsageRecord
): LimitState[] {
  const observed: Record<LimitName, number | null> = {
    maxTurns: state.turnsRun,
    wallMs: observedWallMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  const applied: Record<LimitName, boolean> = {
    maxTurns: state.stopReason === "maxTurns",
    wallMs: wallAborted,
    // The loop enforces no token cap: nothing here stops a run for spending tokens, so a
    // token limit is only ever observed and reported as overrun, never as applied.
    inputTokens: false,
    outputTokens: false,
  };
  return declaredLimits(input.budget).map((limit) => {
    const amount = observed[limit.name];
    return {
      ...limit,
      applied: applied[limit.name],
      observed: amount,
      overrun:
        limit.declared !== null && amount !== null && amount > limit.declared,
    };
  });
}

export async function dispatchAttempt(
  input: DispatchInput
): Promise<DispatchResult> {
  makeDir(input.traceDir, "dispatch");
  makeDir(input.dataDir, "dispatch");
  // The scratch workspace is dispatch-owned: the engine's sandbox root must exist
  // before assembly, or a production fs tool measures a root that is not there.
  makeDir(input.workspaceRoot, "dispatch");

  const provider = await startScriptedProvider(input.scripted, {
    usage: input.providerUsage ?? "reported",
  });
  const tracePath = join(input.traceDir, `${input.conversationId}.jsonl`);
  const controller = new AbortController();
  let wallAborted = false;
  const wallTimer = setTimeout(() => {
    wallAborted = true;
    controller.abort(new Error("wall-clock limit applied"));
  }, input.budget.wallMs);
  wallTimer.unref?.();

  const startedAt = Date.now();
  const state = initialState();
  let engine: Engine | undefined;
  let providerStopped = true;

  try {
    engine = await assembleEngine(input, provider.baseUrl);
    const trace = createJsonlTraceService({
      filePath: input.traceDir,
      conversationId: input.conversationId,
    });
    const deps = {
      ...engine.deps,
      trace,
      maxTurns: input.budget.maxTurns,
      conversationId: input.conversationId,
    };
    await driveTurns(state, deps, controller.signal, input.turns);
    if (wallAborted) {
      // EXIT: a run the declared wall clock cut short is an interrupted measurement,
      // not a valid one — the model never got to finish, so its verdict is not
      // attributable; the owned server and engine are still torn down in `finally`.
      state.stopReason = "cancelled";
      state.validity = "interrupted";
    } else if (state.stopReason === "completed") {
      // A run that reports every turn completed owes the trajectory it declared: fewer
      // served calls than steps means the script the prose and oracles would grade never
      // happened. A turn cap or the wall clock stops a script on purpose, so only a
      // completed run can be in that state, and reaching here means no fault was raised.
      assertScriptConsumed(provider, input.scripted);
    }
  } catch (error) {
    applyFault(state, error, wallAborted, provider);
  } finally {
    clearTimeout(wallTimer);
    providerStopped = await teardown(engine, provider);
  }

  const observedWallMs = Date.now() - startedAt;
  // The trace is read after teardown so every row the engine buffered is on disk: the
  // attempt's cost is what its retained evidence shows, not what the loop remembered.
  const usage = usageOf(llmCallRows(tracePath), observedWallMs);
  return {
    conversationId: input.conversationId,
    tracePath,
    turnsRun: state.turnsRun,
    stopReason: state.stopReason,
    observedWallMs,
    providerRequests: provider.requestCount,
    limits: limitStates(input, state, wallAborted, observedWallMs, usage),
    usage,
    validity: state.validity,
    cleanup: {
      status: providerStopped ? "confirmed" : "unconfirmed",
      owned: ["scripted-provider", "trace-writer"],
    },
    failure: state.failure,
  };
}
