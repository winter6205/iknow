/**
 * The host-side session-open contract (ADR-0136 §4, spec §2.1 / §4).
 *
 * Three hosts open sessions — the hub behind serve/HTTP, the CLI chat resume
 * path, and the TUI — and each used to decide the live write root, run recovery,
 * and choose what the next turn's model context is on its own. They drifted: the
 * chat path restored the published state while the hub computed it and threw it
 * away, a damaged log reached two hosts as a raw store error instead of the
 * `blocked` status, and the reconciled per-file detail stopped at the store
 * boundary. One implementation here removes the divergence rather than patching
 * it three times.
 *
 * Read-only by construction: `openSessionWithRecovery` writes no file, dispatches
 * no model request and no tool, moves no rewind head, restores no permission
 * grant, and never falls back to transcript reconstruction or an older state.
 */

import { RECOVERY_IN_PROGRESS_LABEL } from "./store/recovery-status.js";
import type {
  RecoveryInProgressLabel,
  RecoveryStatus,
} from "./store/recovery-status.js";
import { recoverSession } from "./store/recovery.js";
import type { SessionRecoveryReport } from "./store/recovery.js";
import type { RecoveredFileOperation } from "./store/recovery-reconcile.js";
import type { SessionStore } from "./store/session-store.js";
import type { SessionStoreError } from "./store/errors.js";
import type { SessionFileV1 } from "./store/schema.js";
import type { OwnedWorkerSweepResult } from "../harness/subagent/worker-identity-stop.js";
import type { NativeStateMessage } from "../shared/native-state-port.js";

/**
 * The inputs one host supplies for the live write root. The PRECEDENCE and the
 * "never empty" guarantee live in `resolveLiveRoot`, so no host re-derives
 * them; what differs per host is only which facts it can see.
 *
 * `dirtyRoot` is the hub's dirty-worktree record. A host with no public read of
 * it (the TUI) omits it, which means a post-rebind intent may be measured
 * against the pre-rebind root: reconcile then reports `needs handling` /
 * `root_identity_mismatch`. That fails toward VISIBLE — no mutation, and never
 * a false `recovered`.
 */
export interface LiveRootInput {
  /** The host's own record of a rebound worktree; hub only. */
  readonly dirtyRoot?: string;
  /** The session file's own recorded root. */
  readonly recordedRoot?: string;
  /** The root the host bound itself to. */
  readonly boundRoot?: string;
  /** Last resort: the session's recorded cwd, or the host's process cwd when
   * the session file itself could not be read. Required, so the resolved root
   * is never the empty string that would resolve every recorded `relPath`
   * against nothing. */
  readonly cwd: string;
}

/**
 * THE live write root decision (spec: one host-supplied decision, not three).
 * A recorded `relPath` resolves against the result, and a wrong root can only
 * make reconcile read live bytes from the wrong place — which it reports as
 * `needs handling` instead of mutating.
 */
export function resolveLiveRoot(input: LiveRootInput): string {
  return input.dirtyRoot ?? input.recordedRoot ?? input.boundRoot ?? input.cwd;
}

/** Per-host live-root and identity derivation, resolved once per open. */
export interface SessionOpenRoots {
  /** Resolve the live write root. `file` is null when the session file itself
   * could not be read, so a damaged log still reaches the classification. */
  readonly resolve: (file: SessionFileV1 | null) => string;
  /** Identity of the resolved root, from the host's own single derivation
   * (the hub's `rootIdentityFor`, `mainCheckoutOf` elsewhere). Recovery must
   * not re-derive it: a second derivation could compare unequal to every
   * captured identity. */
  readonly identityOf: (liveRoot: string) => string;
}

export interface OpenSessionWithRecoveryInput {
  readonly store: SessionStore;
  readonly conversationId: string;
  readonly roots: SessionOpenRoots;
  /** Host transient shown while this call is in flight. */
  readonly onProgress?: (label: RecoveryInProgressLabel) => void;
  /**
   * REQUIRED owned-worker sweep capability (spec §4, SC16-SC17): prove — or
   * refuse to claim — that this session's workers are gone.
   *
   * ORDERING REQUIREMENT, and it is the reason this option lives here rather
   * than inside the store: the sweep runs BEFORE the report is built, so the
   * report describes the world AFTER it. A worker whose stop the sweep proved
   * is not reported as needing handling; one it could not prove still is.
   *
   * Required, not optional: an omitted sweep is indistinguishable at the report
   * from a sweep that ran and found nothing, so an optional field let a host
   * silently drop the only stop proof in the system (the TUI bridge and the CLI
   * chat path both did). A host with genuinely nothing to sweep passes an
   * explicit empty result — every worker then carries no stop proof, which
   * reads as needing handling, never as stopped.
   *
   * The sweep is the HOST's to run: this function still issues no signal of
   * its own, writes no file, moves no head, restores no grant, and dispatches
   * no model or tool call.
   */
  readonly sweepOwnedWorkers: (
    conversationId: string
  ) => Promise<OwnedWorkerSweepResult>;
}

/**
 * One session open. DERIVED from the store's report rather than re-listed, so a
 * report field added later reaches every host instead of being silently dropped
 * by one of them.
 */
export interface SessionOpenRecovery extends SessionRecoveryReport {
  /** The live write root this recovery reconciled against. */
  readonly liveRoot: string;
  /**
   * The published body's exact native context — the next turn's model context —
   * or null when nothing was restored. A host must never infer this from
   * `savedMessageCount` or from a transcript projection.
   */
  readonly restoredContext: ReadonlyArray<NativeStateMessage> | null;
  /**
   * The session file, for DISPLAY and for the post-turn projection. Null when
   * the log is unreadable: a damaged log reaches the operator as `blocked`
   * instead of as a raw store error, and no transcript is reconstructed.
   */
  readonly file: SessionFileV1 | null;
}

type SessionRead =
  { readonly file: SessionFileV1 } | { readonly error: SessionStoreError };

/**
 * Open one session and classify how it recovers.
 *
 * The classification runs against a TOLERANT read, because a strict
 * `SessionStore.load` throws `parse_failed` on exactly the damaged committed
 * record the spec requires to surface as `blocked` (SC1a) — loading first would
 * make the required status unreachable.
 */
export async function openSessionWithRecovery(
  input: OpenSessionWithRecoveryInput
): Promise<SessionOpenRecovery> {
  const { store, conversationId } = input;
  input.onProgress?.(RECOVERY_IN_PROGRESS_LABEL);
  const read = await readSessionFile(store, conversationId);
  if ("error" in read && read.error.kind === "not_found") {
    // EXIT: entry-addressed-a-missing-conversation — no variant of the status
    // vocabulary describes a conversation that does not exist, so the typed
    // error stands. Every host raised this before recovery existed.
    throw read.error;
  }
  const file = "file" in read ? read.file : null;
  const liveRoot = input.roots.resolve(file);
  // BEFORE the report, so the report describes the post-sweep world. A sweep
  // fault propagates: a report claiming a worker was stopped when the sweep
  // never ran is the exact false recovery this contract forbids.
  const workerSweep = await input.sweepOwnedWorkers(conversationId);
  const report = await classify(input, liveRoot, file !== null, workerSweep);
  return {
    ...report,
    liveRoot,
    restoredContext: restoredContextOf(report),
    file,
  };
}

/**
 * The published state becomes the next turn's model context only when the tail
 * after its anchor was never settled. A settled turn's own committed protocol
 * (its answer, its settled tool results) is legitimate conversation history and
 * is NOT discarded; an unsettled tail is unacknowledged work — including the
 * store's synthesized closeout `tool_result` for an orphaned `tool_use` — and
 * restoring the published state is the only honest base (spec §2.1: "Do not
 * rebuild from the transcript").
 */
function restoredContextOf(
  report: SessionRecoveryReport
): ReadonlyArray<NativeStateMessage> | null {
  const restorable =
    report.status.status === "recovered" ||
    report.status.status === "needs handling";
  return restorable && report.outcome.state === "unknown"
    ? report.messages
    : null;
}

async function classify(
  input: OpenSessionWithRecoveryInput,
  liveRoot: string,
  sessionExists: boolean,
  workerSweep: OwnedWorkerSweepResult
): Promise<SessionRecoveryReport> {
  try {
    return await recoverSession({
      store: input.store,
      conversationId: input.conversationId,
      taskRoot: liveRoot,
      liveRootIdentity: input.roots.identityOf(liveRoot),
      workerSweep,
    });
  } catch (err) {
    return unrecoverable(input.conversationId, err, sessionExists);
  }
}

/**
 * `recoverSession` resolves every unusable-published-state case to a visible
 * status and rethrows only what is not a recovery state. Both of those reach
 * here, and neither may be swallowed.
 */
function unrecoverable(
  conversationId: string,
  err: unknown,
  sessionExists: boolean
): SessionRecoveryReport {
  if (!isTypedStoreError(err)) {
    // EXIT: unknown-faults-surface — the store contract is typed; an untyped
    // throw is a bug, and mislabelling it would hide it.
    throw err;
  }
  if (err.kind === "not_found" && sessionExists) {
    // EXIT: no-event-log-behind-a-readable-session — the session file loaded, so
    // the selection read had no log to select a published state out of: an
    // old-format session whose bytes stay untouched.
    return unrecoverableReport(conversationId, {
      status: "unsupported_format",
    });
  }
  // EXIT: real-io-faults-are-not-a-recovery-state — an unreadable directory is
  // a fault, not an operator verdict. No status describes it, so it propagates.
  throw err;
}

const unrecoverableReport = (
  conversationId: string,
  status: RecoveryStatus
): SessionRecoveryReport => ({
  conversationId,
  status,
  messages: [],
  savedMessageCount: 0,
  operations: [],
  outcome: { state: "unknown", reason: "no_record" },
  runtime: null,
  operationFacts: null,
});

/**
 * Read the session file, tolerating a damaged log so the classification can
 * still run. Mirrors the tolerance `seedResumeMessages` has always had: typed
 * errors become a value, an unknown throw still surfaces.
 */
async function readSessionFile(
  store: SessionStore,
  conversationId: string
): Promise<SessionRead> {
  try {
    return { file: await store.load(conversationId) };
  } catch (err) {
    if (!isTypedStoreError(err)) throw err;
    return { error: err };
  }
}

/** Narrow a throw to a typed store error vs any other failure. */
export function isTypedStoreError(err: unknown): err is SessionStoreError {
  if (err === null || typeof err !== "object") return false;
  const kind = (err as { readonly kind?: unknown }).kind;
  return (
    kind === "write_failed" ||
    kind === "not_found" ||
    kind === "parse_failed" ||
    kind === "schema_invalid" ||
    kind === "io_error" ||
    kind === "concurrent_write"
  );
}

/**
 * The identifying detail of a typed store error, for a host's operator line.
 *
 * A `SessionStoreError` is a plain object by contract, so `String(err)` on one
 * is `"[object Object]"` and `instanceof Error` is false — every host's error
 * printer has to name it deliberately or it renders a garbage message. Lives
 * beside `isTypedStoreError` so the guard and the formatter cannot drift.
 */
export function storeErrorDetail(err: SessionStoreError): string {
  switch (err.kind) {
    case "parse_failed":
      return `${err.conversation_id}: ${err.reason}`;
    case "schema_invalid":
      return `${err.conversation_id}: field ${err.field}`;
    case "write_failed":
    case "io_error":
      return `${err.conversation_id}: ${err.cause}`;
    default:
      return err.conversation_id;
  }
}

/**
 * One line of per-operation detail for the existing status line (SC11): every
 * operation's settlement and every target's verdict. A `recovered` verdict that
 * hides which files were verified, not replaced, or still unknown is exactly
 * what this closes.
 */
export function formatRecoveredOperations(
  operations: ReadonlyArray<RecoveredFileOperation>
): string {
  return operations
    .map((op) => {
      const targets =
        op.targets.length === 0
          ? "no targets"
          : op.targets.map((t) => `${t.relPath}=${t.state}`).join(", ");
      return `${op.toolUseId} ${op.settlement} [${targets}]`;
    })
    .join("; ");
}
