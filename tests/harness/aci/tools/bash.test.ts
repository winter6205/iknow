import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import { createBashTool } from "../../../../src/harness/aci/tools/bash.ts";
import { createSecretRegistry } from "../../../../src/harness/secret-roundtrip/index.ts";
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

describe("createBashTool — schema and metadata", () => {
  it("exposes only the required command input without a model-facing timeout", async () => {
    const cwd = await makeScratch("bash-schema-");
    const tool = createBashTool(cwd);
    const schema = tool.inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required: string[];
      additionalProperties: boolean;
    };

    assert.equal(tool.name, "bash");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.properties, { command: { type: "string" } });
    assert.deepEqual(schema.required, ["command"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal("timeout" in schema.properties, false);
    assert.deepEqual(tool.aci, {
      category: "execute",
      isConcurrencySafe: false,
      interruptBehavior: "cancel",
      timeoutTier: "build",
    });
  });
});

describe("bash — execution", () => {
  it("returns the structured code/stdout/stderr result for a successful command", async () => {
    const cwd = await makeScratch("bash-success-");
    const result = await runBash(cwd, "echo hello");

    assert.deepEqual(result, { code: 0, stdout: "hello\n", stderr: "" });
  });

  it("returns a non-zero exit code as data rather than throwing", async () => {
    const cwd = await makeScratch("bash-nonzero-");
    const result = await runBash(cwd, "git definitely-not-a-command");

    assert.notEqual(result.code, 0);
    assert.equal(typeof result.stdout, "string");
    assert.equal(typeof result.stderr, "string");
  });

  it("captures stderr separately", async () => {
    const cwd = await makeScratch("bash-stderr-");
    const result = await runBash(cwd, "cat missing-file.txt");

    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /missing-file\.txt/);
  });

  it("runs with the factory cwd", async () => {
    const cwd = await makeScratch("bash-cwd-");
    const result = await runBash(cwd, "pwd");

    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), cwd);
  });
});

describe("bash — permission gates", () => {
  it("no longer rejects non-allowlist commands at handler level (ask flow + bwrap)", async () => {
    // 白名单降级为 ask：handler 不再拦截非白名单命令，执行期边界由 bwrap 承担。
    const cwd = await makeScratch("bash-allowlist-");
    const result = await runBash(cwd, "sh -c true");
    assert.equal(result.code, 0);
  });

  it("rejects a dangerous command through the blacklist defense", async () => {
    const cwd = await makeScratch("bash-dangerous-");
    const tool = createBashTool(cwd);

    await assert.rejects(
      tool.handler({ command: "echo rm -rf /" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("bash: dangerous command rejected")
    );
  });
});

describe("bash — output limits", () => {
  it("truncates stdout to 12000 characters", async () => {
    const cwd = await makeScratch("bash-truncate-");
    await writeFile(join(cwd, "long.txt"), "x".repeat(12_001));

    const result = await runBash(cwd, "cat long.txt");

    assert.equal(result.stdout.length, 12_000);
    assert.equal(result.stdout, "x".repeat(12_000));
  });

  it("truncates by code point without splitting an emoji surrogate pair", async () => {
    const cwd = await makeScratch("bash-codepoint-");
    await writeFile(join(cwd, "unicode.txt"), `${"x".repeat(11_999)}😀tail`);

    const result = await runBash(cwd, "cat unicode.txt");

    assert.equal(Array.from(result.stdout).length, 12_000);
    assert.equal(result.stdout.endsWith("😀"), true);
    assert.equal(result.stdout.includes("�"), false);
  });
});

describe("bash — cancellation", () => {
  it("kills the detached command process tree when the execution signal aborts", async () => {
    const cwd = await makeScratch("bash-cancel-");
    const pidFile = join(cwd, "child.pid");
    await writeFile(
      join(cwd, "tree.cjs"),
      [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const child = spawn("sleep", ["30"], { stdio: "ignore" });',
        'writeFileSync("child.pid", String(child.pid));',
        'child.once("exit", () => process.exit(0));',
        "setInterval(() => {}, 1000);",
      ].join("\n")
    );
    const controller = new AbortController();
    const tool = createBashTool(cwd);
    const execution = tool.handler(
      { command: "node tree.cjs" },
      { signal: controller.signal }
    );
    const childPid = await waitForPidFile(pidFile);
    assert.doesNotThrow(() => process.kill(childPid, 0));

    controller.abort();
    await execution;

    await waitForProcessExit(childPid);
  }, 5_000);
});

interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runBash(cwd: string, command: string): Promise<BashResult> {
  const tool = createBashTool(cwd);
  return (await tool.handler({ command })) as BashResult;
}

// ---------------------------------------------------------------------------
// #406 T3: bash 占位符还原层（restore 在 spawn 前执行）
// ---------------------------------------------------------------------------
// bwrap 0.11.1 在本测试环境可用（既有 execution describe 已真实 spawn）。
// A1:registry 注册 sk- 真值后，命令含 <<<SECRET_1>>> → 还原后 spawn → stdout 含真值。
// A2:命令含未注册 <<<SECRET_MISSING>>> → 原样传给 bash 不抛错，bash 把字面
//    当命令名回显到 stderr（command not found）→ stderr 含字面（graceful）。
describe("#406 T3 — bash 占位符还原层", () => {
  it("A1：注册值还原 —— stdout 不含占位符（restore 命中）", async () => {
    const cwd = await makeScratch("bash-restore-");
    const registry = createSecretRegistry();
    registry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = (await tool.handler({
      command: 'echo "<<<SECRET_1>>>"',
    })) as BashResult;

    // 注：M1 输出遮罩在 restore 后跑，stdout 此时已是 ***（掩盖真值）。
    // 本用例 assert restore 命中（占位符消失 + 真值被 mask 替代），不
    // 重复 M1 的语义。
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes("<<<SECRET_1>>>"),
      false,
      `stdout 不应再含占位符（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(
      result.stdout.includes("sk-aaaaaaaaaaaaaaaaaaaa"),
      false,
      `stdout 不应含原 secret 值（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(result.stdout, "***\n");
  });

  it("A1：多占位符命令完整还原后执行", async () => {
    const cwd = await makeScratch("bash-restore-multi-");
    const registry = createSecretRegistry();
    registry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    registry.register("AKIA1234567890ABCDEF");
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = (await tool.handler({
      command: 'echo "<<<SECRET_1>>> <<<SECRET_2>>>"',
    })) as BashResult;

    // 同上：restore 命中后被 mask 遮成 *** ***；本用例仅 assert 两个
    // 占位符都已被还原（stdout 不含占位符字面）。
    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes("<<<SECRET_1>>>") ||
        result.stdout.includes("<<<SECRET_2>>>"),
      false,
      `stdout 不应含任何占位符（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(result.stdout.includes("sk-aaaaaaaaaaaaaaaaaaaa"), false);
    assert.equal(result.stdout.includes("AKIA1234567890ABCDEF"), false);
    assert.equal(result.stdout, "*** ***\n");
  });

  it("A2：未注册占位符原样透传 bash，不抛错（graceful degradation）", async () => {
    const cwd = await makeScratch("bash-restore-missing-");
    const registry = createSecretRegistry();
    const tool = createBashTool(cwd, { secretRegistry: registry });

    // 引号内占位符保证 bash 不把它当 here-string 重定向；restore 只还原已注册
    // 占位符，未注册的 <<<SECRET_MISSING>>> 原样进入 bash 并输出到 stdout。
    const result = (await tool.handler({
      command: 'echo "<<<SECRET_MISSING>>>"',
    })) as BashResult;

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout,
      "<<<SECRET_MISSING>>>\n",
      `未注册占位符应原样透传（实际=${JSON.stringify(result.stdout)}）`
    );
  });

  it("A2：空 registry 命令不还原，原样透传", async () => {
    const cwd = await makeScratch("bash-restore-empty-");
    const tool = createBashTool(cwd, {
      secretRegistry: createSecretRegistry(),
    });

    const result = (await tool.handler({
      command: "echo keep",
    })) as BashResult;

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
  });
});

// ---------------------------------------------------------------------------
// #406 T3: bash 输出遮罩（output mask 接入 handler return 前）
// ---------------------------------------------------------------------------
// 约束：
//   - mask 构造在 handler 内每次现取（registry 值可跨 turn 变化；不模块级缓存）
//   - 缺席 secretRegistry → 不 mask、不 crash
//   - 形状不变：恰 {code, stdout, stderr} 三字段
//   - registry 在场但空 → mask identity，输出原样
describe("#406 T3 — bash 输出遮罩（output-mask on stdout/stderr）", () => {
  it("M1：registry 在场 + 命令经占位符还原路径 → stdout 真值被遮罩为 ***", async () => {
    const cwd = await makeScratch("bash-mask-stdout-");
    const registry = createSecretRegistry();
    const secret = "sk-live-超密值-aaaaaaaaaaaa";
    registry.register(secret);
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = (await tool.handler({
      command: 'echo "<<<SECRET_1>>>"',
    })) as BashResult;

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes(secret),
      false,
      `stdout 不应含原 secret 值（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(
      result.stdout.includes("***"),
      true,
      `stdout 应含遮罩符 ***（实际=${JSON.stringify(result.stdout)}）`
    );
  });

  it("M1：registry 在场 + stderr 真值同样被遮罩", async () => {
    const cwd = await makeScratch("bash-mask-stderr-");
    const registry = createSecretRegistry();
    const secret = "AKIA1234567890ABCDEF-leak";
    registry.register(secret);
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = (await tool.handler({
      command: `printf '%s' "<<<SECRET_1>>>" >&2; exit 0`,
    })) as BashResult;

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.includes(secret),
      false,
      `stderr 不应含原 secret 值（实际=${JSON.stringify(result.stderr)}）`
    );
    assert.equal(
      result.stderr.includes("***"),
      true,
      `stderr 应含遮罩符 ***（实际=${JSON.stringify(result.stderr)}）`
    );
  });

  it("M2：缺席 secretRegistry → 输出原样、不 crash", async () => {
    const cwd = await makeScratch("bash-mask-absent-");
    const tool = createBashTool(cwd); // 不传 secretRegistry
    const secret = "sk-live-超密值-no-mask";

    const result = (await tool.handler({
      command: `echo "${secret}"`,
    })) as BashResult;

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes(secret),
      true,
      `缺席 registry 时 stdout 应原样含真值（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(result.stdout.includes("***"), false);
  });

  it("M3：返回形状不变 —— 恰 {code, stdout, stderr} 三字段", async () => {
    const cwd = await makeScratch("bash-mask-shape-");
    const registry = createSecretRegistry();
    registry.register("sk-shape-probe-aaaaaaaaaa");
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = await tool.handler({
      command: 'echo "<<<SECRET_1>>>"',
    });

    assert.deepEqual(Object.keys(result as object).sort(), [
      "code",
      "stderr",
      "stdout",
    ]);
    assert.deepEqual(result, {
      code: 0,
      stdout: "***\n",
      stderr: "",
    });
  });

  it("M4：registry 在场但值为空（边界） → mask identity，输出原样不 crash", async () => {
    const cwd = await makeScratch("bash-mask-empty-registry-");
    const tool = createBashTool(cwd, {
      secretRegistry: createSecretRegistry(), // 空 registry
    });

    const result = (await tool.handler({
      command: "echo keep",
    })) as BashResult;

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
    assert.equal(result.stderr, "");
  });

  it("M4：注册空串（边界） → mask identity，输出原样不 crash", async () => {
    const cwd = await makeScratch("bash-mask-empty-string-");
    const registry = createSecretRegistry();
    registry.register(""); // 空串注册
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = (await tool.handler({
      command: "echo keep",
    })) as BashResult;

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
    assert.equal(result.stderr, "");
  });
});
