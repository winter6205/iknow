/**
 * TUI <-> SessionHub bridge. Pure TS: no ink / OpenTUI dependencies.
 *
 * Responsibilities:
 *  - assemble SessionStore (~/.iknow + sha1(cwd)[:12] namespace) + SessionHub;
 *  - lazy create: a draft session is only materialized via createSession when
 *    its first message is sent, so start-then-quit leaves no empty shell
 *    (list() already filters sessions without assistant text — double safety);
 *  - postMessage wrapper: passes AbortSignal through and projects the
 *    response into TUI session-state inputs;
 *  - tool-event attribution seam: the postToolUse hook fires at the deps
 *    layer without knowing conversationId, so it attributes by "exactly one
 *    in-flight session"; with concurrent sessions it suppresses rather than
 *    misattributes.
 *
 * No cross-process file lock by design: the TUI time-slices with a single
 * active session, so in-process contention is small; the worst cross-process
 * outcome is last-write-wins losing one turn, and tmp/rename never corrupts
 * the file.
 */
import { SessionStore } from "../session-api/store/session-store.js";
import { SessionHub } from "../session-api/hub.js";
import { liteTitleGeneratorOptions } from "../session-api/title-generation.js";
import { deriveProjectIdentityRoot } from "../harness/session-roots.js";
import { mainCheckoutOf } from "../harness/isolation/worktree-gate.js";
// The shared host-side session-open contract (ADR-0136 §4).
import {
  openSessionWithRecovery,
  resolveLiveRoot,
} from "../session-api/recovery-host.js";
import type { EngineBundle } from "../harness/build-engine.js";
import type {
  PostMessageResponse,
  TurnOutcomeView,
  WireThinkingOverride,
} from "../session-api/contract.js";
import { knownTurnOutcome } from "../session-api/contract.js";
import type { SessionFileV1 } from "../session-api/store/schema.js";
import type { LedgerRewindTarget } from "../session-api/store/index.js";
import type {
  TuiLoadedSessionFile,
  TuiSessionRecovery,
} from "./session-state.js";
import type { LoopEngineDeps } from "../harness/index.js";
import type { HarnessStreamEvent } from "../harness/stream.js";
import type {
  CompactCallerOpts,
  RewindCodeRestoreResult,
} from "../session-api/contract.js";
import type { CompactReason } from "../harness/compress/index.js";
import type { TokenUsage } from "../harness/model-adapter/types.js";
import type {
  SubAgentManager,
  SubagentInfo,
} from "../harness/subagent/manager.js";
import type { SubAgentTerminalNotice } from "../harness/subagent/mailbox.js";
import type {
  AutoMemoryHook,
  OverlayPrefetchFn,
} from "../harness/memory/index.js";
import type { VerifyConfig } from "../harness/verify/index.js";
import type { GraphAssembly } from "../harness/graph/assembly.js";
import type { FsModeContext } from "../harness/sandbox/fs-mode.js";
import type { YoloContext } from "../harness/sandbox/yolo.js";
import {
  seedRestoredGraphNodes,
  type LiveGraphLedgerHost,
} from "../harness/graph/ledger.js";
import type { VerifyAnswerView } from "../session-api/contract.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import type { IknowEnv, LlmEnv } from "../config/env.js";
import { DEFAULT_STRATEGY_CONTEXT_WINDOW } from "../config/env.js";

/**
 * Default *strategy budget window* for the TUI usage display (ADR-0100).
 * The denominator and the proactive gate must consult the same number, so
 * this references the env layer's `DEFAULT_STRATEGY_CONTEXT_WINDOW`
 * (overridable via `IKNOW_MODEL_CONTEXT_WINDOW`) instead of forking a second
 * constant. Display only — it never enables compaction here.
 */
export const DEFAULT_CONTEXT_WINDOW = DEFAULT_STRATEGY_CONTEXT_WINDOW;

/**
 * Double-Esc rewind debounce window: gap <= this value counts as a double
 * press and opens the anchor picker. 1000ms matches the measured rewind
 * baseline. The first Esc while idle only
 * records a timestamp. See `isDoubleEsc` for the boundary-testable pure
 * function (999ms hit / 1001ms miss); call sites must not inline the
 * bare literal 1000.
 */
export const REWIND_DOUBLE_ESC_WINDOW_MS = 1000;

/** Double-Esc check: gap since the last Esc <= window counts as a double press. */
export function isDoubleEsc(lastMs: number, nowMs: number): boolean {
  return nowMs - lastMs <= REWIND_DOUBLE_ESC_WINDOW_MS;
}

/**
 * In-flight session registry: postMessage marks on entry / unmarks on exit;
 * the postToolUse hook in deps.ts attributes tool events via soleId()
 * (exactly one in-flight -> that session; otherwise undefined).
 */
export interface InflightRegistry {
  readonly mark: (conversationId: string) => void;
  readonly unmark: (conversationId: string) => void;
  readonly soleId: () => string | undefined;
  readonly ids: () => ReadonlySet<string>;
}

export function createInflightRegistry(): InflightRegistry {
  const inflight = new Set<string>();
  return Object.freeze({
    mark: (conversationId: string): void => {
      inflight.add(conversationId);
    },
    unmark: (conversationId: string): void => {
      inflight.delete(conversationId);
    },
    soleId: (): string | undefined =>
      inflight.size === 1 ? [...inflight][0] : undefined,
    ids: (): ReadonlySet<string> => new Set(inflight),
  });
}

export interface TuiPostResult {
  readonly conversationId: string;
  readonly finalText: string;
  readonly stopReason: PostMessageResponse["turn"]["answer"]["stopReason"];
  readonly turnCount: number;
  readonly jsonMode: boolean;
  /** Token usage of the latest successful model call (absent wire field -> null, same semantics as RunResult). */
  readonly lastUsage: TokenUsage | null;
  /** User-interrupt feedback (Esc): present only when cancelled (true =
   *  checkpoint saved / false = nothing new to persist); absent otherwise. */
  readonly interrupted?: boolean;
  /** Final verify-loop state for this turn (passed/failed/unstable/
   *  escalated). verifyConfig absent / abort / disabled -> field absent
   *  (same byte-stable pattern as resp.turn.answer.verify). The TUI renders
   *  VerifyBanner only when present. */
  readonly verify?: VerifyAnswerView;
  /** ADR-0094: gateway-side summary (status + message text) on transport
   *  failure. Absent wire field apiError -> absent field (byte-stable). The
   *  TUI notice renders "API error (status): message" when status is
   *  present, else "API error: message". */
  readonly apiError?: { readonly status?: number; readonly message: string };
  /** The turn's durable output-limit notice, passed through from the hub's
   *  answer projection verbatim (absent wire field -> absent field). Rendered
   *  in the sticky notice lane instead of the generic abnormal-stop copy, so
   *  the live turn and a reopened session show one identical line. */
  readonly outputLimitNotice?: string;
}

/** Rewind result: the post-rewind projection the TUI renders from, plus — only
 *  on a rewind that asked for code restore — the workspace report (absent field
 *  when no restore was requested, same byte-stable pattern as `apiError`). */
export interface TuiRewindOutcome {
  readonly file: SessionFileV1;
  readonly codeRestore?: RewindCodeRestoreResult;
}

export interface TuiBridge {
  readonly hub: SessionHub;
  readonly store: SessionStore;
  /** draft -> create the session and return the new conversation_id; already materialized -> return as-is. */
  readonly ensureSession: (
    conversationId: string | undefined
  ) => Promise<string>;
  /** Send one message, run one turn (signal passes through so Esc can
   *  interrupt the foreground). thinking: per-turn override of the harness
   *  thinking control arm (same shape as SessionHub.postMessage's wire
   *  field; absent -> keep ensureDeps' cached configuration). */
  readonly postMessage: (opts: {
    readonly conversationId: string;
    readonly text: string;
    readonly signal?: AbortSignal;
    readonly thinking?: WireThinkingOverride;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }) => Promise<TuiPostResult>;
  /** Host wake subscription; absent manager is a no-op (ask-safe). */
  readonly subscribeSubagentTerminal: (
    subscriber: (notice: SubAgentTerminalNotice) => void,
    conversationId?: string
  ) => () => void;
  /** Run a silent turn with the pending terminal drain. */
  readonly wakeFromSubagent: (
    conversationId: string
  ) => Promise<TuiPostResult | undefined>;
  readonly listSessions: () => ReturnType<SessionHub["listSessions"]>;
  /** Read a session file for rendering, plus the terminal outcome of its last
   *  settled turn (ADR-0126) so a reopened session can show the same durable
   *  notice the live turn showed. */
  readonly loadSessionFile: (
    conversationId: string
  ) => Promise<TuiLoadedSessionFile>;
  /**
   * The complete session-ENTRY open (ADR-0136 §4): the one projection read plus
   * session-entry recovery. Both entry surfaces — the startup resume and the
   * in-app picker selection — go through here, so a session can never be
   * opened on the TUI without recovery having run.
   *
   * The TUI reads the store directly rather than going through the hub's
   * `getSession`, so it runs its own `recoverSession`. Recovery is a read: it
   * dispatches no model request, no tool, and no file mutation.
   *
   * Non-entry reloads (a turn-end refresh, a rewind or compaction re-read) must
   * keep calling `loadSessionFile` alone — recovery is a session-open concern,
   * not a per-read one.
   */
  readonly openSession: (conversationId: string) => Promise<{
    /** The loaded session, or null when its log is unreadable — the
     *  classification then stands alone and no transcript is reconstructed
     *  (spec §2.1). */
    readonly file: TuiLoadedSessionFile | null;
    readonly recovery: TuiSessionRecovery;
  }>;
  /** Manual compaction (/compact). Returns `{ compacted, cancelled? }`:
   *  `compacted` true = trimming actually happened; false = nothing
   *  compactable (empty session is idempotent) or full failure — the auto
   *  token-gate no-op case no longer exists. Mid-run cancellation reports
   *  `cancelled:true`, which the app layer distinguishes. signal/onStream
   *  pass through SessionHub.compactSession -> runFullCompact so /compact
   *  supports progress events + mid-run cancel. The observer already emits
   *  compaction_cancelled, but the pre-aborted-signal path early-returns
   *  before the observer fires (full-compact.ts); the `cancelled` field is
   *  the catch-all covering every cancellation path. */
  readonly compactSession: (
    conversationId: string,
    opts?: CompactCallerOpts
  ) => Promise<{
    readonly compacted: boolean;
    readonly cancelled?: boolean;
    /** Trigger-criterion classification (one of four); drives the copy branch in the TUI. */
    readonly reason: CompactReason;
  }>;
  /** continue_pending: skip-append resume. Reload/predicates live in the hub; projection same as postMessage. */
  readonly continueSession: (
    conversationId: string,
    opts?: CompactCallerOpts
  ) => Promise<TuiPostResult>;
  /** Rewind: point the persisted head at an event id (null = empty transcript).
   *  `restoreCode` additionally writes the abandoned segment's workspace files
   *  back to their captured preimages before the head moves (ADR-0119); the
   *  returned report is what went back and what the drift / root-identity guard
   *  refused, so the TUI can say so instead of assuming. */
  readonly rewindSession: (
    conversationId: string,
    head: string | null,
    restoreCode: boolean
  ) => Promise<TuiRewindOutcome>;
  /** User anchors on the current head chain (skipped branches not listed). */
  readonly listRewindTargets: (
    conversationId: string
  ) => Promise<ReadonlyArray<LedgerRewindTarget>>;
  readonly inflight: InflightRegistry;
  /** Context window capacity (tokens). Display only; never triggers compaction. */
  readonly contextWindow: number;
  /** Read-only projection of subagent state: no manager -> empty array. */
  readonly listSubagents: (
    conversationId?: string
  ) => ReadonlyArray<SubagentInfo>;
  /**
   * Force-kill one subagent (TUI Ctrl+X on the chrome-focused row).
   * Returns true = the task was still in flight (the parent-side waitFor is
   * settled first, then SIGTERM goes to the worker); unknown / already
   * terminal id, or no manager (ask surface) -> false (no-op, never throws).
   *
   * **Synchronous cancel of the parent turn's wait**: `manager.abortTask`
   * first rejects the task's in-flight `waitFor` with `SubAgentAbortError`
   * (the parent turn sees "cancelled"), then aborts the worker subprocess.
   * See the header note in `src/tui/subagent-kill.ts`.
   */
  readonly abortSubagentTask: (taskId: string) => boolean;
  /**
   * Ctrl+C fan-out to **all foreground subagents of this session**
   * (`foreground === true` and live). The parent `running-fg` turn's
   * aborter still belongs to the app layer (same registry, no second
   * channel). Background (`wait:false`) work and other sessions are outside
   * the set — scope is defined by conversationId. Returns the taskIds
   * actually aborted; no manager -> empty array (never throws).
   */
  readonly abortSessionForegroundWork: (
    conversationId: string
  ) => ReadonlyArray<string>;
}

export interface CreateTuiBridgeOptions {
  /** Session-pool root; defaults to ~/.iknow (ADR-0087, same resolveServeDataDir as serve). */
  readonly dataDir?: string;
  /** T1: resolved workspace root used when lazily creating a session. */
  readonly workspaceRoot?: string;
  /**
   * Stable productRoot (the startup workspace). Passed through to SessionHub
   * one-way; the bridge never recomputes MCP path policy.
   */
  readonly productRoot?: string;
  /** Harness deps (product path passes the buildTuiDeps result; tests inject stub deps). */
  readonly deps: LoopEngineDeps;
  readonly defaultJsonMode?: boolean;
  readonly traceOut?: string;
  /** In-flight registry (same source as deps.ts's soleInflightId, so attribution stays consistent). */
  readonly inflight: InflightRegistry;
  /** subagentManager is assembled by buildTuiDeps via the
   *  buildHarnessEngine SSOT; hub-bridge passes it through to SessionHub.
   *  Default undefined -> no-manager path (drain returns empty). */
  readonly subagentManager?: SubAgentManager;
  /**
   * ADR-0031: auto-memory hook. Rides the same route as subagentManager
   * (buildTuiDeps -> buildHarnessEngine SSOT assembly) into SessionHub.
   * Absent (default OFF) -> the hub never calls it, behavior byte-identical.
   */
  readonly autoMemory?: AutoMemoryHook;
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
  /** Verify-loop configuration. Absent = transparently off (postMessage runs the plain run). */
  readonly verifyConfig?: VerifyConfig;
  /**
   * Graph-assembly snapshot handle (surfaced by buildTuiDeps). The TUI
   * builds its own engine and the hub only receives finished deps — the
   * handle must be handed in here, otherwise flipping `/graph` on the
   * holder would never reach the next assembly. Absent = this entry has no
   * graph overlay.
   */
  readonly graphAssembly?: GraphAssembly;
  /**
   * ADR-0047: live-graph ledger host (built at the TUI assembly point and
   * handed into the hub here — the hub resolves by conversationId; destroyed
   * by resetSession / hub.shutdown). Absent = no live graph on this entry.
   */
  readonly liveGraphLedger?: LiveGraphLedgerHost;
  /** ADR-0036: preimage accumulator shared with the engine built at the TUI
   *  assembly point. Forwarded to SessionHub so the commit side drains what the
   *  write tools captured. Absent → the hub builds its own (never fed here). */
  readonly preimageLedger?: import("../session-api/store/preimage-ledger.js").PreimageLedgerHost;
  /** Denominator for context-usage display (the **strategy budget
   *  window**, tokens). Defaults to `DEFAULT_CONTEXT_WINDOW =
   *  DEFAULT_STRATEGY_CONTEXT_WINDOW = 256_000` (ADR-0100). */
  readonly contextWindow?: number;
  /** LLM env override source, passed through to SessionHub (used when the
   *  override path rebuilds the adapter; never falls back to process.env).
   *  Same shape as SessionHub's constructor overrideEnv option. */
  readonly overrideEnv?: { readonly llm: LlmEnv };
  /**
   * settings-hot-reload: env source, passed through to
   * SessionHub.envProvider. run.tsx injects EnvLoader.get (first lazy load
   * + cache hit). Default -> the hub's internal loadIknowEnv (zero behavior
   * change).
   */
  readonly envProvider?: () => IknowEnv;
  /** settings-hot-reload: env-change callback, passed through to
   *  SessionHub.onEnvChange. run.tsx injects the EnvLoader.subscribe chain
   *  to refresh the TUI display layer. */
  readonly onEnvChange?: (env: IknowEnv) => void;
  /**
   * ADR-0037: the startup engine root for the injected deps (the root
   * buildTuiDeps was built on). Once declared, the hub's ensureDeps falls to
   * per-root engine rebuild (through the buildEngine seam below) when the
   * session root leaves this root (worktree rebind) — consistent with the
   * serve hub's two assembly paths. Absent = short-circuit semantics.
   */
  readonly engineRoot?: string;
  /**
   * Per-root engine rebuild seam (provided by run.tsx: rerun buildTuiDeps
   * with the same depsOpts + the new root, so post-rebind turns run on the
   * worktree-root engine and reuse the same startup settings object).
   * Absent = no rebuild capability (behavior unchanged).
   *
   * The returned bundle shape is `EngineBundle`, the same type shared by
   * chat's `rebuildDeps` and the hub's `getOrBuildEngine`.
   */
  readonly buildEngine?: (root: string) => Promise<EngineBundle>;
  /**
   * ADR-0070 — one-time assembly-resolution result of
   * `isolation.worktreeExclusive` (same shape as
   * SessionHubOptions.worktreeExclusive; absent = OFF = byte-identical
   * behavior). Resolved by the TUI's run.tsx and passed through; the hub
   * feeds it to the `createTaskWorktreeProvisioner` closure to freeze
   * (ADR-0037 hard requirement: reuse the startup settings).
   */
  readonly worktreeExclusive?: boolean;
  /**
   * ADR-0092: fs isolation mode holder (same shape as
   * SessionHubOptions.fsMode). Passed through to `SessionHub` — the hub's
   * verify call sites read it per call, and the TUI's `/config` flips the
   * same holder (the same instance the bash tool is wired to via
   * buildTuiDeps). Absent = this entry has no fs-mode wiring -> the hub's
   * verify surface uses the global mode (serve wires it the same way, see
   * session-api/serve.ts).
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0119 / specs/yolo-mode.md: the yolo no-sandbox-mode holder (same shape
   * as `SessionHubOptions.yolo`). Passed through to `SessionHub`, whose verify
   * call site reads it per call — it is the **same instance** as the TUI's bash
   * surface (BuildEngineOpts.yolo, passed through buildTuiDeps). Absent = this
   * entry has no yolo wiring -> the hub's verify surface stays non-yolo
   * (fail-closed, fence kept).
   */
  readonly yolo?: YoloContext;
}

/**
 * The last settled turn's terminal outcome, read from the transcript's own
 * outcome records (the hub anchors each one on the head event written by that
 * turn, ADR-0126). Returns undefined when no record is anchored there — the
 * same unknown state a legacy transcript has — and also on a failed read: the
 * messages already loaded, and an unreadable outcome must not fail the reopen
 * it was only meant to annotate.
 */
async function lastTurnOutcome(
  store: SessionStore,
  conversationId: string
): Promise<TurnOutcomeView | undefined> {
  try {
    const { messageEventIds, outcomes } =
      await store.projectTurnOutcomes(conversationId);
    const anchor = messageEventIds[messageEventIds.length - 1];
    const recorded = anchor === undefined ? undefined : outcomes.get(anchor);
    return recorded === undefined
      ? undefined
      : knownTurnOutcome(recorded.stopReason, recorded.supplierDetail);
  } catch {
    return undefined;
  }
}

/**
 * A session whose log is a legacy `.json` with no `.jsonl` is reachable from the
 * picker, and the published-state read reports `not_found` for it because there
 * is no log to read a checkpoint out of. The shared host contract maps that one
 * case to the classification that already covers "predates recoverable
 * checkpoints" (the old bytes stay untouched); it decides it from the session
 * file it read itself, so no host has to keep a private `not_found` catch.
 */
export function createTuiBridge(opts: CreateTuiBridgeOptions): TuiBridge {
  // Store namespace keys by projectIdentityRoot, not cwd — mirrors build-engine.
  const projectIdentityRoot = deriveProjectIdentityRoot({
    cwd: opts.workspaceRoot,
  });
  const store = new SessionStore(
    resolveServeDataDir(opts.dataDir),
    projectIdentityRoot
  );
  const hub = new SessionHub({
    store,
    deps: opts.deps,
    defaultJsonMode: opts.defaultJsonMode ?? false,
    traceOut: opts.traceOut,
    // ADR-0113: inject the title generator only when the lite slot exists
    // (the shared assembly seam converges the dual-source resolution:
    // envProvider first, overrideEnv fallback; absent -> the key never
    // appears and never fires).
    ...liteTitleGeneratorOptions({
      envProvider: opts.envProvider,
      env: opts.overrideEnv,
    }),
    // subagentManager assembled by buildTuiDeps via the buildHarnessEngine
    // SSOT; hub-bridge passes it through to SessionHub.
    subagentManager: opts.subagentManager,
    // auto-memory hook: same pass-through route (absent = off).
    ...(opts.autoMemory ? { autoMemory: opts.autoMemory } : {}),
    ...(opts.overlayMemoryPrefetch
      ? { overlayMemoryPrefetch: opts.overlayMemoryPrefetch }
      : {}),
    // verifyConfig assembled by run.tsx (settings.verify section) and
    // passed through. When command is missing (including the whole verify
    // section), runClassifier takes over (subagentManager present); absent
    // verifyConfig = the run is not wrapped (unwired path only).
    verifyConfig: opts.verifyConfig,
    // Take a graph-assembly snapshot before each postMessage (same semantics as chat).
    ...(opts.graphAssembly ? { graphAssembly: opts.graphAssembly } : {}),
    // Ledger host injected into the hub — resolved by conversationId.
    ...(opts.liveGraphLedger ? { liveGraphLedger: opts.liveGraphLedger } : {}),
    // ADR-0036: the same preimage accumulator the engine's write tools fill.
    // Undefined → the hub builds its own (never fed here).
    preimageLedger: opts.preimageLedger,
    // LLM env override source — the env validated at TUI startup goes to
    // the override path, so rebuilding the adapter there never falls back to
    // process.env.
    ...(opts.overrideEnv ? { overrideEnv: opts.overrideEnv } : {}),
    // settings-hot-reload: env source + change callback pass-through (default -> zero behavior change).
    ...(opts.envProvider ? { envProvider: opts.envProvider } : {}),
    ...(opts.onEnvChange ? { onEnvChange: opts.onEnvChange } : {}),
    // The bridge's resolved root is also the hub's engine/state anchor.
    ...(opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
    // Stable productRoot one-way pass-through (absent -> the hub falls back to workspaceRoot).
    ...(opts.productRoot !== undefined
      ? { productRoot: opts.productRoot }
      : {}),
    // Startup root of the injected deps + per-root rebuild seam pass-through.
    ...(opts.engineRoot !== undefined
      ? { injectedEngineRoot: opts.engineRoot }
      : {}),
    ...(opts.buildEngine ? { buildEngine: opts.buildEngine } : {}),
    // ADR-0070: exclusive-lock mode pass-through. OFF (absent / not true)
    // -> the `worktreeExclusive` field is absent at hub construction, the
    // provisioner skips exclusivity checks entirely, byte-identical behavior.
    ...(opts.worktreeExclusive === true ? { worktreeExclusive: true } : {}),
    // ADR-0092: fs isolation mode holder pass-through — the TUI's verify
    // command surface and the bash tool surface must share a mode (same
    // holder instance; the hub's runVerifyLoop call sites read it per call,
    // so `/config` takes effect on the next call). Same wiring as serve.
    // Direct assignment (tsconfig lacks exactOptionalPropertyTypes):
    // `undefined` equals "key absent" under this repo's opts destructuring,
    // saving one ternary branch — the S5 lint ratchet tolerates zero
    // complexity growth in touched functions.
    fsMode: opts.fsMode,
    // ADR-0119 / specs/yolo-mode.md: holder pass-through — the TUI's verify
    // command surface and its bash tool surface must stay homogeneous (same
    // instance; the hub's runVerifyLoop call site reads it per call, so a
    // `/yolo` flip takes effect on the next call). Direct assignment:
    // `undefined` equals "key absent" under the hub opts destructuring (same as
    // the fsMode line).
    yolo: opts.yolo,
  });

  const toPostResult = (resp: PostMessageResponse): TuiPostResult => ({
    conversationId: resp.session.conversation_id,
    finalText: resp.turn.answer.finalText,
    stopReason: resp.turn.answer.stopReason,
    turnCount: resp.session.turn_count,
    jsonMode: resp.session.json_mode,
    lastUsage: resp.turn.answer.lastUsage ?? null,
    interrupted: resp.turn.answer.interrupted,
    ...(resp.turn.answer.verify !== undefined
      ? { verify: resp.turn.answer.verify }
      : {}),
    // ADR-0094: gateway-side summary pass-through on transport failure;
    // absent field -> absent field (byte-stable). Lets the TUI notice
    // distinguish the API-error copy from the generic connection/model
    // failure copy.
    ...(resp.turn.answer.apiError !== undefined
      ? { apiError: resp.turn.answer.apiError }
      : {}),
    ...(resp.turn.answer.outputLimitNotice !== undefined
      ? { outputLimitNotice: resp.turn.answer.outputLimitNotice }
      : {}),
  });

  const bridge: TuiBridge = {
    hub,
    store,
    ensureSession: async (conversationId) => {
      if (conversationId !== undefined) return conversationId;
      if (opts.workspaceRoot !== undefined) {
        await hub.bindWorkspace(opts.workspaceRoot);
      }
      const created = await hub.createSession();
      return created.session.conversation_id;
    },
    postMessage: async ({
      conversationId,
      text,
      signal,
      thinking,
      onStream,
    }) => {
      opts.inflight.mark(conversationId);
      try {
        const resp = await hub.postMessage({
          conversationId,
          text,
          signal,
          onStream,
          ...(thinking !== undefined ? { thinking } : {}),
        });
        return toPostResult(resp);
      } finally {
        opts.inflight.unmark(conversationId);
      }
    },
    subscribeSubagentTerminal: (subscriber, conversationId) =>
      hub.subscribeSubagentTerminal(subscriber, conversationId),
    wakeFromSubagent: async (conversationId) => {
      opts.inflight.mark(conversationId);
      try {
        const resp = await hub.wakeFromSubagent({ conversationId });
        return resp === undefined ? undefined : toPostResult(resp);
      } finally {
        opts.inflight.unmark(conversationId);
      }
    },
    listSessions: () => hub.listSessions(),
    loadSessionFile: async (conversationId) => {
      const file = await store.load(conversationId);
      const outcome = await lastTurnOutcome(store, conversationId);
      // Outcome absent = nothing to annotate: the plain file keeps its shape
      // for every reader that only knows SessionFileV1.
      return outcome === undefined
        ? file
        : { ...file, lastTurnOutcome: outcome };
    },
    openSession: async (conversationId) => {
      const recovery = await openSessionWithRecovery({
        store,
        conversationId,
        // The shared live write root decision. The bridge has no public read of
        // the hub's dirty-worktree record, so `dirtyRoot` stays absent: a
        // post-rebind intent may then be measured against the pre-rebind root,
        // which reconcile reports as `needs handling` /
        // `root_identity_mismatch` — fail toward visible, never a mutation.
        roots: {
          resolve: (file) =>
            resolveLiveRoot({
              ...(file?.workspaceRoot !== undefined
                ? { recordedRoot: file.workspaceRoot }
                : {}),
              ...(opts.workspaceRoot !== undefined
                ? { boundRoot: opts.workspaceRoot }
                : {}),
              cwd: file?.cwd ?? process.cwd(),
            }),
          // Must equal the identity the write tools stamped on their intents
          // (`projectIdentityRoot ?? sandboxRoot` at the registry), so the same
          // derivation the store namespace already uses is the one compared.
          identityOf: () => mainCheckoutOf(projectIdentityRoot),
        },
        // ADR-0136 §4: this host sweeps the workers the session it is opening
        // owns, before the report — the same session-scoped sweep the hub runs
        // on its own entry read, resolved from the same helper at spawn
        // (`<projectDir>/<conversationId>/subagents`) and filtered by the same
        // session id. Without it a TUI reopen had no stop evidence at all, so
        // no unprovable stop was ever reported.
        sweepOwnedWorkers: (id) => hub.sweepOwnedWorkersForSession(id),
      });
      // Same reason the hub and the chat host do it: durable graph facts are
      // the only record that survives the process that wrote them, so the
      // restored per-node view is folded into the live ledger here — in memory
      // only, once per open, and never on `blocked`.
      if (recovery.status.status !== "blocked") {
        seedRestoredGraphNodes(
          opts.liveGraphLedger?.ledgerFor(conversationId),
          recovery.operationFacts?.graphNodes ?? []
        );
      }
      // The turn this host dispatches next must start from the published state,
      // so the restore is handed to the hub rather than kept in the view.
      hub.adoptEntryRecovery(recovery);
      if (recovery.file === null) {
        // A damaged log: there is no transcript to render and none to
        // reconstruct, so the caller renders the classification alone.
        return { file: null, recovery };
      }
      const outcome = await lastTurnOutcome(store, conversationId);
      // Outcome absent = nothing to annotate: the plain file keeps its shape
      // for every reader that only knows SessionFileV1.
      const file =
        outcome === undefined
          ? recovery.file
          : { ...recovery.file, lastTurnOutcome: outcome };
      return { file, recovery };
    },
    compactSession: async (conversationId, compactOpts) => {
      const res = await hub.compactSession(
        conversationId,
        compactOpts !== undefined
          ? {
              ...(compactOpts.signal !== undefined
                ? { signal: compactOpts.signal }
                : {}),
              ...(compactOpts.onStream !== undefined
                ? { onStream: compactOpts.onStream }
                : {}),
            }
          : undefined
      );
      // cancelled pass-through — the TUI app distinguishes "nothing to
      // compact" from "user cancelled mid-run". reason pass-through — the
      // trigger-classification tag that drives the copy branch.
      return {
        compacted: res.compacted,
        reason: res.reason,
        ...(res.cancelled ? { cancelled: true } : {}),
      };
    },
    continueSession: async (conversationId, continueOpts) => {
      opts.inflight.mark(conversationId);
      try {
        const resp = await hub.continueSession(conversationId, continueOpts);
        return toPostResult(resp);
      } finally {
        opts.inflight.unmark(conversationId);
      }
    },
    // Rewind goes through hub.rewindSession — the same per-conversation
    // serialize queue as postMessage/compact (the old discipline of calling
    // bare store IO outside the queue retired together with rewindFile's
    // truncation semantics). Hub side: hub.rewindSession(id, head) ->
    // store.rewindToHead, no file truncation. store.load returns the
    // projection (the authoritative view after closeout self-heal) for TUI
    // rendering.
    rewindSession: async (conversationId, head, restoreCode) => {
      const { codeRestore } = await hub.rewindSession(
        conversationId,
        head,
        restoreCode
      );
      const file = await store.load(conversationId);
      return codeRestore !== undefined ? { file, codeRestore } : { file };
    },
    listRewindTargets: async (conversationId) => {
      const { targets } = await hub.listRewindTargets(conversationId);
      return targets;
    },
    inflight: opts.inflight,
    contextWindow: opts.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    // Subagent read-only projection. No manager (ask surface / legacy product path) -> empty.
    listSubagents: (conversationId) => hub.listSubagents(conversationId),
    // Force-kill exit (Ctrl+X). Hub-side no-op semantics -> false.
    abortSubagentTask: (taskId) => hub.abortSubagentTask(taskId),
    // Ctrl+C fan-out (foreground subagents of this session). No manager on the hub side -> empty array.
    abortSessionForegroundWork: (conversationId) =>
      hub.abortSessionForegroundWork(conversationId),
  };
  return Object.freeze(bridge);
}
