import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createEditFileTool } from "../../../../src/harness/aci/tools/edit-file.ts";

let scratch: string;
let scratchPaths: string[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "aci-edit-file-"));
  scratchPaths = [scratch];
});

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("createEditFileTool — input schema", () => {
  it("exposes name='edit_file' and the documented inputSchema", () => {
    const tool = createEditFileTool(scratch);
    assert.equal(tool.name, "edit_file");
    assert.equal(tool.description.length > 0, true);
    assert.equal(tool.inputSchema.type, "object");
    assert.deepEqual(tool.inputSchema.required, ["path", "old_str", "new_str"]);
    const properties = tool.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(properties.path.type, "string");
    assert.equal(properties.old_str.type, "string");
    assert.equal(properties.new_str.type, "string");
    assert.equal(properties.replace_all.type, "boolean");
    assert.equal(properties.replace_all.default, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  });

  it("uses the ACI write metadata shape", () => {
    const tool = createEditFileTool(scratch);
    assert.equal(tool.aci.category, "write");
    assert.equal(tool.aci.isConcurrencySafe, false);
    assert.equal(tool.aci.interruptBehavior, "block");
  });
});

describe("createEditFileTool — single-replacement success", () => {
  it("replaces a single occurrence and returns the relative path", async () => {
    const file = join(scratch, "a.ts");
    await writeFile(file, "const a = 1;\nconst b = 2;\n", "utf8");
    const tool = createEditFileTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "const a = 1;",
      new_str: "const a = 99;",
    })) as {
      output: string;
      meta: { oldContent: string; newContent: string };
    };
    assert.equal(
      result.output,
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "a.ts")}`
    );
    assert.equal(await readFile(file, "utf8"), "const a = 99;\nconst b = 2;\n");
  });

  it("returns an envelope with meta.oldContent = pre-write full and meta.newContent = post-replace full", async () => {
    const file = join(scratch, "env.ts");
    const before = "const a = 1;\nconst b = 2;\n";
    await writeFile(file, before, "utf8");
    const tool = createEditFileTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "const a = 1;",
      new_str: "const a = 99;",
    })) as {
      output: string;
      meta: { oldContent: string; newContent: string };
    };
    assert.equal(result.meta.oldContent, before);
    assert.equal(result.meta.newContent, "const a = 99;\nconst b = 2;\n");
    // 模型无关的验证:output 是纯文案,不含 meta JSON。
    assert.equal(
      result.output,
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "env.ts")}`
    );
    assert.ok(!result.output.includes("oldContent"));
    assert.ok(!result.output.includes("newContent"));
  });

  it("envelope meta reflects replace_all=multi-occurrence full rewrite", async () => {
    const file = join(scratch, "env-all.ts");
    await writeFile(file, "x = 1\nx = 1\n", "utf8");
    const tool = createEditFileTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "x = 1",
      new_str: "x = 2",
      replace_all: true,
    })) as { output: string; meta: { oldContent: string; newContent: string } };
    assert.equal(result.meta.oldContent, "x = 1\nx = 1\n");
    assert.equal(result.meta.newContent, "x = 2\nx = 2\n");
  });

  it("accepts an empty new_str — acts as a literal deletion of old_str", async () => {
    const file = join(scratch, "b.ts");
    await writeFile(file, "header\nKEEP_ME\nfooter\n", "utf8");
    const tool = createEditFileTool(scratch);
    await tool.handler({
      path: file,
      old_str: "KEEP_ME\n",
      new_str: "",
    });
    assert.equal(await readFile(file, "utf8"), "header\nfooter\n");
  });

  it("preserves `$&` and friends as literal text (no String.replace expansion)", async () => {
    // Standards M1: split-join (NOT String.replace) means `$&` / `$1` / `$$`
    // stay literal. If anyone reintroduces String.replace the assertions blow up.
    const file = join(scratch, "c.ts");
    await writeFile(file, "FOO_BAR = 1;\n", "utf8");
    const tool = createEditFileTool(scratch);
    await tool.handler({
      path: file,
      old_str: "FOO_BAR = 1;",
      new_str: 'const x = "$& and $1 and $$";\n',
    });
    const after = await readFile(file, "utf8");
    assert.equal(after, 'const x = "$& and $1 and $$";\n\n');
    // 反向断言:没有 FOO_BAR 字面值残留(说明 $& 没被展开成 old_str 全文)。
    assert.ok(!after.includes("FOO_BAR"));
  });
});

describe("createEditFileTool — replace_all", () => {
  it("replaces every occurrence when replace_all=true", async () => {
    const file = join(scratch, "d.ts");
    await writeFile(file, "x = 1\nx = 1\nx = 1\n", "utf8");
    const tool = createEditFileTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "x = 1",
      new_str: "x = 2",
      replace_all: true,
    })) as { output: string; meta: { oldContent: string; newContent: string } };
    assert.equal(
      result.output,
      `[edit_file] replaced 3 occurrence(s) in ${join(scratch, "d.ts")}`
    );
    assert.equal(await readFile(file, "utf8"), "x = 2\nx = 2\nx = 2\n");
  });

  it("replaces only the first occurrence when replace_all=false (default)", async () => {
    const file = join(scratch, "e.ts");
    // 三行各不相同;old_str 取第二行的完整唯一上下文,精确命中一次。
    await writeFile(file, "x = 0\nunique_marker = 42\nx = 9\n", "utf8");
    const tool = createEditFileTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "unique_marker = 42",
      new_str: "unique_marker = 100",
    })) as { output: string };
    assert.equal(
      result.output,
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "e.ts")}`
    );
    assert.equal(
      await readFile(file, "utf8"),
      "x = 0\nunique_marker = 100\nx = 9\n"
    );
  });
});

describe("createEditFileTool — exact rejection messages", () => {
  it("rejects with the precise T1-4 message when old_str is not found", async () => {
    const file = join(scratch, "f.ts");
    await writeFile(file, "hello world\n", "utf8");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({ path: file, old_str: "missing", new_str: "ok" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === `[edit_file] old_str not found: ${file}`
    );
  });

  it("rejects with the precise T1-4 multi-match message when replace_all=false and >1 occurrences", async () => {
    const file = join(scratch, "g.ts");
    await writeFile(file, "x = 1\nx = 1\n", "utf8");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({ path: file, old_str: "x = 1", new_str: "x = 2" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message ===
          `[edit_file] old_str matched 2 times, provide more context or set replace_all`
    );
  });

  it("multi-match rejection uses the actual count (3)", async () => {
    const file = join(scratch, "g3.ts");
    await writeFile(file, "a a a a a a", "utf8");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({ path: file, old_str: "a", new_str: "b" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message ===
          `[edit_file] old_str matched 6 times, provide more context or set replace_all`
    );
  });

  it("multi-match rejection does NOT mutate the file (no write before count check)", async () => {
    const file = join(scratch, "g-noop.ts");
    const original = "x = 1\nx = 1\n";
    await writeFile(file, original, "utf8");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({ path: file, old_str: "x = 1", new_str: "x = 2" }),
      ToolExecutionError
    );
    assert.equal(await readFile(file, "utf8"), original);
  });
});

describe("createEditFileTool — poka-yoke linter integration", () => {
  it("rejects when the patched text breaks bracket pairing — file stays intact", async () => {
    const file = join(scratch, "lint.ts");
    const original = "const x = 1;\n";
    await writeFile(file, original, "utf8");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({
        path: file,
        old_str: "const x = 1;",
        new_str: "const x = (1;",
      }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.startsWith("[edit_file] lint rejected:")
    );
    assert.equal(await readFile(file, "utf8"), original);
  });

  it("accepts a balanced new_str including strings and nested brackets", async () => {
    const file = join(scratch, "lint-ok.ts");
    await writeFile(file, "echo;\n", "utf8");
    const tool = createEditFileTool(scratch);
    await tool.handler({
      path: file,
      old_str: "echo;",
      new_str: `call({ value: 'ok' })`,
    });
    assert.equal(await readFile(file, "utf8"), `call({ value: 'ok' })\n`);
  });
});

describe("createEditFileTool — path / file errors", () => {
  it("rejects when the file does not exist", async () => {
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({
        path: join(scratch, "missing.ts"),
        old_str: "x",
        new_str: "y",
      }),
      ToolExecutionError
    );
  });

  it("rejects a path that escapes the root via parent traversal", async () => {
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({
        path: join(scratch, "..", "outside.ts"),
        old_str: "x",
        new_str: "y",
      }),
      ToolExecutionError
    );
  });

  it("rejects a symlink that resolves outside the workspace root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "aci-edit-outside-"));
    scratchPaths.push(outside);
    await symlink(outside, join(scratch, "escape"), "dir");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({
        path: join(scratch, "escape", "victim.ts"),
        old_str: "x",
        new_str: "y",
      }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});

describe("createEditFileTool — input validation", () => {
  it("rejects an empty old_str (would otherwise match everywhere)", async () => {
    const file = join(scratch, "empty-old.ts");
    await writeFile(file, "hello\n", "utf8");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({ path: file, old_str: "", new_str: "X" }),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.message.includes("old_str")
    );
  });

  it("rejects when path is missing", async () => {
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({ old_str: "x", new_str: "y" }),
      ToolExecutionError
    );
  });

  it("rejects when new_str is missing (must be present even if empty string)", async () => {
    const file = join(scratch, "no-new.ts");
    await writeFile(file, "x\n", "utf8");
    const tool = createEditFileTool(scratch);
    await assert.rejects(
      tool.handler({ path: file, old_str: "x" }),
      ToolExecutionError
    );
  });

  it("rejects an unknown extra field (additionalProperties:false)", async () => {
    const file = join(scratch, "extra.ts");
    await writeFile(file, "x\n", "utf8");
    const tool = createEditFileTool(scratch);
    // Bypass type system on purpose: handler must still reject noise.
    await assert.rejects(
      tool.handler({
        path: file,
        old_str: "x",
        new_str: "y",
        evil: true,
      } as unknown as Parameters<typeof tool.handler>[0]),
      ToolExecutionError
    );
  });
});

describe("createEditFileTool — directory support", () => {
  it("edits a file inside a nested subdirectory", async () => {
    const nested = join(scratch, "deep", "inside.ts");
    await mkdir(join(scratch, "deep"), { recursive: true });
    await writeFile(nested, "before\n", "utf8");
    const tool = createEditFileTool(scratch);
    await tool.handler({ path: nested, old_str: "before", new_str: "after" });
    assert.equal(await readFile(nested, "utf8"), "after\n");
  });
});

describe("createEditFileTool — onEdit seam", () => {
  it("调用方传 opts.onEdit → 写盘成功后回调被调一次,参数为绝对路径", async () => {
    const file = join(scratch, "a.ts");
    await writeFile(file, "hello world\n", "utf8");
    const calls: string[] = [];
    const tool = createEditFileTool(scratch, {
      onEdit: (f) => {
        calls.push(f);
      },
    });
    const result = (await tool.handler({
      path: file,
      old_str: "world",
      new_str: "earth",
    })) as { output: string };
    assert.equal(calls.length, 1);
    assert.equal(calls[0], join(scratch, "a.ts"));
    assert.equal(
      result.output,
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "a.ts")}`
    );
    assert.equal(await readFile(file, "utf8"), "hello earth\n");
  });

  it("onEdit 不传时 行为与改动前 byte-identical", async () => {
    const file = join(scratch, "b.ts");
    await writeFile(file, "const a = 1;\n", "utf8");
    const tool = createEditFileTool(scratch);
    const result = (await tool.handler({
      path: file,
      old_str: "const a = 1;",
      new_str: "const a = 2;",
    })) as { output: string };
    assert.equal(
      result.output,
      `[edit_file] replaced 1 occurrence(s) in ${join(scratch, "b.ts")}`
    );
    assert.equal(await readFile(file, "utf8"), "const a = 2;\n");
  });

  it("onEdit 抛错时不吞错 → handler 仍走 execution_failed", async () => {
    const file = join(scratch, "c.ts");
    await writeFile(file, "x = 1\n", "utf8");
    const tool = createEditFileTool(scratch, {
      onEdit: () => {
        throw new Error("notifier disposed");
      },
    });
    await assert.rejects(
      tool.handler({ path: file, old_str: "x = 1", new_str: "x = 2" }),
      (err: unknown) =>
        err instanceof ToolExecutionError || err instanceof Error
    );
  });
});
