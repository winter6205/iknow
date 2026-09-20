/**
 * Unit tests for the read_file tool.
 *
 * Contract covered (ADR-0004 as amended by ADR-0084 D1c + ADR-0006 Decision 4):
 *   - factory signature = createReadFileTool(root): AciToolDef, name === "read_file"
 *   - inputSchema: path required + offset? (0-based) + limit? (**no default value**, explicit cap 2000) + additionalProperties:false
 *   - behavior: resolve+containment (symlink escape rejected) → stat (must be a file, directory → error) → >1MB rejected → NUL binary rejected
 *     → window: no `limit` = read from offset to EOF (page budget 16000 code points; a page stop emits a continuation hint);
 *       explicit `limit` hard-capped at 2000 (excess truncated to 2000); an offset past the end yields a continuation/page-stop receipt, not an empty string
 *   - output: each line `${String(lineNo).padStart(6)}\t${line}`, line numbers start at 1 (first line after offset = offset+1)
 *   - aci metadata: category=read-only, isReadOnly=true, isConcurrencySafe=true, interruptBehavior=cancel
 *   - all errors throw ToolExecutionError
 *   - purely stateless: the factory closure must not hold state across calls
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
    assert.equal(schema.properties.limit.minimum, 1);
    assert.equal(schema.properties.limit.maximum, 2000);
    // Without limit = read to EOF, so the schema **must not** carry a default line count
    // (ADR-0004's old "default 200 lines" was amended by ADR-0084 D1c).
    assert.equal(
      Object.hasOwn(schema.properties.limit, "default"),
      false,
      "limit 不得有 default —— 缺省语义是整读到 EOF，不是任何默认行数"
    );
  });

  it("aci metadata matches the read-only contract", async () => {
    const root = await makeScratch("read-file-shape-");
    const tool = createReadFileTool(root);

    assert.equal(tool.aci.category, "read-only");
    assert.equal(tool.aci.isConcurrencySafe, true);
    assert.equal(tool.aci.interruptBehavior, "cancel");
  });

  it("不带输出闸豁免声明（ADR-0083 只对 skill 内建落值）", async () => {
    // read_file output still passes the executor fallback cap: the >1MB rejection +
    // offset/limit window is its precision path, and an exemption would remove the
    // premise of the "re-call with a more precise input" recovery route.
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

  it("不传 limit → 整读到 EOF，不是任何默认行数（SC13 / D1c）", async () => {
    const root = await makeScratch("read-file-paging-");
    const lines = Array.from({ length: 250 }, (_, i) => `n${i}`).join("\n");
    await writeFile(join(root, "p.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "p.txt" })) as string;
    const resultLines = result.split("\n");

    // all 250 lines returned, no continuation hint — neither cut to 200 (old default) nor to 2000.
    assert.equal(resultLines.length, 250);
    assert.equal(resultLines[0], "     1\tn0");
    assert.equal(resultLines[249], "   250\tn249");
    assert.ok(
      !result.includes("continued at line"),
      "整读到 EOF 时不得出现续读提示"
    );
  });

  it("不传 limit 且超过整页预算 → 正文停在 16000 code point 以内，尾部带续读 offset", async () => {
    const root = await makeScratch("read-file-paging-");
    // 100 chars per line + 7-char line-number prefix ≈ 108 cp per line; 2000 lines is far over 16000.
    const line = "x".repeat(100);
    const lines = Array.from({ length: 2000 }, () => line).join("\n");
    await writeFile(join(root, "big.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "big.txt" })) as string;
    const hintIndex = result.indexOf("\n[read_file] continued at line ");
    assert.ok(hintIndex > 0, `期望续读提示，实际尾部: ${result.slice(-120)}`);

    const body = result.slice(0, hintIndex);
    // body (excluding the hint line) ≤ 16000 code points.
    assert.ok(
      Array.from(body).length <= 16000,
      `正文超预算: ${Array.from(body).length}`
    );
    // not at EOF: the hint carries the file name and total line count.
    assert.match(
      result.slice(hintIndex),
      /of 2000; call read_file again with offset=\d+/
    );
  });

  it("单行超页预算：正文显式标注截断，不冒充干净 EOF（ADR-0006 D4 无静默截断）", async () => {
    const root = await makeScratch("read-file-longline-");
    // one line of 20000 chars + line-number prefix → over the 16000 page budget, entering the whole-line truncation branch.
    await writeFile(join(root, "long.txt"), "x".repeat(20000) + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "long.txt" })) as string;

    // truncation must be explicit: the body carries a "line truncated, remainder unreachable via offset paging" marker.
    assert.ok(
      result.includes("[read_file] line 1 truncated at the page budget"),
      `期望单行截断标记，实际尾部: ${result.slice(-160)}`
    );
    assert.ok(
      result.includes("not reachable via offset paging"),
      "标记必须说清 offset 按行翻页、行内余下部分取不到"
    );
    // the body's first line (incl. line-number prefix) stays within the 16000-code-point page budget.
    const body = result.split("\n")[0]!;
    assert.ok(
      Array.from(body).length <= 16000,
      `正文超预算: ${Array.from(body).length}`
    );
    // a single-line file has no "following lines" → no continuation hint (there is no offset to continue to).
    assert.ok(!result.includes("continued at line"));
  });

  it("单行超页预算且有后续行：截断标记与续读提示同时在场", async () => {
    const root = await makeScratch("read-file-longline-more-");
    await writeFile(
      join(root, "long-then.txt"),
      "y".repeat(20000) + "\ntail-line\n"
    );

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "long-then.txt" })) as string;

    assert.ok(result.includes("truncated at the page budget"));
    // following lines remain → the continuation hint points offset at line 2.
    assert.match(
      result.slice(result.indexOf("truncated at the page budget")),
      /\[read_file\] continued at line 2 of 2; call read_file again with offset=1/
    );
    // continuing at the hinted offset really yields the full content after the truncated line.
    const rest = (await tool.handler({
      path: "long-then.txt",
      offset: 1,
    })) as string;
    assert.equal(rest, "     2\ttail-line");
  });

  it("astral 字符页：UTF-16 长度低于 executor 20000 闸，不发生二次截断", async () => {
    const root = await makeScratch("read-file-astral-");
    // 30000 astral code points = 60000 UTF-16 units; counting only by code point
    // would yield a ~32000-char page, double-truncated by the executor fallback cap (forbidden by ADR-0006 D4).
    await writeFile(join(root, "astral.txt"), "😀".repeat(30_000) + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({ path: "astral.txt" })) as string;

    assert.ok(
      result.length < 20000,
      `序列化页不得触达 executor 20000 闸，实际 ${result.length} 单元`
    );
    assert.ok(result.includes("truncated at the page budget"));
  });

  it("显式 limit 的行窗硬顶 2000 行：空白行（渲染后 7 字符，页预算容得下 2000 行）整窗取满", async () => {
    const root = await makeScratch("read-file-paging-");
    // A blank line renders to exactly 7 chars (6-digit line number + tab), the only line
    // width that fits 2000 lines in the 16000-cp budget — it lets us verify the "window cap"
    // and the "page budget" gates separately: here the window tops out first,
    // and the budget must not shrink the window below 2000 lines.
    await writeFile(join(root, "blank-lines.txt"), "\n".repeat(2500));

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "blank-lines.txt",
      limit: 9999,
    })) as string;
    const resultLines = result.split("\n");

    assert.equal(resultLines.length, 2000);
    assert.equal(resultLines[0], "     1\t");
    assert.equal(resultLines[1999], "  2000\t");
    assert.ok(
      !result.includes("continued at line"),
      "窗口内 2000 行全部给到，预算未先触顶 → 不得出现续读提示"
    );
  });

  it("limit:2000 宽行文件：正文受页预算约束，不触达 executor 20000 闸（无双重截断）", async () => {
    const root = await makeScratch("read-file-wide-");
    // 400 chars/line × 2000 lines: the full window without a budget would yield a ~816000-UTF-16-unit page,
    // tail-cut by the executor 20000 cap (double truncation forbidden by ADR-0006 Decision 4).
    const lines = Array.from({ length: 2000 }, () => "x".repeat(400)).join(
      "\n"
    );
    await writeFile(join(root, "wide.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "wide.txt",
      limit: 2000,
    })) as string;

    assert.ok(
      result.length < 20000,
      `显式 limit 页不得触达 executor 20000 闸，实际 ${result.length} 单元`
    );
    assert.ok(
      result.includes("call read_file again with offset="),
      `预算切短行窗时必须给续读指引，实际尾部: ${result.slice(-160)}`
    );
  });

  it("limit:50 宽行文件同样受页预算约束（50 行 × 400 字符已超 20000 闸）", async () => {
    const root = await makeScratch("read-file-wide-small-");
    const lines = Array.from({ length: 50 }, () => "y".repeat(400)).join("\n");
    await writeFile(join(root, "wide50.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "wide50.txt",
      limit: 50,
    })) as string;

    assert.ok(
      result.length < 20000,
      `50 行宽行窗口同样不得触达 executor 闸，实际 ${result.length} 单元`
    );
  });

  it("显式 limit 下首行自身超预算：行内截断标记与窗口续读标记同时在场", async () => {
    const root = await makeScratch("read-file-wide-firstline-");
    await writeFile(
      join(root, "long-first.txt"),
      "y".repeat(20000) + "\ntail-a\ntail-b\n"
    );

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "long-first.txt",
      limit: 3,
    })) as string;

    assert.ok(result.length < 20000, `实际 ${result.length} 单元`);
    assert.ok(
      result.includes("not reachable via offset paging"),
      "首行行内余下部分不可达 → 行内截断标记必须在"
    );
    // the window still has following lines → the window continuation marker points at
    // line 2 (offset=1), and that offset is accepted by the next call (not "past end of file").
    assert.match(result, /call read_file again with offset=1\b/);
    const rest = (await tool.handler({
      path: "long-first.txt",
      offset: 1,
    })) as string;
    assert.equal(rest.split("\n")[0], "     2\ttail-a");
  });

  it("预算（非行数）切短行窗：提示里的 offset 被下一次调用接受并接着读", async () => {
    const root = await makeScratch("read-file-wide-resume-");
    const lines = Array.from({ length: 500 }, () => "z".repeat(400)).join("\n");
    await writeFile(join(root, "resume.txt"), lines + "\n");

    const tool = createReadFileTool(root);
    const result = (await tool.handler({
      path: "resume.txt",
      limit: 500,
    })) as string;

    const match = /call read_file again with offset=(\d+)/.exec(result);
    assert.ok(match, `期望续读提示，实际尾部: ${result.slice(-160)}`);
    const nextOffset = Number(match[1]);

    // The recovery path must really work: re-calling at the hinted offset must not land
    // on "offset past end of file", and the first line number = offset + 1.
    const rest = (await tool.handler({
      path: "resume.txt",
      offset: nextOffset,
    })) as string;
    const firstLineNumber = Number.parseInt(
      rest.split("\n")[0]!.split("\t")[0]!,
      10
    );
    assert.equal(firstLineNumber, nextOffset + 1);
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
