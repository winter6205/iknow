/**
 * src/util/serial-queue.ts 的单元测试。
 *
 * 钉住的不变式（= 两处原私有实现的收敛契约）：
 *  1. 严格 FIFO：乱序完成的并发入队仍按入队顺序执行；
 *  2. reject 不卡链：失败任务只把 reject 回给自己的调用方，后续任务照常跑；
 *  3. 任务内 fire-and-forget 重入同队列不死锁（嵌套任务排到当前任务之后）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createSerialQueue } from "../../src/util/serial-queue.ts";

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createSerialQueue", () => {
  it("FIFO：乱序发起的任务按入队顺序执行", async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    // 第一个任务慢、后续任务快：若并发交叠，order 会变成 [2,3,4,1]。
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
    // 失败后队列仍可用（连续再排两拍，含一个 reject，链不复活卡死）
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
      // 嵌套入队不 await：排到 outer 之后执行。await 它会死锁（契约见头注释）。
      void queue(async () => {
        order.push("nested");
        nestedResult = "done";
      });
      await tick(10);
      order.push("outer-end");
      return "outer";
    });
    assert.equal(await outer, "outer");
    // 等嵌套任务被排干
    await queue(async () => undefined);
    assert.deepEqual(order, ["outer-start", "outer-end", "nested"]);
    assert.equal(nestedResult, "done");
  });

  it("同步抛出的任务同样不卡链（then(task, task) 直接排后序）", async () => {
    const queue = createSerialQueue();
    // 任务函数本身同步 throw（不是返回 rejected promise）
    const bad = queue(() => {
      throw new Error("sync-boom");
    });
    const good = queue(async () => 42);
    await assert.rejects(bad, /sync-boom/);
    assert.equal(await good, 42);
  });
});
