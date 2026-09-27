/**
 * bash `background` parameter e2e (tracer bullet).
 *
 * Coverage:
 *   1. Unit face (fake manager): background:true → handler returns
 *      {task_id, log_path} immediately, awaiting nothing beyond the spawn itself;
 *      secret-placeholder commands hand the manager the restored command;
 *      dangerous commands are still rejected; missing backgroundManager +
 *      background:true → ToolExecutionError; spawn_error → ToolExecutionError
 *      (kind rendered); the foreground path (background absent/false) is the
 *      untouched existing path and never touches the manager. Foreground
 *      zero-regression is covered by tests/harness/aci/tools/bash.test.ts.
 *   2. Real-process e2e (real manager + defaultBackgroundSpawn,
 *      skipIf(!hasBwrap()) guard per bash-sandbox.test.ts convention): a
 *      long-lived child (sleep 300) → handler returns task_id in ms → child
 *      still alive after the handler returns (manager.status = running +
 *      process-group probe) → teardown manager.stop → process group gone.
 *   3. Tier semantics contrast: createAciExecutor's timeoutMsOverride test seam
 *      (precedent: interrupt-routing.test.ts) squeezes the bash tier to 500ms —
 *      the foreground contrast call (sleep 300) is governed by the tier timeout
 *      (execution_failed: timeout), while the background call returns ok
 *      immediately and the child survives (tier does not govern it). The real
 *      build tier value of 300s is guaranteed by the TIMEOUT_TIER_MS SSOT
 *      (types.ts:32-38); this test only shortens time via the seam, never
 *      waits a real 300s.
 *   4. Fresh workspace-root end to end (test.md command-handler contract):
 *      spawn on a temp-dir workspaceRoot → registry json reads back consistent
 *      → stop teardown.
 *
 * bwrap dependency: createBashTool calls requireBwrap() at construction
 * (bash.ts:45), so this file shares the nature of bash.test.ts /
 * bash-sandbox.test.ts — verified in full on local WSL with bwrap; the CI
 * exclude set should include this file (same class as utils bash.test.ts;
 * runners lack user-namespace).
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

/** fake BackgroundTaskManager — observes spawn args only; child never exits. */
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

/** fake ChildProcess — EventEmitter + PassThrough, for real fs persistence paths. */
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

/** bash handler returns an envelope `{ output, meta? }`; the foreground path
 *  keeps the existing BashResult contract (this helper just parses once more),
 *  while the background path returns `{ task_id, log_path }`, which does not
 *  collide with the envelope, so the original assertions stay as they are. */
interface BashEnvelope {
  readonly output: string;
  readonly meta?: { readonly stdout?: string; readonly stderr?: string };
}
function parseBashEnvelope(envelope: BashEnvelope): BashResult {
  return JSON.parse(envelope.output) as BashResult;
}

// ── 1. schema ──────────────────────────────────────────────────────────────────

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

// ── 2. unit face: fake manager ─────────────────────────────────────────────────

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

    // handler settles right after spawn's own delay (150ms), far below any tier
    // (fast=5s / build=5min). If it additionally awaited the child, it would blow past this bound.
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
    // roundtrip contract: the spawn factory (sandbox execution) gets the real
    // value — the placeholder must never reach any path outside the spawn call stack.
    assert.equal(req.command, 'echo "sk-aaaaaaaaaaaaaaaaaaaa"');
    assert.equal(req.command.includes("<<<SECRET_1>>>"), false);
    assert.equal(req.command.includes("sk-aaaaaaaaaaaaaaaaaaaa"), true);
    // recordCommand = the raw input (placeholder form, for persistence) — the
    // manager writes it into the registry json, so the real value never hits disk.
    assert.equal(req.recordCommand, 'echo "<<<SECRET_1>>>"');
    assert.equal(req.recordCommand.includes("sk-aaaaaaaaaaaaaaaaaaaa"), false);
    assert.equal(req.recordCommand.includes("<<<SECRET_1>>>"), true);
  });

  it("真实 manager：registry json 落盘 command = 占位符形态，真值不上盘（#406 roundtrip 契约锁盘面）", async () => {
    const root = await makeScratch("bash-bg-secret-disk-");
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
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

    // read the disk right after spawn — the running record's command must be in placeholder form.
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

    // the settle path also goes through persistCommand — after exit fires,
    // status flips to exited and the on-disk record's command is still the
    // placeholder form (never restored to the real value). Settle persists
    // asynchronously, so waitFor until the json converges to exited
    // (writeFile defaults to O_TRUNC; the file may be transiently empty
    // mid-settle and cannot be read bare).
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
    // No secret registry: bash passes command through unrestored; recordCommand
    // is literally identical to command, so the manager's
    // `recordCommand ?? command` yields the same result and persistence is
    // byte-identical to the existing path (hand-written callers that omit
    // recordCommand still fall back to `request.command`, keeping compatibility).
    assert.equal(req.command, "echo plain");
    assert.equal(req.recordCommand, "echo plain");
  });

  it("background:true + 危险命令照拒（ToolExecutionError，与前台同闸门）", async () => {
    const cwd = await makeScratch("bash-bg-danger-");
    const { manager, spawn } = makeFakeManager();
    const tool = createBashTool(cwd, { backgroundManager: manager });

    // A real destructive argv: the wall answers nothing for an inert
    // `echo rm -rf /` anymore. The target does not exist, so a wall that
    // stopped rejecting could still not destroy anything from this scratch dir.
    await assert.rejects(
      tool.handler({
        command: "rm -rf ./bash-bg-danger-nonexistent",
        background: true,
      }),
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

    const result = parseBashEnvelope(
      (await tool.handler({
        command: "echo foreground",
      })) as BashEnvelope
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "foreground\n");

    const result2 = parseBashEnvelope(
      (await tool.handler({
        command: "echo foreground-false",
        background: false,
      })) as BashEnvelope
    );
    assert.equal(result2.code, 0);
    assert.equal(result2.stdout, "foreground-false\n");

    assert.equal(spawn.mock.calls.length, 0);
  });
});

// ── 3. real-process e2e (real manager + defaultBackgroundSpawn) ────────────────
// Note: real registry persistence via a fake child (without
// defaultBackgroundSpawn) through createBackgroundTaskManager + real fs is
// covered by manager.test.ts; this section focuses on the physical chain
// handler ↔ defaultBackgroundSpawn.

describe("bash background 真实进程 e2e（defaultBackgroundSpawn）", () => {
  it.skipIf(!hasBwrap())(
    "长驻 sleep:handler 毫秒级返回 task_id → 子进程存活 → stop 清理进程组",
    async () => {
      const root = await makeScratch("bash-bg-real-");
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
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
      // millisecond-level return: bwrap launch chain + registry persistence, far below any tier (fast=5s).
      assert.ok(
        elapsed < 3_000,
        `handler should return in ms after background spawn, got ${elapsed}ms`
      );

      // registry json persisted + reads back consistent (spawn → registry sync contract)
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

      // child still alive after the handler returned: manager in-memory running + process-group probe
      const st = await manager.status(res.task_id);
      assert.equal(st.status, "running");
      assert.doesNotThrow(() => process.kill(-pgid, 0), "进程组应存活");

      // teardown: host-side stop → process group gone
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
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
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

// ── 4. tier semantics contrast: timeoutMsOverride squeezes the bash tier to 500ms ─

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
      // Test seam: the real build-tier value of 300s is guaranteed by the
      // TIMEOUT_TIER_MS SSOT; here we only shorten time to test tier-governance
      // semantics, without waiting a real 300s.
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
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
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
        // the child outlives the long-passed 500ms tier — background is not tier-governed.
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

/** Poll for process-group disappearance (kill(-pgid,0) raising ESRCH = group gone). */
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
