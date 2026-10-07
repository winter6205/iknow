/**
 * registerShutdown coverage (fallback test surface for the "tui" wiring cleanup).
 *
 * Contract (src/cli/runtime.ts:128-172, calibrated against real behavior):
 *   - registerShutdown(built) attaches SIGINT / SIGTERM / beforeExit(once) listeners;
 *   - any signal → dispose() → built.shutdown?.() (no-op when absent);
 *   - shuttingDown is one shared guard: the first dispose runs shutdown once,
 *     every later dispose (signal or manual) is a no-op — idempotent (measured:
 *     emitting three signals in order still leaves counter === 1, not one per signal);
 *   - the parameter is widened to the structural
 *     `{ readonly shutdown?: () => Promise<void> }`: no BuiltEngine / deps /
 *     engine / subagentManager shape is required, the TUI entry passes only the
 *     shutdown handle.
 *
 * Signal-exit semantics (calibrated by real signal delivery):
 *   - the first signal sets reKilled at entry; after dispose() completes,
 *     setImmediate re-issues process.kill(process.pid, sig) once so external
 *     handlers (e.g. chat-session's onSigint counter) get a chance to
 *     force-exit; setImmediate keeps Unix same-signal merging from swallowing
 *     the second delivery;
 *   - the reKilled guard: once the second signal lands, process.exit(code)
 *     exits directly without re-killing — an unconditional re-kill with no
 *     external handler would ping-pong against its own handler into a microtask
 *     loop (the old implementation hung on real SIGINT under node/bun, only
 *     SIGKILL ended it; vitest's process.emit synchronous path masked the bug);
 *   - final exit code for a single signal: SIGINT → 130, SIGTERM → 143.
 *
 * Test discipline: process-level signal assertions must use a real child +
 * child.kill, never process.emit as a stand-in — emit only runs listeners
 * synchronously and does not deliver signals, masking the re-kill loop (the old
 * comment claiming kill is async and non-reentrant on Linux was disproven).
 * The child registers the real registerShutdown (runtime.ts); the parent kills
 * a real signal after ready, under a 60s timeout guard — a hang fails.
 *
 * The child topology must have no wrapper:
 *   - `node <tsx/dist/cli.mjs> -e <script>` is not a single process — the tsx
 *     CLI starts a wrapper which then spawns the real script process.
 *     child.kill(signal) only hits the wrapper; the script gets the signal via
 *     tsx's relay.
 *   - tsx 4.23.0 relay semantics (measured): after forwarding the signal it
 *     waits only 30ms for the child (`waitForSignalFromChild`'s 30ms race),
 *     escalates to SIGKILL on "Previous process hasn't exited yet", then the
 *     wrapper itself does `process.exit(128+signo)` — SIGINT is also 130,
 *     indistinguishable from the script process's re-kill exit code.
 *   - Consequence: on cold start/load, if dispose is slower than 30ms the
 *     script process is SIGKILL'd before writeFileSync and the parent sees
 *     code=130 with the sentinel missing (measured: 200ms handler work → 4/4
 *     sentinels lost; within the 30ms boundary → normal). That is a
 *     child-kill race, not a registerShutdown race (production runs
 *     `bin/iknow → dist/cli.js` directly, no tsx wrapper).
 *   - This file uses `node --import tsx/esm --input-type=module -e`, so the
 *     script under test IS the directly spawned process (measured
 *     `process.pid === child.pid`); signals reach the handler with no relay
 *     window. A re-kill hang is still caught (more deterministically without a
 *     wrapper). `--input-type=module` is declared explicitly rather than
 *     relying on Node's future syntax-detection defaults.
 *
 * Side-effect isolation:
 *   - in-process emit tests stub process.kill via vi.spyOn to no-op so the
 *     re-kill does not bounce a real SIGINT into the vitest worker; the second
 *     emit hits the reKilled guard and would call process.exit(code) — also
 *     stubbed. Real signal exit codes (130/143) are verified only via the child
 *     spawn cases below.
 *   - the child's shutdown hook writes a "dispose-ran" sentinel through a file
 *     side-channel: process.exit does not drain stdio pipes, so stderr buffers
 *     may be lost before exit; fs.writeFileSync lands synchronously and is
 *     deterministically readable.
 *
 * Signal cleanup: in vitest forks, process.listeners are not cleaned between
 * tests, so beforeEach / afterEach removeAllListeners for the three signals to
 * avoid polluting other tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerShutdown } from "../../src/cli/runtime.ts";
import type { BuiltEngine } from "../../src/cli/runtime.ts";
import type { LoopEngineDeps } from "../../src/harness/index.ts";
import { createLoopEngine } from "../../src/harness/index.ts";

const SIGNALS = ["SIGINT", "SIGTERM", "beforeExit"] as const;

function cleanupSignalListeners(): void {
  for (const sig of SIGNALS) {
    process.removeAllListeners(sig);
  }
}

/**
 * Locate tsx's ESM register entry (a worktree's node_modules may be empty with
 * deps hoisted to the main repo): walk up from this file's directory to the
 * first one containing node_modules/tsx/dist/esm/index.mjs (same resolution as
 * tests/cli/trace.test.ts).
 *
 * Use `dist/esm/index.mjs` (the node --import register entry), NOT
 * `dist/cli.mjs` — the latter is the wrapper CLI that spawns another child
 * layer with a 30ms relay escalating to SIGKILL (see the no-wrapper note in
 * the header).
 */
function resolveTsxEsm(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(
      dir,
      "node_modules",
      "tsx",
      "dist",
      "esm",
      "index.mjs"
    );
    try {
      if (statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // keep climbing
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/esm/index.mjs");
    dir = parent;
  }
}

// Consistent with `node --import tsx` module resolution: child cwd = repo root, inline script uses relative imports.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxEsm = resolveTsxEsm();

/**
 * Real-signal-delivery child: registers the real registerShutdown under
 * `node --import tsx` (runtime.ts); after ready the parent kills it with a real
 * signal. Returns { code, timedOut, disposeRan }.
 *   - code: child exit code (130/143 = expected; null = SIGKILL timeout);
 *   - timedOut: true = the parent's 60s guard fired → the old infinite
 *     re-kill hang is caught here;
 *   - disposeRan: whether the shutdown hook really ran (synchronous file
 *     side-channel, dodging process.exit's un-drained stdio pipe loss).
 *
 * The sentinel is written via child-side `import { writeFileSync } from 'node:fs'`
 * (ESM syntax; require is unavailable in the inline script — measured exit 1:
 * ReferenceError: require is not defined), with the filename injected through
 * the SIG_SENTINEL env var, independent of stdio pipe draining.
 *
 * Why not `node <tsx/dist/cli.mjs> -e`: the tsx CLI is a wrapper that spawns
 * another script layer and SIGKILLs after waiting only 30ms on a signal (see
 * header). `node --import tsx/esm` + `--input-type=module` makes the script
 * process the one that was spawned (measured process.pid === child.pid), so
 * signals reach the handler directly. `--input-type=module` declares the module
 * type explicitly; relative imports and cwd still resolve from the repo root.
 */
function runSignalChild(
  shutdownStub: string | null,
  signal: NodeJS.Signals,
  sentinelDir: string
): Promise<{
  code: number | null;
  timedOut: boolean;
  disposeRan: boolean;
  stderr: string;
  /** Self-reported process.pid of the child (script-process identity, for the no-wrapper invariant assert). */
  selfPid: number | null;
  /** pid returned by spawn() (== selfPid iff there is no intermediate wrapper). */
  spawnPid: number | null;
}> {
  const sentinel = join(sentinelDir, "dispose-ran");
  // Pass the sentinel path to the child via env var; the inline script reads process.env.SIG_SENTINEL.
  // shutdownStub is the `_shutdown` declaration body itself (appears once at top level; must not be concatenated twice).
  const shutdownBody = shutdownStub
    ? `${shutdownStub}\n    registerShutdown({ shutdown: _shutdown });`
    : "registerShutdown({});";
  // selfPid is reported with the ready line: if the spawn target is a wrapper
  // (like the tsx CLI), it spawns another script layer → selfPid !== spawnPid,
  // and the test fails fast (the wrapper's 30ms relay would escalate to
  // SIGKILL and lose the sentinel; see header).
  const script = `
    import { registerShutdown } from './src/cli/runtime.ts';
    import { writeFileSync } from 'node:fs';
    ${shutdownBody}
    console.error('stage: ready pid=' + process.pid);
    setInterval(() => {}, 1000);
  `;
  const child = spawn(
    process.execPath,
    ["--import", tsxEsm, "--input-type=module", "-e", script],
    {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, SIG_SENTINEL: sentinel },
    }
  );
  let err = "";
  let signalled = false;
  let selfPid: number | null = null;
  child.stdout.on("data", () => {
    /* suppress stdout; ready is judged via stderr only */
  });
  child.stderr.on("data", (d) => {
    err += String(d);
    const m = /stage: ready pid=(\d+)/.exec(err);
    if (m && !signalled) {
      selfPid = Number(m[1]);
      signalled = true;
      child.kill(signal);
    }
  });
  child.on("error", () => {
    /* the exit event's resolve covers spawn errors */
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: {
      code: number | null;
      timedOut: boolean;
      disposeRan: boolean;
      stderr: string;
      selfPid: number | null;
      spawnPid: number | null;
    }) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // 60s guard: cold-start import of the runtime.ts graph takes ~4-9s (under a
    // full parallel suite, vitest forks ×3 + tsx resolution contention can
    // reach 10-20s+), so 60s leaves cold-start headroom while still catching
    // the old infinite re-kill hang. The previous 30s flaked to false failures
    // under heavy load.
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        code: null,
        timedOut: true,
        disposeRan: existsSync(sentinel),
        stderr: err,
        selfPid,
        spawnPid: child.pid ?? null,
      });
    }, 60000);
    // Finish on close (not exit): close fires after the stdio streams fully
    // close, guaranteeing a complete err buffer (exit may fire before stderr
    // pipe data is flushed). writeFileSync lands synchronously inside dispose,
    // so the sentinel is readable right after close.
    child.on("close", (code) => {
      clearTimeout(guard);
      finish({
        code,
        timedOut: false,
        disposeRan: existsSync(sentinel),
        stderr: err,
        selfPid,
        spawnPid: child.pid ?? null,
      });
    });
  });
}

/**
 * No-wrapper invariant: the script process must be the spawned process itself.
 * If this regressed to `node <tsx/dist/cli.mjs> -e`, the tsx CLI would spawn
 * another script layer, the parent's kill would only hit the wrapper, and the
 * script would be SIGKILL'd by the 30ms relay → sentinels randomly lost under
 * load. This fail-fast pins the topology constraint in the test so a future
 * revert cannot flake.
 */
function expectNoWrapper(r: {
  selfPid: number | null;
  spawnPid: number | null;
  stderr: string;
}): void {
  expect(
    r.selfPid,
    `子进程未上报 pid(脚本可能未跑到 ready 行): ${r.stderr}`
  ).not.toBeNull();
  expect(
    r.selfPid,
    `被测脚本不是 spawn 的直接子进程(selfPid=${r.selfPid} spawnPid=${r.spawnPid}) ` +
      `— 中间存在 wrapper(如 tsx CLI),信号 relay 会引入 SIGKILL 竞态`
  ).toBe(r.spawnPid);
}

describe("registerShutdown (#365 T5)", () => {
  let sentinelDir: string;

  beforeEach(() => {
    cleanupSignalListeners();
    sentinelDir = mkdtempSync(join(tmpdir(), "reg-shut-"));
    // The in-fork emit tests stub process.kill so the re-kill does not deliver
    // a real SIGINT back into the vitest worker; the second emit triggers the
    // reKilled guard's process.exit(130), which vitest would report as an
    // unhandled rejection → stub that too. Real signal exit codes (130/143)
    // are only verified via the child spawn cases below.
    vi.spyOn(process, "kill").mockImplementation(() => true);
    // process.exit is typed `never`-returning; this stub deliberately does not
    // exit, so the implementation is cast rather than annotated `never` (a
    // `never`-returning body with a reachable end point does not compile).
    vi.spyOn(process, "exit").mockImplementation((() => {
      // no-op: intercept the reKilled guard's forced-exit path so it cannot pollute the vitest worker.
    }) as (code?: string | number | null) => never);
  });

  afterEach(() => {
    cleanupSignalListeners();
    vi.restoreAllMocks();
    if (sentinelDir) rmSync(sentinelDir, { recursive: true, force: true });
  });

  it("BuiltEngine.shutdown 存在时,信号触发 dispose → shutdown 计数器 +1(幂等)", async () => {
    let callCount = 0;
    const built: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: createLoopEngine({} as unknown as LoopEngineDeps),
      // BuiltEngine.sessionRoots is required; these cases only exercise the
      // shutdown wiring, so one placeholder triple-root is enough.
      sessionRoots: {
        productRoot: process.cwd(),
        taskRoot: process.cwd(),
        installRoot: process.cwd(),
        projectIdentityRoot: process.cwd(),
      },
      shutdown: async () => {
        callCount += 1;
      },
    };

    const { dispose } = registerShutdown(built);

    // Inside the fork, process.emit only runs listeners synchronously and the
    // re-kill is cut off by the process.kill stub. Real signal semantics go
    // through the child spawn cases below.
    process.emit("SIGINT");
    // dispose().finally(...) is a microtask chain; assert after setImmediate drains.
    await new Promise((r) => setImmediate(r));
    expect(callCount).toBe(1);

    // The shuttingDown single guard: the first dispose consumed it, every later
    // dispose (signal or manual) is a no-op → count stays 1 (idempotent;
    // measured — the original expectation of one call per signal was wrong).
    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    expect(callCount).toBe(1);

    await dispose();
    expect(callCount).toBe(1);

    await dispose();
    expect(callCount).toBe(1);
  });

  it("BuiltEngine.shutdown 缺席时,registerShutdown 不抛 + dispose 也不抛", async () => {
    const built: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: createLoopEngine({} as unknown as LoopEngineDeps),
      // BuiltEngine.sessionRoots is required; these cases only exercise the
      // shutdown wiring, so one placeholder triple-root is enough.
      sessionRoots: {
        productRoot: process.cwd(),
        taskRoot: process.cwd(),
        installRoot: process.cwd(),
        projectIdentityRoot: process.cwd(),
      },
      // shutdown field absent (contract: on the ask surface the manager was never created → absent).
    };

    const { dispose } = registerShutdown(built);

    expect(() => process.emit("SIGINT")).not.toThrow();
    await new Promise((r) => setImmediate(r));

    await expect(dispose()).resolves.toBeUndefined();
    await expect(dispose()).resolves.toBeUndefined();
  });

  it("SIGINT + SIGTERM + beforeExit 三类信号都触发 dispose(surface:tui 模拟)", async () => {
    let callCount = 0;
    const built: BuiltEngine = {
      deps: {} as unknown as LoopEngineDeps,
      engine: createLoopEngine({} as unknown as LoopEngineDeps),
      // BuiltEngine.sessionRoots is required; these cases only exercise the
      // shutdown wiring, so one placeholder triple-root is enough.
      sessionRoots: {
        productRoot: process.cwd(),
        taskRoot: process.cwd(),
        installRoot: process.cwd(),
        projectIdentityRoot: process.cwd(),
      },
      shutdown: async () => {
        callCount += 1;
      },
    };

    registerShutdown(built);

    // Listeners attached for all three signal kinds (wiring coverage: 1 listener each).
    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(1);
    expect(process.listenerCount("beforeExit")).toBe(1);

    // Emit all three signal kinds in order; each reaches the dispose path. The
    // shuttingDown single guard → the first dispose runs shutdown once, later
    // signals are no-op (measured: counter === 1, not one per signal).
    for (const sig of SIGNALS) {
      // @types/node types `emit("beforeExit")` as taking an exit code; the
      // registered listeners here ignore it, so the "beforeExit" arm passes 0.
      if (sig === "beforeExit") process.emit("beforeExit", 0);
      else process.emit(sig);
      await new Promise((r) => setImmediate(r));
    }
    expect(callCount).toBe(1);

    // The beforeExit listener is once → its count drops to 0 after one emit; SIGINT/SIGTERM stay resident.
    expect(process.listenerCount("beforeExit")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(1);
    expect(process.listenerCount("SIGTERM")).toBe(1);
  });

  it("参数放宽(Gap B):TUI 入口只透 shutdown 句柄也能注册", async () => {
    let callCount = 0;
    // Same shape as src/tui/run.tsx: no deps / engine / subagentManager passed.
    const { dispose } = registerShutdown({
      shutdown: async () => {
        callCount += 1;
      },
    });

    process.emit("SIGINT");
    await new Promise((r) => setImmediate(r));
    expect(callCount).toBe(1);
    await dispose();
    expect(callCount).toBe(1);
  });

  it("真实 SIGINT 投递:dispose 完成后二次强杀语义 → 进程以 130 退出(不挂死)", async () => {
    // Real child + child.kill('SIGINT') — process.emit only runs listeners
    // synchronously and would mask the re-kill loop (the old implementation
    // hung on real SIGINT under node/bun). Single SIGINT: first signal sets
    // reKilled → dispose() → setImmediate re-issues once → the second delivery
    // hits the reKilled guard → process.exit(130).
    const r = await runSignalChild(
      "const _shutdown = async () => { writeFileSync(process.env.SIG_SENTINEL, 'ran') }",
      "SIGINT",
      sentinelDir
    );
    expect(r.timedOut).toBe(false);
    expectNoWrapper(r);
    expect(r.code, `child stderr: ${r.stderr}`).toBe(130);
    expect(r.disposeRan, `child stderr: ${r.stderr}`).toBe(true);
    expect(readFileSync(join(sentinelDir, "dispose-ran"), "utf8")).toBe("ran");
  }, 90000);

  it("真实 SIGTERM 投递:dispose 完成后二次强杀语义 → 进程以 143 退出(不挂死)", async () => {
    const r = await runSignalChild(
      "const _shutdown = async () => { writeFileSync(process.env.SIG_SENTINEL, 'ran') }",
      "SIGTERM",
      sentinelDir
    );
    expect(r.timedOut).toBe(false);
    expectNoWrapper(r);
    expect(r.code).toBe(143);
    expect(r.disposeRan).toBe(true);
  }, 90000);

  it("真实 SIGINT 投递 + shutdown 缺席:no-op dispose 后同样二次强杀 → 130", async () => {
    const r = await runSignalChild(null, "SIGINT", sentinelDir);
    expect(r.timedOut).toBe(false);
    expectNoWrapper(r);
    expect(r.code).toBe(130);
    expect(r.disposeRan).toBe(false);
  }, 90000);
});
