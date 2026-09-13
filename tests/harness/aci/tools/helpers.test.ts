import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
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

  it("expands a leading ~ to the home directory (not the workspace)", async () => {
    // W4: `~/foo.ts` 必须解析到 $HOME 而非项目根下的字面 `~` 目录
    const root = await makeScratch("aci-helper-root-");
    const home = homedir();
    const expected = join(home, "foo.ts");
    let resolved: string;
    if (await exists(expected)) {
      // 安全路径:home 下已存在该文件 → 直接断言
      resolved = await resolveWithinRoot(root, "~/foo.ts");
    } else {
      // home 下不存在 → resolveWithinRoot 会因 "outside workspace" 抛出。
      // 我们借此断言:它没有把 `~` 当字面目录建到工作区里(即没解析成
      // <root>/~/<user>/foo.ts),而是把 ~ 展开到了 $HOME。
      await assert.rejects(
        resolveWithinRoot(root, "~/foo.ts"),
        ToolExecutionError
      );
      return;
    }
    assert.equal(resolved, expected);
  });

  it("extraWriteRoots: allows write target inside an extra root", async () => {
    const root = await makeScratch("aci-helper-root-");
    const extra = await makeScratch("aci-helper-extra-");
    await mkdir(join(extra, "sub"));
    const target = join(extra, "sub", "new.ts");

    assert.equal(
      await resolveWithinRoot(root, target, undefined, [extra]),
      target
    );
  });

  it("extraWriteRoots: rejects target outside primary AND extra roots", async () => {
    const root = await makeScratch("aci-helper-root-");
    const extra = await makeScratch("aci-helper-extra-");
    const outside = await makeScratch("aci-helper-outside-");

    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts"), undefined, [extra]),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("extraWriteRoots: rejects a symlink escaping the extra root", async () => {
    const root = await makeScratch("aci-helper-root-");
    const extra = await makeScratch("aci-helper-extra-");
    const outside = await makeScratch("aci-helper-outside-");
    await symlink(outside, join(extra, "escape"), "dir");

    await assert.rejects(
      resolveWithinRoot(root, join(extra, "escape", "file.ts"), undefined, [
        extra,
      ]),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("tmpWriteRoot: an absolute path inside the session tmp host dir is allowed", async () => {
    const root = await makeScratch("aci-helper-tmp-root-");
    const pad = await makeScratch("aci-helper-tmp-pad-");

    assert.equal(
      await resolveWithinRoot(root, join(pad, "ok.txt"), { tmpWriteRoot: pad }),
      join(pad, "ok.txt")
    );
    // 会话 tmp 目录自身也是一个合法的写目标(独立 containment root)。
    assert.equal(
      await resolveWithinRoot(root, pad, { tmpWriteRoot: pad }),
      pad
    );
  });

  it("tmpWriteRoot: a model-supplied guest /tmp/... is typed-rejected (no alias to the pad)", async () => {
    const root = await makeScratch("aci-helper-tmp-neg-root-");
    const pad = await makeScratch("aci-helper-tmp-neg-pad-");

    await assert.rejects(
      resolveWithinRoot(root, "/tmp/ok.txt", { tmpWriteRoot: pad }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
    await assert.rejects(
      resolveWithinRoot(root, "/tmp/", { tmpWriteRoot: pad }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });

  it("tmpWriteRoot: relative path under taskRoot is not remapped", async () => {
    const root = await makeScratch("aci-helper-tmp-rel-root-");
    const pad = await makeScratch("aci-helper-tmp-rel-pad-");
    await writeFile(join(root, "kept.txt"), "in-root\n");

    assert.equal(
      await resolveWithinRoot(root, "kept.txt", { tmpWriteRoot: pad }),
      join(root, "kept.txt")
    );
  });

  it("tmpWriteRoot: /tmp/../ escape leaving guest /tmp still fails containment", async () => {
    const root = await makeScratch("aci-helper-tmp-esc-root-");
    const pad = await makeScratch("aci-helper-tmp-esc-pad-");

    await assert.rejects(
      resolveWithinRoot(root, "/tmp/../etc/passwd", { tmpWriteRoot: pad }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("outside workspace")
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 (plans/891-taskroot-remaining-consumers.md Task 3 / ADR-0037 §4 (e)):
// path-outside 错误文案必须含当前写根，使模型能用相对路径重试。改绑后
// `root` 即活 `taskRoot` (= 写根)，文案必须明示「current write root」以让
// 模型用相对路径重试（现有文字只列「not under <root>」，不带 remap 引导）。
//
// 五类边界自检（empty / negative / overflow / concurrent / exception）：
//   - empty: 文案仍含 root 字符串（不丢信息）；
//   - negative: 相对路径越界（如 `../escape`）同样含 root 字符串；
//   - overflow: 极长 root 完整出现（不被截断）；
//   - concurrent: 多次串行调用，每次文案互不污染；
//   - exception: extraWriteRoots 救不回的越界文案仍含 root 字符串。
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveWithinRoot — T3 path-outside 文案含当前写根 (ADR-0037 §4 (e))", () => {
  it("absolute path outside: 文案含 'current write root: <root>' 引导", async () => {
    const root = await makeScratch("aci-helper-wr-abs-");
    const outside = await makeScratch("aci-helper-wr-out-");
    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts")),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        // 文案必须含写根路径本身 + "current write root" 标识
        // (模型据此用相对路径重试)
        return (
          error.message.includes("current write root") &&
          error.message.includes(root)
        );
      }
    );
  });

  it("relative traversal outside: 文案仍含 'current write root: <root>'", async () => {
    const parent = await makeScratch("aci-helper-wr-rel-");
    const root = join(parent, "root");
    await mkdir(root);
    await assert.rejects(
      resolveWithinRoot(root, "../escape.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root") &&
        error.message.includes(root)
    );
  });

  it("symlink escape: 文案仍含 'current write root: <root>'", async () => {
    const root = await makeScratch("aci-helper-wr-sym-");
    const outside = await makeScratch("aci-helper-wr-sym-out-");
    await symlink(outside, join(root, "escape"), "dir");
    await assert.rejects(
      resolveWithinRoot(root, "escape/file.ts"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root")
    );
  });

  it("overflow: 极长 root 完整出现在文案中（不被 truncate 截断到无意义）", async () => {
    // overflow 验证目标：文案里 root 字符串完整出现（不被截断到无意义）。
    // 将 root 控制在 OS PATH_MAX 之内,但构造一条足够长的真实目录链
    // （30 层 * 8 字符 = 240 字符的有效路径长度，足以验证"不被截断"语义）。
    const realRoot = await makeScratch("aci-helper-wr-overflow-");
    const longTail = Array.from({ length: 30 }, () => "abcdefgh").join("/");
    const longRoot = join(realRoot, longTail);
    await mkdir(longRoot, { recursive: true });
    const outside = await makeScratch("aci-helper-wr-overflow-out-");
    let captured = "";
    await assert.rejects(
      resolveWithinRoot(longRoot, join(outside, "file.ts")),
      (error: unknown) => {
        if (!(error instanceof ToolExecutionError)) return false;
        captured = error.message;
        return true;
      }
    );
    // 文案必须显式含 'current write root' 标识 + 含 longTail 的尾部（证明
    // 极长 root 没被截断）。
    assert.ok(
      captured.includes("current write root"),
      "极长 root 路径必须含 'current write root' 标识"
    );
    assert.ok(
      captured.includes(longTail),
      "极长 root 路径必须含完整 longTail（不被截断）"
    );
  });

  it("concurrent / 重复调用: 每次文案独立且含 root 字符串", async () => {
    const root = await makeScratch("aci-helper-wr-conc-");
    const outside1 = await makeScratch("aci-helper-wr-conc-1-");
    const outside2 = await makeScratch("aci-helper-wr-conc-2-");
    // 串行两次,各自文案必须含同一 root。
    for (const outside of [outside1, outside2]) {
      await assert.rejects(
        resolveWithinRoot(root, join(outside, "file.ts")),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          error.message.includes("current write root") &&
          error.message.includes(root)
      );
    }
  });

  it("exception / extraWriteRoots 救不回: 文案仍含 'current write root: <root>'", async () => {
    const root = await makeScratch("aci-helper-wr-exw-");
    const extra = await makeScratch("aci-helper-wr-exw-extra-");
    const outside = await makeScratch("aci-helper-wr-exw-out-");
    await assert.rejects(
      resolveWithinRoot(root, join(outside, "file.ts"), undefined, [extra]),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("current write root") &&
        error.message.includes(root)
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

  it("forwards an explicit env to the child so host secrets don't leak (env leak fix, #225)", async () => {
    const root = await makeScratch("aci-helper-env-");
    const { done } = spawnWithStopSignal(
      "sh",
      [
        "-c",
        'test -z "$HOST_SECRET" && echo "secret-absent" && echo "explicit=$EXPLICIT"',
      ],
      { cwd: root, env: { PATH: process.env.PATH ?? "", EXPLICIT: "yes" } }
    );

    const result = await done;
    assert.equal(result.code, 0);
    assert.match(result.stdout, /secret-absent/);
    assert.match(result.stdout, /explicit=yes/);
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
