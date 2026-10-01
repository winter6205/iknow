/**
 * src/harness/sandbox/violation-executor.ts
 *
 * Wiring glue: wraps an Executor so every tool result is observed by the
 * violation counter, and so a confirmed escalation actually stops work.
 *
 * Two roles, and the distinction matters:
 *
 *  - Observer (always): classifies each result, feeds the per-turn counter,
 *    and reports the escalation to the host's notification sink.
 *  - Modifier (only at the threshold, ADR-0135 / spec #1170): once the
 *    counter reaches the escalation threshold, the wrapper aborts a signal
 *    derived from the caller's own, cancels the work this turn owns, and
 *    refuses to dispatch further calls for this turn. The engine maps the
 *    resulting `cancelled` results to a `cancelled` stop, the host retains
 *    the session, and the turn's structured cause + cleanup evidence is
 *    reported through `onInterrupt`.
 *
 * What the wrapper deliberately never does: rewrite a tool result. The inner
 * executor's `kind` / `message` / `payload` are returned verbatim in every
 * case. Escalation is carried by the abort signal and by owned-work
 * cancellation, so a result stays a faithful record of what the tool did.
 *
 * Turn scope: the counter and the owned-work registry are supplied by the
 * host, one pair per user turn. Nothing in this file keeps cross-turn state,
 * which is what makes "a new user turn starts at zero" and "an earlier turn's
 * persistent service is not cancelled" structural rather than conditional.
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../tools/types.js";
import type { HarnessStreamEvent } from "../stream.js";
import type { PostToolUseHook } from "../permission/types.js";
import {
  createKillSessionHook,
  createViolationCounter,
  wireKillSessionNotification,
  type ViolationCounter,
  type ViolationTurnScope,
} from "./violation-handling.js";
import {
  createTurnWorkRegistry,
  extractOwnedTaskId,
  type TurnWorkRegistry,
} from "./turn-work-registry.js";

/** Tool that launches a worker whose lifetime outlives the call. */
const SUBAGENT_TOOL_NAMES = new Set(["spawn_subagent"]);

/** Tool that launches a background job (foreground bash excluded). */
const BACKGROUND_TOOL_NAMES = new Set(["bash"]);

/** A background launch is a finite job only when the model asked for one;
 *  omitting `background` is an ordinary foreground call that finishes with
 *  the tool result and is therefore not turn-owned work at all. */
function isBackgroundLaunch(call: ToolCall): boolean {
  if (!BACKGROUND_TOOL_NAMES.has(call.name)) return false;
  const input = call.input;
  return (
    input !== null &&
    typeof input === "object" &&
    (input as { background?: unknown }).background === true
  );
}

/**
 * Record the work a successful launch made this turn own.
 *
 * Kept out of `observe` so the observer stays an observation: this is the one
 * place a launch result mutates the turn ledger, and it can only fire for an
 * `ok` result that actually named a task id. A refused launcher produced no
 * work, so there is nothing to own and nothing is registered.
 */
function registerOwnedLaunch(
  ownedWork: TurnWorkRegistry,
  call: ToolCall,
  payload: unknown
): void {
  const taskId = extractOwnedTaskId(payload);
  if (taskId === undefined) return;
  if (SUBAGENT_TOOL_NAMES.has(call.name)) {
    ownedWork.registerSubagent(taskId);
    return;
  }
  if (isBackgroundLaunch(call)) {
    ownedWork.registerBackgroundTask(taskId);
  }
}

export interface WrapWithViolationHookOpts {
  readonly inner: Executor;
  /** Per-turn counter. A host supplies one instance per user turn; absent →
   *  a private instance (single-turn scope, e.g. a direct test). */
  readonly counter?: ViolationCounter;
  readonly onKill: (reason: string) => void;
  /**
   * Turn interruption report (ADR-0135). Fired once, after owned work has
   * been cancelled and its bounded cleanup evidence collected. The host
   * persists / reports it and retains the session.
   *
   * The report is produced asynchronously (it awaits the cleanup pass), so a
   * caller that must observe it deterministically awaits
   * `interruptionSettled()` on the returned executor; a caller that only
   * needs to know *that* the turn was interrupted can watch the abort.
   */
  readonly onInterrupt?: (reason: string) => void;
  /**
   * Per-turn ownership ledger for work that outlives a tool call. Absent →
   *  a registry with no cancel routes, whose interruption report therefore
   *  lists no cleaned-up work rather than claiming any.
   */
  readonly ownedWork?: TurnWorkRegistry;
  /**
   * A pre-built turn scope (ADR-0135), for hosts that wrap their executor
   * once and resolve the counter / ledger / abort per user turn (the chat
   * REPL). Supplied parts win over the individually-passed ones, so a host
   * must not pass both.
   */
  readonly turnScope?: ViolationTurnScope;
  /**
   * Resolve the turn scope at call time, for a host that wraps its executor
   * once and starts a new user turn later (the chat REPL). Returning
   * undefined before the first turn means "no turn is running"; the wrapper
   * then behaves exactly as if it had been given no scope at all. Takes
   * precedence over `turnScope`.
   */
  readonly turnScopeFor?: () => ViolationTurnScope | undefined;
  /** Optional custom hook; default uses createKillSessionHook. A custom
   *  hook takes over classification, so escalation wiring does not apply. */
  readonly postToolUse?: PostToolUseHook;
}

export function wrapWithViolationHook(
  opts: WrapWithViolationHookOpts
): Executor {
  // The turn scope groups the counter, the owned-work ledger and the abort
  // that share one user turn's lifetime. A host that wraps once and runs many
  // turns supplies a fresh scope per turn; a host that rebuilds per turn (or a
  // direct test) lets the individual options build one here.
  const ownScope = (): ViolationTurnScope =>
    ({
      counter: opts.counter ?? createViolationCounter(),
      ownedWork: opts.ownedWork ?? createTurnWorkRegistry(),
      interrupt: new AbortController(),
      interrupted: false,
    } satisfies ViolationTurnScope);
  // With no resolver and no supplied scope, the wrapper owns one scope for its
  // whole lifetime — the caller's turn is the wrapper's lifetime. Building it
  // per call instead would silently reset the streak on every wave, which is
  // exactly the cross-turn leak ADR-0135 forbids, one layer down.
  const owned = opts.turnScopeFor === undefined && opts.turnScope === undefined
    ? ownScope()
    : undefined;
  // Resolved once per executeAll (a wave belongs to exactly one turn), so the
  // hook, the abort and the ledger all agree on which turn they serve.
  const resolveScope = (): ViolationTurnScope =>
    opts.turnScopeFor?.() ?? opts.turnScope ?? owned!;
  const hookFor = (
    scope: ViolationTurnScope,
    turnId: string | undefined
  ): PostToolUseHook =>
    opts.postToolUse ??
    createKillSessionHook({
      counter: scope.counter,
      onKill: opts.onKill,
      // Abort synchronously at the threshold, before the awaited cleanup
      // pass: in-flight tools stop now, the cleanup report arrives after.
      onEscalate: () => scope.interrupt.abort(),
      ...(opts.onInterrupt !== undefined
        ? { onInterrupt: opts.onInterrupt }
        : {}),
      cleanupOwnedWork: () => scope.ownedWork.cancelOwned(),
      ...(turnId !== undefined ? { currentTurnId: () => turnId } : {}),
    });

  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal,
      timeoutMs?: number,
      conversationId?: string,
      onSettled?: (
        result: ToolExecutionResult,
        index: number
      ) => void | Promise<void>,
      turnId?: string,
      onStream?: (event: HarnessStreamEvent) => void,
      messages?: ToolExecutionContext["messages"],
      parentThinking?: ToolExecutionContext["parentThinking"]
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const seen = new Set<number>();
      const scope = resolveScope();
      const hook = hookFor(scope, turnId);
      const effectiveSignal =
        signal === undefined
          ? scope.interrupt.signal
          : AbortSignal.any([signal, scope.interrupt.signal]);

      // observe is async: PostToolUseHook may now return a Promise, and an
      // unhandled rejection would surface as unhandledRejection. Catch and
      // ignore — a failing hook must not alter the tool result (diagnostics
      // already have the host-side onHookError channel).
      const observe = async (
        r: ToolExecutionResult,
        i: number
      ): Promise<void> => {
        if (seen.has(i)) return;
        const call = calls[i];
        if (!call) return;
        seen.add(i);
        const message =
          r.kind === "execution_failed" || r.kind === "validation_failed"
            ? r.message
            : undefined;
        const payload = r.kind === "ok" ? r.payload : undefined;
        // Ownership is recorded from the launch request + its receipt, not
        // from the hook: a launcher that was refused produced no work, and a
        // launcher that succeeded produced work this turn now owns.
        if (r.kind === "ok")
          registerOwnedLaunch(scope.ownedWork, call, payload);
        try {
          await hook({
            toolUseId: r.toolUseId,
            name: call.name,
            input: call.input,
            kind: r.kind,
            message,
            payload,
          });
        } catch {
          // EXIT: hook failures only affect observation, never the tool
          // result (same fire-and-forget rationale as permission-executor's
          // runAllowed). A hook that throws before recording leaves the
          // counter untouched, which is the pre-existing contract.
        }
      };

      // Once the turn is interrupted, no further call is dispatched: the wave
      // settles as `cancelled`, which is the exact result shape an abort
      // produces, so the engine's stop flags converge without a second
      // round-trip through the inner executor.
      if (scope.interrupt.signal.aborted) {
        const settled = calls.map((call) => ({
          kind: "execution_failed" as const,
          toolUseId: call.id,
          message: "cancelled",
        }));
        for (const [index, result] of settled.entries()) {
          await observe(result, index);
          await onSettled?.(result, index);
        }
        return settled;
      }

      const out = await opts.inner.executeAll(
        calls,
        effectiveSignal,
        timeoutMs,
        conversationId,
        async (result, index) => {
          await observe(result, index);
          await onSettled?.(result, index);
        },
        turnId,
        onStream,
        messages,
        parentThinking
      );
      for (let i = 0; i < out.length; i += 1) {
        const r = out[i];
        if (r) await observe(r, i);
      }
      return out;
    },
  });
}

/**
 * Convenience helper for the three CLI entry points: build a counter + an
 * `onKill` that writes to stderr + sets exit code, wrap the inner executor,
 * return both wrapped executor and counter. Callers needing access to the
 * counter (e.g. to log it) get it directly.
 */
export interface BuildViolationWiringResult {
  readonly executor: Executor;
  readonly counter: ViolationCounter;
}

export function buildViolationWiring(
  inner: Executor,
  opts: {
    readonly sink?: (line: string) => void;
    readonly counter?: ViolationCounter;
    /** Passed through to the wrapper; see `WrapWithViolationHookOpts`. */
    readonly onInterrupt?: (reason: string) => void;
    readonly ownedWork?: TurnWorkRegistry;
  } = {}
): BuildViolationWiringResult {
  const counter = opts.counter ?? createViolationCounter();
  const sink =
    opts.sink ??
    ((line: string): void => {
      process.stderr.write(line + "\n");
    });
  const onKill = wireKillSessionNotification({ sink });
  const executor = wrapWithViolationHook({
    inner,
    counter,
    onKill,
    ...(opts.onInterrupt !== undefined ? { onInterrupt: opts.onInterrupt } : {}),
    ...(opts.ownedWork !== undefined ? { ownedWork: opts.ownedWork } : {}),
  });
  return { executor, counter };
}
