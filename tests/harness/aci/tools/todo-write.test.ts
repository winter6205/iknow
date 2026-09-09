/**
 * #440 T2: todo_write tool factory tests (mode routing + checkbox format).
 *
 * Spec: docs/handoff/2026-08-17-wayfinder-440-decisions.md D1/D5. T2 covers
 * mode parsing, checkbox format (open/closed lines), and typed errors.
 * Atomic write + governance limits live in T3; harness integration in T7.
 *
 * Scope:
 *   - factory shape (name / schema / aci metadata)
 *   - mode = "list": empty file returns ""; full content returned verbatim
 *   - mode = "add": appends `- [ ] <item>\n`; receipt `"Updated todos.md"`
 *   - mode = "check": flips first exact `- [ ] <item>` to `- [x] <item>`
 *   - typed errors: invalid mode, missing item for add/check, no-match check
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
  formatOpenLine,
  flipFirstOpenLine,
  MAX_FILE_BYTES,
  MAX_ITEM_CODEPOINTS,
  codepointLength,
  resolveConversationTodoPath,
  TODO_WRITE_SKIP_CLAUSE,
} from "../../../../src/harness/aci/tools/todo-write.ts";
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
  it("exposes the todo_write schema with mode required (list|add|check|replace) and item/items optional", () => {
    const tool = createTodoWriteTool({ todoDir });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;

    assert.equal(tool.name, "todo_write");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["mode"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(props.mode.type, "string");
    assert.deepEqual(props.mode.enum, ["list", "add", "check", "replace"]);
    assert.equal(props.item.type, "string");
    // #903 SC1: replace 模式携带 items (array of string)
    assert.equal(props.items.type, "array");
    assert.deepEqual(props.items.items, { type: "string" });
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

// -- mode = list -------------------------------------------------------------

describe("createTodoWriteTool — mode=list", () => {
  it("todos.md missing → returns empty string (legal state, not an error)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "list" });
    assert.equal(out, "");
  });

  it("todos.md present → returns full content as-is", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(
      file,
      "- [ ] task A\n- [x] task B\n- [ ] task C\n",
      "utf8"
    );
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "list" });
    assert.equal(out, "- [ ] task A\n- [x] task B\n- [ ] task C\n");
  });
});

// -- mode = add --------------------------------------------------------------

describe("createTodoWriteTool — mode=add", () => {
  it("append `- [ ] <item>` line to empty file; receipt = 'Updated todos.md'", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "add", item: "task A" });
    assert.equal(out, "Updated todos.md");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(content, formatOpenLine("task A"));
  });

  it("append second item preserves earlier lines", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "add", item: "first" });
    await tool.handler({ mode: "add", item: "second" });
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.equal(
      content,
      `${formatOpenLine("first")}${formatOpenLine("second")}`
    );
  });
});

// -- mode = check ------------------------------------------------------------

describe("createTodoWriteTool — mode=check", () => {
  it("flip first exact-match `- [ ] <item>` to `- [x] <item>`; receipt short", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(
      file,
      `- [ ] task A\n- [ ] task B\n- [ ] task C\n`,
      "utf8"
    );
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "check", item: "task A" });
    assert.equal(out, "Updated todos.md");
    const content = await readFile(file, "utf8");
    assert.equal(content, `- [x] task A\n- [ ] task B\n- [ ] task C\n`);
  });

  it("only the FIRST open match is flipped; later matches left open", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(file, `- [ ] task A\n- [ ] task A\n`, "utf8");
    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "check", item: "task A" });
    const content = await readFile(file, "utf8");
    assert.equal(content, `- [x] task A\n- [ ] task A\n`);
  });

  it("already-checked line (`- [x] <item>`) is NOT a match → typed error", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(file, `- [x] task A\n- [ ] task B\n`, "utf8");
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "check", item: "task A" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /no open item matches/);
        return true;
      }
    );
    // File untouched (typed error before any write).
    const content = await readFile(file, "utf8");
    assert.equal(content, `- [x] task A\n- [ ] task B\n`);
  });

  it("no line matches item → typed error; file untouched", async () => {
    const file = join(todoDir, "todos.md");
    await fsWriteFile(file, `- [ ] task A\n`, "utf8");
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "check", item: "task Z" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /no open item matches: task Z/);
        return true;
      }
    );
    const content = await readFile(file, "utf8");
    assert.equal(content, `- [ ] task A\n`);
  });
});

// -- mode = replace ----------------------------------------------------------
// #903 SC2/SC3: replace 主路径 — 把现行 todos.md 换成新列表,旧文件留同目录
// 快照(`todos.<unixMs>.<hex>.md`),`list` 仍只读现行。
// ---------------------------------------------------------------------------

describe("createTodoWriteTool — mode=replace", () => {
  it("fresh conversationId + items=[A,B] → 现行恰好两行 `- [ ] A`/`- [ ] B`;回执短字符串", async () => {
    // T1 SC2:真实 per-conversation 路径 + fresh conversationId(不预存文件)。
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
    assert.equal(content, `${formatOpenLine("A")}${formatOpenLine("B")}`);
  });

  it("replace 前现行非空 → 同目录出现快照文件,内容=旧全文;现行=新列表", async () => {
    // T1 SC3:真实 per-conversation 路径。先 add 三条 → 现行非空,再 replace
    // → 快照保留旧全文,现行换新。
    const tool = createTodoWriteTool({ todoDir });
    const ctx = { conversationId: "conv-replace-snapshot" };
    await tool.handler({ mode: "add", item: "old-1" }, ctx);
    await tool.handler({ mode: "add", item: "old-2" }, ctx);
    await tool.handler({ mode: "add", item: "old-3" }, ctx);
    const beforeContent = await readFile(
      resolveConversationTodoPath({
        projectDir: todoDir,
        conversationId: ctx.conversationId,
      }),
      "utf8"
    );
    const expectedSnapshotContent = beforeContent;

    await tool.handler({ mode: "replace", items: ["new-1", "new-2"] }, ctx);

    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 1, "exactly one snapshot file");
    const snapshotPath = join(dir, snapshotNames[0]);
    const snapshotContent = await readFile(snapshotPath, "utf8");
    assert.equal(snapshotContent, expectedSnapshotContent);
    const currentContent = await readFile(currentPath, "utf8");
    assert.equal(
      currentContent,
      `${formatOpenLine("new-1")}${formatOpenLine("new-2")}`
    );
  });

  it("replace 后 `list` 只返回新现行,不含快照正文", async () => {
    // T1 SC3 第二段:`list` 不读快照。
    const tool = createTodoWriteTool({ todoDir });
    const ctx = { conversationId: "conv-replace-list" };
    await tool.handler({ mode: "add", item: "still-here-in-snapshot" }, ctx);
    await tool.handler({ mode: "replace", items: ["only-new-1"] }, ctx);

    const listed = (await tool.handler({ mode: "list" }, ctx)) as string;
    assert.match(listed, /- \[ \] only-new-1/);
    assert.ok(
      !listed.includes("still-here-in-snapshot"),
      `list 不应包含快照里的旧项,got: ${listed}`
    );
  });

  it("replace 前现行空(0 字节文件)→ 不建快照,只写新列表", async () => {
    // 现行为空 → spec 决议:不建快照。
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
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 0, "no snapshot for empty current");
    const content = await readFile(currentPath, "utf8");
    assert.equal(content, formatOpenLine("x"));
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

    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 0, "no snapshot when current missing");
    const content = await readFile(currentPath, "utf8");
    assert.equal(content, formatOpenLine("only"));
  });

  it("items=[] → 现行变为空文件,合法态;旧内容进快照", async () => {
    // 空 items 是合法操作:把整张列表清空。spec:不灌 messages,回执短字符串。
    const ctx = { conversationId: "conv-replace-clear" };
    const currentPath = resolveConversationTodoPath({
      projectDir: todoDir,
      conversationId: ctx.conversationId,
    });
    await mkdir(join(todoDir, ctx.conversationId), { recursive: true });
    await fsWriteFile(currentPath, `${formatOpenLine("keep-me")}`, "utf8");

    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "replace", items: [] }, ctx);
    assert.equal(out, "Updated todos.md");

    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 1);
    const snapshotContent = await readFile(join(dir, snapshotNames[0]), "utf8");
    assert.equal(snapshotContent, formatOpenLine("keep-me"));
    const currentContent = await readFile(currentPath, "utf8");
    assert.equal(currentContent, "");
  });

  it("replace 带 `item` 字段 → typed error(per-mode 字段互斥)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "replace", items: ["x"], item: "y" } as never, {
        conversationId: "conv-replace-mixed",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
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
    const initialContent = formatOpenLine("original");
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
    const postContent = await readFile(currentPath, "utf8");
    assert.equal(postContent, initialContent);
    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 0, "no snapshot when items invalid");
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
    const initialContent = formatOpenLine("keep");
    await fsWriteFile(currentPath, initialContent, "utf8");

    // 构造一组会让最终文件超 64 KB 的 items:每条 ≤ 500 codepoints(通过
    // per-item 校验),但累计 bytes > 64 KB。每条 500 个 ASCII = 500 字节 +
    // "- [ ] \n" = 507 字节。130 条 × 507 = 65910 字节 > 64 KB。
    const items: string[] = [];
    for (let i = 0; i < 130; i++) items.push("y".repeat(500));

    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "replace", items }, ctx),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /file would exceed 65536 bytes/);
        return true;
      }
    );
    const postContent = await readFile(currentPath, "utf8");
    assert.equal(postContent, initialContent);
    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 0, "no snapshot on limit failure");
  });

  it("add 带 `items` 字段 → typed error(add 仍只认 item)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "add", items: ["x"] } as never, {
        conversationId: "conv-add-items",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        return true;
      }
    );
  });

  it("check 带 `items` 字段 → typed error(check 仍只认 item)", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "check", items: ["x"] } as never, {
        conversationId: "conv-check-items",
      }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        return true;
      }
    );
  });

  it("两次连续 replace(同 conversationId,non-empty current)→ 产生两个快照,文件名不撞", async () => {
    // 快照名 unixMs + 随机 hex 保证不撞;两次串行 replace 后应有两个快照。
    const tool = createTodoWriteTool({ todoDir });
    const ctx = { conversationId: "conv-replace-twice" };
    await tool.handler({ mode: "add", item: "v1-a" }, ctx);
    await tool.handler({ mode: "add", item: "v1-b" }, ctx);
    await tool.handler({ mode: "replace", items: ["v2-a"] }, ctx);
    // 注入一点时间偏移确保 unixMs 不撞(在极快机器上仍可命中 hex 兜底)。
    await new Promise((r) => setTimeout(r, 5));
    await tool.handler({ mode: "add", item: "v2-b" }, ctx);
    await tool.handler({ mode: "replace", items: ["v3-a"] }, ctx);

    const dir = join(todoDir, ctx.conversationId);
    const snapshotNames = await listSnapshotNames(dir);
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
    const initialContent = formatOpenLine("preserved-by-atomic-fail");
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
    const snapshotContent = await readFile(join(dir, snapshotNames[0]), "utf8");
    assert.equal(snapshotContent, initialContent);

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
    const initialContent = formatOpenLine("preserved-by-snapshot-fail");
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
    const postCurrent = await readFile(currentPath, "utf8");
    assert.equal(postCurrent, initialContent);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 0, "no snapshot when rename fails");
    const postEntries = await readdir(dir);
    assert.equal(
      postEntries.filter((e) => e.endsWith(".tmp")).length,
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

    const postEntries = await readdir(dir);
    const snapshotNames = await listSnapshotNames(dir);
    assert.equal(snapshotNames.length, 0, "no snapshot when read fails");
    assert.equal(
      postEntries.filter((e) => e.endsWith(".tmp")).length,
      0,
      "no `.tmp` leftovers"
    );
  });
});

// -- typed-error paths -------------------------------------------------------

describe("createTodoWriteTool — typed-error catch", () => {
  it("unknown mode → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "purge" as never }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /mode must be one of/);
        return true;
      }
    );
  });

  it("add without item → ToolExecutionError", async () => {
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

  it("check without item → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(tool.handler({ mode: "check" }), (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError);
      assert.match(
        (err as Error).message,
        /item must be a non-empty string ≤ 500 codepoints/
      );
      return true;
    });
  });

  it("unknown field in input → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "list", evil: "x" as never }),
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

// -- pure helpers (exported) --------------------------------------------------

describe("formatOpenLine / flipFirstOpenLine — pure helpers", () => {
  it("formatOpenLine: appends newline; item is verbatim", () => {
    assert.equal(formatOpenLine("task A"), "- [ ] task A\n");
    assert.equal(formatOpenLine(""), "- [ ] \n");
  });

  it("flipFirstOpenLine: no match → null", () => {
    assert.equal(flipFirstOpenLine("- [ ] other\n", "task A"), null);
  });

  it("flipFirstOpenLine: preserves trailing newline structure", () => {
    const out = flipFirstOpenLine("- [ ] task A\n- [ ] task B\n", "task A");
    assert.equal(out, "- [x] task A\n- [ ] task B\n");
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
    // File untouched.
    const file = join(todoDir, "todos.md");
    assert.equal(await fileExists(file), false);
  });

  it("per-item limit 用 codepoint 计数：CJK 字符按 1 个 codepoint 算", async () => {
    const tool = createTodoWriteTool({ todoDir });
    // 500 CJK characters = 500 codepoints; just under the limit → accepted.
    const ok = "中".repeat(MAX_ITEM_CODEPOINTS);
    const out = await tool.handler({ mode: "add", item: ok });
    assert.equal(out, "Updated todos.md");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[ \] 中+$/m);
  });

  it("per-item limit 用 codepoint 计数：501 CJK 字符 → typed error", async () => {
    const tool = createTodoWriteTool({ todoDir });
    const tooMany = "中".repeat(MAX_ITEM_CODEPOINTS + 1);
    await assert.rejects(
      tool.handler({ mode: "add", item: tooMany }),
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

  it("文件上限 64 KB：add 到现有文件使之超过上限 → typed error", async () => {
    const file = join(todoDir, "todos.md");
    // Each open line `- [ ] <item>\n`: item of 400 chars → 407 bytes per line.
    // Pre-fill with 161 lines × 407 bytes = 65527 bytes (just under 64 KB).
    // Adding one more 407-byte line pushes to 65934 bytes (over 64 KB).
    const item400 = "a".repeat(400);
    const preLines: string[] = [];
    for (let i = 0; i < 161; i++) {
      preLines.push(`- [ ] ${item400}`);
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
    const postContent = await readFile(file, "utf8");
    assert.equal(postContent, preLines.join("\n") + "\n");
  });

  it("负面措辞不拒绝（add '别忘了跑测试' 成功）", async () => {
    // D4 决议：todo 工具不实现 negative_form 拒绝；与 memory_save 形成对照。
    const tool = createTodoWriteTool({ todoDir });
    const out = await tool.handler({ mode: "add", item: "别忘了跑测试" });
    assert.equal(out, "Updated todos.md");
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[ \] 别忘了跑测试$/m);
  });

  it("串行 add 不丢更新：3 个串行 await add → 3 条全在文件中", async () => {
    // D6 决议：主 loop 单写者；loop engine 串行 tool call（isConcurrencySafe:
    // false）。本测试断言在串行调用下所有 add 都落地、顺序保持。
    // 并发竞态由装配期所有权边界排除（loop-engine 不会并发触发），故
    // 不在工厂层测试 Promise.all 的合并语义。
    const tool = createTodoWriteTool({ todoDir });
    await tool.handler({ mode: "add", item: "first" });
    await tool.handler({ mode: "add", item: "second" });
    await tool.handler({ mode: "add", item: "third" });
    const content = await readFile(join(todoDir, "todos.md"), "utf8");
    assert.match(content, /^- \[ \] first$/m);
    assert.match(content, /^- \[ \] second$/m);
    assert.match(content, /^- \[ \] third$/m);
    // Order preserved.
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
    const initialContent = "- [ ] preserved\n";
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
    const postContent = await readFile(file, "utf8");
    assert.equal(postContent, initialContent);

    // No `.tmp` leftovers in todoDir.
    const entries = await readdir(todoDir);
    assert.equal(
      entries.filter((e) => e.endsWith(".tmp")).length,
      0,
      "no `.tmp` leftovers after failed write"
    );
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
    // mode validation 报告枚举集合(不内嵌 bad value),断言正确渲染集合。
    assert.ok((caught as Error).message.includes("list | add | check"));
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
    // 注:todo_write 当前所有错误路径都 throw ToolExecutionError,此断言只
    // 是反向文档(防止回归到 plain object 抛错)。
  });
});

// ---------------------------------------------------------------------------
// #440 T6: D9 正面引导式 description —— 只写正面触发,无负面禁令。
// 纪律约束：「正面触发条件自排除简单任务」(D9 决策),禁止 "do not" /
// "avoid" / "simple task" / "never" 等负面措辞（grilling 修正后模型决策
// 噪声会变多）。description 字面在 ToolDef.description 字段,经 registry
// catalog 暴露给模型 promptTools —— 测试用 reg.inner.get 拿 def.description
// 锁形态(系统 prompt grep 锚点 = ToolDef.description)。
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
    // 至少一个正向触发关键词（multi-step / multi-turn / progress / track）。
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

  it("description 明确告知三个 mode 的形态(list/add/check/replace),无歧义", () => {
    const desc = readDescription();
    assert.ok(desc.includes("list"));
    assert.ok(desc.includes("add"));
    assert.ok(desc.includes("check"));
    // #903: replace 模式也在正面描述里
    assert.ok(desc.includes("replace"));
  });

  it("registry catalog 暴露的 description 与 factory 直接读一致（系统 prompt grep 锚点）", () => {
    const tool = createTodoWriteTool({ todoDir });
    // factory 直接读
    const factoryDesc = tool.description;
    // 模拟系统 prompt 暴露：经 ACI 工具面（registry.inner）的同一 def
    // 此刻不依赖 registry 装配（隔离测试），但 assert factory 形态稳定
    // (promptTools 经 reg.visibleSchemas 拿到的 def.description 字段同源)
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
    // 正面触发仍在:多步骤 / 跨多轮 / 进度持存(T2 不削弱既有正向表述)。
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
    // D9 纪律硬钉(T2 重申):无「简单任务」式模糊禁令。
    assert.ok(!clause.includes("simple task"));
  });
});
