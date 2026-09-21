/**
 * ADR-0102 — seam tests for worker transcripts in session-api.
 *
 * Pins two things:
 *   1. append/load reuse the SessionFileV1 read path (same jsonl codec: the
 *      first batch creates header + chain + head, later batches splice on from
 *      maxEventIndex+1; typed-error vocabulary shares SessionStore kinds, with
 *      the conversation_id slot carrying task_id);
 *   2. `listSessions` (SessionStore.list) never includes workers — worker
 *      ledgers are nested inside the parent session folder's `subagents/`,
 *      invisible to the project-pool leaf enumeration (ADR-0102 Decision 3 /
 *      continuation of ADR-0071: no peer sub-session leaves).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  SessionStore,
  appendWorkerTranscript,
  loadWorkerPreimageEvents,
  loadWorkerTranscript,
  readWorkerSpawnToolUseId,
  sanitizeSessionFile,
  isSessionFileV1,
  type SessionStoreError,
} from "../../src/session-api/store/index.ts";
import type { PreimageRef } from "../../src/session-api/store/jsonl.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";

function user(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}
function assistant(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function toolResult(
  toolUseId: string,
  isError = false
): AnthropicNativeMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: "ok",
        ...(isError ? { is_error: true } : {}),
      },
    ],
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "iknow-worker-transcript-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("worker transcript append/load（SessionFileV1 读路径可吃）", () => {
  it("首批建账：header + events + head；load 投影 = 原批", async () => {
    const transcriptPath = join(dir, "subagents", "t1", "t1.jsonl");
    const loc = { transcriptPath, taskId: "t1" };
    await appendWorkerTranscript({
      location: loc,
      events: [user("task-1"), assistant("answer-1")],
      cwd: "/work/root",
    });
    const file = await loadWorkerTranscript(loc);
    assert.equal(file.conversation_id, "t1");
    assert.equal(file.title, "task-1");
    assert.equal(file.cwd, "/work/root");
    assert.deepEqual(
      file.messages.map((m) => m.content[0]),
      [
        { type: "text", text: "task-1" },
        { type: "text", text: "answer-1" },
      ]
    );
    assert.ok(isSessionFileV1(sanitizeSessionFile(file)));
  });

  it("空批 = no-op，不建文件", async () => {
    const transcriptPath = join(dir, "subagents", "t2", "t2.jsonl");
    await appendWorkerTranscript({
      location: { transcriptPath, taskId: "t2" },
      events: [],
    });
    await assert.rejects(
      () => loadWorkerTranscript({ transcriptPath, taskId: "t2" }),
      (err: unknown) => (err as { kind?: string }).kind === "not_found"
    );
  });

  it("续批从盘上编号继续挂链，head 前移；既有事件不动", async () => {
    const transcriptPath = join(dir, "subagents", "t3", "t3.jsonl");
    const loc = { transcriptPath, taskId: "t3" };
    await appendWorkerTranscript({
      location: loc,
      events: [user("a"), assistant("b")],
    });
    await appendWorkerTranscript({
      location: loc,
      events: [user("c"), assistant("d")],
    });
    const file = await loadWorkerTranscript(loc);
    assert.equal(file.messages.length, 4);
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
    const events = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.type === "message");
    assert.deepEqual(
      events.map((e) => [e.id, e.parent]),
      [
        ["e0", null],
        ["e1", "e0"],
        ["e2", "e1"],
        ["e3", "e2"],
      ]
    );
    const head = JSON.parse(lines[lines.length - 1]!) as {
      type: string;
      id: string;
    };
    assert.deepEqual([head.type, head.id], ["head", "e3"]);
  });

  it("thinkingMs 只挂 assistant 事件（与 SessionStore.appendEvents 同边界）", async () => {
    const transcriptPath = join(dir, "subagents", "t4", "t4.jsonl");
    const loc = { transcriptPath, taskId: "t4" };
    await appendWorkerTranscript({
      location: loc,
      events: [user("q")],
      thinkingMs: 120,
    });
    await appendWorkerTranscript({
      location: loc,
      events: [assistant("a")],
      thinkingMs: 120,
    });
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(transcriptPath, "utf8"))
      .trim()
      .split("\n")
      .slice(1);
    const records = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.type === "message");
    assert.equal(records[0]!.thinkingMs, undefined);
    assert.equal(records[1]!.thinkingMs, 120);
    void loc;
  });

  it("load 无账 → typed not_found（conversation_id 槽 = task_id）", async () => {
    await assert.rejects(
      () =>
        loadWorkerTranscript({
          transcriptPath: join(dir, "missing", "missing.jsonl"),
          taskId: "ghost-task",
        }),
      (err: unknown) => {
        const typed = err as SessionStoreError;
        assert.equal(typed.kind, "not_found");
        assert.equal(typed.conversation_id, "ghost-task");
        return true;
      }
    );
  });

  it("边界：空 task_id 也走得通（键形态不设语义，父侧无归属场景）", async () => {
    const transcriptPath = join(dir, "subagents", "x", "x.jsonl");
    const loc = { transcriptPath, taskId: "" };
    await appendWorkerTranscript({
      location: loc,
      events: [user("hi"), assistant("yo")],
    });
    const file = await loadWorkerTranscript(loc);
    assert.equal(file.conversation_id, "");
    assert.equal(file.messages.length, 2);
  });

  it("崩溃尾部半截行：尾行丢弃、前账仍可读（同一 codec 的 named EXIT）", async () => {
    const transcriptPath = join(dir, "subagents", "t5", "t5.jsonl");
    const loc = { transcriptPath, taskId: "t5" };
    await appendWorkerTranscript({
      location: loc,
      events: [user("q"), assistant("a")],
    });
    const { appendFile, readFile, writeFile } =
      await import("node:fs/promises");
    const before = await readFile(transcriptPath, "utf8");
    await appendFile(
      transcriptPath,
      '{"type":"message","id":"e2","parent":"e1","mes',
      "utf8"
    );
    const file = await loadWorkerTranscript(loc);
    assert.equal(file.messages.length, 2);
    // Clear the half-written line, then confirm the next batch still continues numbering from e2.
    await writeFile(transcriptPath, before, "utf8");
    await appendWorkerTranscript({ location: loc, events: [user("next")] });
    const after = await loadWorkerTranscript(loc);
    assert.equal(after.messages.length, 3);
  });
});

describe("listSessions 不收录工人（工人账嵌在父会话文件夹）", () => {
  it("父会话 + 其 subagents/<taskId>/ 账 → list 只回父会话一条", async () => {
    const baseDir = join(dir, "pool");
    const root = dir;
    const store = new SessionStore(baseDir, root);
    const parent = "parent-conv";
    await store.save({
      id: parent,
      file: {
        schemaVersion: 5,
        conversation_id: parent,
        messages: [user("hello"), assistant("hi there")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: new Date().toISOString(),
        title: "hello",
        cwd: root,
        sanitized_at: new Date().toISOString(),
      },
    });
    const projectDir = store.getProjectDir();
    // The worker ledger lands inside the parent session folder (keyed by (parent conversationId, task_id)).
    const workerTaskId = "worker-task-1";
    await appendWorkerTranscript({
      location: {
        transcriptPath: join(
          projectDir,
          parent,
          "subagents",
          workerTaskId,
          `${workerTaskId}.jsonl`
        ),
        taskId: workerTaskId,
      },
      // With assistant text: proves it is not listed due to the "skip when no assistant" rule.
      events: [user("do work"), assistant("worked")],
    });

    const entries = await store.list();
    assert.deepEqual(
      entries.map((e) => e.conversation_id),
      [parent]
    );
  });
});

describe("worker-ledger preimage stamp + readers (ADR-0119)", () => {
  const ref: PreimageRef = {
    relPath: "w.ts",
    rootIdentity: "/root",
    preimageSha: "pre-1",
    postimageSha: "post-1",
  };

  it("appendWorkerTranscript: 带 preimages 的续批把 codePreimage 盖到成功 tool_result 事件", async () => {
    const transcriptPath = join(dir, "subagents", "p1", "p1.jsonl");
    const loc = { transcriptPath, taskId: "p1" };
    await appendWorkerTranscript({ location: loc, events: [user("q")] });
    await appendWorkerTranscript({
      location: loc,
      events: [toolResult("tu-1")],
      preimages: new Map([["tu-1", ref]]),
    });
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
    const events = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.type === "message");
    assert.equal(
      events[0]!.codePreimage,
      undefined,
      "无 preimage 的事件保持原样"
    );
    assert.deepEqual(events[1]!.codePreimage, ref);
  });

  it("appendWorkerTranscript: is_error 的 tool_result 不盖章（与父侧 appendEvents 同规则）", async () => {
    const transcriptPath = join(dir, "subagents", "p2", "p2.jsonl");
    const loc = { transcriptPath, taskId: "p2" };
    await appendWorkerTranscript({ location: loc, events: [user("q")] });
    await appendWorkerTranscript({
      location: loc,
      events: [toolResult("tu-1", true)],
      preimages: new Map([["tu-1", ref]]),
    });
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(transcriptPath, "utf8")).trim().split("\n");
    const last = JSON.parse(lines[lines.length - 2]!) as Record<
      string,
      unknown
    >;
    assert.equal(last.codePreimage, undefined);
  });

  it("loadWorkerPreimageEvents: 无账 → [] （先于首批提交退出的合法形态）", async () => {
    const out = await loadWorkerPreimageEvents({
      transcriptPath: join(dir, "nope", "nope.jsonl"),
      taskId: "ghost",
    });
    assert.deepEqual(out, []);
  });

  it("loadWorkerPreimageEvents: 只回当前 head 链上带 codePreimage 的事件", async () => {
    const transcriptPath = join(dir, "subagents", "p3", "p3.jsonl");
    const loc = { transcriptPath, taskId: "p3" };
    await appendWorkerTranscript({ location: loc, events: [user("q")] });
    await appendWorkerTranscript({
      location: loc,
      events: [toolResult("tu-1")],
      preimages: new Map([["tu-1", ref]]),
    });
    await appendWorkerTranscript({ location: loc, events: [assistant("a")] });
    const out = await loadWorkerPreimageEvents(loc);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0]!.codePreimage, ref);
  });

  it("loadWorkerPreimageEvents: 账本损坏 → typed error（conversation_id 槽 = task_id），绝不误读为空", async () => {
    const transcriptPath = join(dir, "subagents", "p4", "p4.jsonl");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "subagents", "p4"), { recursive: true });
    await writeFile(
      transcriptPath,
      '{"type":"not-a-session-header"}\n',
      "utf8"
    );
    await assert.rejects(
      () => loadWorkerPreimageEvents({ transcriptPath, taskId: "p4" }),
      (err: unknown) => {
        const typed = err as SessionStoreError;
        assert.ok(
          typed.kind === "parse_failed" || typed.kind === "schema_invalid",
          `kind=${typed.kind}`
        );
        assert.equal(typed.conversation_id, "p4");
        return true;
      }
    );
  });

  it("readWorkerSpawnToolUseId: 有 meta → 回 toolUseId；缺 meta/缺字段 → undefined（legacy 跳过）", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "subagents", "p5"), { recursive: true });
    const metaPath = join(dir, "subagents", "p5", "agent-p5.meta.json");
    await writeFile(
      metaPath,
      JSON.stringify({ toolUseId: "tu-spawn" }),
      "utf8"
    );
    assert.equal(await readWorkerSpawnToolUseId(metaPath, "p5"), "tu-spawn");
    assert.equal(
      await readWorkerSpawnToolUseId(
        join(dir, "subagents", "ghost", "agent-ghost.meta.json"),
        "ghost"
      ),
      undefined
    );
    await writeFile(metaPath, JSON.stringify({ taskId: "p5" }), "utf8");
    assert.equal(await readWorkerSpawnToolUseId(metaPath, "p5"), undefined);
  });

  it("readWorkerSpawnToolUseId: meta 损坏 → typed parse_failed（断链不可辨 ≠ 无链接，必须中止）", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, "subagents", "p6"), { recursive: true });
    const metaPath = join(dir, "subagents", "p6", "agent-p6.meta.json");
    await writeFile(metaPath, "{not json", "utf8");
    await assert.rejects(
      () => readWorkerSpawnToolUseId(metaPath, "p6"),
      (err: unknown) => {
        const typed = err as SessionStoreError & { reason?: string };
        assert.equal(typed.kind, "parse_failed");
        assert.equal(typed.conversation_id, "p6");
        assert.equal(typed.reason, "worker_meta_json");
        return true;
      }
    );
  });
});
