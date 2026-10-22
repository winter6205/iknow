import { describe, expect, it } from "vitest";

import {
  createDeliveryLedger,
  deliveryKey,
  type DeliveryLedgerEntry,
} from "../../src/harness/subagent/delivery-ledger.ts";

interface TestEnvelope {
  summary: string;
  result: string;
  fileRefs?: string[];
}

function makeEntry(
  overrides: Partial<DeliveryLedgerEntry<TestEnvelope>> = {}
): DeliveryLedgerEntry<TestEnvelope> {
  return {
    conversationId: "conversation-1",
    taskId: "task-1",
    terminalSeq: 1,
    envelope: { summary: "done", result: "body" },
    ...overrides,
  };
}

describe("deliveryKey", () => {
  it("is stable for the same conversation, task, and terminal generation", () => {
    const parts = { conversationId: "c1", taskId: "t1", terminalSeq: 7 };
    expect(deliveryKey(parts)).toBe(deliveryKey({ ...parts }));
  });

  it("separates distinct conversations, tasks, and terminal generations", () => {
    const base = deliveryKey({
      conversationId: "c1",
      taskId: "t1",
      terminalSeq: 1,
    });
    expect(
      deliveryKey({ conversationId: "c2", taskId: "t1", terminalSeq: 1 })
    ).not.toBe(base);
    expect(
      deliveryKey({ conversationId: "c1", taskId: "t2", terminalSeq: 1 })
    ).not.toBe(base);
    expect(
      deliveryKey({ conversationId: "c1", taskId: "t1", terminalSeq: 2 })
    ).not.toBe(base);
  });

  it("treats an absent conversation as the empty string", () => {
    expect(deliveryKey({ taskId: "t1", terminalSeq: 1 })).toBe(
      deliveryKey({ conversationId: "", taskId: "t1", terminalSeq: 1 })
    );
  });
});

describe("createDeliveryLedger", () => {
  it("claims an undelivered entry exactly once", () => {
    const ledger = createDeliveryLedger();
    const entry = makeEntry();

    const first = ledger.claim([entry]);
    const second = ledger.claim([entry]);

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(first[0]?.taskId).toBe("task-1");
    expect(first[0]?.key).toBe(deliveryKey(entry));
    expect(first[0]?.envelope).toEqual({ summary: "done", result: "body" });
  });

  it("reports only the undelivered state through the drain-style filter", () => {
    const ledger = createDeliveryLedger();
    const entry = makeEntry();

    expect(ledger.undelivered([entry])).toHaveLength(1);

    const claims = ledger.claim([entry]);
    expect(ledger.undelivered([entry])).toEqual([]);

    ledger.acknowledge(claims);
    expect(ledger.undelivered([entry])).toEqual([]);
    expect(ledger.isDelivered(deliveryKey(entry))).toBe(true);
  });

  it("returns a released entry to the undelivered state and lets it be claimed again", () => {
    const ledger = createDeliveryLedger();
    const entry = makeEntry();
    const claims = ledger.claim([entry]);

    ledger.release(claims);

    expect(ledger.undelivered([entry])).toHaveLength(1);
    expect(ledger.isDelivered(deliveryKey(entry))).toBe(false);

    const reclaimed = ledger.claim([entry]);
    expect(reclaimed).toHaveLength(1);
    ledger.acknowledge(reclaimed);
    expect(ledger.undelivered([entry])).toEqual([]);
  });

  it("ignores acknowledge and release of unknown or already-settled tokens", () => {
    const ledger = createDeliveryLedger();
    const entry = makeEntry();
    const claims = ledger.claim([entry]);
    ledger.release(claims);

    expect(() => ledger.acknowledge(claims)).not.toThrow();
    expect(() => ledger.release(claims)).not.toThrow();
    expect(ledger.isDelivered(deliveryKey(entry))).toBe(false);

    const reclaimed = ledger.claim([entry]);
    expect(() => ledger.acknowledge(claims)).not.toThrow();
    expect(ledger.isDelivered(deliveryKey(entry))).toBe(false);

    ledger.acknowledge(reclaimed);
    expect(() => ledger.acknowledge(reclaimed)).not.toThrow();
    expect(ledger.isDelivered(deliveryKey(entry))).toBe(true);
  });

  it("keeps the same task id independent across conversations", () => {
    const ledger = createDeliveryLedger();
    const first = makeEntry({ conversationId: "conversation-a" });
    const second = makeEntry({ conversationId: "conversation-b" });

    const claims = ledger.claim([first, second]);
    expect(claims).toHaveLength(2);

    ledger.acknowledge(claims.slice(0, 1));
    ledger.release(claims.slice(1));

    expect(ledger.isDelivered(deliveryKey(first))).toBe(true);
    expect(ledger.isDelivered(deliveryKey(second))).toBe(false);
    expect(ledger.undelivered([first])).toEqual([]);
    expect(ledger.undelivered([second])).toHaveLength(1);
    expect(ledger.claim([second])).toHaveLength(1);
  });

  it("clears claims and delivered generations", () => {
    const ledger = createDeliveryLedger();
    const delivered = makeEntry({ taskId: "delivered" });
    const claimed = makeEntry({ taskId: "claimed" });
    ledger.acknowledge(ledger.claim([delivered]));
    ledger.claim([claimed]);

    ledger.clear();

    expect(ledger.isDelivered(deliveryKey(delivered))).toBe(false);
    expect(ledger.undelivered([delivered, claimed])).toHaveLength(2);
    expect(ledger.claim([delivered, claimed])).toHaveLength(2);
  });

  it("makes distinct terminal generations of one task independently deliverable", () => {
    const ledger = createDeliveryLedger();
    const first = makeEntry({ terminalSeq: 1 });
    const second = makeEntry({ terminalSeq: 2 });

    const claims = ledger.claim([first]);
    expect(claims).toHaveLength(1);
    expect(ledger.undelivered([first, second])).toEqual([second]);

    const secondClaims = ledger.claim([first, second]);
    expect(secondClaims).toHaveLength(1);
    expect(secondClaims[0]?.terminalSeq).toBe(2);
  });

  it("keeps the envelope captured at claim time when the source entry changes", () => {
    const ledger = createDeliveryLedger();
    const source: {
      conversationId?: string;
      taskId: string;
      terminalSeq: number;
      envelope: TestEnvelope;
    } = makeEntry();
    const claims = ledger.claim([source]);

    source.envelope.summary = "mutated";
    expect(claims[0]?.envelope).toEqual({ summary: "done", result: "body" });

    source.envelope = { summary: "replaced", result: "replaced" };
    expect(claims[0]?.envelope).toEqual({ summary: "done", result: "body" });
  });

  it("snapshots nested envelope fields instead of sharing them", () => {
    const ledger = createDeliveryLedger();
    const source = makeEntry({
      envelope: { summary: "done", result: "body", fileRefs: ["a.md"] },
    });
    const claims = ledger.claim([source]);

    source.envelope.fileRefs?.push("b.md");
    expect(claims[0]?.envelope.fileRefs).toEqual(["a.md"]);
  });

  it("leaves an unsnapshottable entry claimable instead of stranding it", () => {
    const ledger = createDeliveryLedger();
    const poisoned = makeEntry({
      taskId: "task-poison",
      envelope: {
        summary: "s",
        result: "r",
        // A function member cannot be structuredClone'd.
        onComplete: () => {},
      } as unknown as TestEnvelope,
    });

    // The claim skips the entry; it neither throws nor marks it claimed.
    expect(() => ledger.claim([poisoned])).not.toThrow();
    expect(ledger.claim([poisoned])).toEqual([]);

    const healthy = makeEntry();
    expect(ledger.claim([healthy])).toHaveLength(1);
    // The poisoned key is still not delivered, so a later read still offers it.
    expect(
      ledger.undelivered([
        {
          conversationId: poisoned.conversationId,
          taskId: poisoned.taskId,
          terminalSeq: poisoned.terminalSeq,
          envelope: poisoned.envelope,
        },
      ])
    ).toHaveLength(1);
  });
});
