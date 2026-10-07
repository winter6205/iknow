/**
 * Per-conversationId todo ledger isolation.
 *
 * Invariant: a todo ledger is scoped to ONE conversation — `todo_write`
 * resolves the ledger at call time from `ctx.conversationId` (SSOT:
 * `resolveConversationTodoPath`), and the agent-status bar projection reads
 * the same per-conversation path. Cross-conversation leakage (issue: a
 * finished session's open item appearing in every later TUI session's
 * `<agent_status>` bar) must be structurally impossible.
 *
 * Backward contract: handlers invoked without a ToolExecutionContext (or
 * without `conversationId`) fall back to the shared root `todos.md` — the
 * pre-isolation layout — so hosts that never inject conversationId keep
 * byte-identical behavior.
 *
 * #903: `mode=replace` writes twice (rename current → snapshot, then atomic
 * write of the new current); both must stay inside the caller's conversation
 * directory, so the isolation invariant is pinned on that branch too.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTodoWriteTool,
  resolveConversationTodoPath,
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

/** First id of a read result (add receipt already names it; kept for clarity). */
function firstIdOf(receipt: unknown): string {
  const match = /Added 1 item: (t\d+)/.exec(String(receipt));
  if (match === null) throw new Error(`no id in receipt: ${String(receipt)}`);
  return match[1]!;
}

describe("resolveConversationTodoPath", () => {
  it("with conversationId → <todoDir>/<sanitized conversationId>/todos.md", () => {
    const p = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: "conv-1",
    });
    assert.equal(p, join(todoDir, "conv-1", TODOS_FILE));
  });

  it("sanitizes path-hostile segments (no traversal, no separators)", () => {
    const p = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: "../../etc",
    });
    assert.ok(!p.includes(".."));
    assert.ok(p.startsWith(todoDir));
  });

  it("absent conversationId → root todos.md (pre-isolation layout)", () => {
    const p = resolveConversationTodoPath({ projectDir: todoDir });
    assert.equal(p, join(todoDir, TODOS_FILE));
  });

  it("empty conversationId → root todos.md", () => {
    const p = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: "",
    });
    assert.equal(p, join(todoDir, TODOS_FILE));
  });
});

describe("todo_write per-conversation isolation (handler reads ctx.conversationId)", () => {
  it("add under conv-a is invisible to conv-b read", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "only in a", { ...CALL_A });
    const seenByB = await tool.handler({ mode: "read" }, { ...CALL_B });
    const seenByA = await tool.handler({ mode: "read" }, { ...CALL_A });
    assert.equal(seenByB, "");
    assert.match(seenByA as string, /only in a/);
  });

  it("ledger physically lands at <todoDir>/<conversationId>/todos.md", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "disk layout", { ...CALL_A });
    const content = await readFile(
      resolveConversationTodoPath({
        projectDir: todoDir,
        conversationId: CALL_A.conversationId,
      }),
      "utf8"
    );
    assert.match(content, /- \[ \] \[t1\] disk layout/);
    // root ledger untouched
    await assert.rejects(readFile(join(todoDir, TODOS_FILE), "utf8"), /ENOENT/);
  });

  it("no ctx (undefined) → legacy root todos.md", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "legacy layout");
    const content = await readFile(join(todoDir, TODOS_FILE), "utf8");
    assert.match(content, /- \[ \] \[t1\] legacy layout/);
  });

  it("ctx without conversationId → legacy root todos.md", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "no id", {});
    const content = await readFile(join(todoDir, TODOS_FILE), "utf8");
    assert.match(content, /- \[ \] \[t1\] no id/);
  });

  it("update status=completed flips within the caller's conversation only", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const receipt = await add(tool, "task x", { ...CALL_A });
    const id = firstIdOf(receipt);
    await tool.handler(
      { mode: "update", id, status: "completed" },
      { ...CALL_A }
    );
    const a = (await tool.handler({ mode: "read" }, { ...CALL_A })) as string;
    assert.match(a, /- \[x\] \[t1\] task x/);
    // conv-b never saw the item → the same id is unknown there: typed error.
    await assert.rejects(
      async () =>
        tool.handler(
          { mode: "update", id, status: "completed" },
          { ...CALL_B }
        ),
      /unknown id/
    );
  });
});

// ---------------------------------------------------------------------------
// replace's per-conversation isolation
//
// replace has two write actions beyond add/check that could leak across
// sessions: (1) renaming the old current file into a snapshot and (2) the
// atomic write of the new current file. Both must stay inside the caller's
// own session directory — one replace must never clear, overwrite, or
// snapshot another session's ledger. Isolation is derived in exactly one
// place, `resolveConversationTodoPath` (SSOT); this section pins that
// invariant on the replace branch.
// ---------------------------------------------------------------------------

/** Snapshot file names inside a session directory (`todos.<unixMs>.<hex>.md`). */
async function snapshotsOf(conversationId: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(join(todoDir, conversationId));
  return entries.filter((n) => /^todos\.\d+\.[0-9a-f]{12}\.md$/.test(n));
}

async function currentOf(conversationId: string): Promise<string> {
  return await readFile(
    resolveConversationTodoPath({ projectDir: todoDir, conversationId }),
    "utf8"
  );
}

describe("todo_write replace per-conversation isolation", () => {
  it("conv-a 的 replace 不动 conv-b 的现行,也不在 conv-b 目录建快照", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "a-old-1", { ...CALL_A });
    await add(tool, "b-keeps-this", { ...CALL_B });

    await tool.handler({ mode: "replace", items: ["a-new-1"] }, { ...CALL_A });

    // conv-a: table swapped + one snapshot in its own directory.
    assert.equal(
      await currentOf(CALL_A.conversationId),
      "- [ ] [t1] a-new-1\n"
    );
    assert.equal((await snapshotsOf(CALL_A.conversationId)).length, 1);

    // conv-b: current file byte-identical + no snapshot in its directory.
    assert.equal(
      await currentOf(CALL_B.conversationId),
      "- [ ] [t1] b-keeps-this\n"
    );
    assert.deepEqual(await snapshotsOf(CALL_B.conversationId), []);
  });

  it("两会话各自 replace → 各自一份快照,内容互不污染", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "a-v1", { ...CALL_A });
    await add(tool, "b-v1", { ...CALL_B });

    await tool.handler({ mode: "replace", items: ["a-v2"] }, { ...CALL_A });
    await tool.handler({ mode: "replace", items: ["b-v2"] }, { ...CALL_B });

    const aSnaps = await snapshotsOf(CALL_A.conversationId);
    const bSnaps = await snapshotsOf(CALL_B.conversationId);
    assert.equal(aSnaps.length, 1);
    assert.equal(bSnaps.length, 1);

    // Each snapshot contains only its own old content — snapshots land in the correct session directory.
    const aSnapshot = await readFile(
      join(todoDir, CALL_A.conversationId, aSnaps[0]),
      "utf8"
    );
    const bSnapshot = await readFile(
      join(todoDir, CALL_B.conversationId, bSnaps[0]),
      "utf8"
    );
    assert.equal(aSnapshot, "- [ ] [t1] a-v1\n");
    assert.equal(bSnapshot, "- [ ] [t1] b-v1\n");

    // The current files stay independent the same way.
    assert.equal(await currentOf(CALL_A.conversationId), "- [ ] [t1] a-v2\n");
    assert.equal(await currentOf(CALL_B.conversationId), "- [ ] [t1] b-v2\n");
  });

  it("replace 清空(items=[])只清空调用方,另一会话的未勾项仍在 list 与栏里", async () => {
    // The leak-prone cut: clearing. If path resolution ever drops the
    // conversationId, the other session's ledger gets wiped along with it.
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "a-will-be-cleared", { ...CALL_A });
    await add(tool, "b-survives", { ...CALL_B });

    await tool.handler({ mode: "replace", items: [] }, { ...CALL_A });

    assert.equal(await currentOf(CALL_A.conversationId), "");
    const seenByA = (await tool.handler(
      { mode: "read" },
      { ...CALL_A }
    )) as string;
    const seenByB = (await tool.handler(
      { mode: "read" },
      { ...CALL_B }
    )) as string;
    assert.equal(seenByA, "");
    assert.equal(seenByB, "- [ ] [t1] b-survives\n");

    // The panel projection reads the same source: conv-b's open items are unaffected by conv-a's clear.
    assert.deepEqual(
      await readOpenTodoLines(todoDir, CALL_A.conversationId),
      []
    );
    assert.deepEqual(await readOpenTodoLines(todoDir, CALL_B.conversationId), [
      "- [ ] [t1] b-survives",
    ]);
  });

  it("有 conversationId 的 replace 不碰 legacy 根 todos.md", async () => {
    // The other half of the backward-compat contract: a per-conversation
    // replace must never rename the root ledger into a snapshot.
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "legacy root item"); // no ctx → root todos.md
    await add(tool, "a-old", { ...CALL_A });

    await tool.handler({ mode: "replace", items: ["a-new"] }, { ...CALL_A });

    // Root ledger byte-identical.
    assert.equal(
      await readFile(join(todoDir, TODOS_FILE), "utf8"),
      "- [ ] [t1] legacy root item\n"
    );
    // No snapshot files in the root directory (snapshots belong under conv-a).
    const { readdir } = await import("node:fs/promises");
    const rootEntries = await readdir(todoDir);
    assert.deepEqual(
      rootEntries.filter((n) => /^todos\.\d+\.[0-9a-f]{12}\.md$/.test(n)),
      []
    );
    assert.equal((await snapshotsOf(CALL_A.conversationId)).length, 1);
  });
});

describe("agent-status projection is per-conversation", () => {
  it("readOpenTodoLines resolves the same per-conversation path (SSOT)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "open in a", { ...CALL_A });
    const forA = await readOpenTodoLines(todoDir, CALL_A.conversationId);
    const forB = await readOpenTodoLines(todoDir, CALL_B.conversationId);
    assert.deepEqual(forA, ["- [ ] [t1] open in a"]);
    assert.deepEqual(forB, []);
  });

  it("computeAgentStatusSnapshot without conversationId reads root (legacy parity)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await add(tool, "root item");
    const snap = await computeAgentStatusSnapshot({
      lastTool: "bash",
      todoDir,
    });
    assert.deepEqual(snap.openTodoLines, ["- [ ] [t1] root item"]);
  });
});
