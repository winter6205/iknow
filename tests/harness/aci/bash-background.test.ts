/**
 * #502 T3 — bash `background` 参数 e2e（tracer bullet）。
 *
 * 覆盖计划 acceptance 要求：
 *   1. 单元面（fake manager）：background:true 命中 → handler 立即返回
 *      {task_id, log_path}，不等待子进程退出、不等待 spawn 之外的任何东西；
 *      secret 占位符命令传给 manager 的是还原后命令；危险命令照拒；
 *      backgroundManager 缺省 + background:true → ToolExecutionError；
 *      spawn_error → ToolExecutionError（kind 渲染）；前台路径（background
 *      缺省/false）走既有一字不改路径且 manager 不被调用。前台零回归由
 *      tests/harness/aci/tools/bash.test.ts 兜底。
 *   2. 真实进程 e2e（真 manager + defaultBackgroundSpawn，skipIf(!hasBwrap())
 *      守卫照 bash-sandbox.test.ts 惯例）：长驻子进程（sleep 300）→ handler
 *      毫秒级返回 task_id → 子进程在 handler 返回后仍存活（manager.status =
 *      running + 进程组探测）→ 收尾 manager.stop → 进程组消失。
 *   3. tier 语义对照：createAciExecutor 的 timeoutMsOverride 测试 seam
 *      （interrupt-routing.test.ts 先例）把 bash tier 压到 500ms —— 前台对照
 *      调用（sleep 300）被 tier 超时治理（execution_failed: timeout），而
 *      background 调用立即返 ok 且子进程存活（不被 tier 治理）。build tier
 *      真值 300s 由 TIMEOUT_TIER_MS SSOT 保证（types.ts:32-38），本测试只用
 *      seam 缩时，不实等 300s。
 *   4. fresh workspace-root 端到端（test.md 命令 handler 契约）：temp dir
 *      workspaceRoot 上 spawn → registry json 读回一致 → stop 收尾。
 *
 * bwrap 依赖：createBashTool 构造期 requireBwrap() 守卫（bash.ts:45），故本
 * 文件与既有 bash.test.ts / bash-sandbox.test.ts 同性质 —— 有 bwrap 的本地
 * WSL 全量验证；CI 排除集应收录本文件（与 utils bash.test.ts 同级，runner 无
 * user-namespace）。
 */

import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";

import { ToolExecutionError } from "../../../src/harness/errors.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
} from "../../../src/harness/background/manager.ts";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.ts";
import { resolveTasksDir } from "../../../src/harness/background/paths.ts";
import { createSecretRegistry } from "../../../src/harness/secret-roundtrip/index.ts";

const scratchPaths: string[] = [];

async function makeScratch(prefix: string): Promise<string> {
  const p = await mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(p);
  return p;
}

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

function hasBwrap(): boolean {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/** fake BackgroundTaskManager —— 只观察 spawn 入参，child 永不 exit。 */
function makeFakeManager(): {
  manager: BackgroundTaskManager;
  spawn: ReturnType<typeof vi.fn>;
} {
  const spawn = vi.fn();
  const manager = {
    spawn: spawn as unknown as BackgroundTaskManager["spawn"],
    status: vi.fn(async () => ({
      status: "running",
      task_id: "bg-0123456789ab",
      exit_code: null,
      command: "",
    })),
    output: vi.fn(),
    stop: vi.fn(async () => undefined),
  } satisfies BackgroundTaskManager;
  return { manager, spawn };
}

/** fake ChildProcess —— EventEmitter + PassThrough,真实 fs 落盘路径用。 */
interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
}

function makeFakeBgChild(pid = 54321): FakeChild {
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill,
  }) as unknown as FakeChild;
}

interface BashResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// ── 1.schema ──────────────────────────────────────────────────────────────────

describe("bash background schema", () => {
  it("inputSchema 显式声明 background?: boolean（additionalProperties:false）", async () => {
    const cwd = await makeScratch("bash-bg-schema-");
    const tool = createBashTool(cwd);
    const properties = (
      tool.inputSchema as { properties: Record<string, { type: string }> }
    ).properties;
    assert.equal(properties.command.type, "string");
    assert.equal(properties.background.type, "boolean");
    assert.equal(
      (tool.inputSchema as { additionalProperties: boolean })
        .additionalProperties,
      false
    );
  });
});

// ── 2.单元面：fake manager ────────────────────────────────────────────────────

describe("bash background handler（fake manager）", () => {
  it("background:true → 立即返回 {task_id, log_path}，child 永不 exit 也返回", async () => {
    const cwd = await makeScratch("bash-bg-fake-");
    const { manager, spawn } = makeFakeManager();
    spawn.mockResolvedValue({
      status: "ok",
      task_id: "bg-0123456789ab",
      log_path: "/tmp/tasks/bg-0123456789ab.log",
    });
    const tool = createBashTool(cwd, { backgroundManager: manager });

    const result = await tool.handler({
      command: "sleep 300",
      background: true,
    });

    assert.deepEqual(result, {
      task_id: "bg-0123456789ab",
      log_path: "/tmp/tasks/bg-0123456789ab.log",
    });
  });

  it("manager.spawn 延迟 resolve 只拖住 spawn 自身的延迟，handler 不额外等待", async () => {
    const cwd = await makeScratch("bash-bg-delay-");
    const { manager, spawn } = makeFakeManager();
    spawn.mockImplementation(
      async () =>
        new Promise((resolve) =>
          setTimeout(() => {
            resolve({
              status: "ok",
              task_id: "bg-0123456789ab",
              log_path: "/tmp/tasks/bg-0123456789ab.log",
            });
          }, 150)
        )
    );
    const tool = createBashTool(cwd, { backgroundManager: manager });

    const start = Date.now();
    await tool.handler({ command: "sleep 300", background: true });
    const elapsed = Date.now() - start;

    // handler 收束时间 ≈ spawn 自身延迟（150ms），远小于任何 tier
    // （fast=5s / build=5min）。若 handler 额外 await 子进程，会远超此界。
    assert.ok(
      elapsed >= 150 && elapsed < 1_500,
      `handler should settle right after spawn resolves, got ${elapsed}ms`
    );
  });

  it("secret 占位符命令：spawn 工厂收还原后真值（沙箱执行）,recordCommand 传原始占位符（落盘）", async () => {
    const cwd = await makeScratch("bash-bg-secret-");
    const { manager, spawn } = makeFakeManager();
    spawn.mockResolvedValue({
      status: "ok",
      task_id: "bg-0123456789ab",
      log_path: "/tmp/tasks/bg-0123456789ab.log",
    });
    const registry = createSecretRegistry();
    registry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    const tool = createBashTool(cwd, {
      secretRegistry: registry,
      backgroundManager: manager,
    });

    const result = (await tool.handler({
      command: 'echo "<<<SECRET_1>>>"',
      background: true,
    })) as { task_id: string; log_path: string };

    assert.match(result.task_id, /^bg-[0-9a-f]{12}$/);
    const req = spawn.mock.calls[0]?.[0] as {
      command: string;
      recordCommand: string;
    };
    // #502 review-repair（#406 roundtrip）：spawn 工厂（沙箱执行）拿真值 —— 占位符不
    // 进 spawn 调用栈之外的任何路径。
    assert.equal(req.command, 'echo "sk-aaaaaaaaaaaaaaaaaaaa"');
    assert.equal(req.command.includes("<<<SECRET_1>>>"), false);
    assert.equal(req.command.includes("sk-aaaaaaaaaaaaaaaaaaaa"), true);
    // recordCommand = 原始入参（占位符形态,落盘用）—— manager 据此落 registry json,
    // 真值不上盘。
    assert.equal(req.recordCommand, 'echo "<<<SECRET_1>>>"');
    assert.equal(req.recordCommand.includes("sk-aaaaaaaaaaaaaaaaaaaa"), false);
    assert.equal(req.recordCommand.includes("<<<SECRET_1>>>"), true);
  });

  it("真实 manager：registry json 落盘 command = 占位符形态，真值不上盘（#406 roundtrip 契约锁盘面）", async () => {
    const root = await makeScratch("bash-bg-secret-disk-");
    const tasksDir = resolveTasksDir(root);
    const fakeChildren: FakeChild[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async () => {
        const child = makeFakeBgChild();
        fakeChildren.push(child);
        return child as unknown as ChildProcess;
      },
    });
    const registry = createSecretRegistry();
    registry.register("sk-aaaaaaaaaaaaaaaaaaaa");
    const tool = createBashTool(root, {
      secretRegistry: registry,
      backgroundManager: manager,
      workspaceRoot: root,
    });

    const res = (await tool.handler({
      command: 'echo "<<<SECRET_1>>>"',
      background: true,
    })) as { task_id: string; log_path: string };

    // spawn 后立即读盘 —— running 态 record 的 command 必须是占位符形态。
    const jsonPath = res.log_path.replace(/\.log$/, ".json");
    const runningRec = JSON.parse(await readFile(jsonPath, "utf8")) as {
      command: string;
      task_id: string;
      status: string;
    };
    assert.equal(runningRec.task_id, res.task_id);
    assert.equal(runningRec.status, "running");
    assert.equal(runningRec.command, 'echo "<<<SECRET_1>>>"');
    assert.ok(!runningRec.command.includes("sk-aaaaaaaaaaaaaaaaaaaa"));
    assert.ok(runningRec.command.includes("<<<SECRET_1>>>"));

    // settle 路径同样走 persistCommand —— 触发 exit 后 status 转 exited,
    // 读盘 record 的 command 仍为占位符形态（不还原为真值）。settle 是
    // 异步落盘,await waitFor 直至 json 收敛到 exited 状态（writeFile 默认
    // O_TRUNC,settle 进行中文件可能瞬时为空,不可裸读）。
    fakeChildren[0]!.emit("exit", 0, null);
    const settledRec = await vi.waitFor(async () => {
      const rec = JSON.parse(await readFile(jsonPath, "utf8")) as {
        command: string;
        status: string;
      };
      assert.equal(rec.status, "exited");
      return rec;
    });
    assert.equal(settledRec.command, 'echo "<<<SECRET_1>>>"');
    assert.ok(!settledRec.command.includes("sk-aaaaaaaaaaaaaaaaaaaa"));
  });

  it("secretRegistry 缺省（无占位符场景）→ recordCommand === command,缺省回退路径等价", async () => {
    const cwd = await makeScratch("bash-bg-secret-default-");
    const { manager, spawn } = makeFakeManager();
    spawn.mockResolvedValue({
      status: "ok",
      task_id: "bg-0123456789ab",
      log_path: "/tmp/tasks/bg-0123456789ab.log",
    });
    const tool = createBashTool(cwd, { backgroundManager: manager });

    await tool.handler({ command: "echo plain", background: true });
    const req = spawn.mock.calls[0]?.[0] as {
      command: string;
      recordCommand: string;
    };
    // 无 secret registry：bash 透传 command 不还原；recordCommand 字段值与
    // command 字面相同，manager 侧 `recordCommand ?? command` 取相同结果，
    // 落盘行为与既有路径逐字节一致（其他手写调用方缺省 recordCommand 走
    // `request.command` 回退，兼容性保持）。
    assert.equal(req.command, "echo plain");
    assert.equal(req.recordCommand, "echo plain");
  });

  it("background:true + 危险命令照拒（ToolExecutionError，与前台同闸门）", async () => {
    const cwd = await makeScratch("bash-bg-danger-");
    const { manager, spawn } = makeFakeManager();
    const tool = createBashTool(cwd, { backgroundManager: manager });

    await assert.rejects(
      tool.handler({ command: "echo rm -rf /", background: true }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("bash: dangerous command rejected")
    );
    assert.equal(spawn.mock.calls.length, 0);
  });

  it("background:true 且 backgroundManager 缺省 → ToolExecutionError（不静默退化成前台）", async () => {
    const cwd = await makeScratch("bash-bg-no-mgr-");
    const tool = createBashTool(cwd);

    await assert.rejects(
      tool.handler({ command: "sleep 300", background: true }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("background")
    );
  });

  it("manager.spawn 返回 spawn_error → ToolExecutionError（kind 渲染，与 bash 既有错误形态一致）", async () => {
    const cwd = await makeScratch("bash-bg-spawnerr-");
    const { manager, spawn } = makeFakeManager();
    spawn.mockResolvedValue({
      status: "spawn_error",
      task_id: "bg-0123456789ab",
      error: {
        kind: "io_failure",
        context: "save bg-0123456789ab",
        cause: "ENOTDIR",
      },
    });
    const tool = createBashTool(cwd, { backgroundManager: manager });

    await assert.rejects(
      tool.handler({ command: "sleep 300", background: true }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("io_failure: save bg-0123456789ab")
    );
  });

  it("前台路径（background 缺省 / false）走既有行为且 manager.spawn 不被调用", async () => {
    const cwd = await makeScratch("bash-bg-foreground-");
    const { manager, spawn } = makeFakeManager();
    const tool = createBashTool(cwd, { backgroundManager: manager });

    const result = (await tool.handler({
      command: "echo foreground",
    })) as BashResult;
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "foreground\n");

    const result2 = (await tool.handler({
      command: "echo foreground-false",
      background: false,
    })) as BashResult;
    assert.equal(result2.code, 0);
    assert.equal(result2.stdout, "foreground-false\n");

    assert.equal(spawn.mock.calls.length, 0);
  });
});

// ── 3.真实进程 e2e（真 manager + defaultBackgroundSpawn）──────────────────────
// 注：真实 registry 落盘走 fake child（不用 defaultBackgroundSpawn）的
// createBackgroundTaskManager+真实 fs 由 manager.test.ts 覆盖；本节聚焦
// handler ↔ defaultBackgroundSpawn 的物理链路。

describe("bash background 真实进程 e2e（defaultBackgroundSpawn）", () => {
  it.skipIf(!hasBwrap())(
    "长驻 sleep:handler 毫秒级返回 task_id → 子进程存活 → stop 清理进程组",
    async () => {
      const root = await makeScratch("bash-bg-real-");
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir(root),
        spawn: defaultBackgroundSpawn,
      });
      const tool = createBashTool(root, {
        backgroundManager: manager,
        workspaceRoot: root,
      });

      const start = Date.now();
      const res = (await tool.handler({
        command: "sleep 300",
        background: true,
      })) as { task_id: string; log_path: string };
      const elapsed = Date.now() - start;

      assert.match(res.task_id, /^bg-[0-9a-f]{12}$/);
      // 毫秒级返回：bwrap 启动链 + registry 落盘，远小于任何 tier（fast=5s）。
      assert.ok(
        elapsed < 3_000,
        `handler should return in ms after background spawn, got ${elapsed}ms`
      );

      // registry json 落盘 + 读回一致（spawn → registry 同步契约）
      const jsonPath = res.log_path.replace(/\.log$/, ".json");
      const rec = JSON.parse(await readFile(jsonPath, "utf8")) as {
        status: string;
        pgid: number;
        command: string;
        owner_pid: number;
      };
      assert.equal(rec.command, "sleep 300");
      assert.equal(rec.owner_pid, process.pid);
      const pgid = rec.pgid;

      // 子进程在 handler 返回后仍存活：manager 内存态 running + 进程组探测
      const st = await manager.status(res.task_id);
      assert.equal(st.status, "running");
      assert.doesNotThrow(() => process.kill(-pgid, 0), "进程组应存活");

      // 收尾：host 侧 stop → 进程组消失
      await manager.stop(res.task_id);
      await waitForGroupExit(pgid);
      const after = await manager.status(res.task_id);
      assert.equal(after.status, "killed");
    },
    10_000
  );

  it.skipIf(!hasBwrap())(
    "fresh workspace-root 端到端：spawn → registry json 读回 → stop 全程",
    async () => {
      const root = await makeScratch("bash-bg-fresh-");
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir(root),
        spawn: defaultBackgroundSpawn,
      });
      const tool = createBashTool(root, {
        backgroundManager: manager,
        workspaceRoot: root,
      });

      const res = (await tool.handler({
        command: "sleep 120",
        background: true,
      })) as { task_id: string; log_path: string };
      const jsonPath = res.log_path.replace(/\.log$/, ".json");
      const rec = JSON.parse(await readFile(jsonPath, "utf8")) as {
        task_id: string;
        log_path: string;
        status: string;
        pgid: number;
      };
      assert.equal(rec.task_id, res.task_id);
      assert.equal(rec.log_path, res.log_path);
      assert.equal(rec.status, "running");
      await manager.stop(res.task_id);
      await waitForGroupExit(rec.pgid);
    },
    10_000
  );
});

// ── 4.tier 语义对照：timeoutMsOverride 把 bash tier 压到 500ms ────────────────

describe("bash background tier 对照（timeoutMsOverride seam）", () => {
  const hasBwrapHere = hasBwrap();

  async function runBashViaAci(
    toolFoo: ReturnType<typeof createBashTool>,
    input: Record<string, unknown>,
    timeoutMsOverride: number
  ): Promise<{ result: ToolExecutionResult; elapsedMs: number }> {
    const inner: Executor = Object.freeze({
      executeAll: async (
        calls: ReadonlyArray<ToolCall>,
        signal?: AbortSignal
      ): Promise<ReadonlyArray<ToolExecutionResult>> => {
        const call = calls[0]!;
        const payload = await toolFoo.handler(call.input, { signal });
        const text =
          typeof payload === "string" ? payload : JSON.stringify(payload);
        return [
          {
            kind: "ok",
            toolUseId: call.id,
            payload: [{ type: "text", text }],
          },
        ];
      },
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: Object.freeze({
        get: (n: string) => (n === "bash" ? toolFoo : undefined),
        all: () => Object.freeze([toolFoo]) as ReadonlyArray<typeof toolFoo>,
      }),
      // 测试 seam：build tier 真值 300s 由 TIMEOUT_TIER_MS SSOT 保证，
      // 此处只缩时测试 tier 治理语义，不实等 300s。
      timeoutMsOverride,
    });
    const start = Date.now();
    const results = await aciExec.executeAll([
      { id: "u1", name: "bash", input },
    ]);
    return { result: results[0]!, elapsedMs: Date.now() - start };
  }

  it.skipIf(!hasBwrapHere)(
    "前台 sleep 300 被 500ms tier 超时治理 → execution_failed:timeout",
    async () => {
      const cwd = await makeScratch("bash-bg-tier-fore-");
      const toolBar = createBashTool(cwd);
      const { result, elapsedMs } = await runBashViaAci(
        toolBar,
        { command: "sleep 300" },
        500
      );
      assert.ok(
        elapsedMs < 4_000,
        `expected tier timeout near 500ms+salvage, got ${elapsedMs}ms`
      );
      assert.equal(result.kind, "execution_failed");
      if (result.kind === "execution_failed") {
        assert.equal(result.message, "timeout");
      }
    }
  );

  it.skipIf(!hasBwrapHere)(
    "background sleep 300 经同一 aciExec 立即返 ok，且子进程存活（不被 tier 治理）",
    async () => {
      const root = await makeScratch("bash-bg-tier-bg-");
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir(root),
        spawn: defaultBackgroundSpawn,
      });
      const toolBaz = createBashTool(root, {
        backgroundManager: manager,
        workspaceRoot: root,
      });
      const { result, elapsedMs } = await runBashViaAci(
        toolBaz,
        { command: "sleep 300", background: true },
        500
      );
      assert.ok(
        elapsedMs < 2_000,
        `background call should return in ms (not governed by tier), got ${elapsedMs}ms`
      );
      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        const payload = JSON.parse(result.payload[0]!.text) as {
          task_id: string;
          log_path: string;
        };
        assert.match(payload.task_id, /^bg-[0-9a-f]{12}$/);
        // 子进程在 500ms tier 早已越过之后仍存活 —— background 不被 tier 治理。
        const st = await manager.status(payload.task_id);
        assert.equal(st.status, "running");
        const jsonPath = payload.log_path.replace(/\.log$/, ".json");
        const rec = JSON.parse(await readFile(jsonPath, "utf8")) as {
          pgid: number;
        };
        assert.doesNotThrow(() => process.kill(-rec.pgid, 0));
        await manager.stop(payload.task_id);
        await waitForGroupExit(rec.pgid);
      }
    }
  );
});

/** 进程组消失轮询（kill(-pgid,0) ESRCH 即组已消失）。 */
async function waitForGroupExit(pgid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process group ${pgid} remained alive`);
}
