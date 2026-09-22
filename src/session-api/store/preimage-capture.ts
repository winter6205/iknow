/**
 * Host-side `PreimageCapture` (session-api) — the concrete implementation the
 * assembly injects into the harness write tools. It lives here (not in the
 * harness) because it reaches both the blob store and the session-folder
 * derivation; Gate B keeps the harness importing only the port type, never
 * session-api. The harness hands this closure an already-constructed
 * `PreimageCapture` via `BuildEngineOpts.preimageCapture`.
 *
 * A throw from `captureCodeSnapshot` propagates to the write tool and aborts
 * the pending workspace write — the tool must not swallow it.
 *
 * `recordPreimagePair` is the shared capture body; the worker transcript's
 * port (src/cli/worker-transcript.ts) calls it too, against the parent session
 * folder, so blob layout and ref shape stay single-sourced here.
 */
import type {
  PreimageCapture,
  PreimageCaptureInput,
} from "../../harness/aci/preimage-port.js";
import { captureCodeSnapshot } from "./code-snapshot-store.js";
import type { PreimageLedgerHost } from "./preimage-ledger.js";
import { resolveConversationDir } from "./session-store.js";

export function createPreimageCapture(deps: {
  readonly getProjectDir: () => string;
  readonly ledger: PreimageLedgerHost;
  /** `settings.codeRestore.enabled !== false`, resolved per call so a config
   *  flip takes effect without rebuilding the engine. */
  readonly isEnabled: () => boolean;
}): PreimageCapture {
  return async (input: PreimageCaptureInput): Promise<void> => {
    if (!deps.isEnabled()) return;
    const { conversationId, toolUseId } = input;
    // A captured blob is only useful once it can be stamped onto the matching
    // tool_result event, which needs both routing ids. Missing either → no
    // blob, no ledger entry (byte-identical to the pre-capture behavior).
    if (conversationId === undefined || toolUseId === undefined) return;
    await recordPreimagePair({
      sessionFolder: resolveConversationDir({
        projectDir: deps.getProjectDir(),
        conversationId,
      }),
      ledger: deps.ledger,
      ledgerKey: conversationId,
      toolUseId,
      input,
    });
  };
}

/**
 * Capture both byte sides of one write as blobs and record the ref under the
 * key the commit side drains with. Shared by the parent session's capture port
 * and the worker's: they differ only in which session folder holds the blobs
 * and which ledger key the later `tool_result` is stamped onto, so the blob
 * layout and the ref shape have exactly one owner.
 */
export async function recordPreimagePair(opts: {
  readonly sessionFolder: string;
  readonly ledger: PreimageLedgerHost;
  readonly ledgerKey: string;
  readonly toolUseId: string;
  readonly input: PreimageCaptureInput;
}): Promise<void> {
  const { sessionFolder, ledger, ledgerKey, toolUseId, input } = opts;
  const preimageSha = await captureCodeSnapshot(sessionFolder, input.preBytes);
  const postimageSha = await captureCodeSnapshot(
    sessionFolder,
    input.postBytes
  );
  ledger.set(ledgerKey, toolUseId, {
    relPath: input.relPath,
    rootIdentity: input.rootIdentity,
    preimageSha,
    postimageSha,
    // Conditional spread: a false (the common edit) leaves the ref
    // byte-identical to legacy lines — one schema, absence recorded only by
    // the capture-time evidence (ADR-0121).
    ...(input.absentBefore ? { absentBefore: true } : {}),
  });
}
