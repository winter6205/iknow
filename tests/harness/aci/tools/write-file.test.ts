import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createWriteFileTool } from "../../../../src/harness/aci/tools/write-file.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

async function doesNotExist(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("createWriteFileTool — schema and metadata", () => {
  it("exposes the write_file schema with the documented defaults", async () => {
    const root = await makeScratch("write-file-shape-");
    const tool = createWriteFileTool(root);
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, Record<string, unknown>>;
      required: string[];
      additionalProperties: boolean;
    };

    assert.equal(tool.name, "write_file");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["path", "content"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.path.type, "string");
    assert.equal(schema.properties.content.type, "string");
    assert.equal(schema.properties.create_directories.type, "boolean");
    assert.equal(schema.properties.create_directories.default, true);
  });

  it("uses the write metadata and blocking interrupt contract", async () => {
    const root = await makeScratch("write-file-shape-");
    const tool = createWriteFileTool(root);

    assert.deepEqual(tool.aci, {
      category: "write",
      isConcurrencySafe: false,
      interruptBehavior: "block",
      timeoutTier: "default",
    });
  });
});

describe("write_file — successful writes", () => {
  it("creates a new file and returns a stable relative-path confirmation", async () => {
    const root = await makeScratch("write-file-create-");
    const content = "const answer = 42;\n";
    const tool = createWriteFileTool(root);

    const result = (await tool.handler({
      path: "new.ts",
      content,
    })) as { output: string; meta: { oldContent: string; newContent: string } };

    assert.equal(
      result.output,
      `[write_file] wrote ${Buffer.byteLength(content, "utf8")} bytes to new.ts`
    );
    assert.equal(await readFile(join(root, "new.ts"), "utf8"), content);
  });

  it("envelope meta.newContent === params.content; meta.oldContent === '' when file did not exist", async () => {
    const root = await makeScratch("write-file-envelope-");
    const content = "const answer = 42;\n";
    const tool = createWriteFileTool(root);

    const result = (await tool.handler({
      path: "new.ts",
      content,
    })) as { output: string; meta: { oldContent: string; newContent: string } };

    assert.equal(result.meta.newContent, content);
    assert.equal(result.meta.oldContent, "");
    // output 是纯文案,不含 meta JSON(oldContent / newContent 不进 model 面)。
    assert.ok(!result.output.includes("oldContent"));
    assert.ok(!result.output.includes("newContent"));
  });

  it("envelope meta.oldContent = pre-write full content when file already exists", async () => {
    const root = await makeScratch("write-file-overwrite-meta-");
    const file = join(root, "existing.txt");
    const oldContent = "old contents\n";
    await writeFile(file, oldContent, "utf8");
    const tool = createWriteFileTool(root);
    const newContent = "new contents\n";

    const result = (await tool.handler({
      path: "existing.txt",
      content: newContent,
    })) as { output: string; meta: { oldContent: string; newContent: string } };

    assert.equal(result.meta.oldContent, oldContent);
    assert.equal(result.meta.newContent, newContent);
    assert.equal(await readFile(file, "utf8"), newContent);
  });

  it("creates missing parent directories by default", async () => {
    const root = await makeScratch("write-file-mkdir-");
    const file = join(root, "one", "two", "three.txt");
    const tool = createWriteFileTool(root);

    await tool.handler({ path: "one/two/three.txt", content: "deep\n" });

    assert.equal(await readFile(file, "utf8"), "deep\n");
  });

  it("overwrites the complete contents of an existing file", async () => {
    const root = await makeScratch("write-file-overwrite-");
    const file = join(root, "existing.txt");
    await writeFile(file, "old contents\n", "utf8");
    const tool = createWriteFileTool(root);

    await tool.handler({ path: "existing.txt", content: "new contents\n" });

    assert.equal(await readFile(file, "utf8"), "new contents\n");
  });
});

describe("write_file — rejection and containment", () => {
  it("rejects when create_directories=false and the parent is missing without creating a file", async () => {
    const root = await makeScratch("write-file-no-mkdir-");
    const file = join(root, "missing", "parent", "file.txt");
    const tool = createWriteFileTool(root);

    await assert.rejects(
      () =>
        tool.handler({
          path: "missing/parent/file.txt",
          content: "content\n",
          create_directories: false,
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.message.includes("parent")
    );
    assert.equal(await doesNotExist(file), true);
    assert.equal(await doesNotExist(join(root, "missing")), true);
  });

  it("rejects a symlink target outside root before writing outside the workspace", async () => {
    const root = await makeScratch("write-file-symlink-root-");
    const outside = await makeScratch("write-file-symlink-outside-");
    await symlink(outside, join(root, "escape"), "dir");
    const outsideFile = join(outside, "created.txt");
    const tool = createWriteFileTool(root);

    await assert.rejects(
      () => tool.handler({ path: "escape/created.txt", content: "nope\n" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
    assert.equal(await doesNotExist(outsideFile), true);
  });
});

describe("write_file — no patch-level lint (W4: whole-file content written verbatim)", () => {
  it("accepts content with balanced braces/brackets and unclosed chars inside comments and strings", async () => {
    // 整文件写入不需要 patch 级 lint;只有 edit_file 才走 lintPatch
    // 这里含合法代码片段(平衡括号)+ 注释/字符串里看似不闭合的字符(实为字面量)
    const root = await makeScratch("write-file-allow-");
    const file = join(root, "ok.ts");
    const content = [
      "function f() {",
      "  // TODO: refine { still inside comment",
      "  const arr = [1, 2, 3];",
      "  const s = 'unclosed would-be quote inside literal';",
      "  return arr;",
      "}",
      "",
    ].join("\n");
    const tool = createWriteFileTool(root);

    await tool.handler({ path: "ok.ts", content });
    assert.equal(await readFile(file, "utf8"), content);
  });

  it("accepts content with unclosed-looking bracket inside a string literal", async () => {
    const root = await makeScratch("write-file-string-");
    const file = join(root, "str.ts");
    const content = 'const x = "this } looks unbalanced";\n';
    const tool = createWriteFileTool(root);

    await tool.handler({ path: "str.ts", content });
    assert.equal(await readFile(file, "utf8"), content);
  });

  it("does not emit 'lint rejected' messages for legitimate whole-file content", async () => {
    // 整文件通过 - 不抛 ToolExecutionError
    const root = await makeScratch("write-file-no-lint-");
    const tool = createWriteFileTool(root);

    await assert.doesNotReject(
      () =>
        tool.handler({
          path: "x.ts",
          content: "if (true) {\n  console.log('hi');\n}\n",
        }),
      ToolExecutionError
    );
  });
});

describe("write_file — handler input validation", () => {
  it("throws ToolExecutionError for missing required fields and unknown fields", async () => {
    const root = await makeScratch("write-file-input-");
    const tool = createWriteFileTool(root);

    await assert.rejects(
      () => tool.handler({ path: "x.txt" }),
      ToolExecutionError
    );
    await assert.rejects(
      () =>
        tool.handler({
          path: "x.txt",
          content: "ok\n",
          extra: true,
        }),
      ToolExecutionError
    );
  });
});
