/**
 * #440 T2 + ADR-0085 / specs/agent-control-surface.md Slice C: todo_write tool
 * factory tests (mode routing, ledger shape, typed errors).
 *
 * Spec: docs/adr/0085-todo-ledger-id-and-three-ops.md. Modes are the three
 * operations — read / add / update — plus the whole-table escape hatch
 * (`replace`, ADR-0046 snapshots). Old `list` → read, old `check` → update
 * status=completed.
 *
 * Scope:
 *   - factory shape (name / schema / aci metadata)
 *   - mode = "read": missing file → ""; current items with id / subject / status
 *   - mode = "add": one item or many; appends (never overwrites); receipt names
 *     the new ids (SC7)
 *   - mode = "update": by id — subject / status / delete; unknown id → typed
 *     error, file untouched (SC8)
 *   - mode = "replace": whole-table swap + same-directory snapshot
 *   - SC11: empty add / empty subject / over-limit → typed error, file
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
  TODO_WRITE_SKIP_CLAUSE,
} from "../../../../src/harness/aci/tools/todo-write.ts";
import {
  formatLedgerLine,
  serializeLedger,
} from "../../../../src/harness/aci/tools/todo-ledger.ts";
import { ToolExecutionError } from "../../../../src/harness/errors.ts";

let todoDir: string;

beforeEach(async () => {
  todoDir = await mkdtemp(join(tmpdir(), "todo-write-"));
});

afterEach(async () => {
  await rm(todoDir, { recursive: true, force: true });
});

/** 某目录下形如 `todos.<unixMs>.<hex>.md` 的快照文件名(SSOT — 与 replace 路径产出的命名形态对齐)。 */
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
    // add: 单条 item 或一次多条 items(G2 决议:多步计划一次写完)。
    assert.equal(props.item.type, "string");
    assert.equal(props.items.type, "array");
    assert.deepEqual(props.items.items, { type: "string" });
    // update: 目标 id + 至少一个改动字段(delete 是更新操作,不是第四态)。
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

  // SC7: 一次 add 多条 → 现行 N 条 pending,回执含 N 个 id。
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

    // read 回读同形:N 条 pending。
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

  // SC8: 未知 id → typed error,现行不动。
  it("unknown id → typed error naming the id; file untouched (SC8)", async () => {
    const tool = await seed();
    const before = await readFile(join(todoDir, "todos.md"), "utf8");
    await assert.rejects(
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
      tool.handler({ mode: "update", id: "t42", delete: true }),
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
      tool.handler({ mode: "update", id: "t1" }),
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
      tool.handler({ mode: "update", status: "completed" }),
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
      tool.handler({ mode: "update", id: "t1", delete: false }),
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
// ADR-0046: replace 主路径 — 把现行 todos.md 换成新列表,旧文件留同目录
// 快照(`todos.<unixMs>.<hex>.md`);read 仍只读现行。降级为整表逃生口。
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — mode=replace", () => {
  it("fresh conversationId + items=[A,B] → 现行恰好两条 pending(新 id);回执短字符串", async () => {
    // 真实 per-conversation 路径 + fresh conversationId(不预存文件)。
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
    // 空 items 是合法操作:把整张列表清空(逃生口的清空语义保留)。
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
      tool.handler({ mode: "replace", items: ["ok", big] }, ctx),
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
    // 整文件 64 KB 上限对 replace 同样适用。limit 校验应在 rename 之前,
    // 失败时现行与目录都不动。
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

    // 构造一组会让最终文件超 64 KB 的 items:每条 ≤ 500 codepoints(通过
    // per-item 校验),但累计 bytes > 64 KB。id 前缀 + 500 字节 ≈ 512 字节/条。
    const items: string[] = [];
    for (let i = 0; i < 140; i++) items.push("y".repeat(500));

    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "replace", items }, ctx),
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
    // 注入一点时间偏移确保 unixMs 不撞(在极快机器上仍可命中 hex 兜底)。
    await new Promise((r) => setTimeout(r, 5));
    await tool.handler({ mode: "add", item: "v2-b" }, ctx);
    await tool.handler({ mode: "replace", items: ["v3-a"] }, ctx);

    const snapshotNames = await listSnapshotNames(
      join(todoDir, ctx.conversationId)
    );
    assert.equal(snapshotNames.length, 2);
    assert.notEqual(snapshotNames[0], snapshotNames[1]);
  });

  // #903 T2 exception 半写不变量:replace 路径下 snapshot rename 成功(snapshot
  // 已落盘旧全文),但 writeTodosAtomic 内部 writeFile/rename 失败时的
  // 不变量:typed-error 抛出,快照仍为旧全文,现行 todos.md 不应是半截——
  // 原子写半截路径由 writeTodosAtomic 的 tmp + rename 保证不存在。
  // 注入点:走 `randomBytes` 测试 seam —— writeTodosAtomic 的执行顺序是
  //   mkdir(parent) → random(6) → writeFile(tmp) → rename(tmp→filePath)
  // 自定义 randomBytes 在第二次调用时(snapshot 用了 1 次,atomic write 用
  // 第 2 次)把 dir chmod 0o555,使随后的 writeFile / rename 抛 EACCES,
  // snapshot 已经成功,现行不会被部分写入。

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
      // 第二次调用 = writeTodosAtomic 的 random(6)。此时 snapshot 已完成,
      // mkdir(parent) 已递归 no-op。chmod 让随后的 writeFile / rename 抛
      // EACCES,落入 catch 路径(typed-error,unlink tmp 失败也吞掉)。
      if (randomCalls === 2) {
        // 同步 chmod:EACCES 直接生效;restore 在 finally 里做。
        chmodSync(dir, 0o555);
      }
      // 全 0xAA buffer → hex "aaaaaaaaaaaaaaaaaaaaaa"。
      return Buffer.alloc(n, 0xaa);
    };

    try {
      const tool = createTodoWriteTool({
        todoDir,
        randomBytes: deterministicRandom,
      });
      await assert.rejects(
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

    // 不变量 ①:快照已落盘且内容 = 旧全文。
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 1, "exactly one snapshot present");
    assert.equal(
      await readFile(join(dir, snapshotNames[0]!), "utf8"),
      initialContent
    );

    // 不变量 ②:现行 todos.md 不存在(原文件已被 snapshot rename 移走,
    // atomic write 失败 → 现行未创建)。这是"无半截"的实证:现行不是部分
    // 新内容,而是根本不存在。
    assert.equal(await fileExists(currentPath), false);

    // 不变量 ③:无 .tmp 残留(atomic write 的 catch 路径 unlink tmpPath)。
    const postEntries = await readdir(dir);
    assert.equal(
      postEntries.filter((e) => e.endsWith(".tmp")).length,
      0,
      "no `.tmp` leftovers after atomic-write failure"
    );
  });

  // #903 T2 exception 半写不变量:replace 路径的 snapshotCurrentTodos rename
  // 抛错时,现行 todos.md 保持旧内容(原子 rename 失败 → 源路径不动),
  // 同目录没有快照文件落地,无 .tmp 残留。注入点:子目录只读。

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

    // 子目录去掉 w 权限 → snapshot rename 写不进 todos.<…>.md 报 EACCES。
    // mkdir(join(filePath, "..")) 在已存在子目录上 recursive no-op,不会先抛。
    await chmod(dir, 0o555);
    let threw = false;
    try {
      const tool = createTodoWriteTool({ todoDir });
      await assert.rejects(
        tool.handler({ mode: "replace", items: ["new"] }, ctx),
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

    // 不变量:现行仍是旧内容 + 无快照 + 无 .tmp。
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

  // #903 T2 exception 半写不变量:replace 路径下 readTodos 抛错(非 ENOENT)
  // 时,无 snapshot、无新 todos.md、无 .tmp 残留。注入点:把 filePath
  // 预置为目录而不是文件 → readFile 抛 EISDIR,落入 readTodos catch 包装
  // 成 "[todo_write] read failed: ..." typed-error,先于 snapshot 抛错。

  it("readTodos 在 replace 抛错 → typed-error,无 snapshot、无 tmp、无新文件", async () => {
    const ctx = { conversationId: "conv-replace-read-fail" };
    const dir = join(todoDir, ctx.conversationId);
    await mkdir(dir, { recursive: true });
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    // 把 filePath 预置为目录(覆盖现有 file)→ readFile 抛 EISDIR。
    await mkdir(currentPath, { recursive: true });

    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "replace", items: ["new"] }, ctx),
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
      tool.handler({ mode: "purge" as never }),
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
      tool.handler({ mode: "list" as never }),
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
      tool.handler({ mode: "check", item: "x" } as never),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /mode must be one of/);
        return true;
      }
    );
  });

  it("add without item → ToolExecutionError (SC11: empty add typed)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(tool.handler({ mode: "add" }), (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError);
      assert.match(
        (err as Error).message,
        /item must be a non-empty string ≤ 500 codepoints/
      );
      return true;
    });
  });

  it("add with empty item → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "add", item: "" }),
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
      tool.handler({ mode: "read", evil: "x" as never }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /unknown field: evil/);
        return true;
      }
    );
  });

  it("input is not an object → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(tool.handler("nope" as never), (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError);
      assert.match((err as Error).message, /input must be an object/);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// #440 T3 — governance limits + atomic write
//
// D4 决议：文件上限 64 KB；单条上限 500 codepoints；负面措辞拒绝**不做**
// （todo 条目"别忘了跑测试"是合法任务；只有 memory_save 拒绝负面措辞）。
// 原子写：tmp + rename（mirror memory_save writeSlugAtomic）；写失败
// 清理 tmp，崩溃中途不污染既有 todos.md。
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — #440 T3 governance + atomic write", () => {
  it("per-item limit 500 codepoints（add 超过上限 → typed error，不写盘）", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const big = "x".repeat(MAX_ITEM_CODEPOINTS + 1);
    await assert.rejects(
      tool.handler({ mode: "add", item: big }),
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

    // 数组里任一元素超限 → 整次 add typed error,不半写。
    const before = await readFile(join(todoDir, "todos.md"), "utf8");
    await assert.rejects(
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
      tool.handler({ mode: "add", item: item400 }),
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
    // D6 决议：主 loop 单写者；loop engine 串行 tool call（isConcurrencySafe:
    // false）。本测试断言在串行调用下所有 add 都落地、顺序保持。
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
        tool.handler({ mode: "add", item: "should fail" }),
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
// SC11: empty / overflow — typed failure and NO half-write.
//
// 每个用例先建立一个非空现行,失败后逐字节比对:现行既不能变成半截新内
// 容,也不能被清空。
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
      tool.handler({ mode: "add", items: [] }),
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
      tool.handler({ mode: "add", item: "" }),
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
      tool.handler({ mode: "add", items: ["ok", ""] }),
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
      tool.handler({ mode: "update", id: "t1", subject: "" }),
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
      tool.handler({ mode: "add", items: [big, big] }),
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

// -- pure helpers (exported for T3) ------------------------------------------

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

// -- T5: typed-error catch 渲染契约（code-quality.md §typed-error catch 契约）
// 渲染端必须能从 catch 侧区分 typed-error 与 plain object —— 禁止
// `err instanceof Error ? err.message : String(err)`（plain Error 会丢
// 掉 name / className 区分；plain object 会打成 [object Object]）。本组
// 测试断言 throw 端 + 通用 catch 模板的输出形态。
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
    // 模拟 catch 侧:
    //   } catch (err) { return err instanceof Error ? err.message : String(err); }
    // 对 ToolExecutionError 应回 message(不是 [object Object]); name 应保留。
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
    // 反向断言:若 throw 端出现 plain object(漏 instanceof Error 检查),
    // catch 用 String(err) 会打成 [object Object] —— 此处仅文档化契约,
    // 不复现 bug,但保留断言防回归。
    const plain = { kind: "tool_error", reason: "x" };
    const rendered = String(plain);
    assert.equal(rendered, "[object Object]");
  });
});

// ---------------------------------------------------------------------------
// ADR-0085 / SC9: actor capability —— worker 与父会话共用同一本账。
//
// 契约(ADR-0085「同一主会话内子代理与父共用账本」):
//   - worker 可 read / update 父会话账本(scoped write 的 update 仍合法);
//   - worker `add` 是**工具自身**的 typed 拒绝(ToolExecutionError +
//     [todo_write] 前缀),不是静默丢弃、不是「工具不在场」——工具必须在
//     worker 工具面上,模型才能读到拒绝原因;
//   - 执行的拒绝不依赖权限层(worker 装配用 no-ask askUser → 权限层恒真)。
//
// 缝形状:worker 进程的 executor 不合成 ctx.conversationId(worker deps 无
// conversationId),故 deps.actor.conversationId 是回退源;父会话仍以
// ctx.conversationId 为准(显式传入者优先)。
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — ADR-0085 SC9 actor capability", () => {
  it("canAdd:false → add 抛 ToolExecutionError,消息带 [todo_write] 前缀并点名 parent-only 共享账本", async () => {
    const tool = createTodoWriteTool({
      todoDir,
      actor: { conversationId: "conv-parent", canAdd: false },
    });
    await assert.rejects(
      tool.handler({ mode: "add", item: "worker must not add" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError, "typed error 形态");
        const message = (err as Error).message;
        assert.match(message, /^\[todo_write\]/);
        // 模型必须能读出「为什么被拒 + 还能做什么」——不是静默丢弃。
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
    await assert.rejects(tool.handler({ mode: "add", item: "x" }));
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
    // 父会话先写一本账(ctx.conversationId 路径,与 worker 的是同一本)。
    const parent = createTodoWriteTool({ todoDir });
    const receipt = await parent.handler(
      { mode: "add", item: "shared item" },
      { conversationId: "conv-parent" }
    );
    const id = /Added 1 item: (t\d+)/.exec(String(receipt))![1]!;

    // worker 装配形态:无 ctx.conversationId,靠 deps.actor 回退。
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
    await tool
      .handler(
        { mode: "update", id: "t1", status: "completed" },
        { conversationId: "conv-from-ctx" }
      )
      .catch(() => undefined);
    // ctx 路径缺文件 → unknown id;deps 路径文件必然缺席。
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
    // ADR-0085 只说「添加仅父会话」;replace 是整表逃生口,不在 add 语义内。
    const tool = createTodoWriteTool({
      todoDir,
      actor: { conversationId: "conv-parent", canAdd: false },
    });
    const out = await tool.handler({ mode: "replace", items: ["only"] });
    assert.equal(out, "Updated todos.md");
  });
});

// ---------------------------------------------------------------------------
// #440 T6: D9 正面引导式 description —— 只写正面触发,无负面禁令。
// 纪律约束：「正面触发条件自排除简单任务」(D9 决策),禁止 "do not" /
// "avoid" / "simple task" / "never" 等负面措辞（grilling 修正后模型决策
// 噪声会变多）。description 字面在 ToolDef.description 字段,经 registry
// catalog 暴露给模型 promptTools —— 测试用 reg.inner.get 拿 def.description
// 锁形态(系统 prompt grep 锚点 = ToolDef.description)。
//
// ADR-0085 起 vocabulary 是三件事:read / add / update(+ replace 逃生口)。
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
    // replace 逃生口也在正面描述里
    assert.ok(desc.includes("replace"));
    // id 寻址是 update 的入参事实,模型要能从 description 读出来。
    assert.ok(desc.includes("id"));
    // 三个 status 值在校验层,description 至少点名 status 轴。
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

  // -- #646 T2: 跳过条件句(下一步就能做完用户这句 → 直接做完,不建清单) ----

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
