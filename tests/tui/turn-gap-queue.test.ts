/**
 * tests/tui/turn-gap-queue.test.ts
 *
 * Contract of the turn-gap queue: FIFO send, LIFO recall, per-session
 * isolation, and the one English chrome row. Public functions only.
 */
import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import {
  emptyGapQueue,
  enqueueGap,
  gapQueueLine,
  recallNewestGap,
  resolveGapKey,
  takeOldestGap,
  type GapDraft,
} from "../../src/tui/turn-gap-queue.ts";

function draft(text: string, displayText = text): GapDraft {
  return { text, displayText, payloads: [] };
}

describe("turn gap queue", () => {
  test("FIFO send: enqueue a then b, takeOldest returns a, then b", () => {
    const queued = enqueueGap(
      enqueueGap(emptyGapQueue(), "s", draft("a")),
      "s",
      draft("b")
    );
    const first = takeOldestGap(queued, "s");
    const second = takeOldestGap(first.queue, "s");
    expect(first.draft?.text).toBe("a");
    expect(second.draft?.text).toBe("b");
    expect(second.queue.bySession.s).toBeUndefined();
  });

  test("LIFO recall: enqueue a then b, recallNewest returns b and leaves a", () => {
    const queued = enqueueGap(
      enqueueGap(emptyGapQueue(), "s", draft("a")),
      "s",
      draft("b")
    );
    const recalled = recallNewestGap(queued, "s");
    expect(recalled.draft?.text).toBe("b");
    expect(recalled.queue.bySession.s?.map((item) => item.text)).toEqual(["a"]);
  });

  test("a taken draft cannot be recalled", () => {
    const queued = enqueueGap(emptyGapQueue(), "s", draft("sent"));
    const taken = takeOldestGap(queued, "s");
    expect(taken.draft?.text).toBe("sent");
    expect(recallNewestGap(taken.queue, "s").draft).toBeUndefined();

    const both = enqueueGap(
      enqueueGap(emptyGapQueue(), "s", draft("a")),
      "s",
      draft("b")
    );
    const oldest = takeOldestGap(both, "s");
    expect(oldest.draft?.text).toBe("a");
    expect(recallNewestGap(oldest.queue, "s").draft?.text).toBe("b");
  });

  test("sessions do not share queues", () => {
    const queued = enqueueGap(emptyGapQueue(), "alpha", draft("only-alpha"));
    const alphaItems = queued.bySession.alpha;
    expect(takeOldestGap(queued, "beta").draft).toBeUndefined();
    expect(recallNewestGap(queued, "beta").draft).toBeUndefined();
    expect(gapQueueLine(queued, "beta", 80)).toBeUndefined();
    expect(queued.bySession.alpha).toBe(alphaItems);
    expect(takeOldestGap(queued, "alpha").draft?.text).toBe("only-alpha");
  });

  test("empty text and display is not enqueued; a display-only image label is", () => {
    const start = emptyGapQueue();
    expect(enqueueGap(start, "s", draft("", "")).bySession).toEqual({});
    expect(enqueueGap(start, "s", draft("", " \n\t")).bySession).toEqual({});
    const queued = enqueueGap(start, "s", draft("", "[image#1]"));
    expect(queued.bySession.s?.map((item) => item.displayText)).toEqual([
      "[image#1]",
    ]);
    expect(queued.bySession.s?.[0]?.text).toBe("");
  });

  test("resolveGapKey: conversationId wins, else the draft's sole live key, else activeKey", () => {
    expect(
      resolveGapKey({
        activeKey: "draft",
        conversationId: "conv-1",
        draftKey: "draft",
        liveKeys: ["live-other"],
      })
    ).toBe("conv-1");

    expect(
      resolveGapKey({
        activeKey: "draft",
        conversationId: undefined,
        draftKey: "draft",
        liveKeys: ["live-1"],
      })
    ).toBe("live-1");

    expect(
      resolveGapKey({
        activeKey: "session-a",
        conversationId: undefined,
        draftKey: "draft",
        liveKeys: ["live-1"],
      })
    ).toBe("session-a");

    expect(
      resolveGapKey({
        activeKey: "draft",
        conversationId: undefined,
        draftKey: "draft",
        liveKeys: ["live-1", "live-2"],
      })
    ).toBe("draft");
  });

  test("gapQueueLine at cols 80 shows the queued count, the next preview, and the edit hint", () => {
    const queued = enqueueGap(emptyGapQueue(), "s", draft("hello"));
    expect(gapQueueLine(queued, "s", 80)).toBe(
      "queued 1 · next: hello · ↑ edit"
    );
  });

  test("gapQueueLine on a narrow terminal clips and stays within cols", () => {
    const preview = "abcdefghijklmnopqrstuvwxyz";
    const queued = enqueueGap(emptyGapQueue(), "s", draft(preview));
    const cols = 24;
    const line = gapQueueLine(queued, "s", cols);
    expect(line).toBeDefined();
    expect(line).toContain("queued 1");
    expect(line).toContain("next:");
    expect(line).not.toContain(preview);
    expect(line).toContain("…");
    expect(stringWidth(line ?? "")).toBeLessThanOrEqual(cols);
  });

  test("previous queue arrays are not mutated", () => {
    const a = draft("a");
    const b = draft("b");
    const first = enqueueGap(emptyGapQueue(), "s", a);
    const firstItems = first.bySession.s;
    const second = enqueueGap(first, "s", b);
    expect(first.bySession.s).toBe(firstItems);
    expect(first.bySession.s).toEqual([a]);
    expect(second.bySession.s).toEqual([a, b]);
    expect(second.bySession.s).not.toBe(firstItems);

    const recalled = recallNewestGap(second, "s");
    const taken = takeOldestGap(second, "s");
    expect(second.bySession.s).toEqual([a, b]);
    expect(recalled.queue.bySession.s).toEqual([a]);
    expect(taken.queue.bySession.s).toEqual([b]);
  });
});
