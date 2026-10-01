/**
 * BackgroundTaskManager: background-task lifecycle / in-memory Map state
 * machine / registry persistence sync / streaming log append.
 *
 * Scope: spawn (returns immediately, does not await exit), registry json
 * write / status-transition sync, log-tail read primitives, and stop
 * (SIGTERM → 2s → SIGKILL, host-side kill(-pgid)).
 *
 * DI boundary mirrors subagent/manager.ts: the manager does not import
 * child_process at runtime (the spawn factory is injected via opts); the
 * production defaultBackgroundSpawn lives in this same file (bwrap fence +
 * detached spawn) and is injected by build-engine at assembly time. The
 * fence reuses createBwrapFence; since ADR-0097 the network axis is constant
 * in foreground and background (`--unshare-net` always present; egress only
 * via the egress seam).
 *
 * Governance values (DEFAULT_LOG_MAX_* / task_id format) are pinned here as
 * the SSOT (ADR-0021).
 * Typed-error BackgroundTaskError discriminated union (catch contract):
 *   empty_task_id / task_not_found / schema_invalid / io_failure / kill_race.
 * kill_race semantics (locked by tests): stop on an already-terminal task =
 * idempotent success (a legal state — no throw, no second signal); only when
 * the process group vanished (ESRCH) during kill escalation before the exit
 * event arrived is it classified as kill_race, and the caller still converges
 * on idempotent success rather than exposing the race as an error.
 */
import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_ENV_WHITELIST,
  applyCwdReadonlyFenceEnv,
  createBwrapFence,
  createEgressSession,
  createEnvIsolation,
  createFsPolicy,
  fenceScanScope,
  protectedFenceWiring,
  wrapCommandWithInnerBridge,
} from "../sandbox/index.js";
import type {
  EgressFenceSpec,
  EgressPolicyInput,
  EgressSession,
} from "../sandbox/index.js";
import type {
  BackgroundTaskRecord,
  BackgroundTaskStatus,
  BackgroundTerminationCause,
} from "./registry.js";
import { createBackgroundRegistry } from "./registry.js";
import type { BackgroundRegistry } from "./registry.js";
import type { BackgroundTaskError } from "./registry.js";
import { readProcStartTime } from "./proc.js";
import {
  NOT_STARTED_CLEANUP,
  confirmedStopped,
  sendSignalToProcessGroup,
  unconfirmedCleanup,
  waitForProcessGroupGone,
  type CleanupEvidence,
} from "../sandbox/cleanup-result.js";

/** Extra kinds for spawn-request validation failures (manager-specific; the registry is unaware of requests). */
export type BackgroundSpawnValidationError =
  | BackgroundTaskError
  | {
      kind: "spawn_validation_failed";
      context: string;
    }
  | {
      kind: "concurrency_limit_reached";
      context: string;
      /** Constructive action hint (ADR-0021 discipline: state the situation
       *  + available actions, zero negative wording). */
      message: string;
    };

/** Default log-read window 12KB (governance-value SSOT lives in the
 *  manager constant, ADR-0021). */
export const DEFAULT_LOG_MAX_BYTES = 12 * 1024;
/** Log-read window cap 100KB (ADR-0021). */
export const MAX_LOG_READ_BYTES = 100 * 1024;
/** ADR-0021: concurrency cap 8 — at the cap manager.spawn rejects with a
 *  constructive message (concurrency_limit_reached spawn_error, see the
 *  spawn section). Exported for tests and assembly-time assertions. */
export const MAX_CONCURRENT_BACKGROUND_TASKS = 8;
/** stop escalation: SIGTERM → 2s grace → SIGKILL (reuses the runner.ts stopTree pattern). */
const STOP_KILL_GRACE_MS = 2_000;
/**
 * ADR-0134: the longest accepted finite `timeout_ms`. A host timer at or
 * beyond this cannot be represented without overflow (setTimeout's 32-bit
 * signed millisecond delay wraps), so a larger value is a representation
 * failure rather than a runtime policy — it is rejected, never clamped.
 */
export const MAX_BACKGROUND_TIMEOUT_MS = 2_147_483_647;
/** Bounded wait for the process group to disappear before a teardown verdict
 *  is published as `unconfirmed`. Mirrors the sandbox planes' settle window:
 *  it bounds the verdict, never the kill route. */
const STOP_GROUP_OBSERVE_MS = 250;
/** shutdown constants mirroring subagent/manager.ts (same names, same
 *  values, for reviewability): SIGTERM → 5s grace → SIGKILL. */
const SHUTDOWN_SIGKILL_GRACE_MS = 5_000;

/** In-memory state: live in-process handle, not persisted to the registry json (child + mutable status). */
interface BackgroundTask {
  readonly task_id: string;
  readonly client: MutableClientState;
  /** The original created_at from spawn time (registry truth); shutdown
   *  convergence step 5 keeps it instead of stamping the current time (same
   *  semantics as the settle closure). */
  readonly createdAt: string;
  child?: ChildProcess;
  /** Serialized log appendFile chain: each chunk continues off the previous chain tail, preserving order. */
  writeChain: Promise<void>;
  /**
   * Bounded-teardown evidence for this task's process group. `not_started`
   * until stop() requests a teardown and the observation publishes its
   * verdict; a caller reads it through `status` to tell a confirmed stop
   * from a cleanup that never proved disappearance.
   */
  cleanup: CleanupEvidence;
  /** SIGKILL fallback timer armed by stop(); shutdown() must clearTimeout it
   *  to avoid double-firing with its own 5s grace escalation. */
  killFallback?: NodeJS.Timeout;
  /**
   * ADR-0134: the launch-time deadline timer, armed once at spawn and never
   * re-armed. Polling, log reads and stop requests deliberately do not touch
   * it — that is what makes the deadline a launch fact rather than an
   * inactivity timeout. Cleared by the terminal transition and by shutdown,
   * so a settled task's timer can never signal it afterwards.
   */
  deadlineTimer?: NodeJS.Timeout;
  /**
   * ADR-0134: the ISO instant this task's deadline expires, frozen at launch.
   * Null on a persistent-service task (no `timeout_ms` supplied), which is
   * how a reader tells the two lifecycles apart without consulting a timer.
   */
  readonly deadlineAt: string | null;
  /**
   * ADR-0134: the validated finite budget this task was launched with, kept so
   * every later persistence of the record (settle, shutdown convergence)
   * rewrites the same launch facts it read at spawn. Null = persistent service.
   */
  readonly timeoutMs: number | null;
  /**
   * ADR-0134: why this task became terminal. Null while running; written once
   * by whichever transition won the race and read back unchanged by every
   * later competing trigger.
   */
  terminationCause: BackgroundTerminationCause | null;
  /**
   * ADR-0097: egress session handle — the per-task session started by
   * manager.spawn; settle (triggered by child exit) disposes inside the
   * already-settled guard, and abnormal paths (registry.save failure / spawn
   * factory throw) dispose through the same fallback (ownership contract:
   * "abnormal and normal paths release through the same channel").
   *
   * Absent = the caller passed no egressPolicy = this task has no egress session.
   */
  egressSession?: EgressSession;
}

/** Externally read-only view; mutable fields are changed exclusively by the manager. */
export interface BackgroundTaskClientState {
  readonly status: BackgroundTaskStatus;
  readonly exit_code: number | null;
  readonly conversation_id: string;
  readonly log_path: string;
  readonly command: string;
}

interface MutableClientState {
  status: BackgroundTaskStatus;
  exit_code: number | null;
  conversation_id: string;
  log_path: string;
  command: string;
}

export interface CreateBackgroundTaskManagerOptions {
  /** Persistence root: `<poolRoot>/projects/<slug>/tasks/` (ADR-0088 home
   *  project tree) — same level and same slug as the session-folder leaf,
   *  injected by the host as an already-resolved absolute path (workspaceRoot
   *  is no longer self-derived; see the tasksDir note on
   *  `buildHarnessEngine`). */
  readonly tasksDir: string;
  /** DI spawn factory, injected by the caller (fake tests / production defaultBackgroundSpawn). */
  readonly spawn: BackgroundSpawn;
  /** Persistence / risk-event log (silent by default). */
  readonly log?: (msg: string) => void;
}

/** Spawn-factory signature: takes the resolved request, returns a ChildProcess. */
export type BackgroundSpawn = (
  request: BackgroundSpawnRequest
) => Promise<ChildProcess>;

/** Spawn inputs: command / cwd / bookkeeping conversationId. */
export interface BackgroundSpawnRequest {
  /** The restored real command — consumed by the spawn factory
   *  (defaultBackgroundSpawn into bwrap) with unchanged semantics; the real
   *  value lives only in memory and the spawn call stack, never persisted. */
  readonly command: string;
  readonly cwd: string;
  readonly conversationId?: string;
  /** Persisted form — the command written into the registry json uses this
   *  field (placeholder form, `<<<SECRET_N>>>`); the spawn real value never
   *  hits disk. Absent (no secret registry / hand-written callers) -> falls
   *  back to request.command. */
  readonly recordCommand?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** cwdReadonly?: boolean — passed through to defaultBackgroundSpawn to
   *  build a readonly fence (the cwd bind changes from `--bind` to
   *  `--ro-bind`, aligning with the foreground bashMode → cwdReadonly
   *  derivation). Absent / false = the existing writable cwd (V1 baseline
   *  unchanged). Derived by bash.ts handleBackground from
   *  opts.bashMode === "readonly" || opts.cwdReadonly === true. */
  readonly cwdReadonly?: boolean;
  /** ADR-0092 (amending ADR-0074): this identity's session tmp host path —
   *  the same path the foreground bash uses as `$TMPDIR`. Never a guest `/tmp`
   *  bind target. */
  readonly tmpDir?: string;
  /**
   * Workspace-tier fs-mode snapshot (ADR-0092) — the foreground bash handler passes it
   * through after its per-call batch snapshot (same discipline mirrored by
   * waveRoot); background spawn reuses the identical one, keeping foreground
   * / background fences set-equal on the fs-tier axis (sandbox discipline
   * G3). Absent / undefined → "global" (V1 baseline). The value has passed
   * the `parseFsModeFlag` guard (read once at the bash.ts handler entry).
   */
  readonly fsMode?: import("../sandbox/fs-mode.js").FsIsolationMode;
  /**
   * Workspace-tier home ro-bind source host absolute path (ADR-0092). Mirrors
   * `opts.homeRoot` (bash.ts defaults to `homedir()` at assembly; background
   * passes the same value through). Missing under the workspace tier ->
   * bwrap throws a typed error (fail-loud, never silently degrading to the
   * global tier); not consumed under the global tier.
   */
  readonly homeRoot?: string;
  /**
   * Name-pattern scan scope (specs/effect-boundary-protection.md "Scan
   * scope"): the workspace directory the fence's name rules enumerate, frozen
   * by the foreground handler from the SAME snapshot vintage as `homeRoot`
   * above so foreground and background materialize over one shared root. Not
   * derived from the fs tier — global and workspace mode scan the same place.
   * Absent (a caller that assembled the request without the handler
   * snapshot) → `fenceScanScope(<the request cwd>)`.
   */
  readonly workspaceRoot?: string;
  /**
   * ADR-0119: --yolo no-sandbox snapshot — a static value passed through from
   * the bash.ts handler-entry per-call snapshot, same vintage as fsMode / homeRoot.
   * true → the fence takes bare argv (defaultBackgroundSpawn hands it to
   * createBwrapFence), and this task starts no egress session: no fence means
   * no netns, so the proxy seam is meaningless (ADR-0119 ruling 3). Absent /
   * false → today's shape byte-for-byte unchanged.
   */
  readonly yolo?: boolean;
  /**
   * ADR-0097: egress proxy seam policy — passed in by the caller (typically
   * derived via `createEgressPolicyFactory`). Background-task form: the egress
   * session starts per-task at assembly time and lives with the task
   * (released when `settle()` fires; the ownership contract pins "abnormal
   * and normal paths release through the same channel").
   *
   * Absent = the caller did not inject = this task starts no egress session
   * and the fence stays fully offline (equivalent to the V1 baseline;
   * `--unshare-net` always present in the sandbox). Minimal implementation of
   * the "only start a session when this task is egress-eligible" contract:
   * force-starting a session without a policy is forbidden (wasteful +
   * contract-violating).
   *
   * Background paths have no ask surface: even with a policy present, when
   * the filter sees `not-in-allowlist` it still records a
   * `no-approval-inlet` violation and does not release (failure path: "new
   * domain first seen at a non-interactive inlet"). If a background task
   * needs that host, provision it in user settings (CI / preset scenarios).
   */
  readonly egressPolicy?: EgressPolicyInput;
  /**
   * ADR-0097: egress session startup product — set by manager.spawn before
   * calling defaultBackgroundSpawn (createEgressSession(policy).spec). The
   * spawn factory reads this field to build fence argv; manager.spawn holds
   * the session handle and disposes it in the child-exit listener.
   *
   * Absent = the caller passed no egressPolicy = no session = no seam.
   * **External callers do not set this field**; it is an internal convention
   * between manager.spawn and the spawn factory only.
   */
  readonly egressSpec?: EgressFenceSpec;
  /**
   * UNBOUND_FENCE segment — the main checkout + session tmp pad frozen at
   * the bash handler entry, passed through and consumed when
   * defaultBackgroundSpawn assembles the fence (same segment, same order as
   * the foreground fence, set-equal per G3). Absent = segment not emitted;
   * bound / gate-OFF background argv stays byte-identical.
   */
  readonly unboundFence?: {
    readonly mainCheckout: string;
    readonly tmpPad?: string;
  };
  /**
   * ADR-0134: the finite runtime budget for this task, in milliseconds, as
   * supplied (and already validated) by the caller. Present → spawn freezes
   * ONE deadline at launch (`created_at + timeoutMs`) and terminates the task
   * when it expires; the deadline is never extended by polling, log reads or
   * stop requests. Absent → the persistent-service lifecycle, with no runtime
   * deadline at all — in particular the foreground 10-second default does not
   * apply to a background task.
   *
   * Validation lives in `validateTimeoutMs` (the single SSOT the manager and
   * the bash handler both consult), so an invalid value can never reach a
   * process, a registry entry or a timer.
   */
  readonly timeoutMs?: number;
}

/**
 * ADR-0134: the one validation of a finite `timeout_ms`. A value is accepted
 * only when it is a positive, finite, integral number of milliseconds whose
 * resulting host timer is representable. Zero, negative, fractional,
 * non-finite and unrepresentable values are rejected with a reason instead of
 * being clamped — a silently shortened timeout is a different contract from
 * the one the caller asked for.
 *
 * Returns null for the accepted case; the shared bash handler consumes the
 * message to build its pre-launch input failure.
 */
export function validateTimeoutMs(
  value: unknown
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "number") {
    return { ok: false, reason: "must be a number of milliseconds" };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: "must be a finite number" };
  }
  if (!Number.isInteger(value)) {
    return { ok: false, reason: "must be a whole number of milliseconds" };
  }
  if (value <= 0) {
    return { ok: false, reason: "must be greater than 0" };
  }
  if (value > MAX_BACKGROUND_TIMEOUT_MS) {
    return {
      ok: false,
      reason: `must not exceed ${MAX_BACKGROUND_TIMEOUT_MS} (host timer limit)`,
    };
  }
  return { ok: true };
}

export type BackgroundSpawnResult =
  | {
      readonly status: "ok";
      readonly task_id: string;
      readonly log_path: string;
    }
  | {
      readonly status: "spawn_error";
      readonly task_id: string;
      readonly error: BackgroundSpawnValidationError;
    };

export interface BackgroundStatusResult {
  readonly status: BackgroundTaskStatus;
  readonly task_id: string;
  readonly exit_code: number | null;
  readonly command: string;
  /**
   * What the bounded teardown observed for this task's process group.
   * `unconfirmed` means a stop was requested but disappearance was never
   * proven — the group may still hold members, and the caller must not treat
   * the `killed` status as proof that the work is finished.
   */
  readonly cleanup: CleanupEvidence;
  /**
   * ADR-0134: the launch-time deadline as an ISO instant, or null on a
   * persistent-service task. Reading it never moves it — this is a projection
   * of the clock frozen at launch, not a fresh computation.
   */
  readonly deadline_at: string | null;
  /**
   * ADR-0134: why the task is in its current state. Null while running; once
   * terminal it names the trigger that won the race and never changes again,
   * so a caller reading cause and cleanup together gets one coherent story.
   */
  readonly cause: BackgroundTerminationCause | null;
}

export interface BackgroundOutputResult {
  /** Return only the tail text (default 12KB, cap 100KB), truncated beyond the cap. */
  readonly text: string;
  readonly status: BackgroundTaskStatus;
  readonly exit_code: number | null;
  readonly task_id: string;
}

export interface BackgroundTaskManager {
  /**
   * Starts a detached process group via the injected spawn factory and
   * returns {task_id, log_path} immediately. Registry json write failure ->
   * spawn_error(io_failure). Once resolved, the registry is already on disk
   * (synchronous contract; tests can read it back immediately).
   */
  readonly spawn: (
    request: BackgroundSpawnRequest
  ) => Promise<BackgroundSpawnResult>;
  /** Query current status (running / exited / killed). In-memory; does not read disk. */
  readonly status: (taskId: string) => Promise<BackgroundStatusResult>;
  /**
   * Reads the log tail (default 12KB, cap 100KB) with current status and
   * exitCode. requesterConversationId is optional (ADR-0021): non-empty and
   * unequal to the task record's conversation_id -> throws
   * task_not_in_scope (carrying owner_conversation_id). Absent / record
   * without conversationId -> no filtering (backward compatible).
   */
  readonly output: (
    taskId: string,
    maxBytes?: number,
    requesterConversationId?: string
  ) => Promise<BackgroundOutputResult>;
  /**
   * Host-side kill(-pgid): SIGTERM → 2s grace → SIGKILL.
   * Returns the teardown *request's* evidence, never a claim that the task
   * exited: the confirmed/unconfirmed verdict for a requested teardown lands on
   * the task's `cleanup` evidence (read via `status`) after the bounded
   * observation. Idempotent success on already-terminal tasks (a legal state);
   * unknown tasks throw task_not_found. requesterConversationId is optional
   * (scope filter, semantics identical to output).
   */
  readonly stop: (
    taskId: string,
    requesterConversationId?: string
  ) => Promise<CleanupEvidence>;
  /**
   * Process-level shutdown (mirrors the subagent manager's exit reap, ADR-0021):
   * clear killFallback timers → SIGTERM all running process groups → ≤5s
   * grace → SIGKILL groups still alive → registry json convergence
   * (killed/exited + exit_code best-effort) → clear the in-memory Map.
   * Idempotent: a second call sees an empty set and returns fast. Never
   * throws (per-group signal errors are swallowed and surfaced via log).
   */
  readonly shutdown: () => Promise<void>;
  /**
   * Reap seam: register a conversation-deletion listener. Only the
   * subscription point exists here; the lifecycle itself is driven by an
   * external component firing `onConversationDeleted`. Registering triggers
   * no calls by itself.
   */
  readonly registerConversationDeletedListener: (
    listener: (conversationId: string) => void
  ) => void;
  /** Reap seam: fire the conversation-deletion event and call every
   *  registered listener. A throwing single listener is swallowed so it
   *  cannot pollute other listeners / the caller. */
  readonly onConversationDeleted: (conversationId: string) => void;
}

/**
 * Production spawn factory: builds the bwrap fence internally + detached
 * spawn. The fence reuses createBwrapFence (current argv shape); process-group
 * detachment is carried by kwargs (only kill(-pgid) can hit the whole group;
 * bwrap's signal forwarding does not cover the deep command process tree).
 *
 * ADR-0045: the direct node:child_process.spawn call is demoted to a thin
 * wrapper around the server spawn handler — routed through the
 * createSandboxServer().spawn long-lived task-handle protocol, which still
 * uses nodeSpawn (node:child_process) internally, keeping pid physical
 * ownership with the host (the manager holds child.handle via the long-lived
 * protocol).
 */
/**
 * The scan scope for a spawn request that carried no frozen workspaceRoot (a
 * caller that did not go through the bash handler's entry snapshot). The
 * request's own `cwd` is the request's anchor — same source the foreground
 * fence uses, so a hand-assembled request cannot scan somewhere the caller
 * never named.
 *
 * Module scope, not inline at the call site: the spread-guard form of this
 * expression is exactly the branch the S5 gate counts, and keeping it out of
 * `defaultBackgroundSpawn` leaves that function's branch budget to the fence
 * assembly it actually owns.
 */
function backgroundScanScope(req: BackgroundSpawnRequest): string {
  return req.workspaceRoot ?? fenceScanScope(req.cwd);
}

export async function defaultBackgroundSpawn(
  req: BackgroundSpawnRequest
): Promise<ChildProcess> {
  const cwd = req.cwd;
  // The fs-tier snapshot (ADR-0092) comes from the spawn request (passed through by the
  // bash.ts handler after its batch snapshot). fsMode absent → global (same
  // shape as opts.fsMode absent in the foreground).
  const fsMode = req.fsMode ?? "global";
  const homeRoot = req.homeRoot;
  // The fs policy (ADR-0092) carries the fs tier (mode field). fsPolicy.tmpRoot() is the
  // SSOT of `$TMPDIR` (the contract root is already required non-empty).
  const fsPolicy = createFsPolicy({
    tmpDir: req.tmpDir ?? tmpdir(),
    mode: fsMode,
  });
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  const fenceEnv = {
    ...applyCwdReadonlyFenceEnv(
      envIsolation.filter(req.env ?? process.env),
      req.cwdReadonly === true
    ),
    // ADR-0092: `$TMPDIR` is this identity's session tmp host path.
    TMPDIR: fsPolicy.tmpRoot(),
  };
  // The inner-listener preamble matches the foreground bash.ts shape — with
  // egressSpec present the `bash -c` payload = `<innerBridgeScript>\n<command>`
  // (the sandbox-side half-bridge is the back half of the seam; without the
  // preamble the seam only has its host half); absent = byte-identical
  // payload (invariant 3 "no seam = no bridge"). The concatenation form has a
  // single point — the egress module's `wrapCommandWithInnerBridge` (three
  // consumers, zero duplication). Proxy env (including GIT_SSH_COMMAND) is
  // not merged here — spec.env is injected as `--setenv` at the single point
  // via createBwrapFence's `egress` field (invariant 4: injection-site SSOT,
  // same shape as the bash.ts foreground consumer).
  const egressSpec = req.egressSpec;
  const commandPayload = wrapCommandWithInnerBridge(egressSpec, req.command);
  const fence = createBwrapFence({
    command: "bash",
    args: ["-c", commandPayload],
    fsPolicy,
    env: fenceEnv,
    cwd,
    // cwdReadonly:true passes through to the fence — the cwd bind changes
    // from --bind to --ro-bind, aligning with the foreground
    // bashMode → cwdReadonly derivation. Foreground / background bwrap argv
    // isolation axes stay set-equal (cwdReadonly on and off). The rest of
    // the fence is byte-identical; only the cwd-bind verb changes.
    ...(req.cwdReadonly ? { cwdReadonly: true } : {}),
    // Workspace-tier fence's three layers (ADR-0092) — foreground / background
    // set-equal. Under the global tier bwrap does not emit this bind, so the
    // V1 baseline holds. A missing home-layer source is **not**
    // pre-filtered here: when the workspace tier forgets homeRoot, bwrap
    // throws a typed error (fail-loud, see bwrap.ts workspaceHomeRoBindArgs)
    // — silently skipping would let the background spawn's fence quietly
    // regress to the global tier (home writable) while the foreground stays
    // on the workspace tier.
    ...(fsMode === "workspace"
      ? {
          homeRoot,
          workspaceRoot: cwd,
          tmpRoot: fsPolicy.tmpRoot(),
        }
      : {}),
    // ADR-0097: egress seam (per-task fence) — the egressSpec assembled by
    // manager.spawn is consumed here (socket --bind + spec.env --setenv
    // emitted at the single point by bwrap); absent = fully-offline baseline.
    ...(egressSpec !== undefined ? { egress: egressSpec } : {}),
    // PROTECTED_TARGETS wiring (T7 write block + T8 credential read mask) —
    // the same `protectedFenceWiring` bundle the foreground builds from its
    // frozen inputs: the inventory resolves against the request's homeRoot
    // when present, else homedir() (same default as the bash handler
    // snapshot). Background tasks that retire the fence wholesale (yolo
    // below) never reach the block.
    ...protectedFenceWiring({
      homeRoot: homeRoot ?? homedir(),
      workspaceRoot: backgroundScanScope(req),
    }),
    // UNBOUND_FENCE segment pass-through — same values, same order as the
    // foreground buildForegroundFence (foreground/background set-equal, G3);
    // absent = segment not emitted, background argv byte-identical.
    ...(req.unboundFence !== undefined
      ? { unboundFence: req.unboundFence }
      : {}),
    // ADR-0119: the whole-fence-retirement switch — spread-guard keeps the
    // non-yolo fence opts byte-identical; when true the fence factory emits
    // bare argv (the egress seam is skipped on the manager.spawn side, so it
    // never reaches the request).
    ...(req.yolo === true ? { yolo: true } : {}),
  });
  // ADR-0045: in consumer form (manager.spawn callers) there is no direct
  // node:child_process call anymore — the server.spawn long-lived
  // task-handle protocol exposes stdout/stderr/exit/stopped events plus a
  // stop control message. But the manager's existing caller contract =
  // Promise<ChildProcess> (child.stdout.on / child.once('exit') / child.pid,
  // etc.), and 30+ fixtures use vi.mock("node:child_process", ...) to
  // intercept spawn and capture argv; for compatibility this factory keeps
  // the direct nodeSpawn path (the server's internal spawn still goes
  // through the same node:child_process.spawn, so the fixture mock hits it
  // automatically), while new fixtures move to the server.spawn
  // task-handle protocol. Acceptance = the consumer entries (bash.ts /
  // verify) do not call spawn directly — they already go through
  // server.exec / server.spawn, and nodeSpawn inside this factory is
  // server-handler-internal implementation.
  return nodeSpawn(fence.argv[0], fence.argv.slice(1), {
    cwd,
    env: fenceEnv,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  }) as ChildProcess;
}

/** Spawn-request validation: command must be a non-empty string, and an
 *  explicit finite `timeoutMs` must be representable (ADR-0134). Both checks
 *  run before a task id is allocated, so a rejected request leaves no process,
 *  no registry entry and no timer. */
function validateRequest(
  req: BackgroundSpawnRequest
): BackgroundSpawnValidationError | null {
  if (typeof req.command !== "string" || req.command.trim().length === 0) {
    return {
      kind: "spawn_validation_failed",
      context: "spawn: command required",
    } satisfies BackgroundSpawnValidationError;
  }
  const timeout = validateTimeoutMs(req.timeoutMs);
  if (!timeout.ok) {
    return {
      kind: "spawn_validation_failed",
      context: `spawn: timeoutMs ${timeout.reason}`,
    } satisfies BackgroundSpawnValidationError;
  }
  return null;
}

/**
 * Registry json persistence (running state) precedes the return — once spawn
 * resolves the registry is on disk (spawn → registry synchronization
 * contract). On failure returns io_failure and immediately reclaims the
 * started detached child (SIGKILL, no orphan leak); on success returns
 * undefined. Its own function (complexity gate: spawn does orchestration
 * only).
 */async function saveSpawnRecordOrReap(
  record: BackgroundTaskRecord,
  child: ChildProcess,
  registry: BackgroundRegistry
): Promise<BackgroundTaskError | undefined> {
  try {
    await registry.save(record);
    return undefined;
  } catch (err) {
    const error = err as BackgroundTaskError;
    try {
      child.kill("SIGKILL");
    } catch {
      /* ESRCH etc. ignored */
    }
    return error;
  }
}

/**
 * ADR-0134: disarm every timer a task is holding. Two independent reasons
 * they must not survive their owner: the stop escalation would re-issue a
 * SIGKILL that shutdown's own 5s grace already replaced, and a pending
 * deadline would signal a task after a process-wide shutdown already ended it.
 */
function clearTaskTimers(task: BackgroundTask): void {
  if (task.killFallback) {
    clearTimeout(task.killFallback);
    task.killFallback = undefined;
  }
  if (task.deadlineTimer) {
    clearTimeout(task.deadlineTimer);
    task.deadlineTimer = undefined;
  }
}

/**
 * ADR-0134: the single terminal arbitration point. A settled flag alone is
 * not enough — a stop request, a deadline expiry and the child's own exit can
 * all reach a terminal state, and each carries a cause the caller needs. This
 * assigns the cause exactly once, so a later competing trigger can only
 * observe the cause already recorded (single-wins semantics — the same
 * discipline `observeTaskGroupGone` uses for the cleanup verdict).
 */
function claimTermination(
  task: BackgroundTask,
  cause: BackgroundTerminationCause
): boolean {
  if (task.terminationCause !== null) return false;
  task.terminationCause = cause;
  return true;
}

/**
 * The one-shot terminal transition for a task: migrate the in-memory status,
 * dispose the egress session, and persist the record. Idempotent by
 * construction — the first call wins and later calls return immediately.
 *
 * The guard ordering is load-bearing. The deadline timer is cleared first (a
 * terminal task must never be signalled by a pending timer), and the status
 * migration stays in the same synchronous run as the exit event for a task
 * with no egress session, so a `status()` reader sampling right after the
 * emit never observes a stale "running".
 */
function createSettleClosure(args: {
  readonly task: BackgroundTask;
  readonly record: BackgroundTaskRecord;
  readonly client: MutableClientState;
  readonly persistCommand: string;
  readonly logPath: string;
  readonly registry: BackgroundRegistry;
  readonly disposeEgress: (session: EgressSession | undefined) => Promise<void>;
  readonly log: (msg: string) => void;
}): (status: BackgroundTaskStatus, exitCode: number | null) => Promise<void> {
  const { task, record, client, persistCommand, logPath, registry, log } = args;
  let settled = false;
  return async (status, exitCode) => {
    if (settled) return;
    settled = true;
    if (task.deadlineTimer !== undefined) {
      clearTimeout(task.deadlineTimer);
      task.deadlineTimer = undefined;
    }
    // ADR-0097: the egress session is released inside the settle guard — same
    // lifetime as the task (the child-exit event is the release moment);
    // dispose failures are swallowed, and shutdown()'s convergence step does
    // not re-dispose (this guard is idempotent).
    if (task.egressSession !== undefined) {
      await args.disposeEgress(task.egressSession);
    }
    client.status = status;
    client.exit_code = exitCode;
    const rec: BackgroundTaskRecord = {
      task_id: task.task_id,
      command: persistCommand,
      owner_pid: process.pid,
      conversation_id: record.conversation_id,
      pgid: record.pgid,
      status,
      exit_code: exitCode,
      created_at: record.created_at,
      log_path: logPath,
      ...(record.starttime !== undefined ? { starttime: record.starttime } : {}),
      ...terminalDeadlineFields(task),
    };
    try {
      await registry.save(rec);
    } catch (err) {
      log(
        `background registry save failed on settle: ${
          (err as BackgroundTaskError).context
        }`
      );
    }
  };
}

/**
 * ADR-0134: the cause an exit event carries. A signal death on a task nobody
 * tore down is the process answering a kill that has not been accounted for
 * (the historical `killed` semantics), so it is named `stop_requested`; any
 * other exit is the task finishing on its own. A task that already owns a
 * cause keeps it — a natural exit arriving after a stop request or a deadline
 * cannot relabel the story the trigger already wrote.
 */
function claimExitCause(
  task: BackgroundTask,
  signal: NodeJS.Signals | null
): void {
  if (task.terminationCause !== null) return;
  task.terminationCause =
    signal !== null ? "stop_requested" : "exit";
}

/**
 * ADR-0021 + ADR-0134: assemble the running-state record. The deadline
 * fields are present exactly when a finite budget was supplied, so the
 * persisted shape itself distinguishes a finite job from a persistent service.
 */
function buildSpawnRecord(args: {
  readonly taskId: string;
  readonly persistCommand: string;
  readonly conversationId: string | undefined;
  readonly pgid: number;
  readonly createdAt: string;
  readonly logPath: string;
  readonly starttime: number | undefined;
  readonly timeoutMs: number | undefined;
  readonly deadlineAt: string | null;
}): BackgroundTaskRecord {
  return {
    task_id: args.taskId,
    command: args.persistCommand,
    owner_pid: process.pid,
    conversation_id: args.conversationId ?? "",
    pgid: args.pgid,
    status: "running",
    exit_code: null,
    created_at: args.createdAt,
    log_path: args.logPath,
    ...(args.starttime !== undefined ? { starttime: args.starttime } : {}),
    ...(args.deadlineAt !== null
      ? { timeout_ms: args.timeoutMs, deadline_at: args.deadlineAt }
      : {}),
  };
}

/**
 * ADR-0134: freeze the ONE deadline instant at launch. Derived from
 * `createdAt` (the record's own time-invariant anchor) rather than a second
 * `Date.now()` reading, so the persisted `deadline_at` and the armed timer
 * always name the same instant. A persistent-service request (`timeoutMs`
 * absent) has no deadline at all — null is that contract, not a "not yet".
 */
function freezeDeadlineAt(
  createdAt: string,
  timeoutMs: number | undefined
): string | null {
  if (timeoutMs === undefined) return null;
  return new Date(Date.parse(createdAt) + timeoutMs).toISOString();
}

/**
 * ADR-0134: the launch-fact fields a persisted record carries, shared by the
 * running record, the settle rewrite and the shutdown convergence so all three
 * state the same deadline and the same cause. A persistent-service task
 * contributes nothing here — the absence of these fields IS the signal that no
 * runtime deadline exists.
 */
function terminalDeadlineFields(task: BackgroundTask): Partial<BackgroundTaskRecord> {
  return {
    ...(task.timeoutMs !== null
      ? { timeout_ms: task.timeoutMs, deadline_at: task.deadlineAt as string }
      : {}),
    ...(task.terminationCause !== null
      ? { termination_cause: task.terminationCause }
      : {}),
  };
}

/**
 * ADR-0134: arm the launch-time deadline, once, and only for a finite task.
 * The teardown reuses the stop route (TERM → the same bounded observation →
 * KILL escalation), so a deadline expiry produces the same truthful cleanup
 * evidence an explicit stop produces, with `deadline_expired` as the cause.
 *
 * `unref` keeps a pending deadline from holding the event loop open — the
 * same reason the stop escalation timer is unref'd. Nothing here is ever
 * re-armed: a poll, a log read or a stop request cannot reach this function.
 */
function armTaskDeadline(
  task: BackgroundTask,
  onExpired: () => void
): void {
  if (task.timeoutMs === null) return;
  const timer = setTimeout(() => {
    if (task.client.status !== "running") return;
    onExpired();
  }, task.timeoutMs);
  timer.unref?.();
  task.deadlineTimer = timer;
}

export function createBackgroundTaskManager(
  opts: CreateBackgroundTaskManagerOptions
): BackgroundTaskManager {
  const log = opts.log ?? (() => undefined);
  const registry: BackgroundRegistry = createBackgroundRegistry({
    tasksDir: opts.tasksDir,
    log,
  });
  const tasks = new Map<string, BackgroundTask>();
  /** Reap seam: set of conversation-deletion listeners (zero internal callers here). */
  const conversationDeletedListeners = new Set<
    (conversationId: string) => void
  >();

  /** task_id generation (ADR-0021): `bg-` + 12 random hex digits. */
  function generateTaskId(): string {
    return `bg-${randomBytes(6).toString("hex")}`;
  }

  /**
   * ADR-0097: the single release channel for the egress session — shared by
   * the spawn abnormal path, settle, and the shutdown fallback. dispose is
   * idempotent and failures are swallowed (the manager never reclaims
   * twice); one helper removes per-site try/catch duplication.
   */
  async function disposeEgressQuietly(
    session: EgressSession | undefined
  ): Promise<void> {
    if (session === undefined) return;
    try {
      await session.dispose();
    } catch {
      /* dispose failure swallowed; the manager does not reclaim twice */
    }
  }

  /**
   * ADR-0021: concurrency-cap governance — the in-memory Map counts running
   * status, excluding exited / killed tasks (being reaped / naturally
   * finished tasks do not occupy a slot). Its own function (spawn does
   * orchestration only).
   */
  function countRunningTasks(): number {
    let count = 0;
    for (const t of tasks.values()) {
      if (t.client.status === "running") count += 1;
    }
    return count;
  }

  async function spawn(
    request: BackgroundSpawnRequest
  ): Promise<BackgroundSpawnResult> {
    const invalid = validateRequest(request);
    if (invalid) {
      return { status: "spawn_error", task_id: "", error: invalid };
    }
    // ADR-0021: concurrency-cap governance gate. The in-memory Map counts
    // running status, excluding exited / killed (being reaped / naturally
    // finished tasks do not occupy a slot). No task_id is generated (the
    // task was never created, so register will not write an empty task
    // file). Constructive message discipline (ADR-0021): state the
    // situation + available actions + zero negative wording.
    const runningCount = countRunningTasks();
    if (runningCount >= MAX_CONCURRENT_BACKGROUND_TASKS) {
      return {
        status: "spawn_error",
        task_id: "",
        error: {
          kind: "concurrency_limit_reached",
          context: `spawn: ${runningCount} running tasks (limit ${MAX_CONCURRENT_BACKGROUND_TASKS})`,
          message: `当前已有 ${runningCount} 个 background 任务在运行（上限 ${MAX_CONCURRENT_BACKGROUND_TASKS}）。可用 bash_stop 终止已完成或多余的任务后再启动新任务。`,
        },
      };
    }
    const taskId = generateTaskId();
    const logPath = join(opts.tasksDir, `${taskId}.log`);

    // ADR-0097: egress session assembly (per-task form; see the helper
    // comment).
    const egressSession = await startTaskEgressSession(request, taskId);
    // The spawn factory consumes only spec (spec.env /
    // spec.unixSocketPath / spec.sandboxLocalPort); egressSession.handle is
    // held by the manager and disposed on the settle path. **egressSpec is
    // an internal-convention field**; external callers do not set it (see
    // the BackgroundSpawnRequest.egressSpec comment).
    const spawnRequest: BackgroundSpawnRequest = {
      ...request,
      ...(egressSession !== undefined
        ? { egressSpec: egressSession.spec }
        : {}),
    };

    let child: ChildProcess;
    try {
      child = await opts.spawn(spawnRequest);
    } catch (err) {
      const error: BackgroundTaskError = {
        kind: "io_failure",
        context: `spawn ${taskId}`,
        cause: err instanceof Error ? err.message : String(err),
      };
      log(`background spawn factory threw: ${error.context}`);
      // Abnormal path: the manager already started the egress session before
      // the spawn factory threw, so dispose is mandatory here (ownership:
      // "abnormal and normal paths release through the same channel").
      await disposeEgressQuietly(egressSession);
      return { status: "spawn_error", task_id: taskId, error };
    }
    if (child.pid === undefined) {
      log(`background spawn returned no pid: ${taskId}`);
      // Abnormal path: dispose as above.
      await disposeEgressQuietly(egressSession);
      return {
        status: "spawn_error",
        task_id: taskId,
        error: {
          kind: "io_failure",
          context: `spawn ${taskId}: child has no pid`,
        },
      };
    }

    const starttime = readProcStartTime(child.pid);
    /** Persisted form — background bash passes the placeholder-form value
     *  (placeholders live on disk; real values live only in the spawn call
     *  stack). Other callers (no secret registry / hand-written
     *  manager.spawn paths) default to falling back to command, behavior
     *  unchanged. */
    const persistCommand = request.recordCommand ?? request.command;
    const createdAt = new Date().toISOString();
    // ADR-0134: freeze the ONE deadline here, at launch.
    const deadlineAt = freezeDeadlineAt(createdAt, request.timeoutMs);
    const record = buildSpawnRecord({
      taskId,
      persistCommand,
      conversationId: request.conversationId,
      pgid: child.pid,
      createdAt,
      logPath,
      starttime,
      timeoutMs: request.timeoutMs,
      deadlineAt,
    });

    // Registry json persistence (running state) precedes the return — once
    // spawn resolves the registry is on disk (spawn → registry synchronization
    // contract). Failure = spawn_error(io_failure), and the started detached
    // child is reclaimed immediately (no orphan leak).
    const saveFailure = await saveSpawnRecordOrReap(record, child, registry);
    if (saveFailure !== undefined) {
      // Abnormal path: registry.save failed; the egress session disposes too.
      await disposeEgressQuietly(egressSession);
      return { status: "spawn_error", task_id: taskId, error: saveFailure };
    }

    const client: MutableClientState = {
      status: "running",
      exit_code: null,
      conversation_id: record.conversation_id,
      log_path: logPath,
      command: persistCommand,
    };
    const task: BackgroundTask = {
      task_id: taskId,
      client,
      createdAt: record.created_at,
      child,
      writeChain: Promise.resolve(),
      cleanup: NOT_STARTED_CLEANUP,
      deadlineAt,
      timeoutMs: request.timeoutMs ?? null,
      terminationCause: null,
      // ADR-0097: dispose on the settle path (the session handle is held by
      // the manager, kept out of the registry and the zod schema).
      ...(egressSession !== undefined ? { egressSession } : {}),
    };
    tasks.set(taskId, task);

    // Terminal status transition: driven by the exit event, migrated once.
    const settle = createSettleClosure({
      task,
      record,
      client,
      persistCommand,
      logPath,
      registry,
      disposeEgress: disposeEgressQuietly,
      log,
    });

    armTaskDeadline(task, () => {
      if (claimTermination(task, "deadline_expired")) {
        log(`background deadline expired: ${taskId}`);
      }
      requestTeardown(task, "deadline");
    });

    // Streaming log append: stdout + stderr merge into the same log file.
    // The serialized chain preserves order: each chunk continues off
    // task.writeChain's tail, so concurrent data events never reorder.
    const enqueue = (chunk: Buffer | string): void => {
      task.writeChain = task.writeChain.then(() =>
        appendFile(logPath, chunk, "utf8").catch(() => {
          log(`background log append failed: ${taskId}`);
        })
      );
    };
    child.stdout?.on("data", (chunk: Buffer) => enqueue(chunk));
    child.stderr?.on("data", (chunk: Buffer) => enqueue(chunk));

    child.on("error", (err) => {
      log(`background child error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      // Terminated by signal → killed; natural exit → exited. When the exit
      // event arrives the write queue may still be pending — settle only
      // migrates status + persists json; log flush is drained on the output
      // side.
      claimExitCause(task, signal);
      // The leader's exit says nothing about the tree: a descendant that holds
      // no pipe keeps the group alive, so a teardown's verdict waits for the
      // bounded observation rather than for this event. A natural exit with no
      // teardown requested publishes no stop claim.
      if (task.cleanup.state !== "not_started") {
        void observeTaskGroupGone(
          task,
          task.cleanup.state === "unconfirmed" ? task.cleanup.detail : undefined
        );
      }
      void settle(
        signal !== null ? "killed" : "exited",
        code ?? (signal === null ? 0 : null)
      );
    });

    return { status: "ok", task_id: taskId, log_path: logPath };
  }

  function ensureTask(taskId: string, op: string): BackgroundTask {
    if (taskId.trim().length === 0) {
      throw {
        kind: "empty_task_id",
        context: op,
      } satisfies BackgroundTaskError;
    }
    const task = tasks.get(taskId);
    if (!task) {
      throw {
        kind: "task_not_found",
        context: taskId,
      } satisfies BackgroundTaskError;
    }
    return task;
  }

  /**
   * ADR-0021: conversation scope filter. Reject only when requester and
   * owner are both non-empty and unequal (task_not_in_scope +
   * owner_conversation_id). Other paths (requester absent / empty string /
   * record without conversationId) → no filtering, backward compatible:
   * historical managers had no conversationId error semantics, and entries
   * that had no session assembly injected at spawn time (ask / worker /
   * oneshot) remain visible. The owner field is carried separately; the
   * bash-output / bash-stop handlers render via renderTaskError as
   * `${kind}: ${context}` (typed-error catch contract).
   */
  function assertTaskInScope(
    task: BackgroundTask,
    requesterConversationId: string | undefined,
    op: string
  ): void {
    const owner = task.client.conversation_id;
    if (
      requesterConversationId === undefined ||
      requesterConversationId.length === 0 ||
      owner.length === 0 ||
      requesterConversationId === owner
    ) {
      return;
    }
    throw {
      kind: "task_not_in_scope",
      context: `${op} ${task.task_id} (owner conversation ${owner})`,
      owner_conversation_id: owner,
    } satisfies BackgroundTaskError;
  }

  async function status(taskId: string): Promise<BackgroundStatusResult> {
    const task = ensureTask(taskId, "status");
    return {
      status: task.client.status,
      task_id: taskId,
      exit_code: task.client.exit_code,
      command: task.client.command,
      cleanup: task.cleanup,
      // Projections of the launch-time facts, never recomputed: reading status
      // must not be an observable act on the clock.
      deadline_at: task.deadlineAt,
      cause: task.terminationCause,
    };
  }

  async function output(
    taskId: string,
    maxBytes: number = DEFAULT_LOG_MAX_BYTES,
    requesterConversationId?: string
  ): Promise<BackgroundOutputResult> {
    const task = ensureTask(taskId, "output");
    // ADR-0021: conversation scope filter (req and owner both non-empty and
    // unequal → task_not_in_scope + owner_conversation_id).
    assertTaskInScope(task, requesterConversationId, "output");
    // Drain the serialized write chain: before reading the log file, wait
    // for all queued appendFile calls, avoiding stdout/stderr chunk vs read
    // races.
    await task.writeChain.catch(() => undefined);
    const effectiveMax = Math.min(
      maxBytes > 0 ? maxBytes : DEFAULT_LOG_MAX_BYTES,
      MAX_LOG_READ_BYTES
    );
    let raw: string;
    try {
      raw = await readFile(task.client.log_path, "utf8");
    } catch (err) {
      // The log does not exist yet (spawn just returned, no first chunk) → empty text, not an error.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") raw = "";
      else {
        throw {
          kind: "io_failure",
          context: `output ${taskId}`,
          cause: err instanceof Error ? err.message : String(err),
        } satisfies BackgroundTaskError;
      }
    }
    return {
      text: raw.length > effectiveMax ? raw.slice(-effectiveMax) : raw,
      status: task.client.status,
      exit_code: task.client.exit_code,
      task_id: taskId,
    };
  }

  /**
   * ADR-0134: the one bounded teardown route, shared by an explicit `stop`
   * and a deadline expiry so both produce the same cleanup evidence and the
   * same TERM → grace → KILL escalation. `label` only names the trigger in
   * the log; it never changes what is signalled.
   *
   * Returns false when the task is not teardownable (already terminal, or no
   * child handle) — the caller turns that into the idempotent no-op stop()
   * promises.
   */
  function requestTeardown(
    task: BackgroundTask,
    label: "stop" | "deadline"
  ): boolean {
    if (task.client.status !== "running") return false;
    // A teardown is already in flight for this task: re-signalling would be a
    // second TERM round for one request (duplicate stop, stop racing the
    // deadline), not a new teardown.
    if (task.killFallback !== undefined) return false;
    const child = task.child;
    const pid = child?.pid;
    if (!child || pid === undefined) {
      log(`background ${label}: no child handle for ${task.task_id}`);
      return false;
    }
    // First strike: dual path — the child process alone + the whole process
    // group (under fakes process.kill throws ESRCH on the fake pid and is
    // swallowed; assertions go through the child.kill record).
    let teardownFailure: string | undefined;
    const recordFailure = (detail: string): void => {
      teardownFailure ??= detail;
      log(`background ${label}: ${detail}`);
    };
    try {
      child.kill("SIGTERM");
    } catch {
      /* Dead-process EPIPE / ESRCH ignored */
    }
    sendSignalToProcessGroup(pid, "SIGTERM", recordFailure);
    // SIGKILL fallback: only sent if still running after 2s.
    const killFallback = setTimeout(() => {
      const t = tasks.get(task.task_id);
      if (t && t.client.status === "running" && t.child) {
        try {
          t.child.kill("SIGKILL");
        } catch {
          /* ignored */
        }
        sendSignalToProcessGroup(pid, "SIGKILL", recordFailure);
        void observeTaskGroupGone(t, teardownFailure);
      }
    }, STOP_KILL_GRACE_MS);
    killFallback.unref?.();
    // Record on the task — shutdown() clears the timer before SIGTERM, so
    // the 2s grace window and shutdown's own 5s escalation never re-issue a
    // duplicate SIGKILL.
    task.killFallback = killFallback;
    // The group's fate is observed after the escalation has had its grace
    // window, not by this call: a teardown is a request and returns
    // immediately.
    void waitForProcessGroupGone(pid, STOP_KILL_GRACE_MS).then((gone) =>
      observeTaskGroupGone(task, teardownFailure, gone)
    );
    return true;
  }

  /**
   * Host-side kill(-pgid): SIGTERM → 2s grace → SIGKILL.
   *
   * The returned evidence describes the *request*, never the task's fate:
   * `confirmed_stopped` only when the group was already observed gone before
   * the request; `unconfirmed` while a teardown is in flight. The
   * confirmation of a requested teardown lands on the task's cleanup evidence
   * (read via `status`), after the bounded observation — so a caller that
   * awaits `stop()` is never told the task exited when it did not.
   */
  async function stop(
    taskId: string,
    requesterConversationId?: string
  ): Promise<CleanupEvidence> {
    const task = ensureTask(taskId, "stop");
    // ADR-0021: scope filter (semantics identical to output), checked before the
    // idempotence branch: trying to stop another conversation's task →
    // reject, even if the task already exited (scope outranks idempotence,
    // because idempotence is a legal state while cross-session reach is
    // not).
    assertTaskInScope(task, requesterConversationId, "stop");
    if (task.client.status !== "running") {
      // Idempotence: stop on an already-terminal task = legal no-op (no throw, no second signal).
      return task.cleanup;
    }
    // ADR-0134: claim the cause before the first signal, so a stop that races
    // the deadline or the child's own exit keeps the cause the caller asked
    // for. The claim is single-wins — an already-claimed task keeps its cause.
    claimTermination(task, "stop_requested");
    requestTeardown(task, "stop");
    return NOT_STARTED_CLEANUP;
  }

  /**
   * Publish the bounded observation of a task's process group onto the task.
   *
   * Exit condition: the group was observed gone → `confirmed_stopped`; the
   * window ended with members alive, or a signal failed → `unconfirmed`. The
   * publish is single-wins, so competing stop / exit / escalation events keep
   * the first verdict instead of overwriting it.
   */
  async function observeTaskGroupGone(
    task: BackgroundTask,
    teardownFailure: string | undefined,
    alreadyGone?: boolean
  ): Promise<void> {
    const pid = task.child?.pid;
    if (pid === undefined) return;
    const gone =
      alreadyGone ??
      (await waitForProcessGroupGone(pid, STOP_GROUP_OBSERVE_MS));
    if (task.cleanup.state !== "not_started") return;
    task.cleanup = gone
      ? confirmedStopped(pid, task.task_id)
      : unconfirmedCleanup(
          pid,
          teardownFailure !== undefined
            ? "teardown_failed"
            : "observation_expired",
          teardownFailure ??
            "process group still alive when the bounded observation ended",
          task.task_id
        );
  }

  /**
   * ADR-0097: per-task egress session assembly — the session starts before
   * the spawn factory is called; a failed start → fail-closed (this task
   * runs without an egress session and the fence stays fully offline).
   * Failure paths
   * converge fail-closed: egress is not released and nothing throws
   * (background has no ask surface).
   */
  async function startTaskEgressSession(
    request: BackgroundSpawnRequest,
    taskId: string
  ): Promise<EgressSession | undefined> {
    // ADR-0119 ruling 3: a yolo task starts no egress session — no fence means
    // no netns, so the proxy seam is meaningless; the fence takes bare argv via
    // defaultBackgroundSpawn.
    if (request.yolo === true) return undefined;
    if (request.egressPolicy === undefined) return undefined;
    try {
      return await createEgressSession({ policy: request.egressPolicy });
    } catch (err) {
      log(
        `background egress session start failed for ${taskId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return undefined;
    }
  }

  /**
   * Process-level shutdown (ADR-0021):
   *   1. clear all armed killFallback timers (the stop fallback layer) and
   *      all armed deadline timers (ADR-0134 — a process-wide shutdown ends
   *      every task, so a pending deadline must never fire afterwards)
   *   2. SIGTERM all running process groups (child + group dual path)
   *   3. wait ≤5s grace (child-exit event + escalation timer dual gate)
   *   4. SIGKILL as fallback for groups that did not exit
   *   5. registry json convergence (tasks without an exit event still
   *      running → marked killed; already-settled ones are not overwritten;
   *      best-effort save)
   *   6. clear the in-memory Map
   * Idempotent: the second call sees shuttingDown already set and returns
   * fast on the empty set. Per-group signal errors are swallowed and
   * surfaced via log (no throw, no pollution of other groups).
   */
  let shuttingDown = false;
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    // 1. Collect all running tasks + clear the armed timers (neither the stop
    //    escalation nor a pending deadline may strike after shutdown).
    const running: BackgroundTask[] = [];
    for (const task of tasks.values()) {
      clearTaskTimers(task);
      if (task.client.status === "running") {
        running.push(task);
      }
    }

    if (running.length === 0) {
      tasks.clear();
      return;
    }

    // 2. SIGTERM all running process groups (child + group dual path, errors swallowed).
    for (const task of running) {
      const child = task.child;
      const pid = child?.pid;
      if (!child || pid === undefined) continue;
      try {
        child.kill("SIGTERM");
      } catch {
        /* EPIPE / ESRCH ignored */
      }
      try {
        process.kill(-pid, "SIGTERM");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") {
          log(`background shutdown SIGTERM failed: ${String(err)}`);
        }
      }
    }

    // 3. Wait ≤5s grace (child-exit event + escalation timer dual gate).
    const closed = new Set<BackgroundTask>();
    let resolveExit: () => void = () => undefined;
    const waitForExits = new Promise<void>((resolve) => {
      resolveExit = resolve;
      for (const task of running) {
        const child = task.child;
        if (!child) {
          closed.add(task);
          continue;
        }
        child.once("exit", () => {
          closed.add(task);
          if (closed.size === running.length) resolve();
        });
      }
      // No child listener to attach, or all closed on the spot → resolve immediately
      if (closed.size === running.length) resolve();
    });
    const timer = setTimeout(() => resolveExit(), SHUTDOWN_SIGKILL_GRACE_MS);
    timer.unref?.();
    await waitForExits;
    clearTimeout(timer);

    // 4. SIGKILL fallback for groups that did not exit.
    for (const task of running) {
      if (closed.has(task)) continue;
      const child = task.child;
      const pid = child?.pid;
      if (!child || pid === undefined) continue;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignored */
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* ignored */
      }
    }

    // 5. Registry json convergence: overwrite only still-running tasks
    //    (settled ones already persisted killed/exited via the exit event,
    //    never rewritten). Best-effort save: failures are only logged.
    //    Convergence keeps the original created_at from spawn time (same
    //    semantics as the settle closure) — a persisted record is a
    //    time-invariant entity; created_at marks the task's creation moment
    //    and is not rewritten by shutdown. ADR-0097 shutdown fallback — a
    //    child may still have emitted no exit event after grace + SIGKILL
    //    (the process group is gone but the Node listener never caught it);
    //    then task.egressSession is still held and the session handle must
    //    be explicitly disposed to prevent a leak. Tasks already disposed
    //    on the settle path never reach this branch (their client status was
    //    rewritten by settle != "running").
    for (const task of running) {
      if (task.client.status !== "running") continue;
      task.client.status = "killed";
      task.client.exit_code = null;
      // ADR-0134: a task still running when the host shuts down was ended by
      // the shutdown, not by anything the model asked for. A cause already
      // claimed by an earlier trigger (a stop, a deadline) is kept.
      task.terminationCause ??= "shutdown";
      // ADR-0097: shutdown fallback dispose (session-start exception /
      // settle path never fired).
      await disposeEgressQuietly(task.egressSession);
      const rec: BackgroundTaskRecord = {
        task_id: task.task_id,
        command: task.client.command,
        owner_pid: process.pid,
        conversation_id: task.client.conversation_id,
        pgid: task.child?.pid ?? 0,
        status: "killed",
        exit_code: null,
        created_at: task.createdAt,
        log_path: task.client.log_path,
        ...terminalDeadlineFields(task),
        termination_cause: task.terminationCause,
      };
      try {
        await registry.save(rec);
      } catch (err) {
        log(
          `background registry save failed on shutdown: ${
            (err as BackgroundTaskError).context
          }`
        );
      }
    }

    // 6. Clear the in-memory Map.
    tasks.clear();
  }

  /** Reap seam: register a conversation-deletion listener. No internal callers; registration itself triggers nothing. */
  function registerConversationDeletedListener(
    listener: (conversationId: string) => void
  ): void {
    conversationDeletedListeners.add(listener);
  }

  /** Reap seam: fire the event + call every registered listener. A throwing single listener is swallowed. */
  function onConversationDeleted(conversationId: string): void {
    for (const listener of conversationDeletedListeners) {
      try {
        listener(conversationId);
      } catch (err) {
        log(
          `background conversation-deleted listener threw: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  return Object.freeze({
    spawn,
    status,
    output,
    stop,
    shutdown,
    registerConversationDeletedListener,
    onConversationDeleted,
  });
}
