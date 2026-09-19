/**
 * issue 1059 / ADR-0109 — bash 工具面的 UNBOUND_FENCE 行为。
 *
 * 翻转后 bash 的写保护 = 物理的:handler 入口读 holder + liveTaskRoot 一次
 * 冻结,unbound(gate ON ∧ waveRoot 是主 checkout)时前台 fence 与后台 spawn
 * 叠同一段 `--ro-bind <main> <main>` + `--bind <pad> <pad>`(G3 前后台集合
 * 相等),EROFS 出现时以 `[fs_denied]` 指引回灌 stderr。
 *
 * 断言面:
 *   - fence argv(mock runInSandbox / node:child_process spawn 捕获真实
 *     createBwrapFence 产物,与 fs-mode-propagation C 段同款);
 *   - envelope stderr(EROFS 回灌:有/无指引的字节同一性对照);
 *   - 入口 vintage:handler 执行中翻 holder 不渗透进本次调用。
 *
 * bound / holder OFF / holder 缺席三态的 argv 与基线 byte-identical —— SC3
 * (bound / gate OFF 档逐字节不变)的工具层形态;argv 段序合同在
 * tests/harness/sandbox/bwrap.test.ts,纯函数合同在
 * tests/harness/isolation/worktree-gate.test.ts。
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

// 前台:挡掉真 bwrap 探测与真执行,捕获 fence。后台:defaultBackgroundSpawn
// 走 node:child_process.spawn,替身只取 argv(被测系统 = handler 装配 + 真
// createBwrapFence)。
vi.mock("../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/harness/sandbox/runner.js")
    >();
  return {
    ...actual,
    requireBwrap: () => {},
    runInSandbox: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };
});

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
const { createLiveTaskRoot } =
  await import("../../../src/harness/session-roots.ts");
const { runInSandbox } = await import("../../../src/harness/sandbox/runner.ts");

const scratchPaths: string[] = [];

function makeScratch(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratchPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  vi.mocked(runInSandbox).mockReset();
  vi.mocked(runInSandbox).mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
  spawnMock.mockReset();
});

function makeFakeChild(pid = 51001) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  return child;
}

interface Holder {
  get(): boolean;
  set(v: boolean): void;
}

function makeHolder(initial: boolean): Holder & { _v: boolean } {
  return {
    _v: initial,
    get() {
      return this._v;
    },
    set(v: boolean) {
      this._v = v;
    },
  };
}

function makeTool(opts: {
  readonly mainCheckout: string;
  readonly pad: string;
  readonly holder: Holder | undefined;
  readonly background?: boolean;
}) {
  return createBashTool(opts.mainCheckout, {
    liveTaskRoot: createLiveTaskRoot(opts.mainCheckout),
    tmpDir: opts.pad,
    ...(opts.holder !== undefined
      ? { worktreeOnMutate: { get: () => opts.holder!.get() } }
      : {}),
    ...(opts.background === true
      ? {
          backgroundManager: createBackgroundTaskManager({
            tasksDir: "/tmp/iknow-unbound-fence-tasks",
            spawn: defaultBackgroundSpawn,
          }),
        }
      : {}),
  });
}

/** Run one foreground call, return the fence argv the production
 *  createBwrapFence produced (captured at the runInSandbox seam). */
async function foregroundArgv(
  tool: ReturnType<typeof makeTool>,
  command = "echo hi"
): Promise<readonly string[]> {
  vi.mocked(runInSandbox).mockClear();
  await tool.handler({ command });
  const calls = vi.mocked(runInSandbox).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const last = calls[calls.length - 1]!;
  return (last[0] as { fence: { argv: readonly string[] } }).fence.argv;
}

/** Run one background call, return the argv the mocked node spawn saw. */
async function backgroundArgv(
  tool: ReturnType<typeof makeTool>,
  command = "echo hi"
): Promise<readonly string[]> {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
  await tool.handler({ command, background: true });
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  expect(call).toBeDefined();
  return (call?.[1] as readonly string[]) ?? [];
}

function tripleIdx(
  argv: readonly string[],
  verb: string,
  target: string
): number {
  return argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === target && argv[i + 2] === target
  );
}

function parseBash(envelope: unknown): {
  code: number;
  stdout: string;
  stderr: string;
} {
  return JSON.parse((envelope as { output: string }).output) as {
    code: number;
    stdout: string;
    stderr: string;
  };
}

describe("bash UNBOUND_FENCE — 前台/后台物理段 (issue 1059 / G3)", () => {
  it("holder ON + main-checkout wave root → fence ro-binds the main checkout, pad re-binds writable", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const holder = makeHolder(true);
    const argv = await foregroundArgv(
      makeTool({ mainCheckout: MAIN, pad: PAD, holder })
    );
    const rootBindIdx = tripleIdx(argv, "--bind", "/");
    const roMainIdx = tripleIdx(argv, "--ro-bind", MAIN);
    const padIdx = tripleIdx(argv, "--bind", PAD);
    const procIdx = argv.indexOf("--proc");
    expect(rootBindIdx).toBeGreaterThan(-1);
    expect(roMainIdx).toBeGreaterThan(rootBindIdx);
    expect(padIdx).toBeGreaterThan(roMainIdx);
    expect(procIdx).toBeGreaterThan(padIdx);
  });

  it("foreground and background carry the same unbound segment (G3 set-equality on this axis)", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const holder = makeHolder(true);
    const tool = makeTool({
      mainCheckout: MAIN,
      pad: PAD,
      holder,
      background: true,
    });
    const fg = await foregroundArgv(tool);
    const bg = await backgroundArgv(tool);
    const unboundAxis = (argv: readonly string[]): string[] => {
      const procIdx = argv.indexOf("--proc");
      const roMainIdx = tripleIdx(argv, "--ro-bind", MAIN);
      const padIdx = tripleIdx(argv, "--bind", PAD);
      return [
        `ro-main:${roMainIdx > -1 && roMainIdx < procIdx}`,
        `pad-top:${padIdx > -1 && padIdx > roMainIdx && padIdx < procIdx}`,
      ];
    };
    expect(unboundAxis(bg)).toEqual(unboundAxis(fg));
    expect(unboundAxis(fg)).toEqual(["ro-main:true", "pad-top:true"]);
  });

  it.each([
    ["holder OFF", () => makeHolder(false)],
    ["holder 缺席", () => undefined],
  ])(
    "%s → 无 unbound 段,argv 与基线 byte-identical (SC3 gate-OFF 档)",
    async (_label, holderFactory) => {
      const MAIN = makeScratch("unbound-main-");
      const PAD = makeScratch("unbound-pad-");
      const offArgv = await foregroundArgv(
        makeTool({ mainCheckout: MAIN, pad: PAD, holder: holderFactory() })
      );
      const bareArgv = await foregroundArgv(
        makeTool({ mainCheckout: MAIN, pad: PAD, holder: undefined })
      );
      // MAIN 本身是 cwd,普通 rw bind 合法携带;unbound 段的特征是 --ro-bind 三重奏。
      expect(tripleIdx(offArgv, "--ro-bind", MAIN)).toBe(-1);
      assert.deepEqual([...offArgv], [...bareArgv]);
    }
  );

  it("bound session (liveTaskRoot 是 task worktree) → 无 unbound 段 (SC3 bound 档)", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const boundRoot = join(MAIN, ".iknow", "worktrees", "conv-1");
    const holder = makeHolder(true);
    const tool = createBashTool(MAIN, {
      liveTaskRoot: createLiveTaskRoot(boundRoot),
      tmpDir: PAD,
      worktreeOnMutate: { get: () => holder.get() },
    });
    const argv = await foregroundArgv(tool);
    expect(argv.includes(MAIN)).toBe(false);
    expect(tripleIdx(argv, "--ro-bind", MAIN)).toBe(-1);
  });

  it("入口 vintage:handler 执行中翻 holder 不渗透进本次调用", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const holder = makeHolder(true);
    const tool = makeTool({ mainCheckout: MAIN, pad: PAD, holder });
    // 执行中段翻 OFF:本次调用的 fence 段与 EROFS 回灌都必须按入口快照走。
    vi.mocked(runInSandbox).mockImplementation(async () => {
      holder.set(false);
      return {
        exitCode: 1,
        stdout: "",
        stderr: `touch: cannot touch '${join(MAIN, "f.txt")}': Read-only file system\n`,
      };
    });
    const envelope = parseBash(await tool.handler({ command: "touch f.txt" }));
    const argv = foregroundArgvFromMock();
    expect(tripleIdx(argv, "--ro-bind", MAIN)).toBeGreaterThan(-1);
    expect(envelope.stderr).toContain("[fs_denied]");
    // 下一次调用按新 vintage 装配:段消失。
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    const next = await foregroundArgv(tool);
    expect(tripleIdx(next, "--ro-bind", MAIN)).toBe(-1);
  });
});

function foregroundArgvFromMock(): readonly string[] {
  const calls = vi.mocked(runInSandbox).mock.calls;
  const last = calls[calls.length - 1]!;
  return (last[0] as { fence: { argv: readonly string[] } }).fence.argv;
}

describe("bash EROFS 回灌 — [fs_denied] 指引 (issue 1059)", () => {
  const EROFS_STDERR =
    "touch: cannot touch '/repo/f.txt': Read-only file system\n";

  function unboundTool(MAIN: string, PAD: string) {
    const holder = makeHolder(true);
    return makeTool({ mainCheckout: MAIN, pad: PAD, holder });
  }

  it("unbound + 非零退出 + EROFS stderr → 指引追加,含 create-worktree 指引与 attempted path", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: EROFS_STDERR,
    });
    const envelope = parseBash(
      await unboundTool(MAIN, PAD).handler({ command: "touch f.txt" })
    );
    expect(envelope.stderr).toContain("[fs_denied]");
    expect(envelope.stderr).toContain("create-worktree");
    expect(envelope.stderr).toContain("re-issue this same command");
    expect(envelope.stderr).toContain("/repo/f.txt");
    // 原文不被吞:指引是追加,EROFS 原始行仍在
    expect(envelope.stderr).toContain(EROFS_STDERR.trim());
  });

  it("unbound + 零退出(stderr 含 EROFS 字样) → 结果 byte-identical,不追加", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: EROFS_STDERR,
    });
    const envelope = parseBash(
      await unboundTool(MAIN, PAD).handler({ command: "grep x" })
    );
    expect(envelope.stderr).not.toContain("[fs_denied]");
    expect(envelope.stderr).toBe(EROFS_STDERR);
  });

  it("unbound + 非零退出但无 EROFS → stderr byte-identical", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const stderr = "bash: line 1: frobnicate: command not found\n";
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 127,
      stdout: "",
      stderr,
    });
    const envelope = parseBash(
      await unboundTool(MAIN, PAD).handler({ command: "frobnicate" })
    );
    expect(envelope.stderr).toBe(stderr);
    expect(envelope.stderr).not.toContain("[fs_denied]");
  });

  it("非 unbound 态 + EROFS 退出(holder OFF) → 不追加指引", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const holder = makeHolder(false);
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: EROFS_STDERR,
    });
    const envelope = parseBash(
      await makeTool({ mainCheckout: MAIN, pad: PAD, holder }).handler({
        command: "touch f.txt",
      })
    );
    expect(envelope.stderr).toBe(EROFS_STDERR);
    expect(envelope.stderr).not.toContain("[fs_denied]");
  });

  it("多条 EROFS 行 → attempted paths 上限 5 行并报余数", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const lines = Array.from(
      { length: 7 },
      (_, i) => `touch '/repo/f${i}.txt': Read-only file system`
    );
    vi.mocked(runInSandbox).mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: `${lines.join("\n")}\n`,
    });
    const envelope = parseBash(
      await unboundTool(MAIN, PAD).handler({ command: "touch many" })
    );
    // 原文 7 行全部保留(回灌是追加);上限只作用于指引里的 attempted paths 段。
    expect(envelope.stderr).toContain("f6.txt");
    const guidance = envelope.stderr.slice(
      envelope.stderr.indexOf("[fs_denied]")
    );
    expect(guidance).toContain("f4.txt");
    expect(guidance).not.toContain("f5.txt");
    expect(guidance).toContain("(+2 more EROFS lines)");
  });
});

describe("bash background unbound preflight notice (issue 1059 / M1)", () => {
  function backgroundCall(tool: ReturnType<typeof makeTool>) {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => makeFakeChild());
    return tool.handler({ command: "sleep 5", background: true }) as Promise<
      Record<string, unknown>
    >;
  }

  it("unbound + background → 回执含 [fs_denied] preflight notice", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const holder = makeHolder(true);
    const result = await backgroundCall(
      makeTool({ mainCheckout: MAIN, pad: PAD, holder, background: true })
    );
    expect(typeof result.notice).toBe("string");
    expect(result.notice as string).toContain("[fs_denied]");
    expect(result.notice as string).toContain("create-worktree");
  });

  it("holder OFF + background → 回执形状不变(无 notice 键,SC3 byte-identical)", async () => {
    const MAIN = makeScratch("unbound-main-");
    const PAD = makeScratch("unbound-pad-");
    const holder = makeHolder(false);
    const result = await backgroundCall(
      makeTool({ mainCheckout: MAIN, pad: PAD, holder, background: true })
    );
    expect("notice" in result).toBe(false);
    expect(typeof result.task_id).toBe("string");
    expect(typeof result.log_path).toBe("string");
  });
});

afterAll(() => {
  for (const path of scratchPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});
