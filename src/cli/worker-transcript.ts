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
import { captureCodeSnapshot } from "../session-api/store/code-snapshot-store.js";
import { createPreimageLedger } from "../session-api/store/preimage-ledger.js";
import type { PreimageRef } from "../session-api/store/jsonl.js";
import { loadIknowSettings } from "../config/settings.js";
import { homedir } from "node:os";
import type { AnthropicNativeMessage } from "../harness/index.js";
import type {
  WorkerPreimageCaptureFactory,
  WorkerTranscriptIOFactory,
} from "../harness/subagent/worker.js";
import { createSerialQueue } from "../util/serial-queue.js";

/**
 * ADR-0119 (T3): the worker process's preimage accumulator, shared by the
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
        // like the parent's hub serialize → appendEvents pair.
        const preimages = pullWorkerPreimages(loc.taskId, events);
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
 * Mirror of SessionHub.pullPreimages (the parent's commit-side drain): pull
 * exactly the ledger refs whose tool_use_id appears in this batch's
 * tool_result blocks. Undefined when nothing was captured in-batch, keeping
 * the append byte-identical to the pre-capture shape.
 */
function pullWorkerPreimages(
  taskId: string,
  events: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyMap<string, PreimageRef> | undefined {
  const ids: string[] = [];
  for (const message of events) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_result") ids.push(block.tool_use_id);
    }
  }
  if (ids.length === 0) return undefined;
  const consumed = workerPreimageLedger.consume(taskId, ids);
  return consumed.size > 0 ? consumed : undefined;
}

/**
 * ADR-0119 (T3): build the cli entry's `WorkerPreimageCaptureFactory` — the
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
      const sessionFolder = resolveConversationDir({
        projectDir,
        conversationId: parentConversationId,
      });
      const preimageSha = await captureCodeSnapshot(
        sessionFolder,
        input.preBytes
      );
      const postimageSha = await captureCodeSnapshot(
        sessionFolder,
        input.postBytes
      );
      workerPreimageLedger.set(loc.taskId, toolUseId, {
        relPath: input.relPath,
        rootIdentity: input.rootIdentity,
        preimageSha,
        postimageSha,
      });
    };
  };
}

/** The instance the production entry (`runSubagentWorker`) receives. */
export const storeWorkerPreimageCapture: WorkerPreimageCaptureFactory =
  createWorkerPreimageCaptureFactory();
