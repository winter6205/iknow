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
