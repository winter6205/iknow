/**
 * live-graph-phase1 T1 — SessionHub 侧活图账本生命周期（SC3 后半段 + SC4）。
 *
 * 三条钉死的边界：
 *   1. SC3 — `resetSession(conversationId)` 销毁该 conversation 的账本,
 *     旧冻结 id 不再被拒,可重新提交 run_graph;
 *   2. SC4 — `compactSession(conversationId)` **不**销毁账本（in-process
 *     对象,compact 只动 JSONL 文件;冻结 id 仍拒重跑）;
 *   3. 进程级 `shutdown()` — `destroyAll` 销毁全部 conversation 账本,无
 *     泄漏到下一个 hub 实例（hub 是多会话入口,SC3 后半段的最强边界）。
 *
 * `LiveGraphLedgerHost` 由测试自己建,经 `liveGraphLedger` 字段注入 hub,
 * 与 CLI / TUI / serve 三入口的实际装配对齐(都把单例 host 交给 hub)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import {
  createLiveGraphLedgerHost,
  type LiveGraphLedgerHost,
} from "../../src/harness/graph/ledger.ts";
import { makeDeps } from "../cli/_fixtures.ts";

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-live-graph-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function makeHubWithLedger(host: LiveGraphLedgerHost): SessionHub {
  return new SessionHub({
    store,
    deps: makeDeps([]),
    workspaceRoot: process.cwd(),
    liveGraphLedger: host,
  });
}

/** 与 handler 同型:ensure() 后 freeze(id, status) —— 把"已冻结"状态装入
 *  真实 LiveGraphLedger,避免 stub 漂移（handler 接线由 run-graph-ledger.test.ts 覆盖）。 */
function freezeLedger(
  host: LiveGraphLedgerHost,
  convId: string,
  id: string,
  status: "done" | "failed" = "done"
): void {
  const ledger = host.ledgerFor(convId);
  ledger.ensure();
  ledger.freeze(id, status);
}

describe("SessionHub 活图账本生命周期（SC3 后半段 + SC4）", () => {
  it("resetSession 销毁该 conversation 的账本：旧 id 不再冻结", async () => {
    const host = createLiveGraphLedgerHost();
    const hub = makeHubWithLedger(host);
    try {
      await hub.bindWorkspace(process.cwd());
      const convId = (await hub.createSession()).session.conversation_id;
      freezeLedger(host, convId, "node-A");
      expect(host.ledgerFor(convId).isFrozen("node-A")).toBe(true);

      await hub.resetSession(convId);
      expect(host.size()).toBe(0);
      expect(host.ledgerFor(convId).isFrozen("node-A")).toBe(false);
    } finally {
      await hub.shutdown();
    }
  });

  it("compactSession 不销毁账本（SC4 — compact 不扔）", async () => {
    const host = createLiveGraphLedgerHost();
    const hub = makeHubWithLedger(host);
    try {
      await hub.bindWorkspace(process.cwd());
      const convId = (await hub.createSession()).session.conversation_id;
      // 写两条消息让 compact 真的裁（空会话早退 compacted=false 也行,但
      // 走一遍真实 save 让 compact 动过文件再断言"账本不动"更硬）。
      const baseFile = await store.load(convId);
      await store.save({
        id: convId,
        file: {
          ...baseFile,
          messages: [
            { role: "user", content: [{ type: "text", text: "first" }] },
            {
              role: "assistant",
              content: [{ type: "text", text: "answer-1" }],
            },
          ],
        },
      });

      freezeLedger(host, convId, "node-B");
      const before = host.ledgerFor(convId).frozenIds();
      expect(before).toEqual(["node-B"]);

      await hub.compactSession(convId);

      // SC4:账本不在 JSONL,compact 只动文件 —— 冻结 id 必须仍被拒。
      const after = host.ledgerFor(convId);
      expect(after.exists()).toBe(true);
      expect(after.frozenIds()).toEqual(before);
      expect(after.isFrozen("node-B")).toBe(true);
    } finally {
      await hub.shutdown();
    }
  });

  it("shutdown() → destroyAll：hub 释放后无账本残留（无泄漏到新会话）", async () => {
    const host = createLiveGraphLedgerHost();
    const hub = makeHubWithLedger(host);
    await hub.bindWorkspace(process.cwd());
    const convId = (await hub.createSession()).session.conversation_id;
    freezeLedger(host, convId, "node-C");
    expect(host.size()).toBe(1);

    await hub.shutdown();
    expect(host.size()).toBe(0);
  });

  it("conversationId 无 session 文件 → resetSession 抛 typed 但账本销毁先于 load 已生效", async () => {
    // 账本销毁发生在 work() 第一行（store.load 之前）—— 即使 load 抛
    // not_found,销毁也已生效。SC3 销毁时机的最严边界。
    const host = createLiveGraphLedgerHost();
    const hub = makeHubWithLedger(host);
    try {
      await hub.bindWorkspace(process.cwd());
      const ghostId = randomUUID();
      freezeLedger(host, ghostId, "ghost-node");
      expect(host.size()).toBe(1);

      await expect(hub.resetSession(ghostId)).rejects.toThrow();
      expect(host.size()).toBe(0);
    } finally {
      await hub.shutdown();
    }
  });
});
