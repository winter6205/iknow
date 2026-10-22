/**
 * src/tui/turn-gap-queue.ts
 *
 * Drafts typed while a turn is running. The kernel holds the session for the
 * whole `postMessage` / `run()`, so the only safe gap is the turn boundary:
 * the moment that run settles and the session is idle again. FIFO sends the
 * oldest draft through that gap. LIFO recall (Up) hands the newest still-unread
 * draft back to the composer. Once a draft is taken for send, it is read and
 * cannot be recalled.
 *
 * Esc does not have its own queue operation. Aborting the live turn makes the
 * same gap arrive now; the caller drains this queue at that boundary.
 */
import type { UserContentBlock } from "../session-api/contract.js";
import { clipOneLineVisual, visualWidth } from "../shared/tool-line.js";
import type { DraftPayload } from "./composer-draft.js";

/** One unread draft. `displayText` is the composer buffer; `text` is the
 *  model payload. Payloads put folded paste / image units back on recall. */
export interface GapDraft {
  readonly text: string;
  readonly displayText: string;
  readonly payloads: readonly DraftPayload[];
  readonly content?: readonly UserContentBlock[];
  /** Who submitted the draft (specs/remote-sync.md §4.3); absent → local. */
  readonly origin?: "local" | "remote";
}

/** Per-session FIFO. Absent key and empty list are the same: nothing waiting. */
export interface GapQueue {
  readonly bySession: Readonly<Record<string, readonly GapDraft[]>>;
}

export interface GapTake {
  readonly queue: GapQueue;
  readonly draft: GapDraft | undefined;
}

export function emptyGapQueue(): GapQueue {
  return { bySession: {} };
}

/** Which session a draft belongs to. A live turn that just remapped the draft
 *  session onto a conversation id is that id, even before React commits it. */
export function resolveGapKey(opts: {
  readonly activeKey: string;
  readonly conversationId: string | undefined;
  readonly draftKey: string;
  readonly liveKeys: readonly string[];
}): string {
  if (opts.conversationId !== undefined) return opts.conversationId;
  const sole = opts.liveKeys.length === 1 ? opts.liveKeys[0] : undefined;
  if (opts.activeKey === opts.draftKey && sole !== undefined) return sole;
  return opts.activeKey;
}

export function gapCount(queue: GapQueue, sessionKey: string): number {
  return queue.bySession[sessionKey]?.length ?? 0;
}

/** Append. A draft with nothing to show and nothing to send is ignored. */
export function enqueueGap(
  queue: GapQueue,
  sessionKey: string,
  draft: GapDraft
): GapQueue {
  if (draft.text.length === 0 && draft.displayText.trim().length === 0) {
    return queue;
  }
  const existing = queue.bySession[sessionKey] ?? [];
  return writeSession(queue, sessionKey, [...existing, draft]);
}

/** Put a draft back at the head. Used when a drain lost the race and the
 *  turn is live again — send order stays oldest-first. */
export function restoreGapHead(
  queue: GapQueue,
  sessionKey: string,
  draft: GapDraft
): GapQueue {
  const existing = queue.bySession[sessionKey] ?? [];
  return writeSession(queue, sessionKey, [draft, ...existing]);
}

/** Up: the newest unread draft leaves. Empty session returns the same queue. */
export function recallNewestGap(queue: GapQueue, sessionKey: string): GapTake {
  const existing = queue.bySession[sessionKey] ?? [];
  if (existing.length === 0) return { queue, draft: undefined };
  const draft = existing[existing.length - 1];
  return {
    queue: writeSession(queue, sessionKey, existing.slice(0, -1)),
    draft,
  };
}

/** The gap: the oldest unread draft is the next model input. */
export function takeOldestGap(queue: GapQueue, sessionKey: string): GapTake {
  const existing = queue.bySession[sessionKey] ?? [];
  if (existing.length === 0) return { queue, draft: undefined };
  const draft = existing[0];
  return {
    queue: writeSession(queue, sessionKey, existing.slice(1)),
    draft,
  };
}

/** One chrome row, or undefined when this session has nothing waiting. */
export function gapQueueLine(
  queue: GapQueue,
  sessionKey: string,
  cols: number
): string | undefined {
  const head = queue.bySession[sessionKey]?.[0];
  if (head === undefined) return undefined;
  return fitGapLine(gapCount(queue, sessionKey), head.displayText, cols);
}

function writeSession(
  queue: GapQueue,
  sessionKey: string,
  items: readonly GapDraft[]
): GapQueue {
  if (items.length === 0) {
    const bySession = { ...queue.bySession };
    delete bySession[sessionKey];
    return { bySession };
  }
  return { bySession: { ...queue.bySession, [sessionKey]: items } };
}

function fitGapLine(count: number, displayText: string, cols: number): string {
  const head = `queued ${count} · next: `;
  const hint = " · ↑ edit";
  const width = Math.max(1, cols);
  const headWidth = visualWidth(head);
  if (headWidth >= width) return clipOneLineVisual(head, width);
  const room = width - headWidth;
  const hintWidth = visualWidth(hint);
  if (room <= hintWidth + 1) return head + clipOneLineVisual(displayText, room);
  return head + clipOneLineVisual(displayText, room - hintWidth) + hint;
}
