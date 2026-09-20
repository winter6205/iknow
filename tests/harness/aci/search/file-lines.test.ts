/**
 * File-admission unit tests on the search side (the fs boundary shared by
 * the `also` line window and context lines).
 *
 * Invariant locked: **both engines' accept sets come from one admission
 * line**. The rg engine doesn't decide binary-ness itself (its 64 KiB window
 * gives different verdicts for the same file across `-l` / `--count` /
 * content output modes), and the Node scan doesn't either — both go through
 * `readWorkspaceLines` / `isTextFile`. So "files containing NUL are not
 * searchable" is defined exactly once here; loosening it on one side shows
 * up in these cases.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import {
  admittedPaths,
  containsNul,
  isTextFile,
  MAX_EXPLICIT_FILE_BYTES,
  MAX_TEXT_FILE_BYTES,
  readWorkspaceLines,
  splitLines,
} from "../../../../src/harness/aci/search/file-lines.ts";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "file-lines-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

/** Write a file under `root` (parent dirs created automatically). */
async function put(root: string, rel: string, data: string | Buffer) {
  const abs = join(root, rel);
  await mkdir(join(abs, ".."), { recursive: true });
  await writeFile(abs, data);
}

describe("containsNul — 整文件判据（不做 8 KiB 窗口截断）", () => {
  it("无 NUL → false", () => {
    assert.equal(containsNul(Buffer.from("plain text\n")), false);
  });

  it("NUL 在早期 / 窗口之外 / 末尾 都算二进制", () => {
    const nul = Buffer.from([0]);
    assert.equal(containsNul(Buffer.concat([Buffer.from("a"), nul])), true);
    // Far beyond the 8 KiB window: the old windowed implementation missed
    // these (same trap applies to rg's 64 KiB window).
    assert.equal(
      containsNul(
        Buffer.concat([Buffer.from("a"), Buffer.alloc(70_000, 0x61), nul])
      ),
      true
    );
    assert.equal(
      containsNul(Buffer.concat([Buffer.alloc(70_000, 0x61), nul])),
      true
    );
  });

  it("UTF-16 文本含 NUL → 判二进制（rg 的 NUL 扫描会漏掉这类）", () => {
    assert.equal(containsNul(Buffer.from("hit\n", "utf16le")), true);
  });

  it("多字节字符的字节序列不被误判（只有真正的 0x00 才算）", () => {
    assert.equal(containsNul(Buffer.from("héllo 漢 😀\n", "utf8")), false);
  });
});

describe("readWorkspaceLines — 行切分与准入", () => {
  it("按 \\n 切行，CRLF 的 \\r 剥掉，末行无换行也算一行", async () => {
    const root = await scratch();
    await put(root, "a.ts", "one\r\ntwo\nthree");

    assert.deepEqual(await readWorkspaceLines(root, "a.ts"), [
      "one",
      "two",
      "three",
    ]);
  });

  it("空文件 → 空数组（不是 null；它不是「不可读」）", async () => {
    const root = await scratch();
    await put(root, "empty.ts", "");

    assert.deepEqual(await readWorkspaceLines(root, "empty.ts"), []);
  });

  it("不存在 / 目录 / 含 NUL → null", async () => {
    const root = await scratch();
    await put(root, "dir/keep.ts", "x\n");
    await put(
      root,
      "bin.ts",
      Buffer.concat([Buffer.from("hit\n"), Buffer.from([0])])
    );

    assert.equal(await readWorkspaceLines(root, "missing.ts"), null);
    assert.equal(await readWorkspaceLines(root, "dir"), null);
    assert.equal(await readWorkspaceLines(root, "bin.ts"), null);
  });

  it("超过 MAX_TEXT_FILE_BYTES → null（遍历期的体积闸）", async () => {
    const root = await scratch();
    await put(root, "big.ts", "x".repeat(MAX_TEXT_FILE_BYTES + 1));

    assert.equal(await readWorkspaceLines(root, "big.ts"), null);
  });

  it("显式文件豁免：allowOversize 时按 MAX_EXPLICIT_FILE_BYTES 放行", async () => {
    const root = await scratch();
    // 1 MiB + 1: recursive walk refuses, explicitly named file reads
    // (rg's --max-filesize only governs the traversal phase).
    await put(root, "big.ts", "x".repeat(MAX_TEXT_FILE_BYTES + 1));

    const lines = await readWorkspaceLines(root, "big.ts", {
      allowOversize: true,
    });
    assert.notEqual(lines, null);
    assert.equal(lines!.length, 1);
  });

  it("显式文件豁免有上界：超过 MAX_EXPLICIT_FILE_BYTES 一律拒读（两条引擎同界）", async () => {
    const root = await scratch();
    await put(root, "huge.ts", "x".repeat(MAX_EXPLICIT_FILE_BYTES + 1));

    assert.equal(await readWorkspaceLines(root, "huge.ts"), null);
    assert.equal(
      await readWorkspaceLines(root, "huge.ts", { allowOversize: true }),
      null
    );
  });

  it("豁免不放宽二进制口径：超限文件含 NUL 仍是 null", async () => {
    const root = await scratch();
    await put(
      root,
      "bigbin.ts",
      Buffer.concat([
        Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61),
        Buffer.from([0]),
      ])
    );

    assert.equal(
      await readWorkspaceLines(root, "bigbin.ts", { allowOversize: true }),
      null
    );
  });

  it("显式上限严大于遍历上限（豁免是放宽体积，不是取消体积）", () => {
    assert.ok(MAX_EXPLICIT_FILE_BYTES > MAX_TEXT_FILE_BYTES);
  });
});

describe("isTextFile — 准入布尔（与 readWorkspaceLines 同源）", () => {
  it("文本 true / 含 NUL false / 不存在 false", async () => {
    const root = await scratch();
    await put(root, "ok.ts", "hit\n");
    await put(
      root,
      "bin.ts",
      Buffer.concat([Buffer.from("hit\n"), Buffer.from([0])])
    );

    assert.equal(await isTextFile(root, "ok.ts"), true);
    assert.equal(await isTextFile(root, "bin.ts"), false);
    assert.equal(await isTextFile(root, "missing.ts"), false);
  });

  it("超限文件默认 false，allowOversize 时 true（与 readWorkspaceLines 一致）", async () => {
    const root = await scratch();
    await put(root, "big.ts", "x".repeat(MAX_TEXT_FILE_BYTES + 1));

    assert.equal(await isTextFile(root, "big.ts"), false);
    assert.equal(
      await isTextFile(root, "big.ts", { allowOversize: true }),
      true
    );
  });
});

describe("admittedPaths — 批量准入（rg 引擎的复核面）", () => {
  it("只回通过的那些，顺序与去重后输入一致", async () => {
    const root = await scratch();
    await put(root, "a.ts", "hit\n");
    await put(root, "b.ts", "hit\n");
    await put(
      root,
      "bin.ts",
      Buffer.concat([Buffer.from("hit\n"), Buffer.from([0])])
    );

    const admitted = await admittedPaths(root, [
      "a.ts",
      "bin.ts",
      "b.ts",
      "a.ts",
    ]);
    assert.deepEqual([...admitted], ["a.ts", "b.ts"]);
  });

  it("空输入 → 空集合（不产生任何 fs 访问）", async () => {
    assert.equal((await admittedPaths("/nonexistent-root", [])).size, 0);
  });

  it("超过并发路数（64）仍全部复核，不漏不重", async () => {
    const root = await scratch();
    const total = 70;
    for (let i = 0; i < total; i += 1) {
      await put(root, `f${String(i)}.ts`, "hit\n");
    }
    // Every 10th file gets a NUL: still removed across concurrency batch boundaries.
    for (let i = 0; i < total; i += 10) {
      await put(
        root,
        `f${String(i)}.ts`,
        Buffer.concat([Buffer.from("hit\n"), Buffer.from([0])])
      );
    }

    const paths = Array.from({ length: total }, (_, i) => `f${String(i)}.ts`);
    const admitted = await admittedPaths(root, paths);
    assert.equal(admitted.size, total - total / 10);
    for (let i = 0; i < total; i += 10) {
      assert.equal(admitted.has(`f${String(i)}.ts`), false, `f${String(i)}`);
    }
  });
});

describe("splitLines — 纯切行", () => {
  it("末行无换行也算一行；空 buffer → 空数组", () => {
    assert.deepEqual(splitLines(Buffer.from("a\nb")), ["a", "b"]);
    assert.deepEqual(splitLines(Buffer.from("")), []);
    assert.deepEqual(splitLines(Buffer.from("a\n")), ["a"]);
  });
});
