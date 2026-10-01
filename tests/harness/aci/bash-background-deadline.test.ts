/**
 * bash `background` + `timeout_ms` (ADR-0134, spec Success Criterion 9).
 *
 * The handler face: `timeout_ms` travels BashInput → inputSchema →
 * BackgroundSpawnRequest.timeoutMs → the manager's launch-time deadline.
 * Invalid values fail before launch (no process, no registry entry, no
 * timer); omission leaves the persistent-service request byte-compatible.
 *
 * Real-process cases are bwrap-gated, following bash-background.test.ts.
 */
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it, vi } from "vitest";

import { ToolExecutionError } from "../../../src/harness/errors.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import {
  createBackgroundTaskManager,
  defaultBackgroundSpawn,
} from "../../../src/harness/background/manager.ts";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.ts";
import { resolveTasksDir } from "../../../src/harness/background/paths.ts";

const scratchPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchPaths
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true }))
  );
});

async function makeScratch(prefix: string): Promise<string> {
  const p = await fs.mkdtemp(join(tmpdir(), prefix));
  scratchPaths.push(p);
  return p;
}

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  capMs = 5_000
): Promise<T> {
  const deadline = Date.now() + capMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor: cap exceeded");
    await sleep(20);
  }
}

function makeFakeChild(pid: number): EventEmitter & { pid: number } {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
}

// ── schema ────────────────────────────────────────────────────────────────────

describe("bash inputSchema: timeout_ms", () => {
  it("声明 timeout_ms 正整数，background 描述指向它", async () => {
    const cwd = await makeScratch("bash-tmo-schema-");
    const tool = createBashTool(cwd);
    const schema = tool.inputSchema as {
      properties: Record<
        string,
        { type?: string; description?: string; minimum?: number }
      >;
      additionalProperties: boolean;
    };
    assert.equal(schema.properties.timeout_ms?.type, "integer");
    assert.equal(schema.properties.timeout_ms?.minimum, 1);
    assert.equal(schema.additionalProperties, false);
    assert.match(
      schema.properties.background?.description ?? "",
      /timeout_ms/
    );
  });

  it("工具描述不再声称后台进程『在 build-tier timeout 之外永续运行』，改为 timeout_ms 契约", async () => {
    const cwd = await makeScratch("bash-tmo-desc-");
    const tool = createBashTool(cwd);
    assert.doesNotMatch(
      tool.description,
      /outside the build-tier timeout/
    );
    assert.match(tool.description, /timeout_ms/);
  });
});

// ── handler → spawn request plumbing ──────────────────────────────────────────

describe("bash background timeout_ms 贯通", () => {
  function makeRecordingManager(): {
    manager: BackgroundTaskManager;
    requests: { timeoutMs?: number }[];
  } {
    const requests: { timeoutMs?: number }[] = [];
    const spawn = vi.fn(async (req: { timeoutMs?: number }) => {
      requests.push(req);
      return {
        status: "ok" as const,
        task_id: "bg-0123456789ab",
        log_path: "/tmp/tasks/bg-0123456789ab.log",
      };
    });
    const manager = {
      spawn: spawn as unknown as BackgroundTaskManager["spawn"],
      status: vi.fn(),
      output: vi.fn(),
      stop: vi.fn(),
    } as unknown as BackgroundTaskManager;
    return { manager, requests };
  }

  it("background:true + timeout_ms → manager 收到 timeoutMs", async () => {
    const cwd = await makeScratch("bash-tmo-pass-");
    const { manager, requests } = makeRecordingManager();
    const tool = createBashTool(cwd, { backgroundManager: manager });

    const res = (await tool.handler({
      command: "sleep 300",
      background: true,
      timeout_ms: 30_000,
    })) as { task_id: string };

    assert.equal(res.task_id, "bg-0123456789ab");
    assert.equal(requests[0]?.timeoutMs, 30_000);
  });

  it("background:true 省略 timeout_ms → 请求不带该字段（持久服务形态）", async () => {
    const cwd = await makeScratch("bash-tmo-omit-");
    const { manager, requests } = makeRecordingManager();
    const tool = createBashTool(cwd, { backgroundManager: manager });

    await tool.handler({ command: "sleep 300", background: true });
    assert.equal(
      requests[0]?.timeoutMs,
      undefined,
      "omission must not synthesise a timeout"
    );
    assert.equal("timeoutMs" in requests[0]!, false);
  });

  it("timeout_ms 非法值 → ToolExecutionError，manager.spawn 从未被调用", async () => {
    const cwd = await makeScratch("bash-tmo-invalid-");
    const spawn = vi.fn();
    const manager = {
      spawn: spawn as unknown as BackgroundTaskManager["spawn"],
      status: vi.fn(),
      output: vi.fn(),
      stop: vi.fn(),
    } as unknown as BackgroundTaskManager;
    const tool = createBashTool(cwd, { backgroundManager: manager });

    for (const value of [0, -1, 1.5, "500", null, true]) {
      await assert.rejects(
        tool.handler({
          command: "sleep 300",
          background: true,
          timeout_ms: value,
        }),
        (error: unknown) =>
          error instanceof ToolExecutionError &&
          /timeout_ms/.test(error.message)
      );
    }
    assert.equal(spawn.mock.calls.length, 0);
  });

  it("真实 manager：非法 timeout_ms 不创建 registry 条目", async () => {
    const root = await makeScratch("bash-tmo-invalid-real-");
    const tasksDir = resolveTasksDir({ dataDir: root, projectIdentityRoot: root });
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async () => makeFakeChild(31_000) as unknown as ChildProcess,
    });
    const tool = createBashTool(root, {
      backgroundManager: manager,
      workspaceRoot: root,
    });

    await assert.rejects(
      tool.handler({ command: "sleep 300", background: true, timeout_ms: 0 }),
      (error: unknown) => error instanceof ToolExecutionError
    );
    assert.deepEqual(await fs.readdir(tasksDir).catch(() => [] as string[]), []);
  });
});

// ── real process e2e ──────────────────────────────────────────────────────────

describe("bash background 有限 deadline 真实进程 e2e", () => {
  it.skipIf(!hasBwrap())(
    "timeout_ms 到期 → 进程组被杀，status 报 deadline_expired + confirmed_stopped",
    async () => {
      const root = await makeScratch("bash-tmo-real-");
      const manager = createBackgroundTaskManager({
        tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
        spawn: defaultBackgroundSpawn,
      });
      const tool = createBashTool(root, {
        backgroundManager: manager,
        workspaceRoot: root,
      });

      const res = (await tool.handler({
        command: "sleep 300",
        background: true,
        timeout_ms: 700,
      })) as { task_id: string; log_path: string };

      const rec = JSON.parse(
        await fs.readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
      ) as { pgid: number; timeout_ms: number; deadline_at: string };
      assert.equal(rec.timeout_ms, 700);
      const pgid = rec.pgid;
      assert.doesNotThrow(() => process.kill(-pgid, 0));

      const settled = await waitFor(async () => {
        const s = await manager.status(res.task_id);
        return s.status !== "running" ? s : undefined;
      }, 8_000);
      assert.equal(settled.cause, "deadline_expired");

      await waitFor(async () => {
        try {
          process.kill(-pgid, 0);
          return undefined;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw e;
        }
      });
      const final = await waitFor(async () => {
        const s = await manager.status(res.task_id);
        return s.cleanup.state !== "not_started" ? s : undefined;
      }, 5_000);
      assert.equal(final.cleanup.state, "confirmed_stopped");
      if (final.cleanup.state === "confirmed_stopped") {
        assert.equal(final.cleanup.pgid, pgid);
        assert.equal(final.cleanup.task_id, res.task_id);
      }
    },
    25_000
  );
});
