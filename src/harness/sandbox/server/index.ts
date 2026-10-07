/**
 * Same-process router for the sandbox execution plane.
 *
 // (ADR-0045)
 *
 * Shape: mountable factory (same pattern as createTraceRouter in the trace
 * server). No socket / no fork / no daemon — all three consumers (bash
 * foreground / verify / background) live in one Node process, and harness
 * assembly holds a single router reference.
 *
 * Two protocol shapes (message contracts in ./types.ts):
 *   - exec(req): short-lived request/response, waits for the child to exit for
 *     a one-shot result.
 *   - spawn(req): long-lived task handle, resolves task_id synchronously; the
 *     handle exposes a stdout/stderr/exit/stopped AsyncIterable + a stop
 *     control message (SIGTERM → graceMs → SIGKILL escalation).
 *
 * Fault paths are thrown as the SandboxServerError discriminated union in
 *
 // (ADR-0045)
 * ./types.ts and clients branch on kind. Overflow is folded into the
 * truncateByCodePoint contract, so it throws no typed error. Fail-loud
 * discipline: an unreachable server fails loud as a typed error, never
 * silently degrades; a ctx.signal abort must not merely drop the promise —
 * the spawn protocol cancels via the stop control message and the exec
 * protocol forwards the AbortSignal down to spawnWithStopSignal (runner.ts).
 *
 * During migration, runInSandbox (runner.ts) and defaultBackgroundSpawn
 * (manager.ts) degrade to thin wrappers around router handlers rather than
 * being deleted (30+ existing fixtures depend on them). This file does not
 * re-implement spawn logic — it still goes through spawnWithStopSignal in
 * runner.ts and the nodeSpawn path in manager.ts.
 */

import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  signalExitCode,
  truncateByCodePoint,
} from "../runner.js";
import { spawnWithStopSignal } from "../runner.js";
import type { SandboxServerError } from "./types.js";
import type {
  ExecRequest,
  ExecResponse,
  SandboxTaskHandle,
  SpawnRequest,
} from "./types.js";
import {
  assembleHandle,
  createEventChannel,
  createOrphanSettler,
  createStopHandle,
  DEFAULT_GROUP_OBSERVE_MS,
  DEFAULT_KILL_GRACE_MS,
  logPathFor,
  makeLogWriter,
  newTaskId,
  onChildClose,
  onChildError,
  spawnDetached,
  wireAbortSignal,
  wireChildStreamHandlers,
} from "./spawn.js";

/** Same-process router shape: no observable state, no server, no socket, no fork. */
export interface SandboxServer {
  readonly exec: (req: ExecRequest) => Promise<ExecResponse>;
  readonly spawn: (req: SpawnRequest) => Promise<SandboxTaskHandle>;
}

/** Factory options — currently a placeholder (ADR-0045): violation-handling stays on the
 *  client side and out of the server; if process-level governance is ever
 *  needed it is added here, and the factory still has no server shape. */
export interface CreateSandboxServerOptions {
  /** Log for spawn failures inside the router; silent by default. */
  readonly log?: (msg: string) => void;
}

/**
 * fence + cwd validation — shared by exec and spawn. An empty frame fails loud
 * as a typed error without spawning (the empty fault path).
 *
 // (ADR-0045)
 */
function validateFenceAndCwd(
  req: ExecRequest | SpawnRequest,
  op: "exec" | "spawn"
): void {
  if (
    !req.fence ||
    !Array.isArray(req.fence.argv) ||
    req.fence.argv.length === 0
  ) {
    throw {
      kind: "empty_request",
      context: `${op}: fence missing or has empty argv`,
    } satisfies SandboxServerError;
  }
  if (typeof req.cwd !== "string" || req.cwd.length === 0) {
    throw {
      kind: "empty_request",
      context: `${op}: cwd required`,
    } satisfies SandboxServerError;
  }
}

/** The frame fields that carry a bounded numeric budget and are range-checked on both protocols. */
type NumericArgField = "maxOutputCodePoints" | "killGraceMs" | "groupObserveMs";

/** Checked in this order, so the first offending field is the one reported. */
const NUMERIC_ARG_FIELDS: readonly NumericArgField[] = Object.freeze([
  "maxOutputCodePoints",
  "killGraceMs",
  "groupObserveMs",
]);

/**
 * Read the three budgets off either request shape. maxOutputCodePoints is
 * exec-only, so a key that is absent from the frame yields undefined — the same
 * "not supplied, apply the default" state an explicit undefined carries. The
 * cast is the price of validating one table against two request shapes; the
 * types in ./types.ts remain the authority on what each field means.
 */
function numericArgsOf(
  req: ExecRequest | SpawnRequest
): Readonly<Record<NumericArgField, number | undefined>> {
  return req as unknown as Readonly<
    Record<NumericArgField, number | undefined>
  >;
}

/** Negative / non-integer argument validation — passes the RangeError through for the client to catch. */
function validateNumericArgs(
  req: ExecRequest | SpawnRequest,
  op: "exec" | "spawn"
): void {
  const args = numericArgsOf(req);
  for (const field of NUMERIC_ARG_FIELDS) {
    const value = args[field];
    // Absent or explicitly undefined → the protocol default applies, nothing to check.
    if (value === undefined) continue;
    if (Number.isInteger(value) && value >= 0) continue;
    throw {
      kind: "negative_argument",
      context: `${op}: ${field}=${value} must be a non-negative integer`,
      cause: new RangeError(`${field} must be a non-negative integer`),
    } satisfies SandboxServerError;
  }
}

/**
 * factory — no server, no shared mutable state; the caller holds one router
 * reference from assembly time and the three consumers (bash foreground /
 * verify / background) share it. Mirrors the createTraceRouter shape.
 */
export function createSandboxServer(
  opts: CreateSandboxServerOptions = {}
): SandboxServer {
  const log = opts.log ?? (() => undefined);

  // ─── short-lived exec ────────────────────────────────────────────────
  async function exec(req: ExecRequest): Promise<ExecResponse> {
    validateFenceAndCwd(req, "exec");
    validateNumericArgs(req, "exec");
    // Even a pre-aborted signal goes through exec: the handler forwards the
    // signal straight to spawnWithStopSignal (runner.ts). Here we only validate
    // frame integrity; the fence's argv is already frozen.
    const maxOutputCodePoints =
      req.maxOutputCodePoints ?? DEFAULT_MAX_OUTPUT_CODE_POINTS;
    const { done } = spawnWithStopSignal(
      req.fence.argv[0] as string,
      req.fence.argv.slice(1),
      {
        cwd: req.cwd,
        signal: req.signal,
        env: req.env,
        killGraceMs: req.killGraceMs,
        groupObserveMs: req.groupObserveMs,
        ...(req.deadlineMs !== undefined ? { deadlineMs: req.deadlineMs } : {}),
      }
    );
    try {
      const result = await done;
      return {
        exitCode: result.code ?? signalExitCode(result.signal),
        stdout: truncateByCodePoint(result.stdout, maxOutputCodePoints),
        stderr: truncateByCodePoint(result.stderr, maxOutputCodePoints),
        // Signal-terminated runs report the name next to 128+N; the exit code
        // alone cannot say whether 137 came from the bounded teardown or from
        // the command itself.
        ...(result.signal !== null ? { signal: result.signal } : {}),
        ...(result.cleanup !== undefined ? { cleanup: result.cleanup } : {}),
        ...(result.deadlineExpired === true ? { deadline_expired: true } : {}),
      };
    } catch (cause) {
      // exception: child exited without acknowledgement / spawn failed — typed
      // fail-loud, no silent degradation. Orphan process-group reaping stays
      // with spawnWithStopSignal (which already manages abort / kill
      // escalation); here we only turn a spawn failure into a typed error.
      throw {
        kind: "server_unreachable",
        context: `exec: spawn failed for fence argv[0]=${String(req.fence.argv[0])}`,
        cause,
      } satisfies SandboxServerError;
    }
  }

  // ─── long-lived spawn ────────────────────────────────────────────────
  function spawn(req: SpawnRequest): Promise<SandboxTaskHandle> {
    validateFenceAndCwd(req, "spawn");
    validateNumericArgs(req, "spawn");
    const killGraceMs = req.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const groupObserveMs = req.groupObserveMs ?? DEFAULT_GROUP_OBSERVE_MS;
    const task_id = newTaskId();
    const log_path = logPathFor(req.cwd, task_id);
    return runSpawnNode(
      req,
      task_id,
      log_path,
      killGraceMs,
      groupObserveMs,
      log
    );
  }

  return { exec, spawn };
}

/** The spawn node — owns the process + event channel + stop escalation. All failures surface as typed errors. */
function runSpawnNode(
  req: SpawnRequest,
  task_id: string,
  log_path: string,
  killGraceMs: number,
  groupObserveMs: number,
  log: (msg: string) => void
): Promise<SandboxTaskHandle> {
  return new Promise<SandboxTaskHandle>((resolveHandle, rejectHandle) => {
    const child = spawnDetached(req.fence.argv, req.cwd, req.env);
    const pgid = child.pid;
    const channel = createEventChannel();
    const writer = makeLogWriter(log_path, task_id, log);
    const orphan = createOrphanSettler(
      child,
      pgid,
      task_id,
      channel,
      rejectHandle,
      log
    );
    const stopHandle = createStopHandle(
      child,
      pgid,
      task_id,
      killGraceMs,
      log,
      channel,
      groupObserveMs
    );
    wireChildStreamHandlers(child, channel, writer);
    onChildError(child, orphan, task_id, log);
    onChildClose(child, channel, orphan, stopHandle);
    wireAbortSignal(req.signal, stopHandle, killGraceMs);
    const handle = assembleHandle(task_id, log_path, channel, stopHandle);
    // Defer resolveHandle by one tick (setImmediate) so a spawn failure's
    // child.once("error") reaches orphan.settled → rejectHandle first;
    // otherwise resolve would win, the reject would be swallowed, and the typed
    // orphan_process_group would be unobservable (fail-loud broken).
    setImmediate(() => {
      if (!orphan.settled) resolveHandle(handle);
    });
  });
}

/** Internals not exposed; consumers get the handle and call stop() / events(). */
export type {
  ExecRequest,
  ExecResponse,
  SpawnRequest,
  SandboxTaskEvent,
  SandboxTaskHandle,
  SandboxServerError,
  QueuedTaskEvent,
} from "./types.js";
export { renderSandboxServerError } from "./types.js";
export type {
  CleanupEvidence,
  CleanupUnconfirmedReason,
} from "../cleanup-result.js";
