/**
 * D-α T3 —— hub host 的 round 边界（serve + TUI 走同一条 postMessage 路径）。
 *
 * chat 那侧的 round 是「一条查询行」，hub 这侧是「一条 postMessage」。两处
 * 语义必须一致，否则同一个 `/graph on` 在 CLI 与 TUI 上生效时机不同 ——
 * SC3 的「三入口同一 overlay」就名存实亡。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { createGraphModeContext } from "../../src/harness/graph/mode.ts";
import {
  createGraphAssembly,
  type GraphAssembly,
} from "../../src/harness/graph/assembly.ts";

let dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

describe("SessionHub — graph 装配 round 边界", () => {
  it("每条 postMessage 前拍一次快照：翻 holder 要下一条消息才进装配面", async () => {
    const store = new SessionStore(await tmpDir("iknow-graph-round-store-"));
    const root = await tmpDir("iknow-graph-round-root-");
    const mode = createGraphModeContext();
    const inner: GraphAssembly = createGraphAssembly(mode);
    const seen: boolean[] = [];
    const graphAssembly: GraphAssembly = {
      beginRound: () => inner.beginRound(),
      enabled: inner.enabled,
    };

    const hub = new SessionHub({
      store,
      surface: "serve",
      askUser: createNoAskUser(),
      buildEngine: async () => ({
        deps: makeDeps([
          assistantResult({ texts: ["one"] }),
          assistantResult({ texts: ["two"] }),
        ]),
        graphAssembly,
      }),
    });
    await hub.bindWorkspace(root);
    const { session } = await hub.createSession();

    mode.setEnabled(true);
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "first",
    });
    seen.push(graphAssembly.enabled());

    mode.setEnabled(false);
    await hub.postMessage({
      conversationId: session.conversation_id,
      text: "second",
    });
    seen.push(graphAssembly.enabled());

    // 第一条消息把「已翻开」拍进去；第二条把「已翻关」拍进去。
    expect(seen).toEqual([true, false]);
  });

  it("buildEngine 不给 graphAssembly → postMessage 照常（未接 overlay 零变化）", async () => {
    const store = new SessionStore(await tmpDir("iknow-graph-round-store2-"));
    const root = await tmpDir("iknow-graph-round-root2-");
    const hub = new SessionHub({
      store,
      surface: "serve",
      askUser: createNoAskUser(),
      buildEngine: async () => ({
        deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      }),
    });
    await hub.bindWorkspace(root);
    const { session } = await hub.createSession();
    const res = await hub.postMessage({
      conversationId: session.conversation_id,
      text: "hi",
    });
    expect(res).toBeDefined();
  });
});
