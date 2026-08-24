/**
 * #653 G1 / 包1-感知 T4 — 环境现势快照（cwd + git 摘要 + diff 要点）:
 *
 *   - 纯构造器 `parseEnvSnapshot`:无 IO、无随机依赖,接收 git / diff 的
 *     字符串输出 → EnvSnapshot(branch / status / dirtyCount / diffPreview)。
 *   - 截断工具 `truncateByCodepoints`:按 Unicode codepoint 计数(不是
 *     UTF-16 code unit 也不是字节),超过上限追加 `[truncated N chars]`
 *     标记(末尾仍 ≤ 上限 + marker 长度)。
 *   - IO 读取器 `readEnvSnapshot`:DI 注入 `exec`,默认走 node 子进程
 *     跑 git,永不 throw — cwd 不可解析 / git 不可用 / 超时 → git 字段全
 *     null、cwd 保留。
 *
 * 与 `agent-status.ts` 同形:纯计算 + IO 读取器分列,失败态收敛为 null
 * 字段,绝不抛进模型回合。
 *
 * spec: specs/653-horizon-pkg1-perception.md §"环境现势";plan:
 * plans/653-horizon-pkg1-perception.md T4。
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
// parseEnvSnapshot — 纯函数
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
    // 2 modified + 2 untracked = 4 dirty 行
    assert.equal(snap.dirtyCount, 4);
    // status 文本保留逐行(便于人读面诊断)
    assert.ok(snap.gitStatus !== null);
    assert.ok(snap.gitStatus!.includes("M src/harness/agent-status.ts"));
    assert.ok(
      snap.gitStatus!.includes("?? tests/harness/env-snapshot.test.ts")
    );
    // diffPreview 透传原文本(截断由调用层按 maxDiffChars 控制)
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
  });

  it("branch 行缺失(stripped / corrupt) → branch = null,但 dirty 仍可计", () => {
    const gitStdout = " M foo.ts\n?? bar.ts\n";
    const snap = parseEnvSnapshot({ cwd: "/r", gitStdout, diffStdout: "" });
    assert.equal(snap.gitBranch, null);
    assert.equal(snap.dirtyCount, 2);
  });
});

// ---------------------------------------------------------------------------
// truncateByCodepoints — 截断 + marker
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
    // SPEC SC 字面:总长 = 主体 + marker 严格 ≤ cap (overflow 边界)。
    assert.ok(
      Array.from(out).length <= MAX_ENV_DIFF_CHARS,
      `total ${Array.from(out).length} > cap ${MAX_ENV_DIFF_CHARS}`
    );
    // marker 报告主体实际丢弃数 (主体上限 = cap - marker预算,丢弃数 =
    // codepoint 总数 - bodyCap)。
    assert.ok(out.endsWith(`[truncated 23 chars]`));
  });

  it("unicode 多字节字符:按 codepoint 计数(Array.from length),不是 UTF-16 长度", () => {
    // 汉字 '你' 是 U+4F60,JS .length = 1 (单 BMP),Array.from(s).length = 1
    // emoji '𝕏' (U+1D54F) 是 astral plane,JS .length = 2 (UTF-16 surrogate pair)
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
    // SPEC SC 字面:总长 = 主体 + marker 严格 ≤ cap。marker 计入预算后
    // 主体短于 cap,但总长 ≤ cap。
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
// readEnvSnapshot — IO 读取器(DI exec),永不 throw
// ---------------------------------------------------------------------------

interface ExecStub {
  readonly exec: (
    cmd: string,
    args: readonly string[],
    cwd: string
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  /** 记录调用次数,断言只在应该跑 git 的路径里跑(默认 exec)。 */
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
    // git status 与 diff 各被调用一次;完整 argv 钉死(spec 防 `-z` 与解析器
    // 不匹配的回归,因 `-z` 让 NUL 分隔的整段变成单行,branch 解析会带尾部
    // NUL、dirtyCount 恒 0)。
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(stub.calls[0]!.args, ["status", "--porcelain=v1", "-b"]);
    // diff 必须带 `--no-pager` + `--no-color`,且 subcommand = "diff"。
    assert.ok(stub.calls[1]!.args.includes("diff"));
    assert.ok(stub.calls[1]!.args.includes("--no-pager"));
    assert.ok(stub.calls[1]!.args.includes("--no-color"));
    assert.ok(!stub.calls[1]!.args.includes("-z"));
  });

  it("ENOENT:exec 抛错 → 不 throw,git 字段全 null,cwd 保留", async () => {
    const stub = makeExecStub(async () => {
      // 模拟 git 二进制缺失:Node child_process.spawn 在 ENOENT 时异步 reject
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
  });

  it("超长 diff(> MAX_ENV_DIFF_CHARS codepoints)→ truncate + marker 长度受控", async () => {
    // 生成 3000 个 codepoint(混 BMP + astral),diff 输出应当被截到 ≤ 上限 + marker。
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
    // marker 报告被丢掉的字符数 (主体实际丢弃 = codepoints.total - bodyCap,
    // 其中 bodyCap = cap - marker预算)。
    assert.ok(
      preview.endsWith("[truncated 1022 chars]"),
      `expected marker; got tail: ${JSON.stringify(preview.slice(-40))}`
    );
    // SPEC SC 字面:截断后整段输出 = 主体 + marker ≤ cap。
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
    // SPEC SC 字面:总长 = 主体 + marker ≤ cap = 100。
    assert.ok(
      Array.from(preview).length <= 100,
      `total ${Array.from(preview).length} > cap 100`
    );
    const body = preview.split("[truncated")[0]!;
    assert.ok(Array.from(body).length <= 100);
  });
});
