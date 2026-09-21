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
    const sessionFolder = resolveConversationDir({
      projectDir: deps.getProjectDir(),
      conversationId,
    });
    const preimageSha = await captureCodeSnapshot(
      sessionFolder,
      input.preBytes
    );
    const postimageSha = await captureCodeSnapshot(
      sessionFolder,
      input.postBytes
    );
    deps.ledger.set(conversationId, toolUseId, {
      relPath: input.relPath,
      rootIdentity: input.rootIdentity,
      preimageSha,
      postimageSha,
    });
  };
}
