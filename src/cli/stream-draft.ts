/**
 * Shared streaming-draft layer: accumulates harness `HarnessStreamEvent`s
 * into the masked current text, consumed from one source by the chat REPL
 * (stdout) and the TUI (`useSyncExternalStore` subscription).
 *
 * Design points:
 * - `rawBuffer` accumulates text incrementally; `masked()` re-masks the
 *   **whole** buffer per call. A secret truncated across delta boundaries
 *   (e.g. `sk-` + `abc123`) is captured whole once accumulation completes,
 *   since masking runs on the full `rawBuffer`. The buffer holds one turn's
 *   text (hundreds to thousands of chars), so O(N) re-masking is
 *   acceptable; no incremental optimization.
 * - **No module-level mask instance cache**: `currentSecretValues()` reads
 *   process.env fresh each call (aligned with `src/cli/format.ts`
 *   start-of-run snapshot semantics; stream-draft spans turns, so env is
 *   re-read per access), keeping the no-memoization-seam property.
 * - Listeners live in a `Set` for dedup; unsubscribe is idempotent; the
 *   same listener subscribed twice still fires once.
 * - No fds, no React dependency; pure string + Set state.
 */
import type { HarnessStreamEvent } from "../harness/stream.js";
import {
  createOutputMask,
  currentSecretValues,
} from "../harness/sandbox/index.js";

export interface StreamDraft {
  append(event: HarnessStreamEvent): void;
  raw(): string;
  masked(): string;
  /**
   * Freeze the current answer buffer as a segment (TUI live interleaving).
   * No-op when the raw buffer is empty. CLI never calls it; masked() is
   * still the full mask over all segments concatenated.
   */
  sealText(): void;
  /** Number of sealed segments (excluding the current unsealed buffer). */
  sealedCount(): number;
  /** Sealed segments + current buffer (if non-empty), each masked. Synchronously readable, no subscribe needed. */
  maskedSegments(): ReadonlyArray<string>;
  /** Raw text accumulated from thinking deltas (separate from the answer rawBuffer). */
  thinkingRaw(): string;
  /** thinking raw text after masking, renderable (secrets never surface unmasked). */
  thinkingMasked(): string;
  /**
   * Seconds from the first thinking_delta until now (0 when no thinking).
   * The `now` parameter exists only for test clock injection (default
   * Date.now()).
   *
   * Timer start = **first thinking_delta** (lazily stamped, the only
   * source): thinking seconds = pure thinking time, excluding the
   * turn-start -> first-delta wait. Total runtime is a separate concept
   * measured at app layer (mode line / `Crunched for X` from the turn-start
   * stamp). The earlier explicit turn-start stamp — which folded the wait
   * into the count — was removed: waiting is not thinking, and conflating
   * them inflates "thought for N seconds".
   */
  thinkingSeconds(now?: number): number;
  reset(): void;
  subscribe(listener: () => void): () => void;
}

export function createStreamDraft(): StreamDraft {
  let rawBuffer = "";
  const sealedRaw: string[] = [];
  // The thinking buffer is separate from the answer text buffer — each
  // accumulates and masks on its own. Thinking never enters the answer
  // rawBuffer (final thinking blocks are the SSOT; streaming thinking is a
  // transient display layer).
  let thinkingBuffer = "";
  // Timestamp (ms) of the first thinking stamp — rendered by the collapsed
  // line "thought for N seconds". Only source: lazily set on the first
  // thinking_delta. Thinking seconds = pure thinking duration (first delta
  // -> answer start); the turn-start -> first-delta wait is excluded
  // (waiting is not thinking; total runtime is tracked at app layer).
  let thinkingStartedAt: number | null = null;
  const listeners = new Set<() => void>();

  // Render throttling:
  //  - the buffer updates **synchronously** inside append (raw()/masked()
  //    are always current; the REPL feed relies on masked() being readable
  //    right after append);
  //  - listener notification is batched through a 50ms trailing timer so a
  //    per-delta notify does not re-render the whole TUI tree
  //    (setDraftsMasked -> full ChatView re-render + markdown re-parse);
  //  - accumulating >= 384 chars flushes immediately (skip the 50ms window)
  //    so large text never piles up unshown;
  //  - timer.unref(): the timer must not hold the process open (it can exit
  //    right after a turn ends / Ctrl+C);
  //  - reset cancels the pending timer — no late notify into an unmounted UI
  //    after an interrupt.
  const THROTTLE_MS = 50;
  const EARLY_FLUSH_CHARS = 384;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  // Chars accumulated since the last flush (accumulated across delta
  // boundaries for the early-flush check).
  let pendingChars = 0;

  const flush = (): void => {
    notifyTimer = null;
    pendingChars = 0;
    // Observer exceptions must never break the data producer (nor block
    // other listeners). Per-listener throw isolation — same contract as
    // safeEmit in anthropic-adapter wireStreamEvents; as a shared layer,
    // stream-draft cannot assume consumers bring their own try/catch (e.g.
    // TUI React listeners), so the SSOT layer absorbs it.
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // swallow (isolation contract above)
      }
    }
  };

  const scheduleNotify = (): void => {
    if (notifyTimer !== null) return; // a batch is already pending; accumulate into it
    notifyTimer = setTimeout(flush, THROTTLE_MS);
    (notifyTimer as ReturnType<typeof setTimeout>).unref?.();
  };

  const cancelPending = (): void => {
    if (notifyTimer !== null) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    pendingChars = 0;
  };

  const appendText = (text: string): void => {
    pendingChars += text.length;
    // >= 384 chars flushes immediately — large text must not wait out the
    // 50ms window (user-visible latency).
    if (pendingChars >= EARLY_FLUSH_CHARS) {
      cancelPending();
      flush();
      return;
    }
    scheduleNotify();
  };

  const closeThinkingPhase = (): void => {
    if (thinkingBuffer.length === 0) return;
    thinkingBuffer = "";
    cancelPending();
    flush();
  };

  return {
    append(event: HarnessStreamEvent): void {
      if (event.type === "text_delta") {
        // The thinking phase ends where the answer begins: clear
        // thinkingBuffer so ChatView collapses the streaming thinking panel.
        // The next thinking_delta accumulates fresh and renders below the
        // already-returned text (live tail drafts), not pinned at the top.
        closeThinkingPhase();
        rawBuffer += event.text;
        appendText(event.text);
      } else if (event.type === "thinking_delta") {
        if (thinkingStartedAt === null) thinkingStartedAt = Date.now();
        thinkingBuffer += event.text;
        appendText(event.text);
      } else if (event.type === "tool_call_start") {
        // Closing the thinking phase on tool-call start: a tool call ends
        // the thinking phase. Clear thinkingBuffer immediately so the
        // ChatView streaming-thinking condition
        // `deferredThinkingDrafts.length > 0` goes false -> panel collapses
        // without waiting for the whole turn (user feedback: the top
        // thinking panel kept piling up). Do NOT reset thinkingStartedAt —
        // the collapsed "thought for N seconds" reflects the whole turn's
        // thinking across multiple segments; later thinking_delta events
        // re-accumulate into thinkingBuffer naturally (multi-segment
        // thinking within one assistant turn is common). Also cancel the
        // throttle timer and flush synchronously: a thinking-phase switch
        // is a state change, and delaying its visibility would be a bug.
        closeThinkingPhase();
      }
    },
    raw(): string {
      return sealedRaw.join("") + rawBuffer;
    },
    masked(): string {
      return createOutputMask(currentSecretValues()).mask(
        sealedRaw.join("") + rawBuffer
      );
    },
    sealText(): void {
      if (rawBuffer.length === 0) return;
      sealedRaw.push(rawBuffer);
      rawBuffer = "";
    },
    sealedCount(): number {
      return sealedRaw.length;
    },
    maskedSegments(): ReadonlyArray<string> {
      const mask = createOutputMask(currentSecretValues());
      const segments = sealedRaw.map((part) => mask.mask(part));
      if (rawBuffer.length > 0) segments.push(mask.mask(rawBuffer));
      return segments;
    },
    thinkingRaw(): string {
      return thinkingBuffer;
    },
    thinkingMasked(): string {
      return createOutputMask(currentSecretValues()).mask(thinkingBuffer);
    },
    thinkingSeconds(now?: number): number {
      if (thinkingStartedAt === null) return 0;
      return Math.max(
        0,
        Math.floor(((now ?? Date.now()) - thinkingStartedAt) / 1000)
      );
    },
    reset(): void {
      rawBuffer = "";
      sealedRaw.length = 0;
      thinkingBuffer = "";
      thinkingStartedAt = null;
      cancelPending();
      // Reset notifies immediately (clears UI draft panels), skipping the throttle window.
      flush();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      let unsubscribed = false;
      return (): void => {
        if (unsubscribed) return;
        unsubscribed = true;
        listeners.delete(listener);
      };
    },
  };
}
