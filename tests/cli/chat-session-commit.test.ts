/**
 * tests/cli/chat-session-commit.test.ts
 *
 * In-turn commit hook on the chat path. Verifies createChatSessionCommitHook:
 * 1) first commit with no JSONL on disk → bootstrap the file from getPriors()
 *    in-memory messages, then append (the user query is never lost);
 * 2) later commits chain onto the current head;
 * 3) a legacy .json-only session → the first commit migrates out a JSONL,
 *    keeping title/turnCount;
 * 4) underlying IO failure propagates as a typed store error (never swallowed);
 * 5) processChatLine passes deps.commitMessages through to the harness run.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChatSessionCommitHook,
  processChatLine,
} from "../../src/cli/chat-session.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.js";
import { ValidationError } from "../../src/shared/errors.js";
import { assistantResult, makeCtx } from "./_fixtures.js";

function storeErrorKind(err: unknown): string | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const kind = (err as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : undefined;
}

function assistantMsg(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-chat-commit-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("T3 (#620): createChatSessionCommitHook", () => {
  it("JSONL 缺失 without workspaceRoot → refuse bootstrap with typed error", async () => {
    await withTempDir(async (baseDir) => {
      const store = new SessionStore(baseDir, process.cwd());
      const commit = createChatSessionCommitHook({
        store,
        conversationId: "chat-commit-rootless",
        jsonMode: false,
        getPriors: () => [],
      });

      await assert.rejects(
        () => commit([assistantMsg("a1")]),
        (err: unknown) => err instanceof ValidationError
      );
    });
  });

  it("JSONL 缺失:首个 commit 用 priors bootstrap,assistant 事件落盘", async () => {
    await withTempDir(async (baseDir) => {
      const store = new SessionStore(baseDir, process.cwd());
      const id = "chat-commit-fresh";
      const priors = [userMsg("q1")];
      const commit = createChatSessionCommitHook({
        store,
        conversationId: id,
        jsonMode: false,
        getPriors: () => priors,
        workspaceRoot: baseDir,
      });

      await commit([assistantMsg("a1")]);

      const sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
      const raw = await readFile(
        join(
          resolveConversationDir({
            projectDir: sessionDir,
            conversationId: id,
          }),
          `${id}.jsonl`
        ),
        "utf8"
      );
      const log = parseSessionJsonl(raw);
      assert.equal(log.events.length, 2);
      assert.equal(log.head, "e1");
      assert.equal(log.events[0]!.message.role, "user");
      assert.equal(log.events[1]!.message.role, "assistant");
      assert.equal(log.events[1]!.parent, "e0");
      const file = await store.load(id);
      assert.equal(file.workspaceRoot, baseDir);
      assert.equal(file.cwd, baseDir);
    });
  });

  it("后续 commit 链接到当前 head(turn 内逐条 append)", async () => {
    await withTempDir(async (baseDir) => {
      const store = new SessionStore(baseDir, process.cwd());
      const id = "chat-commit-chain";
      const commit = createChatSessionCommitHook({
        store,
        conversationId: id,
        jsonMode: false,
        getPriors: () => [],
        workspaceRoot: baseDir,
      });

      await commit([assistantMsg("a1")]);
      await commit([userMsg("tool_result 占位")]);

      const sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
      const raw = await readFile(
        join(
          resolveConversationDir({
            projectDir: sessionDir,
            conversationId: id,
          }),
          `${id}.jsonl`
        ),
        "utf8"
      );
      const log = parseSessionJsonl(raw);
      assert.equal(log.events.length, 2);
      assert.equal(log.head, "e1");
      assert.equal(log.events[1]!.parent, "e0");
      assert.equal(log.events[1]!.message.role, "user");
    });
  });

  it("legacy .json-only 会话:首个 commit 迁出 JSONL,title/turnCount 保留", async () => {
    await withTempDir(async (baseDir) => {
      const store = new SessionStore(baseDir, process.cwd());
      const id = "chat-commit-legacy";
      const sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
      const dir = resolveConversationDir({
        projectDir: sessionDir,
        conversationId: id,
      });
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${id}.json`),
        JSON.stringify({
          schemaVersion: CURRENT_SCHEMA_VERSION,
          conversation_id: id,
          title: "legacy title",
          cwd: "/tmp/test",
          sanitized_at: "2026-08-21T00:00:00.000Z",
          updatedAt: "2026-08-21T00:00:00.000Z",
          messages: [userMsg("old q"), assistantMsg("old a")],
          turnCount: 3,
          jsonMode: false,
          checkpoints: [],
        }),
        "utf8"
      );
      const commit = createChatSessionCommitHook({
        store,
        conversationId: id,
        jsonMode: false,
        getPriors: () => [],
      });

      await commit([assistantMsg("new a")]);

      const loaded = await store.load(id);
      assert.equal(loaded.messages.length, 3);
      assert.equal(loaded.title, "legacy title");
      assert.equal(loaded.turnCount, 3);
      const raw = await readFile(join(dir, `${id}.jsonl`), "utf8");
      const log = parseSessionJsonl(raw);
      assert.equal(log.events.length, 3);
      assert.equal(log.head, "e2");
    });
  });

  it("底层 IO 失败:以 typed store error 传播(不吞)", async () => {
    await withTempDir(async (baseDir) => {
      // A plain file at the projects/ path → every mkdir/read/write hits ENOTDIR.
      await writeFile(join(baseDir, "projects"), "not a dir", "utf8");
      const store = new SessionStore(baseDir, process.cwd());
      const commit = createChatSessionCommitHook({
        store,
        conversationId: "chat-commit-io-fail",
        jsonMode: false,
        getPriors: () => [],
        workspaceRoot: baseDir,
      });

      await assert.rejects(
        () => commit([assistantMsg("a1")]),
        (err: unknown) => {
          const kind = storeErrorKind(err);
          return kind === "io_error" || kind === "write_failed";
        }
      );
    });
  });

  it("processChatLine 把 deps.commitMessages 透传进 harness run", async () => {
    const commits: ReadonlyArray<AnthropicNativeMessage>[] = [];
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["a1"] })],
      stateOverrides: { conversationId: "chat-commit-passthrough" },
    });
    ctx.deps = {
      ...ctx.deps,
      commitMessages: async (messages) => {
        commits.push(messages);
      },
    };
    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.ranQuery, true);
    assert.equal(commits.length, 1);
    assert.equal(commits[0]!.length, 1);
    assert.equal(commits[0]![0]!.role, "assistant");
  });
});
