/**
 * read_file 工具（T5）单元测试。
 *
 * 覆盖契约（ADR-0004 L14 + T1-5/T1-7 裁定）：
 *   - 工厂签名 = createReadFileTool(root): AciToolDef，name === "read_file"
 *   - inputSchema: path 必填 + offset? (默认 0, 0 基) + limit? (默认 200, 上限 2000) + additionalProperties:false
 *   - 行为：resolve+containment（symlink 越界拒绝）→ stat (必须文件，目录→报错) → >1MB 拒绝 → NUL 二进制拒绝
 *     → offset/limit 窗口 (limit 上限 2000 截断, offset 越界返回空串)
 *   - 输出：每行 `${String(lineNo).padStart(6)}\t${line}`，行号 1 起 (即 offset 后第一行 = offset+1)
 *   - aci 元数据: category=read-only, isReadOnly=true, isConcurrencySafe=true, interruptBehavior=cancel
 *   - 错误一律 throw ToolExecutionError
 *   - 纯无状态：工厂闭包不得持有跨调用状态
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createReadFileTool } from "../../../../src/harness/aci/tools/read-file.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("createReadFileTool — schema/aci shape", () => {
  it("name === 'read_file'", async () => {
    const root = await makeScratch("read-file-shape-");
    const tool = createReadFileTool(root);
    assert.equal(tool.name, "read_file");
  });

  it("inputSchema enforces path required and additionalProperties:false", async () => {
    const root = await makeScratch("read-file-shape-");
    const tool = createReadFileTool(root);
    const schema = tool.inputSchema as Record<string, unknown>;

    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["path"]);
    assert.equal(schema.additionalProperties, false);
  });

  it("inputSchema exposes integer offset/limit with documented bounds", async () => {
    const root = await makeScratch("read-file-shape-");
    const tool = createReadFileTool(root);
    const schema = tool.inputSchema as {
      properties: Record<
        string,
        { type: string; default?: unknown; minimum?: number; maximum?: number }
      >;
    };

    assert.equal(schema.properties.path.type, "string");
    assert.equal(schema.properties.offset.type, "integer");
    assert.equal(schema.properties.offset.default, 0);
    assert.equal(schema.properties.offset.minimum, 0);
    assert.equal(schema.properties.limit.type, "integer");
    assert.equal(schema.properties.limit.default, 200);
    assert.equal(schema.properties.limit.minimum, 1);
    assert.equal(schema.properties.limit.maximum, 2000);
  });

  it("aci metadata matches the read-only contract", async () => {
    const root = await makeScratch("read-file-shape-");
    const tool = createReadFileTool(root);

    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
  });

  it("不带输出闸豁免声明（ADR-0083 只对 skill 内建落值）", async () => {
    // read_file 输出仍走 executor 兜底闸：>1MB 拒绝 + offset/limit 窗口是它的
    // 精度路径，豁免会去掉「换更精确输入重调」这条恢复路径的前提。
    const root = await makeScratch("read-file-shape-");
    const tool = createReadFileTool(root);

    assert.equal(tool.exemptFromOutputCap, undefined);
  });
});

describe("read_file — happy path", () => {
  it("reads a small multi-line file and applies the line-number format", async () => {
    const root = await makeScratch("read-file-happy-");
    await writeFile(join(root, "lines.txt"), "alpha\nbeta\ngamma\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "lines.txt" })) as string;

    assert.equal(result, "     1\talpha\n     2\tbeta\n     3\tgamma");
  });

  it("the first displayed line number matches offset+1 (0-based offset, 1-based display)", async () => {
    const root = await makeScratch("read-file-happy-");
    const lines = Array.from({ length: 5 }, (_, i) => `row-${i}`).join("\n");
    await writeFile(join(root, "rows.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "rows.txt",
      offset: 2,
    })) as string;

    assert.equal(result, "     3\trow-2\n     4\trow-3\n     5\trow-4");
  });

  it("returns a plain string (not an object)", async () => {
    const root = await makeScratch("read-file-happy-");
    await writeFile(join(root, "solo.txt"), "only-line\n");

    const tool = createReadFileTool(root);
    const result = await tool.handler({ path: "solo.txt" });
    assert.equal(typeof result, "string");
  });

  it("factory is stateless: two independent calls share no cursor", async () => {
    const root = await makeScratch("read-file-happy-");
    await writeFile(join(root, "a.txt"), "a-1\na-2\na-3\n");
    await writeFile(join(root, "b.txt"), "b-1\nb-2\nb-3\n");

    const tool = createReadFileTool(root);
    const first = (await tool.handler({ path: "a.txt" })) as string;
    const second = (await tool.handler({ path: "b.txt" })) as string;

    assert.equal(first, "     1\ta-1\n     2\ta-2\n     3\ta-3");
    assert.equal(second, "     1\tb-1\n     2\tb-2\n     3\tb-3");
  });

  it("two factories over the same root are independent", async () => {
    const root = await makeScratch("read-file-happy-");
    await writeFile(join(root, "x.txt"), "x-1\nx-2\nx-3\n");

    const toolA = createReadFileTool(root);
    const toolB = createReadFileTool(root);
    const a = (await toolA.handler({ path: "x.txt", offset: 1 })) as string;
    const b = (await toolB.handler({ path: "x.txt" })) as string;

    // offset=1 → returns lines[1..] → "x-2","x-3" displayed with line numbers 2,3.
    assert.equal(a, "     2\tx-2\n     3\tx-3");
    assert.equal(b, "     1\tx-1\n     2\tx-2\n     3\tx-3");
  });
});

describe("read_file — offset/limit paging", () => {
  it("limit truncates the window without affecting offset semantics", async () => {
    const root = await makeScratch("read-file-paging-");
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`).join("\n");
    await writeFile(join(root, "p.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "p.txt",
      offset: 2,
      limit: 3,
    })) as string;

    assert.equal(result, "     3\tL2\n     4\tL3\n     5\tL4");
  });

  it("uses limit=200 by default", async () => {
    const root = await makeScratch("read-file-paging-");
    const lines = Array.from({ length: 250 }, (_, i) => `n${i}`).join("\n");
    await writeFile(join(root, "p.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "p.txt" })) as string;
    const resultLines = result.split("\n");

    assert.equal(resultLines.length, 200);
    assert.equal(resultLines[0], "     1\tn0");
    assert.equal(resultLines[199], "   200\tn199");
  });

  it("clamps limit values above 2000 down to 2000", async () => {
    const root = await makeScratch("read-file-paging-");
    const lines = Array.from({ length: 2500 }, (_, i) => `n${i}`).join("\n");
    await writeFile(join(root, "p.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "p.txt",
      limit: 9999,
    })) as string;
    const resultLines = result.split("\n");

    assert.equal(resultLines.length, 2000);
    assert.equal(resultLines[0], "     1\tn0");
    assert.equal(resultLines[1999], "  2000\tn1999");
  });

  it("offset == lines.length throws ToolExecutionError (no silent empty)", async () => {
    const root = await makeScratch("read-file-paging-");
    await writeFile(join(root, "tiny.txt"), "a\nb\n");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "tiny.txt", offset: 2 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message ===
          "[read_file] offset 2 past end of file (2 lines); use a smaller offset"
    );
  });

  it("offset far past end of file throws ToolExecutionError", async () => {
    const root = await makeScratch("read-file-paging-");
    await writeFile(join(root, "tiny.txt"), "a\nb\n");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "tiny.txt", offset: 100 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message ===
          "[read_file] offset 100 past end of file (2 lines); use a smaller offset"
    );
  });

  it("limit=0 throws ToolExecutionError (must be ≥ 1)", async () => {
    const root = await makeScratch("read-file-paging-");
    await writeFile(join(root, "tiny.txt"), "a\nb\n");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "tiny.txt", limit: 0 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === "[read_file] limit must be a positive integer"
    );
  });

  it("limit=-1 throws ToolExecutionError", async () => {
    const root = await makeScratch("read-file-paging-");
    await writeFile(join(root, "tiny.txt"), "a\nb\n");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "tiny.txt", limit: -1 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === "[read_file] limit must be a positive integer"
    );
  });

  it("limit=1.5 throws ToolExecutionError (not an integer)", async () => {
    const root = await makeScratch("read-file-paging-");
    await writeFile(join(root, "tiny.txt"), "a\nb\n");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "tiny.txt", limit: 1.5 }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message === "[read_file] limit must be a positive integer"
    );
  });

  it("empty file returns the [read_file] ok (empty file) marker", async () => {
    const root = await makeScratch("read-file-paging-");
    await writeFile(join(root, "blank.txt"), "");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "blank.txt" })) as string;

    assert.equal(result, "[read_file] ok (empty file)");
  });

  it("empty file with offset/limit still returns the empty-file marker", async () => {
    const root = await makeScratch("read-file-paging-");
    await writeFile(join(root, "blank.txt"), "");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "blank.txt",
      offset: 5,
      limit: 50,
    })) as string;

    assert.equal(result, "[read_file] ok (empty file)");
  });
});

describe("read_file — error paths", () => {
  it("missing file → ToolExecutionError", async () => {
    const root = await makeScratch("read-file-err-");
    const tool = createReadFileTool(root);

    await assert.rejects(
      () => tool.handler({ path: "nope.txt" }),
      (error: unknown) => error instanceof ToolExecutionError
    );
  });

  it("directory path → ToolExecutionError", async () => {
    const root = await makeScratch("read-file-err-");
    await mkdir(join(root, "subdir"));

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "subdir" }),
      (error: unknown) => error instanceof ToolExecutionError
    );
  });

  it("symlink whose real target lies outside root → ToolExecutionError", async () => {
    const root = await makeScratch("read-file-err-");
    const outside = await makeScratch("read-file-outside-");
    await writeFile(join(outside, "secret.txt"), "private\n");
    await symlink(outside, join(root, "escape"), "dir");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "escape/secret.txt" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("parent-traversal path → ToolExecutionError", async () => {
    const root = await makeScratch("read-file-err-");
    const tool = createReadFileTool(root);

    await assert.rejects(
      () => tool.handler({ path: "../etc/passwd" }),
      (error: unknown) => error instanceof ToolExecutionError
    );
  });
});

describe("read_file — size/binary guards", () => {
  it("rejects a file larger than 1MB with the documented guidance message", async () => {
    const root = await makeScratch("read-file-binary-");
    // 1MB + 1 byte (sentinel) so the byte count is > 1_048_576.
    const filler = "a".repeat(1_048_576);
    await writeFile(join(root, "big.txt"), filler + "X");

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "big.txt" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message ===
          "[read_file] file exceeds 1MB limit, locate with grep then read precisely with offset/limit"
    );
  });

  it("accepts a file exactly at 1MB", async () => {
    const root = await makeScratch("read-file-binary-");
    const filler = "a".repeat(1_048_576);
    await writeFile(join(root, "edge.txt"), filler);

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "edge.txt" })) as string;
    const resultLines = result.split("\n");
    // 1MB of "a" with no newline splits into one giant line; padStart(6) + tab + line.
    assert.ok(
      resultLines[0].startsWith("     1\t"),
      `expected line-number prefix, got: ${resultLines[0].slice(0, 12)}`
    );
  });

  it("rejects a binary file containing NUL bytes with the documented message", async () => {
    const root = await makeScratch("read-file-binary-");
    const buffer = Buffer.from("hello world", "utf8");
    await writeFile(join(root, "blob.bin"), buffer);

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "blob.bin" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message ===
          `[read_file] binary file rejected: ${join(root, "blob.bin")}`
    );
  });

  it("rejects a NUL-bearing file whose real size is under 1MB", async () => {
    const root = await makeScratch("read-file-binary-");
    // Ensure NUL detection runs before any size heuristic — keep file tiny.
    const buffer = Buffer.from([0x00, 0x41, 0x42, 0x43]);
    await writeFile(join(root, "tiny.bin"), buffer);

    const tool = createReadFileTool(root);
    await assert.rejects(
      () => tool.handler({ path: "tiny.bin" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.startsWith("[read_file] binary file rejected: ")
    );
  });
});
