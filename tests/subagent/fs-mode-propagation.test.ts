/**
 * ADR-0092 Amendment — the parent→worker propagation channel for the fs mode.
 *
 * Gap (code-review High): the `CreateWorkerDepsOptions.fsMode` seam was
 * previously test-covered only; the sole production entry `runSubagentWorker`
 * did not pass it. When the parent session is in workspace mode, the model
 * still got the writable-home global fence via `subagent → bash` —
 * escapable within the same session. This file pins the fixed whole channel:
 *
 *   build-engine `opts.fsMode` (holder)
 *     → `createDefaultSubAgentSpawn({ fsMode })`
 *     → child-process env `IKNOW_FS_MODE` (holder read at spawn time)
 *     → `runSubagentWorker`'s `fsModeOptionFromEnv`
 *     → `createWorkerRuntime`'s `fsMode` holder
 *     → registry → bash factory → bwrap fence's workspace three-layer mount.
 *
 * Channel shape = env (same "parent sets, worker reads" precedent as
 * `IKNOW_WORKSPACE_ROOT` / `IKNOW_PRODUCT_ROOT`); the envelope is an untrusted
 * input surface (`additionalProperties:false` + ajv) and does not carry this field.
 *
 * Assertions in four segments:
 *   A. parent-side write: env key value = holder's current value at spawn time; absent holder → key absent;
 *   B. worker-side read: valid value → holder; absent / invalid → default (fail-closed);
 *   C. end to end: through the worker's assembly entry, the **real fence argv**
 *      produced by the bash factory stacks `--ro-bind <home>` + `--bind <taskRoot>`
 *      in workspace mode; not stacked in default mode;
 *   D. build-engine hands the same holder object to the spawn factory (chain head unbroken).
 */
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// For segment D: capture the opt surface build-engine → `createDefaultSubAgentSpawn`.
// Wrap, not replace — segment A still calls the real implementation (really spawns children).
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

// For segment C: at bash-factory time requireBwrap() / at handler time runInSandbox
// do not assume the host has bwrap (same as worker-identity-root.test.ts;
// registry / bash.ts / fs-policy / bwrap.ts all stay real, only the spawn exit is blocked).
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
  workspaceRoot: undefined,
  productRoot: undefined,
};

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

/** Parent-process ambient env must not interfere with assertions (the channel value should be decided only by spawn opts). */
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

// ── A. parent-side write: spawn env ─────────────────────────────────────────

/**
 * Really spawn a node child that prints the env value it sees (same style as
 * spawn-argv.test.ts's IKNOW_TRACE_OUT case: asserting the **bytes that
 * actually reach the child**, not the options object we handed to spawn).
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
    // Tradeoff: holder present = this session explicitly pinned a mode, so the
    // value is written even when it equals the default — leaving parent and
    // child exactly one interpretation of "default" (key absent = channel unwired).
    expect(await spawnAndReadFsMode(createFsModeContext("global"))).toBe(
      "global"
    );
  });

  it("holder 缺席（legacy / 测试路径）→ 键不出现，子进程 env 字节不变", async () => {
    expect(await spawnAndReadFsMode(undefined)).toBe("<unset>");
  });

  it("spawn 期读 holder（D2）：工厂建好后 /config 翻档，下一次 spawn 带新值", async () => {
    // build-engine creates the spawn factory once at assembly time; if the
    // holder were evaluated into a string at factory time, a runtime
    // `/config fs workspace` could never reach the child. Flipping the mode
    // between two spawns must be visible to the second one.
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

// ── B. worker-side read: env key → holder (fail-closed) ─────────────────────

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

// ── C. end to end: worker assembly → bash factory → real fence argv ─────────

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
 * Go through the worker's assembly entry (`createWorkerDeps` +
 * `fsModeOptionFromEnv`, same call shape as `runSubagentWorker`), drive the
 * bash handler, and capture the real fence argv. Assertion surface = argv
 * (not the env string, not the holder object).
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
    // home visible: ro-bind; and no writable home bind may remain (the latter would override back to writable).
    expect(roBindIndex(argv, userHome)).toBeGreaterThan(-1);
    expect(bindIndex(argv, userHome)).toBe(-1);
    // Write whitelist: the worker's live taskRoot = harness-side sandboxRoot
    // (waveRoot has no liveTaskRoot cell, falls back to the factory cwd).
    expect(bindIndex(argv, sandboxRoot)).toBeGreaterThan(-1);
    // Mount order is last-mount-wins: home ro-bind must precede the taskRoot
    // writable bind, otherwise a later-emitted ro-bind refreezes the whitelist.
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

// ── D. chain head: build-engine hands the holder to the spawn factory ───────

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
