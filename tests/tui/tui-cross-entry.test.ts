/**
 * tests/tui/tui-cross-entry.test.ts
 *
 * Cross-entry consistency acceptance, TUI half (mirrors the serve half in
 * tests/session-api/cross-entry-consistency). The TUI bridge and an
 * independent serve-style hub share one SessionStore pool:
 *   Step 1  TUI bridge creates the session + postMessage N turns
 *   Step 2  independent hub load: messages / turnCount / title / schemaVersion agree
 *   Step 3  independent hub runs turn N+1 and saves
 *   Step 4  TUI bridge re-reads: N+1 visible
 *
 * Pure logic (no React/TUI rendering), only exercises hub-bridge + SessionHub
 * cross-process consistency semantics. bun:test.
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
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/session-store.js";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.js";
import { parseSessionJsonl } from "../../src/session-api/store/jsonl.js";
import { CURRENT_SCHEMA_VERSION } from "../../src/session-api/store/schema.js";
import { SessionHub } from "../../src/session-api/hub.js";
import { createNoAskUser } from "../../src/harness/permission/ask-user.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

describe("Q6 验收 TUI 半边：TUI bridge ↔ 独立 hub 共享池", () => {
  let baseDir: string;
  // T1 (session-folder-consolidation): both the bridge and the "independent
  // entry" store must derive the same projectIdentityRoot (hub-bridge derives
  // it from workspaceRoot) — otherwise the two land in different project
  // folders and cross-entry reads hit not_found.
  let projectIdentityRoot: string;
  let projectDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "iknow-tui-cross-"));
    projectIdentityRoot = deriveProjectIdentityRoot({ cwd: baseDir });
    projectDir = resolveProjectSessionDir(baseDir, projectIdentityRoot);
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("TUI 写入的会话，独立入口读回并续跑，反之亦然（SC 8）", async () => {
    // TUI side: bridge (direct wiring, stub deps injected)
    const tuiDeps = makeDeps([
      assistantResult({ texts: ["第一轮答复"] }),
      assistantResult({ texts: ["第二轮答复"] }),
    ]);
    const bridge = createTuiBridge({
      dataDir: baseDir,
      workspaceRoot: baseDir,
      deps: tuiDeps,
      inflight: createInflightRegistry(),
    });

    // Step 1: TUI creates the session + 2 turns
    const id = await bridge.ensureSession(undefined);
    await bridge.postMessage({ conversationId: id, text: "第一个问题" });
    await bridge.postMessage({ conversationId: id, text: "第二个问题" });

    // Step 2: independent hub (simulating another process) load and assert consistency
    const serveStore = new SessionStore(baseDir, projectIdentityRoot);
    const serveHub = new SessionHub({
      store: serveStore,
      deps: makeDeps([assistantResult({ texts: ["第三轮答复"] })]),
      askUser: createNoAskUser(),
    });
    const serveView = await serveHub.getSession(id);
    expect(serveView.session.conversation_id).toBe(id);
    expect(serveView.session.turn_count).toBe(2);
    // Cross-check against the on-disk JSONL header read directly (SSOT = the
    // file; the .json mirror was removed; the authoritative JSONL lives inside
    // the `<projectDir>/<conversationId>/` session folder).
    const dir = resolveConversationDir({ projectDir, conversationId: id });
    const jsonlRaw = readFileSync(join(dir, `${id}.jsonl`), "utf8");
    const raw = parseSessionJsonl(jsonlRaw).header as {
      schemaVersion: number;
      turnCount: number;
      title: string;
      cwd: string;
      workspaceRoot: string;
    };
    // Don't assert schemaVersion as a hardcoded number (once pinned to 2, rotted
    // once the schema evolved to 5) — align with the SSOT constant so it follows
    // future evolution automatically.
    expect(raw.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(raw.turnCount).toBe(2);
    expect(raw.title).toBe("第一个问题");
    expect(raw.cwd).toBe(baseDir);
    expect(raw.workspaceRoot).toBe(baseDir);

    // Step 3: independent hub runs turn N+1
    await serveHub.postMessage({ conversationId: id, text: "第三个问题" });

    // Step 4: TUI bridge re-reads: N+1 visible
    const file = await bridge.loadSessionFile(id);
    expect(file.turnCount).toBe(3);
    expect(file.title).toBe("第一个问题"); // title = first user message, stable across turns
    const assistantTexts = file.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) =>
        m.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
      );
    expect(assistantTexts).toEqual(["第一轮答复", "第二轮答复", "第三轮答复"]);
    // Data source for the TUI list view (list() title field)
    const list = await bridge.listSessions();
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe("第一个问题");
  });
});
