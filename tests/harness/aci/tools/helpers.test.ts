import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  lintPatch,
  resolveWithinRoot,
  spawnWithStopSignal,
  truncateByCodePoint,
} from "../../../../src/harness/aci/tools/helpers.ts";
import { waitForPidFile, waitForProcessExit } from "./spawn-test-utils.ts";

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

describe("resolveWithinRoot", () => {
  it("resolves an existing file inside the real workspace root", async () => {
    const root = await makeScratch("aci-helper-root-");
    const file = join(root, "src", "index.ts");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "export {};\n");

    assert.equal(await resolveWithinRoot(root, "src/index.ts"), file);
  });

  it("resolves a missing write target through its existing parent chain", async () => {
    const root = await makeScratch("aci-helper-root-");
    await mkdir(join(root, "existing"));

    assert.equal(
      await resolveWithinRoot(root, "existing/new/deep/file.ts"),
      join(root, "existing", "new", "deep", "file.ts")
    );
  });

  it("rejects an absolute path outside the workspace", async () => {
    const root = await makeScratch("aci-helper-root-");
    const outside = await makeScratch("aci-helper-outside-");

    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts")),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("rejects a relative parent traversal outside the workspace", async () => {
    const parent = await makeScratch("aci-helper-parent-");
    const root = join(parent, "root");
    await mkdir(root);

    await assert.rejects(
      resolveWithinRoot(root, "../outside.ts"),
      ToolExecutionError
    );
  });

  it("rejects a symlink whose real target is outside the workspace", async () => {
    const root = await makeScratch("aci-helper-root-");
    const outside = await makeScratch("aci-helper-outside-");
    await symlink(outside, join(root, "escape"), "dir");

    await assert.rejects(
      resolveWithinRoot(root, "escape/file.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});

describe("truncateByCodePoint", () => {
  it("truncates ASCII by character count", () => {
    assert.equal(truncateByCodePoint("abcdef", 3), "abc");
  });

  it("returns the empty string unchanged", () => {
    assert.equal(truncateByCodePoint("", 4), "");
  });

  it("does not truncate at the exact boundary", () => {
    assert.equal(truncateByCodePoint("abcd", 4), "abcd");
  });

  it("never returns half of a surrogate pair", () => {
    assert.equal(truncateByCodePoint("😀😀x", 1), "😀");
    assert.deepEqual(Array.from(truncateByCodePoint("a😀b", 2)), ["a", "😀"]);
  });

  it("rejects a negative maximum", () => {
    assert.throws(() => truncateByCodePoint("abc", -1), RangeError);
  });
});

describe("spawnWithStopSignal", () => {
  it("aborts a detached shell process group including its background child", async () => {
    const root = await makeScratch("aci-helper-process-");
    const pidFile = join(root, "child.pid");
    const controller = new AbortController();
    const { child, done } = spawnWithStopSignal(
      "sh",
      ["-c", `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`],
      { cwd: root, signal: controller.signal, killGraceMs: 50 }
    );

    const childPid = await waitForPidFile(pidFile);
    assert.ok(child.pid);
    assert.doesNotThrow(() => process.kill(childPid, 0));

    controller.abort();
    const result = await done;

    assert.notEqual(result.code, 0);
    await waitForProcessExit(childPid);
  }, 5_000);

  it("escalates from SIGTERM to SIGKILL after the configurable grace period", async () => {
    // 触发 SIGTERM 前必须等 sh 装好 `trap '' TERM`,否则在 spawn→exec 的
    // 启动窗口里,SIGTERM 会先于 trap 装入命中 sh,导致 close 报 SIGTERM(issue #199)。
    // sh 在 trap 后才写自己的 pid 到 marker,waitForPidFile 充当确定性屏障。
    const root = await makeScratch("aci-helper-escalate-");
    const trapReadyFile = join(root, "trap-ready");
    const controller = new AbortController();
    const { child, done } = spawnWithStopSignal(
      "sh",
      [
        "-c",
        `trap '' TERM; echo $$ > ${JSON.stringify(trapReadyFile)}; while :; do sleep 1; done`,
      ],
      { cwd: root, signal: controller.signal, killGraceMs: 25 }
    );
    const pid = child.pid;
    assert.ok(pid);

    await waitForPidFile(trapReadyFile);
    controller.abort();
    const result = await done;

    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGKILL");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  }, 5_000);

  it("collects stdout, stderr, and a normal exit code", async () => {
    const { done } = spawnWithStopSignal(
      "sh",
      ["-c", "printf out; printf err >&2; exit 7"],
      { cwd: tmpdir() }
    );

    assert.deepEqual(await done, {
      code: 7,
      signal: null,
      stdout: "out",
      stderr: "err",
    });
  });
});

describe("lintPatch", () => {
  // 以下断言从 tools-mutating.test.ts（已删）迁移而来——lintPatch 从
  // 旧工具文件迁到 helpers.ts（T4），写入类工具单元覆盖由 edit-file.test.ts /
  // bash.test.ts 承接，本组断言保留 lintPatch 单元覆盖（状态机正确性 +
  // Windows 路径字面量）。
  it("accepts balanced parentheses / brackets / braces", () => {
    assert.deepEqual(lintPatch("foo(bar) [baz] {qux}"), { ok: true });
  });

  it("rejects unmatched ')' (more close than open)", () => {
    const r = lintPatch("foo(bar))");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("'"));
  });

  it("rejects unmatched ']' at end", () => {
    const r = lintPatch("foo([bar]");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unmatched"));
  });

  it("rejects unclosed '{' at end of patch", () => {
    const r = lintPatch("function f() { return 1");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unclosed"));
  });

  it("rejects mismatched pair (')' for '[')", () => {
    const r = lintPatch("[1, 2)");
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("expected"));
  });

  it("rejects unclosed double quote", () => {
    const r = lintPatch(`const x = "hello`);
    assert.equal(r.ok, false);
  });

  it("accepts escaped quotes (\\\" / \\' do not break pairing)", () => {
    // 字符串字面量 "a \\\" b" 内部带 \" 转义,不影响配对
    assert.deepEqual(lintPatch(`"a \\\" b"`), { ok: true });
    assert.deepEqual(lintPatch(`'a \\\' b'`), { ok: true });
  });

  it("accepts balanced single quotes", () => {
    assert.deepEqual(lintPatch(`'hello' + "world"`), { ok: true });
  });

  it("accepts empty string", () => {
    assert.deepEqual(lintPatch(""), { ok: true });
  });

  it('accepts `"it\'s a test"` (双引号字符串内的单引号 = 字面量)', () => {
    const r = lintPatch(`"it's a test"`);
    assert.deepEqual(r, { ok: true });
  });

  it('accepts `"C:\\\\Users\\\\x"` (Windows 路径字面量,含 `\\\\` 转义)', () => {
    const r = lintPatch(`"C:\\Users\\x"`);
    assert.deepEqual(r, { ok: true });
  });

  it("accepts nested string: `\"outer 'inner' outer\"`", () => {
    const r = lintPatch(`"outer 'inner' outer"`);
    assert.deepEqual(r, { ok: true });
  });

  it('accepts `"a\\\\b"` (\\\\ 视为字面量反斜杠,不误闭合)', () => {
    const r = lintPatch(`"a\\b"`);
    assert.deepEqual(r, { ok: true });
  });

  it("rejects unclosed single quote", () => {
    const r = lintPatch(`'unclosed`);
    assert.equal(r.ok, false);
    assert.ok(r.reason?.includes("unclosed"));
  });

  it('rejects genuinely mismatched `"a"b` (单引号后无配对)', () => {
    const r = lintPatch(`"a"b'`);
    assert.equal(r.ok, false);
  });

  it("rejects when `\\\\` at end of string leaves trailing backslash", () => {
    const r = lintPatch(`"abc\\`);
    assert.equal(r.ok, false);
  });
});
