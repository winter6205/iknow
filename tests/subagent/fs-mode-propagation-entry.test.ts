/**
 * ADR-0092 Amendment 2026-09-13 / SC11 —— fs 档传播的**生产入口**验证。
 *
 * `fs-mode-propagation.test.ts` 覆盖了通道两端（spawn 写 env / `fsModeOptionFromEnv`
 * 读 env）与「等价装配入口」（测试自己调 `createWorkerDeps` + helper）。等价入口
 * 有一个判别力缺口：把 `runSubagentWorker` 里 `...fsModeOptionFromEnv(process.env)`
 * 这一行删掉，等价入口照旧绿 —— 因为测试自己拼装 deps 时调了 helper 一次，
 * 而 prod 入口的那一次调用没有任何测试经过。这正是本 bug 的类别（缝在、
 * 生产接线断）。
 *
 * 本文件把真 `runSubagentWorker()` 跑起来（stdin 喂一行 envelope、stdout 收一行
 * result），断言面 = **bwrap 实际收到的 fence argv**（bash 工具真实执行面；
 * fence 经 server 层 spawn，argv[0] = `bwrap`，PATH 上的替身即最外缘可观测点）。
 * 因此：
 *
 *   - fs 档接线在（env=workspace）→ fence argv 里有 `--ro-bind <home>` +
 *     `--bind <sandboxRoot>`；
 *   - 删掉 `runSubagentWorker` 的那行 → fence argv 退回全局档（`--bind / /`
 *     在、home ro-bind 不在）→ 本文件红。
 *
 * 边界选择（为什么不 stub env/stdin）：
 *   - stdin：`process` 的 `stdin` 只有 getter 且不可 set，spy 不掉（实测
 *     `Object.getOwnPropertyDescriptor(process, "stdin")` → `{get, configurable,
 *     set: false}`）；改成 `vi.mock("node:process")` 会连带换掉生产路径真正
 *     使用的 `process.env` / `process.cwd()` / `process.stderr`，违反真实边界。
 *     故从真 stdin 喂数据（与 `cli.ts --subagent-worker` 的子进程形态同款）。
 *   - env：`loadIknowEnv()` 走 `process.env`（ADR-0001 worker 继承父 env），
 *     本文件按真实边界改 ambient env + HOME 重定向到 scratch，跑完恢复。
 *   - 唯一被替身的是模型面（`createRealAnthropicAdapter` → 本地确定性 stub）：
 *     本机无 LLM key，且本测试的题面是 fs 档接线，不是 adapter 行为。
 *     `buildThinkingParams` / `withTransportRetry` / `translateAnthropicTransportFault`
 *     保持真实现（只换 adapter 本体，与 `createWorkerDeps` 测试注入 stub-model
 *     同一抽象层级）。
 *   - bash 走真实执行：父进程 PATH 上的 `bwrap` 被换成记录 argv + `{}` 的替身
 *     （bwrap 不在工作区内，不属被测系统），被测系统 = worker 装配 + registry +
 *     bash 工厂 + fence 构造 + server 协议。替身既非真 bwrap，自然也没有真
 *     沙箱副作用 —— 本测试只取 argv 面。
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// 模型面替身：worker 装配期用 createStubModel 作 adapter（本机无 LLM key）。
// 其余导出（buildThinkingParams / createExecutor / withTransportRetry /
// translateAnthropicTransportFault）保持真实现。
vi.mock(
  "../../src/harness/model-adapter/anthropic-adapter.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../src/harness/model-adapter/anthropic-adapter.ts")
      >();
    const { createStubModel } =
      await import("../../src/harness/stubs/stub-model.ts");

    return {
      ...actual,
      createRealAnthropicAdapter: () =>
        createStubModel({
          responses: [
            {
              nativeMessage: {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "call_bash_1",
                    name: "bash",
                    input: { command: "echo hi" },
                  },
                ],
              },
              projection: {
                nativeMessage: {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "call_bash_1",
                      name: "bash",
                      input: { command: "echo hi" },
                    },
                  ],
                },
                texts: [],
                toolCalls: [
                  {
                    id: "call_bash_1",
                    name: "bash",
                    input: { command: "echo hi" },
                  },
                ],
              },
              supplierStop: "success",
              needsTools: true,
              isEmptyFinalResponse: false,
            },
            {
              nativeMessage: {
                role: "assistant",
                content: [{ type: "text", text: "done" }],
              },
              projection: {
                nativeMessage: {
                  role: "assistant",
                  content: [{ type: "text", text: "done" }],
                },
                texts: ["done"],
                toolCalls: [],
              },
              supplierStop: "success",
              needsTools: false,
              isEmptyFinalResponse: false,
            },
          ],
        }),
    };
  }
);

import { runSubagentWorker } from "../../src/harness/subagent/worker.ts";
import { FS_MODE_ENV_KEY } from "../../src/config/workspace-root.ts";
import {
  installTestProviderApiKey,
  llmSettingsJson,
} from "../_helpers/test-llm-settings.ts";

/** 本文件改的 ambient env 键（跑完原样恢复）。 */
const ENV_KEYS = [
  "HOME",
  "IKNOW_FS_MODE",
  "IKNOW_WORKSPACE_ROOT",
  "IKNOW_PRODUCT_ROOT",
  "IKNOW_TRACE_OUT",
  "IKNOW_LLM_BASE_URL",
  "IKNOW_LLM_MAX_OUTPUT_TOKENS",
  "IKNOW_LLM_TIMEOUT_MS",
  "IKNOW_LLM_STREAM",
] as const;

const scratchPaths: string[] = [];
const savedEnv = new Map<string, string | undefined>();

const originalExit = process.exit;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function scratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/**
 * 把 PATH 换成一个只含 bwrap 替身的目录（真 bash/echo 仍走真 PATH）。
 *
 * 替身把收到的 argv 追加进 `argvLog`：路径在**生成时写死**，不读环境变量
 * —— bash 起 bwrap 用的是 fence env（`--clearenv` + 白名单），`process.env`
 * 里的键在那里不可见（这正是围栏的语义）。
 */
function makeBwrapShimDir(argvLog: string): string {
  const dir = scratch("iknow-fs-mode-entry-bin-");
  const shim = join(dir, "bwrap");
  // 每次调用先写分隔行再写 argv —— 装配期的 bwrap 探针调用与真 fence 调用
  // 因此可分开（两者都在同一个 log 里，追加写）。本文件在 PATH 前置了一个
  // 只含本替身的目录，故宿主是否装 bwrap 都不影响本文件（不真跑围栏）。
  writeFileSync(
    shim,
    `#!/bin/sh\nprintf '###ARGS###\\n' >> ${JSON.stringify(argvLog)}\nprintf '%s\\n' "$@" >> ${JSON.stringify(argvLog)}\n`
  );
  chmodSync(shim, 0o755);
  return dir;
}

async function runWorkerEntry(opts: {
  readonly fsModeToken?: string;
  readonly argvLog: string;
  readonly home: string;
  readonly sandboxRoot: string;
  readonly task: string;
  readonly bwrapShimDir: string;
}): Promise<{
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}> {
  const { home, sandboxRoot, task, argvLog } = opts;
  // 1) ambient env：worker 继承父 env（ADR-0001），与 spawn.ts 写的形状一致。
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  process.env.HOME = home;
  installTestProviderApiKey();
  process.env.IKNOW_LLM_MAX_OUTPUT_TOKENS = "1024";
  process.env.IKNOW_LLM_TIMEOUT_MS = "5000";
  process.env.IKNOW_LLM_STREAM = "off";
  delete process.env.IKNOW_WORKSPACE_ROOT;
  delete process.env.IKNOW_PRODUCT_ROOT;
  const traceDir = join(home, ".iknow", "projects", "entry-fixture");
  mkdirSync(traceDir, { recursive: true });
  process.env.IKNOW_TRACE_OUT = traceDir;
  if (opts.fsModeToken === undefined) delete process.env[FS_MODE_ENV_KEY];
  else process.env[FS_MODE_ENV_KEY] = opts.fsModeToken;

  // 2) settings：loadIknowEnv 的模型唯一来源 = 用户层 settings.llm.model。
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify(llmSettingsJson({ model: "test/stub-model" }))
  );

  // 3) PATH = bwrap 替身目录 + 真 PATH（bash / echo 等仍可达）。
  const savedPath = process.env.PATH;
  process.env.PATH = `${opts.bwrapShimDir}:${savedPath ?? ""}`;
  // 4) sandbox 根 = 活 taskRoot 形状（bash 围栏的 taskRoot / cwd）。
  writeFileSync(join(sandboxRoot, ".keep"), "");

  // 5) 真 stdin：一行 envelope（worker 协议），读到 EOF。
  const envelope = JSON.stringify({
    task,
    sandboxRoot,
    maxTurns: 3,
  });
  const stdinPath = join(
    scratch("iknow-fs-mode-entry-stdin-"),
    "envelope.jsonl"
  );
  writeFileSync(stdinPath, envelope + "\n");

  let exitCode = 0;
  let stderr = "";
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown): boolean => {
      stderr += String(chunk);
      return true;
    });
  let stdout = "";
  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown): boolean => {
      stdout += String(chunk);
      return true;
    });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number
  ) => {
    exitCode = code ?? 0;
    throw new Error(`__worker_exit_${exitCode}__`);
  }) as never);

  try {
    const stdinReal = readFileSync(stdinPath);
    const fakeStdin = new (await import("node:stream")).PassThrough();
    Object.defineProperty(process, "stdin", {
      value: fakeStdin,
      configurable: true,
    });
    fakeStdin.end(stdinReal);
    try {
      await runSubagentWorker();
    } catch (err) {
      if (!String(err).includes("__worker_exit_")) throw err;
    }
    Object.defineProperty(process, "stdin", {
      value: undefined,
      configurable: true,
    });
  } finally {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    process.env.PATH = savedPath;
    for (const key of ENV_KEYS) {
      const previous = savedEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    savedEnv.clear();
  }

  return { exitCode, stderr, stdout };
}

function roBindIndex(argv: readonly string[], root: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" && argv[i + 1] === root && argv[i + 2] === root
  );
}

function bindIndex(argv: readonly string[], root: string): number {
  return argv.findIndex(
    (arg, i) => arg === "--bind" && argv[i + 1] === root && argv[i + 2] === root
  );
}

function hasHostRootBind(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) => arg === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/"
  );
}

function shimFenceArgv(argvLog: string): readonly string[] {
  let raw = "";
  try {
    raw = readFileSync(argvLog, "utf8");
  } catch {
    return [];
  }
  const calls = raw
    .split("###ARGS###\n")
    .map((chunk) => chunk.split("\n").filter(Boolean))
    .filter((argv) => argv.length > 0);
  // 探针调用 = `bwrap --version`（argv[0] === "--version"），真围栏调用以
  // `--unshare-user-try` 开头。
  const fence = calls.find((argv) => argv[0] === "--unshare-user-try");
  return fence ?? [];
}

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (process.env.KEEP_SCRATCH === "1") {
    for (const path of scratchPaths) console.error(`KEEP ${path}`);
    scratchPaths.length = 0;
    return;
  }
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("runSubagentWorker（生产入口）— IKNOW_FS_MODE 决定 bash fence", () => {
  it("env=workspace → 真 worker 跑完，bwrap 收到 home ro-bind + taskRoot 写白名单", async () => {
    const home = scratch("iknow-fs-mode-entry-home-");
    const sandboxRoot = scratch("iknow-fs-mode-entry-task-");
    const argvLog = join(scratch("iknow-fs-mode-entry-log-"), "argv.txt");
    const bwrapShimDir = makeBwrapShimDir(argvLog);

    const result = await runWorkerEntry({
      fsModeToken: "workspace",
      argvLog,
      home,
      sandboxRoot,
      task: "run a harmless command",
      bwrapShimDir,
    });

    // 先钉「入口真的跑到了 bash 围栏」——否则下面的 argv 断言是空集上恒真。
    const argv = shimFenceArgv(argvLog);
    expect(
      argv.length,
      `exit=${result.exitCode} stdout=${result.stdout} stderr=${result.stderr}`
    ).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    // SC11：home 只读可见 + 活 taskRoot 可写。
    expect(roBindIndex(argv, home)).toBeGreaterThan(-1);
    expect(bindIndex(argv, home)).toBe(-1);
    expect(bindIndex(argv, sandboxRoot)).toBeGreaterThan(-1);
    // mount 序 last-mount-wins：home ro-bind 必须先于 taskRoot 可写 bind。
    expect(roBindIndex(argv, home)).toBeLessThan(bindIndex(argv, sandboxRoot));
  }, 60_000);

  it("env 缺席 → 同一入口走全局档 fence（home ro-bind 不出现）", async () => {
    const home = scratch("iknow-fs-mode-entry-home-");
    const sandboxRoot = scratch("iknow-fs-mode-entry-task-");
    const argvLog = join(scratch("iknow-fs-mode-entry-log-"), "argv.txt");
    const bwrapShimDir = makeBwrapShimDir(argvLog);

    const result = await runWorkerEntry({
      argvLog,
      home,
      sandboxRoot,
      task: "run a harmless command",
      bwrapShimDir,
    });

    const argv = shimFenceArgv(argvLog);
    expect(argv.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(hasHostRootBind(argv)).toBe(true);
    expect(roBindIndex(argv, home)).toBe(-1);
    expect(bindIndex(argv, sandboxRoot)).toBe(-1);
  }, 60_000);

  it("env=非法值 → fail-closed 到全局档（与缺席同形）", async () => {
    const home = scratch("iknow-fs-mode-entry-home-");
    const sandboxRoot = scratch("iknow-fs-mode-entry-task-");
    const argvLog = join(scratch("iknow-fs-mode-entry-log-"), "argv.txt");
    const bwrapShimDir = makeBwrapShimDir(argvLog);

    const result = await runWorkerEntry({
      fsModeToken: "workspace!",
      argvLog,
      home,
      sandboxRoot,
      task: "run a harmless command",
      bwrapShimDir,
    });

    const argv = shimFenceArgv(argvLog);
    expect(argv.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
    expect(roBindIndex(argv, home)).toBe(-1);
    expect(bindIndex(argv, sandboxRoot)).toBe(-1);
  }, 60_000);
});
