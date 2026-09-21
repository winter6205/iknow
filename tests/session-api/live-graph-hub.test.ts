/**
 * SessionHub-side live-graph ledger lifecycle.
 *
 * Three pinned boundaries:
 *   1. resetSession(conversationId) destroys that conversation's ledger;
 *     previously frozen ids are no longer rejected and run_graph may be
 *     resubmitted;
 *   2. compactSession(conversationId) does NOT destroy the ledger (it is an
 *     in-process object; compact only touches the JSONL file, so frozen ids
 *     still block re-runs);
 *   3. process-level shutdown() — destroyAll destroys every conversation's
 *     ledger with no leak into the next hub instance (the hub is a
 *     multi-session entry point, the strongest lifecycle boundary).
 *
 * The test builds `LiveGraphLedgerHost` itself and injects it via the
 * `liveGraphLedger` field, matching how CLI / TUI / serve actually assemble
 * (all hand the singleton host to the hub).
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

/** Same shape as the handler: ensure() then freeze(id, status) — loads the
 *  "already frozen" state into the real LiveGraphLedger to avoid stub drift
 *  (handler wiring is covered by run-graph-ledger.test.ts). */
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
      // Two real messages so compact actually trims; going through a real
      // save makes the "ledger untouched" assert harder than an early-exit.
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

      // The ledger is not in the JSONL; compact only touches the file — frozen ids must stay rejected.
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
    // Ledger destruction happens on the first line of work() (before
    // store.load) — it stands even when load throws not_found.
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
