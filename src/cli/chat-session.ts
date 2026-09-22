/**
 * Product chat session: TTY REPL + non-interactive pipe path.
 * Core line handling is exported for unit tests (no real TTY required).
 */
import * as readline from "node:readline";
import { homedir } from "node:os";
import {
  run as runHarness,
  type AnthropicNativeMessage,
  type HarnessStreamEvent,
  type LoopEngineDeps,
  type LoopTrace,
  type RunResult,
} from "../harness/index.js";
import type { EngineBundle } from "../harness/build-engine.js";
import { runVerifyLoop, type VerifyConfig } from "../harness/verify/index.js";
import { createRunClassifierFromManager } from "../harness/verify/run-classifier-adapter.js";
import {
  formatRunHuman,
  formatRunJson,
  formatStatusLine,
  formatChatVerifyReport,
} from "./format.js";
import {
  applySlashCommand,
  parseChatLine,
  type CliChatState,
  type SlashEffect,
} from "./slash.js";
import type { SessionContext } from "../shared/schema.js";
import { isIknowError, ValidationError } from "../shared/errors.js";
import { MaxTurnsExceeded, errorMessage } from "../harness/errors.js";
import { deriveProjectIdentityRoot } from "../harness/session-roots.js";
import { resolveSessionFenceTmp } from "../harness/sandbox/fence-tmp.js";
import { maxTurnsNotice } from "./max-turns.js";
import {
  clearErrLine,
  isInteractive,
  writeErr,
  writeOut,
} from "./session-io.js";
import { wrapWithViolationHook } from "../harness/sandbox/violation-executor.js";
import {
  mainCheckoutOf,
  type WorktreeGateReader,
} from "../harness/isolation/worktree-gate.js";
import { writeSituation } from "../harness/isolation/write-situation.js";
import {
  renderTranscript,
  hasSuccessfulMemorySave,
} from "../harness/auto-memory-wire.js";
import {
  applyHostPrefetch,
  notifyAutoMemory,
  recoverInjectedMemoryIds,
  recordInjectedMemoryIds,
  type AutoMemoryHook,
  type OverlayPrefetchFn,
} from "../harness/memory/index.js";
import type { SubAgentManager } from "../harness/subagent/manager.js";
import { stampHostInjected } from "../harness/model-adapter/outbound-projection.js";
import {
  drainPendingSubagents,
  drainPendingSubagentsBeforeShutdown,
} from "../harness/subagent/host-drain.js";
import {
  createSubagentWake,
  queryableSubagentTaskIds,
  toSubagentWakeError,
  type SubagentWake,
  type SubagentWakeError,
} from "../harness/subagent/host-wake.js";
import {
  createViolationCounter,
  wireKillSessionNotification,
} from "../harness/sandbox/violation-handling.js";
import { createStreamDraft } from "./stream-draft.js";
import {
  formatThinkingLive,
  formatToolStatusLine,
  summarizePartialInput,
} from "../shared/tool-line.js";
import {
  parsePermissionMode,
  type PermissionMode,
  type PermissionModeContext,
} from "../harness/permission/modes.js";
import {
  agentModeLabel,
  applyGraphCommand,
  applyShiftTabAgentModeFlip,
  type GraphModeContext,
} from "../harness/graph/mode.js";
import {
  applyFsModeCommand,
  type FsIsolationMode,
  type FsModeContext,
} from "../harness/sandbox/fs-mode.js";
import type { GraphAssembly } from "../harness/graph/assembly.js";
import type { LiveGraphLedgerHost } from "../harness/graph/ledger.js";
import {
  SessionStore,
  type SessionStoreError,
  type SessionFileV1,
  CURRENT_SCHEMA_VERSION,
  extractTitle,
  appendCheckpoint,
  decideCheckpointPersist,
  pinGoal,
  shouldPersistCheckpoint,
  toInterruptReason,
  validateGoalText,
  type GoalState,
} from "../session-api/store/index.js";
// Deep import: internal persist-rule helper, deliberately not on the store barrel.
import { persistedLastUsage } from "../session-api/store/schema.js";
import { isTurnQuery } from "../session-api/turn-projection.js";
import { resolveServeDataDir } from "../session-api/serve.js";
import {
  applyGoalAutoContinue,
  applyGoalAutoError,
  reportGoalAutoStoreLoadErr,
  runAutoLoopSteps,
} from "../session-api/goal-auto.js";
import {
  continuePredicateError,
  evaluateContinuePending,
  mapSkipAppendToContinueError,
  matchesContinuePendingNlLine,
  shouldTriggerContinueFromNl,
} from "../session-api/continue-pending.js";
import { MAX_MESSAGE_CHARS } from "../session-api/contract.js";
import {
  exceedsUserInputCap,
  writeRootSegment,
} from "../harness/skill/body.js";
import type { SkillCatalog } from "../harness/skill/catalog.js";
import {
  SkillRescanError,
  type SkillRescanner,
} from "../harness/skill/rescan.js";
import {
  CLI_STATIC_COMMANDS,
  buildCliSkillLoad,
  parseSkillLoad,
  slashPrefix,
  toCliSkillEntries,
} from "./skill-load.js";
import { randomUUID } from "node:crypto";

/** Visual separator after a completed answer on TTY only. */
const TTY_ANSWER_SEP = "────────";

export type ChatSessionOpts = {
  deps: LoopEngineDeps;
  session: SessionContext;
  jsonMode: boolean;
  /**
   * Quiet pipe mode: no turn markers on stderr.
   * Default: true when `IKNOW_CHAT_QUIET=1`, else false.
   * Interactive TTY ignores this (still uses prompt + optional Thinking…
   * spinner).
   */
  quiet?: boolean;
  /**
   * Thinking visibility toggle for the human projection (env-driven).
   * Default false; source `IKNOW_CHAT_SHOW_THINKING=on|off` (env.ts SSOT).
   * When on, thinking is shown before the answer text; `projection.texts` /
   * `finalText` / LoopTrace / session-store are unaffected.
   */
  showThinking?: boolean;
  /**
   * Permission-mode context. `/permissions` flips the mode in place without
   * rebuilding the engine. Not passed by ask/serve.
   */
  permissionMode?: PermissionModeContext;
  /**
   * ADR-0030: session holder for the graph-orchestration overlay. The
   * Shift+Tab tri-state cycle and `/graph on|off` mutate this same object;
   * the assembly layer reads it to decide whether the next run() exposes
   * `run_graph`. ask does not pass it (no overlay).
   */
  graphMode?: GraphModeContext;
  /**
   * ADR-0092: filesystem isolation mode holder (parallel to
   * GraphModeContext — one shared point across the three entry points).
   * `/config` flips it in place; the engine assembly reads the same object
   * (`BuildEngineOpts.fsMode` → bash factory per-call read). ask does not
   * pass it (no fs mode → `/config` reports unwired).
   */
  fsMode?: FsModeContext;
  /**
   * worktree-on-mutate live holder — host passes
   * `BuiltEngine.worktreeOnMutate` (the singleton surfaced by engine
   * assembly; the bash gate reads the same one). chat's verify fence
   * forwards it to runVerifyLoop via `chatVerifyFenceOpts`, so verify and
   * the bash tool face judge the UNBOUND_FENCE axis from the same source.
   * Absent (ask / unwired host seam) → the key is not produced, verify
   * falls back to the V1 baseline, byte-for-byte unchanged.
   */
  worktreeOnMutate?: WorktreeGateReader;
  /**
   * Graph assembly snapshot (`BuiltEngine.graphAssembly`). One chat round =
   * one user query line; the host takes a snapshot before run(), so mode
   * flips only take effect on the next run(). Absent = overlay not wired
   * (neither the tool nor the orchestration segment exists).
   */
  graphAssembly?: GraphAssembly;
  /**
   * Live-graph ledger host, attached to the session runtime parallel to
   * graphMode (the overlay toggle does not destroy it); `/reset` and process
   * exit do. ask does not pass it (no live graph). Session-scoped: a rebind
   * engine rebuild deliberately does **not** rewire it (same as graphMode),
   * otherwise reset semantics would drift across rebinds.
   */
  liveGraphLedger?: LiveGraphLedgerHost;
  /**
   * `--resume <id>` anchors an existing conversationId to continue. When
   * set, runChatSession uses it as the conversationId (writing back to the
   * same checkpoint file) and tries to load existing messages from
   * SessionStore as the initial history; a typed load failure keeps the id
   * as an anchor but starts messages empty. undefined = a fresh random UUID
   * per session.
   */
  resumeId?: string;
  /**
   * Caller-injected REPL-level conversationId. When given it is used
   * directly as the session anchor (cli.ts computes it once at runChat entry
   * and passes it explicitly: = resumeId with --resume, otherwise
   * randomUUID()); runChatSession no longer generates a second one — this
   * keeps subagentsDir, the checkpoint file, and the trace anchor sharing
   * one conversation folder (same SSOT as cli.ts, see ADR-0071).
   * Default (ask / legacy test seam) → `resumeId ?? randomUUID()`, the
   * byte-stable fallback, unchanged.
   */
  conversationId?: string;
  /**
   * Host drain — before each runHarness the chat entry calls
   * `drainPendingSubagents(subagentManager)` and folds the condensed
   * completed envelopes into the next turn's priorMessages. The ask entry
   * has no manager → not passed.
   */
  readonly subagentManager?: SubAgentManager;
  /**
   * Verify-loop config (settings.verify section, constructed in cli.ts).
   * A missing command (including a wholly missing verify section) still
   * yields a non-undefined `{ command: "" }` — with subagentManager present
   * the runClassifier takes over (spawning the judge after each
   * completion); without it (ask shape) the verify loop stays transparently
   * off for backward compatibility. With a configured command, every run is
   * wrapped by runVerifyLoop.
   */
  readonly verifyConfig?: VerifyConfig;
  /**
   * ADR-0031: auto-memory host hook (`BuiltEngine.autoMemory`). Absent
   * (default OFF / ask surface) → never called, behavior byte-for-byte
   * unchanged.
   */
  readonly autoMemory?: AutoMemoryHook;
  /**
   * auto-memory low-trust read: prepend scored bodies onto the user turn.
   * Absent (default OFF / ask) → query is passed through unchanged. Hosts
   * pass `excludeIds` (session-level dedup) via the second argument.
   */
  readonly overlayMemoryPrefetch?: OverlayPrefetchFn;
  /**
   * ADR-0037: per-root engine rebuild seam. The chat REPL's deps are
   * assembled once; after a rebind the session file's workspaceRoot
   * points at the task worktree, and the next turn rebuilds the engine at
   * the new root through this seam (provided by cli.ts runChat — rerun
   * buildHarnessEngine with the same assembly opts + the same startup
   * settings object). Absent (ask / tests) → no rebuild detection, zero
   * behavior change.
   *
   * Returns the full handle bundle (RebuiltChatEngine, matching the TUI
   * buildEngine seam / hub per-root path shape) — returning only deps would
   * drop the rebuilt engine's shutdown / subagentManager handles in the
   * seam (split-brain + leaks).
   */
  readonly rebuildDeps?: (root: string) => Promise<RebuiltChatEngine>;
  /**
   * Engine root at the time `opts.deps` was assembled (sandboxRoot =
   * process.cwd()). Rebind detection baseline: rebuild triggers when the
   * session file's workspaceRoot deviates from it. Absent → no detection.
   */
  readonly engineRoot?: string;
  /**
   * Active-engine shutdown handle box — cli.ts's registerShutdown closure
   * reads `current` (signal hooks installed once); refresh closes out the
   * old engine at the rebind switch point and writes the rebuilt engine's
   * shutdown into current (SIGINT/SIGTERM must always reach the **active**
   * engine, never the stale initial one).
   */
  readonly engineShutdown?: { current?: () => Promise<void> };
  /** T1: resolved workspace root used by fresh checkpoint bootstraps. */
  readonly workspaceRoot?: string;
  /**
   * ADR-0087: session-pool root for an explicit `--data-dir`.
   * `undefined` → `resolveServeDataDir()` defaults to `~/.iknow` — **not** a
   * cwd shard. cli.ts runChat passes `parsed.dataDir`, so
   * `iknow chat --data-dir <alt>` writes checkpoints / resume under `<alt>`
   * instead of silently under `~/.iknow` (explicit dataDir = isolated pool).
   * ask / legacy tests don't pass it → default pool root.
   */
  readonly dataDir?: string;
  /**
   * Worktree isolation flag (one-time read at `buildHarnessEngine` startup,
   * same source as gate arming). `refreshChatDepsForRebind` uses it to
   * compute the situation enum for the one-shot post-rebind write-root
   * segment — with isolation ON and a rebind to a non-tree root it still
   * discloses `no_writable_root` (conservative fallback, aligned with the
   * skill-load write-root contract). Absent → default false (legacy shape =
   * `writable_main`, byte-equal to before the change; tests / ask don't wire
   * this seam).
   */
  readonly isolationOn?: boolean;
  /**
   * Loadable-skills catalog (cli.ts runChat passes
   * `built.skillCatalog`). Present → `/skill-name [remainder]` goes through
   * the skill-load envelope assembly (same entry as TUI / Web). Absent (ask
   * / legacy tests) → skill names fall back to the unknown-command branch,
   * behavior byte-for-byte unchanged.
   */
  readonly skillCatalog?: SkillCatalog;
  /**
   * Hot rescan seam for the loadable surface (cli.ts runChat passes
   * `built.skillRescanner`). Present → before resolving a skill name on
   * every non-empty slash line, rescan with the current root, so skills
   * installed after assembly are visible immediately (no need to wait for
   * the next turn); absent (ask / legacy tests) → candidates stay the
   * assembly-time snapshot, behavior byte-for-byte unchanged.
   *
   * Only meaningful together with `skillCatalog` (without a catalog every
   * skill name hits the unknown-command branch and rescanning is
   * pointless); ignored when the catalog is absent.
   */
  readonly skillRescanner?: SkillRescanner;
};

/**
 * rebuildDeps seam return bundle — beyond deps it carries the rebuilt
 * engine's host handles, shaped like the TUI `buildEngine` seam / hub
 * per-root path. This is the `EngineBundle` SSOT alias shared by the three
 * hosts, so no private copy can drift semantically.
 */
export type RebuiltChatEngine = EngineBundle & {
  /**
   * The rebuilt engine's skillCatalog (a `BuiltEngine` superset field;
   * `EngineBundle` itself doesn't surface it — that's the six-field host
   * handle surface). Optional: legacy seams (returning only EngineBundle)
   * omit it → refresh keeps the ctx's original catalog (the old root's
   * skill set; a visible degradation rather than a silent swap).
   */
  readonly skillCatalog?: SkillCatalog;
  /**
   * The rebuilt engine's rescan seam (`BuiltEngine` same field). Must be
   * swapped **together with** `skillCatalog` — swapping only the catalog
   * would draw "hot" candidates from the old root's scan seam. Optional:
   * legacy seams omit it → keep the original rescanner (same visible
   * degradation as the catalog; never silently becomes "no rescan").
   */
  readonly skillRescanner?: SkillRescanner;
};

export type ChatLineContext = {
  deps: LoopEngineDeps;
  state: CliChatState;
  /** Thinking visibility toggle (same source as ChatSessionOpts.showThinking). */
  showThinking?: boolean;
  /** Permission-mode context (passed through by runChatSession; /permissions flips it). */
  permissionMode?: PermissionModeContext;
  /** Graph-orchestration overlay holder (passed through by runChatSession;
   *  flipped by /graph and Shift+Tab). */
  graphMode?: GraphModeContext;
  /** ADR-0092: filesystem isolation mode holder (passed through by
   *  runChatSession; /config flips it). */
  fsMode?: FsModeContext;
  /** worktree-on-mutate live holder (same as
   *  ChatSessionOpts.worktreeOnMutate, passed through by runChatSession).
   *  verify fence and the bash gate share the UNBOUND_FENCE judgment;
   *  absent → key not produced. */
  worktreeOnMutate?: WorktreeGateReader;
  /** Graph assembly snapshot (passed through by runChatSession; taken once
   *  before a query line runs). */
  graphAssembly?: GraphAssembly;
  /**
   * Live-graph ledger host (same as ChatSessionOpts.liveGraphLedger, passed
   * through by runChatSession). Session-scoped — destroyed by `/reset`;
   * destroyAll on process exit.
   */
  liveGraphLedger?: LiveGraphLedgerHost;
  /**
   * REPL-level AbortController wired into run()'s signal — the first SIGINT
   * while busy aborts the in-flight turn, which resolves with stopReason
   * "cancelled". Default (pipe / tests) → signal=undefined, zero change.
   */
  abortController?: AbortController;
  /**
   * SessionStore for post-run checkpoints (default ~/.iknow pool, shared
   * with serve/TUI). When present alongside `state.conversationId`,
   * post-run goes decideCheckpointPersist → appendCheckpoint → atomic
   * write. Default (ask/tests) → skip persistence, zero change.
   */
  checkpointStore?: SessionStore;
  /** T1: resolved root persisted when a fresh checkpoint file is bootstrapped. */
  workspaceRoot?: string;
  /**
   * Same as ChatSessionOpts.subagentManager, passed through by
   * runChatSession. Absent (undefined) = no drain, zero change. Mutable —
   * after a rebind rebuild, refreshChatDepsForRebind swaps it to the
   * rebuilt engine's manager (split-brain fix).
   */
  subagentManager?: SubAgentManager;
  /**
   * Rebind closeout queue: terminal results drained from the old manager
   * before it shuts down, awaiting delivery in the next primary-model run.
   */
  pendingSubagentDrain?: string;
  /**
   * One-shot write-root notice segment: set by refreshChatDepsForRebind
   * after a successful rebind (writeRootSegment text); appended to the end
   * of the priorMessages for the next query line / subagent wake and then
   * cleared. Fires once after rebind, not on every user message; never
   * enters system / env_snapshot. On run failure / cancellation the notice
   * is **discarded, not redelivered** (deliberate: the write root is
   * idempotent guidance; the next rebind reissues it).
   */
  pendingWriteRootNotice?: string;
  /**
   * Interactive host hook used to resubscribe wake delivery after a rebind
   * replaces the manager. Non-interactive callers leave it unset.
   */
  onSubagentManagerRebound?: () => void;
  /**
   * Same as ChatSessionOpts.verifyConfig, passed through by
   * runChatSession. Absent (undefined) = run is not wrapped, behavior
   * byte-for-byte unchanged (only test / unwired assembly paths).
   */
  readonly verifyConfig?: VerifyConfig;
  /**
   * Same as ChatSessionOpts.autoMemory, passed through by runChatSession.
   * Absent = hook not called, zero change. Mutable — follows the active
   * engine on rebind rebuilds.
   */
  autoMemory?: AutoMemoryHook;
  /**
   * Auto-memory low-trust read: same ChatSessionOpts field, passed through
   * by runChatSession. Hosts pass `excludeIds` (session-level dedup) via
   * the second argument. Mutable — follows the active engine on rebind
   * rebuilds.
   */
  overlayMemoryPrefetch?: OverlayPrefetchFn;
  /**
   * Auto-memory session-level prefetch dedup state — per-conversation sets
   * of already-injected memory ids. Allocated lazily by processChatLine
   * (the runChatSession ctx lives for the whole REPL, naturally
   * per-conversation); optional in tests.
   */
  prefetchInjectedIds?: Map<string, Set<string>>;
  /**
   * CLI _client_ idle/busy-guard for continue. Shared mutable box
   * so a concurrent processChatLine can refuse continue without aborting the
   * in-flight turn (EXIT busy_stop_first).
   */
  clientBusy?: { value: boolean };
  /**
   * Per-root engine rebuild seam (assembled by runChatSession; same as
   * ChatSessionOpts.rebuildDeps). Absent → processChatLine does no rebuild
   * detection. Returns the RebuiltChatEngine bundle (handle rewiring in
   * refreshChatDepsForRebind).
   */
  rebuildDeps?: (root: string) => Promise<RebuiltChatEngine>;
  /**
   * Engine root the current deps are bound to (mutable — updated with the
   * new root after rebuilds).
   */
  engineRoot?: string;
  /**
   * Active-engine shutdown handle box (same as
   * ChatSessionOpts.engineShutdown, passed through by runChatSession).
   * Absent (ask/tests) → rebuilds skip shutdown closeout/handoff, behavior
   * matches the previous version.
   */
  engineShutdown?: { current?: () => Promise<void> };
  /**
   * Wrapper seam for rebuilt deps (runChatSession provides wrapChatDeps —
   * violation executor + conversationId + commitMessages with the same
   * semantics as initial assembly). Absent → rebuild results only converge
   * conversationId (tests).
   */
  wrapRebuiltDeps?: (base: LoopEngineDeps) => LoopEngineDeps;
  /**
   * Worktree isolation flag (same source as
   * `ChatSessionOpts.isolationOn` — passed through by runChatSession). Used
   * by `refreshChatDepsForRebind` to compute the situation enum of the
   * one-shot post-rebind write-root segment. Never changes across rebinds
   * (settings read at startup, read-only afterwards). Absent → default
   * false (legacy shape = `writable_main`; tests / ask don't wire this
   * seam).
   */
  isolationOn?: boolean;
  /**
   * Loadable-skills catalog (`BuiltEngine`'s skillCatalog). Present →
   * `/skill-name [remainder]` goes through skill-load envelope assembly
   * (same entry semantics as TUI / Web); absent (ask / legacy tests) →
   * skill names fall back to the unknown-command branch, byte-identical to
   * today.
   *
   * Mutable — refreshChatDepsForRebind swaps it to the rebuilt engine's
   * catalog after rebinds (otherwise the slash surface stays on the old
   * root's skill set = split-brain).
   */
  skillCatalog?: SkillCatalog;
  /**
   * "Hot at the moment" rescan seam for the loadable surface (same as
   * `ChatSessionOpts.skillRescanner`, passed through by runChatSession).
   * Present → rescan with the current root before resolving a skill name on
   * each non-empty slash line, so newly installed skills after assembly are
   * visible immediately.
   *
   * Mutable — swapped **together with** `skillCatalog` on rebind (swapping
   * only one = new-root candidates on the old root's scan seam,
   * split-brain).
   */
  skillRescanner?: SkillRescanner;
};

/**
 * Rebind detection — when the session file's workspaceRoot deviates from
 * ctx.engineRoot (an isolation gate rebound and persisted the root during
 * the previous turn), rebuild at the new root. Failure degrades visibly
 * (keep the old deps; the stale engine's gate stays fail-closed, never
 * silently allowing writes to the old root). rebuildDeps / checkpointStore
 * absent (ask / tests) → no-op.
 *
 * After a successful rebuild, the RebuiltChatEngine bundle's handles are
 * rewired into ctx — subagentManager / graphAssembly / autoMemory /
 * overlayMemoryPrefetch all point at the rebuilt engine (otherwise drain
 * reads the old manager while the active engine spawns into the new one =
 * split-brain result loss; /graph snapshots would reflect the old
 * assembly). Shutdown closeout order: **close out the old engine first,
 * then write the rebuilt engine's shutdown into
 * ctx.engineShutdown.current** (a combined closeout was rejected —
 * registerShutdown installs signal hooks once and its closure reads the
 * single `current` value; a historical handle list would let the signal
 * path re-close already-retired engines). Before switching, wait for the
 * old engine's still-running background subagents to finish and drain
 * their terminal results into the next primary-model run; task ids whose
 * wait failed are reported on stderr before shutdown, and the old engine
 * is still closed out per its existing lifecycle.
 */
/**
 * Split-brain fix: after the rebuilt engine takes over, point all
 * host-side handles at it — drain / `/graph` snapshots / auto-memory /
 * overlay prefetch / skill surface follow the active engine.
 *
 * Extracted from `refreshChatDepsForRebind` under single responsibility
 * (that function was already long); each item is a "rebuilt artifact → ctx
 * slot" transfer with the same rule — when the provider is absent, keep
 * the original value.
 */
function swapHostHandlesToRebuiltEngine(
  ctx: ChatLineContext,
  rebuilt: RebuiltChatEngine
): void {
  ctx.subagentManager = rebuilt.subagentManager;
  ctx.graphAssembly = rebuilt.graphAssembly;
  ctx.autoMemory = rebuilt.autoMemory;
  ctx.overlayMemoryPrefetch = rebuilt.overlayMemoryPrefetch;
  // Skill surface follows the active engine — after handoff, `/skill`
  // candidates / body reads use the new root's skill set (when the legacy
  // seam omits the field, keep the original catalog; see
  // RebuiltChatEngine.skillCatalog).
  if (rebuilt.skillCatalog !== undefined) {
    ctx.skillCatalog = rebuilt.skillCatalog;
  }
  // The rescan seam must also point at the **new** seam post-rebind — a
  // fresh catalog with rescan still on the old root would make "skills
  // installed on the new root" and "rescan results from the old root"
  // fight each other on the next `/` line (candidates hot but sourced from
  // the old root). Absent (legacy seam) → keep the original rescanner
  // (same visible degradation as the catalog; never silently drops
  // rescanning).
  if (rebuilt.skillRescanner !== undefined) {
    ctx.skillRescanner = rebuilt.skillRescanner;
  }
}

export async function refreshChatDepsForRebind(
  ctx: ChatLineContext
): Promise<void> {
  const rebuild = ctx.rebuildDeps;
  if (rebuild === undefined) return;
  const conversationId = ctx.state.conversationId;
  if (conversationId === null) return;
  const store = ctx.checkpointStore;
  if (store === undefined) return;
  let newRoot: string | undefined;
  try {
    const file = await store.load(conversationId);
    newRoot = file.workspaceRoot;
  } catch (err) {
    // typed not_found = the normal shape of an absent session file → no
    // rebind signal, stay silent (the gate's fail-closed backstop still
    // holds). Other errors (io_error / parse_failed / schema_invalid…) are
    // real IO faults — degrade visibly (keep the old deps), never swallow
    // silently.
    if (
      typeof err === "object" &&
      err !== null &&
      (err as { kind?: unknown }).kind === "not_found"
    ) {
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    writeErr(
      `[worktree_isolation] rebind 检测读取会话文件失败，保持旧根（mutate 仍 fail-closed）: ${msg}\n`
    );
    return;
  }
  if (newRoot === undefined || newRoot === ctx.engineRoot) return;
  let rebuilt: RebuiltChatEngine;
  try {
    rebuilt = await rebuild(newRoot);
  } catch (err) {
    writeErr(
      `[worktree_isolation] 会话已改绑到 ${newRoot}，但引擎重建失败，保持旧根（mutate 仍 fail-closed）: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    return;
  }
  // Switch point: close out the old engine first (await; failure warns
  // only — a closeout fault must not block the new engine taking over),
  // then swap ctx handles + the shutdown box. This ordering guarantees the
  // signal path always reads `current` pointing at "the active engine after
  // the old one was closed" — no window where both engines hold handles.
  const previousManager = ctx.subagentManager;
  if (previousManager !== undefined) {
    const closeout = await drainPendingSubagentsBeforeShutdown(
      previousManager,
      {
        onError: (error) =>
          writeErr(
            `[worktree_isolation] 旧 manager 后台结果收口异常（继续收口并显式检查未交付任务）: ${
              error instanceof Error ? error.message : String(error)
            }\n`
          ),
      }
    );
    if (closeout.text.length > 0) {
      ctx.pendingSubagentDrain = ctx.pendingSubagentDrain
        ? `${ctx.pendingSubagentDrain}\n\n${closeout.text}`
        : closeout.text;
    }
    if (closeout.undeliveredTaskIds.length > 0) {
      writeErr(
        `[worktree_isolation] 旧 manager 中仍在运行的后台子代理未能在 rebind 前交付，shutdown 将取消它们，结果未交付：${closeout.undeliveredTaskIds.join(", ")}\n`
      );
    }
  }
  const prevShutdown =
    ctx.engineShutdown?.current ??
    (previousManager !== undefined
      ? previousManager.shutdown.bind(previousManager)
      : undefined);
  if (prevShutdown !== undefined) {
    try {
      await prevShutdown();
    } catch (err) {
      writeErr(
        `[worktree_isolation] 旧引擎 shutdown 收口失败（继续切换）: ${
          err instanceof Error ? err.message : String(err)
        }\n`
      );
    }
  }
  const base = rebuilt.deps;
  ctx.deps = ctx.wrapRebuiltDeps
    ? ctx.wrapRebuiltDeps(base)
    : { ...base, conversationId };
  ctx.engineRoot = newRoot;
  ctx.engineShutdown && (ctx.engineShutdown.current = rebuilt.shutdown);
  swapHostHandlesToRebuiltEngine(ctx, rebuilt);
  try {
    ctx.onSubagentManagerRebound?.();
  } catch (err) {
    writeErr(
      `[worktree_isolation] 重建后重新订阅子代理唤醒失败，新 manager 结果仍可在下一查询行 drain：${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
  }
  // Write-root segment: when rebind succeeded and **the live write root ≠
  // the identity root**, give the next primary-model run the current write
  // root once (same helper text as worker prior / skill trailer). Identity
  // root = mainCheckoutOf(newRoot) (pure path derivation, same source as
  // assembly-time projectIdentityRoot): on exit-worktree back to the main
  // repo the two roots coincide, and the injected "write root is up /
  // Project path read-only" text would contradict itself → don't set it.
  // Only reached on successful rebuild; rebuild failure / unchanged-root
  // early returns skip this.
  //
  // Situation enum = writeSituation(isolationOn, newRoot). Isolation OFF is
  // always `writable_main` (byte-equal to before the change); isolation ON +
  // tree root → `writable_tree` (also byte-equal); isolation ON + non-tree
  // root → the third state's disclosure (conservative fallback; a genuine
  // return to the main repo is already rejected above by `mainCheckoutOf`).
  ctx.pendingWriteRootNotice =
    newRoot !== mainCheckoutOf(newRoot)
      ? (writeRootSegment(
          writeSituation(
            ctx.worktreeOnMutate !== undefined
              ? ctx.worktreeOnMutate.get()
              : (ctx.isolationOn ?? false),
            newRoot
          ),
          newRoot
        ) ?? undefined)
      : undefined;
}

type ChatSubagentDrain = {
  readonly text: string;
  readonly pendingText?: string;
};

async function collectChatSubagentDrain(
  ctx: ChatLineContext
): Promise<ChatSubagentDrain> {
  const pendingText = ctx.pendingSubagentDrain;
  const currentText = await drainPendingSubagents(ctx.subagentManager);
  const text = [pendingText, currentText]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n\n");
  return {
    text,
    ...(pendingText !== undefined ? { pendingText } : {}),
  };
}

function acknowledgeChatSubagentDrain(
  ctx: ChatLineContext,
  pendingText: string | undefined
): void {
  if (pendingText !== undefined && ctx.pendingSubagentDrain === pendingText) {
    ctx.pendingSubagentDrain = undefined;
  }
}

/**
 * Drain-prefixed user message (shared by wake / query-line commits).
 * ADR-0112: the condensed drain is a host-injected commit — stamped with a
 * non-model-visible provenance mark; only the outbound projection forwards
 * it as the official "## Sub-agent " prefix anchor. Every text block in the
 * segment (drain / write-root notice) comes from the host, so stamping the
 * whole message is sound.
 */
function hostDrainMessage(
  texts: ReadonlyArray<string>
): AnthropicNativeMessage {
  return stampHostInjected({
    role: "user",
    content: Object.freeze(
      texts.map((text) => Object.freeze({ type: "text" as const, text }))
    ),
  });
}

export type ProcessChatLineResult = {
  quit: boolean;
  /** Material for stdout (answers, slash info/help/reset). */
  output: string;
  /**
   * Status line extracted from `formatRunHuman` (human projection only;
   * `undefined` for JSON projection or slash commands). The streaming chat
   * host uses this when the answer text has already been streamed to stdout
   * as the final output — emitting it avoids re-rendering the answer.
   */
  statusLine?: string;
  /** Material for stderr (errors). */
  stderr?: string;
  /** True when this line was a user query that ran the agent. */
  ranQuery?: boolean;
  /** A silent subagent handoff failed; no completion was fabricated. */
  wakeFailure?: SubagentWakeError;
};

export interface ProcessChatLineOpts {
  readonly line: string;
  readonly ctx: ChatLineContext;
  /**
   * Streaming-event observer callback, passed through to run() opts
   * verbatim. The interactive REPL uses it for incremental preview (spinner
   * seam); pipe/ask don't wire it (undefined passthrough, zero change).
   * Observer callback exceptions are swallowed at the loop-engine layer
   * (observers must not break turns).
   */
  readonly onStream?: (event: HarnessStreamEvent) => void;
}

/**
 * Pure disk-read + helper for the chat-side verify-loop task formula:
 * `goal.text ?? query` (same discipline as empty-goal-skip).
 *
 * History: a taskFocus segment was once removed from verify input; the
 * whole session.taskFocus field and its seed lifecycle have since been
 * retired, so only the goal field drives it.
 *
 * Failure semantics (named EXIT paths):
 * - store absent / conversationId === null → HITL; userText = query.
 *   Never treat the query as the judge's task for a completion.
 * - store.load succeeds with non-empty goal.text → auto; userText =
 *   goal.text.
 * - store.load succeeds with missing / empty goal.text → HITL;
 *   userText = query.
 * - store.load throws anything (incl. not_found) → HITL; userText = query.
 *   Fail-open (query as judge task) is forbidden.
 */
async function resolveVerifyDispatch(
  store: SessionStore | undefined,
  conversationId: string | null,
  query: string
): Promise<{
  readonly userText: string;
  readonly completionMode: "hitl" | "auto";
}> {
  if (store === undefined || conversationId === null) {
    return { userText: query, completionMode: "hitl" };
  }
  try {
    const session = await store.load(conversationId);
    if (session.goal !== undefined && session.goal.text.length > 0) {
      return { userText: session.goal.text, completionMode: "auto" };
    }
    return { userText: query, completionMode: "hitl" };
  } catch (err) {
    // EXIT: load throw → HITL, userText=query; never fail-open query as judge task.
    skipChatAutoOnLoadError(err, conversationId);
    return { userText: query, completionMode: "hitl" };
  }
}

function busyBox(ctx: ChatLineContext): { value: boolean } {
  if (ctx.clientBusy === undefined) {
    ctx.clientBusy = { value: false };
  }
  return ctx.clientBusy;
}

function isClientBusy(ctx: ChatLineContext): boolean {
  return ctx.clientBusy?.value === true;
}

function busyStopFirstResult(): ProcessChatLineResult {
  return {
    quit: false,
    output: "",
    stderr: "busy_stop_first: a turn is already in progress; not aborting",
  };
}

function continueFailResult(stderr: string): ProcessChatLineResult {
  return { quit: false, output: "", stderr };
}

type ContinueLoaded =
  | {
      ok: true;
      messages: ReadonlyArray<AnthropicNativeMessage>;
      goal?: GoalState;
    }
  | { ok: false; result: ProcessChatLineResult };

/** store.load when conversationId is set; freeze-of-state is the no-disk test stand-in. */
async function loadContinueTranscript(
  ctx: ChatLineContext
): Promise<ContinueLoaded> {
  const store = ctx.checkpointStore;
  const conversationId = ctx.state.conversationId;
  if (store === undefined || conversationId === null) {
    return { ok: true, messages: ctx.state.messages };
  }
  try {
    const file = await store.load(conversationId);
    return {
      ok: true,
      messages: file.messages,
      ...(file.goal !== undefined ? { goal: file.goal } : {}),
    };
  } catch (err) {
    if (!isSessionStoreErrorKind(err)) throw err;
    // Missing disk file = empty transcript (fresh conversation; same as /goal).
    if ((err as SessionStoreError).kind === "not_found") {
      return { ok: true, messages: [] };
    }
    return {
      ok: false,
      result: continueFailResult(typedGoalError(err, conversationId)),
    };
  }
}

type ContinuePrep =
  | { kind: "busy" }
  | { kind: "exit"; result: ProcessChatLineResult }
  | { kind: "run"; prior: ReadonlyArray<AnthropicNativeMessage> }
  | { kind: "skip" };

async function prepareContinue(opts: {
  readonly ctx: ChatLineContext;
  readonly mode: "slash" | "nl";
  readonly line: string;
}): Promise<ContinuePrep> {
  // Slash: busy-first (do not start a second continue). NL: load+predicate
  // first so a table line that is not pending skip-appends as a normal query
  // even while another turn is in-flight.
  if (opts.mode === "slash" && isClientBusy(opts.ctx)) {
    return { kind: "busy" };
  }
  const loaded = await loadContinueTranscript(opts.ctx);
  if (!loaded.ok) return { kind: "exit", result: loaded.result };
  const verdict = evaluateContinuePending({
    messages: loaded.messages,
    ...(loaded.goal !== undefined ? { goal: loaded.goal } : {}),
  });
  if (opts.mode === "nl") {
    if (
      !shouldTriggerContinueFromNl({
        line: opts.line,
        pending: verdict.ok,
      })
    ) {
      return { kind: "skip" };
    }
    if (isClientBusy(opts.ctx)) return { kind: "busy" };
  } else if (!verdict.ok) {
    return {
      kind: "exit",
      result: continueFailResult(continuePredicateError(verdict.exit).message),
    };
  }
  return { kind: "run", prior: loaded.messages };
}

async function executeSkipAppendTurn(opts: {
  readonly ctx: ChatLineContext;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const { ctx, priorMessages } = opts;
  const box = busyBox(ctx);
  box.value = true;
  let stopSummary: string | undefined;
  const wrappedOnStream =
    opts.onStream === undefined
      ? undefined
      : (event: HarnessStreamEvent): void => {
          if (event.type === "stop_summary") stopSummary = event.text;
          else opts.onStream!(event);
        };
  try {
    return await runSkipAppendAndPresent({
      ctx,
      priorMessages,
      stopSummaryRef: {
        get: () => stopSummary,
      },
      ...(wrappedOnStream !== undefined ? { onStream: wrappedOnStream } : {}),
    });
  } finally {
    box.value = false;
  }
}

async function runSkipAppendAndPresent(opts: {
  readonly ctx: ChatLineContext;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  readonly stopSummaryRef: { get: () => string | undefined };
}): Promise<ProcessChatLineResult> {
  const { ctx, priorMessages } = opts;
  try {
    const { result, trace } = await runHarness(
      "",
      ctx.deps,
      ctx.abortController?.signal,
      {
        priorMessages,
        appendUserText: false,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      }
    );
    if (ctx.checkpointStore && ctx.state.conversationId !== null) {
      await persistChatSessionCheckpoint({
        store: ctx.checkpointStore,
        conversationId: ctx.state.conversationId,
        jsonMode: ctx.state.jsonMode,
        ...(ctx.workspaceRoot !== undefined
          ? { workspaceRoot: ctx.workspaceRoot }
          : {}),
        result,
        priorMessages,
      });
    }
    if (
      result.stopReason !== "protocolError" &&
      result.stopReason !== "emptyFinalResponse"
    ) {
      ctx.state.messages = Object.freeze([...result.messages]);
    }
    // auto-memory: `/continue` is also a completed turn; treat it like the
    // main path.
    notifyAutoMemory({
      hook: ctx.autoMemory,
      stopReason: result.stopReason,
      transcript: renderTranscript(result.messages),
      sessionKey: ctx.state.conversationId ?? "chat",
      memorySaveSucceeded: hasSuccessfulMemorySave(
        result.messages.slice(priorMessages.length)
      ),
      onError: (error) =>
        writeErr(
          `[memory/auto] turn hook skipped: ${
            error instanceof Error ? error.message : String(error)
          }\n`
        ),
    });
    return presentChatTurn({
      ctx,
      result,
      trace,
      priorMessages,
    });
  } catch (err) {
    const mapped = mapSkipAppendToContinueError(err);
    if (mapped !== null) return continueFailResult(mapped.message);
    if (err instanceof MaxTurnsExceeded) {
      const notice = maxTurnsNotice(err, opts.stopSummaryRef.get());
      return {
        quit: false,
        output: notice.output,
        stderr: notice.stderr,
        ranQuery: true,
      };
    }
    return {
      quit: false,
      output: "",
      stderr: formatChatError(err),
      ranQuery: true,
    };
  }
}

/**
 * Consume a terminal subagent handoff without inventing a user input.
 * The drain is a prior user message for the model, but it never goes through
 * the readline/input-history path.
 */
export async function runChatSubagentWake(opts: {
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const { ctx } = opts;
  const pendingDrain = await collectChatSubagentDrain(ctx);
  if (pendingDrain.text.length === 0) return { quit: false, output: "" };
  const box = busyBox(ctx);
  if (box.value) return { quit: false, output: "" };
  box.value = true;
  ctx.graphAssembly?.beginRound();
  // Write-root segment: wake is a primary-model run that may arrive before
  // a user query post-rebind — consume the one-shot slot the same way query
  // lines do; consuming clears it.
  const wakeWriteRootNotice = ctx.pendingWriteRootNotice;
  if (wakeWriteRootNotice !== undefined) {
    ctx.pendingWriteRootNotice = undefined;
  }
  const wakeTailTexts = [pendingDrain.text, wakeWriteRootNotice].filter(
    (value): value is string => value !== undefined && value.length > 0
  );
  const priorMessages = Object.freeze([
    ...ctx.state.messages,
    hostDrainMessage(wakeTailTexts),
  ]);
  try {
    const { result, trace } = await runHarness(
      "",
      ctx.deps,
      ctx.abortController?.signal,
      {
        priorMessages,
        appendUserText: false,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      }
    );
    acknowledgeChatSubagentDrain(ctx, pendingDrain.pendingText);
    if (ctx.checkpointStore && ctx.state.conversationId !== null) {
      await persistChatSessionCheckpoint({
        store: ctx.checkpointStore,
        conversationId: ctx.state.conversationId,
        jsonMode: ctx.state.jsonMode,
        result,
        priorMessages: ctx.state.messages,
      });
    }
    if (
      result.stopReason !== "protocolError" &&
      result.stopReason !== "emptyFinalResponse"
    ) {
      ctx.state.messages = Object.freeze([...result.messages]);
    }
    return presentChatTurn({
      ctx,
      result,
      trace,
      priorMessages,
    });
  } catch (err) {
    const wakeError = toSubagentWakeError(err, {
      taskIds: queryableSubagentTaskIds(ctx.subagentManager),
      queryable: ctx.subagentManager !== undefined,
    });
    return {
      quit: false,
      output: "",
      stderr: formatChatError(wakeError),
      ranQuery: false,
      wakeFailure: wakeError,
    };
  } finally {
    box.value = false;
  }
}

function presentChatTurn(opts: {
  readonly ctx: ChatLineContext;
  readonly result: RunResult;
  readonly trace: LoopTrace;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
}): ProcessChatLineResult {
  const { ctx, result, trace, priorMessages } = opts;
  const interruptNote =
    result.stopReason === "cancelled"
      ? shouldPersistCheckpoint(result, priorMessages)
        ? "已保存"
        : "未落checkpoint"
      : undefined;
  const human = !ctx.state.jsonMode;
  const output = human
    ? formatRunHuman({
        result,
        trace,
        showThinking: ctx.showThinking,
        interruptNote,
      })
    : formatRunJson({ result, trace });
  const statusLine = human
    ? formatStatusLine({
        result,
        trace,
        showThinking: ctx.showThinking,
        interruptNote,
      })
    : undefined;
  return {
    quit: false,
    output,
    ...(statusLine !== undefined ? { statusLine } : {}),
    ranQuery: true,
  };
}

async function dispatchPreparedContinue(
  prep: ContinuePrep,
  ctx: ChatLineContext,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<ProcessChatLineResult | undefined> {
  if (prep.kind === "busy") return busyStopFirstResult();
  if (prep.kind === "exit") return prep.result;
  if (prep.kind === "skip") return undefined;
  return executeSkipAppendTurn({
    ctx,
    priorMessages: prep.prior,
    ...(onStream !== undefined ? { onStream } : {}),
  });
}

async function runSlashContinue(opts: {
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const prep = await prepareContinue({
    ctx: opts.ctx,
    mode: "slash",
    line: "/continue",
  });
  const result = await dispatchPreparedContinue(prep, opts.ctx, opts.onStream);
  return (
    result ??
    continueFailResult("nothing_pending: cannot continue this session")
  );
}

async function maybeContinueFromPendingNl(opts: {
  readonly line: string;
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult | undefined> {
  if (!matchesContinuePendingNlLine(opts.line)) return undefined;
  const prep = await prepareContinue({
    ctx: opts.ctx,
    mode: "nl",
    line: opts.line,
  });
  return dispatchPreparedContinue(prep, opts.ctx, opts.onStream);
}

/**
 * The **current** catalog for slash candidates.
 *
 * The assembly-time catalog is a frozen snapshot (`ctx.skillCatalog` only
 * refreshes on rebind), so newly installed skills wait for the next rebind
 * to enter candidates — but the surface should include new entries the
 * moment they are installed / reloaded. When the rescan seam is present,
 * rescan live and return the current `loadable()`; seam absent (ask / legacy
 * tests) or rescan failure → the cached snapshot (the human-side slash
 * surface must not go empty because of one IO fault; EXIT: visible
 * degradation).
 *
 * The refresh point is **non-static slash lines** (`trySkillLoadLine`), not
 * every keystroke: the CLI resolves candidates as "type `/name` + Enter"
 * (no per-key completion), so per-key rescans would only add input latency
 * without changing any observable result; "immediately" = effective on the
 * next slash line. Static-vocabulary lines (`/help` etc.) short-circuit
 * inside `parseSkillLoad`, so rescans have no observable effect on them —
 * callers check for static first, never scanning the disk for a `/quit`.
 *
 * Degradation reports only real faults (non-ENOENT `SkillRescanError`) — a
 * skill root happening to be absent during rescan is a legal empty state
 * (existing scanner discipline) and shouldn't spam.
 */
async function slashCandidateCatalog(
  ctx: ChatLineContext,
  cached: SkillCatalog
): Promise<SkillCatalog> {
  const rescanner = ctx.skillRescanner;
  if (rescanner === undefined) return cached;
  try {
    return await rescanner.rescan();
  } catch (err) {
    if (!(err instanceof SkillRescanError)) throw err;
    // EXIT: typed rescan failure → fall back to the cached catalog (never
    // throw to the REPL: one IO fault must not turn installed skills into
    // unknown command), but the degradation must be visible. Rendering
    // belongs to `errorMessage` (the typed-error catch contract forbids
    // `instanceof Error ? … : String(…)`).
    writeErr(
      `[skill] slash 候选刷新失败，沿用装配期快照: ${errorMessage(err)}\n`
    );
    return cached;
  }
}

/**
 * Skill-name parsing and envelope assembly on slash lines (single-
 * responsibility extraction from `processChatLine`).
 *
 * Static-vocabulary precedence is guaranteed inside `parseSkillLoad` (a hit
 * on `CLI_STATIC_COMMANDS` → undefined, caller falls back to
 * `processSlash`). Returning `undefined` means "this line is not a
 * skill-load" — the caller continues slash dispatch; a returned result
 * object means the line was consumed.
 *
 * Catalog absent (ask / legacy tests) → always `undefined`, behavior
 * identical to today.
 */
async function trySkillLoadLine(
  line: string,
  ctx: ChatLineContext,
  onStream: ProcessChatLineOpts["onStream"]
): Promise<ProcessChatLineResult | undefined> {
  const cached = ctx.skillCatalog;
  if (cached === undefined) return undefined;
  // Static-vocabulary lines (/help /quit …) short-circuit inside
  // parseSkillLoad — rescanning has no observable effect on them, so don't
  // scan the disk for a single /quit.
  const prefix = slashPrefix(line);
  if (prefix === "" || CLI_STATIC_COMMANDS.has(prefix)) return undefined;
  // Candidates come from the **current** catalog (live rescan when the seam
  // is present; absent / failed → cached snapshot). Parsing and body reads
  // use the same instance — otherwise "candidate hits but get misses" fake
  // unknowns appear.
  const catalog = await slashCandidateCatalog(ctx, cached);
  // Keep the hot catalog in memory (body read / later lines): the swap
  // happens only on the success branch.
  ctx.skillCatalog = catalog;
  const skillLoad = parseSkillLoad(line, toCliSkillEntries(catalog));
  if (skillLoad === undefined) return undefined;
  const entry = catalog.get(skillLoad.name);
  // Not in the catalog (parseSkillLoad matched a projected entry but get
  // failed) — same tier as TUI: prompt explicitly, never silently fall back
  // to unknown command.
  if (entry === undefined) {
    return { quit: false, output: `技能 ${skillLoad.name} 不可用（不存在）。` };
  }
  try {
    // The envelope is same-source as TUI / Web (buildSkillLoadText); a
    // body-read failure propagates to the REPL error surface, never
    // disguised as success.
    const sendText = await buildCliSkillLoad({
      name: skillLoad.name,
      remainder: skillLoad.remainder,
      entry,
    });
    // Reuse the query-line path: turn commits / persistence / interruption
    // semantics all match ordinary questions (skill-load is just a
    // machine-assembled user message). Swap the line for the envelope —
    // runChatQueryLine re-runs parseChatLine internally, and the envelope
    // doesn't start with "/" so it hits the query branch, exactly the
    // semantics we want.
    return await runChatQueryLine({
      line: sendText,
      ctx,
      ...(onStream !== undefined ? { onStream } : {}),
    });
  } catch (err) {
    // Disk-read / assembly failures are real faults (same tier as TUI /
    // hub: never disguised as success). Reuse formatChatError (IknowError
    // renders as an error line with its code).
    return { quit: false, output: formatChatError(err) };
  }
}

/**
 * Pure-ish one-line handler for tests and both I/O paths.
 * Mutates ctx (state) as needed.
 */
export async function processChatLine(
  opts: ProcessChatLineOpts
): Promise<ProcessChatLineResult> {
  const { line, ctx } = opts;
  const parsedLine = parseChatLine(line);

  if (parsedLine.kind === "empty") {
    return { quit: false, output: "" };
  }

  if (parsedLine.kind === "slash") {
    // Skill names are tried before static slash dispatch (static precedence
    // guaranteed inside the helper). undefined = not a skill-load; continue
    // slash dispatch.
    const skillLoadLine = await trySkillLoadLine(line, ctx, opts.onStream);
    if (skillLoadLine !== undefined) return skillLoadLine;
    // Slash lines don't run the engine → skip rebind detection, saving a
    // store.load per slash line. Detection lives on the engine-line path
    // (incl. continue lines).
    return processSlash({
      command: parsedLine.command,
      args: parsedLine.args,
      ctx,
      ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
    });
  }

  // Rebind detection — after an isolation gate rebound the session root to
  // a task worktree on the previous turn, rebuild deps at the new root
  // before this line starts (only effective when chat production wires
  // rebuildDeps; ask / tests absent → no-op). Rebuild failure degrades
  // visibly. Placement: engine-line path (slash lines returned above, no
  // store.load IO).
  await refreshChatDepsForRebind(ctx);

  const query = parsedLine.text;

  const fromNl = await maybeContinueFromPendingNl({
    line: query,
    ctx,
    ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
  });
  if (fromNl !== undefined) return fromNl;

  // Machine-assembled skill-load messages skip the user-input length cap
  // (same root cause as hub.ts validateText: a 78KB SKILL.md loaded at once
  // would hit the 8000 cap; symmetric with the model-side tool-result
  // channel having no character cap — both are machine-assembled, not typed
  // user text).
  if (exceedsUserInputCap(query, MAX_MESSAGE_CHARS)) {
    return {
      quit: false,
      output: "",
      stderr: `message text exceeds max length ${MAX_MESSAGE_CHARS}`,
    };
  }

  const box = busyBox(ctx);
  box.value = true;
  try {
    return await runChatQueryLine(opts);
  } finally {
    box.value = false;
  }
}

/**
 * auto-memory: per-conversation injected-id set for the chat path, lazily
 * recovered from ctx.state.messages on first attach — the same messages that
 * seedResumeMessages seeded on `--resume` (cold start from checkpoint /
 * session JSONL). Empty set is cached too; recovery failure degrades to an
 * empty set (log-and-continue inside recoverInjectedMemoryIds).
 */
function chatPrefetchExcludeIds(ctx: ChatLineContext): Set<string> {
  const conversationId = ctx.state.conversationId ?? "chat";
  if (ctx.prefetchInjectedIds === undefined) {
    ctx.prefetchInjectedIds = new Map<string, Set<string>>();
  }
  const cached = ctx.prefetchInjectedIds.get(conversationId);
  if (cached !== undefined) return cached;
  const recovered = recoverInjectedMemoryIds(ctx.state.messages);
  ctx.prefetchInjectedIds.set(conversationId, recovered);
  return recovered;
}

/**
 * Opts the chat verify call site needs to match the bash tool surface
 * (ADR-0092).
 *
 * Same shape as the like-named seam in `session-api/hub.ts`: the holder is
 * **read per call** (a `/config` flip takes effect on the next verify, not
 * an assembly-time snapshot); `homeRoot` = `homedir()` — chat's engine
 * assembly (cli.ts's `buildHarnessEngine`) doesn't inject `userHome`, so
 * build-engine's `opts.userHome ?? homedir()` lands on the latter, same
 * source in both places.
 *
 * Holder absent (ask entry / unwired) → neither `fsMode` nor `homeRoot` key
 * is produced, runVerifyLoop uses the global-mode baseline, identical to
 * today.
 *
 * `tmpDir` is orthogonal to the holder and **always** resolved — it feeds
 * the `$TMPDIR` shared by both modes, same as the bash surface (the bash
 * handler unconditionally injects `TMPDIR: tmpDir` into the fence env).
 * Resolution uses the **same** helper as the bash surface
 * (`resolveSessionFenceTmp`), not a third independent derivation: project
 * root from `ctx.checkpointStore.getProjectDir()` (same source as cli.ts's
 * `todoProjectDir`, i.e. the `projectDir` the registry feeds bash), leaf
 * from `state.conversationId`. Host null/absent (ask / tests / unwired) →
 * the key is not produced and verify-loop falls back to process `tmpdir()`
 * (a fallback, not the target state).
 *
 * `worktreeOnMutate` holder is orthogonal to the three seams above and
 * keyed independently — the singleton surfaced by engine assembly (chat
 * host passes `built.worktreeOnMutate`), so the verify fence judges the
 * UNBOUND_FENCE axis from the same source as the bash surface via
 * `makeDefaultRunVerify`. Absent (host didn't pass it / legacy injection
 * seam) → key absent, byte-unchanged.
 */
function chatVerifyFenceOpts(ctx: ChatLineContext): {
  readonly fsMode?: FsIsolationMode;
  readonly homeRoot?: string;
  readonly tmpDir?: string;
  readonly worktreeOnMutate?: WorktreeGateReader;
} {
  const holder = ctx.fsMode;
  const tmpDir = resolveSessionFenceTmp({
    projectDir: ctx.checkpointStore?.getProjectDir(),
    conversationId: ctx.state.conversationId ?? undefined,
  });
  return {
    ...(holder === undefined
      ? {}
      : { fsMode: holder.get(), homeRoot: homedir() }),
    ...(tmpDir !== undefined ? { tmpDir } : {}),
    ...(ctx.worktreeOnMutate !== undefined
      ? { worktreeOnMutate: ctx.worktreeOnMutate }
      : {}),
  };
}

async function runChatQueryLine(
  opts: ProcessChatLineOpts
): Promise<ProcessChatLineResult> {
  const { ctx } = opts;
  const parsedLine = parseChatLine(opts.line);
  if (parsedLine.kind !== "query") {
    return { quit: false, output: "" };
  }
  const query = parsedLine.text;

  // Round boundary (ADR-0030): one user query line = one run(). Snapshot the
  // graph assembly here; every run() on this line (incl. verify / auto-loop
  // multi-rounds) shares the same tool surface. Shift+Tab and `/graph` flips
  // after this point take effect only on the next line.
  ctx.graphAssembly?.beginRound();

  // HITL vs /goal auto dispatch. Read the disk only when verifyConfig is
  // present; the absent branch goes straight to runHarness(query, ...) with
  // no extra IO.
  const verifyDispatch =
    ctx.verifyConfig === undefined
      ? undefined
      : await resolveVerifyDispatch(
          ctx.checkpointStore,
          ctx.state.conversationId,
          query
        );
  // stop_summary observation — a wrapper captures the closing-summary text
  // emitted on abnormal stops. The host's onStream (if any) only receives
  // business events like text_delta / tool_call_start, avoiding a
  // double-print in the preview sink. The loop-engine run() emits the
  // summary before returning / rethrowing, so summary rounds don't count
  // toward maxTurns. Variable hoisted outside try: the catch block reads it
  // too.
  let stopSummary: string | undefined;
  const wrappedOnStream:
    | ((event: import("../harness/index.js").HarnessStreamEvent) => void)
    | undefined =
    opts.onStream === undefined
      ? undefined
      : (event) => {
          if (event.type === "stop_summary") stopSummary = event.text;
          else opts.onStream!(event);
        };
  const outputs: string[] = [];
  let lastStatusLine: string | undefined;
  // auto-memory: session-level prefetch dedup — exclude ids already
  // injected in this conversation (lazy resume recovery from ctx.state.messages
  // on first attach) and record what this turn actually injects (overlay-
  // bearing attach results only; identity fallbacks add nothing).
  const prefetchExcludeIds = chatPrefetchExcludeIds(ctx);
  const attachPrefetch = (text: string): Promise<string> =>
    applyHostPrefetch(text, ctx.overlayMemoryPrefetch, {
      excludeIds: prefetchExcludeIds,
    }).then((effective) => {
      recordInjectedMemoryIds(prefetchExcludeIds, effective);
      return effective;
    });
  // F4: shared /goal auto-loop skeleton. Chat's `reloadSession` is a no-op
  // (in-memory ctx.state.messages already mutated inside `run`); hub reloads
  // via store.load. Each host controls its own error semantics (chat converts
  // to error result; hub rethrows).
  try {
    return await runAutoLoopSteps({
      run: async () => {
        // Host drain — condense the manager's completed subagent results
        // into a user message, appended to the end of this run's
        // priorMessages. Empty manager / nothing completed → priorMessages
        // unchanged (zero behavior change).
        const pendingDrain = await collectChatSubagentDrain(ctx);
        // Write-root segment: injected once after rebind, concatenated after
        // the drain (if any), cleared on consumption.
        const writeRootNotice = ctx.pendingWriteRootNotice;
        if (writeRootNotice !== undefined) {
          ctx.pendingWriteRootNotice = undefined;
        }
        const tailTexts = [pendingDrain.text, writeRootNotice].filter(
          (value): value is string => value !== undefined && value.length > 0
        );
        const priorMessages =
          tailTexts.length > 0
            ? Object.freeze([
                ...ctx.state.messages,
                hostDrainMessage(tailTexts),
              ])
            : ctx.state.messages;
        // When verifyConfig is non-undefined (incl. an empty command
        // string), run is wrapped by runVerifyLoop (advisor shape, zero
        // engine changes); absent → the bare runHarness call is
        // byte-unchanged (only the unwired path). runVerifyLoop's runFn
        // passes onStream → wrappedOnStream, keeping the stop_summary
        // capture semantics; no trace is injected (chat has no trace
        // service) so VerificationRecord isn't persisted (trace is
        // optional). Note: runVerifyLoop's first-round runFn omits
        // priorMessages / onStream — the closure must supply chat's
        // priorMessages and wrappedOnStream, or multi-turn history is lost
        // and streaming preview breaks.
        const runOutcome =
          verifyDispatch !== undefined && ctx.verifyConfig !== undefined
            ? await runVerifyLoop({
                runFn: (text, o) =>
                  attachPrefetch(text).then(async (effective) => {
                    const outcome = await runHarness(
                      effective,
                      ctx.deps,
                      o?.signal,
                      {
                        priorMessages: o?.priorMessages ?? priorMessages,
                        onStream: o?.onStream ?? wrappedOnStream,
                      }
                    );
                    acknowledgeChatSubagentDrain(ctx, pendingDrain.pendingText);
                    return outcome;
                  }),
                userText: verifyDispatch.userText,
                completionMode: verifyDispatch.completionMode,
                config: ctx.verifyConfig,
                sessionId: ctx.state.conversationId ?? "chat",
                signal: ctx.abortController?.signal,
                cwd: process.cwd(),
                // The verify command's fence matches the bash tool surface
                // (holder read per call; absent → global baseline).
                ...chatVerifyFenceOpts(ctx),
                // Production wiring: subagentManager present → enable
                // classifier fill-in (when command is missing/empty the
                // classifier takes over); absent (ask shape) → undefined,
                // verify-loop naturally stays transparently off for
                // backward compatibility.
                runClassifier:
                  ctx.subagentManager === undefined
                    ? undefined
                    : createRunClassifierFromManager({
                        manager: ctx.subagentManager,
                      }),
              })
            : await attachPrefetch(query).then(async (effective) => {
                const outcome = await runHarness(
                  effective,
                  ctx.deps,
                  ctx.abortController?.signal,
                  {
                    priorMessages,
                    onStream: wrappedOnStream,
                  }
                );
                acknowledgeChatSubagentDrain(ctx, pendingDrain.pendingText);
                return outcome;
              });
        const { result, trace } = runOutcome;
        // Ctrl+C interrupt feedback — prompt whether the checkpoint was
        // saved, only when cancelled. The cancelled judgment matches
        // decideCheckpointPersist (delta>0 → "已保存"), keeping the
        // status-line text consistent with the actual write; non-cancelled →
        // undefined (no prefix).
        const interruptNote =
          result.stopReason === "cancelled"
            ? shouldPersistCheckpoint(result, priorMessages)
              ? "已保存"
              : "未落checkpoint"
            : undefined;
        const human = !ctx.state.jsonMode;
        // Surface the verify final verdict (failed/unstable/escalated) to
        // chat output, so "model claims done but verification didn't pass"
        // doesn't render as a normal completion. Only the verify branch has
        // outcome/rounds; the bare run branch has none (no report, behavior
        // unchanged).
        const verifyReport =
          "outcome" in runOutcome
            ? formatChatVerifyReport(runOutcome.outcome, runOutcome.rounds)
            : undefined;
        const baseOutput = human
          ? formatRunHuman({
              result,
              trace,
              showThinking: ctx.showThinking,
              interruptNote,
            })
          : formatRunJson({ result, trace });
        const output =
          verifyReport !== undefined
            ? `${baseOutput}\n${verifyReport}`
            : baseOutput;
        outputs.push(output);
        lastStatusLine = human
          ? formatStatusLine({
              result,
              trace,
              showThinking: ctx.showThinking,
              interruptNote,
            })
          : undefined;
        return { result, runOutcome, priorMessages };
      },
      persist: async (s) => {
        // Post-run checkpoint write (mirrors hub.ts conditionalSave).
        // Ask/serve/tests don't wire checkpointStore → skip, zero change
        // (pipe / ask untouched). Persist only after run resolves — throw
        // paths (the catch below) never reach here, deliberately
        // implementing the prior ruling ("MaxTurnsExceeded does not save"
        // falls out naturally from the catch branch: an unresolved run has
        // no usable turnCount / messages, and appendCheckpoint can't
        // produce delta>0).
        if (ctx.checkpointStore && ctx.state.conversationId !== null) {
          await persistChatSessionCheckpoint({
            store: ctx.checkpointStore,
            conversationId: ctx.state.conversationId,
            jsonMode: ctx.state.jsonMode,
            ...(ctx.workspaceRoot !== undefined
              ? { workspaceRoot: ctx.workspaceRoot }
              : {}),
            result: s.result,
            priorMessages: s.priorMessages,
          });
        }
        // Continue the conversation next turn on cancelled/timeout/nonSuccessStop
        // (all append an assistant message). maxTurns no longer returns here —
        // ADR-0011 upgraded it to `throw MaxTurnsExceeded`, caught below
        // without appending anything. protocolError and emptyFinalResponse
        // return finalState with NO assistant message appended, so continuing on
        // them would feed a dangling user message to the model next turn and
        // poison the loop — drop context on those two. CliChatState owned by host
        // replaces and freezes the shallow copy so history remains append-only
        // (harness returns ReadonlyArray).
        if (
          s.result.stopReason !== "protocolError" &&
          s.result.stopReason !== "emptyFinalResponse"
        ) {
          ctx.state.messages = Object.freeze([...s.result.messages]);
        }
        // ADR-0031: hand each turn's result to the hook, which owns the
        // completed gate + N-turn gate. Hook absent (default OFF / ask) →
        // the whole call is a no-op.
        notifyAutoMemory({
          hook: ctx.autoMemory,
          stopReason: s.result.stopReason,
          transcript: renderTranscript(s.result.messages),
          sessionKey: ctx.state.conversationId ?? "chat",
          memorySaveSucceeded: hasSuccessfulMemorySave(
            s.result.messages.slice(s.priorMessages.length)
          ),
          onError: (error) =>
            writeErr(
              `[memory/auto] turn hook skipped: ${
                error instanceof Error ? error.message : String(error)
              }\n`
            ),
        });
      },
      decideContinue: async (s) =>
        applyChatAutoContinue({
          ctx,
          result: s.result,
          runOutcome: s.runOutcome,
          priorCount: s.priorMessages.length,
        }),
      buildStop: async () => ({
        quit: false,
        output: outputs.join("\n"),
        ...(lastStatusLine !== undefined ? { statusLine: lastStatusLine } : {}),
        ranQuery: true,
      }),
      reloadSession: async () => {
        // Chat keeps session state in-memory (ctx.state.messages mutated above);
        // reload is a no-op here. Hub passes `() => store.load(id)`.
      },
    });
  } catch (err) {
    await applyChatAutoError(ctx, err);
    if (err instanceof MaxTurnsExceeded) {
      // ADR-0011: maxTurns overflow is a forced-awareness signal — catch
      // the throw and present the "limit reached" stderr + closing summary
      // (if any). The summary is captured by the wrapper above (loop-engine
      // emits stop_summary before rethrowing).
      const notice = maxTurnsNotice(err, stopSummary);
      return {
        quit: false,
        output:
          outputs.length > 0
            ? `${outputs.join("\n")}\n${notice.output}`
            : notice.output,
        stderr: notice.stderr,
        ranQuery: true,
      };
    }
    return {
      quit: false,
      output: outputs.join("\n"),
      stderr: formatChatError(err),
      ranQuery: true,
    };
  }
}

async function applyChatAutoContinue(opts: {
  readonly ctx: ChatLineContext;
  readonly result: RunResult;
  readonly runOutcome: {
    readonly result: RunResult;
    readonly outcome?: string;
    readonly records?: ReadonlyArray<{
      readonly reason?: string;
      readonly missing?: readonly string[];
    }>;
  };
  readonly priorCount: number;
}): Promise<boolean> {
  const { ctx, result, runOutcome, priorCount } = opts;
  const store = ctx.checkpointStore;
  const conversationId = ctx.state.conversationId;
  if (store === undefined || conversationId === null) return false;
  if (ctx.verifyConfig === undefined) return false;
  return applyGoalAutoContinue({
    store,
    conversationId,
    summary: {
      result,
      priorCount,
      records: runOutcome.records ?? [],
      ...(runOutcome.outcome !== undefined
        ? { verifyOutcome: runOutcome.outcome }
        : {}),
    },
    onLoadError: (err) => skipChatAutoOnLoadError(err, conversationId),
  });
}

async function applyChatAutoError(
  ctx: ChatLineContext,
  err: unknown
): Promise<void> {
  const store = ctx.checkpointStore;
  const conversationId = ctx.state.conversationId;
  if (store === undefined || conversationId === null) return;
  await applyGoalAutoError({
    store,
    conversationId,
    err,
    onLoadError: (loadErr) => skipChatAutoOnLoadError(loadErr, conversationId),
  });
}

async function processSlash(opts: {
  readonly command: string;
  readonly args: string[];
  readonly ctx: ChatLineContext;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<ProcessChatLineResult> {
  const { command, args, ctx } = opts;
  const effect = applySlashCommand({
    command,
    args,
    ctx: { state: ctx.state },
  });

  switch (effect.type) {
    case "quit":
      return { quit: true, output: "" };

    case "help":
    case "info":
      return { quit: false, output: effect.text };

    case "error":
      return { quit: false, output: "", stderr: effect.text };

    case "reset":
      // reset destroys the live-graph ledger — afterwards a re-run of
      // run_graph in the same session can reuse old ids and truly spawn.
      // Ledger absent (ask / tests unwired) → no-op.
      if (ctx.liveGraphLedger !== undefined) {
        const convId = ctx.state.conversationId;
        if (convId !== null) {
          ctx.liveGraphLedger.destroy(convId);
        }
      }
      return { quit: false, output: effect.message };

    case "continue":
      return runSlashContinue({
        ctx,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      });

    case "permissions": {
      // Permission-mode query/switch. Without ctx.permissionMode (ask/serve
      // don't pass it) → show "not available". Empty args / "status" → show
      // the current mode; valid mode → set; invalid → error text.
      const modeCtx = ctx.permissionMode;
      const target = (effect.args[0] ?? "").toLowerCase();
      if (!modeCtx) {
        return {
          quit: false,
          output: "",
          stderr: "/permissions: 当前入口不提供权限模式上下文（ask/serve）",
        };
      }
      if (target === "" || target === "status" || target === "help") {
        const current = modeCtx.get();
        const hint =
          target === "help"
            ? "  · 用法: /permissions [default|plan|full_auto]"
            : "";
        return {
          quit: false,
          output: `权限模式: ${current}${hint}`,
        };
      }
      const parsed: PermissionMode | undefined = parsePermissionMode(target);
      if (parsed === undefined) {
        return {
          quit: false,
          output: "",
          stderr:
            "Usage: /permissions [default|plan|full_auto]（或空 / status 查看当前）",
        };
      }
      modeCtx.set(parsed);
      return {
        quit: false,
        output: `权限模式已切换: ${parsed}`,
      };
    }

    case "graph":
      // Graph-mode query/switch for the orchestration overlay. Semantics and
      // text are single-sourced in harness/graph/mode.ts (same source for
      // TUI / serve); chat only decides stdout vs stderr. Holder absent (ask
      // doesn't install it) → unavailable notice.
      return applyHolderSlash(
        ctx.graphMode,
        (h) => applyGraphCommand(h, effect.args),
        "/graph: 当前入口不提供 graph 模式上下文（ask）"
      );

    case "config":
      // Filesystem isolation mode query/switch (ADR-0092). Semantics and
      // text are single-sourced in harness/sandbox/fs-mode.ts (same source
      // for TUI / serve); chat only decides stdout vs stderr. Holder absent
      // (ask doesn't install it) → unavailable notice. Like /graph: flips
      // the holder only, never persists to settings — chat has no settings
      // write-back channel (the TUI's persistence face is onPersistFsMode;
      // the settings path is the startup read surface, not a REPL command's
      // job).
      return applyHolderSlash(
        ctx.fsMode,
        (h) => applyFsModeCommand(h, effect.args),
        "/config: 当前入口不提供文件系统隔离档上下文（ask）"
      );

    case "goal": {
      // /goal has three faces — status / clear / pin(<text>).
      // status / clear follow the typed-error catch contract: not_found is
      // the legal state of a fresh conversation (not an error; silent
      // stderr + friendly output), other typed errors (parse_failed /
      // schema_invalid / io_error / write_failed / concurrent_write) render
      // `${kind}: ${conversation_id}`. pin first passes validateGoalText
      // length/empty checks; non-null → stderr error, nothing written.
      // recordGoal is emitted uniformly by hub.clearGoal on the clear
      // branch.
      const store = ctx.checkpointStore;
      const conversationId = ctx.state.conversationId;
      if (!store || !conversationId) {
        return {
          quit: false,
          output: "",
          stderr:
            "/goal: 当前入口不提供会话持久化上下文（ask / pipe 模式不支持）",
        };
      }
      if (effect.action === "status") {
        return goalStatus(store, conversationId);
      }
      if (effect.action === "clear") {
        return goalClear(store, conversationId);
      }
      const pinned = await goalPin(
        store,
        conversationId,
        effect,
        ctx.workspaceRoot
      );
      if (pinned.stderr !== undefined || ctx.verifyConfig === undefined) {
        return pinned;
      }
      const started = await processChatLine({
        line: effect.text,
        ctx,
        ...(opts.onStream !== undefined ? { onStream: opts.onStream } : {}),
      });
      const output =
        pinned.output.length > 0 && started.output.length > 0
          ? `${pinned.output}\n${started.output}`
          : pinned.output || started.output;
      return { ...started, output };
    }
  }
}

/**
 * Holder absent → this entry doesn't offer the control; otherwise run the
 * SSOT apply and route the text to stdout / stderr by ok. `/graph` and
 * `/config` differ only in holder + apply + absent text — semantics and
 * literals stay with their respective SSOTs (harness/graph/mode.ts,
 * harness/sandbox/fs-mode.ts); this function only dispatches the host-side
 * carrier.
 */
function applyHolderSlash<T>(
  holder: T | undefined,
  apply: (h: T) => { ok: boolean; text: string },
  unavailable: string
): ProcessChatLineResult {
  if (!holder) {
    return { quit: false, output: "", stderr: unavailable };
  }
  const result = apply(holder);
  return result.ok
    ? { quit: false, output: result.text }
    : { quit: false, output: "", stderr: result.text };
}

/** /goal status — echo the current goal.text; not_found = the legal
 *  fresh-conversation state "no goal set". */
async function goalStatus(
  store: SessionStore,
  conversationId: string
): Promise<ProcessChatLineResult> {
  let existing: SessionFileV1;
  try {
    existing = await store.load(conversationId);
  } catch (err) {
    if (
      isSessionStoreErrorKind(err) &&
      (err as SessionStoreError).kind === "not_found"
    ) {
      return { quit: false, output: "未设置 goal" };
    }
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  const goalText = existing.goal?.text;
  if (!goalText) {
    return { quit: false, output: "未设置 goal" };
  }
  return { quit: false, output: `goal: ${goalText}` };
}

/** /goal clear — chat-side mirror of hub.clearGoal semantics (goal cleared
 *  via an atomic store write); not_found = the legal fresh-conversation
 *  state "nothing to clear". Note: the CLI chat entry doesn't assemble
 *  SessionHub; recordGoal trace emission lives in hub, so no trace side
 *  effect on the CLI path is an existing fact. */
async function goalClear(
  store: SessionStore,
  conversationId: string
): Promise<ProcessChatLineResult> {
  let existing: SessionFileV1;
  try {
    existing = await store.load(conversationId);
  } catch (err) {
    if (
      isSessionStoreErrorKind(err) &&
      (err as SessionStoreError).kind === "not_found"
    ) {
      return { quit: false, output: "无 goal 可清" };
    }
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  const now = new Date().toISOString();
  const cleared: SessionFileV1 = {
    ...existing,
    goal: undefined,
    updatedAt: now,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
  try {
    await store.save({ id: conversationId, file: cleared });
  } catch (err) {
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  return { quit: false, output: "goal cleared" };
}

/** /goal pin — non-null validateGoalText → stderr error, nothing written;
 *  valid → atomic write via pinGoal (same path shape). Fresh conversations
 *  also take the not_found legal state (pin from zero, constructing a
 *  minimal SessionFileV1). */
async function goalPin(
  store: SessionStore,
  conversationId: string,
  effect: Extract<SlashEffect, { type: "goal" }>,
  workspaceRoot?: string
): Promise<ProcessChatLineResult> {
  const text = effect.text.trim();
  if (text.length === 0) {
    return {
      quit: false,
      output: "",
      stderr: "Usage: /goal <status|clear|text>",
    };
  }
  const invalid = validateGoalText(text);
  if (invalid !== null) {
    return { quit: false, output: "", stderr: `goal rejected: ${invalid}` };
  }
  const loaded = await loadGoalTarget(store, conversationId, workspaceRoot);
  if (!loaded.ok) return loaded.result;
  return savePinnedGoal(
    store,
    conversationId,
    loaded.file,
    text,
    effect.maxTurns
  );
}

/** load-or-fresh: not_found is the legal fresh-conversation state → return
 *  a minimal SessionFileV1 (pin from zero); other typed errors → return a
 *  stderr-rendered result. */
async function loadGoalTarget(
  store: SessionStore,
  conversationId: string,
  workspaceRoot?: string
): Promise<
  | { ok: true; file: SessionFileV1 }
  | { ok: false; result: ProcessChatLineResult }
> {
  try {
    return { ok: true, file: await store.load(conversationId) };
  } catch (err) {
    if (
      isSessionStoreErrorKind(err) &&
      (err as SessionStoreError).kind === "not_found"
    ) {
      return {
        ok: true,
        file: freshSessionFile(
          conversationId,
          requireSessionWorkspaceRoot(workspaceRoot)
        ),
      };
    }
    return {
      ok: false,
      result: {
        quit: false,
        output: "",
        stderr: typedGoalError(err, conversationId),
      },
    };
  }
}

/** Minimal legal SessionFileV1 (shape consistent with persistChatSessionCheckpoint's reconstruction). */
function freshSessionFile(
  conversationId: string,
  workspaceRoot: string
): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: conversationId,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    title: "",
    cwd: workspaceRoot,
    sanitized_at: now,
    checkpoints: [],
    workspaceRoot,
  };
}

function requireSessionWorkspaceRoot(
  workspaceRoot: string | undefined
): string {
  if (workspaceRoot === undefined || workspaceRoot.trim().length === 0) {
    throw new ValidationError(
      "workspace root is required to create a session",
      { field: "workspaceRoot" }
    );
  }
  return workspaceRoot;
}

/** pinGoal + atomic write; save failure → typed-error rendering, no crash. */
async function savePinnedGoal(
  store: SessionStore,
  conversationId: string,
  existing: SessionFileV1,
  text: string,
  maxTurns?: number
): Promise<ProcessChatLineResult> {
  const now = new Date().toISOString();
  const updated: SessionFileV1 = {
    ...existing,
    goal: pinGoal({
      current: existing.goal,
      text,
      now,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
    }),
    updatedAt: now,
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
  try {
    await store.save({ id: conversationId, file: updated });
  } catch (err) {
    return {
      quit: false,
      output: "",
      stderr: typedGoalError(err, conversationId),
    };
  }
  return { quit: false, output: `goal pinned: ${text}` };
}

/** Typed-error catch contract — render `${kind}: ${conversation_id}`.
 *  Only accepts SessionStore typed errors (the discriminated union's kind);
 *  unknown throws are surprises outside the store contract and are rethrown
 *  as-is (defensive, never silently swallowed). */
function typedGoalError(err: unknown, conversationId: string): string {
  if (isSessionStoreErrorKind(err)) {
    const kind = (err as SessionStoreError).kind;
    return `${kind}: ${conversationId}`;
  }
  throw err;
}

function formatChatError(err: unknown): string {
  if (isIknowError(err)) {
    return `错误 [${err.code}]: ${err.message}`;
  }
  if (err instanceof Error) {
    return `错误: ${err.message}`;
  }
  return `错误: ${String(err)}`;
}

/**
 * Message-seeding helper for `--resume <id>` — runChatSession calls it
 * before constructing state, loading existing messages from SessionStore as
 * the initial history (processChatLine's `prior = ctx.state.messages`
 * naturally sees them; the first continued turn needs no extra wiring).
 *
 * Pure IO (the only IO is `store.load`) + pure mapping, no harness deps,
 * easy to unit-test. Exported so tests can verify typed-error boundary
 * handling directly.
 *
 * **Failure semantics**: SessionStore.load only throws typed
 * SessionStoreError (not_found | parse_failed | schema_invalid | io_error).
 * All typed errors are **non-blocking** — return empty messages + a warn
 * callback (one stderr line); callers keep the conversationId anchor so
 * later checkpoints still write back to the same `<id>.jsonl` instead of
 * fragmenting into a new id. Unknown throws (defensive — the store only
 * throws typed) are rethrown as-is.
 */
export async function seedResumeMessages(opts: {
  readonly store: SessionStore | undefined;
  readonly id: string | undefined;
}): Promise<{
  messages: ReadonlyArray<AnthropicNativeMessage>;
  /** Default = nothing to report (undefined → not called); when present, the caller should run it to emit stderr. */
  warn?: () => void;
}> {
  if (opts.store === undefined || opts.id === undefined) {
    return { messages: [] };
  }
  try {
    const file = await opts.store.load(opts.id);
    return { messages: file.messages };
  } catch (err) {
    if (!isSessionStoreErrorKind(err)) {
      // Defensive: the store contract only throws typed errors; unknown
      // exceptions must surface, never be silently swallowed.
      throw err;
    }
    const kind = (err as SessionStoreError).kind;
    const id = opts.id;
    const warnFor = (k: SessionStoreError["kind"]) => (): void =>
      writeErr(`恢复会话 ${id} 失败: [${k}]，从空开始（仍锚定 ${id} 续写）`);
    return { messages: [], warn: warnFor(kind) };
  }
}

/**
 * Post-run checkpoint write for the chat REPL — chat-side mirror of
 * `src/session-api/hub.ts` conditionalSave. Pure IO (load / atomic save);
 * all decisions delegate to the pure functions in
 * `session-api/store/checkpoint.ts` (tri-state SSOT; rules are not
 * duplicated here):
 *
 *   - `decideCheckpointPersist(result, priorMessages)` returns three kinds:
 *     "none" (zero-delta cancelled / protocolError without a user delta) →
 *     early return, no write; "full" → persist all of result.messages;
 *     "partial_user_only" → append only the real user queries (isTurnQuery,
 *     same source as hub) from this run's delta; failed assistant turns
 *     never enter history (spec invariant).
 *   - `toInterruptReason` maps StopReason to a checkpoint label (cancelled /
 *     timeout / protocolError / maxTurns; completed etc. → null, no record
 *     appended).
 *   - `appendCheckpoint` has a built-in delta<=0 no-op guard (appends only
 *     when records.messagesCount > session.messages.length).
 *
 * **Cumulative turnCount**: mirrors hub's `session.turnCount +
 * result.turnCount` convention — when the conversationId already has an
 * on-disk file, new records continue numbering from its turnCount, so
 * --resume reads a contiguous snapshot series.
 *
 * **Error handling**: all failures reuse SessionStore's existing typed
 * kinds (write_failed / not_found / parse_failed / schema_invalid), never
 * invent new ones; failures go to stderr via `opts.warn?.(line)` and
 * continue — never crash the REPL, never block exit (the second Ctrl+C
 * only bounded-waits 1s).
 */
export async function persistChatSessionCheckpoint(opts: {
  readonly store: SessionStore;
  readonly conversationId: string;
  readonly jsonMode: boolean;
  readonly result: RunResult;
  readonly priorMessages: ReadonlyArray<AnthropicNativeMessage>;
  /** Resolved root for a new conversation bootstrap. */
  readonly workspaceRoot?: string;
  /** stderr notice on write failure / corrupted file (silent by default — observer discipline). */
  readonly warn?: (line: string) => void;
}): Promise<void> {
  const {
    store,
    conversationId,
    jsonMode,
    result,
    priorMessages,
    warn,
    workspaceRoot,
  } = opts;
  try {
    const decision = decideCheckpointPersist(result, priorMessages);
    if (decision.kind === "none") return;
    let session: SessionFileV1;
    try {
      session = await store.load(conversationId);
    } catch (err) {
      // not_found → first write: build a brand-new v3 file with the current
      // fields; parse_failed / schema_invalid → the existing file for this
      // conversationId is unusable, rebuild from current progress (an
      // unusable file must not block this turn's write).
      session = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: conversationId,
        messages: [],
        jsonMode,
        turnCount: 0,
        updatedAt: new Date().toISOString(),
        title: "",
        cwd: requireSessionWorkspaceRoot(workspaceRoot),
        sanitized_at: new Date().toISOString(),
        checkpoints: [],
        workspaceRoot: requireSessionWorkspaceRoot(workspaceRoot),
      };
    }
    const now = new Date().toISOString();
    const turnCount = session.turnCount + result.turnCount;
    const interruptReason = toInterruptReason(result.stopReason);
    // What "partial_user_only" persists: on-disk history + the real user
    // queries in this run's delta. isTurnQuery is the turn-boundary SSOT
    // (tool_result-only / drain / status messages are not queries); verbatim
    // mirror of hub.conditionalSave's like-named splice — duplicating the
    // rule would let the two entries drift on the next change. Failed
    // assistant turns never hit disk.
    const persistedMessages =
      decision.kind === "partial_user_only"
        ? [
            ...session.messages,
            ...result.messages
              .slice(priorMessages.length)
              .filter((m) => isTurnQuery(m)),
          ]
        : result.messages;
    // appendCheckpoint's delta=0 guard compares record.messagesCount
    // against session.messages.length — this must be computed **before**
    // merging post-run messages in (otherwise delta=0 is never reached and
    // the guard never fires; same ordering as hub.conditionalSave).
    const withCheckpoint =
      interruptReason === null
        ? session
        : appendCheckpoint(session, {
            turnIndex: turnCount,
            messagesCount: persistedMessages.length,
            interruptedAt: now,
            interruptReason,
            ...persistedLastUsage(result.lastUsage),
          });
    const updated: SessionFileV1 = {
      ...withCheckpoint,
      messages: persistedMessages,
      turnCount,
      updatedAt: now,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      title: extractTitle(persistedMessages),
      // #1079: same file-level usage snapshot discipline as
      // hub.conditionalSave (reopen must not regress to 0%).
      ...persistedLastUsage(result.lastUsage),
    };
    await store.save({ id: conversationId, file: updated });
  } catch (err) {
    // Failures warn only — never rethrow / never crash the REPL. Typed
    // kinds pass through verbatim for diagnosis.
    const kind = isSessionStoreErrorKind(err)
      ? `[${(err as SessionStoreError).kind}]`
      : "";
    warn?.(
      `会话检查点写入失败 ${kind}（${err instanceof Error ? err.message : String(err)}），本次进度未持久化`
    );
  }
}

/* ---------------- in-turn commit hook ---------------- */

/**
 * Chat-path in-turn commit hook: append harness-produced messages to the
 * session JSONL log immediately. The chat path has no serialize queue;
 * bare store IO as today.
 *
 * On the first commit the JSONL may not exist (new sessions don't pre-write
 * the file before run, or legacy .json-only sessions): bootstrap the file /
 * migrate first, then append. Bootstrap history source: loadable on disk
 * (legacy migration) → disk is authoritative; not loadable (brand-new
 * session) → use getPriors()' in-memory messages (history before this run).
 * Underlying store IO faults propagate as typed store errors, never
 * swallowed.
 *
 * The chat REPL is NOT a preimage-capture host (specs/code-restore.md): its
 * engine assembles no capture port, so nothing feeds a ledger and this hook
 * never stamps `codePreimage` — no preimage params by design. Subagents
 * spawned from chat still capture in their own worker process and stay
 * restorable through the hub's rewind on the same session folder.
 */
export function createChatSessionCommitHook(opts: {
  readonly store: SessionStore;
  readonly conversationId: string;
  readonly jsonMode: boolean;
  readonly getPriors: () => ReadonlyArray<AnthropicNativeMessage>;
  /** Resolved root for a new conversation bootstrap. */
  readonly workspaceRoot?: string;
}): (messages: ReadonlyArray<AnthropicNativeMessage>) => Promise<void> {
  const { store, conversationId, jsonMode, getPriors, workspaceRoot } = opts;
  return async (messages) => {
    try {
      await store.appendEvents({
        id: conversationId,
        events: [...messages],
      });
      return;
    } catch (err) {
      // Only typed store errors (JSONL missing / legacy / corrupted)
      // bootstrap; anything else rethrows.
      if (!isSessionStoreErrorKind(err)) throw err;
    }
    let base: SessionFileV1;
    let priors: ReadonlyArray<AnthropicNativeMessage>;
    try {
      base = await store.load(conversationId);
      // The disk already holds authoritative history (legacy .json
      // migration): trust the disk, not getPriors — empty priors would
      // otherwise wipe existing history.
      priors = base.messages;
    } catch {
      // Same shape as persistChatSessionCheckpoint's not_found branch: a
      // brand-new v3 file whose history comes from getPriors (in-memory
      // messages before this run).
      const now = new Date().toISOString();
      base = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: conversationId,
        messages: [],
        jsonMode,
        turnCount: 0,
        updatedAt: now,
        title: "",
        cwd: requireSessionWorkspaceRoot(workspaceRoot),
        sanitized_at: now,
        checkpoints: [],
        workspaceRoot: requireSessionWorkspaceRoot(workspaceRoot),
      };
      priors = getPriors();
    }
    await store.save({
      id: conversationId,
      file: {
        ...base,
        messages: [...priors],
        updatedAt: new Date().toISOString(),
      },
    });
    await store.appendEvents({
      id: conversationId,
      events: [...messages],
    });
  };
}

/** Kind-guard + writeErr + EXIT for store.load in auto/HITL paths.
 *  Delegates to the shared `reportGoalAutoStoreLoadErr` so chat and hub render
 *  the same `${kind}: ${conversation_id}` form on the same channel. */
function skipChatAutoOnLoadError(err: unknown, conversationId: string): void {
  if (!isSessionStoreErrorKind(err)) {
    throw err;
  }
  reportGoalAutoStoreLoadErr(err, conversationId);
}

/** Narrow a throw to SessionStoreError (typed-kind member) vs other failures. */
function isSessionStoreErrorKind(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const kind = (err as { kind?: unknown }).kind;
  return (
    kind === "write_failed" ||
    kind === "not_found" ||
    kind === "parse_failed" ||
    kind === "schema_invalid" ||
    kind === "io_error" ||
    kind === "concurrent_write"
  );
}

function resolveQuiet(optsQuiet: boolean | undefined): boolean {
  if (typeof optsQuiet === "boolean") {
    return optsQuiet;
  }
  return process.env.IKNOW_CHAT_QUIET === "1";
}

/**
 * TTY streaming final-output seam.
 *
 * Returns `{ feed, textStreamed }` (replacing the earlier bare callback),
 * used as `processChatLine`'s `onStream`:
 *   - `feed` routes harness stream events by "final answer straight to
 *     stdout / tool-progress lines to stderr":
 *     - `text_delta` → written via `opts.writeOut` as stdout's **final
 *       output** (rolling increments); on the first delta, first write
 *       `\r\x1b[K` via `opts.writeErr` to clear the `Thinking…` spinner on
 *       stderr (one-shot); also flip `textStreamed` to `true` (exposed via
 *       getter so the host can decide to emit only the status line at turn
 *       end).
 *     - Tool calls → **deferred flush**: the CLI event order is
 *       `tool_call_start {name,id}` followed only then by
 *       `tool_input_delta {id,partialJson}`, with **no input-complete
 *       event**. Drawing at start would yield a bare tool name (progress
 *       points must be visible), so stage the pending call here,
 *       accumulate the incremental JSON by id, and flush **exactly one
 *       line** when the first non-increment event for that id arrives —
 *       assembled by the shared `formatToolStatusLine`
 *       (`src/shared/tool-line.ts`, same function as TUI):
 *       `read_file · Read a.ts` / `Running 1 shell command… · ls`.
 *       Incomplete increment JSON → `summarizePartialInput` verbatim
 *       truncation, still one line, no throw (no input at all → name-only
 *       line). Does **not** flip `textStreamed` (pure prompt, carries no
 *       answer).
 *   - `textStreamed` reflects whether answer text has been streamed (to
 *     stdout).
 *
 * The answer text is emitted to stdout exactly once (no more stderr preview
 * rewrites that `formatRunHuman` would render a second time — the root
 * cause of multi-line double-printing). `textStreamed` tells the host
 * whether to skip the text part of `output` at turn end.
 *
 * Write errors are swallowed (observers must not break turns; safeTrace
 * discipline). pipe / non-TTY paths never construct this sink (zero-output-
 * change regression protection).
 */
export interface StreamPreviewSink {
  readonly feed: (event: HarnessStreamEvent) => void;
  readonly textStreamed: boolean;
}

/** Human-readable line for an in-flight tool call; single source of truth is
 *  `src/shared/tool-line.ts` (shared with the TUI). The pending input
 *  accumulator is a streaming half-product → pass `running: true`, same
 *  semantics as the TUI live line (quantities like write_file's line count,
 *  only trustworthy once the input is complete, get omitted).
 *  Partial JSON is often incomplete at the CLI (slices not yet joined) → the
 *  shared `summarizePartialInput` truncates as-is; when empty, a bare `name`
 *  line still stands. */
function formatCliToolLine(name: string, partialJson: string): string {
  const detail = summarizePartialInput(name, partialJson);
  return formatToolStatusLine({
    toolName: name,
    input: undefined,
    status: "running",
    detail,
  });
}

export function createStreamPreviewSink(opts: {
  /** Answer text → stdout final output. Interactive REPL passes `process.stdout.write`. */
  readonly writeOut: (chunk: string) => void;
  /** Spinner clearing + tool progress lines → stderr. Interactive REPL passes `process.stderr.write`. */
  readonly writeErr: (chunk: string) => void;
}): StreamPreviewSink {
  let textStreamed = false;
  // The streaming draft accumulates via stream-draft; stdout receives the
  // `masked()` deltas (secrets are redacted, never written raw).
  // `lastWrittenLen` tracks the written position so each append emits only
  // the new tail.
  // Known boundary (adjudicated): `masked()` re-masks the full accumulation
  // and keeps no tail slack — a secret fragment split across deltas (e.g.
  // `sk-` arrives first, `abc123` later) can flash raw until the pieces
  // join. Complete-key hits are masked normally.
  const streamDraft = createStreamDraft();
  let lastWrittenLen = 0;
  // Deferred-flush pending tool call. At most one at a time — the harness
  // loop is serial, so no second start can slip between a start and its
  // input deltas; if one ever does, the prior one is flushed first
  // (exactly one line per call, no lost lines).
  let pending: {
    readonly id: string;
    readonly name: string;
    json: string;
  } | null = null;
  const flushPending = (): void => {
    if (pending === null) return;
    const line = formatCliToolLine(pending.name, pending.json);
    pending = null;
    if (line.length > 0) opts.writeErr(`\n${line}\n`);
  };
  const feed = (event: HarnessStreamEvent): void => {
    try {
      if (event.type === "text_delta") {
        // Anything other than the current pending call's input delta is a
        // closing point (see above).
        flushPending();
        if (!textStreamed) {
          // Clear the `Thinking…` spinner (one-shot); no clearing after the
          // first delta.
          opts.writeErr("\r\x1b[K");
        }
        streamDraft.append(event);
        const masked = streamDraft.masked();
        const slice = masked.slice(lastWrittenLen);
        if (slice.length > 0) {
          opts.writeOut(slice);
          lastWrittenLen = masked.length;
        }
        textStreamed = true;
        return;
      }
      if (event.type === "tool_input_delta") {
        // Accumulate deltas only for the current pending call; other ids
        // (out-of-order) neither trigger a flush nor lose the current line
        // (keeps "exactly one line per call").
        if (pending !== null && pending.id === event.id) {
          pending.json += event.partialJson;
        }
        return;
      }
      // All other events (tool_call_start / thinking_delta / stop_summary /
      // …) are closing points: flush the previous item first, then handle
      // this one.
      flushPending();
      if (event.type === "tool_call_start") {
        if (!textStreamed) {
          opts.writeErr("\r\x1b[K");
        }
        // Only register the pending call, emit no line yet — its input
        // deltas have not arrived (see above).
        pending = { id: event.id, name: event.name, json: "" };
      }
    } catch {
      // Observer write failures must never affect turn delivery (stderr /
      // stdout breakage etc.).
    }
  };
  return {
    feed,
    get textStreamed() {
      return textStreamed;
    },
  };
}

/**
 * Assembles `ChatLineContext` (extracted single-responsibility from
 * `runChatSession`: the main function keeps only session lifecycle
 * orchestration, while field-by-field plumbing lives here).
 *
 * Conditional spreads (`...(x !== undefined ? {k: x} : {})`) follow existing
 * discipline: when an optional seam is absent the key must not appear, so
 * downstream `"k" in ctx` checks and byte-equal assertions hold.
 */
function assembleChatSessionContext(input: {
  readonly opts: ChatSessionOpts;
  readonly state: CliChatState;
  readonly abortController: AbortController;
  readonly checkpointStore: SessionStore;
  readonly wrappedDeps: LoopEngineDeps;
  readonly wrapChatDeps: (base: LoopEngineDeps) => LoopEngineDeps;
}): ChatLineContext {
  const { opts, state, abortController, checkpointStore, wrappedDeps } = input;
  return {
    deps: wrappedDeps,
    state,
    showThinking: opts.showThinking,
    permissionMode: opts.permissionMode,
    graphMode: opts.graphMode,
    fsMode: opts.fsMode,
    graphAssembly: opts.graphAssembly,
    ...(opts.liveGraphLedger ? { liveGraphLedger: opts.liveGraphLedger } : {}),
    abortController,
    checkpointStore,
    ...(opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
    subagentManager: opts.subagentManager,
    verifyConfig: opts.verifyConfig,
    autoMemory: opts.autoMemory,
    overlayMemoryPrefetch: opts.overlayMemoryPrefetch,
    // Isolation flag used for write-situation determination; refresh uses it
    // to enumerate the write-root situation for one-shot rebind segments.
    // Absent → defaults to false (legacy shape = writable_main, byte-equal
    // with pre-refactor behavior).
    ...(opts.isolationOn !== undefined
      ? { isolationOn: opts.isolationOn }
      : {}),
    // Verify-gate holder — absent (ask / host did not forward the built
    // handles) → key not present, chatVerifyFenceOpts produces no
    // worktreeOnMutate.
    ...(opts.worktreeOnMutate !== undefined
      ? { worktreeOnMutate: opts.worktreeOnMutate }
      : {}),
    // Loadable-skills surface — absent (ask / old tests) → slash skill names
    // fall through to unknown-command, behavior byte-identical. Mutable:
    // rebind swaps it via refreshChatDepsForRebind.
    ...(opts.skillCatalog !== undefined
      ? { skillCatalog: opts.skillCatalog }
      : {}),
    // Seam making the loadable surface "hot at once" — absent (ask / old
    // tests) → candidates stay the assembly-time snapshot, behavior
    // byte-identical.
    ...(opts.skillRescanner !== undefined
      ? { skillRescanner: opts.skillRescanner }
      : {}),
    // Rebind-detection seam — when the session file's workspaceRoot drifts
    // from engineRoot, rebuild deps with the new root (wrapping semantics
    // come from the same source as initial assembly, see wrapChatDeps).
    ...(opts.rebuildDeps
      ? {
          rebuildDeps: opts.rebuildDeps,
          engineRoot: opts.engineRoot,
          wrapRebuiltDeps: input.wrapChatDeps,
          // Box holding the live engine's shutdown handle — refresh closes
          // out the old engine at the swap point and writes the rebuilt
          // engine's shutdown into current (cli.ts's registerShutdown closure
          // reads current).
          ...(opts.engineShutdown
            ? { engineShutdown: opts.engineShutdown }
            : {}),
        }
      : {}),
  };
}

/**
 * Run a product chat session (TTY REPL or non-interactive pipe).
 */
export async function runChatSession(opts: ChatSessionOpts): Promise<void> {
  // REPL-level conversationId. `--resume <id>` anchors to the existing
  // checkpoint file's id; default (undefined) = new session with a random
  // UUID (`randomUUID` comes from the same source as cli.ts's ask entry, so
  // token shape is consistent).
  // Caller-injected conversationId (from cli.ts) wins — single source, so
  // cli.ts's subagentsDir derivation and this layer's checkpoint derivation
  // never end up with two different ids (split-brain). The default fallback
  // stays `resumeId ?? randomUUID()`, byte-stable.
  const conversationId = opts.conversationId ?? opts.resumeId ?? randomUUID();

  // REPL-level AbortController + SessionStore injected into ctx; ask/pipe
  // entries share the same ctx, and by default signal/store never reach the
  // persistence path (zero change exposed to ask).
  // Default store pool = ~/.iknow, same pool as serve/TUI; tests / ask
  // entries pass opts.deps without a store path, so persistence is skipped
  // naturally. Ordering: checkpointStore is constructed before state — the
  // resume path must load the existing file first, then seed
  // state.messages; the store/state dependency graph permits this order.
  const abortController = new AbortController();
  // The store namespace keys by projectIdentityRoot, not cwd.
  // The pool root follows `opts.dataDir` (explicit `--data-dir`, else
  // `~/.iknow`) — the same pool cli.ts runChat uses for
  // worktreeProvisioner / todoDir / tasksDir, so `iknow chat --data-dir <alt>`
  // no longer silently writes to `~/.iknow`.
  const checkpointStore = new SessionStore(
    resolveServeDataDir(opts.dataDir),
    deriveProjectIdentityRoot({ cwd: opts.workspaceRoot })
  );

  // On resume, load the initial message history (seed) from the existing
  // checkpoint file:
  //   - `opts.resumeId === undefined` → zero IO, empty messages, behavior
  //     identical to a fresh session.
  //   - load OK → messages come from the file; the first turn's
  //     processChatLine prior already sees the history, no extra wiring.
  //   - typed load failure → empty messages + one stderr warning; the
  //     conversationId anchor is still kept — later turns' checkpoints write
  //     back to the same `<id>.jsonl` instead of fragmenting into a new id.
  //     Unknown (defensive) errors rethrow as-is.
  const { messages: seeded, warn: resumeWarn } = await seedResumeMessages({
    store: opts.resumeId !== undefined ? checkpointStore : undefined,
    id: opts.resumeId,
  });
  resumeWarn?.();

  const state: CliChatState = {
    messages: Object.freeze([...seeded]),
    jsonMode: opts.jsonMode,
    session: opts.session,
    conversationId,
  };

  // Wrap the executor with the violation kill-session hook so tool results
  // get observed against the three-tier counter. When the counter
  // escalates, wireKillSessionNotification writes the stderr line and sets
  // process.exitCode = 1; the REPL then closes after the current turn
  // (kill = exit the session).
  const counter = createViolationCounter();
  const killRef: { fired: boolean } = { fired: false };
  const notify = wireKillSessionNotification({ sink: writeErr });
  const onKill = (reason: string): void => {
    killRef.fired = true;
    notify(reason);
  };
  // Deps wrapping is collapsed into one closure — initial assembly and the
  // per-root rebuild after rebind share the same wrapping semantics
  // (violation executor + conversationId + commitMessages hook), so rebuilds
  // cannot drift.
  const commitHook = createChatSessionCommitHook({
    store: checkpointStore,
    conversationId,
    jsonMode: state.jsonMode,
    getPriors: () => state.messages,
    ...(opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
  });
  const wrapChatDeps = (base: LoopEngineDeps): LoopEngineDeps => ({
    ...base,
    executor: wrapWithViolationHook({
      inner: base.executor,
      counter,
      onKill,
    }),
    // CliChatState.conversationId is string | null; LoopEngineDeps
    // .conversationId is string | undefined — collapse null via ?? undefined
    // into the undefined-default semantics (no filtering, aligned with
    // ADR-0021's backward-compat path).
    conversationId: state.conversationId ?? undefined,
    // In-turn commit — the chat path has no serialize queue, so call the
    // store directly (keeping the current bare store IO). getPriors reads
    // live state.messages (= history before this run, same semantics as the
    // hub bootstrap's session.messages; the current turn's user query is
    // still persisted by the closing checkpoint). A caller-injected
    // commitMessages takes precedence.
    commitMessages: base.commitMessages ?? commitHook,
  });
  const wrappedDeps: LoopEngineDeps = wrapChatDeps(opts.deps);
  const ctx = assembleChatSessionContext({
    opts,
    state,
    abortController,
    checkpointStore,
    wrappedDeps,
    wrapChatDeps,
  });

  const interactive = isInteractive();

  if (interactive) {
    await runInteractive({ ctx, killRef });
  } else {
    await runPiped({ ctx, quiet: resolveQuiet(opts.quiet), killRef });
  }
}

function printBanner(): void {
  writeErr("iknow chat");
  writeErr("输入问题开始对话。/help 查看命令 · /quit 或 Ctrl+D 退出");
}

async function runInteractive(opts: {
  readonly ctx: ChatLineContext;
  /** T6: set when the violation counter escalates; the REPL closes after
   *  the current turn completes (one-shot notification already emitted). */
  readonly killRef?: { fired: boolean };
}): Promise<void> {
  const { ctx, killRef } = opts;
  printBanner();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let closed = false;
  let busy = false;
  let farewellPrinted = false;
  const sayGoodbye = (): void => {
    if (farewellPrinted) {
      return;
    }
    farewellPrinted = true;
    writeErr("再见。");
  };

  let sigintCount = 0;
  /** Coalesce same-tick dual delivery (process + readline) without timed debounce. */
  let sigintCoalesce = false;
  /** First-Ctrl+C idle-branch notice — makes the "idle does not interrupt"
   *  semantics explicit, so users don't think the current turn got aborted.
   *  The busy branch's wording stays unchanged (see onSigint). */
  const printIdleCtrlCNotice = (): void => {
    writeErr("\n当前无运行中的 turn（Ctrl+C 空闲时不打断）；/quit 退出");
  };
  const onSigint = (): void => {
    if (sigintCoalesce) {
      return;
    }
    sigintCoalesce = true;
    queueMicrotask(() => {
      sigintCoalesce = false;
    });

    sigintCount += 1;
    if (sigintCount === 1) {
      // When busy, the first Ctrl+C interrupts the in-flight turn.
      // controller.signal is passed through processChatLine into run();
      // signal.abort → run resolves with stopReason "cancelled" → the
      // post-run path persists the checkpoint (recoverable). When idle, do
      // not abort (avoid polluting the next turn), just redraw the prompt.
      if (busy) {
        writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
        ctx.abortController?.abort();
      } else if (!closed) {
        printIdleCtrlCNotice();
        rl.prompt(true);
      } else {
        // closed fallback: still show the exit path (matches the pre-change
        // "unconditional print").
        writeErr("\n再次 Ctrl+C 退出，或输入 /quit");
      }
      return;
    }
    // Second SIGINT: leave immediately even if a turn is mid-flight.
    farewellPrinted = true;
    writeErr("\n退出。");
    closed = true;
    process.off("SIGINT", onSigint);
    rl.removeListener("SIGINT", onSigint);
    try {
      rl.close();
    } catch {
      // EXIT: interface may already be closed
    }
    // Wait at most 1s for the in-flight turn (including the
    // persistChatSessionCheckpoint already awaited inside processChatLine)
    // to finish, then process.exit(130). Never block on the exit hook (save
    // failures are handled warn+continue inside persist). The 1s cap forces
    // exit even if the turn is stuck, so the REPL never hangs.
    void Promise.race([
      chain.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ]).then(() => process.exit(130));
  };
  // Node may deliver Ctrl+C to process and/or readline depending on platform.
  process.on("SIGINT", onSigint);
  rl.on("SIGINT", onSigint);

  const prompt = (): void => {
    if (closed) {
      return;
    }
    sigintCount = 0;
    rl.setPrompt("iknow> ");
    rl.prompt();
  };

  // Serialize turns: never start next line / prompt until previous finishes.
  let chain: Promise<void> = Promise.resolve();
  let wakeController: SubagentWake | undefined;

  const handle = async (line: string): Promise<void> => {
    busy = true;
    let showThinking = false;
    // Streaming final-output sink (function-level scope, so it can be
    // assigned inside try and the catch can fall back to clearing the line).
    let preview: StreamPreviewSink | null = null;
    try {
      // Pause input so the next prompt cannot appear mid-turn.
      rl.pause();

      const looksLikeQuery =
        line.trim().length > 0 && !line.trim().startsWith("/");
      // Thinking… spinner only when stderr is a TTY (never spam pipes /
      // redirected logs). The text comes from shared/tool-line (same
      // `formatThinkingLive` function the TUI uses; the CLI does not write
      // its own literal for it).
      showThinking = looksLikeQuery && Boolean(process.stderr.isTTY);

      if (showThinking) {
        process.stderr.write(formatThinkingLive());
      }

      // Streaming final output (only when stderr is a TTY; same gate as the
      // Thinking… spinner). Answer text goes straight to stdout via feed as
      // the final output; the first delta clears the spinner automatically.
      // textStreamed drives the turn-end branch below.
      if (showThinking) {
        preview = createStreamPreviewSink({
          writeOut: (chunk) => process.stdout.write(chunk),
          writeErr: (chunk) => process.stderr.write(chunk),
        });
      }
      const onStream = preview ? preview.feed : undefined;

      let result: ProcessChatLineResult;
      try {
        result = await processChatLine({ line, ctx, onStream });
      } catch (err) {
        if (preview) {
          clearErrLine();
        }
        writeErr(formatChatError(err));
        if (killRef?.fired === true) {
          closed = true;
          rl.close();
          return;
        }
        if (!closed) {
          prompt();
          rl.resume();
        }
        return;
      }

      if (preview) {
        // The sink manages spinner clearing itself (on the first delta);
        // this is the fallback for turns with no delta (empty response /
        // error etc.). Once is enough.
        clearErrLine();
      }

      if (result.stderr) {
        writeErr(result.stderr);
      }
      if (result.output) {
        // Already streamed → the answer text is on stdout; only add the
        // status line + separator (avoid double-printing). Not streamed
        // (preview=null OR preview but no text_delta → empty response /
        // non-streaming arm) → write `result.output` whole, keeping pipe /
        // non-TTY / ask unchanged.
        if (preview?.textStreamed && result.statusLine !== undefined) {
          writeOut(result.statusLine);
          writeOut(TTY_ANSWER_SEP);
        } else {
          writeOut(result.output);
          // Separator after agent answers only (TTY path).
          if (result.ranQuery) {
            writeOut(TTY_ANSWER_SEP);
          } else {
            writeOut("");
          }
        }
      }

      if (result.quit) {
        closed = true;
        rl.close();
        return;
      }

      // Violation escalation fired mid-turn → kill the session after this
      // turn completes (notification already written by onKill).
      if (killRef?.fired === true) {
        closed = true;
        rl.close();
        return;
      }

      // Prompt only after the full turn is done.
      if (!closed) {
        prompt();
        rl.resume();
      }
    } catch (err) {
      // EXIT: protect chain from rejections before/around processChatLine
      if (preview) {
        clearErrLine();
      }
      writeErr(formatChatError(err));
      if (!closed) {
        try {
          prompt();
          rl.resume();
        } catch {
          // EXIT: readline may already be closed
        }
      }
    } finally {
      busy = false;
      wakeController?.flush();
    }
  };

  const createWakeController = (): SubagentWake =>
    createSubagentWake({
      manager: ctx.subagentManager,
      isIdle: () => !busy && !closed,
      wake: async () => {
        busy = true;
        try {
          const wakeRun = chain.then(async () => {
            const result = await runChatSubagentWake({ ctx });
            if (result.stderr) writeErr(result.stderr);
            if (result.output) {
              writeOut(result.output);
              if (result.ranQuery) writeOut(TTY_ANSWER_SEP);
            }
          });
          chain = wakeRun.catch((error: unknown) => {
            const wakeError = toSubagentWakeError(error, {
              reason: "wakeFailed",
              taskIds: queryableSubagentTaskIds(ctx.subagentManager),
              queryable: ctx.subagentManager !== undefined,
            });
            writeErr(formatChatError(wakeError));
            // EXIT: keep the serialized wake chain usable after reporting this
            // undelivered wake; never turn the failure into a success summary.
          });
          await chain;
        } finally {
          busy = false;
        }
      },
      onError: (error) => writeErr(formatChatError(error)),
    });

  ctx.onSubagentManagerRebound = () => {
    wakeController?.dispose();
    wakeController = createWakeController();
  };
  wakeController = createWakeController();

  // Shift+Tab flips the permission mode (default ↔ full_auto; plan is only
  // reachable via `/permissions plan`, never through the cycle). The REPL
  // uses readline: with terminal:true stdin already emits keypress, where
  // shift+tab = key.name==="tab" && key.shift.
  //
  // While busy (turn in-flight) readline's `rl.pause()` suspends stdin, so
  // keypress never arrives — Shift+Tab only takes effect while idle (prompt
  // awaiting input). Busy-time mode switching is reachable only through the
  // TUI entry (ink useInput bypasses readline, unaffected by pause). This
  // is a known boundary, recorded honestly here.
  //
  // The `!key.ctrl && !key.meta` guard avoids misfires (Ctrl+Tab / Meta+Tab
  // each have their own use). Guard + flip side effects go through the
  // shared helper `applyShiftTabAgentModeFlip` (modes.ts; the TUI uses it
  // too) to avoid a second implementation.
  //
  // The handler is captured in a named constant so rl.close can off it
  // (nothing accumulates).
  const keypressHandler = (
    _ch: unknown,
    key?: { name?: string; shift?: boolean; ctrl?: boolean; meta?: boolean }
  ): void => {
    if (closed) return;
    // ADR-0030: three-state cycle Default → Auto → Graph → Default. When
    // the graph holder is absent it degrades to the existing single-axis
    // permission cycle (zero behavior change).
    applyShiftTabAgentModeFlip({
      key,
      permission: opts.ctx.permissionMode,
      graph: opts.ctx.graphMode,
      onFlip: (next) => {
        writeErr(`\n模式: ${agentModeLabel(next)}`);
        rl.prompt(true);
      },
    });
  };
  process.stdin.on("keypress", keypressHandler);

  await new Promise<void>((resolve) => {
    rl.on("line", (line) => {
      if (closed) {
        return;
      }
      chain = chain
        .then(() => handle(line))
        .catch((err) => {
          // EXIT: last-resort so unhandled rejections never kill the process
          writeErr(formatChatError(err));
          busy = false;
          if (!closed) {
            try {
              prompt();
              rl.resume();
            } catch {
              // EXIT: readline closed
            }
          }
        });
    });
    rl.on("close", () => {
      wakeController?.dispose();
      process.off("SIGINT", onSigint);
      rl.removeListener("SIGINT", onSigint);
      // Unregister the Shift+Tab keypress listener; same place as SIGINT
      // cleanup (nothing accumulates).
      process.stdin.off("keypress", keypressHandler);
      // Normal /quit or EOF: wait for in-flight turn then farewell.
      // Forced second Ctrl+C uses process.exit(130) and never reaches here.
      void chain.finally(() => {
        sayGoodbye();
        resolve();
      });
    });
    prompt();
  });
}

async function runPiped(opts: {
  readonly ctx: ChatLineContext;
  readonly quiet: boolean;
  /** Violation escalation closes the pipe loop after the current turn. */
  readonly killRef?: { fired: boolean };
}): Promise<void> {
  const { ctx, quiet, killRef } = opts;
  // Do not force terminal:true — avoids prompt garble on pipes.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
    crlfDelay: Infinity,
  });

  let turn = 0;
  for await (const line of rl) {
    // Empty lines: skip (no turn marker, no agent call).
    if (line.trim().length === 0) {
      continue;
    }

    turn += 1;
    if (!quiet) {
      writeErr(`── turn ${turn} ──`);
    }

    // Never print the Thinking… spinner on pipe (quiet product / script
    // friendly).
    const result = await processChatLine({ line, ctx });

    if (result.stderr) {
      writeErr(result.stderr);
    }
    if (result.output) {
      writeOut(result.output);
      writeOut("");
    }
    if (result.quit) {
      break;
    }
    // Violation escalation fired mid-turn → stop reading further lines.
    if (killRef?.fired === true) {
      break;
    }
  }
}
