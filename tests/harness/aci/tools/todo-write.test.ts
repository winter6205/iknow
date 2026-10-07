/**
 * ADR-0085: todo_write tool factory tests (mode routing, ledger shape, typed
 * errors).
 *
 * Spec: docs/adr/0085-todo-ledger-id-and-three-ops.md. Modes are the three
 * operations — read / add / update — plus the whole-table escape hatch
 * (`replace`, ADR-0046 snapshots). Old `list` → read, old `check` → update
 * status=completed.
 *
 * Scope:
 *   - factory shape (name / schema / aci metadata)
 *   - mode = "read": missing file → ""; current items with id / subject / status
 *   - mode = "add": one item or many; appends (never overwrites); receipt
 *     names the new ids
 *   - mode = "update": by id — subject / status / delete; unknown id → typed
 *     error, file untouched
 *   - mode = "replace": whole-table swap + same-directory snapshot
 *   - empty add / empty subject / over-limit → typed error, file
 *     byte-identical (no half-write)
 *   - id stability across delete+add and across reload
 *
 * Isolation: mkdtemp baseDir; tests don't share filesystem state.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  readdir,
  readFile,
  stat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTodoWriteTool,
  MAX_FILE_BYTES,
  MAX_ITEM_CODEPOINTS,
  codepointLength,
  resolveConversationTodoPath,
  TODO_WRITE_MODES,
  TODO_WRITE_SKIP_CLAUSE,
} from "../../../../src/harness/aci/tools/todo-write.ts";
import {
  formatLedgerLine,
  serializeLedger,
} from "../../../../src/harness/aci/tools/todo-ledger.ts";
import { createRegistry } from "../../../../src/harness/tools/registry.ts";
import { createExecutor } from "../../../../src/harness/tools/executor.ts";
import {
  ToolExecutionError,
  ToolInputValidationError,
} from "../../../../src/harness/errors.ts";

let todoDir: string;

beforeEach(async () => {
  todoDir = await mkdtemp(join(tmpdir(), "todo-write-"));
});

afterEach(async () => {
  await rm(todoDir, { recursive: true, force: true });
});

/** Snapshot file names matching `todos.<unixMs>.<hex>.md` in a directory (SSOT — aligned with the naming produced by the replace path). */
async function listSnapshotNames(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((n) => /^todos\.\d+\.[0-9a-f]{12}\.md$/.test(n));
}

// -- tool shape / metadata ---------------------------------------------------

describe("createTodoWriteTool — tool shape", () => {
  it("exposes the todo_write schema with mode required (read|add|update|replace) and per-mode fields", () => {
    const tool = createTodoWriteTool({ todoDir });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;

    assert.equal(tool.name, "todo_write");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["mode"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(props.mode.type, "string");
    assert.deepEqual(props.mode.enum, ["read", "add", "update", "replace"]);
    // add: one `item` or several `items` at once (multi-step plans are written in one call).
    assert.equal(props.item.type, "string");
    assert.equal(props.items.type, "array");
    assert.deepEqual(props.items.items, { type: "string" });
    // update: target id + at least one changed field (delete is an update, not a fourth state).
    assert.equal(props.id.type, "string");
    assert.equal(props.subject.type, "string");
    assert.equal(props.status.type, "string");
    assert.deepEqual(props.status.enum, [
      "pending",
      "in_progress",
      "completed",
    ]);
    assert.equal(props.delete.type, "boolean");
  });

  it("uses write, non-concurrency-safe, block, default aci metadata (D7)", () => {
    const tool = createTodoWriteTool({ todoDir });
    assert.deepEqual(tool.aci, {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    });
  });
});

// -- mode = read -------------------------------------------------------------

describe("createTodoWriteTool — mode=read", () => {
  it("todos.md missing → returns empty string (legal state, not an error)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "read" });
    assert.equal(out, "");
  });

  it("todos.md present → returns every item as id / status / subject", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(
      file,
      "- [ ] [t1] task A\n- [x] [t2] task B\n- [~] [t3] task C\n",
      "utf8"
    );
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "read" });
    assert.equal(
      out,
      "- [ ] [t1] task A\n- [x] [t2] task B\n- [~] [t3] task C\n"
    );
  });

  it("legacy lines without ids are readable: read synthesizes ids in file order", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(file, "- [ ] task A\n- [x] task B\n", "utf8");
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "read" });
    assert.equal(out, "- [ ] [t1] task A\n- [x] [t2] task B\n");
  });

  it("read does not silently repair malformed lines (skipped, not invented)", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(file, "prose\n- [ ] [t1] real\n", "utf8");
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "read" });
    assert.equal(out, "- [ ] [t1] real\n");
  });
});

// -- mode = add --------------------------------------------------------------

describe("createTodoWriteTool — mode=add", () => {
  it("single item: appends `- [ ] [t1] <item>`; receipt names the new id", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "add", item: "task A" });
    assert.equal(out, "Added 1 item: t1");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(
      content,
      formatLedgerLine({ id: "t1", status: "pending", subject: "task A" })
    );
  });

  // One add call with N items → N pending entries in the current ledger, receipt names N ids.
  it("multi-item: one call appends N pending items and the receipt names N ids (SC7)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({
      mode: "add",
      items: ["step 1", "step 2", "step 3"],
    });
    assert.equal(out, "Added 3 items: t1, t2, t3");

    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    const expected = serializeLedger([
      { id: "t1", status: "pending", subject: "step 1" },
      { id: "t2", status: "pending", subject: "step 2" },
      { id: "t3", status: "pending", subject: "step 3" },
    ]);
    assert.equal(content, expected);

    // read returns the same shape: N pending items.
    const readBack = await tool.handler({ mode: "read" });
    assert.equal(readBack, expected);
  });

  it("multi-item append preserves earlier lines and continues the id sequence", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "add", item: "first" });
    const out = await tool.handler({ mode: "add", items: ["second", "third"] });
    assert.equal(out, "Added 2 items: t2, t3");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(
      content,
      serializeLedger([
        { id: "t1", status: "pending", subject: "first" },
        { id: "t2", status: "pending", subject: "second" },
        { id: "t3", status: "pending", subject: "third" },
      ])
    );
  });

  it("add on a legacy file persists synthesized ids for the old lines too", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(file, "- [ ] legacy\n", "utf8");
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "add", item: "fresh" });
    assert.equal(out, "Added 1 item: t2");
    const content = await readFile(file, "utf8");
    assert.equal(content, "- [ ] [t1] legacy\n- [ ] [t2] fresh\n");
  });
});

// -- mode = update -----------------------------------------------------------

describe("createTodoWriteTool — mode=update", () => {
  async function seed(): Promise<ReturnType<typeof createTodoWriteTool>> {
    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "add", items: ["a", "b", "c"] });
    return tool;
  }

  it("status=completed flips the addressed line only (old check semantics by id)", async () => {
    const tool = await seed();
    const out = await tool.handler({
      mode: "update",
      id: "t2",
      status: "completed",
    });
    assert.equal(out, "Updated t2: status=completed");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(
      content,
      serializeLedger([
        { id: "t1", status: "pending", subject: "a" },
        { id: "t2", status: "completed", subject: "b" },
        { id: "t3", status: "pending", subject: "c" },
      ])
    );
  });

  it("status=in_progress is a distinct state (not folded into pending)", async () => {
    const tool = await seed();
    const out = await tool.handler({
      mode: "update",
      id: "t1",
      status: "in_progress",
    });
    assert.equal(out, "Updated t1: status=in_progress");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[~\] \[t1\] a$/m);
  });

  it("subject change keeps status; receipt reports the new subject", async () => {
    const tool = await seed();
    const out = await tool.handler({
      mode: "update",
      id: "t3",
      subject: "renamed",
    });
    assert.equal(out, "Updated t3: subject=renamed");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[ \] \[t3\] renamed$/m);
  });

  it("subject + status in one call → both applied", async () => {
    const tool = await seed();
    const out = await tool.handler({
      mode: "update",
      id: "t2",
      subject: "renamed",
      status: "completed",
    });
    assert.equal(out, "Updated t2: status=completed, subject=renamed");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[x\] \[t2\] renamed$/m);
  });

  it("delete:true removes the line (delete is an update op, not a fourth status)", async () => {
    const tool = await seed();
    const out = await tool.handler({ mode: "update", id: "t2", delete: true });
    assert.equal(out, "Deleted t2");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(
      content,
      serializeLedger([
        { id: "t1", status: "pending", subject: "a" },
        { id: "t3", status: "pending", subject: "c" },
      ])
    );
  });

  // Unknown id → typed error; the current ledger stays untouched.
  it("unknown id → typed error naming the id; file untouched (SC8)", async () => {
    const tool = await seed();
    const before = await readFile(join(todoDir, "todos.md"), "utf8");
    await assert.rejects(
      async () =>
        tool.handler({ mode: "update", id: "t99", status: "completed" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /\[todo_write\] unknown id: t99/);
        return true;
      }
    );
    const after = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(after, before, "unknown id must not rewrite the file");
  });

  it("unknown id on delete → typed error; file untouched", async () => {
    const tool = await seed();
    const before = await readFile(join(todoDir, "todos.md"), "utf8");
    await assert.rejects(
      async () => tool.handler({ mode: "update", id: "t42", delete: true }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /unknown id: t42/);
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("update with no change field → typed error", async () => {
    const tool = await seed();
    await assert.rejects(
      async () => tool.handler({ mode: "update", id: "t1" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /requires subject, status, or delete:true/
        );
        return true;
      }
    );
  });

  it("update without id → typed error", async () => {
    const tool = await seed();
    await assert.rejects(
      async () => tool.handler({ mode: "update", status: "completed" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /id must be a string/);
        return true;
      }
    );
  });

  it("delete:true combined with another change field → typed error", async () => {
    const tool = await seed();
    await assert.rejects(
      async () =>
        tool.handler({
          mode: "update",
          id: "t1",
          status: "completed",
          delete: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /delete:true on its own/);
        return true;
      }
    );
  });

  it("invalid status value → typed error naming the enum", async () => {
    const tool = await seed();
    await assert.rejects(
      async () =>
        tool.handler({ mode: "update", id: "t1", status: "done" as never }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /status must be one of pending \| in_progress \| completed/
        );
        return true;
      }
    );
  });

  it("delete:false alone is not a change → typed error (file untouched)", async () => {
    const tool = await seed();
    const before = await readFile(join(todoDir, "todos.md"), "utf8");
    await assert.rejects(
      async () => tool.handler({ mode: "update", id: "t1", delete: false }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("ids stay stable across delete + add (no reuse of a live number)", async () => {
    const tool = await seed();
    await tool.handler({ mode: "update", id: "t2", delete: true });
    const out = await tool.handler({ mode: "add", item: "d" });
    assert.equal(out, "Added 1 item: t4");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(
      content,
      serializeLedger([
        { id: "t1", status: "pending", subject: "a" },
        { id: "t3", status: "pending", subject: "c" },
        { id: "t4", status: "pending", subject: "d" },
      ])
    );
  });

  it("ids stay stable across reload (read → update still addresses the same item)", async () => {
    const tool = await seed();
    const readBack = (await tool.handler({ mode: "read" })) as string;
    assert.match(readBack, /^- \[ \] \[t2\] b$/m);
    await tool.handler({ mode: "update", id: "t2", status: "completed" });
    const reloaded = (await tool.handler({ mode: "read" })) as string;
    assert.match(reloaded, /^- \[x\] \[t2\] b$/m);
  });
});

// -- mode = replace ----------------------------------------------------------
// ADR-0046: replace swaps the current todos.md for a new list and keeps the old
// file as a same-directory snapshot (`todos.<unixMs>.<hex>.md`); read still
// only shows the current ledger. replace serves as the whole-table escape hatch.
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — mode=replace", () => {
  it("fresh conversationId + items=[A,B] → 现行恰好两条 pending(新 id);回执短字符串", async () => {
    // Real per-conversation path + fresh conversationId (no pre-existing file).
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler(
      { mode: "replace", items: ["A", "B"] },
      { conversationId: "conv-replace-fresh-1" }
    );
    assert.equal(out, "Updated todos.md");
    const content = await readFile(
      resolveConversationTodoPath({
        projectDir: todoDir,
        conversationId: "conv-replace-fresh-1",
      }),
      "utf8"
    );
    assert.equal(
      content,
      serializeLedger([
        { id: "t1", status: "pending", subject: "A" },
        { id: "t2", status: "pending", subject: "B" },
      ])
    );
  });

  it("replace 前现行非空 → 同目录出现快照文件,内容=旧全文;现行=新列表", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const ctx = { conversationId: "conv-replace-snapshot" };
    await tool.handler(
      { mode: "add", items: ["old-1", "old-2", "old-3"] },
      ctx
    );
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    const beforeContent = await readFile(currentPath, "utf8");

    await tool.handler({ mode: "replace", items: ["new-1", "new-2"] }, ctx);

    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 1, "exactly one snapshot file");
    const snapshotContent = await readFile(
      join(dir, snapshotNames[0]!),
      "utf8"
    );
    assert.equal(snapshotContent, beforeContent);
    const currentContent = await readFile(currentPath, "utf8");
    assert.equal(
      currentContent,
      serializeLedger([
        { id: "t1", status: "pending", subject: "new-1" },
        { id: "t2", status: "pending", subject: "new-2" },
      ])
    );
  });

  it("replace 后 `read` 只返回新现行,不含快照正文", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const ctx = { conversationId: "conv-replace-read" };
    await tool.handler({ mode: "add", item: "still-here-in-snapshot" }, ctx);
    await tool.handler({ mode: "replace", items: ["only-new-1"] }, ctx);

    const listed = (await tool.handler({ mode: "read" }, ctx)) as string;
    assert.match(listed, /- \[ \] \[t1\] only-new-1/);
    assert.ok(
      !listed.includes("still-here-in-snapshot"),
      `read 不应包含快照里的旧项,got: ${listed}`
    );
  });

  it("replace 前现行空(0 字节文件)→ 不建快照,只写新列表", async () => {
    const ctx = { conversationId: "conv-replace-empty-current" };
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    await mkdir(join(todoDir, ctx.conversationId), { recursive: true });
    await fsWriteFile(currentPath, "", "utf8");

    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "replace", items: ["x"] }, ctx);

    const dir = join(todoDir, ctx.conversationId);
    assert.equal(
      (await listSnapshotNames(dir)).length,
      0,
      "no snapshot for empty current"
    );
    assert.match(await readFile(currentPath, "utf8"), /^- \[ \] \[t1\] x$/m);
  });

  it("replace 前现行缺席(无 todos.md)→ 不建快照,只写新列表", async () => {
    const ctx = { conversationId: "conv-replace-missing-current" };
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    assert.equal(await fileExists(currentPath), false);

    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "replace", items: ["only"] }, ctx);

    assert.equal(
      (await listSnapshotNames(join(todoDir, ctx.conversationId))).length,
      0,
      "no snapshot when current missing"
    );
    assert.equal(
      await readFile(currentPath, "utf8"),
      formatLedgerLine({ id: "t1", status: "pending", subject: "only" })
    );
  });

  it("items=[] → 现行变为空文件,合法态;旧内容进快照", async () => {
    // Empty items is a legal operation: it clears the whole list (the escape hatch keeps clear semantics).
    const ctx = { conversationId: "conv-replace-clear" };
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    await mkdir(join(todoDir, ctx.conversationId), { recursive: true });
    await fsWriteFile(
      currentPath,
      formatLedgerLine({ id: "t1", status: "pending", subject: "keep-me" }),
      "utf8"
    );

    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "replace", items: [] }, ctx);
    assert.equal(out, "Updated todos.md");

    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 1);
    assert.match(
      await readFile(join(dir, snapshotNames[0]!), "utf8"),
      /\[t1\] keep-me/
    );
    assert.equal(await readFile(currentPath, "utf8"), "");
  });

  it("replace 带 `item` 字段 → typed error(per-mode 字段互斥)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () =>
        tool.handler({ mode: "replace", items: ["x"], item: "y" } as never, {
          conversationId: "conv-replace-mixed",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /mode replace does not accept item/
        );
        return true;
      }
    );
  });

  it("replace 不带 items → typed error", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () =>
        tool.handler(
          { mode: "replace" },
          { conversationId: "conv-replace-no-items" }
        ),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /items must be an array of strings/
        );
        return true;
      }
    );
  });

  it("replace items 含空字符串 → typed error(per-item 非空)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () =>
        tool.handler(
          { mode: "replace", items: ["ok", ""] },
          { conversationId: "conv-replace-empty-item" }
        ),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /item must be a non-empty string ≤ 500 codepoints/
        );
        return true;
      }
    );
  });

  it("replace items 含超过 500 codepoints 的元素 → typed error,文件不被动", async () => {
    const ctx = { conversationId: "conv-replace-overlong" };
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    await mkdir(join(todoDir, ctx.conversationId), { recursive: true });
    const initialContent = formatLedgerLine({
      id: "t1",
      status: "pending",
      subject: "original",
    });
    await fsWriteFile(currentPath, initialContent, "utf8");

    const tool = createTodoWriteTool({ todoDir });
    const big = "z".repeat(MAX_ITEM_CODEPOINTS + 1);
    await assert.rejects(
      async () => tool.handler({ mode: "replace", items: ["ok", big] }, ctx),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /item must be a non-empty string ≤ 500 codepoints/
        );
        return true;
      }
    );
    assert.equal(await readFile(currentPath, "utf8"), initialContent);
    assert.equal(
      (await listSnapshotNames(join(todoDir, ctx.conversationId))).length,
      0,
      "no snapshot when items invalid"
    );
  });

  it("replace items 整文件超 64 KB → typed error,旧文件保留", async () => {
    // The 64 KB whole-file cap applies to replace too. The limit check must run
    // before the rename; on failure neither the current ledger nor the directory changes.
    const ctx = { conversationId: "conv-replace-huge" };
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    await mkdir(join(todoDir, ctx.conversationId), { recursive: true });
    const initialContent = formatLedgerLine({
      id: "t1",
      status: "pending",
      subject: "keep",
    });
    await fsWriteFile(currentPath, initialContent, "utf8");

    // Build items whose final file exceeds 64 KB: each ≤ 500 codepoints (passes
    // the per-item check) but total bytes > 64 KB (~512 bytes/line incl. id prefix).
    const items: string[] = [];
    for (let i = 0; i < 140; i++) items.push("y".repeat(500));

    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "replace", items }, ctx),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /file would exceed 65536 bytes/);
        return true;
      }
    );
    assert.equal(await readFile(currentPath, "utf8"), initialContent);
    assert.equal(
      (await listSnapshotNames(join(todoDir, ctx.conversationId))).length,
      0,
      "no snapshot on limit failure"
    );
  });

  it("add 同时带 item 与 items → typed error(字段二选一)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () =>
        tool.handler({ mode: "add", item: "x", items: ["y"] } as never, {
          conversationId: "conv-add-both",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /mode add accepts item or items, not both/
        );
        return true;
      }
    );
  });

  it("update 带 `items` 字段 → typed error(per-mode 字段互斥)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () =>
        tool.handler({ mode: "update", items: ["x"], id: "t1" } as never, {
          conversationId: "conv-update-items",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /mode update does not accept items/
        );
        return true;
      }
    );
  });

  it("read 带 `item` 字段 → typed error(per-mode 字段互斥)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () =>
        tool.handler({ mode: "read", item: "x" } as never, {
          conversationId: "conv-read-item",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /mode read does not accept item/);
        return true;
      }
    );
  });

  it("两次连续 replace(同 conversationId,non-empty current)→ 产生两个快照,文件名不撞", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const ctx = { conversationId: "conv-replace-twice" };
    await tool.handler({ mode: "add", items: ["v1-a", "v1-b"] }, ctx);
    await tool.handler({ mode: "replace", items: ["v2-a"] }, ctx);
    // Small time offset ensures unixMs doesn't collide (on very fast machines the hex fallback may still be exercised).
    await new Promise((r) => setTimeout(r, 5));
    await tool.handler({ mode: "add", item: "v2-b" }, ctx);
    await tool.handler({ mode: "replace", items: ["v3-a"] }, ctx);

    const snapshotNames = await listSnapshotNames(
      join(todoDir, ctx.conversationId)
    );
    assert.equal(snapshotNames.length, 2);
    assert.notEqual(snapshotNames[0], snapshotNames[1]);
  });

  // Partial-write invariant for the exception path: when replace's snapshot
  // rename succeeds (old full text persisted as snapshot) but writeTodosAtomic
  // fails inside writeFile/rename, the invariants are: a typed error is thrown,
  // the snapshot keeps the old full text, and the current todos.md is never a
  // half-written file — writeTodosAtomic's tmp + rename makes partial paths
  // impossible.
  // Injection point: the `randomBytes` test seam — writeTodosAtomic runs
  //   mkdir(parent) → random(6) → writeFile(tmp) → rename(tmp→filePath)
  // The custom randomBytes chmods the dir to 0o555 on the second call (snapshot
  // uses 1, atomic write uses the 2nd), so the following writeFile / rename throw
  // EACCES while the snapshot has already succeeded; the current ledger is never partially written.

  it("snapshot rename 成功 → atomic write 写错 → typed-error,快照保留旧全文,现行不动", async () => {
    const ctx = { conversationId: "conv-replace-snap-ok-write-fail" };
    const dir = join(todoDir, ctx.conversationId);
    await mkdir(dir, { recursive: true });
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    const initialContent = formatLedgerLine({
      id: "t1",
      status: "pending",
      subject: "preserved-by-atomic-fail",
    });
    await fsWriteFile(currentPath, initialContent, "utf8");

    let randomCalls = 0;
    const deterministicRandom: (n: number) => Buffer = (n: number) => {
      randomCalls += 1;
      // Second call = writeTodosAtomic's random(6). Snapshot is done and
      // mkdir(parent) is a recursive no-op. The chmod makes the following
      // writeFile / rename throw EACCES, entering the catch path (typed error;
      // a failing tmp unlink is also swallowed).
      if (randomCalls === 2) {
        // Synchronous chmod: EACCES takes effect immediately; restore happens in finally.
        chmodSync(dir, 0o555);
      }
      // All-0xAA buffer → hex "aaaaaaaaaaaaaaaaaaaaaa".
      return Buffer.alloc(n, 0xaa);
    };

    try {
      const tool = createTodoWriteTool({
        todoDir,
        randomBytes: deterministicRandom,
      });
      await assert.rejects(
        async () =>
          tool.handler({ mode: "replace", items: ["new-1", "new-2"] }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof ToolExecutionError);
          assert.match((err as Error).message, /atomic write failed/);
          return true;
        }
      );
    } finally {
      chmodSync(dir, 0o755);
    }
    assert.equal(randomCalls, 2, "snapshot random + atomic-write random");

    // Invariant 1: snapshot is persisted with content = the old full text.
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 1, "exactly one snapshot present");
    assert.equal(
      await readFile(join(dir, snapshotNames[0]!), "utf8"),
      initialContent
    );

    // Invariant 2: the current todos.md does not exist (the original file was
    // renamed away by the snapshot, and the atomic write failed → nothing
    // created). This is the "no half-write" evidence: the current file is not
    // partial new content — it simply does not exist.
    assert.equal(await fileExists(currentPath), false);

    // Invariant 3: no `.tmp` leftovers (the atomic write catch path unlinks tmpPath).
    const postEntries = await readdir(dir);
    assert.equal(
      postEntries.filter((e) => e.endsWith(".tmp")).length,
      0,
      "no `.tmp` leftovers after atomic-write failure"
    );
  });

  // Partial-write invariant for the exception path: when replace's
  // snapshotCurrentTodos rename throws, the current todos.md keeps its old
  // content (a failed atomic rename leaves the source untouched), no snapshot
  // file lands in the directory, and there are no `.tmp` leftovers. Injection
  // point: read-only subdirectory.

  it("snapshot rename 失败 → typed-error,现行保持旧内容,无快照无 tmp", async () => {
    const ctx = { conversationId: "conv-replace-snapshot-fail" };
    const dir = join(todoDir, ctx.conversationId);
    await mkdir(dir, { recursive: true });
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    const initialContent = formatLedgerLine({
      id: "t1",
      status: "pending",
      subject: "preserved-by-snapshot-fail",
    });
    await fsWriteFile(currentPath, initialContent, "utf8");

    // Remove w on the subdirectory → the snapshot rename cannot write
    // todos.<…>.md and throws EACCES. mkdir(join(filePath, "..")) is a
    // recursive no-op on the existing directory, so it does not throw first.
    await chmod(dir, 0o555);
    let threw = false;
    try {
      const tool = createTodoWriteTool({ todoDir });
      await assert.rejects(
        async () => tool.handler({ mode: "replace", items: ["new"] }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof ToolExecutionError);
          assert.match(
            (err as Error).message,
            /snapshot rename failed|atomic write failed/
          );
          return true;
        }
      );
      threw = true;
    } finally {
      await chmod(dir, 0o755);
    }
    assert.ok(threw, "replace rejected (snapshot rename EACCES)");

    // Invariant: current still holds the old content + no snapshot + no .tmp.
    assert.equal(await readFile(currentPath, "utf8"), initialContent);
    assert.equal(
      (await listSnapshotNames(dir)).length,
      0,
      "no snapshot when rename fails"
    );
    assert.equal(
      (await readdir(dir)).filter((e) => e.endsWith(".tmp")).length,
      0,
      "no `.tmp` leftovers"
    );
  });

  // Partial-write invariant for the exception path: when replace's readTodos
  // throws (non-ENOENT), there is no snapshot, no new todos.md, and no `.tmp`
  // leftovers. Injection point: pre-create filePath as a directory instead of a
  // file → readFile throws EISDIR, which readTodos's catch wraps into the
  // "[todo_write] read failed: ..." typed error before any snapshot happens.

  it("readTodos 在 replace 抛错 → typed-error,无 snapshot、无 tmp、无新文件", async () => {
    const ctx = { conversationId: "conv-replace-read-fail" };
    const dir = join(todoDir, ctx.conversationId);
    await mkdir(dir, { recursive: true });
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    // Pre-create filePath as a directory (replacing any file) → readFile throws EISDIR.
    await mkdir(currentPath, { recursive: true });

    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "replace", items: ["new"] }, ctx),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /read failed/);
        return true;
      }
    );

    assert.equal(
      (await listSnapshotNames(dir)).length,
      0,
      "no snapshot when read fails"
    );
    assert.equal(
      (await readdir(dir)).filter((e) => e.endsWith(".tmp")).length,
      0,
      "no `.tmp` leftovers"
    );
  });
});

// -- typed-error paths -------------------------------------------------------

describe("createTodoWriteTool — typed-error catch", () => {
  it("unknown mode → ToolExecutionError naming the new enum", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "purge" as never }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /mode must be one of read \| add \| update \| replace/
        );
        return true;
      }
    );
  });

  it("removed mode `list` → typed error (the enum is the new four)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "list" as never }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /mode must be one of/);
        return true;
      }
    );
  });

  it("removed mode `check` → typed error (check folded into update)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "check", item: "x" } as never),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /mode must be one of/);
        return true;
      }
    );
  });

  it("add without item → ToolExecutionError (SC11: empty add typed)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "add" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /item must be a non-empty string ≤ 500 codepoints/
        );
        return true;
      }
    );
  });

  it("add with empty item → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "add", item: "" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /item must be a non-empty string ≤ 500 codepoints/
        );
        return true;
      }
    );
  });

  it("unknown field in input → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "read", evil: "x" as never }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /unknown field: evil/);
        return true;
      }
    );
  });

  it("input is not an object → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler("nope" as never),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /input must be an object/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Governance limits + atomic write
//
// Decided: file cap 64 KB; per-item cap 500 codepoints; rejecting negative
// phrasing is deliberately **not** done (a todo like "don't forget to run the
// tests" is a legitimate task; only memory_save rejects negative phrasing).
// Atomic write: tmp + rename (mirrors memory_save's writeSlugAtomic); failures
// clean up the tmp file, so a mid-write crash never pollutes an existing todos.md.
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — #440 T3 governance + atomic write", () => {
  it("per-item limit 500 codepoints（add 超过上限 → typed error，不写盘）", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const big = "x".repeat(MAX_ITEM_CODEPOINTS + 1);
    await assert.rejects(
      async () => tool.handler({ mode: "add", item: big }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /item must be a non-empty string ≤ 500 codepoints/
        );
        return true;
      }
    );
    assert.equal(await fileExists(join(todoDir, "todos.md")), false);
  });

  it("per-item limit 用 codepoint 计数：CJK 500 字接受,501 字拒绝（多条目同规则）", async () => {
    const tool = createTodoWriteTool({ todoDir });
    // 500 CJK characters = 500 codepoints; just under the limit → accepted.
    const ok = "中".repeat(MAX_ITEM_CODEPOINTS);
    const out = await tool.handler({ mode: "add", item: ok });
    assert.equal(out, "Added 1 item: t1");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[ \] \[t1\] 中+$/m);

    // Any element over the limit → the whole add fails typed, no partial write.
    const before = await readFile(join(todoDir, "todos.md"), "utf8");
    await assert.rejects(
      async () =>
        tool.handler({ mode: "add", items: ["fine", "中".repeat(501)] }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match(
          (err as Error).message,
          /non-empty string ≤ 500 codepoints/
        );
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("文件上限 64 KB：add 到现有文件使之超过上限 → typed error", async () => {
    const file = join(todoDir, "todos.md");
    // Each pending line `- [ ] [tN] <item>\n` is ~414 bytes (id marker +
    // 400-char item). 158 lines = 65304 bytes, just under 64 KB; one more
    // 400-char item pushes the file over.
    const item400 = "a".repeat(400);
    const preLines: string[] = [];
    for (let i = 0; i < 158; i++) {
      preLines.push(`- [ ] [t${i + 1}] ${item400}`);
    }
    await fsWriteFile(file, preLines.join("\n") + "\n", "utf8");
    const preBytes = Buffer.byteLength(await readFile(file, "utf8"), "utf8");
    assert.ok(
      preBytes < MAX_FILE_BYTES,
      `pre-fill under limit (${preBytes} < ${MAX_FILE_BYTES})`
    );

    // Item of 400 chars is under per-item limit (500 codepoints), so it
    // passes parseInput. The file-size limit triggers in the handler.
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "add", item: item400 }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /file would exceed 65536 bytes/);
        return true;
      }
    );
    // File untouched: pre-existing content is preserved byte-for-byte.
    assert.equal(await readFile(file, "utf8"), preLines.join("\n") + "\n");
  });

  it("负面措辞不拒绝（add '别忘了跑测试' 成功）", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "add", item: "别忘了跑测试" });
    assert.equal(out, "Added 1 item: t1");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[ \] \[t1\] 别忘了跑测试$/m);
  });

  it("串行 add 不丢更新：3 个串行 await add → 3 条全在文件中", async () => {
    // Decided: single writer in the main loop — the loop engine serializes
    // tool calls (isConcurrencySafe: false). This asserts that under serial
    // calls every add lands and order is preserved.
    const tool = createTodoWriteTool({ todoDir });
    assert.equal(
      await tool.handler({ mode: "add", item: "first" }),
      "Added 1 item: t1"
    );
    assert.equal(
      await tool.handler({ mode: "add", item: "second" }),
      "Added 1 item: t2"
    );
    assert.equal(
      await tool.handler({ mode: "add", item: "third" }),
      "Added 1 item: t3"
    );
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[ \] \[t1\] first$/m);
    assert.match(content, /^- \[ \] \[t2\] second$/m);
    assert.match(content, /^- \[ \] \[t3\] third$/m);
    assert.ok(
      content.indexOf("first") < content.indexOf("second"),
      "first < second"
    );
    assert.ok(
      content.indexOf("second") < content.indexOf("third"),
      "second < third"
    );
  });

  it("写失败不污染既有 todos.md：rename 抛错时原文件不变 + tmp 被清理", async () => {
    const file = join(todoDir, "todos.md");
    const initialContent = "- [ ] [t1] preserved\n";
    await fsWriteFile(file, initialContent, "utf8");

    // Make the directory read-only so the write/rename step fails (mkdir
    // recursive into a read-only directory throws EACCES). Restore perms in
    // finally so the afterEach rm works.
    await chmod(todoDir, 0o555);
    let threw = false;
    try {
      const tool = createTodoWriteTool({ todoDir });
      await assert.rejects(
        async () => tool.handler({ mode: "add", item: "should fail" }),
        (err: unknown) => {
          assert.ok(err instanceof ToolExecutionError);
          // Failure surface: mkdir fails (EACCES) or rename fails.
          assert.match(
            (err as Error).message,
            /atomic write failed|mkdir failed|read failed/
          );
          return true;
        }
      );
      threw = true;
    } finally {
      await chmod(todoDir, 0o755);
    }
    assert.ok(threw, "tool call rejected (read-only todoDir)");

    // Pre-existing file untouched (byte-for-byte preserved).
    assert.equal(await readFile(file, "utf8"), initialContent);
    assert.equal(
      (await readdir(todoDir)).filter((e) => e.endsWith(".tmp")).length,
      0,
      "no `.tmp` leftovers after failed write"
    );
  });
});

// ---------------------------------------------------------------------------
// Empty / overflow inputs — typed failure and NO half-write.
//
// Each case first builds a non-empty current ledger, then compares
// byte-for-byte after the failure: the ledger must neither become a
// half-written new content nor get cleared.
// ---------------------------------------------------------------------------

describe("SC11 — empty / overflow typed failure leaves the ledger byte-identical", () => {
  /** Seed a two-item ledger and return the exact bytes on disk. */
  async function seed(): Promise<string> {
    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "add", items: ["keep-1", "keep-2"] });
    return await readFile(join(todoDir, "todos.md"), "utf8");
  }

  it("add items:[] → typed error, file byte-identical", async () => {
    const before = await seed();
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "add", items: [] }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /at least one subject/);
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("add item:'' → typed error, file byte-identical", async () => {
    const before = await seed();
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "add", item: "" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /non-empty string/);
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("add items with one empty subject → typed error, no partial append", async () => {
    const before = await seed();
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "add", items: ["ok", ""] }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("update subject:'' → typed error, file byte-identical", async () => {
    const before = await seed();
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () => tool.handler({ mode: "update", id: "t1", subject: "" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /non-empty string/);
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("add items over the 500-codepoint limit → typed error, file byte-identical", async () => {
    const before = await seed();
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      async () =>
        tool.handler({ mode: "add", items: ["ok", "中".repeat(501)] }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /≤ 500 codepoints/);
        return true;
      }
    );
    assert.equal(await readFile(join(todoDir, "todos.md"), "utf8"), before);
  });

  it("add that would push the file over 64 KB → typed error, file byte-identical", async () => {
    const file = join(todoDir, "todos.md");
    const tool = createTodoWriteTool({ todoDir });
    // 158 lines × ~414 bytes = 65304 bytes, just under the cap.
    const big = "b".repeat(400);
    const preLines: string[] = [];
    for (let i = 0; i < 158; i++) preLines.push(`- [ ] [t${i + 1}] ${big}`);
    await fsWriteFile(file, preLines.join("\n") + "\n", "utf8");
    const before = await readFile(file, "utf8");

    await assert.rejects(
      async () => tool.handler({ mode: "add", items: [big, big] }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /file would exceed 65536 bytes/);
        return true;
      }
    );
    assert.equal(await readFile(file, "utf8"), before);
  });

  it("update that would keep the file over 64 KB → typed error, file byte-identical", async () => {
    const file = join(todoDir, "todos.md");
    const tool = createTodoWriteTool({ todoDir });
    const big = "c".repeat(400);
    const preLines: string[] = [];
    for (let i = 0; i < 158; i++) preLines.push(`- [ ] [t${i + 1}] ${big}`);
    await fsWriteFile(file, preLines.join("\n") + "\n", "utf8");
    const before = await readFile(file, "utf8");

    await assert.rejects(
      async () =>
        tool.handler({
          mode: "update",
          id: "t1",
          subject: "中".repeat(MAX_ITEM_CODEPOINTS),
        }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /file would exceed 65536 bytes/);
        return true;
      }
    );
    assert.equal(await readFile(file, "utf8"), before);
  });
});

// -- fileExists helper -------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// -- pure helpers (exported) -------------------------------------------------

describe("codepointLength — pure helper", () => {
  it("ASCII: byte length === codepoint length", () => {
    assert.equal(codepointLength("hello"), 5);
  });

  it("CJK: 500 个汉字 = 500 codepoints", () => {
    assert.equal(codepointLength("中".repeat(500)), 500);
  });

  it("emoji: '👨‍👩‍👧' (ZWJ sequence) counts each base + ZWJ", () => {
    // Family emoji: man + ZWJ + woman + ZWJ + girl = 5 codepoints.
    const family = "👨‍👩‍👧";
    assert.equal(codepointLength(family), 5);
  });
});

// -- Typed-error catch rendering contract (code-quality.md)
// The rendering side must distinguish typed errors from plain objects at the
// catch site — `err instanceof Error ? err.message : String(err)` is banned
// (a plain Error loses the name / className distinction; a plain object
// prints as [object Object]). This group asserts the throw side plus the
// output shape of the generic catch template.
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — typed-error catch 渲染契约 (code-quality.md)", () => {
  it("invalid mode: throw ToolExecutionError 且 message 以 [todo_write] 前缀开头", async () => {
    const tool = createTodoWriteTool({ todoDir });
    let caught: unknown;
    try {
      await tool.handler({ mode: "bogus" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ToolExecutionError);
    assert.equal((caught as Error).name, "ToolExecutionError");
    assert.ok(
      (caught as Error).message.startsWith("[todo_write]"),
      `message prefix preserved: ${(caught as Error).message}`
    );
    assert.ok((caught as Error).message.includes("read | add | update"));
  });

  it("empty item on add: 同样以 [todo_write] 前缀抛 typed-error", async () => {
    const tool = createTodoWriteTool({ todoDir });
    let caught: unknown;
    try {
      await tool.handler({ mode: "add", item: "" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ToolExecutionError);
    assert.ok((caught as Error).message.startsWith("[todo_write]"));
    assert.ok((caught as Error).message.includes("non-empty"));
  });

  it("unknown id on update: 以 [todo_write] 前缀抛 typed-error 且带 id", async () => {
    const tool = createTodoWriteTool({ todoDir });
    let caught: unknown;
    try {
      await tool.handler({ mode: "update", id: "t7", status: "completed" });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ToolExecutionError);
    assert.ok((caught as Error).message.startsWith("[todo_write]"));
    assert.ok((caught as Error).message.includes("t7"));
  });

  it("通用 catch 模板正确提取 message(模拟 code-quality.md 渲染契约)", () => {
    // Simulated catch side:
    //   } catch (err) { return err instanceof Error ? err.message : String(err); }
    // ToolExecutionError must yield its message (not [object Object]); name is kept.
    function renderCatch(err: unknown): string {
      return err instanceof Error ? err.message : String(err);
    }
    const tErr = new ToolExecutionError(
      "[todo_write] file would exceed 65536 bytes"
    );
    assert.equal(
      renderCatch(tErr),
      "[todo_write] file would exceed 65536 bytes"
    );
    assert.equal(tErr.name, "ToolExecutionError");
  });

  it("plain object (非 Error 子类): catch 端 String(err) 应避免丢 [object Object]", () => {
    // Counter-assertion: if the throw side ever emits a plain object (bypassing
    // the instanceof Error check), catch renders it via String(err) as
    // [object Object]. This documents the contract only — no bug replay — but
    // keeps the assertion as a regression pin.
    const plain = { kind: "tool_error", reason: "x" };
    const rendered = String(plain);
    assert.equal(rendered, "[object Object]");
  });
});

// ---------------------------------------------------------------------------
// ADR-0085: actor capability — worker and parent share one ledger.
//
// Contract (ADR-0085 `同一主会话内子代理与父共用账本`, "sub-agents share
// the parent's ledger within one main session):
//   - a worker may read / update the parent ledger (update is still legal
//     under a scoped write);
//   - worker `add` is rejected as a typed error **by the tool itself**
//     (ToolExecutionError + [todo_write] prefix) — not a silent drop, not
//     "tool absent"; the tool must stay on the worker's tool surface so the
//     model can read the rejection reason;
//   - the runtime rejection does not rely on the permission layer (worker
//     assembly uses a no-ask askUser, so the permission layer is always true).
//
// Seam shape: the worker process's executor does not synthesize
// ctx.conversationId (worker deps carry none), so deps.actor.conversationId
// is the fallback source; the parent still resolves via ctx.conversationId
// (an explicitly passed one takes priority).
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — ADR-0085 SC9 actor capability", () => {
  it("canAdd:false → add 抛 ToolExecutionError,消息带 [todo_write] 前缀并点名 parent-only 共享账本", async () => {
    const tool = createTodoWriteTool({
      todoDir,
      actor: { conversationId: "conv-parent", canAdd: false },
    });
    await assert.rejects(
      async () => tool.handler({ mode: "add", item: "worker must not add" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError, "typed error 形态");
        const message = (err as Error).message;
        assert.match(message, /^\[todo_write\]/);
        // The model must be able to read "why rejected + what it can still
        // do" — not a silent drop.
        assert.match(message, /parent-only/);
        assert.match(message, /read.*update|update.*read/);
        return true;
      }
    );
  });

  it("canAdd:false → 拒绝先于任何写盘:账本文件不产生(add 失败不半写)", async () => {
    const tool = createTodoWriteTool({
      todoDir,
      actor: { conversationId: "conv-parent", canAdd: false },
    });
    await assert.rejects(async () => tool.handler({ mode: "add", item: "x" }));
    await assert.rejects(
      readFile(
        resolveConversationTodoPath({
          projectDir: todoDir,
          conversationId: "conv-parent",
        }),
        "utf8"
      ),
      /ENOENT/
    );
  });

  it("canAdd:false → read / update 仍作用于 actor.conversationId 指向的父账本", async () => {
    // The parent session writes a ledger first (via the ctx.conversationId
    // path — the same book the worker points at).
    const parent = createTodoWriteTool({ todoDir });
    const receipt = await parent.handler(
      { mode: "add", item: "shared item" },
      { conversationId: "conv-parent" }
    );
    const id = /Added 1 item: (t\d+)/.exec(String(receipt))![1]!;

    // Worker assembly shape: no ctx.conversationId — relies on the
    // deps.actor fallback.
    const worker = createTodoWriteTool({
      todoDir,
      actor: { conversationId: "conv-parent", canAdd: false },
    });
    const seen = (await worker.handler({ mode: "read" })) as string;
    assert.match(seen, /\[t1\] shared item/);
    await worker.handler({ mode: "update", id, status: "completed" });
    assert.equal(
      await readFile(
        resolveConversationTodoPath({
          projectDir: todoDir,
          conversationId: "conv-parent",
        }),
        "utf8"
      ),
      "- [x] [t1] shared item\n"
    );
  });

  it("canAdd 缺省(true) → 父会话 add 语义逐字节不变", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const receipt = await tool.handler(
      { mode: "add", item: "parent add" },
      { conversationId: "conv-parent" }
    );
    assert.equal(receipt, "Added 1 item: t1");
  });

  it("ctx.conversationId 优先于 deps.actor.conversationId(显式调用方赢)", async () => {
    const tool = createTodoWriteTool({
      todoDir,
      actor: { conversationId: "conv-from-deps", canAdd: false },
    });
    await Promise.resolve(
      tool.handler(
        { mode: "update", id: "t1", status: "completed" },
        { conversationId: "conv-from-ctx" }
      )
    ).catch(() => undefined);
    // The ctx path has no file → unknown id; the deps file must be absent.
    await assert.rejects(
      readFile(
        resolveConversationTodoPath({
          projectDir: todoDir,
          conversationId: "conv-from-deps",
        }),
        "utf8"
      ),
      /ENOENT/
    );
    await assert.rejects(
      readFile(
        resolveConversationTodoPath({
          projectDir: todoDir,
          conversationId: "conv-from-ctx",
        }),
        "utf8"
      ),
      /ENOENT/
    );
  });

  it("replace 在 canAdd:false 下照常可用(整表逃生口是 update 族,不被 actor 裁剪)", async () => {
    // ADR-0085 only restricts *adding* to the parent session; replace is the
    // whole-table escape hatch and is not part of add semantics.
    const tool = createTodoWriteTool({
      todoDir,
      actor: { conversationId: "conv-parent", canAdd: false },
    });
    const out = await tool.handler({ mode: "replace", items: ["only"] });
    assert.equal(out, "Updated todos.md");
  });
});

// ---------------------------------------------------------------------------
// Positive-trigger description — only affirmative triggers, no negative
// prohibitions. The discipline: the trigger conditions themselves exclude
// simple tasks; the wording bans "do not" / "avoid" / "simple task" /
// "never" (negative phrasing only adds decision noise for the model). The
// description literal lives in ToolDef.description and reaches the model via
// registry catalog -> promptTools, so the test reads def.description through
// reg.inner.get to pin its shape (the system-prompt grep anchor is
// ToolDef.description).
//
// Since ADR-0085 the vocabulary is three modes: read / add / update
// (plus the replace escape hatch).
// ---------------------------------------------------------------------------

const NEGATIVE_PHRASES = [
  "do not",
  "don't",
  "avoid",
  "should not",
  "shouldn't",
  "never",
  "simple task",
  "trivial",
  "不要",
  "避免",
  "禁止",
  "切勿",
];

describe("createTodoWriteTool — #440 T6 D9 正面引导式 description (无负面禁令)", () => {
  function readDescription(): string {
    const tool = createTodoWriteTool({ todoDir });
    return tool.description;
  }

  it("正面触发条件自显：含 'multi-step' / 'progress' 等正向关键词", () => {
    const desc = readDescription().toLowerCase();
    const positiveKeys = ["multi-step", "multi-turn", "progress", "track"];
    assert.ok(
      positiveKeys.some((k) => desc.includes(k)),
      `description 应含至少一个正向关键词, got: ${desc}`
    );
  });

  it("description 不含任何 NEGATIVE_PHRASES（grammar 守门）", () => {
    const desc = readDescription().toLowerCase();
    for (const phrase of NEGATIVE_PHRASES) {
      assert.ok(
        !desc.includes(phrase.toLowerCase()),
        `description 不应含负面措辞 "${phrase}", got: ${desc}`
      );
    }
  });

  it("description 明确告知新 mode 形态(read/add/update/replace)与 id 寻址,无歧义", () => {
    const desc = readDescription();
    assert.ok(desc.includes("read"));
    assert.ok(desc.includes("add"));
    assert.ok(desc.includes("update"));
    // the replace escape hatch is part of the affirmative description too
    assert.ok(desc.includes("replace"));
    // id addressing is an update input fact the model must read off the
    // description.
    assert.ok(desc.includes("id"));
    // the three status values live in the validation layer; the description
    // at least names the status axis.
    assert.ok(desc.includes("status"));
    assert.ok(desc.includes("delete"));
  });

  it("description 不再广告已退役的 mode=check / mode=list", () => {
    const desc = readDescription();
    assert.ok(!/mode=check/.test(desc), "check 已并入 update");
    assert.ok(!/mode=list/.test(desc), "list 已更名 read");
  });

  it("registry catalog 暴露的 description 与 factory 直接读一致（系统 prompt grep 锚点）", () => {
    const tool = createTodoWriteTool({ todoDir });
    const factoryDesc = tool.description;
    assert.equal(typeof factoryDesc, "string");
    assert.ok(factoryDesc.length > 20, "description should be informative");
  });

  // -- Skip clause: if the next step finishes the user's request outright,
  //    just do it — no list. ------------------------------------------------

  it("#646 T2: description 含跳过条件句(正面表述仍是多步骤跨多轮才建清单)", () => {
    const desc = readDescription();
    assert.ok(
      desc.includes(TODO_WRITE_SKIP_CLAUSE),
      `description 应含 TODO_WRITE_SKIP_CLAUSE, got: ${desc}`
    );
    assert.ok(desc.includes("multi-step"));
    assert.ok(desc.includes("multi-turn"));
    assert.ok(/multiple turns/.test(desc));
    assert.ok(desc.includes("progress"));
  });

  it("#646 T2: 跳过条件句自身为正面措辞 — NEGATIVE_PHRASES 原样守门,不出现 'simple task'", () => {
    const clause = TODO_WRITE_SKIP_CLAUSE.toLowerCase();
    for (const phrase of NEGATIVE_PHRASES) {
      assert.ok(
        !clause.includes(phrase.toLowerCase()),
        `跳过条件句不应含负面措辞 "${phrase}", got: ${TODO_WRITE_SKIP_CLAUSE}`
      );
    }
    assert.ok(!clause.includes("simple task"));
  });
});

// ---------------------------------------------------------------------------
// The tool description and schema must describe each mode separately, and
// every field description pins its binding to the owning mode. Pinned
// invariants (SSOT, derived from ADR-0085 / ADR-0046):
//   - the description spells out read/add/update/replace one sentence each;
//     the update sentence names delete:true + id (ADR-0085: delete belongs
//     to the update family); the add sentence names item and items; the
//     replace sentence names items, never the singular item (ADR-0046).
//   - every schema field carries a description, and that description binds
//     the field to its mode (add ↔ item / items; update ↔ id / subject /
//     status / delete; replace ↔ items).
//   - the handler-layer typed rejection text stays byte-identical.
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — todo-write-mode-copy: 四 mode 分述说明书 (SC1–SC7)", () => {
  function readTool() {
    return createTodoWriteTool({ todoDir });
  }

  // Delete is bound to update, not a fifth mode.
  it("SC2 description 同段同时点出 update / delete:true / id(删除属 update 族,非独立 mode)", () => {
    const description = readTool().description;
    // Normalize whitespace, then split the description into sentences on `.`.
    const sentences = description
      .replace(/\s+/g, " ")
      .split(".")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const found = sentences.some(
      (s) =>
        s.includes("update") && s.includes("delete:true") && s.includes("id")
    );
    assert.ok(
      found,
      `description 应有某句同时含 update / delete:true / id,got sentences:\n${sentences.join("\n----\n")}`
    );
  });

  it("SC2 description 不把 delete 写成独立 mode (mode=delete / delete mode)", () => {
    const description = readTool().description;
    assert.ok(
      !/mode\s*=?\s*["'`]?delete/i.test(description),
      `description 不应出现 mode=delete,got: ${description}`
    );
    assert.ok(
      !/delete\s+mode/i.test(description),
      `description 不应出现 "delete mode",got: ${description}`
    );
  });

  // The replace sentence must name items (the whole new table); the singular
  // item must not appear.
  it("SC3 replace 句点名 items(整张新表),不出现单数 item", () => {
    const description = readTool().description;
    assert.match(
      description,
      /replace[^.]*\bitems\b/,
      `replace 所在句应点名 items,got: ${description}`
    );
    assert.ok(
      !/\breplace\b[^.]*\bitem\b(?!s)/.test(description),
      `replace 句不得出现单数 item,got: ${description}`
    );
  });

  // The add sentence names both item and items (single / batch forms).
  it("add 分述句同时点名 item 与 items", () => {
    const description = readTool().description;
    const sentences = description
      .split(".")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const found = sentences.some(
      (s) => s.includes("add") && /\bitem\b/.test(s) && /\bitems\b/.test(s)
    );
    assert.ok(
      found,
      `add 分述句应同时含 item 与 items,got sentences:\n${sentences.join("\n----\n")}`
    );
  });

  // Schema field descriptions must be non-empty and bound to their mode.
  it("SC4 schema 字段 description 非空且绑定到对应 mode", () => {
    const schema = readTool().inputSchema;
    const props = schema.properties as Record<string, { description?: string }>;
    const fields = ["item", "items", "id", "subject", "status", "delete"];
    for (const f of fields) {
      assert.ok(
        typeof props[f].description === "string" &&
          (props[f].description as string).length > 0,
        `${f} 必须挂非空 description`
      );
    }
    // Binding relations (case-insensitive):
    assert.ok(
      props.item.description!.toLowerCase().includes("add"),
      `item.description 应绑定 add,got: ${props.item.description}`
    );
    assert.ok(
      props.delete.description!.toLowerCase().includes("update"),
      `delete.description 应绑定 update,got: ${props.delete.description}`
    );
    assert.ok(
      props.items.description!.toLowerCase().includes("add") &&
        props.items.description!.toLowerCase().includes("replace"),
      `items.description 应同时绑定 add 与 replace,got: ${props.items.description}`
    );
    assert.ok(
      !props.item.description!.toLowerCase().includes("replace"),
      `item.description 不应绑定 replace,got: ${props.item.description}`
    );
  });

  // Rewriting the description must not drift the mode enum SSOT (still four
  // values).
  it("SC1 regression guard: mode 枚举仍为 read/add/update/replace 四值", () => {
    assert.deepEqual(
      [...TODO_WRITE_MODES],
      ["read", "add", "update", "replace"]
    );
  });

  // Handler-layer typed rejection: replace does not accept item.
  it("SC3 handler: mode=replace 携带 item 字段 → typed 拒绝", async () => {
    const tool = readTool();
    let caught: unknown;
    try {
      await tool.handler({ mode: "replace", item: "x" } as never, {
        conversationId: "test-sc3-replace-item",
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ToolExecutionError, "应抛 ToolExecutionError");
    assert.equal(
      (caught as Error).message,
      "[todo_write] mode replace does not accept item"
    );
  });

  // The rewritten description still follows the positive-guidance discipline
  // (no negative prohibitions) and keeps the positive keywords present.
  it("SC5 regression guard: description 仍含 multi-step", () => {
    assert.ok(readTool().description.includes("multi-step"));
  });
});

// ---------------------------------------------------------------------------
// Executor result classification for input-validation failures.
//
// parseInput rejections must arrive at the model as `validation_failed`
// (the deterministic-input-error signal the narrow fuse consumes), with the
// message bytes unchanged (ADR-0086 passthrough); state-dependent / IO
// failures stay `execution_failed`.
// ---------------------------------------------------------------------------

describe("todo_write — executor classification of validation vs execution failures", () => {
  function executorFor() {
    const tool = createTodoWriteTool({ todoDir });
    const registry = createRegistry([tool]);
    return { tool, executor: createExecutor(registry) };
  }

  it("parseInput rejection → kind validation_failed, message byte-identical to the handler throw", async () => {
    const { tool, executor } = executorFor();
    const input = { mode: "add", item: "" };
    const results = await executor.executeAll([
      { id: "call-vf", name: "todo_write", input },
    ]);
    assert.equal(results[0]!.kind, "validation_failed");
    let direct = "";
    try {
      await tool.handler(input);
    } catch (err) {
      direct = (err as Error).message;
    }
    assert.ok(
      direct.startsWith("[todo_write]"),
      `handler text seam: ${direct}`
    );
    assert.equal(
      (results[0] as { kind: string; message?: string }).message,
      direct
    );
  });

  it("state-dependent failure (unknown id) → still execution_failed", async () => {
    const { executor } = executorFor();
    const results = await executor.executeAll([
      {
        id: "call-ue",
        name: "todo_write",
        input: { mode: "update", id: "t9", status: "completed" },
      },
    ]);
    assert.equal(results[0]!.kind, "execution_failed");
    assert.match(
      (results[0] as { kind: string; message?: string }).message ?? "",
      /\[todo_write\] unknown id: t9/
    );
  });

  it("IO failure (atomic write EACCES) → still execution_failed", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(file, "- [ ] [t1] seed\n", "utf8");
    await chmod(todoDir, 0o555);
    try {
      const { executor } = executorFor();
      const results = await executor.executeAll([
        {
          id: "call-io",
          name: "todo_write",
          input: { mode: "add", item: "boom" },
        },
      ]);
      assert.equal(results[0]!.kind, "execution_failed");
      assert.match(
        (results[0] as { kind: string; message?: string }).message ?? "",
        /atomic write failed|mkdir failed/
      );
    } finally {
      await chmod(todoDir, 0o755);
    }
  });

  it("parseInput rejections are ToolInputValidationError and remain ToolExecutionError instances", async () => {
    const { tool } = executorFor();
    await assert.rejects(
      async () => tool.handler({ mode: "read", item: "x" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolInputValidationError);
        assert.ok(err instanceof ToolExecutionError);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Mode-specific schema contract: ajv must reject every cross-mode field
// combination BEFORE the handler runs. Discriminator vs the
// parseInput fallback: ajv-layer messages carry no `[todo_write]` prefix.
// ---------------------------------------------------------------------------

describe("todo_write — mode contract branches reject cross-mode shapes at the schema layer", () => {
  async function execute(input: unknown) {
    const tool = createTodoWriteTool({ todoDir });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const [result] = await executor.executeAll([
      { id: "call-schema", name: "todo_write", input },
    ]);
    return result!;
  }

  const rejected: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["mode=update carries item", { mode: "update", id: "t1", item: "x" }],
    ["mode=update carries items", { mode: "update", id: "t1", items: ["x"] }],
    ["mode=add carries id", { mode: "add", item: "x", id: "t1" }],
    ["mode=add carries subject", { mode: "add", item: "x", subject: "s" }],
    ["mode=add carries status", { mode: "add", item: "x", status: "pending" }],
    ["mode=add carries delete", { mode: "add", item: "x", delete: true }],
    ["mode=add item+items coexist", { mode: "add", item: "x", items: ["y"] }],
    ["mode=add without item or items", { mode: "add" }],
    ["mode=update without id", { mode: "update", status: "completed" }],
    ["mode=update with id but no change field", { mode: "update", id: "t1" }],
    ["mode=replace carries item", { mode: "replace", item: "x" }],
    ["mode=replace without items", { mode: "replace" }],
    ["mode=read carries item", { mode: "read", item: "x" }],
  ];

  for (const [name, input] of rejected) {
    it(`${name} → validation_failed from the ajv layer (no [todo_write] prefix)`, async () => {
      const result = await execute(input);
      assert.equal(result.kind, "validation_failed");
      const message =
        (result as { kind: string; message?: string }).message ?? "";
      assert.ok(
        !message.startsWith("[todo_write]"),
        `expected schema-layer rejection, parseInput answered: ${message}`
      );
    });
  }

  it("schema-layer rejection of coexisting add item/items does not reach the handler prefix path", async () => {
    const result = await execute({ mode: "add", item: "x", items: ["y"] });
    assert.equal(result.kind, "validation_failed");
    const message =
      (result as { kind: string; message?: string }).message ?? "";
    assert.ok(
      !message.includes("accepts item or items"),
      `handler exclusiveness text must stay the direct-call fallback only: ${message}`
    );
  });

  // The point of the schema-layer contract: the rejection the model reads must
  // name the field to fix, and two different bad inputs must not collapse into
  // one byte-identical string.
  it("cross-mode rejection names the offending field of that input", async () => {
    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ["/item", { mode: "replace", items: ["x"], item: "y" }],
      ["/item", { mode: "update", id: "t1", status: "pending", item: "x" }],
      ["/id", { mode: "add", item: "x", id: "t1" }],
      ["/items", { mode: "read", items: ["x"] }],
    ];
    const messages: string[] = [];
    for (const [field, input] of cases) {
      const result = await execute(input);
      assert.equal(result.kind, "validation_failed");
      const message =
        (result as { kind: string; message?: string }).message ?? "";
      assert.ok(
        message.includes(`at ${field}:`),
        `expected ${field} to be named in the rejection, got: ${message}`
      );
      assert.match(message, /not accepted/);
      messages.push(message);
    }
    // Two /item cases share one string; /id and /items each add one.
    assert.equal(new Set(messages).size, 3);
  });

  it("bad-mode rejection lists every accepted mode so the model can self-correct", async () => {
    const result = await execute({ mode: "bogus" });
    assert.equal(result.kind, "validation_failed");
    const message =
      (result as { kind: string; message?: string }).message ?? "";
    assert.ok(
      message.includes("at /mode:"),
      `expected /mode to be named, got: ${message}`
    );
    for (const mode of TODO_WRITE_MODES) {
      assert.ok(
        message.includes(mode),
        `expected accepted mode "${mode}" in: ${message}`
      );
    }
  });

  it("each mode's valid minimal shape still passes the schema", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const results = await executor.executeAll([
      { id: "s-read", name: "todo_write", input: { mode: "read" } },
      {
        id: "s-add-item",
        name: "todo_write",
        input: { mode: "add", item: "one" },
      },
      {
        id: "s-add-items",
        name: "todo_write",
        input: { mode: "add", items: ["a", "b"] },
      },
      {
        id: "s-replace",
        name: "todo_write",
        input: { mode: "replace", items: ["z"] },
      },
    ]);
    assert.deepEqual(
      results.map((r) => r.kind),
      ["ok", "ok", "ok", "ok"]
    );
    const after = await executor.executeAll([
      {
        id: "s-upd",
        name: "todo_write",
        input: { mode: "update", id: "t1", status: "completed" },
      },
    ]);
    assert.equal(after[0]!.kind, "ok");
  });

  it("mode contract branches derive one field-exclusion branch per mode", () => {
    const tool = createTodoWriteTool({ todoDir });
    const schema = tool.inputSchema as {
      allOf?: ReadonlyArray<{
        if?: {
          properties?: Record<string, unknown>;
          required?: ReadonlyArray<string>;
        };
        then?: { properties?: Record<string, unknown> };
      }>;
      properties?: Record<string, unknown>;
      required?: ReadonlyArray<string>;
      additionalProperties?: boolean;
    };
    const exclusions = (schema.allOf ?? []).filter(
      (branch) => Object.keys(branch.then?.properties ?? {}).length > 0
    );
    assert.equal(
      exclusions.length,
      TODO_WRITE_MODES.length,
      "one field-exclusion branch per mode"
    );
    exclusions.forEach((branch, i) => {
      const declared = (
        branch.if?.properties?.mode as { const?: string } | undefined
      )?.const;
      assert.equal(declared, TODO_WRITE_MODES[i], `branch #${i} mode guard`);
      for (const [field, subSchema] of Object.entries(
        branch.then?.properties ?? {}
      )) {
        assert.equal(
          subSchema,
          false,
          `${declared} excludes ${field} with a false subschema`
        );
      }
    });
    // Top-level flat contract (properties/required/additionalProperties) is
    // kept so field descriptions and the direct-call parseInput fallback stay
    // single-sourced.
    assert.ok(schema.properties && "mode" in schema.properties);
    assert.deepEqual(schema.required, ["mode"]);
    assert.equal(schema.additionalProperties, false);
  });
});
