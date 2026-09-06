/**
 * Per-conversationId todo ledger isolation.
 *
 * Invariant: a todo ledger is scoped to ONE conversation — `todo_write`
 * resolves the ledger at call time from `ctx.conversationId` (SSOT:
 * `resolveConversationTodoDir`), and the agent-status bar projection reads
 * the same per-conversation path. Cross-conversation leakage (issue: a
 * finished session's open item appearing in every later TUI session's
 * `<agent_status>` bar) must be structurally impossible.
 *
 * Backward contract: handlers invoked without a ToolExecutionContext (or
 * without `conversationId`) fall back to the shared root `todos.md` — the
 * pre-isolation layout — so hosts that never inject conversationId keep
 * byte-identical behavior.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTodoWriteTool,
  resolveConversationTodoDir,
  TODOS_FILE,
} from "../../../../src/harness/aci/tools/todo-write.ts";
import {
  computeAgentStatusSnapshot,
  readOpenTodoLines,
} from "../../../../src/harness/agent-status.ts";

let todoDir: string;

beforeEach(async () => {
  todoDir = await mkdtemp(join(tmpdir(), "todo-per-conv-"));
});

afterEach(async () => {
  await rm(todoDir, { recursive: true, force: true });
});

const CALL_A = { conversationId: "conv-aaaa" } as const;
const CALL_B = { conversationId: "conv-bbbb" } as const;

async function add(
  tool: ReturnType<typeof createTodoWriteTool>,
  item: string,
  ctx?: { conversationId?: string }
) {
  return tool.handler({ mode: "add", item }, ctx);
}

describe("resolveConversationTodoDir", () => {
  it("with conversationId → <todoDir>/<sanitized conversationId>/todos.md", () => {
    const p = resolveConversationTodoDir({ todoDir, conversationId: "conv-1" });
    assert.equal(p, join(todoDir, "conv-1", TODOS_FILE));
  });

  it("sanitizes path-hostile segments (no traversal, no separators)", () => {
    const p = resolveConversationTodoDir({
      todoDir,
      conversationId: "../../etc",
    });
    assert.ok(!p.includes(".."));
    assert.ok(p.startsWith(todoDir));
  });

  it("absent conversationId → root todos.md (pre-isolation layout)", () => {
    const p = resolveConversationTodoDir({ todoDir });
    assert.equal(p, join(todoDir, TODOS_FILE));
  });

  it("empty conversationId → root todos.md", () => {
    const p = resolveConversationTodoDir({ todoDir, conversationId: "" });
    assert.equal(p, join(todoDir, TODOS_FILE));
  });
});

describe("todo_write per-conversation isolation (handler reads ctx.conversationId)", () => {
  it("add under conv-a is invisible to conv-b list", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "only in a", { ...CALL_A });
    const seenByB = await tool.handler({ mode: "list" }, { ...CALL_B });
    const seenByA = await tool.handler({ mode: "list" }, { ...CALL_A });
    assert.equal(seenByB, "");
    assert.match(seenByA as string, /only in a/);
  });

  it("ledger physically lands at <todoDir>/<conversationId>/todos.md", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "disk layout", { ...CALL_A });
    const content = await readFile(
      resolveConversationTodoDir({
        todoDir,
        conversationId: CALL_A.conversationId,
      }),
      "utf8"
    );
    assert.match(content, /- \[ \] disk layout/);
    // root ledger untouched
    await assert.rejects(readFile(join(todoDir, TODOS_FILE), "utf8"), /ENOENT/);
  });

  it("no ctx (undefined) → legacy root todos.md", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "legacy layout");
    const content = await readFile(join(todoDir, TODOS_FILE), "utf8");
    assert.match(content, /- \[ \] legacy layout/);
  });

  it("ctx without conversationId → legacy root todos.md", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "no id", {});
    const content = await readFile(join(todoDir, TODOS_FILE), "utf8");
    assert.match(content, /- \[ \] no id/);
  });

  it("check flips within the caller's conversation only", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "task x", { ...CALL_A });
    await tool.handler({ mode: "check", item: "task x" }, { ...CALL_A });
    const a = (await tool.handler({ mode: "list" }, { ...CALL_A })) as string;
    assert.match(a, /- \[x\] task x/);
    // conv-b never saw the item → check there is a typed error, not a flip
    await assert.rejects(
      tool.handler({ mode: "check", item: "task x" }, { ...CALL_B })
    );
  });
});

describe("agent-status projection is per-conversation", () => {
  it("readOpenTodoLines resolves the same per-conversation path (SSOT)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "open in a", { ...CALL_A });
    const forA = await readOpenTodoLines(todoDir, CALL_A.conversationId);
    const forB = await readOpenTodoLines(todoDir, CALL_B.conversationId);
    assert.deepEqual(forA, ["- [ ] open in a"]);
    assert.deepEqual(forB, []);
  });

  it("computeAgentStatusSnapshot without conversationId reads root (legacy parity)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "root item");
    const snap = await computeAgentStatusSnapshot({
      lastTool: "bash",
      todoDir,
    });
    assert.deepEqual(snap.openTodoLines, ["- [ ] root item"]);
  });
});
