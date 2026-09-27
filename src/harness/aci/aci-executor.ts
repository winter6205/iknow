/**
 * ACI capability layer: decorating executor (graduation transition).
 *
 * The 5-step middleware (preToolUse → checkPermission → askUser → inner →
 * postToolUse) now lives in `src/harness/permission/permission-executor.ts`;
 * this file keeps the prototype API (createAciExecutor /
 * AciExecutorOptions / onDecision observation hook) and forwards to the new
 * PermissionExecutor internally.
 *
 * Per-tool tier + interruptBehavior routing layered on top:
 *   - the `timeoutTier` declared in the tool catalog overrides the timeoutMs
 *     passed in by the Loop Engine.
 *   - interruptBehavior="cancel" passes the caller's AbortSignal through to
 *     inner; a caller abort preempts the wait immediately and returns
 *     "cancelled"; if the handler has not finished, the operation is marked
 *     background and the host is notified; a timeout hit returns "timeout".
 *   - interruptBehavior="block" does not pass the caller signal (only a new
 *     AbortController governed by the tier timeout); the handler runs to
 *     natural completion; if the caller signal aborts during the wait, the
 *     settled ok result is converted to execution_failed { message:
 *     "cancelled" } (no partial, since the handler stays clean), and the
 *     host status channel explains that the wait cannot be aborted.
 *   - the bash handler may already have flushed partial stdout/stderr before
 *     being interrupted / timed out; that partial content is attached to
 *     execution_failed.partial so the Anthropic Adapter encodes it as extra
 *     [partial stdout] / [partial stderr] text blocks.
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
  Registry,
} from "../tools/types.js";
import type { HarnessStreamEvent } from "../stream.js";
import { safeEmitStream } from "../stream.js";
import type { PermissionOutcome } from "../permission/types.js";
import {
  createPermissionRuntime,
  type PermissionExecutorOptions,
  type PermissionRuntime,
} from "../permission/permission-executor.js";
import { partitionConcurrencyWaves } from "../tools/concurrency-waves.js";
import { createAciCatalog } from "../permission/permission-executor.js";
import { checkPermission } from "../permission/policy.js";
import { errorMessage } from "../errors.js";
import { createPermissionPolicy } from "./permission.js";
import { TIMEOUT_TIER_MS, type AciCatalog, type AciToolDef } from "./types.js";

export interface AciBackgroundRejection {
  readonly kind: "background_handler_rejection";
  readonly toolUseId: string;
  readonly toolName: string;
  readonly error: unknown;
}

export type AciDiagnosticSink = (
  diagnostic: AciBackgroundRejection
) => void | Promise<void>;

/**
 * Host-visible notice for a caller abort that detached an uncooperative
 * handler. The stream event is the existing status channel available to TUI.
 */
export const BACKGROUND_OPERATION_NOTICE =
  "界面已停止等待，但底层操作仍在后台运行";
export const BLOCK_OPERATION_NOTICE =
  "界面已停止等待，但 block 操作仍在后台收尾";

export interface AciExecutorOptions {
  readonly inner: Executor;
  readonly catalog?: import("./types.js").AciCatalog;
  readonly policy?: ReturnType<typeof createPermissionPolicy>;
  /** Legacy shape compat: when no registry/catalog passed, build catalog from registry. */
  readonly registry?: Registry;
  /** Optional askUser injection (defaults to no-ask for prototype/test callers). */
  readonly askUser?: PermissionExecutorOptions["askUser"];
  /** Optional hooks; default no-op. */
  readonly hooks?: {
    readonly preToolUse?: PermissionExecutorOptions["preToolUse"];
    readonly postToolUse?: PermissionExecutorOptions["postToolUse"];
  };
  /** Observation hook: called on every permission decision (demo/tests; does not participate in the decision). */
  readonly onDecision?: (call: ToolCall, outcome: PermissionOutcome) => void;
  /**
   * Diagnostic sink for a handler rejection observed after the caller has
   * already received a cancellation result. Omitted callers still get a
   * sanitized stderr record.
   */
  readonly onDiagnostic?: AciDiagnosticSink;
  /**
   * Test seam: per-tool tier overrides use this fixed millisecond value
   * (so tier-timeout tests need not wait for real durations).
   * Default undefined = use the real TIMEOUT_TIER_MS. Production callers
   * do not pass it.
   */
  readonly timeoutMsOverride?: number;
}

/**
 * Decorate inner Executor with the 5-step permission middleware + per-tool
 * tier + interruptBehavior routing. Back-compat shim: built on top of
 * permission/permission-executor so the prototype tests (which import from
 * aci/) keep passing without changing their call sites.
 *
 * Safe batches may overlap — executeAll schedules waves along the
 * `isConcurrencySafe` dimension annotated in the catalog: consecutive calls
 * marked `isConcurrencySafe: true` start concurrently via Promise.all
 * within one wave; calls marked `isConcurrencySafe: false` (and the
 * conservative default for catalog misses) must occupy a singleton wave
 * that overlaps nothing else. Result order follows the input calls order,
 * and per-call pre/permission/post steps still run inside each call's own
 * routeOneCall (the 5-step middleware is unchanged).
 */
export function createAciExecutor(opts: AciExecutorOptions): Executor {
  const policy = opts.policy ?? createPermissionPolicy();
  // Build a registry-compatible surface: if catalog was passed, wrap it as a
  // Registry. Otherwise expect opts.registry to have been provided.
  let registry: Registry | undefined = opts.registry;
  if (!registry && opts.catalog) {
    const all = opts.catalog.all();
    registry = Object.freeze({
      list: () => all,
      get: (name: string) => opts.catalog!.get(name),
    });
  }
  if (!registry) {
    throw new Error(
      "createAciExecutor: either `catalog` or `registry` must be provided"
    );
  }
  const askUser = opts.askUser ?? (async () => true); // prototype default: no-ask approve
  // ADR-0043 + ADR-0046: inject isDiscovered / discover from the catalog into
  // the permission runtime so gateOne takes the hydrate-then-execute path
  // (read opts.catalog directly when present; otherwise build once from the
  // registry — the latter keeps byte-stable behavior: without
  // isDiscovered/discover the gate never triggers hydrate).
  const catalogForT5: AciCatalog = opts.catalog ?? createAciCatalog(registry);
  const perm = createPermissionRuntime({
    inner: opts.inner,
    registry,
    policy,
    askUser,
    preToolUse: (ctx) => {
      return opts.hooks?.preToolUse?.(ctx);
    },
    postToolUse: opts.hooks?.postToolUse,
    ...(catalogForT5.isDiscovered
      ? { isDiscovered: catalogForT5.isDiscovered }
      : {}),
    ...(catalogForT5.discover ? { discover: catalogForT5.discover } : {}),
  });
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal,
      _timeoutMs?: number,
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
      if (calls.length === 0) return [];
      const waves = partitionConcurrencyWaves(
        calls.map((call) =>
          toWaveItem(call, catalogForT5, opts, _timeoutMs, policy)
        ),
        (item) => item.doesNotBreakWave
      );
      const out: ToolExecutionResult[] = [];
      let indexBase = 0;
      for (const wave of waves) {
        const part = await runWave({
          wave,
          perm,
          policy,
          onDecision: opts.onDecision,
          onDiagnostic: opts.onDiagnostic,
          signal,
          conversationId,
          turnId,
          onSettled,
          indexBase,
          onStream,
          messages,
          parentThinking,
        });
        for (const r of part) out.push(r);
        indexBase += wave.length;
      }
      return out;
    },
  });
}

type WaveItem = {
  readonly call: ToolCall;
  readonly def: AciToolDef | undefined;
  readonly tierTimeoutMs: number | undefined;
  readonly doesNotBreakWave: boolean;
};

function toWaveItem(
  call: ToolCall,
  catalog: AciCatalog,
  opts: AciExecutorOptions,
  fallbackTimeoutMs: number | undefined,
  policy: ReturnType<typeof createPermissionPolicy>
): WaveItem {
  const def = catalog.get(call.name);
  const predictedDeny =
    def !== undefined &&
    checkPermission({
      def,
      input: call.input,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    }).decision === "deny";
  return {
    call,
    def,
    tierTimeoutMs:
      opts.timeoutMsOverride ??
      (def ? TIMEOUT_TIER_MS[def.aci.timeoutTier] : fallbackTimeoutMs),
    doesNotBreakWave: def?.aci.isConcurrencySafe === true || predictedDeny,
  };
}

function emitOnDecision(
  item: WaveItem,
  policy: ReturnType<typeof createPermissionPolicy>,
  onDecision: AciExecutorOptions["onDecision"]
): void {
  if (!onDecision) return;
  if (!item.def) {
    onDecision(item.call, {
      decision: "allow",
      reason: "unknown tool — delegated to inner",
    });
    return;
  }
  onDecision(
    item.call,
    checkPermission({
      def: item.def,
      input: item.call.input,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    })
  );
}

async function runWave(opts: {
  readonly wave: ReadonlyArray<WaveItem>;
  readonly perm: PermissionRuntime;
  readonly policy: ReturnType<typeof createPermissionPolicy>;
  readonly onDecision: AciExecutorOptions["onDecision"];
  readonly onDiagnostic: AciExecutorOptions["onDiagnostic"];
  readonly signal: AbortSignal | undefined;
  readonly conversationId: string | undefined;
  readonly turnId: string | undefined;
  readonly onSettled:
    | ((result: ToolExecutionResult, index: number) => void | Promise<void>)
    | undefined;
  readonly indexBase: number;
  readonly onStream: ((event: HarnessStreamEvent) => void) | undefined;
  readonly messages: ToolExecutionContext["messages"];
  readonly parentThinking: ToolExecutionContext["parentThinking"];
}): Promise<ReadonlyArray<ToolExecutionResult>> {
  const gated: Array<{
    readonly item: WaveItem;
    readonly blocked: ToolExecutionResult | undefined;
    readonly def: AciToolDef | undefined;
  }> = [];
  for (const item of opts.wave) {
    emitOnDecision(item, opts.policy, opts.onDecision);
    const gate = await opts.perm.gateOne(item.call, opts.signal);
    gated.push({
      item,
      blocked: gate.kind === "blocked" ? gate.result : undefined,
      def: gate.kind === "proceed" ? gate.def : item.def,
    });
  }
  return Promise.all(
    gated.map((g, i) => {
      const work =
        g.blocked !== undefined
          ? Promise.resolve(g.blocked)
          : routeOneCall({
              runInner: (effectiveSignal) =>
                opts.perm.runAllowed(
                  g.item.call,
                  g.def,
                  effectiveSignal,
                  undefined,
                  opts.conversationId,
                  opts.turnId,
                  opts.onStream,
                  opts.messages,
                  opts.parentThinking
                ),
              call: g.item.call,
              def: g.item.def,
              tierTimeoutMs: g.item.tierTimeoutMs,
              callerSignal: opts.signal,
              onDiagnostic: opts.onDiagnostic,
              onStream: opts.onStream,
            });
      return work.then(async (result) => {
        await opts.onSettled?.(result, opts.indexBase + i);
        return result;
      });
    })
  );
}

/**
 * The "salvage window" granted to inner after a tier timeout hit (partial
 * recovery).
 *
 * The tier abort has already propagated to the handler (bash/grep/glob get
 * SIGTERM→2s→SIGKILL via spawnWithStopSignal; block tools wind down on the
 * tierAbort signal). A benign handler settles inside this window and hands
 * over its already-flushed stdout/stderr, so we can attach the partial to
 * execution_failed. If it still has not settled when the window ends, the
 * partial is abandoned and a bare timeout is returned (the handler refused
 * to wind down; waiting is not an option).
 *
 * 3 s: bash's kill grace is 2 s (SIGTERM→SIGKILL), plus 1 s of wind-down margin.
 */
const SALVAGE_GRACE_MS = 3_000;
/**
 * Give non-bash handlers one event-loop turn to honor caller abort before
 * declaring that the operation is still running in the background.
 */
const CALLER_SETTLE_GRACE_MS = 10;

/**
 * Per-call tier + interruptBehavior routing. Returns a ToolExecutionResult
 * matching the call's identity; failure labels stay strictly equal
 * `"timeout"` / `"cancelled"` (ADR-0005). Since ADR-0091 these result labels
 * no longer drive the turn-level timeout
 * (loop-engine.computeToolStopFlags only trusts the signal.reason clock
 * marker), so this layer's semantics are unchanged: a single call's tier
 * expiry only fails that one result.
 *
 * Race design: inner.executeAll races against the tierAbort trigger. When
 * the tier wins we do not wait indefinitely for the handler (it may refuse
 * to wind down), but a bounded salvage window gets a chance to recover the
 * already-flushed partial.
 */
async function routeOneCall(opts: {
  readonly runInner: (
    signal: AbortSignal | undefined
  ) => Promise<ToolExecutionResult>;
  readonly call: ToolCall;
  readonly def: AciToolDef | undefined;
  readonly tierTimeoutMs: number | undefined;
  readonly callerSignal: AbortSignal | undefined;
  readonly onDiagnostic: AciExecutorOptions["onDiagnostic"];
  readonly onStream: ((event: HarnessStreamEvent) => void) | undefined;
}): Promise<ToolExecutionResult> {
  const {
    runInner,
    call,
    def,
    tierTimeoutMs,
    callerSignal,
    onDiagnostic,
    onStream,
  } = opts;
  const isBlock = def !== undefined && def.aci.interruptBehavior === "block";

  const tierAbort = new AbortController();
  const tierTimer: NodeJS.Timeout | undefined =
    tierTimeoutMs !== undefined && tierTimeoutMs > 0
      ? setTimeout(() => {
          tierAbort.abort(new Error("tier timeout"));
        }, tierTimeoutMs)
      : undefined;
  if (tierTimer && tierTimer.unref) tierTimer.unref();

  const effectiveSignal: AbortSignal | undefined = isBlock
    ? tierAbort.signal
    : callerSignal !== undefined
      ? AbortSignal.any([callerSignal, tierAbort.signal])
      : tierAbort.signal;

  const notifyBackground = (
    notice: string = BACKGROUND_OPERATION_NOTICE
  ): void => {
    safeEmitStream(onStream, {
      type: "stop_summary",
      text: notice,
    });
  };
  let blockNoticeSent = false;
  const notifyBlock = (): void => {
    if (blockNoticeSent) return;
    blockNoticeSent = true;
    notifyBackground(BLOCK_OPERATION_NOTICE);
  };
  let blockAbortListener: (() => void) | undefined;
  if (isBlock && callerSignal !== undefined) {
    blockAbortListener = notifyBlock;
    if (callerSignal.aborted) {
      notifyBlock();
    } else {
      callerSignal.addEventListener("abort", blockAbortListener, {
        once: true,
      });
    }
  }
  const innerPromise = runInner(effectiveSignal).then(
    (result) => [result] as const
  );

  let result: ToolExecutionResult;
  try {
    result = await awaitInnerOrTier({
      innerPromise,
      tierSignal: tierAbort.signal,
      callerSignal: isBlock ? undefined : callerSignal,
      call,
      onDiagnostic,
      onBackground: notifyBackground,
      // partial salvage is only opened for tools that produce partials
      // (bash); other tools return timeout immediately on a tier hit
      // without waiting for wind-down (keeps stub/benign handlers fast).
      salvageMs: def?.name === "bash" ? SALVAGE_GRACE_MS : 0,
    });
  } catch (err) {
    // inner threw (not tier-triggered): rethrow.
    if (tierAbort.signal.aborted) {
      result = {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "timeout",
      };
    } else if (callerSignal?.aborted && isBlock) {
      result = {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "cancelled",
      };
    } else {
      if (tierTimer !== undefined) clearTimeout(tierTimer);
      throw err;
    }
  } finally {
    if (tierTimer !== undefined) clearTimeout(tierTimer);
    if (blockAbortListener !== undefined && callerSignal !== undefined) {
      callerSignal.removeEventListener("abort", blockAbortListener);
    }
  }

  // Normalization (order = precedence):
  //   1. tier timeout hit → timeout (authoritative; overrides block/cancel
  //      alike). A salvaged partial is kept if recovered.
  //   2. caller signal abort:
  //        block → cancelled (no partial; the handler completed cleanly);
  //        cancel → cancelled (bash partial kept).
  //   3. everything else passes through unchanged.

  if (tierAbort.signal.aborted) {
    const partial =
      result.kind === "ok" ? extractBashPartial(result, def) : undefined;
    return withPartial(
      { kind: "execution_failed", toolUseId: call.id, message: "timeout" },
      partial
    );
  }

  if (callerSignal?.aborted === true) {
    if (isBlock) {
      // block tool: a caller abort does not interrupt the handler; after
      // wind-down normalize to cancelled (no partial), and explain via the
      // host status channel that the wait could not be aborted.
      notifyBlock();
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "cancelled",
      };
    }
    const partial =
      result.kind === "ok" ? extractBashPartial(result, def) : undefined;
    const background =
      result.kind === "execution_failed" && result.background === true;
    return withPartial(
      { kind: "execution_failed", toolUseId: call.id, message: "cancelled" },
      partial,
      background
    );
  }

  // No abort / no timeout: if inner already returned cancelled/timeout
  // (executor.runOne normalizes when signal.aborted), top up the bash
  // partial (if any) and pass through.
  if (
    result.kind === "execution_failed" &&
    (result.message === "cancelled" || result.message === "timeout")
  ) {
    return result; // partial can only come from an ok payload; this is already failed
  }

  return result;
}

/**
 * Await inner; when a tier/caller abort wins first, optionally enter a
 * bounded salvage window (recovering the partial the handler already
 * flushed). Returns the final ToolExecutionResult:
 *   - inner settles first → its result;
 *   - caller wins first + inner settles within the grace → its result (the
 *     caller normalizes to cancelled + partial);
 *   - tier wins first + inner settles within salvage → its result (the
 *     caller normalizes to timeout + partial);
 *   - abort wins first + inner unsettled when salvage ends → the matching
 *     execution_failed (no partial).
 */
async function awaitInnerOrTier(opts: {
  readonly innerPromise: Promise<ReadonlyArray<ToolExecutionResult>>;
  readonly tierSignal: AbortSignal;
  /** caller signal for the cancel tier; the block tier deliberately omits it. */
  readonly callerSignal: AbortSignal | undefined;
  readonly call: ToolCall;
  readonly onDiagnostic: AciExecutorOptions["onDiagnostic"];
  readonly onBackground: (() => void) | undefined;
  /** salvage window (ms); a caller-side 0 uses the short settle grace, a tier-side 0 returns immediately. */
  readonly salvageMs: number;
}): Promise<ToolExecutionResult> {
  const {
    innerPromise,
    tierSignal,
    callerSignal,
    call,
    onDiagnostic,
    onBackground,
    salvageMs,
  } = opts;

  const tierFired = abortPromise(tierSignal);
  const callerFired =
    callerSignal === undefined
      ? undefined
      : abortPromise(callerSignal, "caller");
  const winner = await Promise.race<
    | { kind: "inner"; arr: ReadonlyArray<ToolExecutionResult> }
    | { kind: "timer" }
    | { kind: "caller" }
  >([
    innerPromise.then((arr) => ({ kind: "inner" as const, arr })),
    tierFired,
    ...(callerFired === undefined ? [] : [callerFired]),
  ]);

  if (winner.kind === "inner") {
    return winner.arr[0] as ToolExecutionResult;
  }

  if (winner.kind === "caller") {
    // A caller preempt only ends the UI-side wait. bash still gets its
    // existing salvage window to recover the partial; other tools get a
    // very short wind-down grace and are treated as background-running
    // only if still unsettled.
    const settleGraceMs = salvageMs > 0 ? salvageMs : CALLER_SETTLE_GRACE_MS;
    const salvaged = await awaitDuringSalvage(innerPromise, settleGraceMs);
    if (salvaged.kind === "inner") return salvaged.result;
    if (salvaged.kind === "rejected") {
      void reportDetachedRejection(call, onDiagnostic, salvaged.error);
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "cancelled",
      };
    }
    observeDetachedRejection(innerPromise, call, onDiagnostic);
    onBackground?.();
    return {
      kind: "execution_failed",
      toolUseId: call.id,
      message: "cancelled",
      background: true,
    };
  }

  // Tier won first: the abort has already propagated to the handler. When
  // salvageMs>0, give a bounded window to recover the partial.
  if (salvageMs > 0) {
    const salvaged = await awaitDuringSalvage(innerPromise, salvageMs);
    if (salvaged.kind === "inner") {
      // The handler wound down inside the salvage window — hand over its
      // flushed result; the caller normalizes to timeout via
      // tierAbort.aborted and injects the partial.
      return salvaged.result;
    }
    if (salvaged.kind === "rejected") {
      void reportDetachedRejection(call, onDiagnostic, salvaged.error);
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: "timeout",
      };
    }
  }

  // Salvage expired (or was not opened): the handler refused to wind down.
  // Stop waiting and return a bare timeout.
  observeDetachedRejection(innerPromise, call, onDiagnostic);
  return {
    kind: "execution_failed",
    toolUseId: call.id,
    message: "timeout",
  };
}

type SalvageOutcome =
  | { readonly kind: "inner"; readonly result: ToolExecutionResult }
  | { readonly kind: "rejected"; readonly error: unknown }
  | { readonly kind: "grace" };

async function awaitDuringSalvage(
  innerPromise: Promise<ReadonlyArray<ToolExecutionResult>>,
  salvageMs: number
): Promise<SalvageOutcome> {
  const salvageGrace = new Promise<{ kind: "grace" }>((resolveGrace) => {
    const t = setTimeout(() => resolveGrace({ kind: "grace" }), salvageMs);
    if (t.unref) t.unref();
  });
  const salvaged = await Promise.race<
    | {
        kind: "inner";
        result: ToolExecutionResult;
      }
    | { kind: "rejected"; error: unknown }
    | { kind: "grace" }
  >([
    innerPromise.then(
      (arr) => ({
        kind: "inner" as const,
        result: arr[0] as ToolExecutionResult,
      }),
      (error: unknown) => ({ kind: "rejected" as const, error })
    ),
    salvageGrace,
  ]);
  return salvaged;
}

/** Promise that resolves when the signal aborts (resolves immediately if already aborted). */
function abortPromise(
  signal: AbortSignal,
  kind: "timer" | "caller" = "timer"
): Promise<{ kind: "timer" } | { kind: "caller" }> {
  return new Promise((resolveTimer) => {
    if (signal.aborted) {
      resolveTimer({ kind });
      return;
    }
    signal.addEventListener("abort", () => resolveTimer({ kind }), {
      once: true,
    });
  });
}

/**
 * Shape of a bash ok payload:`[{ type: "text", text: JSON.stringify({ code, stdout, stderr }) }]`.
 * Parse the JSON and put stdout / stderr back into the partial.
 */
function extractBashPartial(
  result: ToolExecutionResult,
  def: AciToolDef | undefined
): { stdout?: string; stderr?: string } | undefined {
  if (def?.name !== "bash") return undefined;
  if (result.kind !== "ok") return undefined;
  const first = result.payload[0];
  if (!first || first.type !== "text") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as { stdout?: unknown; stderr?: unknown };
  const out: { stdout?: string; stderr?: string } = {};
  if (typeof obj.stdout === "string" && obj.stdout.length > 0) {
    out.stdout = obj.stdout;
  }
  if (typeof obj.stderr === "string" && obj.stderr.length > 0) {
    out.stderr = obj.stderr;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function withPartial(
  base: { kind: "execution_failed"; toolUseId: string; message: string },
  partial: { stdout?: string; stderr?: string } | undefined,
  background: boolean = false
): ToolExecutionResult {
  if (partial === undefined && !background) return base;
  return {
    ...base,
    ...(partial !== undefined ? { partial } : {}),
    ...(background ? { background: true } : {}),
  };
}

function observeDetachedRejection(
  innerPromise: Promise<ReadonlyArray<ToolExecutionResult>>,
  call: ToolCall,
  onDiagnostic: AciExecutorOptions["onDiagnostic"]
): void {
  void innerPromise.catch((error: unknown) =>
    reportDetachedRejection(call, onDiagnostic, error)
  );
}

async function reportDetachedRejection(
  call: ToolCall,
  onDiagnostic: AciExecutorOptions["onDiagnostic"],
  error: unknown
): Promise<void> {
  const diagnostic: AciBackgroundRejection = {
    kind: "background_handler_rejection",
    toolUseId: call.id,
    toolName: call.name,
    error,
  };
  try {
    if (onDiagnostic !== undefined) {
      await onDiagnostic(diagnostic);
    } else {
      console.error(
        `[aci] ${diagnostic.kind} tool=${call.name} toolUseId=${call.id}: ${errorMessage(error)}`
      );
    }
  } catch (sinkError) {
    // EXIT: a diagnostic sink must not create a second unhandled rejection.
    console.error(
      `[aci] diagnostic sink failed for tool=${call.name} toolUseId=${call.id}: original=${errorMessage(
        error
      )}; sink=${errorMessage(sinkError)}`
    );
  }
}
