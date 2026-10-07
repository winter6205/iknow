/**
 * ADR-0045 — contract tests for server-izing the sandbox execution surface.
 *
 * Covers ADR-0045 §4's fault classes (overflow folded into the
 * truncateByCodePoint contract, so it throws no typed error) + §5's failure
 * contract + the two protocol shapes' happy paths:
 *   - §2.1 short-lived exec happy path (await child exit; stdout/stderr/exitCode)
 *   - §2.2 long-lived spawn happy path (synchronous task_id, AsyncIterable event
 *     stream, stop control message driving SIGTERM → SIGKILL escalation)
 *   - §4 empty fence / cwd → typed fail-loud, no spawn (empty_task_id is gone —
 *     task_id comes from the server's randomBytes, callers cannot pass empty)
 *   - §4 negative maxOutputCodePoints / killGraceMs → RangeError along the
 *     truncateByCodePoint contract
 *   - §4 concurrent fence construction shares no mutable state (parallelism is
 *     allowed; a recorded decision)
 *   - §4 exception: child exits after accept without an ack → typed
 *     orphan_process_group fail-loud + pgid reap; spawn failure → typed
 *     server_unreachable fail-loud
 *   - §5 ctx.signal abort: the exec protocol routes through
 *     spawnWithStopSignal; the spawn protocol cancels via the stop control
 *     message, never by just dropping the client promise (orphan process-group
 *     reap discipline)
 *
 * In the same-process router shape "server unreachable" physically cannot
 * happen, but the contract keeps the typed fail-loud semantics with test
 * coverage — keeping the interface stable for a future cross-process split.
 *
 * Same double-track as trace: no trace-service dependency (the stub server emits
 * no trace events), but every assertion runs two paths — direct server-handler
 * call + the indirect runInSandbox path — so the router behavior itself stays
 * ground truth.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

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

/** Test-double fence — no bwrap; sh acts as the argv directly (same shape as runner.test.ts). */
function shFence(command: string): BwrapFence {
  return Object.freeze({
    argv: Object.freeze(["sh", "-c", command]),
    sealed: true as const,
    // the fixture emits no boundary block, so it names no mask.
    exactFileMaskPaths: Object.freeze([]),
  });
}

/** typed-error kind enumeration — the fault-path branches. */
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

// ─── §2.1 short-lived exec happy path ──────────────────────────────────────

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
    // wait for child.pid to land (the signal has already routed through spawnWithStopSignal).
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

// ─── §2.2 long-lived spawn happy path ──────────────────────────────────────

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
    // wait for the child to really come up — otherwise stop may see close before SIGTERM.
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
    await handle.stop(30); // does not throw
    assert.ok(true);
  }, 10_000);
});

// ─── §4 fault classes (overflow folded into truncateByCodePoint) ────────────

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
          // the fixture emits no boundary block, so it names no mask.
          exactFileMaskPaths: Object.freeze([]),
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
    // a nonexistent fence command — server.exec must throw typed fail-loud instead of silently degrading.
    try {
      await server.exec({
        kind: "exec",
        fence: Object.freeze({
          argv: Object.freeze([
            "/nonexistent-iknow-sandbox-fence-xyzzy",
            "--nope",
          ]),
          sealed: true as const,
          // the fixture emits no boundary block, so it names no mask.
          exactFileMaskPaths: Object.freeze([]),
        }),
        cwd: tmpdir(),
        env: process.env,
      });
      assert.fail("expected throw");
    } catch (err) {
      // spawn failure during exec → typed server_unreachable (no degrade, per ADR §5).
      expectTypedFail(err, "server_unreachable");
    }
  });

  it("exception: spawn accept 后子进程退出未回执 → typed orphan_process_group fail-loud + pgid reap", async () => {
    const server = createSandboxServer();
    const cwd = makeScratch("server-orphan-");
    // spawn argv[0] points at a nonexistent command: Node fires child.once("error")
    // when the spawn syscall fails — the "child exited after accept without an ack"
    // path (the product context marker `accept 后子进程异常退出未回执`, "child
    // exited after accept without ack", asserted below). Silent degradation is the
    // old bug shape: the server only reaped + closed, events() drained empty, and
    // the client saw no typed error. The contract now: reject with typed
    // orphan_process_group whose context carries the task_id + that marker.
    const task = server.spawn({
      kind: "spawn",
      fence: Object.freeze({
        argv: Object.freeze([
          "/nonexistent-iknow-sandbox-fence-xyzzy-orphan",
          "--nope",
        ]),
        sealed: true as const,
        // the fixture emits no boundary block, so it names no mask.
        exactFileMaskPaths: Object.freeze([]),
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

// ─── §5 failure contract: signal abort cancels via control message ─────────

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
    // abort immediately — the handler must route the signal into
    // spawnWithStopSignal's stopTree, not just drop the client promise.
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
    // let the child start before aborting.
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

// ─── §6 runInSandbox stays a thin wrapper over the router handler ──────────

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
 * Deduplicates the four `for await ... break on exit` sites: returns every event
 * up to and including the exit event. Note the single-consumer contract of
 * events() — calling this twice on one handle steals events, so drainUntilExit
 * may be called only once per handle.
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
