/**
 * `NativeStatePort` host adapter (ADR-0136) — the single place the session
 * store's typed `SessionStoreError` union is translated into the port's
 * `NativeStatePortError` vocabulary. One mapping, so no consumer downstream
 * has to learn a second error dialect, and so "was this rejected before any
 * write, or did a required write fail to complete" stays answerable from the
 * code alone.
 *
 * CONCURRENCY: this adapter adds no locking, no second journal, no
 * independent current-state pointer, no expiry and no GC. It must be called
 * under the host's existing per-session writer queue (`SessionHub.serialize`)
 * exactly like `appendEvents`; the store itself stays lock-free and its
 * callers remain the single writer per session file (ADR-0110).
 */
import {
  isNativeStatePortError,
  NativeStatePortError,
  type NativeStatePort,
  type NativeStatePortErrorCode,
  type PublishNativeStateRequest,
  type PublishedNativeStateResult,
  type RecordFileIntentRequest,
} from "../../shared/native-state-port.js";
import type { SessionStoreError } from "./errors.js";
import type { SessionStore } from "./session-store.js";

export interface NativeStatePortDeps {
  readonly store: SessionStore;
}

/**
 * The port backed by one real store. `conversationId` is the store's session
 * id — the same identity the transcript is keyed by, so the port needs no
 * separate routing vocabulary.
 */
export function createNativeStatePort(
  deps: NativeStatePortDeps
): NativeStatePort {
  const { store } = deps;
  return {
    async publishNativeState(
      input: PublishNativeStateRequest
    ): Promise<PublishedNativeStateResult> {
      try {
        const res = await store.appendNativeState({
          id: input.conversationId,
          anchorEventId: input.anchorEventId,
          boundary: input.boundary,
          snapshot: input.snapshot,
        });
        return { bodySha: res.bodySha, messageCount: res.messageCount };
      } catch (err) {
        throw asPortError(err, input.conversationId, "publishNativeState");
      }
    },
    async recordFileIntent(input: RecordFileIntentRequest): Promise<void> {
      try {
        await store.appendFileIntent({
          id: input.conversationId,
          toolUseId: input.toolUseId,
          targets: input.targets,
          captured: input.captured,
        });
      } catch (err) {
        throw asPortError(err, input.conversationId, "recordFileIntent");
      }
    },
  };
}

/**
 * Rejections that happened BEFORE any write are `VALIDATION`: the caller can
 * correct the request and retry, and nothing was persisted. Everything else
 * means a required write did not complete, so dependent execution must not
 * proceed → `PERSIST_FAILED`.
 *
 * Exported because the runtime-persistence binder is a second consumer of the
 * SAME seam and must not learn a third error dialect: one mapping, two callers.
 */
export function portCodeFor(
  kind: SessionStoreError["kind"]
): NativeStatePortErrorCode {
  switch (kind) {
    case "not_found":
    case "parse_failed":
    case "schema_invalid":
      return "VALIDATION";
    default:
      return "PERSIST_FAILED";
  }
}

/** Re-throw anything that is not a store error unchanged: a foreign failure
 *  must stay a foreign failure, not be filed as a persistence outcome. */
export function asPortError(
  err: unknown,
  conversationId: string,
  operation: string
): unknown {
  if (isNativeStatePortError(err)) return err;
  const typed = err as Partial<SessionStoreError>;
  if (typeof typed?.kind !== "string") return err;
  return new NativeStatePortError(
    portCodeFor(typed.kind),
    `${operation} failed for ${conversationId}: ${typed.kind}`,
    { kind: typed.kind, conversationId, operation }
  );
}
