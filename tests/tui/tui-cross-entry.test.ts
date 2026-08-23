/**
 * tests/tui/tui-cross-entry.test.ts
 *
 * #343 T6-C：SC 8 Q6 验收 TUI 半边（镜像 tests/session-api/cross-entry-consistency
 * 的 serve 半边）。TUI bridge ↔ 独立 serve 风格 hub 共享同一 SessionStore
 * 池：
 *   Step 1  TUI bridge 建档 + postMessage N 轮
 *   Step 2  独立 hub load：messages / turnCount / title / schemaVersion 一致
 *   Step 3  独立 hub 续跑第 N+1 轮保存
 *   Step 4  TUI bridge 再读：N+1 可见
 *
 * 纯逻辑（不依赖 React/TUI 渲染），仅 exercises hub-bridge + SessionHub
 * 跨进程一致语义。bun:test（D2 裁决）。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import {
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/session-store.js";
import { parseSessionJsonl } from "../../src/session-api/store/jsonl.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/schema.js";
import { SessionHub } from "../../src/session-api/hub.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

describe("Q6 验收 TUI 半边：TUI bridge ↔ 独立 hub 共享池", () => {
  let baseDir: string;
  const cwd = process.cwd();

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "iknow-tui-cross-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("TUI 写入的会话，独立入口读回并续跑，反之亦然（SC 8）", async () => {
    // TUI 侧：bridge（α 直连，注入 stub deps）
    const tuiDeps = makeDeps([
      assistantResult({ texts: ["第一轮答复"] }),
      assistantResult({ texts: ["第二轮答复"] }),
    ]);
    const bridge = createTuiBridge({
      dataDir: baseDir,
      deps: tuiDeps,
      inflight: createInflightRegistry(),
    });

    // Step 1：TUI 建档 + 2 轮
    const id = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id, text: "第一个问题" });
    await bridge.postMessage({ conversationId: id, text: "第二个问题" });

    // Step 2：独立 hub（模拟另一进程）load 断言一致
    const serveStore = new SessionStore(baseDir, cwd);
    const serveHub = new SessionHub({
      store: serveStore,
      deps: makeDeps([assistantResult({ texts: ["第三轮答复"] })]),
      askUser: createNoAskUser(),
    });
    const serveView = await serveHub.getSession(id);
    expect(serveView.session.conversation_id).toBe(id);
    expect(serveView.session.turn_count).toBe(2);
    // 磁盘 JSONL 头记录直读交叉核对（SSOT = 文件; #629 去掉 .json 镜像）。
    const dir = resolveProjectSessionDir(baseDir, cwd);
    const jsonlRaw = readFileSync(join(dir, `${id}.jsonl`), "utf8");
    const raw = parseSessionJsonl(jsonlRaw).header as {
      schemaVersion: number;
      turnCount: number;
      title: string;
      cwd: string;
    };
    // schemaVersion 不断言硬编码数字（曾写死 2，schema 演进到 5 后腐烂）——
    // 与 SSOT 常量对齐，演进时自动跟随。
    expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(raw.turnCount).toBe(2);
    expect(raw.title).toBe("第一个问题");
    expect(raw.cwd).toBe(cwd);

    // Step 3：独立 hub 续跑第 N+1 轮
    await serveHub.postMessage({ conversationId: id, text: "第三个问题" });

    // Step 4：TUI bridge 再读：N+1 可见
    const file = await bridge.loadSessionFile(id);
    expect(file.turnCount).toBe(3);
    expect(file.title).toBe("第一个问题"); // title = 首条 user，不随轮变
    const assistantTexts = file.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
      );
    expect(assistantTexts).toEqual(["第一轮答复", "第二轮答复", "第三轮答复"]);
    // TUI 列表视图数据源（SC 13：list() title 字段）
    const list = await bridge.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("第一个问题");
  });
});
