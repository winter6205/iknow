/**
 * SubAgentManager: parent-side subagent lifecycle / state machine / condensed
 * buffer / shutdown chain.
 *
 * Structurally mirrors the mcp/manager.ts blueprint (abort in-flight + SIGTERM
 * + SIGKILL backstop). DI boundary: the manager itself does not import
 * child_process at runtime; the spawn factory is injected by the caller,
 * avoiding a runtime coupling of child-process types with worker.ts. The
 * production spawn implementation defaultSubAgentSpawn lives in ./spawn.ts and
 * is injected by build-engine at wiring time.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  attachParentVisibleTmp,
  shouldAttachProductRoster,
  parseParentEnvelope,
  truncateEnvelopeResult,
  FINAL_TEXT_PAD_NAME,
  SUMMARY_LIMIT,
} from "./envelope.js";
import type {
  SkillIndexSnapshotEntry,
  SubAgentEnvelope,
  SubagentFailureReason,
  WorkerEnvelope,
} from "./envelope.js";
import type { SubAgentDefinition } from "./role.js";
import { createSubAgentMailbox } from "./mailbox.js";
import type { SubAgentTerminalSubscriber } from "./mailbox.js";
import { SubAgentSandboxRootError } from "../errors.js";
import type {
  TraceService,
  TraceError,
  SubagentStopRecord,
  SubagentStateChangeRecord,
  SubagentState,
} from "../trace/index.js";
import { safeTrace } from "../trace/safe-trace.js";
import { createJsonlTraceService } from "../trace/jsonl.js";
import { DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS } from "../../config/settings.js";
import { createOutputMask, currentSecretValues } from "../sandbox/index.js";
import { writeSituation } from "../isolation/write-situation.js";
import { sanitizeConversationSegment } from "../session-roots.js";
import { SUBAGENT_TRACE_DIR_NAME } from "../../shared/session-tree-names.js";
import {
  ensureWorkerSessionLayout,
  workerFenceTmpPath,
  workerMetaPath,
  workerStderrPath,
  workerTranscriptPath,
} from "../sandbox/fence-tmp.js";
import { inspectWorkerPad, listPadTopLevelNames } from "./pad-inspect.js";
import type { PadQueryResult } from "./pad-inspect.js";

export type { PadQueryResult } from "./pad-inspect.js";

// re-export: manager callers (tools, host-drain) uniformly take
// SubAgentDefinition from the manager side instead of importing role.js themselves.
export type { SubAgentDefinition } from "./role.js";

export type QueryBufferResult =
  | { status: "not_found" }
  | { status: "running" }
  | SubAgentEnvelope // completed
  | {
      status: "failed";
      // ADR-0111: the reason vocabulary reuses the envelope SSOT by name.
      reason: SubagentFailureReason;
      summary: string;
    };

/**
 * Minimal state surface for the Session API read-only projection.
 * Field set aligns with trace SubagentSpawnRecord, but truncation differs:
 * taskPreview is cut at ≤120 (a permission line — full task text never
 * leaves here). Postel: endedAt/summary/reason are present only in terminal
 * states with values; absent while running.
 */
export interface SubagentInfo {
  readonly taskId: string;
  readonly state: "starting" | "running" | "completed" | "failed";
  readonly taskPreview: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly summary?: string;
  readonly reason?: string;
  /** catalog persona id (`explore` / `general-purpose`); absent when unset. */
  readonly role?: string;
  /**
   * The tool_use id of the `spawn_subagent` call that dispatched this
   * subagent — the session card joins live rows back to the dispatch card
   * through it.
   * Optional: ask / direct-handler / test-injected spawns carry no such key,
   * and absence means the whole field is absent (Postel) — absent ≠ undefined.
   */
  readonly toolUseId?: string;
  /** Owning session (`def.conversationId`); absent for direct manager calls / judge and other session-less contexts. */
  readonly conversationId?: string;
  /**
   * Foreground flag — **equivalent to** `def.excludeFromHostDrain === true`,
   * i.e. parent-side in-band waiting (`wait:true` spawn_subagent) shares the
   * same population as judge / graph-node: the envelope was already taken by
   * the caller as a hop. Foreground interrupt (Ctrl+C fanning out all
   * foreground subagents of this session) selects targets by this field, so
   * it **must not** recompute "is running" here — the semantics are the
   * delivery channel, not the lifetime.
   * Postel: only true is present; background / unknown absent (consumers must check `=== true`).
   */
  readonly foreground?: boolean;
}

export interface SubAgentManager {
  /**
   * Synchronously enters the map and returns a taskId immediately (the
   * manager's internal randomUUID() is the single source of truth). When
   * running+starting count ≥ MAX_CONCURRENT_WORKERS, throws
   * SubAgentCapacityError immediately (the handler catches it and throws ToolExecutionError).
   */
  readonly spawn: (def: SubAgentDefinition) => { readonly taskId: string };
  /** Synchronous non-blocking four-state query. */
  readonly queryBuffer: (taskId: string) => QueryBufferResult;
  /**
   * Sync list/read of this worker's fence-tmp pad. Unknown id →
   * `not_found` (same discriminant as queryBuffer). Optional on the
   * interface so poll-only fakes stay structural.
   */
  readonly queryPad?: (taskId: string, tmpPath?: string) => PadQueryResult;
  /**
   * The third param `signal?: AbortSignal` — caller abort → rejects
   * SubAgentAbortError (typed apart from SubAgentWaitTimeoutError). The
   * first-query terminal path is preserved (immediate resolve, no interval).
   * timeoutMs defaults through the three-tier chain
   * (def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS).
   */
  readonly waitFor: (
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ) => Promise<SubAgentEnvelope>;
  /** abort in-flight + SIGTERM descendants + ≥5s backstop SIGKILL. */
  readonly shutdown: () => Promise<void>;
  /** Minimal read-only enumeration needed by host-drain: terminal tasks currently in the buffer. */
  readonly drainCompleted: (conversationId?: string) => ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }>;
  /**
   * Non-terminal task IDs (starting + running) for host-drain's blocking
   * polling. completed / failed never appear; host drain uses this to
   * distinguish "no tasks → empty" from "only running → poll".
   */
  readonly listActive: () => ReadonlyArray<string>;
  /**
   * Actively abort a single task → first settle this task's in-flight
   * `waitFor` with SubAgentAbortError (operator force-kill attribution),
   * then propagate task.abortCtrl.abort + child.SIGTERM + 5s SIGKILL backstop
   * (re-armed from this SIGTERM as the baseline). No-op for unknown or
   * already-terminal tasks.
   */
  readonly abortTask: (taskId: string) => boolean;
  /**
   * Resume a dead worker — new process, same external `task_id` handle. All
   *
   // (ADR-0102)
   * gates are decided inside the manager (the tool only maps typed kind →
   * ToolExecutionError, never recomputing lifetime at the tool side):
   * unknown id → `not_found`; starting/running → `running` (never feed words
   * into an in-flight loop); missing worker transcript (including legacy
   * locations without an assembly dir) → `no_transcript`, **never backfilled
   * from the per-agent trace**. Concurrency cap shares its source with spawn
   * (over the limit still throws SubAgentCapacityError).
   * `def` carries only this call's turn fields (next task sentence /
   * parentTurnId / toolUseId / foreground-exclusion bit); identity and
   * capability fields (role / model / maxTurns / sandboxRoot /
   * disallowedTools …) are taken from the original def — rerun() the original
   * catalog role.
   * Optional on the interface so poll-only fakes stay structural.
   */
  readonly resumeTask?: (
    taskId: string,
    def: SubAgentDefinition
  ) => { readonly taskId: string };
  /**
   * Read-only full enumeration (starting/running/completed/failed together) —
   * consumed by Session API GET /sessions/:id/subagents. Data source =
   * in-memory map + terminal envelopes (the same truth as
   * queryBuffer/drainCompleted); no task-lifetime decisions at the endpoint
   * side. taskPreview truncation ≤120: see the SubagentInfo comment.
   */
  readonly listSubagents: (
    conversationId?: string
  ) => ReadonlyArray<SubagentInfo>;
  /**
   * T3: notify the host when a terminal result is available. The notification
   * contains only immutable handoff facts; the manager buffer remains intact.
   */
  readonly subscribe: (
    subscriber: SubAgentTerminalSubscriber,
    conversationId?: string
  ) => () => void;
  /**
   * Current concurrency cap (`number` or `"unlimited"`) — the single SSOT
   *
   // (ADR-0096)
   * point for the spawn gate. The spawn_subagent tool description derives
   * from the same place, guaranteeing N and the error receipt carry the same
   * number. After TUI /config panel Enter calls holder.set, get reflects the
   * new value immediately.
   */
  readonly getCapacity: () => SubagentCapacityValue;
}

/** Spawn DI factory signature: injected by the caller (test fakes / production defaultSubAgentSpawn). */
export type SubAgentSpawn = (
  def: SubAgentDefinition,
  taskId: string,
  stdinPayload: WorkerEnvelope
) => ChildProcess;

/** Typed rejection reasons for waitFor timeout / shutdown collection (status/reason constants passed through to the caller). */
export class SubAgentWaitTimeoutError extends Error {
  override readonly name = "SubAgentWaitTimeoutError";
  readonly status = "failed" as const;
  readonly reason = "timeout" as const;
}

/**
 * Typed rejection for resumeTask. `kind` is a discriminated union; the
 *
 // (ADR-0102)
 * consumer (subagent_continue handler) maps kind to model-visible text, and
 * `err instanceof Error ? err.message : …` semantic loss is forbidden.
 */
export class SubAgentResumeError extends Error {
  override readonly name = "SubAgentResumeError";
  readonly kind: "not_found" | "running" | "no_transcript" | "missing_task";
  readonly taskId: string;
  constructor(taskId: string, kind: SubAgentResumeError["kind"]) {
    super(`subagent resume refused: ${kind} (task ${taskId})`);
    this.taskId = taskId;
    this.kind = kind;
  }
}

/**
 * Default concurrent-worker cap on the parent side. At the spawn entry, when
 * running+starting count ≥ this value, throw SubAgentCapacityError
 * immediately (explicit failure so the model can lower concurrency and retry;
 * no queueing, no silence).
 */
export const MAX_CONCURRENT_WORKERS = DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS;

/**
 * Value range of the subagent concurrency cap. `number` = gate value
 *
 // (ADR-0096)
 * (active+starting ≥ it throws `SubAgentCapacityError`); `"unlimited"` = no
 * concurrency rejection (OS / memory remain the factual caps).
 *
 * The holder's `get()` is re-read on every spawn-gate pass inside
 * `createSubAgentManager`; both the subagent tool description and the
 * `SubAgentCapacityError.maxConcurrentWorkers` receipt derive from that same
 *
 // (ADR-0096)
 * place, so "description N and error receipt the same number" holds directly.
 */
export type SubagentCapacityValue = number | "unlimited";

/**
 * Runtime concurrency-cap holder (mirrors `FsModeContext` /
 *
 // (ADR-0096)
 * `PermissionModeContext` / `GraphModeContext` — three entries, one source).
 * `set` falls back through `coerceSubagentCapacityValue`: only positive
 * integers / `"unlimited"` take effect, anything else is ignored, keeping the
 * holder's current state (fail-closed, same discipline as fs-mode.ts).
 *
 * Assembly-time initial value = `env.subagent.maxConcurrentWorkers` (the
 * env > settings > 15 chain is already pinned in env.ts); the TUI /config
 * panel Enter loops `set(...)` within the closed set `3|5|9|15|unlimited`,
 * and the manager applies the new gate immediately.
 */
export interface SubagentCapacityHolder {
  readonly get: () => SubagentCapacityValue;
  readonly set: (value: SubagentCapacityValue) => void;
}

/**
 * Assembly-time fallback (mirrors `parseFsModeFlag`'s "valid literal first /
 * invalid falls back to default"): only positive integers or the literal
 * `"unlimited"` are accepted, everything else falls back to
 * `DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS`. Callers (the env chain) almost
 * never pass invalid values; this function is the last fail-back at assembly
 * time (note: unlike the holder's set — set validates strictly with
 * `isValidSubagentCapacityValue` and skips invalid values, never snapping the
 * holder back to the default).
 */
export function coerceSubagentCapacityValue(
  value: unknown
): SubagentCapacityValue {
  if (value === "unlimited") return "unlimited";
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 1
  ) {
    return value;
  }
  return DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS;
}

export function createSubagentCapacityHolder(
  initial: SubagentCapacityValue = DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS
): SubagentCapacityHolder {
  const starting = coerceSubagentCapacityValue(initial);
  let current: SubagentCapacityValue = starting;
  /** Strict valid gate value: positive integer or the literal `"unlimited"`. Invalid returns false (differs from `coerceSubagentCapacityValue`: the latter falls back to the default). */
  function isValidSubagentCapacityValue(
    v: unknown
  ): v is SubagentCapacityValue {
    return (
      v === "unlimited" ||
      (typeof v === "number" && Number.isInteger(v) && v >= 1)
    );
  }

  return Object.freeze({
    get: () => current,
    set: (value: SubagentCapacityValue) => {
      // fail-closed: same discipline as fs-mode.ts. Running
      // `coerceSubagentCapacityValue` here would snap invalid literals back to
      // the default, letting set(0)-style calls silently reset the holder; so
      // this uses strict validation instead — invalid → skip, holder keeps its
      // current state. The spawn gate thus never receives an invalid value
      // from a bad set (the hard gate of the typed-error contract).
      if (isValidSubagentCapacityValue(value)) current = value;
    },
  });
}

/** Internal helper: when the gate value is a `number`, validate the running+starting count, else throw a typed rejection.
 *  Extracted from `spawn()` to keep complexity in check (nested for/if no longer count toward spawn's branches). */
function assertCapacityAvailable(
  cap: number,
  tasks: ReadonlyMap<string, Task>
): void {
  let activeCount = 0;
  for (const t of tasks.values()) {
    if (t.state === "starting" || t.state === "running") activeCount++;
  }
  if (activeCount >= cap) {
    throw new SubAgentCapacityError(activeCount, cap);
  }
}

/**
 * Typed rejection for spawn over the concurrency cap. Fields
 * `{ status:"failed", reason:"capacity", active }` pass through. The message
 * carries capacity + active/limit (the handler uses it as ToolExecutionError text).
 */
export class SubAgentCapacityError extends Error {
  override readonly name = "SubAgentCapacityError";
  readonly status = "failed" as const;
  readonly reason = "capacity" as const;
  readonly active: number;
  readonly maxConcurrentWorkers: number;
  constructor(active: number, maxConcurrentWorkers = MAX_CONCURRENT_WORKERS) {
    super(
      `spawn_subagent: at capacity (${active}/${maxConcurrentWorkers} concurrent workers). Requeue after a worker completes or reduce parallelism.`
    );
    this.active = active;
    this.maxConcurrentWorkers = maxConcurrentWorkers;
  }
}

/**
 * waitFor receives an AbortSignal abort → typed rejection (typed apart from
 * SubAgentWaitTimeoutError). Fields `{ status:"failed", reason:"aborted", taskId }`.
 * The handler catches it and throws ToolExecutionError; the executor, seeing
 * `signal.aborted === true`, normalizes to `execution_failed:cancelled`
 * (attribution = caller-side cancellation).
 */
export class SubAgentAbortError extends Error {
  override readonly name = "SubAgentAbortError";
  readonly status = "failed" as const;
  readonly reason = "aborted" as const;
  readonly taskId: string;
  constructor(taskId: string) {
    super(`waitFor aborted for task ${taskId}`);
    this.taskId = taskId;
  }
}

/**
 * Per-task default wallclock 7200s (2h): real operator usage data shows
 * subagent tasks routinely exceed 1 hour, so align with deer-flow's 1800s and
 * leave headroom; the original 300s had no measurement backing.
 * The wait:true handler passes this explicitly to waitFor; the per-task
 * SIGTERM timer inside manager spawn also uses this chain's end constant as
 * its default, aligning the worker-side wallclock with foreground wait.
 * Single declaration point (the per-task default belongs to the manager
 * consumer, avoiding two-place drift).
 */
export const PER_TASK_TIMEOUT_MS = 7_200_000;

/**
 * Three-tier per-task wallclock default chain:
 * `def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`.
 * Semantic separation: this is the task lifetime (parent manager SIGTERM),
 * unrelated to the in-worker per-call race (deps.timeoutMs); the single
 * constant declaration point keeps the default from drifting.
 */
export function effectiveTaskTimeoutMs(
  def: SubAgentDefinition,
  opts: { readonly taskTimeoutMs?: number }
): number {
  return def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS;
}

/**
 * taskPreview SSOT — unified length + source.
 * Takes only `def.task` (never falls back to def.systemPrompt), truncated ≤120
 * chars (default). Two consumer surfaces share one truth:
 *   - `recordSubagentSpawn`'s subagent_spawn persisted taskPreview
 *   - `listSubagents`' HTTP/API projection taskPreview
 * 120 is the least-privilege boundary decided for the permission line (full
 * task text never persists / goes upstream); the trace side has no reason to
 * write more, and including systemPrompt would widen the masking surface.
 * The max param allows explicit override (no caller currently passes a
 * smaller value <120; the param is kept against future drift).
 */
export function truncateTaskPreview(
  def: SubAgentDefinition,
  max?: number
): string {
  return def.task?.slice(0, max ?? 120) ?? "";
}

/**
 * `def.parentTurnId` → `parentTurnId` on the three lifecycle record kinds.
 *
 * Expanded at one point instead of repeating the ternary at four trace sites:
 * drift in any one punctures that turn's reverse trace (present on spawn but
 * not stop = `?parent_turn_id=` retrieves only half the story).
 * Postel (ADR-0003): when the dispatcher gives no attribution turn the whole
 * key is absent — never null / empty string.
 */
function parentTurnFields(def: SubAgentDefinition): {
  readonly parentTurnId?: string;
} {
  return def.parentTurnId !== undefined
    ? { parentTurnId: def.parentTurnId }
    : {};
}

/**
 * Postel increments for the projection: owning session + foreground flag (see
 * the two SubagentInfo field comments). Expanded at one point instead of
 * inlining into listSubagents' field literals — every optional field added
 * would grow a branch in the projection function, and the complexity
 * threshold would alarm before any semantic drift does.
 */
function ownershipInfoFields(def: SubAgentDefinition): {
  readonly conversationId?: string;
  readonly foreground?: boolean;
} {
  return {
    ...(def.conversationId !== undefined
      ? { conversationId: def.conversationId }
      : {}),
    // Foreground == parent awaits in-band == excludeFromHostDrain (same
    // population: wait:true spawn_subagent / judge / graph-node).
    // Downstream Ctrl+C fan-out selects this session's foreground subagents by it.
    ...(def.excludeFromHostDrain === true ? { foreground: true } : {}),
  };
}

type TaskState = "starting" | "running" | "completed" | "failed";

interface Task {
  readonly id: string;
  readonly def: SubAgentDefinition;
  state: TaskState;
  child?: ChildProcess;
  envelope?: SubAgentEnvelope;
  abortCtrl?: AbortController;
  /**
   * Per-task timeout handle (def.timeoutMs expiry -> SIGTERM
   * + 5s fallback SIGKILL -> reason:"timeout"). shutdown / child exit /
   * terminal state must clear it to avoid leaks or stray SIGKILL.
   */
  timeoutTimer?: NodeJS.Timeout;
  /** SIGKILL backstop timer (exit / shutdown must clear it together with timeoutTimer). */
  timeoutKillFallback?: NodeJS.Timeout;
  /** startedAt ISO stamp (the source for persisted subagent_spawn).
   *  Created at Task construction; later spawn/stop records all reference this ISO. */
  readonly startedAt: string;
  /** stoppedEmitted guard — subagent_stop single-emit at one point
   * (exit handler and child.on("error")/timeout-fired and other paths can all trigger the terminal state);
   * once set, never overwritten, avoiding duplicate persistence. */
  stoppedEmitted: boolean;
  /**
   * Terminal-state ISO stamp (bookkeeping only, does not change state-machine
   * semantics). Latched once inside emitStop alongside stoppedEmitted;
   * listSubagents reads it as endedAt. Absent while running/starting →
   * Postel: not surfaced upward.
   */
  endedAt?: string;
  /** exit/error share one bounded stderr-drain continuation. */
  crashInFlight: boolean;
  /** Host path of this worker's fence `/tmp` pad when session layout exists. */
  padRoot?: string;
  /**
   * SettleReject references for this task's pending waitFor.
   * `abortTask` (operator force-kill) uses them to reject the task's waiters
   * **synchronously** — killing only the worker child is not enough: the
   * parent-side foreground wait carries no manager-side abort signal, so it
   * would otherwise have to wait for SIGTERM to let the worker write back a
   * failed envelope (and attribution would be mislabeled as timeout).
   * Kept separate from the global `waitRejecters` (shutdown's blanket
   * rejection): these are single-task scoped.
   */
  readonly waitRejects: Set<(reason: unknown) => void>;
}

const WAIT_POLL_MS = 25;
const SHUTDOWN_SIGKILL_GRACE_MS = 5000;
const MAX_STDERR_TAIL_CHARS = SUMMARY_LIMIT;
const STDERR_DRAIN_GRACE_MS = 500;
const MAX_STDERR_DIAGNOSTICS_BYTES = 1024 * 1024;

/** Postel presence criterion: only a non-empty string is present; absent ≠ undefined.
 *  `writeMetaOnce` (persisted meta) and `listSubagents` (external projection)
 *  must use the same criterion for the same field — writing it twice and
 *  drifting in either place makes "present in meta but not in the projection"
 *  (or the reverse) a silently inconsistent field. */
function presentString(v: string | undefined): boolean {
  return typeof v === "string" && v.length > 0;
}

function waitForStderrClose(stderr: ChildProcess["stderr"]): Promise<void> {
  if (!stderr || stderr.readableEnded || stderr.destroyed) {
    return Promise.resolve();
  }
  return new Promise<void>((resolvePromise) => {
    const finish = (): void => {
      stderr.removeListener("end", finish);
      stderr.removeListener("close", finish);
      stderr.removeListener("error", finish);
      resolvePromise();
    };
    stderr.once("end", finish);
    stderr.once("close", finish);
    stderr.once("error", finish);
  });
}

function delayMs(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}

function persistStderrDiagnostics(opts: {
  readonly diagnosticsDir: string;
  readonly taskId: string;
  readonly stderr: Buffer;
  readonly mask: ReturnType<typeof createOutputMask>;
}): { readonly path: string; readonly bytes: number } | undefined {
  const path = workerStderrPath(resolve(opts.diagnosticsDir), opts.taskId);
  const masked = opts.mask.mask(opts.stderr.toString("utf8"));
  const content = Buffer.from(masked).slice(-MAX_STDERR_DIAGNOSTICS_BYTES);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return { path, bytes: content.byteLength };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `[subagent] stderr diagnostics write skipped for ${opts.taskId}: ${detail}`
    );
    return undefined;
  }
}

function crashedSummary(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string
): string {
  const base = `worker exit code=${code} signal=${signal}`;
  return stderrTail.length === 0
    ? base
    : `${base}\nstderr tail:\n${stderrTail}`;
}

/**
 * SIGKILL backstop timer (shared by per-task timeout and abortTask).
 * With `reset=true`, first clear any existing backstop and re-arm from the
 * new baseline (abortTask scenario: the backstop baseline moves from an
 * earlier arm point to this SIGTERM point — avoiding a double-fire at the
 * timeout SIGTERM's same instant). Cleanup on child exit / shutdown /
 * terminal state lives in the exit handler / shutdown loop.
 */
function armKillFallback(task: Task, reset = false): void {
  if (task.timeoutKillFallback !== undefined) {
    if (!reset) return;
    clearTimeout(task.timeoutKillFallback);
    task.timeoutKillFallback = undefined;
  }
  const killFallback = setTimeout(() => {
    if (task.child && task.child.exitCode === null) {
      try {
        task.child.kill("SIGKILL");
      } catch {
        /* ESRCH et al. ignore */
      }
    }
  }, SHUTDOWN_SIGKILL_GRACE_MS);
  killFallback.unref?.();
  task.timeoutKillFallback = killFallback;
}

/**
 * ADR-0085: parent-session ledger anchor — worker and parent share the same
 * todos.md.
 *
 * Data source = host-injected `todoDir` (the same value as the main loop
 * registry; we do not reverse-derive from the trace file layout, avoiding
 * fragile coupling) + `conversationId` (parent session id, threaded through
 * by spawn_subagent from ctx). Missing either, or an empty-string id (an
 * empty id would be interpreted by `resolveConversationTodoPath` as the
 * legacy root ledger) → the field is not emitted, and the worker falls back
 * to the todoDir-less legacy tool surface (byte-stable).
 */
function todoLedgerAnchor(
  todoDir: string | undefined,
  conversationId: string | undefined
): { readonly todoLedger?: { projectDir: string; conversationId: string } } {
  if (
    todoDir === undefined ||
    conversationId === undefined ||
    conversationId.length === 0
  ) {
    return {};
  }
  return { todoLedger: { projectDir: todoDir, conversationId } };
}

/**
 * Parent-session model-index snapshot → envelope field (three-state folding).
 *
 *   - getter absent / returns undefined → `{}` (key omitted = worker takes
 *     its own fallback path);
 *   - returns `[]` → key present with an empty array ("the parent has no
 *     model index" is a definite fact, not absence);
 *   - returns entries → shallow copy per entry (copy at the delivery point:
 *     later parent-side pushes / rewrites never flow back into the already
 *     dispatched envelope, and the worker receives that frozen segment too).
 *
 * A throwing getter propagates as-is (never swallowed into an empty snapshot)
 * — surfacing assembly-time faults beats silently freezing a wrong table.
 */
function skillIndexSnapshotField(
  read:
    | ((
        conversationId: string | undefined
      ) => readonly SkillIndexSnapshotEntry[] | undefined)
    | undefined,
  conversationId: string | undefined
): { readonly skillIndexSnapshot?: readonly SkillIndexSnapshotEntry[] } {
  if (read === undefined) return {};
  const entries = read(conversationId);
  if (entries === undefined) return {};
  return {
    skillIndexSnapshot: entries.map((entry) => ({ ...entry })),
  };
}

/**
 * ADR-0071: per-worker disk-ledger three-key folding — taskId /
 *
 // (ADR-0102)
 * traceFilePath / transcriptPath are derived from the same `subagentsDir` in
 * one place (the directory segment for key `(parent conversationId, task_id)`
 * is already resolved by `resolveSubagentsDirForDef`). Directory absent → all
 * three keys omitted (legacy envelope byte-stable); present → lazily create
 * the `subagents/<taskId>/` layout (trace record + fence-tmp pad + worker
 * transcript path).
 *
 * A standalone module-level function rather than an inline conditional:
 * `buildWorkerPayload`'s cyclomatic complexity is a per-function ratchet (same
 * precedent as spawn-subagent-tool's foregroundDrainExclusion).
 */
function workerLedgerFields(
  subagentsDir: string | undefined,
  taskId: string
): {
  readonly taskId?: string;
  readonly traceFilePath?: string;
  readonly transcriptPath?: string;
} {
  if (subagentsDir === undefined) return {};
  const layout = ensureWorkerSessionLayout(subagentsDir, taskId);
  return {
    taskId,
    traceFilePath: layout.recordPath,
    transcriptPath: layout.transcriptPath,
  };
}

/**
 * Resume-def merge: **identity and capability fields come from the original
 *
 // (ADR-0102)
 * def** (rerun() the original catalog role, same model / maxTurns / timeoutMs
 * / sandboxRoot / disallowedTools / systemPrompt / conversationId
 * attribution); **turn and delivery-channel fields are recomputed per call**
 * (task next sentence / parentTurnId / toolUseId / foreground-exclusion bit).
 * The turn fields must be detached before re-attaching: leaving base's values
 * would mis-wire the previous turn's attribution onto this hop, and leaving
 * `excludeFromHostDrain` would lose the mailbox wake-up for a background
 * resume's terminal state. `task` is this hop's input proper: missing / empty
 * string → typed rejection (`missing_task`), never silently start on an empty
 * task — a worker with an empty task immediately returns a meaningless
 * result, which is harder to attribute than a rejection.
 */
function resumeDefinition(
  base: SubAgentDefinition,
  next: SubAgentDefinition,
  taskId: string
): SubAgentDefinition {
  const task = next.task;
  if (task === undefined || task.length === 0) {
    throw new SubAgentResumeError(taskId, "missing_task");
  }
  // rest destructuring = strongly-typed omit: detach the previous hop's turn
  // attribution fields, then re-attach per this call.
  const {
    parentTurnId: _baseTurnId,
    toolUseId: _baseToolUseId,
    excludeFromHostDrain: _baseDrain,
    ...identity
  } = base;
  return {
    ...identity,
    task,
    ...(next.parentTurnId !== undefined
      ? { parentTurnId: next.parentTurnId }
      : {}),
    ...(next.toolUseId !== undefined ? { toolUseId: next.toolUseId } : {}),
    ...(next.excludeFromHostDrain === true
      ? { excludeFromHostDrain: true }
      : {}),
  };
}

export function createSubAgentManager(opts: {
  readonly spawn: SubAgentSpawn;
  /**
   * Parent sandboxRoot — the parent agent's "work domain". `buildWorkerPayload`
   * validates in one place that `def.sandboxRoot` must be prefix-of-parent
   * (preventing arbitrary-path escalation). Default = process.cwd()
   * (manager-direct construction scenarios, e.g. the existing manager.test.ts
   * makeHarness); production assembly injects the main agent's sandboxRoot via
   * build-engine. The manager itself does not resolve opts.sandboxRoot — it is
   * realpath'd once inside buildWorkerPayload and then frozen, and the
   * worker's fs tools reuse the same resolved value.
   */
  readonly sandboxRoot?: string;
  /**
   * Optional live cell getter — `buildWorkerPayload` reads the live root once
   * at entry as the parent sandbox bound. When the parent rebinds, manager's
   * prefix-of-parent validation of def.sandboxRoot migrates with it: a def
   * inside the old root is now outside the new one and gets typed-rejected,
   * never misjudged as a legitimate child of the new root.
   *
   * Mutually exclusive with `sandboxRoot`: when present it takes priority
   * (the getter is re-read on every spawn). Absent → use `sandboxRoot`'s
   * frozen value (existing behavior, byte-for-byte unchanged).
   */
  readonly sandboxRootCell?: () => string;
  /**
   * Optional TraceService — the three subagent lifecycle event kinds
   * (subagent_spawn / subagent_state_change / subagent_stop) persist to disk.
   * When injected, emit through safeTrace wrapping; when not injected, zero
   * side effects (byte-stable with existing behavior).
   */
  readonly trace?: TraceService;
  /**
   * Crash diagnostics root. When present, stderr is masked and persisted at
   * `<diagnosticsDir>/<taskId>/stderr.log` (same dir as record + pad) with a
   * 1 MiB cap. Leftover `<diagnosticsDir>/stderr/<taskId>.log` is not migrated.
   */
  readonly diagnosticsDir?: string;
  /**
   * Per-task default wallclock (ms) — middle of the consumption chain:
   * `def.timeoutMs ?? opts.taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`.
   * Assembly threads it from build-engine's env.subagent.taskTimeoutMs
   * (settings/env merged); the env layer carries no third-tier default (the
   * constant's single declaration point is in this file).
   */
  readonly taskTimeoutMs?: number;
  /**
   * Concurrency cap. `number` only takes effect as a positive integer
   *
   // (ADR-0096)
   * (absent or invalid falls back to `MAX_CONCURRENT_WORKERS`, i.e. 15);
   * `"unlimited"` = no concurrency rejection (OS / memory remain the factual
   * caps); a `SubagentCapacityHolder` = runtime in-place flipping (assembly
   * time / TUI /config panel alike). Over the limit throws immediately, no
   * queueing.
   *
   * Priority against `subagentCapacityHolder`: when the holder is present,
   * **fully** use the holder's current value (read fresh at every spawn
   * entry); `maxConcurrentWorkers` only serves as the initial fallback when
   * the holder is absent; both absent → default 15 (byte-for-byte equal to
   * existing behavior).
   */
  readonly maxConcurrentWorkers?: SubagentCapacityValue;
  /**
   * Runtime concurrency-cap holder — same shape as `FsModeContext` /
   *
   // (ADR-0096)
   * `PermissionModeContext`. When present, the spawn gate reads
   * `holder.get()` fresh every time; TUI /config panel Enter loops
   * `holder.set(...)`, and the manager applies the new gate immediately
   * (sharing the ceiling with graph nodes: run-graph-executor's existing
   * assertions do not regress).
   */
  readonly subagentCapacityHolder?: SubagentCapacityHolder;
  /**
   * Optional worktree isolation tier (the transparency of build-engine's
   * single `isolationEnabled` read point). `buildWorkerPayload` uses it with
   * the resolved sandboxRoot at spawn time to compute `writeSituation`, then
   * threads it into the envelope — the worker prior renders its write-root
   * segment from it. Default → `false` (isolation OFF, equivalent to
   * `writable_main`), byte-equal with the pre-change state (build-engine's
   * assembly layer always passes this value; the seam exists only for
   * manager-direct scenarios like the existing manager.test.ts makeHarness
   * falling back to default behavior).
   */
  readonly isolationOn?: boolean;
  /**
   * ADR-0071: subagent per-agent trace + meta home directory =
   * `<parent session folder>/subagents/`. When present: each spawn lazily
   * creates a file-mode JsonlTraceService instance
   * (`<subagentsDir>/agent-<taskId>.jsonl`, conversationId pinned to taskId);
   * all three lifecycle record kinds for the same taskId (subagent_spawn /
   * _state_change / _stop) land in that file (written by the parent process;
   *
   // (ADR-0035)
   * the "unconditional persistence" lifecycle guarantee ensures no
   * degradation). The first spawn also writes `.meta.json` once: at least
   * `{agentType, toolUseId, spawnDepth}`, Postel — absent fields omitted.
   * Absent → NoopTraceService (same as the existing build-engine default,
   * byte-stable).
   */
  readonly subagentsDir?: string;
  /**
   * Assembly-time root — shaped `<baseDir>/projects/<slug>` (used by the
   * serve hub when it does not hold a conversationId at assembly time,
   * instead of `subagentsDir`). At spawn, if `def.conversationId` is present
   * → derive the per-conversation subdirectory
   * `<projectDir>/<sanitize(convId)>/subagents/`; if convId is absent → fall
   * back to `<projectDir>/subagents/` (project-level flat, compatible with
   * legacy manager-direct scenarios).
   *
   * Mutually exclusive priority with `subagentsDir`: when `subagentsDir` is
   * present it is used directly in the existing form; when `subagentsDir` is
   * absent but `projectDir` present → derive through this two-segment seam.
   * Same shape as `resolveConversationTodoPath` (the todo-write.ts SSOT) —
   * do not invent a new form.
   */
  readonly projectDir?: string;
  /**
   * ADR-0085: parent-session project directory (the same value as
   * `TodoWriteToolDeps.todoDir`, host-injected). Present and `def.conversationId`
   * present → `buildWorkerPayload` writes `{projectDir, conversationId}` as
   * `todoLedger` into the envelope, and the worker's assembly mounts **the
   * same** todos.md to the worker's todo_write (read / update; adds are
   * typed-rejected by the tool for the worker). Absent → field not emitted
   * (old wire form, worker tool surface without todo_write, byte-stable).
   *
   * Never reverse-derived from the trace file layout — the stored value and
   * `resolveConversationTodoPath` (todo-write.ts SSOT) use the same
   * (projectDir, conversationId) pair.
   */
  readonly todoDir?: string;
  /**
   * The parent session's complete model-index entries **as of now** (getter) =
   * the parent's frozen-table model index ∪ the parent index's arrival
   * history — see ADR-0098.
   *
   * **Re-read at every spawn** (same shape as `sandboxRootCell`; taking the
   * value at construction time is not "as of now"): once new skill names
   * arrive mid-session in the parent, the next spawn's worker snapshot
   * contains them. The return value lands in `WorkerEnvelope.skillIndexSnapshot`;
   * the worker renders its own `<available_skills>` frozen table from it, no
   * longer diffing on its own / no longer relying on the worker's own scan roots.
   *
   * **The argument is this spawn's parent-session anchor** (`def.conversationId`):
   * arrival history is a per-session leaf
   * (`<projectDir>/<sanitize(convId)>/skill-index.json`), while one subagent
   * manager is shared across sessions by build-engine (serve especially) —
   * pinning conversationId at assembly time would hand every session the same
   * history. The frozen-table-names half is session-independent and is
   * carried by the getter's implementor through `initialNames` in the seam.
   *
   * Three-state semantics (the parent's "don't know" and "definitely empty"
   * are not the same thing):
   *   - getter absent / returns `undefined` → envelope **omits the key**,
   *     worker falls back to its own independent rescan (old wire /
   *     manager-direct paths byte-for-byte unchanged);
   *   - returns `[]` → key present as an empty array, worker renders the empty
   *     manifest sentence (the parent genuinely has no model index; the
   *     worker's self-scan result must not stand in for it).
   *
   * A throwing getter propagates as-is (never swallowed into an empty
   * snapshot): surfacing assembly-time faults beats silently handing the
   * worker a wrong frozen table.
   */
  readonly skillIndexSnapshot?: (
    conversationId: string | undefined
  ) => readonly SkillIndexSnapshotEntry[] | undefined;
  /**
   * Optional override — replaces the default `createJsonlTraceService` file
   * instances with an externally injected TraceService factory (one per
   * taskId). Test / special injection only; the production path uses the file
   * mode default.
   */
  readonly traceFactory?: (
    filePath: string,
    conversationId: string
  ) => TraceService;
}): SubAgentManager {
  const tasks = new Map<string, Task>();
  /** Polling handles of all pending waitFor (non-terminal; shutdown must clear them to prevent a hanging process). */
  const waitPollers = new Set<ReturnType<typeof setInterval>>();
  /** settleReject references of pending waitFor: actively rejected at shutdown, never hanging. */
  const waitRejecters = new Set<(reason: unknown) => void>();
  const terminalMailbox = createSubAgentMailbox();
  /**
   * Per-task independently held per-agent trace instance + meta write closure.
   * When `opts.subagentsDir` is absent, degrades to NoopTraceService (same as
   * the build-engine default, byte-stable); lazily built at the spawn entry,
   * and the instance can simply be GC'd after the task ends (trace writes are
   * backed by the OS page cache / fsync, the manager holds no long-lived file
   * handles).
   */
  type PerAgentTrace = {
    readonly trace: TraceService;
    readonly filePath: string;
  };
  const perAgentTraces = new Map<string, PerAgentTrace>();
  /** subagentsDir / projectDir any present → per-agent form
   *  (null triggers NoopTraceService); both absent → fall back to the opts.trace single-instance compatibility. */
  const noopTrace: TraceService | null =
    opts.subagentsDir || opts.projectDir ? null : (opts.trace ?? null);
  /**
   * Factory default implementation: file mode JsonlTraceService, anchored at
   * `<subagentsDir>/agent-<taskId>.jsonl`, conversationId pinned to taskId.
   * Tests may inject `opts.traceFactory` to override.
   */
  const defaultTraceFactory = (
    filePath: string,
    conversationId: string
  ): TraceService =>
    createJsonlTraceService({ traceFilePath: filePath, conversationId });
  const traceFactory = opts.traceFactory ?? defaultTraceFactory;
  /** Resolve task → per-agent trace (lazy build + reuse, never a second instance per task).
   * Accepts an optional `def` — when `def.conversationId` is present, derive
   * `<projectDir>/<sanitize(convId)>/subagents/`; otherwise fall back to the
   * assembly-time root (`opts.subagentsDir` first, else `<opts.projectDir>/subagents/`). */
  function resolvePerAgentTrace(
    taskId: string,
    def?: SubAgentDefinition
  ): TraceService | null {
    if (!opts.subagentsDir && !opts.projectDir) return noopTrace;
    const cached = perAgentTraces.get(taskId);
    if (cached !== undefined) return cached.trace;
    const subagentsDir = resolveSubagentsDirForDef(def);
    if (subagentsDir === undefined) return noopTrace;
    const filePath = ensureWorkerSessionLayout(subagentsDir, taskId).recordPath;
    mkdirSync(dirname(filePath), { recursive: true });
    const traceInstance = traceFactory(filePath, taskId);
    perAgentTraces.set(taskId, { trace: traceInstance, filePath });
    return traceInstance;
  }
  /**
   * Two-segment seam derivation — given a def, derive the "actual write
   * directory".
   *   1. `opts.subagentsDir` present → use it directly (the assembly part
   *      already includes the convId segment, cli/TUI form, byte-stable);
   *   2. else `opts.projectDir` + `def.conversationId` → derive
   *      `<projectDir>/<sanitize(convId)>/subagents/` (same shape as
   *      todo-write's `resolveConversationTodoPath`);
   *   3. `projectDir` present but `def.conversationId` absent →
   *      `<projectDir>/subagents/` (project-level flat, fallback for legacy
   *      manager-direct scenarios).
   *
   * The two assembly parts `subagentsDir` / `projectDir` are mutually
   * exclusive — one manager never receives both: build-engine prefers
   * threading `subagentsDir` when the assembly part exists (cli/TUI); the
   * hub's whole chain goes through `projectDir`.
   */
  function resolveSubagentsDirForDef(
    def?: SubAgentDefinition
  ): string | undefined {
    if (opts.subagentsDir) return opts.subagentsDir;
    if (!opts.projectDir) return undefined;
    if (def?.conversationId !== undefined && def.conversationId.length > 0) {
      const segment = sanitizeConversationSegment(def.conversationId);
      return join(opts.projectDir, segment, SUBAGENT_TRACE_DIR_NAME);
    }
    return join(opts.projectDir, SUBAGENT_TRACE_DIR_NAME);
  }

  /**
   * Locked sentence 2: host-side final-text landing. Writes the terminal
   * assistant text (the `result` the host holds — already wire-folded by the
   * worker when it exceeded 20000 chars) to the worker pad's stable relative
   * path, and returns that pad-relative path for the envelope.
   *
   * Failure modes (all degrade, never throw):
   *   - no padRoot / empty-or-whitespace-only `result` → `undefined` (no file,
   *     no `output_path`; the timeout fallback envelope lands here);
   *   - pad write failure (ENOTDIR / EACCES / ENOSPC / …) → `undefined` +
   *     warn-once. A pad write is bookkeeping: it must not fail the task and
   *     must not abort the terminal path.
   *
   * The `finalTextWriteWarned` latch is load-bearing and deliberately NOT
   * shared with `writeMetaOnce` (which has no latch): this function is reached
   * from `locateEnvelope`, and one task can land an envelope **more than
   * once** — a timeout fallback (below, `timeoutTimer`) is documented to be
   * replaced by the worker's richer SIGTERM-turn envelope when the stdout
   * handler fires, and crash / spawn-failure / clean-exit-without-envelope
   * are separate terminal paths on the same task. Every such landing retries
   * the pad write, so without the latch a single broken padRoot would spam
   * one warn per landing. `writeMetaOnce` needs no latch because it has a
   * single call site (before the spawn try) plus an `existsSync` early
   * return — one warn per task is structural there, not latched.
   *
   * Truncation is NOT a failure here — a `truncated: true` envelope still
   * lands its (folded) text and keeps `status: "ok"`.
   */
  const finalTextWriteWarned = new Set<string>();
  function writeFinalTextToPad(
    task: Task,
    env: SubAgentEnvelope
  ): string | undefined {
    if (task.padRoot === undefined) return undefined;
    // Postel: empty / whitespace-only is "no final text", not an empty file.
    if (env.result.trim().length === 0) return undefined;
    try {
      mkdirSync(task.padRoot, { recursive: true });
      writeFileSync(join(task.padRoot, FINAL_TEXT_PAD_NAME), env.result);
    } catch (err) {
      // EXIT: pad writing is a best-effort delivery channel; the short handoff
      // in the envelope remains the authoritative parent-visible result.
      if (!finalTextWriteWarned.has(task.id)) {
        finalTextWriteWarned.add(task.id);
        const detail = err instanceof Error ? err.message : String(err);
        console.warn(
          `[subagent] final text pad write skipped for ${task.id}: ${detail}`
        );
      }
      return undefined;
    }
    return FINAL_TEXT_PAD_NAME;
  }

  function locateEnvelope(task: Task, env: SubAgentEnvelope): SubAgentEnvelope {
    if (task.padRoot === undefined) return env;
    // The host is the writer: an `output_path` echoed by the worker is not
    // trusted, and the stamp always names a file this call actually wrote.
    const outputPath = writeFinalTextToPad(task, env);
    const located = attachParentVisibleTmp(env, {
      task_id: task.id,
      tmp_root: task.padRoot,
      ...(outputPath !== undefined ? { output_path: outputPath } : {}),
    });
    if (!shouldAttachProductRoster(located)) return located;
    return {
      ...located,
      product_roster: listPadTopLevelNames(task.padRoot),
    };
  }
  /**
   * Per-task `.meta.json` written once — contains at least
   * `{agentType, toolUseId, spawnDepth}`, Postel: absent fields omitted.
   * `agentType` comes from `def.role` (spawn_subagent → catalog id; judge →
   * "judge"; default / unknown / old wire → field omitted).
   *
   * The landing site shares its source with `resolvePerAgentTrace` — the same
   * def derives the same directory. The assembly parts subagentsDir /
   * projectDir are mutually exclusive and share the same function.
   *
   * `spawnDepth` defaults to 1 — top-level spawn is always 1 (v1 forbids
   * nesting); an explicit `def.spawnDepth` wins (the seam is reserved for
   * future nested-dispatch scenarios). On failure, console.warn; never blocks
   * spawn.
   *
   * "Once" is **structural**, not latch-based: `writeMetaOnce` has a single
   * call site plus an `existsSync(metaPath)` early return — a task's second
   * pass never reaches the warn. By contrast, `writeFinalTextToPad` re-enters
   * with multiple envelope landings on the same task (see its header), so
   * there `finalTextWriteWarned` must latch. The differing shapes follow each
   * one's call cardinality, not an oversight.
   */
  function writeMetaOnce(taskId: string, def: SubAgentDefinition): void {
    const subagentsDir = resolveSubagentsDirForDef(def);
    if (subagentsDir === undefined) return;
    const metaPath = workerMetaPath(subagentsDir, taskId);
    ensureWorkerSessionLayout(subagentsDir, taskId);
    if (existsSync(metaPath)) return;
    const meta: Record<string, unknown> = {};
    if (typeof def.role === "string" && def.role.length > 0) {
      meta.agentType = def.role;
    }
    if (presentString(def.toolUseId)) {
      meta.toolUseId = def.toolUseId;
    }
    // v1 forbids nesting → plain spawn is always 1; an explicit def.spawnDepth wins.
    meta.spawnDepth = def.spawnDepth ?? 1;
    try {
      // The meta may be written before the lazy resolvePerAgentTrace creates
      // the subdirectory (this path skips the trace side); explicit mkdirSync
      // backstop — the mkdirSync inside resolvePerAgentTrace is idempotent
      // protection for trace writes, not a substitute for the meta backstop.
      mkdirSync(dirname(metaPath), { recursive: true });
      writeFileSync(metaPath, JSON.stringify(meta) + "\n");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`[subagent] meta write skipped for ${taskId}: ${detail}`);
    }
  }
  /**
   * Compatibility with the existing `opts.trace` injection (test seam): if a
   * manager-direct scenario passes trace but no subagentsDir, the previous
   * shape is kept — all tasks share one trace instance (aggregated writes via
   * the `subagent.jsonl` directory mode), behavior unchanged from before.
   * Once subagentsDir is explicitly passed, opts.trace stops taking effect
   * (the per-agent form wins).
   *
   * Gate-value holding = holder first; holder absent → one-shot
   *
   // (ADR-0096)
   * `maxConcurrentWorkers` (byte-for-byte equal to existing behavior, still
   * running `opts.maxConcurrentWorkers` through fail-closed validation). The
   * spawn gate reads `currentCapacity()`: the holder form re-reads every
   * time, the static form returns the opts initial value directly.
   */
  const capacityHolder: SubagentCapacityHolder =
    opts.subagentCapacityHolder ??
    createSubagentCapacityHolder(
      opts.maxConcurrentWorkers ?? DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS
    );

  /** The spawn gate reads the holder's current value (`number` or `"unlimited"`). */
  function currentCapacity(): SubagentCapacityValue {
    return capacityHolder.get();
  }

  /**
   * emitStateChange — every task.state transition point must pass through
   * here. Postel: reason is filled only when toState === "failed". This
   * function: (1) writes task.state (2) synchronously emits the
   * subagent_state_change trace record (3) never throws. safeTrace wrapping:
   * trace write failure does not block manager business. Trace is per task —
   * in the per-agent form the trace instance is taken by taskId
   * (`<subagentsDir>/agent-<taskId>.jsonl`); when opts.subagentsDir is absent
   * it falls back to the `opts.trace` compatibility form (the existing
   * aggregated single instance).
   */
  function emitStateChange(
    task: Task,
    toState: SubagentState,
    opts2?: {
      readonly reason?: SubagentStateChangeRecord["reason"];
      readonly error?: TraceError;
    }
  ): void {
    const fromState = task.state;
    // Same-state transition self-loop guard — a "same state" transition in the
    // state machine is a no-op. Typical scenario: during graceful timeout
    // collection the timer fires first and calls emitStateChange
    // (running → failed), then the worker's timeout envelope makes the stdout
    // handler call emitStateChange again (failed → failed) — the former has
    // already persisted, and writing again would produce a spurious record
    // with from_state === to_state === "failed". Skip both the state
    // assignment and the trace (emitStop's stoppedEmitted single-emit guard
    // does not cover this: state_change has no equivalent flag, it relies on
    // the prev === toState check).
    if (fromState === toState) return;
    task.state = toState;
    const taskTrace = resolvePerAgentTrace(task.id, task.def);
    if (!taskTrace) return;
    void safeTrace(() =>
      taskTrace.recordSubagentStateChange({
        id: task.id,
        taskId: task.id,
        ...parentTurnFields(task.def),
        origin: "parent",
        startedAt: task.startedAt,
        status: toState === "failed" ? "error" : "ok",
        ts: new Date().toISOString(),
        fromState,
        toState,
        ...(opts2?.reason !== undefined ? { reason: opts2.reason } : {}),
        ...(opts2?.error !== undefined ? { error: opts2.error } : {}),
      })
    );
  }

  /**
   * Postel projection terminal envelope → mailbox notice: optional fields
   * expanded conditionally, item by item. Collapsed at one point instead of
   * letting emitStop grow a chain of `...(x !== undefined ? …)` — every
   * locator field added would grow a branch in emitStop, and the complexity
   * threshold would alarm before any semantic drift (same collapse rationale
   * as ownershipInfoFields).
   */
  function terminalNoticeOf(task: Task, envelope: SubAgentEnvelope) {
    return {
      taskId: task.id,
      ...(task.def.conversationId !== undefined
        ? { conversationId: task.def.conversationId }
        : {}),
      status: envelope.status,
      summary: envelope.summary,
      result: envelope.result,
      ...(envelope.fileRefs !== undefined
        ? { fileRefs: envelope.fileRefs }
        : {}),
      ...(envelope.reason !== undefined ? { reason: envelope.reason } : {}),
      ...(envelope.stop_reason !== undefined
        ? { stop_reason: envelope.stop_reason }
        : {}),
      ...(envelope.truncated !== undefined
        ? { truncated: envelope.truncated }
        : {}),
      ...(envelope.totalLength !== undefined
        ? { totalLength: envelope.totalLength }
        : {}),
      ...(envelope.tmp_root !== undefined
        ? { tmp_root: envelope.tmp_root }
        : {}),
      ...(envelope.output_path !== undefined
        ? { output_path: envelope.output_path }
        : {}),
    };
  }

  /**
   * emitStop — persists subagent_stop at task terminal state; the
   * stoppedEmitted flag guards single-emit (exit handler + timeout-fire +
   * child.on("error") are multiple terminal-state paths); no-op if already sent.
   * Postel: default reason = envelope.reason; summary = envelope.summary (always present in failed state).
   */
  function emitStop(
    task: Task,
    finalState: "completed" | "failed",
    extras: {
      readonly exitCode?: number;
      readonly signal?: NodeJS.Signals | string;
      readonly reason?: SubagentStopRecord["reason"];
      readonly summary?: string;
      readonly error?: TraceError;
      readonly stderrPath?: string;
      readonly stderrBytes?: number;
    } = {}
  ): void {
    if (task.stoppedEmitted) return;
    task.stoppedEmitted = true;
    if (task.envelope !== undefined && task.def.excludeFromHostDrain !== true) {
      // Locked sentence 2: published after locateEnvelope, so the envelopes
      // drain/wake receives also carry output_path (the write precedes publish).
      terminalMailbox.publish(terminalNoticeOf(task, task.envelope));
    }
    const endedAt = new Date().toISOString();
    // The terminal ISO is latched once alongside single-emit (listSubagents reads it as endedAt).
    task.endedAt = endedAt;
    const durationMs = Math.max(
      0,
      Date.parse(endedAt) - Date.parse(task.startedAt)
    );
    const taskTrace = resolvePerAgentTrace(task.id, task.def);
    if (!taskTrace) return;
    void safeTrace(() =>
      taskTrace.recordSubagentStop({
        id: task.id,
        taskId: task.id,
        ...parentTurnFields(task.def),
        origin: "parent",
        startedAt: task.startedAt,
        endedAt,
        durationMs,
        finalState,
        status: finalState === "failed" ? "error" : "ok",
        ts: endedAt,
        ...(extras.exitCode !== undefined ? { exitCode: extras.exitCode } : {}),
        ...(extras.signal !== undefined ? { signal: extras.signal } : {}),
        ...(extras.reason !== undefined ? { reason: extras.reason } : {}),
        ...(extras.summary !== undefined ? { summary: extras.summary } : {}),
        ...(extras.error !== undefined ? { error: extras.error } : {}),
        ...(extras.stderrPath !== undefined
          ? { stderrPath: extras.stderrPath }
          : {}),
        ...(extras.stderrBytes !== undefined
          ? { stderrBytes: extras.stderrBytes }
          : {}),
      })
    );
  }

  async function settleCrash(opts2: {
    readonly task: Task;
    readonly stderrClosed: Promise<void>;
    readonly stderr: () => Buffer;
    readonly summary: () => string;
    readonly exitCode?: number | null;
    readonly signal?: NodeJS.Signals | null;
  }): Promise<void> {
    const { task } = opts2;
    if (task.crashInFlight || task.stoppedEmitted) return;
    task.crashInFlight = true;
    task.endedAt = new Date().toISOString();
    const mask = createOutputMask(currentSecretValues());
    await Promise.race([opts2.stderrClosed, delayMs(STDERR_DRAIN_GRACE_MS)]);
    if (task.stoppedEmitted) return;
    const summary = mask.mask(opts2.summary());
    const error: TraceError = { type: "unknown", message: summary };
    task.envelope = locateEnvelope(task, {
      status: "failed",
      reason: "crashed",
      summary,
      result: "",
    });
    emitStateChange(task, "failed", {
      reason: "crashed",
      error,
    });
    // ADR-0071: stderr / subagentDiagnosticsDir follow
    // (ADR-0035)
    // `<parent session folder>/subagents/` — an explicit diagnosticsDir is
    // absent → degrade to subagentsDir. The degradation chain also derives
    // through the projectDir two-segment seam (same-def landing site): under
    // the hub path (def.conversationId present) the stderr pointer lands in
    // the per-conversation leaf too. All three absent → no stderr pointer
    // (byte-stable with existing behavior).
    const effectiveDiagnosticsDir =
      opts.diagnosticsDir ?? resolveSubagentsDirForDef(task.def);
    const stderrDiagnostics =
      effectiveDiagnosticsDir !== undefined
        ? persistStderrDiagnostics({
            diagnosticsDir: effectiveDiagnosticsDir,
            taskId: task.id,
            stderr: opts2.stderr(),
            mask,
          })
        : undefined;
    emitStop(task, "failed", {
      reason: "crashed",
      summary,
      error,
      ...(stderrDiagnostics !== undefined
        ? {
            stderrPath: stderrDiagnostics.path,
            stderrBytes: stderrDiagnostics.bytes,
          }
        : {}),
      ...(opts2.exitCode !== undefined && opts2.exitCode !== null
        ? { exitCode: opts2.exitCode }
        : {}),
      ...(opts2.signal !== undefined && opts2.signal !== null
        ? { signal: opts2.signal }
        : {}),
    });
  }

  function spawn(def: SubAgentDefinition): { readonly taskId: string } {
    // running+starting ≥ configured cap throws SubAgentCapacityError
    // (ADR-0096)
    // immediately. Explicit failure > silent queueing (the handler catches it
    // and throws ToolExecutionError, the model lowers concurrency and retries).
    //
    // The cap value is re-read from holder.get() every time, so a TUI /config
    // panel Enter flip takes effect on the very next spawn. `"unlimited"` →
    // no concurrency rejection (OS / memory remain the factual caps) (ADR-0096), the
    // branch skips the whole counting + throw path.
    const cap = currentCapacity();
    if (cap !== "unlimited") {
      assertCapacityAvailable(cap, tasks);
    }

    // Validation must precede opts.spawn (otherwise the existing try/catch in
    // the launch path would swallow the rejection as task failed). Also not
    // after tasks.set — throwing early guarantees no map residue.
    // buildWorkerPayload validates every spawn path in one place (model tool
    // + judge + future roles); validation failure throws
    // SubAgentSandboxRootError synchronously (the handler converts it to ToolExecutionError).
    //
    // ADR-0071: buildWorkerPayload now receives taskId — only with the taskId
    // already locked by the parent-side manager can the corresponding
    // traceFilePath be computed (per-agent form:
    // `<parent session folder>/subagents/agent-<taskId>.jsonl`), written into
    // the envelope so the worker persists that path in file-mode, replacing
    // the retired fake-scope `randomUUID()`.
    return launchWorker(def, randomUUID());
  }

  /**
   * The mechanical arm of spawn: start a new worker process under a given
   *
   // (ADR-0102)
   * task_id and book it (capacity / argument validation already completed at
   * the call site before entering this function). Fresh spawn passes
   * randomUUID(); resumeTask passes **the same** task_id (external handle
   * unchanged, process is new). If meta already exists, writeMetaOnce skips
   * naturally; the per-agent trace is cached and reused by taskId, so the
   * resume's lifecycle records append to the same trace file.
   */
  function launchWorker(
    def: SubAgentDefinition,
    id: string
  ): { readonly taskId: string } {
    const payload = buildWorkerPayload(def, id);
    const startedAt = new Date().toISOString();
    const task: Task = {
      id,
      def,
      state: "starting",
      startedAt,
      stoppedEmitted: false,
      crashInFlight: false,
      waitRejects: new Set(),
    };
    const layoutDir = resolveSubagentsDirForDef(def);
    if (layoutDir !== undefined) {
      task.padRoot = workerFenceTmpPath(layoutDir, id);
    }
    tasks.set(id, task);

    let child: ChildProcess;
    // Write meta.json once (attempted on both success and failure paths) —
    // before the spawn factory call, so the failure path has meta too; the
    // production spawn factory also takes time launching the child, and meta
    // landing before that is friendlier to the observability side.
    writeMetaOnce(id, def);
    try {
      child = opts.spawn(def, id, payload);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      task.envelope = locateEnvelope(task, {
        status: "failed",
        reason: "crashed",
        summary: `subagent spawn failed: ${errMsg}`,
        result: "",
      });
      // spawn still records subagent_spawn (the failure path records the
      // attempt too); immediately followed by emitStateChange(failed) +
      // emitStop (single-emit lifecycle). Trace per taskId (per-agent form);
      // when subagentsDir is absent the opts.trace compatibility form applies.
      const taskTrace = resolvePerAgentTrace(task.id, task.def);
      if (taskTrace) {
        void safeTrace(() =>
          taskTrace.recordSubagentSpawn({
            id: task.id,
            taskId: task.id,
            ...parentTurnFields(def),
            origin: "parent",
            startedAt: task.startedAt,
            status: "error",
            ts: new Date().toISOString(),
          })
        );
      }
      emitStateChange(task, "failed", { reason: "crashed" });
      emitStop(task, "failed", {
        reason: "crashed",
        summary: `subagent spawn failed: ${errMsg}`,
      });
      return { taskId: id };
    }
    task.child = child;
    task.abortCtrl = new AbortController();
    let stderrBuf = "";
    let stderrCapture = Buffer.alloc(0);
    const stderrClosed = waitForStderrClose(child.stderr);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      // EXIT: bound retained crash diagnostics so stderr cannot grow without limit.
      if (stderrBuf.length > MAX_STDERR_TAIL_CHARS) {
        stderrBuf = stderrBuf.slice(-MAX_STDERR_TAIL_CHARS);
      }
      stderrCapture = Buffer.concat([stderrCapture, Buffer.from(chunk)]);
      if (stderrCapture.byteLength > MAX_STDERR_DIAGNOSTICS_BYTES) {
        stderrCapture = stderrCapture.slice(-MAX_STDERR_DIAGNOSTICS_BYTES);
      }
    });

    // subagent_spawn is emitted after the child launches successfully (task.state is
    // still "starting" at this point; the emitStateChange("running") below drives the
    // starting→running transition). Trace per taskId (per-agent form); if subagentsDir
    // is absent, use opts.trace compatibility.
    const taskTrace = resolvePerAgentTrace(task.id, task.def);
    if (taskTrace) {
      const taskPreviewSource = truncateTaskPreview(def, 120);
      void safeTrace(() =>
        taskTrace.recordSubagentSpawn({
          id: task.id,
          taskId: task.id,
          ...parentTurnFields(def),
          origin: "parent",
          startedAt: task.startedAt,
          status: "ok",
          ts: new Date().toISOString(),
          ...(taskPreviewSource.length > 0
            ? { taskPreview: taskPreviewSource }
            : {}),
          ...(def.model !== undefined ? { model: def.model } : {}),
          ...(def.maxTurns !== undefined ? { maxTurns: def.maxTurns } : {}),
          ...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
        })
      );
    }
    // State transition: starting → running (emitStateChange internally writes task.state + emits the record)
    emitStateChange(task, "running");

    // Per-task timeout. def.timeoutMs defaults through the three-tier chain
    // (def ?? taskTimeoutMs ?? 7200s), aligned with the foreground wait —
    // avoiding the "spawn wallclock vs waitFor wait" semantic mismatch.
    // expiry -> mark failed reason:"timeout" + SIGTERM; 5s fallback SIGKILL
    // against workers that ignore SIGTERM (the fallback is armed after the
    // timeout SIGTERM, baseline aligned to the SIGTERM point; arming at spawn
    // time was wrong — with the default 7200s timeout a worker would be
    // force-killed after 5s). timer.unref so it does not block process exit.
    const effectiveTimeoutMs = effectiveTaskTimeoutMs(def, opts);
    if (effectiveTimeoutMs > 0) {
      task.timeoutTimer = setTimeout(() => {
        // Already terminated (child exit / stdout envelope) -> do not overwrite.
        if (task.state === "completed" || task.state === "failed") return;
        // Graceful window: here we first write a generic fallback envelope and
        // SIGTERM immediately, but before the SIGKILL backstop (5s later)
        // arrives, the stdout handler's `task.envelope = env` unconditionally
        // replaces the fallback with the **richer envelope written back by the
        // child** — the {reason:"timeout", summary:<real progress>} the worker
        // emits after running its own SIGTERM epilogue summary round thus
        // becomes the parent-side final truth, not overwritten by the generic
        // "timeout after <n>ms" (emitStateChange/emitStop have already fired
        // irrevocably; timedOut is kept as reason=timeout by the exit handler's
        // guard). The SIGKILL backstop only reaches workers that ignore
        // SIGTERM (armKillFallback).
        task.envelope = locateEnvelope(task, {
          status: "failed",
          reason: "timeout",
          summary: `timeout after ${effectiveTimeoutMs}ms`,
          result: "",
        });
        emitStateChange(task, "failed", { reason: "timeout" });
        emitStop(task, "failed", {
          reason: "timeout",
          summary: `timeout after ${effectiveTimeoutMs}ms`,
        });
        if (task.child) {
          try {
            task.child.kill("SIGTERM");
          } catch {
            /* ESRCH et al. ignore */
          }
        }
        // SIGKILL backstop arms 5s from the SIGTERM baseline; when the worker
        // ignores SIGTERM it is force-killed after 5s. If abortTask arrived
        // first, reset=false here reuses directly (avoiding a double SIGKILL
        // firing). Cleaned up by the exit handler.
        armKillFallback(task);
      }, effectiveTimeoutMs);
      task.timeoutTimer.unref?.();
    }

    // Write payload (stdin JSON-line). The worker's for-await stdin only
    // starts running after EOF; end() immediately after writing, otherwise the
    // worker waits for stdin forever. Reuse the already-validated payload from
    // the single validation point to avoid side-effect risks of a second
    // buildWorkerPayload call (it is currently a pure function, but explicit
    // reuse is clearer and aligns with opts.spawn's third param).
    if (child.stdin) {
      child.stdin.write(JSON.stringify(payload) + "\n");
      child.stdin.end();
    }

    // stdout newline-JSON → parse → truncate → completed. With multiple envelopes the last one wins.
    let stdoutBuf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.trim().length === 0) continue;
        try {
          const env = locateEnvelope(
            task,
            truncateEnvelopeResult(parseParentEnvelope(line))
          );
          task.envelope = env;
          // State migration + stop event (single-emit is guarded by the
          // stoppedEmitted flag inside emitStop; repeated triggers from later
          // exit/error paths are no-ops).
          if (env.status === "ok") {
            emitStateChange(task, "completed");
            emitStop(task, "completed", { summary: env.summary });
          } else {
            emitStateChange(task, "failed", {
              reason: env.reason ?? "protocolError",
            });
            emitStop(task, "failed", {
              reason: env.reason ?? "protocolError",
              summary: env.summary,
            });
          }
        } catch (err) {
          // Envelope validation failure = protocol error.
          const errMsg = err instanceof Error ? err.message : String(err);
          task.envelope = locateEnvelope(task, {
            status: "failed",
            reason: "protocolError",
            summary: `subagent envelope protocol error: ${errMsg}`,
            result: "",
          });
          emitStateChange(task, "failed", { reason: "protocolError" });
          emitStop(task, "failed", {
            reason: "protocolError",
            summary: `subagent envelope protocol error: ${errMsg}`,
          });
        }
      }
    });

    child.on("exit", (code, signal) => {
      // child exited -> clear timeoutTimer + killFallback to
      // avoid stray SIGKILL on already-dead children.
      if (task.timeoutTimer) {
        clearTimeout(task.timeoutTimer);
        task.timeoutTimer = undefined;
      }
      if (task.timeoutKillFallback) {
        clearTimeout(task.timeoutKillFallback);
        task.timeoutKillFallback = undefined;
      }
      // Non-zero exit code / killed by signal -> crashed, overwriting the prior envelope (even if already completed).
      // After a deliberate timeout we SIGTERM the child, and the child
      // exiting on a signal lands here — keep reason:"timeout", not
      // overwritten by crashed (otherwise the timeout semantics of
      // waitFor / queryBuffer would be lost).
      const timedOut =
        task.state === "failed" && task.envelope?.reason === "timeout";
      if (!timedOut && (code !== 0 || signal !== null)) {
        const reason: "crashed" | "timeout" =
          task.state === "failed" && task.envelope?.reason === "timeout"
            ? "timeout"
            : "crashed";
        // Child exits via SIGTERM after the timeout-fire: task.state is
        // already failed, emitStop directly (reason=timeout, signal=SIGTERM
        // etc.) — no second emitStateChange.
        if (reason === "crashed") {
          void settleCrash({
            task,
            stderrClosed,
            stderr: () => stderrCapture,
            summary: () => crashedSummary(code, signal, stderrBuf),
            exitCode: code,
            signal,
          });
        } else {
          // timeout envelope already written -> only supplement emitStop (terminal signal)
          emitStop(task, "failed", {
            reason: "timeout",
            summary: task.envelope?.summary ?? `timeout after effective`,
            ...(code !== null ? { exitCode: code } : {}),
            ...(signal !== null ? { signal } : {}),
          });
        }
      }
      // Clean exit (0, null) with no envelope -> protocolError, slot released immediately.
      // Existing terminal states are not overwritten: legitimate envelope /
      // timeout / other failure-path results stay as they are.
      if (
        code === 0 &&
        signal === null &&
        task.state !== "completed" &&
        task.state !== "failed" &&
        task.envelope === undefined
      ) {
        const summary = "worker exited cleanly without envelope";
        task.envelope = locateEnvelope(task, {
          status: "failed",
          reason: "protocolError",
          summary,
          result: "",
        });
        emitStateChange(task, "failed", { reason: "protocolError" });
        emitStop(task, "failed", {
          reason: "protocolError",
          summary,
        });
      }
      // Clean exit (0, null) with an envelope -> stays completed (emitStop already fired in the stdout stage).
    });

    child.on("error", (err) => {
      void settleCrash({
        task,
        stderrClosed,
        stderr: () => stderrCapture,
        summary: () =>
          stderrBuf.length === 0
            ? err.message
            : `${err.message}\nstderr tail:\n${stderrBuf}`,
      });
    });

    return { taskId: id };
  }

  /**
   * Sync version of realpathWithMissingSuffix (same shape as
   * src/harness/aci/tools/helpers.ts): realpath the nearest existing ancestor
   * then append the unresolved suffix segments. Used by the ENOENT fallback
   * of sandboxRoot validation — both child and parent arms land in realpath
   * form, so under a symlinked parent root (macOS /var → /private/var etc.) a
   * lexical child never falsely appears outside the realpath'd parent.
   * Non-ENOENT errors rethrow as-is (the caller distinguishes I/O faults from outside).
   */
  function resolveWithinParentForm(target: string): string {
    const missingSegments: string[] = [];
    let candidate = resolve(target);
    while (true) {
      try {
        const existingAncestor = realpathSync(candidate);
        return resolve(existingAncestor, ...missingSegments.reverse());
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const parent = dirname(candidate);
        if (parent === candidate) throw err;
        missingSegments.push(relative(parent, candidate));
        candidate = parent;
      }
    }
  }

  function buildWorkerPayload(
    def: SubAgentDefinition,
    taskId: string
  ): WorkerEnvelope {
    // Every spawn path passes this single-point validation. Semantics:
    //   1. parentSandboxRoot is read once at entry:
    //      - sandboxRootCell present → cell() (live root)
    //      - otherwise realpathSync(opts.sandboxRoot ?? process.cwd()) (frozen value, legacy path)
    //      The parent agent's true work domain (the resolved parent directory
    //      layer may contain symlinks, e.g. /var → /private/var on macOS);
    //      the worker's fs tools reuse the same resolved value.
    //   2. def.sandboxRoot absent → write parentSandboxRoot (inherit the
    //      parent root, not process.cwd()). Where parent root ≠ process.cwd()
    //      (the main agent's sandboxRoot differs from the startup cwd), this
    //      prevents the subagent's work domain from accidentally widening
    //      beyond the main process cwd.
    //   3. def.sandboxRoot present → resolved =
    //      realpathSync(resolve(def.sandboxRoot)), rel =
    //      relative(parentSandboxRoot, resolved). rel === "" is legal
    //      (equality); rel.startsWith("..") || isAbsolute(rel) → typed
    //      rejection. realpath throwing ENOENT → lexical fallback: redo the
    //      prefix verdict with the lexical path of resolve(def.sandboxRoot)
    //      (a not-yet-created child path under the parent root is not
    //      outside; lexical containment in the parent root passes); a lexical
    //      escape is still typed-rejected (guards against "declaring an
    //      uncreated path = implicitly widening the parent root"). Other
    //      errnos (EACCES / ELOOP etc.) rethrow as-is, never wrapped as outside.
    //   4. `rel.startsWith("..")` also rejects the legal directory name
    //      `..foo` (fail-closed first per contract; no attempt to distinguish
    //      `..foo` from `..` / `../`).
    let parentSandboxRoot: string;
    try {
      const candidate =
        opts.sandboxRootCell !== undefined
          ? opts.sandboxRootCell()
          : (opts.sandboxRoot ?? process.cwd());
      parentSandboxRoot = realpathSync(candidate);
    } catch (err) {
      // opts.sandboxRoot itself exists but cannot be realpath'd (rare; the
      // main agent assembly usually shares cwd) → the parent root cannot be
      // inferred, typed-reject directly.
      const candidate =
        opts.sandboxRootCell !== undefined
          ? opts.sandboxRootCell()
          : (opts.sandboxRoot ?? process.cwd());
      if (
        (err as NodeJS.ErrnoException).code === "ENOENT" ||
        (err as NodeJS.ErrnoException).code === "ENOTDIR"
      ) {
        throw new SubAgentSandboxRootError({
          parentSandboxRoot: candidate,
          requested: def.sandboxRoot ?? "(inherited from parent)",
        });
      }
      throw err;
    }

    let resolved: string;
    if (def.sandboxRoot === undefined) {
      resolved = parentSandboxRoot;
    } else {
      try {
        resolved = realpathSync(resolve(def.sandboxRoot));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // A not-yet-existing child path under the parent root is not
          // outside — pass, but not with a pure lexical resolve: the child
          // takes "realpath of the nearest existing ancestor + unresolved
          // suffix", aligning with the parent arm's realpath form (see the
          // comment at the relative() verdict below; a pure lexical child
          // falsely escapes under a symlinked parent root).
          resolved = resolveWithinParentForm(def.sandboxRoot);
        } else {
          // Non-ENOENT I/O (EACCES / ELOOP / ENOTDIR etc.) rethrows as-is,
          // never wrapped as outside.
          throw err;
        }
      }
      // Both arms adjudicated in the same form: the ENOENT-fallback child
      // does not use a pure lexical resolve — under a symlinked parent root
      // (macOS /var → /private/var etc.), relative()ing a lexical child
      // directly against realpath(parent) would falsely report an escape.
      // The child instead takes "realpath of the nearest existing ancestor +
      // unresolved suffix", matching the parent arm's realpath form (the
      // sync twin of helpers.ts realpathWithMissingSuffix).
      const rel = relative(parentSandboxRoot, resolved);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new SubAgentSandboxRootError({
          parentSandboxRoot,
          requested: def.sandboxRoot,
        });
      }
    }

    return {
      task: def.task ?? "",
      sandboxRoot: resolved,
      ...(def.systemPrompt !== undefined && { systemPrompt: def.systemPrompt }),
      ...(def.disallowedTools !== undefined && {
        disallowedTools: [...def.disallowedTools],
      }),
      ...(def.model !== undefined && { model: def.model }),
      ...(def.maxTurns !== undefined && { maxTurns: def.maxTurns }),
      ...(def.timeoutMs !== undefined && { timeoutMs: def.timeoutMs }),
      ...(def.role !== undefined && { role: def.role }),
      ...(def.finalText !== undefined && { finalText: def.finalText }),
      ...(def.evidenceContext !== undefined && {
        evidenceContext: def.evidenceContext,
      }),
      // The situation enum is computed at spawn time and threaded through the
      // envelope. The worker prior renders the write-root segment from it:
      //   - writable_main / writable_tree → ①/② wording (byte-equal to before the change);
      //   - no_writable_root → ③ disclosure (isolation ON + resolved non-tree
      //     shape = unbound tree).
      // Single source = `writeSituation(isolationOn, resolved)` at spawn time;
      // consumers (render / worker prior) no longer judge the shape each on
      // their own. The shape decision still lives in `writeSituation`
      // (`isolation/write-situation.ts`); this site only computes it once and threads it through.
      // opts.isolationOn absent → false (isolation OFF); byte-unchanged for
      // existing manager-direct scenarios (manager.test.ts makeHarness).
      ...(opts.isolationOn !== undefined
        ? {
            writeSituation: writeSituation(opts.isolationOn, resolved),
          }
        : { writeSituation: writeSituation(false, resolved) }),
      // ADR-0071: the parent manager already created
      // `<parent session folder>/subagents/agent-<taskId>.jsonl` for this
      // taskId, and threads traceFilePath + taskId through the envelope to the
      // worker — the worker persists that path directly in file-mode with
      // conversationId=taskId, replacing the retired fake-scope `randomUUID()`
      // (per-agent form wins).
      //
      // The landing site shares its source with `resolvePerAgentTrace` /
      // `writeMetaOnce` — the same def derives the same directory (cli/TUI via
      // the existing subagentsDir form; hub via the two-segment seam of
      // projectDir + def.conversationId). If either is present, emit per the
      // derived result; both absent → do not write these two additive fields →
      // the worker degrades to the existing IKNOW_TRACE_OUT / defaultTraceDir
      // form (legacy envelope byte-stable).
      //
      // Under the same directory derivation we also emit `transcriptPath` —
      // (ADR-0102)
      // the worker transcript (the SessionFileV1-shaped conversation ledger,
      // `<subagents>/<taskId>/<taskId>.jsonl`, kept apart from the per-agent
      // trace `agent-<taskId>.jsonl`). Same landing discipline as trace: if the
      // directory derivation is absent, all three keys are omitted and the
      // worker keeps no ledger (old form byte-for-byte unchanged).
      ...workerLedgerFields(resolveSubagentsDirForDef(def), taskId),
      ...todoLedgerAnchor(opts.todoDir, def.conversationId),
      // The parent session's complete model-index snapshot "as of now" — the
      // getter is re-read at every spawn (same shape as `sandboxRootCell`);
      // once the value is on the wire, later parent-side growth never flows back.
      // Three-state folding lives in the helper (getter absent / undefined →
      // key omitted; `[]` → key present).
      ...skillIndexSnapshotField(opts.skillIndexSnapshot, def.conversationId),
    };
  }

  function queryBuffer(taskId: string): QueryBufferResult {
    const task = tasks.get(taskId);
    if (!task) return { status: "not_found" };
    if (task.state === "starting" || task.state === "running")
      return { status: "running" };
    if (task.state === "completed" && task.envelope) return task.envelope;
    // A failed task always carries an envelope (handlers uniformly pass
    // result); this is the defensive fallback.
    if (task.envelope) {
      return {
        status: "failed",
        reason: task.envelope.reason ?? "crashed",
        summary: task.envelope.summary,
      };
    }
    return {
      status: "failed",
      reason: "crashed",
      summary: "subagent failed without envelope",
    };
  }

  function queryPad(taskId: string, tmpPath?: string): PadQueryResult {
    const task = tasks.get(taskId);
    if (!task) return { status: "not_found" };
    return inspectWorkerPad(task.padRoot, tmpPath);
  }

  function waitFor(
    taskId: string,
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<SubAgentEnvelope> {
    return new Promise((resolve, reject) => {
      const task = tasks.get(taskId);
      if (!task) {
        reject(new SubAgentWaitTimeoutError());
        return;
      }
      // Default timeoutMs goes through the three-tier chain
      // (def ?? taskTimeoutMs ?? 7200s), the same source as spawn's SIGTERM
      // timer — preventing default-value drift across two declaration points.
      const effectiveTimeout =
        timeoutMs ?? effectiveTaskTimeoutMs(task.def, opts);
      // Pre-aborted signal → immediate SubAgentAbortError, no polling state built.
      if (signal?.aborted) {
        reject(new SubAgentAbortError(taskId));
        return;
      }

      let settled = false;
      let interval: ReturnType<typeof setInterval> | undefined;
      // The abort listener is cleaned up after resolve/reject, preventing leaks.
      const onAbort = (): void => {
        if (!signal?.aborted) return;
        cleanup();
        settleReject(new SubAgentAbortError(taskId));
      };
      const cleanup = () => {
        if (interval) clearInterval(interval);
        waitPollers.delete(interval as ReturnType<typeof setInterval>);
        waitRejecters.delete(settleReject);
        // This task's wait has settled (any arm) → remove from abortTask's
        // single-task rejection set, so a stale setter isn't double-settled by
        // a later abortTask.
        task.waitRejects.delete(settleReject);
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const settleReject = (reason: unknown): void => {
        if (settled) return;
        settled = true;
        reject(reason);
      };
      const resolveEnvelope = (env: SubAgentEnvelope): void => {
        cleanup();
        if (settled) return;
        settled = true;
        resolve(env);
      };

      const started = Date.now();
      const check = () => {
        // completed / failed both resolve the envelope (the caller branches on
        // status); only timeout / abort / shutdown reject.
        if (task.state === "completed" || task.state === "failed") {
          if (task.envelope) resolveEnvelope(task.envelope);
          else settleReject(new SubAgentWaitTimeoutError());
          return;
        }
        if (signal?.aborted) {
          cleanup();
          settleReject(new SubAgentAbortError(taskId));
          return;
        }
        if (Date.now() - started >= effectiveTimeout) {
          cleanup();
          settleReject(new SubAgentWaitTimeoutError());
        }
      };
      interval = setInterval(check, WAIT_POLL_MS);
      waitPollers.add(interval);
      waitRejecters.add(settleReject);
      // Registered from the same source into this task's rejection set —
      // abortTask settles this task's in-flight wait through it (operator
      // force-kill → the parent turn collects cancelled).
      task.waitRejects.add(settleReject);
      signal?.addEventListener("abort", onAbort);
      check(); // Immediate first check: an already-terminal task converges directly, no first tick
    });
  }

  /**
   * Actively abort a single task. First settle this task's in-flight
   * `waitFor` (reject with `SubAgentAbortError` — same shape as shutdown but
   * scoped to this one task), then propagate abortCtrl.abort() → child
   * SIGTERM → SIGKILL backstop 5s.
   *
   * The order is contractual: the rejection must precede the SIGTERM — the
   * worker's SIGTERM epilogue writes back a `reason:"timeout"` failed
   * envelope, and if we killed first / rejected after, the parent would see
   * wallclock-timeout attribution, whereas operator force-kill and wallclock
   * expiry must stay distinguishable.
   *
   * Clear the old backstop timer first, then re-arm 5s from this SIGTERM —
   * otherwise a backstop armed early (before the per-task timeout) still
   * fires on the old baseline, double-firing at the timeout SIGTERM's
   * instant. Unknown / already-terminal tasks are a no-op returning false;
   * returns true when an in-flight child was actually signaled.
   */
  function abortTask(taskId: string): boolean {
    const task = tasks.get(taskId);
    if (!task) return false;
    if (task.state !== "starting" && task.state !== "running") return false;
    // 1. First settle the waiters (snapshot: settleReject mutates this set
    //    inside its own cleanup, skipping iteration).
    for (const reject of [...task.waitRejects]) {
      reject(new SubAgentAbortError(taskId));
    }
    task.waitRejects.clear();
    // 2. Then abort the worker child process + backstop.
    task.abortCtrl?.abort();
    if (task.child) {
      try {
        task.child.kill("SIGTERM");
      } catch {
        /* ESRCH et al. ignore */
      }
      // Clear + re-arm: backstop baseline = this SIGTERM moment (reset=true).
      armKillFallback(task, true);
    }
    return true;
  }

  /**
   * Resume gate (process already dead + the worker transcript written since
   *
   // (ADR-0102)
   * this slice onward). `completed` / `failed` / `aborted` are treated alike
   * (one mechanical path); gate order: existence → lifetime → transcript →
   * concurrency cap; an unsatisfied earlier gate typed-rejects and occupies
   * no quota. Success = `launchWorker(merged, same taskId)` — new process,
   * same external handle; the old Task record is wholesale replaced by the new
   * one (the terminal envelope / endedAt were the previous round's truth and
   * leave the books with the replacement; the handoff itself was already
   * delivered in that hop's tool_result / mailbox).
   */
  function resumeTask(
    taskId: string,
    def: SubAgentDefinition
  ): { readonly taskId: string } {
    const old = tasks.get(taskId);
    if (old === undefined) {
      throw new SubAgentResumeError(taskId, "not_found");
    }
    if (old.state === "starting" || old.state === "running") {
      throw new SubAgentResumeError(taskId, "running");
    }
    const dir = resolveSubagentsDirForDef(old.def);
    const transcriptPath =
      dir === undefined ? undefined : workerTranscriptPath(dir, taskId);
    // Only accept the worker ledger written by this slice's layout; a present
    // per-agent trace (agent-<taskId>.jsonl) with an absent ledger = a
    // pre-slice worker — never fabricate a ledger backfilled from the trace.
    if (transcriptPath === undefined || !existsSync(transcriptPath)) {
      throw new SubAgentResumeError(taskId, "no_transcript");
    }
    // The resume occupies the same subagent concurrency cap (over the limit → SubAgentCapacityError).
    const cap = currentCapacity();
    if (cap !== "unlimited") {
      assertCapacityAvailable(cap, tasks);
    }
    return launchWorker(resumeDefinition(old.def, def, taskId), taskId);
  }

  /** Non-terminal task IDs (starting + running) needed by host-drain's blocking poll. */
  function listActive(): ReadonlyArray<string> {
    const out: string[] = [];
    for (const [id, task] of tasks) {
      if (task.state === "starting" || task.state === "running") out.push(id);
    }
    return out;
  }

  /**
   * Full read-only projection. summary/reason come from the terminal
   * envelope (the same truth as queryBuffer); taskPreview truncates ≤120,
   * never carrying full task text (the permission row).
   * Postel: endedAt persists only in terminal states; summary/reason surface
   * upward only when the envelope has values.
   */
  function listSubagents(conversationId?: string): ReadonlyArray<SubagentInfo> {
    const out: SubagentInfo[] = [];
    for (const task of tasks.values()) {
      if (
        conversationId !== undefined &&
        task.def.conversationId !== conversationId
      ) {
        continue;
      }
      const envelope = task.envelope;
      const item: SubagentInfo = {
        taskId: task.id,
        state: task.state,
        // Same source as recordSubagentSpawn (truncateTaskPreview default 120).
        taskPreview: truncateTaskPreview(task.def),
        startedAt: task.startedAt,
        ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
        ...(envelope?.summary !== undefined
          ? { summary: envelope.summary }
          : {}),
        ...(envelope !== undefined &&
        envelope.status === "failed" &&
        envelope.reason !== undefined
          ? { reason: envelope.reason }
          : {}),
        ...(task.def.role !== undefined && task.def.role.trim() !== ""
          ? { role: task.def.role.trim() }
          : {}),
        // presentString = same criterion as writeMetaOnce (one helper, see module top).
        ...(presentString(task.def.toolUseId)
          ? { toolUseId: task.def.toolUseId }
          : {}),
        ...ownershipInfoFields(task.def),
      };
      out.push(item);
    }
    return out;
  }

  function subscribe(
    subscriber: SubAgentTerminalSubscriber,
    conversationId?: string
  ): () => void {
    if (conversationId === undefined) {
      return terminalMailbox.subscribe(subscriber);
    }
    return terminalMailbox.subscribe((notice) => {
      if (notice.conversationId === conversationId) subscriber(notice);
    });
  }

  async function shutdown(): Promise<void> {
    const runningTasks = [...tasks.values()].filter(
      (t) => t.state === "starting" || t.state === "running"
    );
    const runningChildren = runningTasks
      .map((t) => t.child)
      .filter((c): c is ChildProcess => c !== undefined);

    // shutdown clears all timeoutTimers so the manager
    // process does not hold dangling timers nor fire SIGKILL on already-
    // SIGTERM'd children.
    for (const t of runningTasks) {
      if (t.timeoutTimer) {
        clearTimeout(t.timeoutTimer);
        t.timeoutTimer = undefined;
      }
      if (t.timeoutKillFallback) {
        clearTimeout(t.timeoutKillFallback);
        t.timeoutKillFallback = undefined;
      }
    }

    // 1. abort in-flight (reserved: the current spec does not wire abortCtrl to concrete calls).
    for (const t of tasks.values()) t.abortCtrl?.abort();

    // 2. SIGTERM all running children.
    for (const child of runningChildren) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ESRCH et al. ignore */
      }
    }

    // 3. Wait for exit ≤5s; survivors → SIGKILL backstop.
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const closed = new Set<ChildProcess>();
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolvePromise();
      };
      const timer = setTimeout(() => {
        for (const child of runningChildren) {
          if (!closed.has(child)) {
            try {
              child.kill("SIGKILL");
            } catch {
              /* ESRCH et al. ignore */
            }
          }
        }
        finish();
      }, SHUTDOWN_SIGKILL_GRACE_MS);
      if (runningChildren.length === 0) {
        finish();
        return;
      }
      for (const child of runningChildren) {
        // Children that already exited after spawn (exitCode is a number) count as closed; otherwise listen for exit.
        if (typeof child.exitCode === "number") {
          closed.add(child);
          if (closed.size === runningChildren.length) finish();
          continue;
        }
        child.once("exit", () => {
          closed.add(child);
          if (closed.size === runningChildren.length) finish();
        });
      }
    });

    // Actively reject pending waitFor + clear poll handles (never hanging).
    // The snapshot prevents settleReject mutating waitRejecters inside its own
    // cleanup and skipping iteration.
    for (const reject of [...waitRejecters])
      reject(new SubAgentWaitTimeoutError());
    waitRejecters.clear();
    for (const poller of waitPollers) clearInterval(poller);
    waitPollers.clear();

    // 4. Clear the tasks map.
    tasks.clear();
    terminalMailbox.clear();
  }

  function drainCompleted(conversationId?: string): ReadonlyArray<{
    readonly taskId: string;
    readonly envelope: SubAgentEnvelope;
  }> {
    const out: { taskId: string; envelope: SubAgentEnvelope }[] = [];
    for (const [id, task] of tasks) {
      if (
        (task.state === "completed" || task.state === "failed") &&
        task.envelope &&
        task.def.excludeFromHostDrain !== true &&
        (conversationId === undefined ||
          task.def.conversationId === conversationId)
      ) {
        out.push({ taskId: id, envelope: task.envelope });
      }
    }
    return out;
  }

  return Object.freeze({
    spawn,
    queryBuffer,
    queryPad,
    waitFor,
    shutdown,
    drainCompleted,
    listActive,
    abortTask,
    // Entry point for resuming dead workers (gates decided inside resumeTask;
    // (ADR-0102)
    // subagent_continue only maps them).
    resumeTask,
    listSubagents,
    subscribe,
    // Read-only getter for the concurrency cap — description and
    // SubAgentCapacityError share one source (ADR-0096); the holder is the same one the
    // spawn gate holds.
    getCapacity: currentCapacity,
  });
}
