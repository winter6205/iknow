/**
 * T7 (plans/worktree-live-task-root.md §6 T7 / §5 D4) — bash cwd + bwrap
 * fence per-call rebuild against the live `taskRoot` cell.
 *
 * Acceptance focus (named by plan §6 T7):
 *   1. liveTaskRoot flips → next bash call's fence argv binds new cwd
 *      (no factory-time closure on `cwd` capturing the build-time root).
 *   2. wave snapshot is read ONCE per handler invocation — both the foreground
 *      and background branches of the same call read the same value.
 *   3. argv SHAPE+ORDER byte-for-byte unchanged: with a frozen home/tmp the
 *      only mutations across rebind are the cwd tokens themselves
 *      (`--chdir <cwd>`; `--ro-bind <cwd> <cwd>` when cwdReadonly). Everything
 *      else — host-root `--bind / /`, system --ro-bind series, optional
 *      /opt /snap, --proc/--dev-bind, --clearenv, envArgs, command ordering —
 *      is invariant under rebind (ADR-0092 global mode).
 *
 * Test harness strategy: drive bash.handler with `background: true` so the
 * production chain (bash.handler → handleBackground → manager.spawn →
 * defaultBackgroundSpawn → spawn(fence.argv)) runs end-to-end; capture the
 * `spawn` call's argv through a `vi.mock("node:child_process", …)`.
 *
 * Why handler-with-background rather than calling defaultBackgroundSpawn
 * directly: the mock + dynamic-import scoping combination worked reliably in
 * this file only when bash.handler was the consumer; direct driver calls
 * recorded zero spawn invocations under vitest's transformer caching. The
 * handler route is also closer to the actual production hot path.
 */

import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { createBashTool } =
  await import("../../../src/harness/aci/tools/bash.ts");
const { createBackgroundTaskManager, defaultBackgroundSpawn } =
  await import("../../../src/harness/background/manager.ts");
const sessionRootsModule =
  await import("../../../src/harness/session-roots.ts");
const { createLiveTaskRoot, writeLiveTaskRoot } = sessionRootsModule;
import type { LiveTaskRoot } from "../../../src/harness/session-roots.ts";

function makeFakeChild(pid = 47171) {
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill,
  });
  return child as unknown as EventEmitter & {
    readonly stdin: PassThrough;
    readonly stdout: PassThrough;
    readonly stderr: PassThrough;
    readonly pid: number;
    readonly kill: ReturnType<typeof vi.fn>;
  };
}

function makeManager() {
  return createBackgroundTaskManager({
    tasksDir: "/tmp/tasks",
    spawn: defaultBackgroundSpawn,
  });
}

function makeTool(opts: {
  readonly cwd: string;
  readonly liveTaskRoot?: LiveTaskRoot;
}) {
  return createBashTool(opts.cwd, {
    backgroundManager: makeManager(),
    ...(opts.liveTaskRoot ? { liveTaskRoot: opts.liveTaskRoot } : {}),
  });
}

/** Drive one bash.handler call with `background: true`; return the argv the
 *  underlying spawn call observed. Resets the mock first so a second call
 *  in the same test gets a clean call index. */
async function bashBgOnce(
  tool: ReturnType<typeof makeTool>,
  args: { command: string; background: boolean }
): Promise<readonly string[]> {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
  await tool.handler(args);
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  const argv = (call?.[1] as readonly string[]) ?? [];
  spawnMock.mockClear();
  return argv;
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  spawnMock.mockReset();
});

// T3 闭世界适配:合同根(taskRoot)盘上校验 → 全部根 fixture 用真实目录
// (mkdtemp),不再用不存在的 "/workspace/*" 假路径。rebind 不变式只依赖
// 「argv 形状不变、cwd token 随活根走」,与根的具体值无关。
const REAL_ROOTS: string[] = [];
function makeRealRoot(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bash-lt-${name}-`));
  REAL_ROOTS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of REAL_ROOTS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 1. per-call rebuild ─────────────────────────────────────────────────────

describe("bash T7: live taskRoot cell drives fence per call", () => {
  it("liveTaskRoot flips → next bash background call's argv binds new cwd", async () => {
    const initialRoot = makeRealRoot("original");
    const reboundRoot = makeRealRoot("rebound");
    const cell: LiveTaskRoot = createLiveTaskRoot(initialRoot);
    const tool = makeTool({ cwd: initialRoot, liveTaskRoot: cell });

    // Pre-rebind call: handler reads cell → initialRoot.
    const argvPre = await bashBgOnce(tool, {
      command: "echo pre",
      background: true,
    });
    assert.ok(
      argvPre.includes(initialRoot),
      `pre-rebind argv must bind initialRoot; argv=${JSON.stringify(argvPre)}`
    );
    assert.ok(
      !argvPre.includes(reboundRoot),
      `pre-rebind argv must NOT bind reboundRoot; argv=${JSON.stringify(argvPre)}`
    );

    // Rebind: D1 single writer updates the cell.
    writeLiveTaskRoot(cell, reboundRoot);

    // Post-rebind call: handler reads cell → reboundRoot.
    const argvPost = await bashBgOnce(tool, {
      command: "echo post",
      background: true,
    });
    assert.ok(
      argvPost.includes(reboundRoot),
      `post-rebind argv must bind reboundRoot; argv=${JSON.stringify(argvPost)}`
    );
    assert.ok(
      !argvPost.includes(initialRoot),
      `post-rebind argv must NOT bind initialRoot; argv=${JSON.stringify(argvPost)}`
    );
  });

  it("absence of liveTaskRoot → handler falls back to factory-captured sandboxRoot (legacy parity)", async () => {
    const cwd = makeRealRoot("main");
    const tool = makeTool({ cwd });
    const argv = await bashBgOnce(tool, {
      command: "echo hi",
      background: true,
    });
    assert.ok(
      argv.includes(cwd),
      `argv must include cwd; argv=${JSON.stringify(argv)}`
    );
  });

  it("flip flips back → argv goes back to original cwd byte-for-byte at the cwd positions", async () => {
    // The argv SHAPE contract (system --ro-bind, etc.) is preserved under
    // any number of flips; only the cwd token positions track the live root.
    // Pin a single command across all calls so the byte-equal comparison
    // is not contaminated by command text — the invariant is about the
    // fence tokens, not the user command.
    const sameCommand = "echo stable";
    const rootA = makeRealRoot("A");
    const rootB = makeRealRoot("B");
    const rootC = makeRealRoot("C");
    const cell: LiveTaskRoot = createLiveTaskRoot(rootA);
    const tool = makeTool({ cwd: rootA, liveTaskRoot: cell });

    const argvA = await bashBgOnce(tool, {
      command: sameCommand,
      background: true,
    });
    writeLiveTaskRoot(cell, rootB);
    const argvB = await bashBgOnce(tool, {
      command: sameCommand,
      background: true,
    });
    writeLiveTaskRoot(cell, rootC);
    const argvC = await bashBgOnce(tool, {
      command: sameCommand,
      background: true,
    });
    writeLiveTaskRoot(cell, rootA);
    const argvA2 = await bashBgOnce(tool, {
      command: sameCommand,
      background: true,
    });

    assert.ok(argvA.includes(rootA));
    assert.ok(argvB.includes(rootB));
    assert.ok(!argvB.includes(rootA));
    assert.ok(argvC.includes(rootC));
    assert.ok(!argvC.includes(rootA));
    assert.ok(!argvC.includes(rootB));
    // Returning to rootA must produce argv identical at the cwd positions.
    assert.deepEqual(argvA2, argvA, "flipping back to rootA must restore argv");
  });
});

// ── 2. argv shape / order byte-identical across rebind ─────────────────────

describe("bash T7: argv SHAPE+ORDER invariant under root rebind", () => {
  it("rebind changes only cwd tokens (every non-cwd position byte-equal)", async () => {
    // For a frozen home / tmpdir pair the only argv deltas across a root
    // rebind are the cwd tokens themselves. Locks the "argv 形状与顺序
    // 逐字节不变" contract from plan §5 D4 — only the substring changes,
    // not the shape, the order, or the set of flags.
    // Pin a single command across both calls so the byte-equal comparison
    // is not contaminated by command text.
    const sameCommand = "echo stable";
    const originalRoot = makeRealRoot("original2");
    const reboundRoot = makeRealRoot("rebound2");
    const cell: LiveTaskRoot = createLiveTaskRoot(originalRoot);
    const tool = makeTool({ cwd: originalRoot, liveTaskRoot: cell });

    const argvOriginal = await bashBgOnce(tool, {
      command: sameCommand,
      background: true,
    });
    writeLiveTaskRoot(cell, reboundRoot);
    const argvRebound = await bashBgOnce(tool, {
      command: sameCommand,
      background: true,
    });

    // Length parity is a precondition of the byte-equal comparison below —
    // a length mismatch would mean a new flag slipped in or a flag was
    // dropped, which is exactly the regression D4 forbids.
    assert.equal(
      argvRebound.length,
      argvOriginal.length,
      `argv length must stay constant across rebind; original=${argvOriginal.length} rebound=${argvRebound.length}\noriginal=${JSON.stringify(argvOriginal)}\nrebound=${JSON.stringify(argvRebound)}`
    );

    // Every position that held `<originalRoot>` in argvOriginal must hold
    // `<reboundRoot>` in argvRebound, and every other position must be
    // byte-equal. This is the strongest form of "argv shape + order
    // 逐字节不变" short of producing the exact same string.
    for (let i = 0; i < argvRebound.length; i++) {
      if (argvOriginal[i] === originalRoot) {
        assert.equal(
          argvRebound[i],
          reboundRoot,
          `at position ${i}: cwd token expected to update (original=${argvOriginal[i]}, rebound=${argvRebound[i]})`
        );
      } else {
        assert.equal(
          argvRebound[i],
          argvOriginal[i],
          `at position ${i}: non-cwd argv token must be byte-equal across rebind (original=${JSON.stringify(argvOriginal[i])}, rebound=${JSON.stringify(argvRebound[i])})`
        );
      }
    }
  });

  it("cwd under /tmp is covered by the host-root bind — no guest /tmp mount or rebind (ADR-0092)", async () => {
    // ADR-0092: the per-invocation `--tmpfs /tmp` + post-tmpfs cwd rebind is
    // retired. A cwd that is a descendant of host /tmp is now covered by
    // `--bind / /`, so there is no guest `/tmp` mount to rebind after.
    const cwd = makeRealRoot("tmp-cwd");
    const cell: LiveTaskRoot = createLiveTaskRoot(cwd);
    const tool = makeTool({ cwd, liveTaskRoot: cell });
    const argv = await bashBgOnce(tool, {
      command: "echo tmp",
      background: true,
    });
    assert.ok(
      argv.some((arg, i) => arg === "--bind" && argv[i + 1] === "/"),
      `host root must be bound; argv=${JSON.stringify(argv)}`
    );
    assert.equal(
      argv.some((arg, i) => arg === "--bind" && argv[i + 2] === "/tmp"),
      false,
      "guest /tmp pad bind is retired"
    );
    assert.equal(argv.includes("--tmpfs"), false, "--tmpfs /tmp is retired");
    // cwd still travels as the `--chdir` target so the live root is honored.
    const chdirIdx = argv.indexOf("--chdir");
    assert.notEqual(chdirIdx, -1);
    assert.equal(argv[chdirIdx + 1], cwd);
  });

  it("argv shape contains the canonical fence markers", async () => {
    const cwd = makeRealRoot("live");
    const cell: LiveTaskRoot = createLiveTaskRoot(cwd);
    const tool = makeTool({ cwd, liveTaskRoot: cell });
    const argv = await bashBgOnce(tool, {
      command: "echo hi",
      background: true,
    });
    // argv[0] is the first fence token (after `bwrap` itself, which is the
    // spawn cmd separate from args). The spawn mock sees `cmd, args, opts`,
    // so call?.[1] captures the argv starting at the first fence flag.
    assert.equal(argv[0], "--unshare-user-try");
    assert.equal(argv[1], "--unshare-net");
    assert.ok(argv.includes("--die-with-parent"));
    assert.ok(argv.includes("--clearenv"));
    assert.ok(argv.includes("--chdir"));
    assert.ok(argv.includes(cwd));
  });
});

// ── 3. wave snapshot: one read per handler invocation ─────────────────────

describe("bash T7: wave snapshot (D2) — one read per handler invocation", () => {
  it("handler reads liveTaskRoot: mid-call flip does NOT leak into this call's fence", async () => {
    // D2 一次入口读一次。同 handler 内反复改 cell 不应影响本次 fence——
    // handler 在入口读一次冻结局部 waveRoot,贯穿整条路径。
    const initialRoot = makeRealRoot("wave-original");
    const flickeredRoot = makeRealRoot("wave-flickered");
    const cell: LiveTaskRoot = createLiveTaskRoot(initialRoot);
    const reads: string[] = [];
    const instrumented: LiveTaskRoot = {
      read: () => {
        const v = cell.read();
        reads.push(v);
        return v;
      },
    };

    const tool = makeTool({
      cwd: initialRoot,
      liveTaskRoot: instrumented,
    });

    // Background path: handler reads cell → waveRoot (frozen in local)
    // then passes waveRoot to manager.spawn. Any external flip of the
    // cell after handler entry does NOT propagate to this call's fence.
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild());
    const callPromise = tool.handler({
      command: "echo mid",
      background: true,
    });
    // Simulate a mid-call rebind attempt: handler must have already
    // captured its waveRoot before this fires.
    writeLiveTaskRoot(cell, flickeredRoot);
    await callPromise;

    const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
    const argv = (call?.[1] as readonly string[]) ?? [];
    assert.ok(
      argv.includes(initialRoot),
      `argv must bind entry-time waveRoot (${initialRoot}); argv=${JSON.stringify(argv)}`
    );
    assert.ok(
      !argv.includes(flickeredRoot),
      `argv must NOT bind mid-call flicker (${flickeredRoot}); argv=${JSON.stringify(argv)}`
    );
    spawnMock.mockClear();

    // Cell must be read at least once with the entry-time value.
    const observed = new Set(reads);
    assert.ok(
      observed.has(initialRoot),
      `cell must be read at least once with entry-time value; reads=${JSON.stringify([...observed])}`
    );
    assert.ok(
      !observed.has(flickeredRoot),
      `cell must NOT be observed mid-call; reads=${JSON.stringify([...observed])}`
    );
  });
});
