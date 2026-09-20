/**
 * Live-graph ledger — single-source-of-truth tests.
 *
 * Covers the ledger module alone (harness/graph authority). Wiring (run_graph
 * handler / session-api holding / CLI reset / hub compact/shutdown) is tested
 * by the respective integration tests.
 *
 * Five aspects:
 *   1. absent: a fresh ledger → exists() false before any node settles, isFrozen all false;
 *   2. ensure: one call → exists; idempotent; without it freeze never takes
 *      effect (defense: a handler mis-calling freeze cannot freeze anything);
 *   3. freeze accept/reject: done/failed freeze, skipped does not, never-run ids do not;
 *   4. destroy/reset: clears the frozen set + exists flag; old ids are no longer frozen afterwards;
 *   5. host multi-session: isolated per conversationId; destroy one / destroyAll;
 *      `undefined` id maps to the shared anonymous ledger.
 *
 * Pure module unit test — no run_graph handler or SubAgentManager involved.
 */

import { describe, expect, it } from "vitest";

import {
  createLiveGraphLedger,
  createLiveGraphLedgerHost,
} from "../../../src/harness/graph/ledger.ts";

describe("LiveGraphLedger: 新建实例", () => {
  it("未 ensure：exists() false，全 id 不冻结", () => {
    const ledger = createLiveGraphLedger();
    expect(ledger.exists()).toBe(false);
    expect(ledger.isFrozen("anything")).toBe(false);
    expect(ledger.frozenIds()).toEqual([]);
  });

  it("ensure：exists() true，幂等，零副作用", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    expect(ledger.exists()).toBe(true);
    ledger.ensure();
    expect(ledger.exists()).toBe(true);
  });
});

describe("LiveGraphLedger: freeze 收/拒（spec Glossary：done/failed 冻，skipped 不冻）", () => {
  it("ensure 之前 freeze 是 no-op（防御：handler 误调也不让冻结）", () => {
    const ledger = createLiveGraphLedger();
    ledger.freeze("a", "done");
    expect(ledger.isFrozen("a")).toBe(false);
    expect(ledger.frozenIds()).toEqual([]);
  });

  it("done → frozen；failed → frozen", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("a", "done");
    ledger.freeze("b", "failed");
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.isFrozen("b")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["a", "b"]);
  });

  it("skipped 不冻结（spec Glossary：未冻状态含 skipped 与从未跑过）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    // skipped is a legal settle status (the handler passes GraphNodeResult.status
    // through) — the ledger itself enforces no-freeze, not caller-side filtering.
    ledger.freeze("sk", "skipped");
    expect(ledger.isFrozen("sk")).toBe(false);
    expect(ledger.frozenIds()).toEqual([]);
  });

  it("非终态值 / 非法值不冻结（防御性运行时容错）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    // SettleStatus is narrowed to done | failed | skipped — "running"/"pending"
    // are neither in the signature nor produced anywhere; this tests the
    // fallback when the type is bypassed (the ledger must not freeze).
    // @ts-expect-error running is not in SettleStatus
    ledger.freeze("r", "running");
    // @ts-expect-error pending is not in SettleStatus
    ledger.freeze("p", "pending");
    // @ts-expect-error bogus value: even bypassing the type, the ledger must not freeze.
    ledger.freeze("x", "bogus" as "done");
    expect(ledger.isFrozen("r")).toBe(false);
    expect(ledger.isFrozen("p")).toBe(false);
    expect(ledger.isFrozen("x")).toBe(false);
    expect(ledger.frozenIds()).toEqual([]);
  });

  it("未跑过的 id 不冻结（isFrozen 默认 false）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    expect(ledger.isFrozen("never-ran")).toBe(false);
  });

  it("同 id 多次 freeze：末次状态覆盖（fallback 收敛，便于 T2 back-edge 回写）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("a", "done");
    ledger.freeze("a", "failed");
    expect(ledger.isFrozen("a")).toBe(true);
    expect(ledger.frozenIds()).toEqual(["a"]);
  });
});

describe("LiveGraphLedger: 产出记录（T2 / spec SC5「B 能读到 A 的产出」）", () => {
  it("freeze done + output → outputOf 可读、statusOf 回 done", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("a", "done", "A-OUTPUT");
    expect(ledger.outputOf("a")).toBe("A-OUTPUT");
    expect(ledger.statusOf("a")).toBe("done");
  });

  it("freeze 未传 output 的 done → outputOf undefined（不虚构产出）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("a", "done");
    expect(ledger.statusOf("a")).toBe("done");
    expect(ledger.outputOf("a")).toBe(undefined);
  });

  it("failed / skipped 不写产出；末次 freeze 覆盖旧产出（与状态一致）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("a", "done", "V1");
    ledger.freeze("a", "failed");
    expect(ledger.statusOf("a")).toBe("failed");
    expect(ledger.outputOf("a")).toBe(undefined);
    // failed → then done with a new output: last write wins
    ledger.freeze("a", "done", "V2");
    expect(ledger.statusOf("a")).toBe("done");
    expect(ledger.outputOf("a")).toBe("V2");
  });

  it("skipped 从未进产出表（Glossary：未冻）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("sk", "skipped", "should-not-store");
    expect(ledger.isFrozen("sk")).toBe(false);
    expect(ledger.outputOf("sk")).toBe(undefined);
  });

  it("destroy 清空产出表", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("a", "done", "A-OUTPUT");
    ledger.destroy();
    ledger.ensure();
    expect(ledger.outputOf("a")).toBe(undefined);
    expect(ledger.statusOf("a")).toBe(undefined);
  });

  it("未冻结 id 的 outputOf / statusOf 返回 undefined", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    expect(ledger.outputOf("never")).toBe(undefined);
    expect(ledger.statusOf("never")).toBe(undefined);
  });
});

describe("LiveGraphLedger: destroy / reset 语义（SC3）", () => {
  it("destroy 清空存在标志 + 冻结集合；之后旧 id 不再冻结", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("a", "done");
    ledger.freeze("b", "failed");
    expect(ledger.frozenIds()).toEqual(["a", "b"]);

    ledger.destroy();
    expect(ledger.exists()).toBe(false);
    expect(ledger.isFrozen("a")).toBe(false);
    expect(ledger.frozenIds()).toEqual([]);

    // destroy then ensure again → clean fresh ledger
    ledger.ensure();
    expect(ledger.exists()).toBe(true);
    expect(ledger.frozenIds()).toEqual([]);
  });

  it("destroy 未 ensure 的实例是 no-op（防御）", () => {
    const ledger = createLiveGraphLedger();
    ledger.destroy();
    expect(ledger.exists()).toBe(false);
  });
});

describe("LiveGraphLedgerHost: 多会话解析（hub 接线）", () => {
  it("按 conversationId 懒创建并复用", () => {
    const host = createLiveGraphLedgerHost();
    const a1 = host.ledgerFor("conv-a");
    const a2 = host.ledgerFor("conv-a");
    expect(a1).toBe(a2);
    const b = host.ledgerFor("conv-b");
    expect(b).not.toBe(a1);
    expect(host.size()).toBe(2);
  });

  it("destroy(id) 清空该会话账本，其它会话账本不动", () => {
    const host = createLiveGraphLedgerHost();
    const a = host.ledgerFor("conv-a");
    const b = host.ledgerFor("conv-b");
    a.ensure();
    b.ensure();
    a.freeze("x", "done");
    b.freeze("y", "failed");

    host.destroy("conv-a");
    expect(host.size()).toBe(1);
    expect(a.exists()).toBe(false);
    expect(a.isFrozen("x")).toBe(false);
    // b is untouched
    expect(b.exists()).toBe(true);
    expect(b.isFrozen("y")).toBe(true);
  });

  it("destroy(id) 缺席 id 是 no-op（reset 不存在的会话不报错）", () => {
    const host = createLiveGraphLedgerHost();
    host.destroy("never-existed");
    expect(host.size()).toBe(0);
  });

  it("destroyAll 清空全部 + 匿名账本（hub.shutdown / 进程退出）", () => {
    const host = createLiveGraphLedgerHost();
    const a = host.ledgerFor("conv-a");
    const anon = host.ledgerFor(undefined);
    a.ensure();
    anon.ensure();
    a.freeze("x", "done");
    anon.freeze("z", "failed");

    host.destroyAll();
    expect(host.size()).toBe(0);
    expect(a.exists()).toBe(false);
    expect(a.isFrozen("x")).toBe(false);
    expect(anon.isFrozen("z")).toBe(false);
  });

  it("undefined conversationId 落到共享匿名账本（stub/直调路径）", () => {
    const host = createLiveGraphLedgerHost();
    const anon1 = host.ledgerFor(undefined);
    const anon2 = host.ledgerFor(undefined);
    expect(anon1).toBe(anon2);
    // the anonymous ledger is not counted in size (size measures per-session isolation)
    expect(host.size()).toBe(0);

    anon1.ensure();
    anon1.freeze("q", "done");
    expect(anon2.isFrozen("q")).toBe(true);
  });

  it("destroy 之后再次 ledgerFor 拿回新账本（旧冻结集合已丢）", () => {
    const host = createLiveGraphLedgerHost();
    const a1 = host.ledgerFor("conv-a");
    a1.ensure();
    a1.freeze("x", "done");
    host.destroy("conv-a");
    const a2 = host.ledgerFor("conv-a");
    expect(a2).not.toBe(a1);
    expect(a2.exists()).toBe(false);
    expect(a2.isFrozen("x")).toBe(false);
  });
});
