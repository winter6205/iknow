/**
 * last-read ledger（ADR-0084 / spec D1）单元测试。
 *
 * 钉住的不变式：
 *   - 分桶按 conversationId，同 id 同一份、异 id 互不可见（禁止跨会话串读）。
 *   - `undefined` conversationId → **不建匿名桶**（与 graph/ledger.ts 相反）：
 *     这是 spec 的显式要求 —— 无 id 的非空覆写必须 fail-closed，且禁止隐式
 *     进程级全局表。
 *   - destroy / destroyAll 后账本为空（reset / 会话结束 / 进程重启的空表语义）。
 *   - 进程内存：本模块不 import 任何 fs / store，resume 天然空表。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createLastReadLedger,
  createLastReadLedgerHost,
} from "../../../src/harness/aci/last-read-ledger.ts";

describe("createLastReadLedger — 单会话账本", () => {
  it("record 后 has 命中；未 record 的 path 恒不命中", () => {
    const ledger = createLastReadLedger();
    ledger.record("/ws/a.ts");

    assert.equal(ledger.has("/ws/a.ts"), true);
    assert.equal(ledger.has("/ws/b.ts"), false);
  });

  it("record 幂等：重复记同一 path 不涨条数", () => {
    const ledger = createLastReadLedger();
    ledger.record("/ws/a.ts");
    ledger.record("/ws/a.ts");

    assert.equal(ledger.size(), 1);
  });

  it("空输入：空串 path 也只是一个普通键（账本不解析 path，调用方负责规范化）", () => {
    const ledger = createLastReadLedger();
    assert.equal(ledger.has(""), false);
    ledger.record("");
    assert.equal(ledger.has(""), true);
    assert.equal(ledger.size(), 1);
  });

  it("destroy 后清空（reset / 会话结束）", () => {
    const ledger = createLastReadLedger();
    ledger.record("/ws/a.ts");
    ledger.destroy();

    assert.equal(ledger.has("/ws/a.ts"), false);
    assert.equal(ledger.size(), 0);
  });
});

describe("createLastReadLedgerHost — 多会话分桶", () => {
  it("同 conversationId 多次取拿回同一对象，path 可见", () => {
    const host = createLastReadLedgerHost();
    const first = host.ledgerFor("conv-a");
    first?.record("/ws/a.ts");

    assert.equal(host.ledgerFor("conv-a")?.has("/ws/a.ts"), true);
  });

  it("异 conversationId 互不可见（禁止跨会话串读）", () => {
    const host = createLastReadLedgerHost();
    host.ledgerFor("conv-a")?.record("/ws/a.ts");

    assert.equal(host.ledgerFor("conv-b")?.has("/ws/a.ts"), false);
  });

  it("undefined conversationId → undefined，且不建匿名桶（spec D1 显式例外）", () => {
    const host = createLastReadLedgerHost();
    assert.equal(host.ledgerFor(undefined), undefined);
    // 不建桶：host 里没有任何会话账本可被后来的 undefined 命中。
    assert.equal(host.size(), 0);
  });

  it("destroy 只清目标会话，其余会话不受影响", () => {
    const host = createLastReadLedgerHost();
    host.ledgerFor("conv-a")?.record("/ws/a.ts");
    host.ledgerFor("conv-b")?.record("/ws/b.ts");

    host.destroy("conv-a");

    assert.equal(host.ledgerFor("conv-a")?.has("/ws/a.ts"), false);
    assert.equal(host.ledgerFor("conv-b")?.has("/ws/b.ts"), true);
  });

  it("destroy 未知 conversationId → no-op（不抛）", () => {
    const host = createLastReadLedgerHost();
    host.destroy("never-seen");
    assert.equal(host.size(), 0);
  });

  it("destroyAll 清空全部会话（引擎 shutdown）", () => {
    const host = createLastReadLedgerHost();
    host.ledgerFor("conv-a")?.record("/ws/a.ts");
    host.ledgerFor("conv-b")?.record("/ws/b.ts");

    host.destroyAll();

    assert.equal(host.size(), 0);
    // destroyAll 后新取一份 → 空表（resume / 重启的空表语义）。
    assert.equal(host.ledgerFor("conv-a")?.size(), 0);
  });

  it("resume 语义：新建 host（进程重启的等价形态）→ 空表", () => {
    const first = createLastReadLedgerHost();
    first.ledgerFor("conv-a")?.record("/ws/a.ts");

    const second = createLastReadLedgerHost();
    assert.equal(second.ledgerFor("conv-a")?.has("/ws/a.ts"), false);
  });
});
