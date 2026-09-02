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
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../../../src/harness/session-roots.ts";
import type { LiveTaskRoot } from "../../../../src/harness/session-roots.ts";

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

describe("createEditFileTool — live taskRoot (T5)", () => {
  // T5 (plans/worktree-live-task-root.md §6) — edit_file 在 **handler 调用时**
  // 取根（不再闭包冻结装配期根）。门禁未翻 ⇒ 装配期根未翻转时行为与今日逐字节
  // 一致；本组用例覆盖以下三件：
  //   (a) LiveTaskRoot 参数 + 翻转 cell → 第二次调用落到新根；
  //   (b) 一次 handler 内 resolve 与写入用同一个根值（D2 per-call 单读）；
  //   (c) 字符串参数 + LiveTaskRoot 参数在初值相同的情况下行为逐字节一致。
  it("(a) handler reads root at call time — rebind mid-lifecycle edits in new root", async () => {
    const initialRoot = await mkdtemp(
      join(tmpdir(), "edit-file-live-initial-")
    );
    scratchPaths.push(initialRoot);
    const reboundRoot = await mkdtemp(
      join(tmpdir(), "edit-file-live-rebound-")
    );
    scratchPaths.push(reboundRoot);

    // 在两棵树各预置一份待改文件
    const initFile = join(initialRoot, "f.ts");
    const rebFile = join(reboundRoot, "f.ts");
    await writeFile(initFile, "before\n", "utf8");
    await writeFile(rebFile, "before\n", "utf8");

    const cell: LiveTaskRoot = createLiveTaskRoot(initialRoot);
    const tool = createEditFileTool(cell);

    // 第一次：改 initialRoot
    await tool.handler({
      path: join(initialRoot, "f.ts"),
      old_str: "before",
      new_str: "after-initial",
    });
    assert.equal(await readFile(initFile, "utf8"), "after-initial\n");
    assert.equal(await readFile(rebFile, "utf8"), "before\n");

    // rebind —— 模拟 host seam 成功 resolve 后 cell 被翻转
    writeLiveTaskRoot(cell, reboundRoot);

    // 第二次：改 reboundRoot
    await tool.handler({
      path: join(reboundRoot, "f.ts"),
      old_str: "before",
      new_str: "after-rebound",
    });
    assert.equal(await readFile(rebFile, "utf8"), "after-rebound\n");
    // 老树里第一次的改写保留
    assert.equal(await readFile(initFile, "utf8"), "after-initial\n");
  });

  it("(b) within one handler call, resolve and write use the same root snapshot (D2)", async () => {
    const initialRoot = await mkdtemp(join(tmpdir(), "edit-file-d2-initial-"));
    scratchPaths.push(initialRoot);
    const reboundRoot = await mkdtemp(join(tmpdir(), "edit-file-d2-rebound-"));
    scratchPaths.push(reboundRoot);

    const initFile = join(initialRoot, "g.ts");
    const rebFile = join(reboundRoot, "g.ts");
    await writeFile(initFile, "snapshotted\n", "utf8");
    await writeFile(rebFile, "snapshotted\n", "utf8");

    const cell: LiveTaskRoot = createLiveTaskRoot(initialRoot);
    const tool = createEditFileTool(cell);

    // 钩 cell.read：第一次 read 之后立即翻 cell；handler 必须只读一次并
    // 把结果钉在局部变量上复用（D2 per-call 快照）。
    const origRead = cell.read;
    let reads = 0;
    cell.read = () => {
      reads += 1;
      const v = origRead.call(cell);
      if (reads === 1) {
        writeLiveTaskRoot(cell, reboundRoot);
      }
      return v;
    };

    await tool.handler({
      path: join(initialRoot, "g.ts"),
      old_str: "snapshotted",
      new_str: "rewritten",
    });

    // handler 必须只读 cell 一次（D2 per-call 快照）
    assert.equal(reads, 1, "handler must snapshot cell.read() exactly once");
    // 改写必须落在 initialRoot（snapshot 时的值），不是 reboundRoot
    assert.equal(await readFile(initFile, "utf8"), "rewritten\n");
    assert.equal(await readFile(rebFile, "utf8"), "snapshotted\n");
  });

  it("(c) factory accepts LiveTaskRoot and a string is byte-identical to today", async () => {
    const root = scratch;
    const stringTool = createEditFileTool(root);
    const cellTool = createEditFileTool(createLiveTaskRoot(root));

    // 同一棵树内同一个文件 —— 两条路径同文件，output 文案应逐字节一致。
    const file = join(scratch, "byte.ts");
    await writeFile(file, "X", "utf8");

    const r1 = (await stringTool.handler({
      path: file,
      old_str: "X",
      new_str: "Y",
    })) as { output: string };
    await writeFile(file, "X", "utf8"); // reset for cell tool
    const r2 = (await cellTool.handler({
      path: file,
      old_str: "X",
      new_str: "Y",
    })) as { output: string };

    assert.equal(r1.output, r2.output);
    assert.ok(r1.output.startsWith("[edit_file] replaced 1 occurrence(s) in "));
  });
});
