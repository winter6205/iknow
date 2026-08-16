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
import {
  mkdtemp,
  rm,
  readFile,
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
} from "../../../../src/harness/aci/tools/todo-write.ts";
import { ToolExecutionError } from "../../../../src/harness/errors.ts";

let todoDir: string;

beforeEach(async () => {
  todoDir = await mkdtemp(join(tmpdir(), "todo-write-"));
});

afterEach(async () => {
  await rm(todoDir, { recursive: true, force: true });
});

// -- tool shape / metadata ---------------------------------------------------

describe("createTodoWriteTool — tool shape", () => {
  it("exposes the todo_write schema with mode required (list|add|check) and item optional", () => {
    const tool = createTodoWriteTool({ todoDir });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;

    assert.equal(tool.name, "todo_write");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["mode"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(props.mode.type, "string");
    assert.deepEqual(props.mode.enum, ["list", "add", "check"]);
    assert.equal(props.item.type, "string");
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
      assert.match((err as Error).message, /non-empty string for mode add/);
      return true;
    });
  });

  it("add with empty item → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(
      tool.handler({ mode: "add", item: "" }),
      (err: unknown) => {
        assert.ok(err instanceof ToolExecutionError);
        assert.match((err as Error).message, /non-empty string for mode add/);
        return true;
      }
    );
  });

  it("check without item → ToolExecutionError", async () => {
    const tool = createTodoWriteTool({ todoDir });
    await assert.rejects(tool.handler({ mode: "check" }), (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError);
      assert.match((err as Error).message, /non-empty string for mode check/);
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
        assert.match((err as Error).message, /exceeds 500 codepoints/);
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
        assert.match((err as Error).message, /exceeds 500 codepoints/);
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
    const { chmod, readdir } = await import("node:fs/promises");
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
    const { stat } = await import("node:fs/promises");
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
