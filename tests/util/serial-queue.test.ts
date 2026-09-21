/**
 * Unit tests for src/util/serial-queue.ts.
 *
 * Pinned invariants (= the convergence contract of the two former private
 * implementations):
 *  1. Strict FIFO: concurrent enqueues that finish out of order still run in
 *     enqueue order;
 *  2. A reject doesn't jam the chain: a failed task routes its reject only to
 *     its own caller, later tasks run normally;
 *  3. Fire-and-forget re-entry from inside a task doesn't deadlock (the nested
 *     task is queued after the current one).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createSerialQueue } from "../../src/util/serial-queue.ts";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createSerialQueue", () => {
  it("FIFO：乱序发起的任务按入队顺序执行", async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    // First task slow, rest fast: with concurrent overlap, order would become [2,3,4,1].
    const p1 = queue(async () => {
      await tick(30);
      order.push(1);
      return 1;
    });
    const p2 = queue(async () => {
      order.push(2);
      return 2;
    });
    const p3 = queue(async () => {
      order.push(3);
      return 3;
    });
    assert.deepEqual(await Promise.all([p1, p2, p3]), [1, 2, 3]);
    assert.deepEqual(order, [1, 2, 3]);
  });

  it("前序 reject 只回给该调用方，不卡链", async () => {
    const queue = createSerialQueue();
    const ran: string[] = [];
    const boom = queue(async () => {
      throw new Error("boom");
    });
    const after = queue(async () => {
      ran.push("after");
      return "after";
    });
    await assert.rejects(boom, /boom/);
    assert.equal(await after, "after");
    assert.deepEqual(ran, ["after"]);
    // After a failure the queue stays usable (two more beats, one rejecting; the chain must not re-jam)
    const third = queue(async () => {
      ran.push("third");
      return "third";
    });
    assert.equal(await third, "third");
    assert.deepEqual(ran, ["after", "third"]);
  });

  it("任务内 fire-and-forget 重入不死锁，嵌套任务排在当前任务之后", async () => {
    const queue = createSerialQueue();
    const order: string[] = [];
    let nestedResult = "";
    const outer = queue(async () => {
      order.push("outer-start");
      // Don't await the nested enqueue: it runs after outer. Awaiting it would deadlock (contract in the header comment).
      void queue(async () => {
        order.push("nested");
        nestedResult = "done";
      });
      await tick(10);
      order.push("outer-end");
      return "outer";
    });
    assert.equal(await outer, "outer");
    // Drain the nested task
    await queue(async () => undefined);
    assert.deepEqual(order, ["outer-start", "outer-end", "nested"]);
    assert.equal(nestedResult, "done");
  });

  it("同步抛出的任务同样不卡链（then(task, task) 直接排后序）", async () => {
    const queue = createSerialQueue();
    // The task function throws synchronously (it does not return a rejected promise)
    const bad = queue(() => {
      throw new Error("sync-boom");
    });
    const good = queue(async () => 42);
    await assert.rejects(bad, /sync-boom/);
    assert.equal(await good, 42);
  });
});
