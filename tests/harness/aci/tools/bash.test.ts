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
  it("exposes command + optional background + optional network, no model-facing timeout", async () => {
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
    assert.deepEqual(schema.properties, {
      command: { type: "string" },
      // #502 T3:background?: boolean(缺省 false = 前台,行为不变)
      background: {
        type: "boolean",
        description:
          "When true, run the command in the background: returns {task_id, log_path} immediately and the process keeps running after the call, managed by the task registry. Use for long-lived servers or daemons; pair with bash_output (read the log) and bash_stop (terminate). Defaults to false (foreground).",
      },
      // #503 T10 / ADR-0022:network?: boolean(宿主网络批准轴 — fence 去掉
      // --unshare-net；上层 rule 强制 ask,full_auto 不豁免)。
      network: {
        type: "boolean",
        description:
          "When true, this command gets host network access (the fence skips --unshare-net) so it can reach the LAN or the internet. Network opt-in is a separate approval axis: calls with network:true always go through explicit permission and full_auto mode does not exempt them. Defaults to false (network-isolated).",
      },
    });
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

  // T8 (parent-visible-tmp): bash description 两句 —— 进项目写 taskRoot；
  // 不必进仓写 /tmp（跟当前身份同寿命，不是交付）。写根段仍不提 /tmp。
  // 取代 write-situation-disclosure SC11 的「一次命令即灭」寿命句（ADR-0074）。
  it("description documents project writes at taskRoot and /tmp when it need not enter the repo", async () => {
    const cwd = await makeScratch("bash-desc-tmp-");
    const tool = createBashTool(cwd);
    assert.match(tool.description, /write into the project at taskRoot/i);
    assert.match(
      tool.description,
      /write \/tmp when it need not enter the repo/i
    );
    assert.match(tool.description, /not a delivery destination/);
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

/** #693 T4 D4:bash handler 自 T4 起返回 envelope `{ output, meta? }`,模型视野
 *  仅见 `output` 字段里 JSON 化的 code/stdout/stderr（形状不变）。本测试文件
 *  保持「接口 = BashResult 旧形」契约,在 helper 层多走一次 parse —— 业务
 *  断言不被 envelope 包装影响。 */
interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}

function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

async function runBash(cwd: string, command: string): Promise<BashResult> {
  const tool = createBashTool(cwd);
  const envelope = (await tool.handler({ command })) as BashEnvelope;
  return parseBashEnvelope(envelope);
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

    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_1>>>"',
      })) as BashEnvelope
    );

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

    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_1>>> <<<SECRET_2>>>"',
      })) as BashEnvelope
    );

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
    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_MISSING>>>"',
      })) as BashEnvelope
    );

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

    const result = parseBashEnvelope(
      (await tool.handler({
        command: "echo keep",
      })) as BashEnvelope
    );

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
//   - envelope 形态：顶层恰 { output: string, meta?: { stdout?, stderr? } },
//     output 字段里 JSON 化 code/stdout/stderr（模型视野字节不变），
//     meta 是观测旁路（TUI 5 行尾窗用，不进模型 tool_result）
//   - registry 在场但空 → mask identity，输出原样
describe("#406 T3 — bash 输出遮罩（output-mask on stdout/stderr）", () => {
  it("M1：registry 在场 + 命令经占位符还原路径 → stdout 真值被遮罩为 ***", async () => {
    const cwd = await makeScratch("bash-mask-stdout-");
    const registry = createSecretRegistry();
    const secret = "sk-live-超密值-aaaaaaaaaaaa";
    registry.register(secret);
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: 'echo "<<<SECRET_1>>>"',
      })) as BashEnvelope
    );

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

    const result = parseBashEnvelope(
      (await tool.handler({
        command: `printf '%s' "<<<SECRET_1>>>" >&2; exit 0`,
      })) as BashEnvelope
    );

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

    const result = parseBashEnvelope(
      (await tool.handler({
        command: `echo "${secret}"`,
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(
      result.stdout.includes(secret),
      true,
      `缺席 registry 时 stdout 应原样含真值（实际=${JSON.stringify(result.stdout)}）`
    );
    assert.equal(result.stdout.includes("***"), false);
  });

  it("M3：返回形状是 envelope —— 顶层恰 { output: string, meta?: { stdout?, stderr? } }", async () => {
    const cwd = await makeScratch("bash-mask-shape-");
    const registry = createSecretRegistry();
    registry.register("sk-shape-probe-aaaaaaaaaa");
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = (await tool.handler({
      command: 'echo "<<<SECRET_1>>>"',
    })) as BashEnvelope;

    // 顶层：必含 `output`(模型视野字符串);`meta` 是观测旁路(stdout/stderr
    // 走此处,不进模型 tool_result);顶层不再有 code/stdout/stderr 字段。
    assert.deepEqual(Object.keys(result).sort(), ["meta", "output"]);
    assert.equal(typeof result.output, "string");
    assert.equal(typeof result.meta, "object");

    // 解析 envelope 内嵌的 code/stdout/stderr 仍维持原 M3 语义(形状不变,
    // 断言 strength 不降): code=0,stdout="***\n",stderr="",且 envelope
    // 内的 stdout/stderr 同步被遮罩(不绕过 output mask)。
    const parsed = parseBashEnvelope(result);
    assert.deepEqual(parsed, {
      code: 0,
      stdout: "***\n",
      stderr: "",
    });
    // meta.stdout / meta.stderr 是输出旁路,与 envelope.output 内的字段
    // 字节一致(mask 同步覆盖两侧,避免 model/tool/UI 三视角漂移)。
    assert.equal(result.meta?.stdout, parsed.stdout);
    assert.equal(result.meta?.stderr, parsed.stderr);
  });

  it("M4：registry 在场但值为空（边界） → mask identity，输出原样不 crash", async () => {
    const cwd = await makeScratch("bash-mask-empty-registry-");
    const tool = createBashTool(cwd, {
      secretRegistry: createSecretRegistry(), // 空 registry
    });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: "echo keep",
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
    assert.equal(result.stderr, "");
  });

  it("M4：注册空串（边界） → mask identity，输出原样不 crash", async () => {
    const cwd = await makeScratch("bash-mask-empty-string-");
    const registry = createSecretRegistry();
    registry.register(""); // 空串注册
    const tool = createBashTool(cwd, { secretRegistry: registry });

    const result = parseBashEnvelope(
      (await tool.handler({
        command: "echo keep",
      })) as BashEnvelope
    );

    assert.equal(result.code, 0);
    assert.equal(result.stdout, "keep\n");
    assert.equal(result.stderr, "");
  });
});
