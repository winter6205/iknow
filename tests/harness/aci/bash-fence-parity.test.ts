/**
 * #653 / T1 — 前台 / 后台 bash 沙箱纪律对齐 (argv 隔离轴集合相等)。
 *
 * 覆盖 spec SC lines 44-45 (positive + negative):
 *   - SC44 positive:同一 fixture 输入下，前台与后台 bwrap argv 在隔离轴上
 *     集合相等(cwdReadonly 开与关各至少一例)。
 *   - SC45 negative:产品 `bash` `background:true` 路径的 spawn argv 包含
 *     bwrap(或测试替身证明调用了与前台同一围栏构造缝);不存在「仅
 *     `nodeSpawn(command)` 无围栏」的产品分支。
 *
 * ADR-0092:默认档从闭世界换成全局档 —— 宿主 `/` 打底 + 系统前缀只读重绑,
 * 不再有 guest `/tmp` pad bind;前台后台共用同一 fence 构造缝。
 *
 * ADR-0097:网络轴在 fence 层是**常量**(netns 恒断,无 per-call opt-in),
 * 出口由 egress 缝 unix socket 代理。网络轴不是 argv 集合的可变维度 ——
 * 前后台 `--unshare-net` 都恒在。
 *
 * 驱动方式:
 *   - 前台:调 createBwrapFence,env 走产品缝(filter + cwdReadonly 时
 *     GIT_OPTIONAL_LOCKS=0,镜像 bash.ts,禁止只传 cwdReadonly 旗标
 *     而漏 fenceEnv)。
 *   - 后台:用模块级 vi.mock("node:child_process", ...) 拦截 spawn,
 *     直接调 defaultBackgroundSpawn 拿真实 fence.argv。
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

import {
  BASE_ENV_WHITELIST,
  READ_ONLY_SYSTEM_PATHS,
  applyCwdReadonlyFenceEnv,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
} from "../../../src/harness/sandbox/index.ts";

// 必须先于 manager 导入:模块级 vi.mock 会被 vitest hoist,但写在这里
// 也让读者直观看到拦截点 —— manager.ts defaultBackgroundSpawn 内部走
// `import { spawn as nodeSpawn } from "node:child_process"`,我们拦截的
// 就是这个 node:child_process 模块的 spawn。
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

// 在 mock 设置之后再 import manager —— 这样 manager.ts 引用的 spawn 是
// mock 之后的版本。
const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { defaultBackgroundSpawn } =
  await import("../../../src/harness/background/manager.ts");
const { ToolExecutionError } = await import("../../../src/harness/errors.ts");

/**
 * fake ChildProcess — EventEmitter + PassThrough streams + fake pid。
 * 让 spawn 工厂 fake 出 child 但不走真实 detach,捕获 argv。
 */
function makeFakeChild(pid = 99001) {
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  });
  return child;
}

/**
 * 镜像 bash.ts foreground fence 装配(ADR-0092 全局档)。
 * - env:envIsolation.filter(...) 后,cwdReadonly 时注入 GIT_OPTIONAL_LOCKS=0
 *   (产品缝 bash.ts,post-filter additive)
 * - fence 选项:cwdReadonly 由 opts 透传;网络轴无 opt-in(`--unshare-net`
 *   是常量)
 * - fsPolicy:全局档只承载 tmpRoot,不塑形 argv mount
 */
function foregroundFenceArgv(opts: {
  readonly cwd: string;
  readonly cwdReadonly: boolean;
}): readonly string[] {
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  const fenceEnv = applyCwdReadonlyFenceEnv(
    envIsolation.filter({ PATH: "/bin" }),
    opts.cwdReadonly
  );
  return createBwrapFence({
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ tmpDir: tmpdir() }),
    env: fenceEnv,
    cwd: opts.cwd,
    ...(opts.cwdReadonly ? { cwdReadonly: true } : {}),
  }).argv;
}

/**
 * 关键隔离旗标集合(spec SC line 44):从 argv 投影成集合,确保比较的是隔离
 * 维度而非 argv 顺序 / 拼写差异。
 *
 * ADR-0097:网络轴不在集合里——`--unshare-net` 是常量,既为 fg 又为 bg,
 * 加入集合也恒等,不参与差异比较。函数保留以备未来轴扩展时复用。
 */
function isolationAxisFlags(argv: readonly string[]): Set<string> {
  const flags = new Set<string>();
  // 网络轴 `--unshare-net` 恒在(不参与对称性比较,与下文各轴独立)。
  if (argv.includes("--unshare-net")) flags.add("unshare-net");
  // ADR-0021 生命周期轴
  if (argv.includes("--unshare-user-try")) flags.add("unshare-user-try");
  if (argv.includes("--die-with-parent")) flags.add("die-with-parent");
  // env 隔离轴
  if (argv.includes("--clearenv")) flags.add("clearenv");
  // ADR-0092 全局档:宿主根 `/` 打底 + 系统前缀只读重绑。
  if (argv.some((arg, i) => arg === "--bind" && argv[i + 2] === "/")) {
    flags.add("host-root-bind");
  }
  for (const path of READ_ONLY_SYSTEM_PATHS) {
    if (
      argv.some(
        (arg, i) =>
          arg === "--ro-bind" && argv[i + 1] === path && argv[i + 2] === path
      )
    ) {
      flags.add(`ro-bind:${path}`);
    }
  }
  // cwd 只读重绑 verb(--ro-bind);全局档无可写 --bind cwd 形态。
  if (argv.some((arg, idx) => arg === "--ro-bind" && argv[idx + 1] === CWD)) {
    flags.add("cwd-ro-bind");
  }
  // GIT_OPTIONAL_LOCKS=0 (foreground cwdReadonly 注入,bash.ts)。
  // 扫全部 --setenv 三元组:indexOf 会命中 PATH 等先出现的键,漏掉本轴。
  for (let i = 0; i < argv.length; i++) {
    if (
      argv[i] === "--setenv" &&
      argv[i + 1] === "GIT_OPTIONAL_LOCKS" &&
      argv[i + 2] === "0"
    ) {
      flags.add("git-optional-locks-0");
      break;
    }
  }
  return flags;
}

/**
 * 驱动 real defaultBackgroundSpawn,通过 vi.mock 拦截 child_process.spawn
 * 捕获 argv(不真启子进程)。
 *
 * ADR-0097:后台 fence 无网络入参 —— `--unshare-net` 恒在。
 */
async function backgroundFenceArgv(opts: {
  readonly cwd: string;
  readonly cwdReadonly: boolean;
}): Promise<readonly string[]> {
  spawnMock.mockImplementation(() => makeFakeChild());
  await defaultBackgroundSpawn({
    command: "echo hi",
    cwd: opts.cwd,
    env: { PATH: "/bin" },
    ...(opts.cwdReadonly ? { cwdReadonly: true } : {}),
  });
  // spawn 被调一次 —— 第一次参数(argv)就是 fence.argv 的展开形式。
  const call = spawnMock.mock.calls[0];
  expect(call).toBeDefined();
  // spawn(cmd, args, opts) — argv = [cmd, ...args]
  const argv = call?.[1] as readonly string[];
  spawnMock.mockClear();
  return argv;
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  spawnMock.mockReset();
});

// ── SC line 44:argv 隔离轴集合相等 ─────────────────────────────────────────

// 合同根(cwd)盘上校验 → fixture 用真实目录。
const CWD = mkdtempSync(join(tmpdir(), "bash-fence-parity-"));

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
});

describe("bash fence parity (foreground vs background argv isolation axis SETS)", () => {
  // ADR-0097:网络轴不在隔离维度里 —— `--unshare-net` 恒在,fg / bg 不存在
  // 网络输入差异。fixture 矩阵即 cwdReadonly 的两种取值,二者各自钉住
  // 「前后台隔离轴集合逐条相等」。
  const fixtures = [
    { cwdReadonly: true, label: "ro:true" },
    { cwdReadonly: false, label: "ro:false" },
  ] as const;

  for (const fx of fixtures) {
    it(`axis SETS equal: ${fx.label}`, async () => {
      const fg = foregroundFenceArgv({
        cwd: CWD,
        cwdReadonly: fx.cwdReadonly,
      });
      const bg = await backgroundFenceArgv({
        cwd: CWD,
        cwdReadonly: fx.cwdReadonly,
      });
      const fgFlags = [...isolationAxisFlags(fg)].sort();
      const bgFlags = [...isolationAxisFlags(bg)].sort();
      assert.deepEqual(
        bgFlags,
        fgFlags,
        `fg/bg isolation axes differ (${fx.label})\nfg=${JSON.stringify(fgFlags)}\nbg=${JSON.stringify(bgFlags)}`
      );
    });
  }

  it("cwdReadonly:true → bg argv contains --ro-bind <cwd>", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: true,
    });
    const hasBgRoBind = bg.some(
      (arg, idx) => arg === "--ro-bind" && bg[idx + 1] === CWD
    );
    assert.ok(
      hasBgRoBind,
      `bg argv must have --ro-bind ${CWD}, got ${JSON.stringify(bg)}`
    );
  });

  it("cwdReadonly:false → bg argv has no cwd ro-bind (covered by host root)", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    const hasBgRoBind = bg.some(
      (arg, idx) => arg === "--ro-bind" && bg[idx + 1] === CWD
    );
    assert.equal(
      hasBgRoBind,
      false,
      "global mode must not ro-bind cwd when not readonly"
    );
  });

  it("ADR-0097: both fg and bg argv carry --unshare-net (constant netns isolation)", async () => {
    // 钉住 SC1(--unshare-net 恒在)的 fg / bg 形态;fg / bg 同步恒等。
    const fg = foregroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    assert.ok(fg.includes("--unshare-net"), "fg must carry --unshare-net");
    assert.ok(bg.includes("--unshare-net"), "bg must carry --unshare-net");
    assert.ok(
      fg.includes("--die-with-parent"),
      "fg must keep --die-with-parent"
    );
    assert.ok(
      bg.includes("--die-with-parent"),
      "bg must keep --die-with-parent"
    );
    assert.ok(bg.includes("--clearenv"), "bg must keep --clearenv");
  });

  it("cwdReadonly:true → bg argv --setenv GIT_OPTIONAL_LOCKS 0 (mirror bash.ts)", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: true,
    });
    const injected = bg.some(
      (arg, idx) =>
        arg === "--setenv" &&
        bg[idx + 1] === "GIT_OPTIONAL_LOCKS" &&
        bg[idx + 2] === "0"
    );
    assert.ok(
      injected,
      `bg fence env must contain GIT_OPTIONAL_LOCKS=0 when cwdReadonly, got ${JSON.stringify(bg)}`
    );
  });

  it("cwdReadonly:false → bg argv does not inject GIT_OPTIONAL_LOCKS", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    const injected = bg.some(
      (arg, idx) => arg === "--setenv" && bg[idx + 1] === "GIT_OPTIONAL_LOCKS"
    );
    assert.equal(
      injected,
      false,
      "bg must not inject GIT_OPTIONAL_LOCKS when cwdReadonly is false"
    );
  });
});

// ── ADR-0092 全局档:宿主根 + 系统前缀只读重绑的前后台 parity ──────────────

describe("bash fence parity — global-mode mounts (host root + system ro-binds)", () => {
  function roBindIndex(argv: readonly string[], root: string): number {
    return argv.findIndex(
      (arg, i) =>
        arg === "--ro-bind" && argv[i + 1] === root && argv[i + 2] === root
    );
  }

  it("host-root --bind / / present on BOTH sides (same token)", async () => {
    const fg = foregroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    const isRootBind = (argv: readonly string[]): boolean =>
      argv.some(
        (arg, i) =>
          arg === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/"
      );
    assert.ok(isRootBind(fg), "fg must --bind / /");
    assert.ok(isRootBind(bg), "bg must --bind / /");
  });

  it("system ro-binds present on BOTH sides (same tokens)", async () => {
    const fg = foregroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    for (const path of READ_ONLY_SYSTEM_PATHS) {
      assert.notEqual(roBindIndex(fg, path), -1, `fg must ro-bind ${path}`);
      assert.notEqual(roBindIndex(bg, path), -1, `bg must ro-bind ${path}`);
    }
  });

  it("neither side carries a guest /tmp pad bind or tmpfs", async () => {
    const fg = foregroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
    });
    for (const argv of [fg, bg]) {
      assert.equal(
        argv.some((arg, i) => arg === "--bind" && argv[i + 2] === "/tmp"),
        false,
        "guest /tmp pad bind is retired (ADR-0092)"
      );
      assert.equal(
        argv.includes("--tmpfs"),
        false,
        "--tmpfs /tmp is retired (ADR-0092)"
      );
    }
  });
});

// ── SC line 45 (negative):产品 bash background:true 路径走围栏构造缝 ──────

describe("defaultBackgroundSpawn negative — drives createBwrapFence seam", () => {
  it("bg spawn argv[0] === 'bwrap' (产品路径不裸 spawn 命令)", async () => {
    spawnMock.mockImplementation(() => makeFakeChild());
    await defaultBackgroundSpawn({
      command: "echo hi",
      cwd: CWD,
      env: { PATH: "/bin" },
    });
    const call = spawnMock.mock.calls[0];
    expect(call).toBeDefined();
    const cmd = call?.[0] as string;
    assert.equal(
      cmd,
      "bwrap",
      "spawn cmd must be bwrap, not the raw bash command"
    );
    // argv 至少包含宿主根 bind + --clearenv(隔离护栏存在)。
    const argv = call?.[1] as readonly string[];
    assert.ok(argv.includes(CWD), "argv must include cwd");
    assert.ok(
      argv.some((arg, i) => arg === "--bind" && argv[i + 2] === "/"),
      "argv must bind the host root at /"
    );
    assert.ok(argv.includes("--clearenv"), "argv must include --clearenv");
  });

  it("bg spawn argv 包含 detached 生命周期护栏 (--die-with-parent)", async () => {
    spawnMock.mockImplementation(() => makeFakeChild());
    await defaultBackgroundSpawn({
      command: "echo hi",
      cwd: CWD,
      env: { PATH: "/bin" },
    });
    const argv = (spawnMock.mock.calls[0]?.[1] as readonly string[]) ?? [];
    assert.ok(
      argv.includes("--die-with-parent"),
      "bg argv must include --die-with-parent (ADR-0021 lifecycle)"
    );
  });

  it("bg spawn workspace 档漏传 homeRoot → typed fail-loud（不静默退化成全局档）", async () => {
    // 后台是独立调用点(defaultBackgroundSpawn):workspace 档下 req.homeRoot
    // 缺席时若跳过 home ro-bind,后台围栏静默退回全局档(home 可写)而前台
    // 仍是工作区档 —— 违反沙箱纪律 G3(前后台隔离轴集合相等)且无信号。
    // 判别力:修复前 manager.ts 的 `fsMode === "workspace" && homeRoot !==
    // undefined` 预过滤让这里静默 spawn(测试红);修复后 bwrap 抛 typed。
    spawnMock.mockImplementation(() => makeFakeChild());
    await assert.rejects(
      () =>
        defaultBackgroundSpawn({
          command: "echo hi",
          cwd: CWD,
          env: { PATH: "/bin" },
          fsMode: "workspace",
          // homeRoot 缺席 —— 缺口本身。
        }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /homeRoot/.test(err.message),
      "workspace-mode background spawn without homeRoot must fail loud"
    );
    assert.equal(
      spawnMock.mock.calls.length,
      0,
      "no child may be spawned from a fence that failed to assemble"
    );

    // 判别力对照:homeRoot 在场时同一调用点正常 spawn,argv 带 home ro-bind。
    await defaultBackgroundSpawn({
      command: "echo hi",
      cwd: CWD,
      env: { PATH: "/bin" },
      fsMode: "workspace",
      homeRoot: CWD,
    });
    const argv = (spawnMock.mock.calls[0]?.[1] as readonly string[]) ?? [];
    assert.ok(
      argv.some(
        (arg, i) =>
          arg === "--ro-bind" && argv[i + 1] === CWD && argv[i + 2] === CWD
      ),
      "control: workspace-mode background argv carries the home ro-bind"
    );
  });
});
