/**
 * live-graph-phase1 T1 — 账本单点权威（SC1–SC4 / ADR-0051）。
 *
 * 本测试只覆盖账本本身（harness/graph 权威）。接线（run_graph handler
 * / session-api 持有 / CLI reset / hub compact/shutdown）见各自集成测试。
 *
 * 五件事：
 *   1. **不存在**：新建 host / ledger，未交节点前 `exists()` 为 false，
 *      `isFrozen` 全 false；
 *   2. **ensure**：调一次 → exists；幂等；不调 → 后续 freeze 不生效
 *      （防御：handler 误调 freeze 也不会被冻结，零行为变化）；
 *   3. **freeze 收/拒**：done / failed 冻结，skipped 不冻，未跑过不冻；
 *   4. **destroy / reset**：清空冻结集合 + 存在标志；之后旧 id 不再冻结；
 *   5. **host 多会话**：按 conversationId 隔离；destroy 单 / destroyAll；
 *      `undefined` id 落到共享匿名账本。
 *
 * 不依赖 run_graph handler 或 SubAgentManager — 是纯模块单测。
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
    // skipped 是合法结算状态（handler 直传 GraphNodeResult.status）——
    // 账本单点强制不冻结，不靠调用方过滤。
    ledger.freeze("sk", "skipped");
    expect(ledger.isFrozen("sk")).toBe(false);
    expect(ledger.frozenIds()).toEqual([]);
  });

  it("非终态值（running / pending / 非法值）不冻结（防御性运行时容错）", () => {
    const ledger = createLiveGraphLedger();
    ledger.ensure();
    ledger.freeze("r", "running");
    ledger.freeze("p", "pending");
    // @ts-expect-error 非法值：即便绕过类型，账本也不冻结。
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

    // destroy 后再 ensure → 干净新账本
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
    // b 不受影响
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
    // 匿名账本不计入 size（按会话隔离的观测量）
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
