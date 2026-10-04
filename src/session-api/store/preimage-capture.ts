/**
 * Host-side `PreimageCapture` (session-api) — the concrete implementation the
 * assembly injects into the harness write tools. It lives here (not in the
 * harness) because it reaches both the blob store and the session-folder
 * derivation; Gate B keeps the harness importing only the port type, never
 * session-api. The harness hands this closure an already-constructed
 * `PreimageCapture` via `BuildEngineOpts.preimageCapture`.
 *
 * Two durability obligations meet here (ADR-0136, spec §3):
 *   1. The BYTES are captured as content-addressed blobs.
 *   2. The ASSOCIATION between those blobs and this tool call is appended to
 *      the session log as a `file_intent` record, DURABLY, before the caller
 *      is allowed to mutate the target.
 *
 * (2) is what closes the gap the in-memory ledger cannot: the ledger is
 * keyed `(conversationId, toolUseId)` and last-write-wins, and the
 * `tool_result` event that would carry the ref does not exist yet at capture
 * time — so without (2) a crash between capture and result leaves blobs on
 * disk that nothing points at.
 *
 * A throw from `captureCodeSnapshot` — or from the intent append — propagates
 * to the write tool and aborts the pending workspace write. The tool must not
 * swallow it: a write whose evidence is not durable must not happen.
 *
 * `recordPreimagePair` is the shared capture body; the worker transcript's
 * port (src/cli/worker-transcript.ts) calls it too, against the parent session
 * folder, so blob layout and ref shape stay single-sourced here.
 */
import type {
  PreimageCapture,
  PreimageCaptureInput,
} from "../../harness/aci/preimage-port.js";
import type { FileIntentTarget } from "../../shared/native-state-port.js";
import type { NativeStatePort } from "../../shared/native-state-port.js";
import { captureCodeSnapshot } from "./code-snapshot-store.js";
import type { PreimageLedgerHost } from "./preimage-ledger.js";
import { resolveConversationDir } from "./session-store.js";
import type { PreimageRef } from "./jsonl.js";

/** The subset of the neutral port this capture needs. Structural, so a host
 *  can hand over the whole `NativeStatePort` or a test double of just this
 *  method. Absent → capture keeps today's blob+ledger-only behavior. */
export type FileIntentRecorder = Pick<NativeStatePort, "recordFileIntent">;

export function createPreimageCapture(deps: {
  readonly getProjectDir: () => string;
  readonly ledger: PreimageLedgerHost;
  /** `settings.codeRestore.enabled !== false`, resolved per call so a config
   *  flip takes effect without rebuilding the engine. */
  readonly isEnabled: () => boolean;
  /** Durable per-file intent writer. Wired by the host that owns the parent
   *  session's store. */
  readonly intentRecorder?: FileIntentRecorder;
}): PreimageCapture {
  return async (input: PreimageCaptureInput): Promise<void> => {
    const { conversationId, toolUseId } = input;
    // An intent needs both routing ids: it is anchored at the parent
    // session's persisted head and keyed by the tool call.
    if (conversationId === undefined || toolUseId === undefined) return;
    if (!deps.isEnabled()) {
      // SC9a: suppression must not become silence. The write stays
      // permitted and no blob is created, but the effect is recorded as
      // uncaptured so recovery reports it UNVERIFIED instead of inferring
      // completion from a missing record.
      await recordIntent(deps, {
        conversationId,
        toolUseId,
        captured: false,
        target: uncapturedTarget(input),
      });
      return;
    }
    const ref = await recordPreimagePair({
      sessionFolder: resolveConversationDir({
        projectDir: deps.getProjectDir(),
        conversationId,
      }),
      ledger: deps.ledger,
      ledgerKey: conversationId,
      toolUseId,
      input,
    });
    // After the blobs, before the caller mutates: this append is awaited, so
    // a failure here aborts the write with the target untouched.
    await recordIntent(deps, {
      conversationId,
      toolUseId,
      captured: true,
      target: {
        relPath: input.relPath,
        rootIdentity: input.rootIdentity,
        absentBefore: input.absentBefore,
        preimageSha: ref.preimageSha,
        postimageSha: ref.postimageSha,
      },
    });
  };
}

/**
 * Capture both byte sides of one write as blobs and record the ref under the
 * key the commit side drains with. Shared by the parent session's capture port
 * and the worker's: they differ only in which session folder holds the blobs
 * and which ledger key the later `tool_result` is stamped onto, so the blob
 * layout and the ref shape have exactly one owner. Returns the ref so the
 * caller can persist the same facts durably.
 */
export async function recordPreimagePair(opts: {
  readonly sessionFolder: string;
  readonly ledger: PreimageLedgerHost;
  readonly ledgerKey: string;
  readonly toolUseId: string;
  readonly input: PreimageCaptureInput;
}): Promise<PreimageRef> {
  const { sessionFolder, ledger, ledgerKey, toolUseId, input } = opts;
  const preimageSha = await captureCodeSnapshot(sessionFolder, input.preBytes);
  const postimageSha = await captureCodeSnapshot(
    sessionFolder,
    input.postBytes
  );
  const ref: PreimageRef = {
    relPath: input.relPath,
    rootIdentity: input.rootIdentity,
    preimageSha,
    postimageSha,
    // Conditional spread: a false (the common edit) leaves the ref
    // byte-identical to legacy lines — one schema, absence recorded only by
    // the capture-time evidence (ADR-0121).
    ...(input.absentBefore ? { absentBefore: true } : {}),
  };
  ledger.set(ledgerKey, toolUseId, ref);
  return ref;
}

/** ONE record per captured target. A multi-file call's port runs once per
 *  target, so a later reader groups by `toolUseId` to recover the operation's
 *  full target set — which the last-write-wins ledger cannot express. */
async function recordIntent(
  deps: { readonly intentRecorder?: FileIntentRecorder },
  request: {
    readonly conversationId: string;
    readonly toolUseId: string;
    readonly captured: boolean;
    readonly target: FileIntentTarget;
  }
): Promise<void> {
  if (deps.intentRecorder === undefined) return;
  await deps.intentRecorder.recordFileIntent({
    conversationId: request.conversationId,
    toolUseId: request.toolUseId,
    captured: request.captured,
    targets: [request.target],
  });
}

/** The association a suppressed capture can still make: where the write was
 *  going and whether the path existed. No `preimageSha` / `postimageSha` keys
 *  at all — a record must never claim evidence that was not kept. */
function uncapturedTarget(input: PreimageCaptureInput): FileIntentTarget {
  return {
    relPath: input.relPath,
    rootIdentity: input.rootIdentity,
    absentBefore: input.absentBefore,
  };
}
