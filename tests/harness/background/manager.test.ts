/**
 * Unit tests for BackgroundTaskManager + registry persistence.
 *
 * Covers the boundary classes required by the acceptance list (no real child
 * processes; fake spawn factory):
 *   1. happy path: fake spawn -> spawn returns {task_id, log_path} -> registry
 *      json reads back identically (stdout/stderr flow into the log)
 *   2. log tail read: oversized log returns only the tail window, with status/exitCode
 *   3. empty task_id -> empty_task_id (typed)
 *   4. unknown task_id -> task_not_found (typed)
 *   5. concurrent duplicate: two parallel stops of one task -> idempotent, second call deterministic
 *   6. kill race: stop on an already-exited task -> idempotent success (no further signals)
 *   7. persistence IO failure: registry save/load fs errors -> io_failure (typed)
 *
 * Fake ChildProcess follows the precedent in tests/subagent/manager.test.ts:
 * EventEmitter + PassThrough stdin/stdout/stderr + kill spy.
 * Registry / log persistence uses the real fs (mkdtemp dir, cleaned in afterAll).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { createBackgroundRegistry } from "../../../src/harness/background/registry.js";
import { EventEmitter } from "node:events";
import { writeFile as fsWriteFile } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";

import {
  createBackgroundTaskManager,
  DEFAULT_LOG_MAX_BYTES,
} from "../../../src/harness/background/manager.js";
import type { BackgroundTaskManager } from "../../../src/harness/background/manager.js";
import { renderTaskError } from "../../../src/harness/background/registry.js";
import { resolveTasksDir } from "../../../src/harness/background/paths.js";
import { resolveProjectSessionDir } from "../../../src/session-api/store/session-store.js";

// ── fake ChildProcess factory (same shape as subagent/manager.test.ts) ─────────

interface FakeChild {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly pid: number;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
  once: (event: string | symbol, ...args: unknown[]) => unknown;
}

function makeFakeChild(pid = 12345): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    pid,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as FakeChild;
}

// ── per-run temp root for real-fs registry/log persistence ─────────────────────

const tempRoots: string[] = [];

async function makeManager(opts?: {
  tasksDir?: string;
}): Promise<{ manager: BackgroundTaskManager; spawned: FakeChild[] }> {
  const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-"));
  tempRoots.push(root);
  const spawned: FakeChild[] = [];
  const manager = createBackgroundTaskManager({
    tasksDir:
      opts?.tasksDir ??
      resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
    spawn: async (_req) => {
      const child = makeFakeChild();
      child.pid = 12345 + spawned.length;
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
  });
  return { manager, spawned };
}

afterEach(() => {
  // Clear kill-fallback timers armed by stop escalation (they keep the loop alive if unref'd).
  vi.clearAllTimers();
});

// ── 1. happy path ──────────────────────────────────────────────────────────────

describe("BackgroundTaskManager 正常路径", () => {
  it("spawn 返回 {task_id, log_path},registry json 读回字段全对齐", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({
      command: "python3 -m http.server 8123",
      cwd: process.cwd(),
    });
    assert.match(res.task_id, /^bg-[0-9a-f]{12}$/);
    assert.ok(res.log_path.endsWith(`/${res.task_id}.log`));

    const status = await manager.status(res.task_id);
    assert.equal(status.status, "running");
    assert.equal(status.task_id, res.task_id);

    // Read back the persisted json; every field must match.
    const jsonPath = res.log_path.replace(/\.log$/, ".json");
    const raw = await fs.readFile(jsonPath, "utf8");
    const rec = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(rec.task_id, res.task_id);
    assert.equal(rec.command, "python3 -m http.server 8123");
    assert.equal(rec.owner_pid, process.pid);
    assert.equal(rec.pgid, 12345);
    assert.equal(rec.status, "running");
    assert.equal(rec.conversation_id, "");
    assert.equal(rec.log_path, res.log_path);
    assert.ok(typeof rec.created_at === "string");
    assert.ok(rec.created_at.length > 0);
  });

  it("recordCommand 缺省 → 落盘 command 回退为 request.command（其他调用方兼容，#502 review-repair #406 roundtrip 契约回退路径）", async () => {
    const { manager } = await makeManager();
    const res = await manager.spawn({ command: "echo fallback", cwd: "." });
    const rec = JSON.parse(
      await fs.readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as { command: string };
    // Without recordCommand: manager internally takes `request.recordCommand ?? request.command`,
    // so the persisted command = request.command. Existing callers that spawn
    // without recordCommand see zero regression.
    assert.equal(rec.command, "echo fallback");
  });

  it("recordCommand 存在 → 落盘 command = recordCommand,spawn 工厂仍收 command（真值不上盘）", async () => {
    // Custom manager: the spawn factory captures the request, proving the factory
    // receives the real value while the registry record stores the placeholder form.
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-record-"));
    tempRoots.push(root);
    let capturedRequest:
      | {
          command: string;
          recordCommand: string | undefined;
        }
      | undefined;
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({ dataDir: root, projectIdentityRoot: root }),
      spawn: async (req) => {
        capturedRequest = {
          command: req.command,
          recordCommand: req.recordCommand,
        };
        return makeFakeChild(55555) as unknown as ChildProcess;
      },
    });
    const res = await manager.spawn({
      command: 'echo "sk-real-secret"',
      recordCommand: 'echo "<<<SECRET_1>>>"',
      cwd: root,
    });
    assert.equal(res.status, "ok");

    // The spawn factory receives only request.command (the restored real value);
    // recordCommand exists on the request but never enters the spawn call stack.
    assert.ok(capturedRequest, "spawn factory must have captured request");
    assert.equal(capturedRequest!.command, 'echo "sk-real-secret"');
    assert.equal(capturedRequest!.recordCommand, 'echo "<<<SECRET_1>>>"');

    // Persisted JSON: command field = placeholder form; the real secret never reaches disk.
    const rec = JSON.parse(
      await fs.readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as { command: string };
    assert.equal(rec.command, 'echo "<<<SECRET_1>>>"');
    assert.ok(!rec.command.includes("sk-real-secret"));
    assert.ok(rec.command.includes("<<<SECRET_1>>>"));
  });

  it("stdout + stderr 合并流入 log 文件", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "echo hi", cwd: "." });
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stdout.write("hello\n", () => resolvePromise());
    });
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stderr.write("warn\n", () => resolvePromise());
    });
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stdout.write("tail", () => resolvePromise());
    });
    // No trailing newline: remaining buffer is flushed on exit.
    spawned[0]!.emit("exit", 0, null);
    const out = await manager.output(task_id);
    assert.equal(out.status, "exited");
    assert.equal(out.exit_code, 0);
    assert.equal(out.text, "hello\nwarn\ntail");
  });

  it("模拟 exit 状态迁移 → exited + exitCode 落 json", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id, log_path } = await manager.spawn({
      command: "exit 3",
      cwd: ".",
    });
    spawned[0]!.stdout.write("bye\n");
    spawned[0]!.emit("exit", 3, null);

    const status = await manager.status(task_id);
    assert.equal(status.status, "exited");
    assert.equal(status.exit_code, 3);

    await vi.waitFor(async () => {
      const rec = JSON.parse(
        await fs.readFile(log_path.replace(/\.log$/, ".json"), "utf8")
      ) as {
        status: string;
        exit_code: number;
      };
      assert.equal(rec.status, "exited");
      assert.equal(rec.exit_code, 3);
    });
  });
});

// ── 2. log tail read ───────────────────────────────────────────────────────────

describe("BackgroundTaskManager output 尾部读", () => {
  it("log 超过默认窗口只回尾部(<= limit)", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "tail", cwd: "." });
    const big = "x".repeat(DEFAULT_LOG_MAX_BYTES + 5000);
    await new Promise<void>((resolvePromise) => {
      spawned[0]!.stdout.write(big, () => resolvePromise());
    });
    spawned[0]!.emit("exit", 0, null);
    const out = await manager.output(task_id);
    assert.equal(out.status, "exited");
    assert.equal(out.exit_code, 0);
    assert.ok(
      out.text.length <= DEFAULT_LOG_MAX_BYTES,
      `len=${out.text.length}`
    );
    assert.equal(out.text.slice(-1), "x");
  });

  it("maxBytes 参数覆盖默认窗口", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "tail", cwd: "." });
    spawned[0]!.stdout.write("0123456789");
    spawned[0]!.emit("exit", 0, null);
    const out = await manager.output(task_id, 5);
    assert.equal(out.text, "56789");
  });
});

// ── 3. empty task_id → empty_task_id ───────────────────────────────────────────

describe("BackgroundTaskManager typed-error:空 task_id", () => {
  it('stop("") → 抛出 kind=empty_task_id', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.stop(""), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "empty_task_id");
      return true;
    });
  });

  it('status("") → 抛出 kind=empty_task_id', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.status(""), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "empty_task_id");
      return true;
    });
  });

  it('output("") → 抛出 kind=empty_task_id', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.output(""), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "empty_task_id");
      return true;
    });
  });
});

// ── 4. unknown task_id → task_not_found ────────────────────────────────────────

describe("BackgroundTaskManager typed-error:未知 task_id", () => {
  it('status("bg-unknown") → 抛出 kind=task_not_found', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.status("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "task_not_found");
      return true;
    });
  });

  it('output("bg-unknown") → 抛出 kind=task_not_found', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.output("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "task_not_found");
      return true;
    });
  });

  it('stop("bg-unknown") → 抛出 kind=task_not_found', async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.stop("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "task_not_found");
      return true;
    });
  });
});

// ── 5. concurrent duplicates ───────────────────────────────────────────────────

describe("BackgroundTaskManager 并发重复 stop", () => {
  it("同一 task 并发两次 stop → 都成功且 SIGTERM 次数有限", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "long", cwd: "." });
    const results = await Promise.allSettled([
      manager.stop(task_id),
      manager.stop(task_id),
    ]);
    // Both stops succeed (the manager serializes them internally).
    assert.equal(results[0]?.status, "fulfilled");
    assert.equal(results[1]?.status, "fulfilled");
    // INVARIANT: while the fake never exits, kill calls <= 2 (one SIGTERM round per stop)
    const sigterms = spawned[0]!.kill.mock.calls.filter(
      (c) => c[0] === "SIGTERM"
    ).length;
    assert.ok(sigterms >= 1 && sigterms <= 2, `sigterm count=${sigterms}`);
    // Cleanup: fake exits -> kill-fallback timer is cleared.
    spawned[0]!.emit("exit", null, "SIGTERM");
  });

  it("同一 task 并发两次 stop → 最终状态 killed", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "long", cwd: "." });
    await Promise.allSettled([manager.stop(task_id), manager.stop(task_id)]);
    spawned[0]!.emit("exit", null, "SIGTERM");
    const final = await manager.status(task_id);
    assert.equal(final.status, "killed");
  });
});

// ── 6. kill race (stop on a terminal task) ─────────────────────────────────────

describe("BackgroundTaskManager kill 竞态", () => {
  it("对已 exited 的 task stop → 幂等成功(不再发任何信号)", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "fast", cwd: "." });
    spawned[0]!.emit("exit", 0, null);
    const st = await manager.status(task_id);
    assert.equal(st.status, "exited");
    // Stop on a terminal task: idempotent success, no throw
    await manager.stop(task_id);
    // No additional signals sent
    assert.equal(spawned[0]!.kill.mock.calls.length, 0);
    const st2 = await manager.status(task_id);
    assert.equal(st2.status, "exited");
  });

  it("对已 killed 的任务 stop → 幂等成功", async () => {
    const { manager, spawned } = await makeManager();
    const { task_id } = await manager.spawn({ command: "fast", cwd: "." });
    // First stop: child gets SIGTERM then exits by signal -> terminal state
    await manager.stop(task_id);
    spawned[0]!.emit("exit", null, "SIGTERM");
    const st = await manager.status(task_id);
    assert.equal(st.status, "killed");
    // Second stop: idempotent success, no extra signal
    await manager.stop(task_id);
    const sigtermCount = spawned[0]!.kill.mock.calls.filter(
      (c) => c[0] === "SIGTERM"
    ).length;
    assert.equal(sigtermCount, 1);
  });
});

// ── 7. persistence IO failure ──────────────────────────────────────────────────

describe("BackgroundTaskManager 落盘 IO 失败", () => {
  it("tasksDir 不可写(父路径是文件) → spawn 返回 spawn_error 且 error.kind=io_failure", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-ro-"));
    tempRoots.push(root);
    const blocker = join(root, "blocker");
    await fsWriteFile(blocker, "file", "utf8");
    const tasksDir = join(blocker, "tasks"); // parent path is a file -> mkdir ENOTDIR
    const manager = createBackgroundTaskManager({
      tasksDir,
      spawn: async (_req) => makeFakeChild(1) as unknown as ChildProcess,
    });
    const res = await manager.spawn({ command: "x", cwd: "." });
    assert.equal(res.status, "spawn_error");
    const err = res.error as { kind?: string };
    assert.equal(err.kind, "io_failure");
  });

  it("registry save 遇 IO 错误 → io_failure(而非 crash)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-iofail-"));
    tempRoots.push(root);
    const blocker = join(root, "blocker");
    await fsWriteFile(blocker, "file", "utf8");
    const registry = createBackgroundRegistry({
      tasksDir: join(blocker, "tasks"),
    });
    await assert.rejects(
      registry.save({
        task_id: "bg-0123456789ab",
        command: "x",
        owner_pid: 1,
        conversation_id: "",
        pgid: 1,
        status: "running",
        exit_code: null,
        created_at: "now",
        log_path: "/none/tasks/bg-0123456789ab.log",
      }),
      (err: unknown) => {
        assert.equal((err as { kind?: string }).kind, "io_failure");
        return true;
      }
    );
  });

  it("registry load 遇到坏 JSON → 抛 kind=schema_invalid(registry 层职责)", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-badjson-"));
    tempRoots.push(root);
    const tasksDir = resolveTasksDir({
      dataDir: root,
      projectIdentityRoot: root,
    });
    await fs.mkdir(tasksDir, { recursive: true });
    await fsWriteFile(join(tasksDir, "bg-0123456789ab.json"), "{bad json");
    const registry = createBackgroundRegistry({ tasksDir });
    await assert.rejects(registry.load("bg-0123456789ab"), (err: unknown) => {
      assert.equal((err as { kind?: string }).kind, "schema_invalid");
      return true;
    });
  });
});

// ── typed-error catch contract: discriminate by kind, never by message string ──

describe("typed-error catch 契约(kind 判别)", () => {
  it("errors 带 kind + context 供判别渲染", async () => {
    const { manager } = await makeManager();
    await assert.rejects(manager.output("bg-ffffffffffff"), (err: unknown) => {
      const e = err as { kind?: string; context?: string };
      assert.equal(e.kind, "task_not_found");
      assert.ok(typeof e.context === "string");
      return true;
    });
  });

  it("renderTaskError 输出 `${kind}: ${context}` 形态", () => {
    assert.equal(
      renderTaskError({ kind: "task_not_found", context: "bg-x" }),
      "task_not_found: bg-x"
    );
    assert.equal(
      renderTaskError({
        kind: "io_failure",
        context: "save bg-x",
        cause: "EACCES",
      }),
      "io_failure: save bg-x"
    );
  });
});

// ── paths.ts pure functions ────────────────────────────────────────────────────

describe("paths.resolveTasksDir", () => {
  it("返回 <pool>/projects/<slug>/tasks，与 resolveProjectSessionDir 严格同树", () => {
    // ADR-0088: task records share the session pool's project tree. The slug
    // formula/cap are shared via `src/shared/project-slug.ts`; assert a
    // cross-function equality so drift on either side fails (previously each
    // test recomputed sha1 independently and stayed green while drifting).
    assert.equal(
      resolveTasksDir({ dataDir: "/home/x", projectIdentityRoot: "/repo" }),
      join(resolveProjectSessionDir("/home/x", "/repo"), "tasks")
    );
  });

  it("workspaceRoot 不再参与派生（多 checkout 共用一份账本）", () => {
    // ADR-0088: throwaway checkouts don't open a second live ledger — within the
    // same projectIdentityRoot, only a different dataDir switches pools; a
    // different workspace does not.
    const a = resolveTasksDir({
      dataDir: "/pool-a",
      projectIdentityRoot: "/repo",
    });
    const b = resolveTasksDir({
      dataDir: "/pool-a",
      projectIdentityRoot: "/repo",
    });
    assert.equal(a, b);
    assert.ok(!a.includes(".iknow/tasks"));
  });

  it("边界回归:121–255 字符的 projectIdentityRoot 两边都接受(review 抓到的区间)", () => {
    // paths.ts once capped at MAX_ROOT_DETAIL_CHARS=120 while session-store.ts
    // allowed 255: roots of 121-255 chars resolved a session dir but threw in
    // the registry, orphaning the ledger. Both now share
    // MAX_PROJECT_IDENTITY_ROOT_BYTES=255, so both must accept the same input.
    const longRoot = "/" + "a".repeat(254); // exactly 255 chars
    assert.equal(longRoot.length, 255);
    assert.doesNotThrow(() => resolveProjectSessionDir("/pool", longRoot));
    assert.doesNotThrow(() =>
      resolveTasksDir({ dataDir: "/pool", projectIdentityRoot: longRoot })
    );
    // Cross-function equality: the same long root must land in the same slug sibling dir.
    assert.equal(
      resolveTasksDir({ dataDir: "/pool", projectIdentityRoot: longRoot }),
      join(resolveProjectSessionDir("/pool", longRoot), "tasks")
    );
  });

  it("边界外:256 字符根两边一致拒绝(同一上限派生同一报错)", () => {
    const tooLong = "/" + "a".repeat(255); // 256 chars
    assert.equal(tooLong.length, 256);
    assert.throws(() => resolveProjectSessionDir("/pool", tooLong));
    assert.throws(() =>
      resolveTasksDir({ dataDir: "/pool", projectIdentityRoot: tooLong })
    );
  });

  it("缺根 / 空白 / 相对 / 超长 projectIdentityRoot → typed SessionRootError", () => {
    const cases: ReadonlyArray<string> = ["", "   ", "relative/path"];
    for (const bad of cases) {
      assert.throws(
        () => resolveTasksDir({ dataDir: "/pool", projectIdentityRoot: bad }),
        (err: unknown) => {
          const e = err as { name?: string; kind?: string };
          assert.equal(e.name, "SessionRootError");
          assert.ok(
            e.kind === "missing_root" || e.kind === "invalid_root",
            `unexpected kind: ${String(e.kind)}`
          );
          return true;
        }
      );
    }
  });
});

describe("registry 读回一致性(字段全对齐)", () => {
  it("conversationId 记账字段落盘", async () => {
    const { manager, spawned } = await makeManager();
    const res = await manager.spawn({
      command: "true",
      cwd: ".",
      conversationId: "conv-test-1",
    });
    const rec = JSON.parse(
      await fs.readFile(res.log_path.replace(/\.log$/, ".json"), "utf8")
    ) as Record<string, unknown>;
    assert.equal(rec.task_id, res.task_id);
    assert.equal(rec.command, "true");
    assert.equal(rec.conversation_id, "conv-test-1");
    assert.equal(rec.owner_pid, process.pid);
    assert.equal(rec.pgid, spawned[0]!.pid);
    assert.equal(rec.status, "running");
    assert.equal(rec.log_path, res.log_path);
    assert.ok(typeof rec.created_at === "string");
  });
});

// ── ADR-0097: egress-seam assembly unit tests ────────────────────────────────
//
// vi.doMock does not affect static imports, so use a top-level vi.mock whose
// factory reads the module-level mutable `nextCreateEgressImpl`; each test
// resets that variable before running. Verifies three things: fence-spec
// passthrough, dispose on settle, and start failure -> fail-closed (no seam,
// task still spawns).

const nextCreateEgressImpl: {
  current: () => Promise<unknown>;
} = { current: async () => undefined };

vi.mock("../../../src/harness/sandbox/egress/session.js", () => ({
  createEgressSession: async (_opts: unknown) => nextCreateEgressImpl.current(),
}));

describe("BackgroundTaskManager egress 缝装配 (ADR-0097 / T7)", () => {
  it("egressPolicy 缺省 → 不起 session,fence 不带 egress 缝", async () => {
    let capturedSpec: unknown = "sentinel";
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-egress-"));
    tempRoots.push(root);
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async (req) => {
        capturedSpec = req.egressSpec;
        const child = makeFakeChild();
        child.pid = 99999;
        return child as unknown as ChildProcess;
      },
    });
    await manager.spawn({
      command: "true",
      cwd: ".",
      // no egressPolicy → no session → no fence egress
    });
    assert.equal(capturedSpec, undefined);
  });

  it("egressPolicy 在场 + session.start 成功 → fence 带 egressSpec,settle 触发 dispose", async () => {
    const dispose = vi.fn(async () => undefined);
    const fakeSession = {
      spec: {
        unixSocketPath: "/tmp/iknow-egress-test.sock",
        sandboxLocalPort: 18080,
        env: { HTTP_PROXY: "http://127.0.0.1:18080" },
        innerBridgeScript: "",
        relayAssetsDir: "/test/iknow/vendor/egress-relay",
      },
      dispose,
    };
    nextCreateEgressImpl.current = async () => fakeSession;
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-egress-ok-"));
    tempRoots.push(root);
    const capturedSpec: unknown[] = [];
    const spawnedChildren: FakeChild[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async (req) => {
        capturedSpec.push(req.egressSpec);
        const child = makeFakeChild();
        child.pid = 88888;
        spawnedChildren.push(child);
        return child as unknown as ChildProcess;
      },
    });
    await manager.spawn({
      command: "true",
      cwd: ".",
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "bash:test",
        allowlistSource: "persisted",
      },
    });
    // The fence request receives the spec (shape passthrough, not a deep clone)
    assert.equal(capturedSpec.length, 1);
    assert.equal(capturedSpec[0], fakeSession.spec);
    assert.equal(dispose.mock.calls.length, 0);
    // child exit -> settle -> dispose fires exactly once
    const child = spawnedChildren[0]!;
    child.emit("exit", 0, null);
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(dispose.mock.calls.length, 1);
  });

  it("session.start 抛错 → 无 egressSpec 注入 fence,task 仍能正常 spawn (fail-closed)", async () => {
    // fail-closed: if createEgressSession throws (e.g. relay deps missing),
    // the manager attaches no spec to the fence request, so the fence runs
    // fully offline (V1 baseline) and the task still spawns normally.
    nextCreateEgressImpl.current = async () => {
      throw new Error("relay deps not found");
    };
    const root = await fs.mkdtemp(join(tmpdir(), "iknow-bg-egress-fail-"));
    tempRoots.push(root);
    const capturedSpec: unknown[] = [];
    const manager = createBackgroundTaskManager({
      tasksDir: resolveTasksDir({
        dataDir: root,
        projectIdentityRoot: root,
      }),
      spawn: async (req) => {
        capturedSpec.push(req.egressSpec);
        const child = makeFakeChild();
        child.pid = 77777;
        return child as unknown as ChildProcess;
      },
    });
    const res = await manager.spawn({
      command: "true",
      cwd: ".",
      egressPolicy: {
        allowedDomains: ["example.com"],
        deniedDomains: [],
        commandLabel: "bash:test",
        allowlistSource: "persisted",
      },
    });
    assert.equal(res.status, "ok");
    assert.equal(capturedSpec.length, 1);
    // start failed -> manager keeps the fence request spec-free
    assert.equal(capturedSpec[0], undefined);
  });
});
