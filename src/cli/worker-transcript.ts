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
  type SessionStoreError,
} from "../session-api/store/index.js";
import { createSerialQueue } from "../util/serial-queue.js";
import type { WorkerTranscriptIOFactory } from "../harness/subagent/worker.js";

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
        await appendWorkerTranscript({
          location: { transcriptPath: loc.transcriptPath, taskId: loc.taskId },
          events,
          ...(thinkingMs !== undefined ? { thinkingMs } : {}),
          cwd: loc.cwd,
        });
      }),
  };
};
