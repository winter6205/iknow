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
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../../../src/harness/session-roots.ts";
import type { LiveTaskRoot } from "../../../../src/harness/session-roots.ts";

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
    // output is plain text, no meta JSON (oldContent / newContent never reach the model face).
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

describe("write_file — SC4/SC5 可写合同 (specs/mutate-write-contract.md)", () => {
  it("SC4: 写 /tmp 绝对路径仍拒——文案含活 taskRoot 路径与「/tmp 非交付落点」说明", async () => {
    // The bash fence permits /tmp (process temp face), but durable writes land
    // only in taskRoot. The failure message must spell out both facts: the
    // current write root = live taskRoot (path included) and /tmp is not a
    // delivery destination — so the model retries with a relative path instead
    // of writing deliverables into /tmp.
    const root = await makeScratch("write-file-sc4-");
    const tool = createWriteFileTool(root);

    await assert.rejects(
      () =>
        tool.handler({
          path: "/tmp/write-file-sc4-not-a-delivery.txt",
          content: "nope\n",
        }),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        return (
          error.message.includes("path outside workspace") &&
          error.message.includes("current write root") &&
          error.message.includes(root) &&
          error.message.includes("taskRoot") &&
          error.message.includes("not a delivery destination") &&
          error.message.includes("/tmp")
        );
      }
    );
  });

  it("SC5: 相对活 taskRoot 的合法路径（含尚未存在的子目录）可完成写入", async () => {
    // A missing target parent dir ≠ outside; create_directories defaults to creating dirs before writing.
    const root = await makeScratch("write-file-sc5-missing-subdir-");
    const cell: LiveTaskRoot = createLiveTaskRoot(root);
    const tool = createWriteFileTool(cell);

    await tool.handler({ path: "new/deep/dir/file.txt", content: "ok\n" });

    assert.equal(
      await readFile(join(root, "new", "deep", "dir", "file.txt"), "utf8"),
      "ok\n"
    );
  });

  it("SC5: create_directories=false 时缺父目录是 typed「parent directory does not exist」，不是 outside", async () => {
    // An actionable error must stay distinguishable from a containment rejection — the message must not contain "outside".
    const root = await makeScratch("write-file-sc5-nodir-");
    const tool = createWriteFileTool(root);

    await assert.rejects(
      () =>
        tool.handler({
          path: "missing/parent/file.txt",
          content: "x\n",
          create_directories: false,
        }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("parent directory does not exist") &&
        !error.message.includes("outside workspace")
    );
  });

  it("表 B overflow: 极深相对路径仍在 taskRoot 下——写入成功，不报 outside", async () => {
    // Overflow on the tool face: prefix adjudication applies along the whole chain, so a very deep legal path must not blow up as "outside".
    const root = await makeScratch("write-file-sc5-deep-");
    const tool = createWriteFileTool(root);
    const deepRel =
      Array.from({ length: 30 }, (_, i) => `d${i}`).join("/") + "/leaf.txt";

    await tool.handler({ path: deepRel, content: "deep\n" });

    assert.equal(await readFile(join(root, deepRel), "utf8"), "deep\n");
  });
});

describe("write_file — no patch-level lint (W4: whole-file content written verbatim)", () => {
  it("accepts content with balanced braces/brackets and unclosed chars inside comments and strings", async () => {
    // Whole-file writes need no patch-level lint; only edit_file goes through lintPatch.
    // The content below mixes legitimate code (balanced brackets) with chars inside
    // comments/strings that look unclosed but are literals.
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
    // The whole file passes — no ToolExecutionError thrown.
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

describe("createWriteFileTool — live taskRoot (T5)", () => {
  // write_file, like edit_file, resolves the root **at handler call time**
  // (no more assembly-time root frozen in a closure). While the cell never
  // flips, behavior stays byte-identical to the string-root form; these cases
  // cover:
  //   (a) LiveTaskRoot param + a flipped cell → the second call lands on the new root;
  //   (b) within one handler call, resolve and write use the same root value
  //       (per-call single read; cell.read() is called once at handler entry);
  //   (c) the string param behaves byte-identically to today (already covered
  //       by existing tests; here we pin the coexistence of both factory forms).
  it("(a) handler reads root at call time — rebind mid-lifecycle writes to new root", async () => {
    const initialRoot = await makeScratch("write-file-live-initial-");
    const reboundRoot = await makeScratch("write-file-live-rebound-");
    const cell: LiveTaskRoot = createLiveTaskRoot(initialRoot);
    const tool = createWriteFileTool(cell);

    // First call: writes into initialRoot
    await tool.handler({ path: "first.ts", content: "first\n" });
    assert.equal(
      await readFile(join(initialRoot, "first.ts"), "utf8"),
      "first\n"
    );
    assert.equal(await doesNotExist(join(reboundRoot, "first.ts")), true);

    // rebind — simulates the cell flipping after the host seam resolves successfully
    writeLiveTaskRoot(cell, reboundRoot);

    // Second call: writes into reboundRoot
    await tool.handler({ path: "second.ts", content: "second\n" });
    assert.equal(
      await readFile(join(reboundRoot, "second.ts"), "utf8"),
      "second\n"
    );
    assert.equal(await doesNotExist(join(initialRoot, "second.ts")), true);
    // The first write is still in the old tree, not moved
    assert.equal(
      await readFile(join(initialRoot, "first.ts"), "utf8"),
      "first\n"
    );
  });

  it("(b) within one handler call, resolve and write use the same root snapshot (D2)", async () => {
    // Within one handler call, resolve and write must use the same root value
    // (never resolve against the new root while writing to the old one). The
    // cell here flips mid-flight: the handler must snapshot the root first and
    // resolve with that snapshot; a flip during the handler must still land
    // writes in the originally resolved root.
    const initialRoot = await makeScratch("write-file-d2-initial-");
    const reboundRoot = await makeScratch("write-file-d2-rebound-");
    const cell: LiveTaskRoot = createLiveTaskRoot(initialRoot);
    const tool = createWriteFileTool(cell);

    // Hook cell.read: flip the cell right after the first read; any later read
    // inside the handler would see reboundRoot — so the handler must pin the
    // first read's result in a local and reuse it.
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

    await tool.handler({ path: "d2.ts", content: "snapshotted\n" });

    // The handler must read the cell exactly once (per-call snapshot)
    assert.equal(reads, 1, "handler must snapshot cell.read() exactly once");
    // The write must land in initialRoot (the snapshotted value), not reboundRoot
    assert.equal(
      await readFile(join(initialRoot, "d2.ts"), "utf8"),
      "snapshotted\n"
    );
    assert.equal(await doesNotExist(join(reboundRoot, "d2.ts")), true);
  });

  it("(c) factory accepts LiveTaskRoot and a string is byte-identical to today", async () => {
    // While the cell never flips, the assembly-time root = `sandboxRoot` is the
    // cell's initial value; passing a plain string and wrapping the same
    // literal in a LiveTaskRoot behave byte-identically.
    const root = await makeScratch("write-file-byte-");
    const stringTool = createWriteFileTool(root);
    const cellTool = createWriteFileTool(createLiveTaskRoot(root));

    const r1 = (await stringTool.handler({
      path: "a.ts",
      content: "X",
    })) as { output: string };
    const r2 = (await cellTool.handler({
      path: "a.ts",
      content: "X",
    })) as { output: string };

    assert.equal(r1.output, r2.output);
    // byte-for-byte: path rendering and byte count both identical
    assert.ok(r1.output.startsWith("[write_file] wrote 1 bytes to "));
  });
});
