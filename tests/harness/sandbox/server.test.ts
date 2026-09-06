/**
 * ADR-0045 — sandbox 执行面 server 化(T8 实施)合同测试。
 *
 * 覆盖 ADR-0045 §4 四类故障路径(overflow 已合并进 truncateByCodePoint
 * 契约,不抛 typed error)+ §5 失败合同 + 两型协议 happy path:
 *   - §2.1 短生命周期 exec happy path(等子进程退出、stdout/stderr/exitCode)
 *   - §2.2 长生命周期 spawn happy path(同步 task_id、AsyncIterable 事件流、
 *     stop control message 触发 SIGTERM → SIGKILL 升级)
 *   - §4 empty fence / cwd → typed fail-loud,不 spawn(empty_task_id 已
 *     删除 —— task_id 由 server randomBytes 生成,caller 无法传空)
 *   - §4 negative maxOutputCodePoints / killGraceMs → RangeError 沿 truncateByCodePoint 契约
 *   - §4 concurrent fence 构造无共享 mutable state(并行允许,显式记录决策)
 *   - §4 exception:child 进程退出未回执 → typed orphan_process_group fail-loud
 *     + pgid reap;spawn 失败 → typed server_unreachable fail-loud
 *   - §5 ctx.signal abort:exec 协议透传到 spawnWithStopSignal;spawn 协议经 stop
 *     control message 取消,不只丢 client promise(orphan 进程组 reap 纪律)
 *
 * 同进程 router 形态下「server 不可达」物理上不发生,但合同保留 typed
 * fail-loud 语义并写测试覆盖 —— 为未来跨进程化留接口稳定。
 *
 * 同 trace double-track:不依赖 trace-service(stub-server 不产 trace 事件),
 * 但每条断言有两条路径 —— server handler 直接调用 + runInSandbox 间接路径,
 * 让 router 行为本身保持 ground truth。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSandboxServer,
  renderSandboxServerError,
} from "../../../src/harness/sandbox/server/index.js";
import { runInSandbox } from "../../../src/harness/sandbox/runner.js";
import type {
  SandboxServerError,
  SandboxTaskEvent,
  SandboxTaskHandle,
} from "../../../src/harness/sandbox/server/types.js";
import type { BwrapFence } from "../../../src/harness/sandbox/bwrap.js";

const SCRATCH: string[] = [];
function makeScratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

/** 测试替身 fence —— 不经 bwrap,用 sh 直接当 argv(与 runner.test.ts 同款)。 */
function shFence(command: string): BwrapFence {
  return Object.freeze({
    argv: Object.freeze(["sh", "-c", command]),
    sealed: true as const,
  });
}

/** typed-error kind 枚举 —— 4 类故障路径分支。 */
function expectTypedFail(
  err: unknown,
  kind: SandboxServerError["kind"]
): asserts err is SandboxServerError {
  assert.ok(typeof err === "object" && err !== null);
  const e = err as { kind?: unknown; context?: unknown };
  assert.equal(e.kind, kind, `expected kind=${kind}, got ${String(e.kind)}`);
  assert.equal(
    typeof e.context,
    "string",
    `expected context string, got ${String(e.context)}`
  );
}

// ─── §2.1 短生命周期 exec happy path ──────────────────────────────────────

describe("sandbox server exec — short-lived happy path (ADR-0045 §2.1)", () => {
  it("returns exitCode + stdout + stderr from a completed fence child", async () => {
    const server = createSandboxServer();
    const result = await server.exec({
      kind: "exec",
      fence: shFence("printf out; printf err >&2; exit 7"),
      cwd: tmpdir(),
      env: process.env,
    });
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
  });

  it("truncates stdout/stderr at maxOutputCodePoints (server-side contract)", async () => {
    const server = createSandboxServer();
    const result = await server.exec({
      kind: "exec",
      fence: shFence("printf 'aaaaaaaaaa'; printf 'bbbbbbbbbb' >&2"),
      cwd: tmpdir(),
      env: process.env,
      maxOutputCodePoints: 5,
    });
    assert.equal(result.stdout, "aaaaa");
    assert.equal(result.stderr, "bbbbb");
  });

  it("aborted signal stops the detached process tree (signal abort path)", async () => {
    const cwd = makeScratch("server-exec-abort-");
    const pidFile = join(cwd, "child.pid");
    const controller = new AbortController();
    const server = createSandboxServer();
    const execution = server.exec({
      kind: "exec",
      fence: shFence(`sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 50,
    });
    // 等 child.pid 落盘(信号透传到 spawnWithStopSignal 已发生)。
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const i = setInterval(() => {
        if (existsSyncSafe(pidFile)) {
          clearInterval(i);
          resolve();
        } else if (Date.now() - start > 4_000) {
          clearInterval(i);
          resolve();
        }
      }, 5);
    });
    controller.abort();
    const result = await execution;
    assert.notEqual(
      result.exitCode,
      0,
      "aborted fence must yield non-zero exit"
    );
  }, 5_000);
});

// ─── §2.2 长生命周期 spawn happy path ──────────────────────────────────────

describe("sandbox server spawn — long-lived task-handle (ADR-0045 §2.2)", () => {
  it("resolves task_id synchronously, log_path present, event stream yields stdout", async () => {
    const server = createSandboxServer();
    const cwd = makeScratch("server-spawn-");
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence("printf hello; sleep 0.1; printf bye"),
      cwd,
      env: process.env,
    });
    assert.match(handle.task_id, /^bg-[0-9a-f]{12}$/);
    assert.ok(handle.log_path.length > 0);
    const events = await drainUntilExit(handle);
    const stdout = events
      .filter(
        (e): e is { kind: "stdout"; chunk: string } => e.kind === "stdout"
      )
      .map((e) => e.chunk)
      .join("");
    assert.equal(stdout, "hellobye");
  }, 5_000);

  it("stop control message triggers SIGTERM → SIGKILL escalation", async () => {
    const server = createSandboxServer();
    const cwd = makeScratch("server-stop-");
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence("sleep 30"),
      cwd,
      env: process.env,
    });
    // 等子进程真正起来 —— 否则 stop 可能在 SIGTERM 之前就看到 close。
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop(50);
    const events = await drainUntilExit(handle);
    assert.equal(
      events.some((e) => e.kind === "exit"),
      true,
      "stop() must lead to exit event"
    );
  }, 10_000);

  it("idempotent stop — second stop does not throw", async () => {
    const server = createSandboxServer();
    const cwd = makeScratch("server-stop-idem-");
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence("sleep 30"),
      cwd,
      env: process.env,
    });
    await handle.stop(30);
    await handle.stop(30); // 不抛错
    assert.ok(true);
  }, 10_000);
});

// ─── §4 四类故障路径(overflow 已合并进 truncateByCodePoint)──────────────────────

describe("sandbox server — IPC boundary 4 fault classes (ADR-0045 §4)", () => {
  it("empty: missing fence in exec request → empty_request, no spawn", async () => {
    const server = createSandboxServer();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await server.exec({
        kind: "exec",
        fence: undefined as any,
        cwd: tmpdir(),
        env: process.env,
      });
      assert.fail("expected throw");
    } catch (err) {
      expectTypedFail(err, "empty_request");
      assert.equal(
        renderSandboxServerError(err as SandboxServerError).startsWith(
          "empty_request: "
        ),
        true
      );
    }
  });

  it("empty: empty argv fence in exec request → empty_request", async () => {
    const server = createSandboxServer();
    try {
      await server.exec({
        kind: "exec",
        fence: Object.freeze({
          argv: Object.freeze([]),
          sealed: true as const,
        }),
        cwd: tmpdir(),
        env: process.env,
      });
      assert.fail("expected throw");
    } catch (err) {
      expectTypedFail(err, "empty_request");
    }
  });

  it("empty: missing cwd in exec → empty_request", async () => {
    const server = createSandboxServer();
    try {
      await server.exec({
        kind: "exec",
        fence: shFence("true"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cwd: undefined as any,
        env: process.env,
      });
      assert.fail("expected throw");
    } catch (err) {
      expectTypedFail(err, "empty_request");
    }
  });

  it("negative: maxOutputCodePoints = -1 → typed fail-loud (RangeError contract)", async () => {
    const server = createSandboxServer();
    try {
      await server.exec({
        kind: "exec",
        fence: shFence("true"),
        cwd: tmpdir(),
        env: process.env,
        maxOutputCodePoints: -1,
      });
      assert.fail("expected throw");
    } catch (err) {
      expectTypedFail(err, "negative_argument");
    }
  });

  it("negative: killGraceMs = -5 → typed fail-loud", async () => {
    const server = createSandboxServer();
    try {
      await server.exec({
        kind: "exec",
        fence: shFence("true"),
        cwd: tmpdir(),
        env: process.env,
        killGraceMs: -5,
      });
      assert.fail("expected throw");
    } catch (err) {
      expectTypedFail(err, "negative_argument");
    }
  });

  it("overflow: stdout > maxOutputCodePoints → server truncates before responding", async () => {
    const server = createSandboxServer();
    const result = await server.exec({
      kind: "exec",
      fence: shFence("printf 'x%.0s' $(seq 1 100)"),
      cwd: tmpdir(),
      env: process.env,
      maxOutputCodePoints: 10,
    });
    assert.equal(result.stdout.length, 10);
    assert.equal(result.stdout, "x".repeat(10));
  });

  it("concurrent: parallel exec requests on the same router — fence no shared mutable state", async () => {
    const server = createSandboxServer();
    const cwd = makeScratch("server-concurrent-");
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        server.exec({
          kind: "exec",
          fence: shFence(`echo ${i}; exit ${i}`),
          cwd,
          env: process.env,
        })
      )
    );
    assert.equal(results.length, N);
    for (let i = 0; i < N; i++) {
      assert.equal(results[i]!.exitCode, i);
      assert.equal(results[i]!.stdout, `${i}\n`);
    }
  });

  it("exception: spawn failure surfaces as typed server_unreachable (fail-loud, no silent degrade)", async () => {
    const server = createSandboxServer();
    // bwrap 不存在的命令 —— server.exec 必须抛 typed fail-loud 而非静默降级。
    try {
      await server.exec({
        kind: "exec",
        fence: Object.freeze({
          argv: Object.freeze([
            "/nonexistent-iknow-sandbox-fence-xyzzy",
            "--nope",
          ]),
          sealed: true as const,
        }),
        cwd: tmpdir(),
        env: process.env,
      });
      assert.fail("expected throw");
    } catch (err) {
      // exec 阶段 spawn 失败 → typed server_unreachable(沿 ADR §5 不降级)。
      expectTypedFail(err, "server_unreachable");
    }
  });

  it("exception: spawn accept 后子进程退出未回执 → typed orphan_process_group fail-loud + pgid reap", async () => {
    const server = createSandboxServer();
    const cwd = makeScratch("server-orphan-");
    // spawn argv[0] 指向不存在的命令 —— Node 在 spawn syscall 失败时
    // 触发 child.once("error"),路径 = "accept 后子进程异常退出未回执"。
    // 修复前:server 只 reap + close,handle.events() 自然 drain 出空
    // stream,client 拿不到 typed fail-loud → 静默降级到「exit event
    // 已落,push(exit,null,null)」,client 看不到 typed error。
    // 修复后:rejectHandle typed orphan_process_group + context 含
    // 「accept 后子进程异常退出未回执」 + task_id 锚定。
    const task = server.spawn({
      kind: "spawn",
      fence: Object.freeze({
        argv: Object.freeze([
          "/nonexistent-iknow-sandbox-fence-xyzzy-orphan",
          "--nope",
        ]),
        sealed: true as const,
      }),
      cwd,
      env: process.env,
    });
    try {
      await task;
      assert.fail("expected typed orphan_process_group reject");
    } catch (err) {
      expectTypedFail(err, "orphan_process_group");
      assert.match(
        (err as { context: string }).context,
        /spawn bg-[0-9a-f]{12}: accept 后子进程异常退出未回执/,
        "context must include task_id and 'accept 后子进程异常退出未回执'"
      );
    }
  });
});

// ─── §5 失败合同:signal abort 经 control message 取消 ──────────────────────

describe("sandbox server — fail-loud contracts (ADR-0045 §5)", () => {
  it("exec: ctx.signal abort routes through stopTree — child gets killed, no orphan", async () => {
    const cwd = makeScratch("server-fail-loud-exec-");
    const controller = new AbortController();
    const server = createSandboxServer();
    const execution = server.exec({
      kind: "exec",
      fence: shFence("sleep 30"),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 30,
    });
    // 立即 abort —— handler 必须把信号透传到 spawnWithStopSignal stopTree,
    // 不只丢 client promise。
    controller.abort();
    const result = await execution;
    assert.notEqual(result.exitCode, 0, "aborted exec must yield non-zero");
  }, 5_000);

  it("spawn: ctx.signal abort routes through stop() control message, not promise-only", async () => {
    const cwd = makeScratch("server-fail-loud-spawn-");
    const controller = new AbortController();
    const server = createSandboxServer();
    const handle = await server.spawn({
      kind: "spawn",
      fence: shFence("sleep 30"),
      cwd,
      env: process.env,
      signal: controller.signal,
    });
    // 等子进程起来再 abort。
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const events = await drainUntilExit(handle);
    assert.equal(
      events.some((e) => e.kind === "exit"),
      true,
      "abort must trigger exit via stop() control message"
    );
  }, 10_000);

  it("concurrent spawn requests are independent — each handle has its own task_id and event stream", async () => {
    const server = createSandboxServer();
    const cwd = makeScratch("server-concurrent-spawn-");
    const N = 4;
    const handles = await Promise.all(
      Array.from({ length: N }, () =>
        server.spawn({
          kind: "spawn",
          fence: shFence("printf hi; sleep 0.05"),
          cwd,
          env: process.env,
        })
      )
    );
    const ids = new Set(handles.map((h) => h.task_id));
    assert.equal(
      ids.size,
      N,
      "each concurrent spawn must yield a unique task_id"
    );
    for (const h of handles) {
      const events = await drainUntilExit(h);
      const stdout = events
        .filter(
          (e): e is { kind: "stdout"; chunk: string } => e.kind === "stdout"
        )
        .map((e) => e.chunk)
        .join("");
      assert.equal(stdout, "hi");
    }
  }, 10_000);
});

// ─── §6 runInSandbox 仍为 router handler 薄包装 ───────────────────────────

describe("runInSandbox — adapter for §1 compat fixtures (ADR-0045 §1)", () => {
  it("delegates to server.exec (observable behavior preserved)", async () => {
    const result = await runInSandbox({
      fence: shFence("printf hello; exit 3"),
      cwd: tmpdir(),
      env: process.env,
    });
    assert.equal(result.exitCode, 3);
    assert.equal(result.stdout, "hello");
  });

  it("preserves truncateByCodePoint semantics through the server", async () => {
    const result = await runInSandbox({
      fence: shFence("printf '%.0s_' $(seq 1 100)"),
      cwd: tmpdir(),
      env: process.env,
      maxOutputCodePoints: 5,
    });
    assert.equal(result.stdout.length, 5);
  });

  it("aborted signal stops the detached process tree via server.exec handler", async () => {
    const cwd = makeScratch("runner-adapter-abort-");
    const controller = new AbortController();
    const execution = runInSandbox({
      fence: shFence("sleep 30"),
      cwd,
      env: process.env,
      signal: controller.signal,
      killGraceMs: 50,
    });
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    const result = await execution;
    assert.notEqual(result.exitCode, 0);
  }, 5_000);
});

// ─── helpers ──────────────────────────────────────────────────────────────

function existsSyncSafe(p: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:fs").existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 抽离 4 处重复:`for await ... break on exit`。返回 exit 事件之前的所有
 * 事件(包括 exit 自己)。注意 events() 单 consumer 契约 —— 同一 handle
 * 上多次调用会抢事件,故 drainUntilExit 只能调一次。
 */
async function drainUntilExit(
  handle: SandboxTaskHandle
): Promise<SandboxTaskEvent[]> {
  const events: SandboxTaskEvent[] = [];
  for await (const ev of handle.events()) {
    events.push(ev);
    if (ev.kind === "exit") break;
  }
  return events;
}
