/**
 * ADR-0092 Amendment 2026-09-13 / SC11 —— fs 档的父子传播通道（父会话 → worker）。
 *
 * 缺口（code-review High）：`CreateWorkerDepsOptions.fsMode` 缝此前只有测试
 * 覆盖，唯一生产入口 `runSubagentWorker` 不传；父会话在工作区档时，模型经
 * `subagent → bash` 拿到的仍是「可写 home」的全局档围栏 —— SC11 在同一会话内
 * 可绕过。本文件钉住修复后的整条通道：
 *
 *   build-engine `opts.fsMode`（holder）
 *     → `createDefaultSubAgentSpawn({ fsMode })`
 *     → 子进程 env `IKNOW_FS_MODE`（spawn 期读 holder，D2 语义）
 *     → `runSubagentWorker` 的 `fsModeOptionFromEnv`
 *     → `createWorkerRuntime` 的 `fsMode` holder
 *     → registry → bash 工厂 → bwrap fence 的 workspace 三层 mount。
 *
 * 通道形态 = env（与 `IKNOW_WORKSPACE_ROOT` / `IKNOW_PRODUCT_ROOT` 同款
 * 「父进程设、worker 读」先例）；信封（envelope）是 untrusted 输入面
 * （`additionalProperties:false` + ajv），不承载本字段。
 *
 * 断言分四段：
 *   A. 父侧写：env 键值 = spawn 期 holder 当前值；缺省 holder → 键缺席；
 *   B. worker 侧读：合法值 → holder；缺省 / 非法 → 缺省（fail-closed）；
 *   C. 端到端：走 worker 的装配入口，bash 工厂产出的**真实 fence argv**
 *      在工作区档叠 `--ro-bind <home>` + `--bind <taskRoot>`；缺省档不叠；
 *   D. build-engine 把同一个 holder 对象交给 spawn 工厂（链头不断）。
 */
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// D 段用：捕获 build-engine → `createDefaultSubAgentSpawn` 的 opt 面。
// 包装而非替换 —— A 段仍调用真实现（真 spawn 子进程）。
const spawnOptsCapture = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../../src/harness/subagent/spawn.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/subagent/spawn.ts")
    >();
  return {
    ...actual,
    createDefaultSubAgentSpawn: (
      opts?: Parameters<typeof actual.createDefaultSubAgentSpawn>[0]
    ): ReturnType<typeof actual.createDefaultSubAgentSpawn> => {
      spawnOptsCapture.current = opts as Record<string, unknown> | undefined;
      return actual.createDefaultSubAgentSpawn(opts);
    },
  };
});

// C 段用：bash 工厂期 requireBwrap() / handler 期 runInSandbox 不假设宿主有
// bwrap（与 worker-identity-root.test.ts 同款，registry / bash.ts / fs-policy /
// bwrap.ts 全部保持真实，只有 spawn 出口被挡）。
vi.mock("../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/sandbox/runner.js")
    >();
  return {
    ...actual,
    requireBwrap: () => {},
    runInSandbox: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
});

import { runInSandbox } from "../../src/harness/sandbox/runner.ts";
import { createDefaultSubAgentSpawn } from "../../src/harness/subagent/spawn.ts";
import {
  createWorkerDeps,
  fsModeOptionFromEnv,
} from "../../src/harness/subagent/worker.ts";
import {
  createFsModeContext,
  type FsModeContext,
} from "../../src/harness/sandbox/fs-mode.ts";
import { FS_MODE_ENV_KEY } from "../../src/config/workspace-root.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import { buildHarnessEngine } from "../../src/harness/build-engine.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const TEST_ENV: IknowEnv = {
  llm: {
    baseUrl: "http://127.0.0.1:9999",
    model: "test-model",
    fallback: [],
    apiKey: "test-key",
    maxOutputTokens: 1024,
    timeoutMs: 60_000,
    temperature: 0,
    thinking: "off",
    thinkingEffort: "",
    stream: "on",
  },
  chat: { showThinking: false },
  web: { searchUrl: undefined, proxy: undefined },
  compress: { contextWindow: 200_000, thresholdTokens: undefined },
  mcp: { connectTimeoutMs: 60_000 },
  subagent: { taskTimeoutMs: undefined },
};

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/** 父进程 ambient env 不得干扰断言（通道值只应由 spawn opts 决定）。 */
const originalEnvValue = process.env[FS_MODE_ENV_KEY];

afterEach(async () => {
  if (originalEnvValue === undefined) delete process.env[FS_MODE_ENV_KEY];
  else process.env[FS_MODE_ENV_KEY] = originalEnvValue;
  vi.mocked(runInSandbox).mockClear();
  spawnOptsCapture.current = undefined;
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

// ── A. 父侧写：spawn env ────────────────────────────────────────────────────

/**
 * 真 spawn 一个 node 子进程打印它看到的 env 值（与 spawn-argv.test.ts 的
 * IKNOW_TRACE_OUT 用例同款：断言的是**真实到达子进程的字节**，不是我们传给
 * spawn 的 options 对象）。
 */
async function spawnAndReadFsMode(
  fsMode: FsModeContext | undefined
): Promise<string> {
  delete process.env[FS_MODE_ENV_KEY];
  const root = await makeScratch("iknow-fs-mode-wire-");
  const script = join(root, "print-fs-mode.js");
  await writeFile(
    script,
    `process.stdout.write(process.env[${JSON.stringify(FS_MODE_ENV_KEY)}] ?? "<unset>")`
  );
  const spawnWorker = createDefaultSubAgentSpawn(
    fsMode !== undefined ? { fsMode } : {}
  );
  const originalArgv1 = process.argv[1];
  process.argv[1] = script;
  let child: ChildProcess;
  try {
    child = spawnWorker({} as never, "task-id", {} as never);
  } finally {
    process.argv[1] = originalArgv1;
  }
  return await new Promise<string>((resolvePromise, reject) => {
    let value = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      value += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", () => resolvePromise(value));
  });
}

describe("A. createDefaultSubAgentSpawn — fs 档写入子进程 env", () => {
  it("workspace holder → IKNOW_FS_MODE=workspace 到达子进程", async () => {
    expect(await spawnAndReadFsMode(createFsModeContext("workspace"))).toBe(
      "workspace"
    );
  });

  it("global holder → 显式写 IKNOW_FS_MODE=global（holder 在场即钉值，不省略）", async () => {
    // 取舍：holder 在场 = 本会话显式钉了档位，即使值是缺省档也写线 ——
    // 父/子两侧对「缺省」的解释因此只有一种（键缺席 = 这条通道未接）。
    expect(await spawnAndReadFsMode(createFsModeContext("global"))).toBe(
      "global"
    );
  });

  it("holder 缺席（legacy / 测试路径）→ 键不出现，子进程 env 字节不变", async () => {
    expect(await spawnAndReadFsMode(undefined)).toBe("<unset>");
  });

  it("spawn 期读 holder（D2）：工厂建好后 /config 翻档，下一次 spawn 带新值", async () => {
    // build-engine 只在装配期建一次 spawn 工厂；若在工厂期把 holder 求值成
    // 字符串，运行期 `/config fs workspace` 就再也到不了子进程。两次 spawn
    // 之间翻档，第二次必须看到新档。
    delete process.env[FS_MODE_ENV_KEY];
    const root = await makeScratch("iknow-fs-mode-wire-flip-");
    const script = join(root, "print-fs-mode.js");
    await writeFile(
      script,
      `process.stdout.write(process.env[${JSON.stringify(FS_MODE_ENV_KEY)}] ?? "<unset>")`
    );
    const holder = createFsModeContext("global");
    const spawnWorker = createDefaultSubAgentSpawn({ fsMode: holder });
    const readOnce = async (): Promise<string> => {
      const originalArgv1 = process.argv[1];
      process.argv[1] = script;
      let child: ChildProcess;
      try {
        child = spawnWorker({} as never, "task-id", {} as never);
      } finally {
        process.argv[1] = originalArgv1;
      }
      return await new Promise<string>((resolvePromise, reject) => {
        let value = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          value += chunk.toString("utf8");
        });
        child.once("error", reject);
        child.once("close", () => resolvePromise(value));
      });
    };
    expect(await readOnce()).toBe("global");
    holder.set("workspace");
    expect(await readOnce()).toBe("workspace");
  });
});

// ── B. worker 侧读：env 键 → holder（fail-closed）───────────────────────────

describe("B. fsModeOptionFromEnv — worker 侧 env → holder", () => {
  it("IKNOW_FS_MODE=workspace → workspace holder", () => {
    const opts = fsModeOptionFromEnv({ [FS_MODE_ENV_KEY]: "workspace" });
    expect(opts.fsMode?.get()).toBe("workspace");
  });

  it("大小写与首尾空白按 parseFsModeFlag 归一（与 /config、settings 同一值域）", () => {
    expect(
      fsModeOptionFromEnv({ [FS_MODE_ENV_KEY]: "  Workspace  " }).fsMode?.get()
    ).toBe("workspace");
  });

  it("IKNOW_FS_MODE=global → global holder", () => {
    expect(
      fsModeOptionFromEnv({ [FS_MODE_ENV_KEY]: "global" }).fsMode?.get()
    ).toBe("global");
  });

  it.each([undefined, "", "   ", "GLOBAL2", "on", "1", "ro"])(
    "非法 / 缺省值 %j → 键缺席（fail-closed 到 bash 工厂缺省 = 全局档）",
    (raw) => {
      expect(fsModeOptionFromEnv({ [FS_MODE_ENV_KEY]: raw })).toEqual({});
    }
  );
});

// ── C. 端到端：worker 装配 → bash 工厂 → 真实 fence argv ────────────────────

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

/**
 * 走 worker 的装配入口（`createWorkerDeps` + `fsModeOptionFromEnv`，与
 * `runSubagentWorker` 的调用面同一形态），驱动 bash handler，取真实 fence
 * argv。断言面 = argv（不是 env 字符串、不是 holder 对象）。
 */
async function workerBashArgv(
  rawEnv: Record<string, string | undefined>
): Promise<{
  readonly argv: readonly string[];
  readonly sandboxRoot: string;
  readonly userHome: string;
}> {
  const sandboxRoot = await makeScratch("iknow-fs-mode-e2e-task-");
  const userHome = await makeScratch("iknow-fs-mode-e2e-home-");
  const deps = await createWorkerDeps({
    env: TEST_ENV,
    sandboxRoot,
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    trace: createNoopTraceService(),
    userHome,
    ...fsModeOptionFromEnv(rawEnv),
  });
  const bash = deps.registry.get("bash");
  if (!bash || typeof bash.handler !== "function") {
    throw new Error("bash tool missing from worker registry");
  }
  vi.mocked(runInSandbox).mockClear();
  await bash.handler({ command: "echo hi" });
  const calls = vi.mocked(runInSandbox).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1]!;
  return { argv: last[0]!.fence.argv, sandboxRoot, userHome };
}

describe("C. worker 端到端 — env 档决定 bash fence 的 mount 层", () => {
  it("env=workspace → fence 叠 home 只读 + taskRoot 写白名单（SC11 收紧真实生效）", async () => {
    const { argv, sandboxRoot, userHome } = await workerBashArgv({
      [FS_MODE_ENV_KEY]: "workspace",
    });
    expect(hasHostRootBind(argv)).toBe(true);
    // home 可见：ro-bind；且不得再有可写的 home bind（后者会覆盖回可写）。
    expect(roBindIndex(argv, userHome)).toBeGreaterThan(-1);
    expect(bindIndex(argv, userHome)).toBe(-1);
    // 写白名单：worker 的活 taskRoot = harness 侧 sandboxRoot（waveRoot 无
    // liveTaskRoot cell，回落工厂 cwd）。
    expect(bindIndex(argv, sandboxRoot)).toBeGreaterThan(-1);
    // mount 序 last-mount-wins：home ro-bind 必须在 taskRoot 可写 bind 之前，
    // 否则后发射的 ro-bind 会把写白名单重新冻住。
    expect(roBindIndex(argv, userHome)).toBeLessThan(
      bindIndex(argv, sandboxRoot)
    );
  });

  it.each([
    ["键缺席", {}],
    ["非法值", { [FS_MODE_ENV_KEY]: "workspace!" }],
  ])(
    "%s → 全局档 fence（无 home ro-bind / 无 taskRoot 写白名单）",
    async (_label, rawEnv) => {
      const { argv, sandboxRoot, userHome } = await workerBashArgv(rawEnv);
      expect(hasHostRootBind(argv)).toBe(true);
      expect(roBindIndex(argv, userHome)).toBe(-1);
      expect(bindIndex(argv, sandboxRoot)).toBe(-1);
    }
  );
});

// ── D. 链头：build-engine 把 holder 交给 spawn 工厂 ─────────────────────────

describe("D. buildHarnessEngine — fs 档 holder 进入 spawn 工厂 opt 面", () => {
  it("opts.fsMode holder 原样透传（同一对象，装配期不求值）", async () => {
    const root = await makeScratch("iknow-fs-mode-build-");
    const holder = createFsModeContext("workspace");
    const built = await buildHarnessEngine({
      env: TEST_ENV,
      askUser: createNoAskUser(),
      surface: "chat",
      cwd: root,
      userHome: join(root, "home"),
      workspaceRoot: root,
      productRoot: root,
      fsMode: holder,
      skipCountTokens: true,
    });
    try {
      expect(spawnOptsCapture.current?.fsMode).toBe(holder);
    } finally {
      await built.shutdown?.();
    }
  });
});
