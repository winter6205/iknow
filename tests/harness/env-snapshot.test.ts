/**
 * Environment live snapshot (cwd + git summary + diff preview):
 *
 *   - Pure constructor `parseEnvSnapshot`: no IO, no randomness; takes git /
 *     diff string output → EnvSnapshot(branch / status / dirtyCount / diffPreview).
 *   - `truncateByCodepoints`: counts Unicode codepoints (not UTF-16 code
 *     units, not bytes); over the cap appends a `[truncated N chars]` marker
 *     (final length still ≤ cap + marker length).
 *   - IO reader `readEnvSnapshot`: `exec` injected via DI, defaults to git in
 *     node child processes, never throws — unresolvable cwd / git unavailable
 *     / timeout → all git fields null, cwd kept.
 *
 * Same shape as `agent-status.ts`: pure computation and IO reader split;
 * failure states collapse into null fields and never throw into a model turn.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  parseEnvSnapshot,
  readEnvSnapshot,
  truncateByCodepoints,
  MAX_ENV_DIFF_CHARS,
} from "../../src/harness/env-snapshot.ts";

// ---------------------------------------------------------------------------
// parseEnvSnapshot — pure function
// ---------------------------------------------------------------------------

describe("parseEnvSnapshot", () => {
  it("git porcelain v1 解析:branch + untracked/modified 计数", () => {
    const gitStdout = [
      "## main", // branch line
      " M src/harness/agent-status.ts", // modified (unstaged)
      " M src/harness/loop-engine.ts", // modified (unstaged)
      "?? tests/harness/env-snapshot.test.ts", // untracked
      "?? plans/653-horizon-pkg1-perception.md", // untracked
    ].join("\n");
    const diffStdout = [
      "diff --git a/src/harness/agent-status.ts b/src/harness/agent-status.ts",
      "--- a/src/harness/agent-status.ts",
      "+++ b/src/harness/agent-status.ts",
      "@@ -1,3 +1,3 @@",
      "-old line",
      "+new line",
    ].join("\n");

    const snap = parseEnvSnapshot({
      cwd: "/repo",
      gitStdout,
      diffStdout,
    });
    assert.equal(snap.cwd, "/repo");
    assert.equal(snap.gitBranch, "main");
    // 2 modified + 2 untracked = 4 dirty lines
    assert.equal(snap.dirtyCount, 4);
    assert.equal(snap.degradeReason, null);
    // status text is kept line-by-line for human-readable diagnostics
    assert.ok(snap.gitStatus !== null);
    assert.ok(snap.gitStatus!.includes("M src/harness/agent-status.ts"));
    assert.ok(
      snap.gitStatus!.includes("?? tests/harness/env-snapshot.test.ts")
    );
    // diffPreview passes raw text through; truncation is the caller's job via maxDiffChars
    assert.equal(snap.diffPreview, diffStdout);
  });

  it("非 git 仓库:fatal: not a git repository → git 字段全部 null,cwd 仍在", () => {
    const snap = parseEnvSnapshot({
      cwd: "/tmp/scratch",
      gitStdout:
        "fatal: not a git repository (or any of the parent directories): .git\n",
      diffStdout: "",
    });
    assert.equal(snap.cwd, "/tmp/scratch");
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.gitStatus, null);
    assert.equal(snap.dirtyCount, null);
    assert.equal(snap.diffPreview, null);
    assert.equal(snap.degradeReason, "not_a_git_repo");
  });

  it("空 stdout(空仓库 / 全部 --porcelain 输出空)→ 全 null 字段,cwd 仍在", () => {
    const snap = parseEnvSnapshot({
      cwd: "/repo",
      gitStdout: "",
      diffStdout: "",
    });
    assert.equal(snap.cwd, "/repo");
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.gitStatus, null);
    assert.equal(snap.dirtyCount, 0, "empty porcelain → 0 dirty (clean tree)");
    assert.equal(snap.diffPreview, null);
    assert.equal(snap.degradeReason, null);
  });

  it("branch 行缺失(stripped / corrupt) → branch = null,但 dirty 仍可计", () => {
    const gitStdout = " M foo.ts\n?? bar.ts\n";
    const snap = parseEnvSnapshot({ cwd: "/r", gitStdout, diffStdout: "" });
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.dirtyCount, 2);
  });
});

// ---------------------------------------------------------------------------
// truncateByCodepoints — truncation + marker
// ---------------------------------------------------------------------------

describe("truncateByCodepoints", () => {
  it("恰好 2000 codepoints → 不截,marker 不附加", () => {
    const s = "a".repeat(MAX_ENV_DIFF_CHARS);
    const out = truncateByCodepoints(s, MAX_ENV_DIFF_CHARS);
    assert.equal(out, s, "exactly at limit must not be truncated");
    assert.ok(!out.includes("[truncated"));
  });

  it("2001 codepoints → 截断 + marker, 总长 ≤ 上限", () => {
    const s = "a".repeat(MAX_ENV_DIFF_CHARS + 1);
    const out = truncateByCodepoints(s, MAX_ENV_DIFF_CHARS);
    // Hard contract: body + marker must stay strictly within cap (overflow boundary).
    assert.ok(
      Array.from(out).length <= MAX_ENV_DIFF_CHARS,
      `total ${Array.from(out).length} > cap ${MAX_ENV_DIFF_CHARS}`
    );
    // Marker reports the actual dropped count (bodyCap = cap - marker budget;
    // dropped = total codepoints - bodyCap).
    assert.ok(out.endsWith(`[truncated 23 chars]`));
  });

  it("unicode 多字节字符:按 codepoint 计数(Array.from length),不是 UTF-16 长度", () => {
    // '你' is U+4F60: JS .length = 1 (BMP only); '𝕏' (U+1D54F) is astral: .length = 2 (surrogate pair)
    const emoji = "\u{1D54F}"; // 1 codepoint, 2 UTF-16 code units
    const s = emoji.repeat(MAX_ENV_DIFF_CHARS + 1);
    assert.equal(
      s.length,
      (MAX_ENV_DIFF_CHARS + 1) * 2,
      "sanity: UTF-16 length is doubled"
    );
    assert.equal(
      Array.from(s).length,
      MAX_ENV_DIFF_CHARS + 1,
      "sanity: codepoint count is single"
    );
    const out = truncateByCodepoints(s, MAX_ENV_DIFF_CHARS);
    // Hard contract: body + marker ≤ cap; the marker eats into the body budget.
    assert.ok(
      Array.from(out).length <= MAX_ENV_DIFF_CHARS,
      `total ${Array.from(out).length} > cap ${MAX_ENV_DIFF_CHARS}`
    );
    assert.ok(out.endsWith("[truncated 23 chars]"));
  });

  it("空字符串 → 原样返回", () => {
    assert.equal(truncateByCodepoints("", MAX_ENV_DIFF_CHARS), "");
    assert.equal(truncateByCodepoints("", 0), "");
  });

  it("短字符串(< max) → 原样返回", () => {
    const s = "short diff";
    assert.equal(truncateByCodepoints(s, MAX_ENV_DIFF_CHARS), s);
  });
});

// ---------------------------------------------------------------------------
// readEnvSnapshot — IO reader (DI exec), never throws
// ---------------------------------------------------------------------------

interface ExecStub {
  readonly exec: (
    cmd: string,
    args: readonly string[],
    cwd: string
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  /** Call log, to assert git only runs on paths that should reach it (default exec). */
  readonly calls: ReadonlyArray<{
    readonly cmd: string;
    readonly args: readonly string[];
  }>;
}

function makeExecStub(
  impl: (
    cmd: string,
    args: readonly string[]
  ) => Promise<{ stdout: string; stderr: string }>
): ExecStub {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const exec = async (
    cmd: string,
    args: readonly string[],
    _cwd: string
  ): Promise<{ stdout: string; stderr: string }> => {
    calls.push({ cmd, args });
    return impl(cmd, args);
  };
  return { exec, calls };
}

describe("readEnvSnapshot (DI exec)", () => {
  it("正常:git status + diff 输出 → branch / dirtyCount / diffPreview 投影", async () => {
    const statusOut = "## feature/x\n M src/foo.ts\n?? new-file.ts\n";
    const diffOut = "diff --git a/src/foo.ts b/src/foo.ts\n-old\n+new\n";
    const stub = makeExecStub(async (cmd, args) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: statusOut, stderr: "" };
      }
      // prod passes `["--no-pager", "diff", "--no-color"]` — match by subcommand
      // token rather than by position so the test does not over-specify git argv.
      if (cmd === "git" && args.includes("diff")) {
        return { stdout: diffOut, stderr: "" };
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    });

    const snap = await readEnvSnapshot({ cwd: "/repo", exec: stub.exec });
    assert.equal(snap.cwd, "/repo");
    assert.equal(snap.gitBranch, "feature/x");
    assert.equal(snap.dirtyCount, 2);
    assert.ok(snap.diffPreview !== null);
    assert.ok(snap.diffPreview!.includes("diff --git a/src/foo.ts"));
    // status and diff each called once; full argv pinned (guards against a
    // `-z` regression: NUL-separated output collapses to one line, branch
    // parsing picks up a trailing NUL and dirtyCount stays 0).
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(stub.calls[0]!.args, ["status", "--porcelain=v1", "-b"]);
    // diff must carry `--no-pager` + `--no-color` with subcommand = "diff".
    assert.ok(stub.calls[1]!.args.includes("diff"));
    assert.ok(stub.calls[1]!.args.includes("--no-pager"));
    assert.ok(stub.calls[1]!.args.includes("--no-color"));
    assert.ok(!stub.calls[1]!.args.includes("-z"));
  });

  it("ENOENT:exec 抛错 → 不 throw,git 字段全 null,cwd 保留", async () => {
    const stub = makeExecStub(async () => {
      // Simulate a missing git binary: child_process.spawn rejects asynchronously with ENOENT
      const err: NodeJS.ErrnoException = new Error(
        "spawn git ENOENT"
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const snap = await readEnvSnapshot({ cwd: "/work", exec: stub.exec });
    assert.equal(snap.cwd, "/work", "cwd preserved even when git missing");
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.gitStatus, null);
    assert.equal(snap.dirtyCount, null);
    assert.equal(snap.diffPreview, null);
    assert.equal(snap.degradeReason, "git_unavailable");
  });

  it("超时:exec stub throw → 不 throw,git 字段全 null", async () => {
    const stub = makeExecStub(async () => {
      throw new Error("exec timed out after 5000ms");
    });
    const snap = await readEnvSnapshot({ cwd: "/work", exec: stub.exec });
    assert.equal(snap.cwd, "/work");
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.gitStatus, null);
    assert.equal(snap.dirtyCount, null);
    assert.equal(snap.diffPreview, null);
    assert.equal(snap.degradeReason, "git_unavailable");
  });

  it("IO 路径非 git:fatal 进 reject message → degradeReason=not_a_git_repo", async () => {
    const stub = makeExecStub(async () => {
      throw new Error(
        "git status --porcelain=v1 -b exited 128: fatal: not a git repository (or any of the parent directories): .git"
      );
    });
    const snap = await readEnvSnapshot({ cwd: "/scratch", exec: stub.exec });
    assert.equal(snap.degradeReason, "not_a_git_repo");
    assert.equal(snap.gitBranch, null);
  });

  it("空 cwd → degradeReason=cwd_unavailable,不调用 exec", async () => {
    let calls = 0;
    const stub = makeExecStub(async () => {
      calls += 1;
      throw new Error("should not be called");
    });
    const snap = await readEnvSnapshot({ cwd: "  ", exec: stub.exec });
    assert.equal(snap.degradeReason, "cwd_unavailable");
    assert.equal(snap.cwd, "");
    assert.equal(calls, 0);
  });

  it("超长 diff(> MAX_ENV_DIFF_CHARS codepoints)→ truncate + marker 长度受控", async () => {
    // 3000 codepoints (mixed BMP + astral); diff output must shrink to ≤ cap + marker.
    const longLine = "啊".repeat(MAX_ENV_DIFF_CHARS + 1000);
    const stub = makeExecStub(async (cmd, args) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "## main\n M src/big.ts\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("diff")) {
        return { stdout: longLine, stderr: "" };
      }
      throw new Error(`unexpected call: ${cmd} ${args.join(" ")}`);
    });
    const snap = await readEnvSnapshot({ cwd: "/repo", exec: stub.exec });
    assert.ok(snap.diffPreview !== null);
    const preview = snap.diffPreview!;
    // Marker reports the dropped count (dropped = total codepoints - bodyCap,
    // where bodyCap = cap - marker budget).
    assert.ok(
      preview.endsWith("[truncated 1022 chars]"),
      `expected marker; got tail: ${JSON.stringify(preview.slice(-40))}`
    );
    // Hard contract: truncated output = body + marker ≤ cap.
    assert.ok(
      Array.from(preview).length <= MAX_ENV_DIFF_CHARS,
      `total ${Array.from(preview).length} > cap ${MAX_ENV_DIFF_CHARS}`
    );
    const body = preview.split("[truncated")[0]!;
    assert.ok(Array.from(body).length <= MAX_ENV_DIFF_CHARS);
  });

  it("自定义 maxDiffChars → 用自定义上限截断", async () => {
    const stub = makeExecStub(async (cmd, args) => {
      if (cmd === "git" && args[0] === "status") {
        return { stdout: "## main\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("diff")) {
        return { stdout: "x".repeat(500), stderr: "" };
      }
      throw new Error(`unexpected call`);
    });
    const snap = await readEnvSnapshot({
      cwd: "/repo",
      exec: stub.exec,
      maxDiffChars: 100,
    });
    assert.ok(snap.diffPreview !== null);
    const preview = snap.diffPreview!;
    assert.ok(preview.endsWith("[truncated 421 chars]"));
    // Hard contract: body + marker ≤ cap = 100.
    assert.ok(
      Array.from(preview).length <= 100,
      `total ${Array.from(preview).length} > cap 100`
    );
    const body = preview.split("[truncated")[0]!;
    assert.ok(Array.from(body).length <= 100);
  });
});
