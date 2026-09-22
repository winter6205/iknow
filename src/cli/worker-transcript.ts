/**
 * Production worker transcript IO for the subagent worker (ADR-0102),
 * injected from the CLI entry seam.
 *
 * Rationale = Gate B direction constraint: the codec and typed-error
 * vocabulary live in session-api/store/worker-transcript (reusing the
 * SessionFileV1 read path = store load/save seam), while the consumer
 * worker lives in src/harness — harness executables must not import
 * session-api (pinned by tests/harness/public-exports.test.ts). So
 * assembly happens here: the `__subagent_worker__` dispatch (cli.ts)
 * constructs the instance and passes it to runSubagentWorker through a
 * narrow interface.
 *
 * Error folding recognises exactly one legal state: `not_found` = fresh
 * worker with no ledger -> `absent`; every other typed kind (io_error /
 * parse_failed / schema_invalid / write_failed) rethrows — a corrupt
 * ledger must never read as absent (a fresh seed would overwrite existing
 * content).
 *
 * The path guard is wired at the factory entry (the
 * `isWorkerTranscriptPathSafe` call site): the envelope is an untrusted
 * input surface; relative paths / empty strings are rejected typed
 * (schema_invalid), leaving no silent channel to write into
 * process.cwd() when the parent mis-computed the path. The throw happens
 * before any fs touch and propagates through wireWorkerTranscript ->
 * worker process exit 2 (protocol-layer crash).
 */
import {
  appendWorkerTranscript,
  isWorkerTranscriptPathSafe,
  loadWorkerTranscript,
  resolveConversationDir,
  type SessionStoreError,
} from "../session-api/store/index.js";
import {
  createPreimageLedger,
  drainPreimageRefs,
  warnUnstampablePreimages,
} from "../session-api/store/preimage-ledger.js";
import { recordPreimagePair } from "../session-api/store/preimage-capture.js";
import { loadIknowSettings } from "../config/settings.js";
import { homedir } from "node:os";
import type {
  WorkerPreimageCaptureFactory,
  WorkerTranscriptIOFactory,
} from "../harness/subagent/worker.js";
import { createSerialQueue } from "../util/serial-queue.js";

/**
 * ADR-0121: the worker process's preimage accumulator, shared by the
 * two host seams assembled in this module — the injected capture port
 * (`createWorkerPreimageCaptureFactory` fills it the moment a write is about
 * to land) and `appendMessages` (drains exactly the committed batch's
 * tool_result ids). One worker process runs exactly one task (the cli
 * dispatch ends in process.exit), so a module-level instance can never
 * cross tasks; the key is (taskId, toolUseId) and the parent hub's identically
 * shaped ledger lives in a different process — no collision surface.
 */
const workerPreimageLedger = createPreimageLedger();

export const storeWorkerTranscriptIo: WorkerTranscriptIOFactory = (loc) => {
  if (!isWorkerTranscriptPathSafe(loc.transcriptPath)) {
    throw {
      kind: "schema_invalid",
      conversation_id: loc.taskId,
      field: "transcript_path",
    } satisfies SessionStoreError;
  }
  // WHY: appendWorkerTranscript is read-modify-write and the store layer
  // deliberately holds no lock (architecture discipline: locks live at the
  // assembly boundary, ADR-0110 single-writer contract). Interleaved
  // concurrent flushPrefix calls from the worker loop would produce duplicate
  // event ids -> worker exit 2. Serialize at this assembly point; queue
  // semantics (FIFO, reject without stalling the chain) in util/serial-queue.
  const serialize = createSerialQueue();
  return {
    loadMessages: () =>
      serialize(async () => {
        try {
          const file = await loadWorkerTranscript({
            transcriptPath: loc.transcriptPath,
            taskId: loc.taskId,
          });
          return { status: "present", messages: file.messages };
        } catch (err) {
          if ((err as { kind?: string }).kind === "not_found") {
            return { status: "absent" };
          }
          throw err;
        }
      }),
    appendMessages: (events, thinkingMs) =>
      serialize(async () => {
        // Drain inside the queue so the consume ↔ append pair stays ordered
        // like the parent's hub serialize → appendEvents pair. A ref that
        // cannot land on this batch's events is warned to stderr (the worker's
        // human-visible channel; stdout carries only envelopes).
        const preimages = drainPreimageRefs(
          workerPreimageLedger,
          loc.taskId,
          events,
          (unstamped) => warnUnstampablePreimages(loc.taskId, unstamped)
        );
        await appendWorkerTranscript({
          location: { transcriptPath: loc.transcriptPath, taskId: loc.taskId },
          events,
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
          ...(preimages !== undefined ? { preimages } : {}),
          cwd: loc.cwd,
        });
      }),
  };
};

/**
 * ADR-0121: build the cli entry's `WorkerPreimageCaptureFactory` — the
 * worker-side sibling of `createPreimageCapture` (parent path).
 *
 * The asymmetry against the parent implementation is deliberate: a worker's
 * write tools see ctx.conversationId = taskId, but the worker has NO leaf in
 * the project pool (ADR-0102) — so blobs key under the PARENT session folder
 * (`resolveConversationDir` over the envelope's todoLedger anchor) while the
 * ledger keys under taskId so only this task's transcript commit drains it.
 * Content-addressed `wx` blobs dedupe against the parent's own captures.
 *
 * `codeRestore.enabled` is resolved from the user layer once per factory
 * call (= once per worker process), matching the parent hub's
 * startup-settings snapshot. `userHome` is a test seam to keep fixtures off
 * the real user dir (mirrors CreateWorkerDepsOptions.userHome).
 */
export function createWorkerPreimageCaptureFactory(opts?: {
  readonly userHome?: string;
}): WorkerPreimageCaptureFactory {
  return (loc) => {
    const settings = loadIknowSettings({
      home: opts?.userHome ?? homedir(),
    });
    const enabled = settings.codeRestore?.enabled !== false;
    const { projectDir, conversationId: parentConversationId } =
      loc.parentLedger;
    return async (input) => {
      if (!enabled) return;
      const { toolUseId } = input;
      // No tool_use_id → nothing to key a later stamp on; skipping the blob
      // keeps the ledger's "never a wrong stamp" posture (same guard as the
      // parent's createPreimageCapture).
      if (toolUseId === undefined) return;
      await recordPreimagePair({
        sessionFolder: resolveConversationDir({
          projectDir,
          conversationId: parentConversationId,
        }),
        ledger: workerPreimageLedger,
        ledgerKey: loc.taskId,
        toolUseId,
        input,
      });
    };
  };
}

/** The instance the production entry (`runSubagentWorker`) receives. */
export const storeWorkerPreimageCapture: WorkerPreimageCaptureFactory =
  createWorkerPreimageCaptureFactory();
