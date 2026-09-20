/**
 * LSP edit-invalidation notification layer.
 *
 * **Responsibility**: after edit_file successfully writes to disk, the
 * assembly layer (build-engine.ts) injects `invalidate(file)` as the
 * registry's `onEdit` callback; the notifier then syncs the file's latest
 * text to the matching language-server client so the server-side text stays
 * current.
 *
 * **Standard didChange** (replacing the earlier non-standard `workspace/xrefs`
 * literal): the old implementation sent non-standard `workspace/xrefs`, so
 * server-side text stayed forever at didOpen version:1 and later
 * definition/references ran on stale content. Now it goes through
 * `client.notifyChange(file)` as standard `textDocument/didChange` (full
 * sync, version++): once server-side text is synced, later requests naturally
 * see new content with no guessing at server-private invalidation semantics.
 * The "how to send" decision stays encapsulated in this file, so future
 * adjustments touch only here.
 *
 * **Degradation policy**: the notifier is best-effort.
 *   - `invalidate` is fire-and-forget: returns void, sends asynchronously;
 *   - the async send is wrapped in try/catch; any failure (client already
 *     disposed / file read failure / spawn failure) is logged and swallowed,
 *     **never propagated back to the edit_file main path** — one failed
 *     invalidation would otherwise turn the whole edit into execution_failed;
 *   - `getClient` returning undefined (no usable LSP server for the file) →
 *     silently skip. The file write itself succeeded; a server that missed
 *     the notification merely holds stale cache and self-heals.
 *
 * **Cancellation semantics**: this module only sends JSON-RPC notifications
 * and never terminates any language-server subprocess (consistent with
 * client.ts).
 */
import type { LspCtx } from "./types.js";
import { getClient } from "./client.js";

/**
 * Create the LSP edit-invalidation notifier.
 *
 * @param ctx  LSP client context (build-engine passes `{ directory }` at assembly).
 * @returns   `{ invalidate(file) }` — a fire-and-forget invalidation callback
 *            the assembly layer injects as the registry's `onEdit` into edit_file.
 */
export function createLspNotifier(ctx: LspCtx): {
  readonly invalidate: (file: string) => void;
} {
  const invalidate = (file: string): void => {
    // Best-effort: send asynchronously; failures never propagate back to the
    // edit_file main path. The onEdit callback has a sync signature — return
    // immediately here, the send completes in the background.
    void notifyInvalidation(ctx, file);
  };

  return { invalidate };
}

/**
 * Send one invalidation notification asynchronously. Catches and swallows all
 * errors internally (log/ignore), guaranteeing none propagate to the caller
 * (fire-and-forget).
 */
async function notifyInvalidation(ctx: LspCtx, file: string): Promise<void> {
  try {
    const client = await getClient(ctx, file);
    if (!client) {
      // No usable LSP server for this file → skip silently (degradation;
      // never blocks the write path).
      return;
    }
    // Standard didChange sync (see header): not open → didOpen-equivalent
    // path; already open → full-sync didChange with version++. A file-read
    // failure rejects here and is swallowed by the catch below (notifier is
    // best-effort, nothing returns to the edit_file main path).
    await client.notifyChange(file);
  } catch (err) {
    // Degradation: notifier failure never affects the edit_file main path.
    // The file is already written; a failed invalidation only leaves the
    // server briefly stale and self-heals.
    // stderr trail aids diagnosis — an empty catch is banned, an observable
    // surface is required.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[lsp-notifier] invalidate failed for ${file}: ${msg}\n`
    );
  }
}
