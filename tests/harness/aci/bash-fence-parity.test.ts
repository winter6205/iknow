/**
 * #653 / T1 — 前台 / 后台 bash 沙箱纪律对齐 (argv 隔离轴集合相等)。
 *
 * 覆盖 spec SC lines 44-45 (positive + negative)：
 *   - SC44 positive:同一 fixture 输入下，前台与后台 bwrap argv 在隔离轴上
 *     集合相等(network / cwdReadonly 开与关各至少一例)。
 *   - SC45 negative:产品 `bash` `background:true` 路径的 spawn argv 包含
 *     bwrap(或测试替身证明调用了与前台同一围栏构造缝);不存在「仅
 *     `nodeSpawn(command)` 无围栏」的产品分支。
 *
 * 驱动方式:
 *   - 前台:调 createBwrapFence,env 走产品缝(filter + cwdReadonly 时
 *     GIT_OPTIONAL_LOCKS=0,镜像 bash.ts:126-134,禁止只传 cwdReadonly 旗标
 *     而漏 fenceEnv)。
 *   - 后台:用模块级 vi.mock("node:child_process", ...) 拦截 spawn,
 *     直接调 defaultBackgroundSpawn 拿真实 fence.argv。
 *
 * 关键约束:#653 / T1 之前此测试必须失败 —— 后台路径不传 cwdReadonly,
 * 集合对比时 cwdReadonly:fg 有 / bg 无,差异落在 cwdReadonly 轴上;
 * #653 / T1 之后绿。
 */

import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BASE_ENV_WHITELIST,
  applyCwdReadonlyFenceEnv,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createResourceLimits,
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
 * 镜像 bash.ts foreground fence 装配(bash.ts:126-162)。
 * - env:envIsolation.filter(...) 后,cwdReadonly 时注入 GIT_OPTIONAL_LOCKS=0
 *   (产品缝 bash.ts:132-134,post-filter additive)
 * - fence 选项:network + cwdReadonly 由 opts 透传
 */
function foregroundFenceArgv(opts: {
  readonly cwd: string;
  readonly network: boolean;
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
    fsPolicy: createFsPolicy({
      cwd: opts.cwd,
      home: "/home/user",
      tmpDir: "/tmp/job",
    }),
    networkPolicy: createNetworkPolicy(),
    resourceLimits: createResourceLimits(),
    env: fenceEnv,
    cwd: opts.cwd,
    ...(opts.network ? { network: true } : {}),
    ...(opts.cwdReadonly ? { cwdReadonly: true } : {}),
  }).argv;
}

/**
 * 关键隔离旗标集合(spec SC line 44):从 argv 投影成集合,确保比较的是隔离
 * 维度而非 argv 顺序 / 拼写差异。
 */
function isolationAxisFlags(argv: readonly string[]): Set<string> {
  const flags = new Set<string>();
  // 网络轴:--unshare-net 存在 = 隔离,否则 = host-net
  if (argv.includes("--unshare-net")) flags.add("unshare-net");
  else flags.add("host-net");
  // ADR-0021 生命周期轴
  if (argv.includes("--unshare-user-try")) flags.add("unshare-user-try");
  if (argv.includes("--die-with-parent")) flags.add("die-with-parent");
  // env 隔离轴
  if (argv.includes("--clearenv")) flags.add("clearenv");
  // rlimit + tmpfs
  if (argv.includes("--size")) flags.add("rlimit-tmp-size");
  if (argv.includes("--tmpfs")) flags.add("tmpfs");
  // cwd 绑定 verb --bind vs --ro-bind
  const hasCwdRoBind = argv.some(
    (arg, idx) => arg === "--ro-bind" && argv[idx + 1] === "/workspace"
  );
  const hasCwdBind = argv.some(
    (arg, idx) => arg === "--bind" && argv[idx + 1] === "/workspace"
  );
  if (hasCwdRoBind) flags.add("cwd-ro-bind");
  if (hasCwdBind) flags.add("cwd-bind");
  // GIT_OPTIONAL_LOCKS=0 (foreground cwdReadonly 注入,bash.ts:132-134)。
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
 * Pre-fix:BackgroundSpawnRequest 不含 cwdReadonly 字段,cwdReadonly 参数无法
 * 传入 → fg argv 含 cwd-ro-bind,bg argv 不含 → 轴集合不等。
 * Post-fix:cwdReadonly 字段已加入,defaultBackgroundSpawn 透传到 fence →
 * bg argv 同样含 cwd-ro-bind → 轴集合相等。
 */
async function backgroundFenceArgv(opts: {
  readonly cwd: string;
  readonly network: boolean;
  readonly cwdReadonly: boolean;
}): Promise<readonly string[]> {
  spawnMock.mockImplementation(() => makeFakeChild());
  await defaultBackgroundSpawn({
    command: "echo hi",
    cwd: opts.cwd,
    env: { PATH: "/bin" },
    home: "/home/user",
    ...(opts.network ? { network: true } : {}),
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

const CWD = "/workspace";

describe("bash fence parity (foreground vs background argv isolation axis SETS)", () => {
  // 4 个 fixture:network × cwdReadonly 全笛卡尔积
  const fixtures = [
    { network: true, cwdReadonly: true, label: "net:true,ro:true" },
    { network: true, cwdReadonly: false, label: "net:true,ro:false" },
    { network: false, cwdReadonly: true, label: "net:false,ro:true" },
    { network: false, cwdReadonly: false, label: "net:false,ro:false" },
  ] as const;

  for (const fx of fixtures) {
    it(`axis SETS equal: ${fx.label}`, async () => {
      const fg = foregroundFenceArgv({
        cwd: CWD,
        network: fx.network,
        cwdReadonly: fx.cwdReadonly,
      });
      const bg = await backgroundFenceArgv({
        cwd: CWD,
        network: fx.network,
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

  // 关键单点断言 —— 在 #653 T1 之前,这一组断言会因为 bg 漏 cwdReadonly 而 fail。
  it("cwdReadonly:true → bg argv contains --ro-bind <cwd>, no --bind <cwd>", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      network: false,
      cwdReadonly: true,
    });
    const hasBgRoBind = bg.some(
      (arg, idx) => arg === "--ro-bind" && bg[idx + 1] === CWD
    );
    const hasBgBind = bg.some(
      (arg, idx) => arg === "--bind" && bg[idx + 1] === CWD
    );
    assert.ok(
      hasBgRoBind,
      `bg argv must have --ro-bind ${CWD}, got ${JSON.stringify(bg)}`
    );
    assert.equal(
      hasBgBind,
      false,
      `bg argv must drop --bind ${CWD} when readonly`
    );
  });

  it("cwdReadonly:false → bg argv contains --bind <cwd>, no --ro-bind <cwd>", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      network: false,
      cwdReadonly: false,
    });
    const hasBgBind = bg.some(
      (arg, idx) => arg === "--bind" && bg[idx + 1] === CWD
    );
    const hasBgRoBind = bg.some(
      (arg, idx) => arg === "--ro-bind" && bg[idx + 1] === CWD
    );
    assert.ok(hasBgBind, `bg argv must have --bind ${CWD}`);
    assert.equal(
      hasBgRoBind,
      false,
      `bg argv must drop --ro-bind ${CWD} when not readonly`
    );
  });

  it("network:true → bg argv drops --unshare-net, fg keeps --die-with-parent", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      network: true,
      cwdReadonly: false,
    });
    assert.equal(
      bg.includes("--unshare-net"),
      false,
      `bg must drop --unshare-net when network:true`
    );
    assert.ok(
      bg.includes("--die-with-parent"),
      "bg must keep --die-with-parent"
    );
    assert.ok(
      bg.includes("--unshare-user-try"),
      "bg must keep --unshare-user-try"
    );
    assert.ok(bg.includes("--clearenv"), "bg must keep --clearenv");
  });

  it("network:false → bg argv keeps --unshare-net (default isolation)", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      network: false,
      cwdReadonly: false,
    });
    assert.ok(bg.includes("--unshare-net"), "bg must keep --unshare-net");
  });

  it("cwdReadonly:true → bg argv --setenv GIT_OPTIONAL_LOCKS 0 (mirror bash.ts:132-134)", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      network: false,
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
      network: false,
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

// ── SC line 45 (negative):产品 bash background:true 路径走围栏构造缝 ──────

describe("defaultBackgroundSpawn negative — drives createBwrapFence seam", () => {
  it("bg spawn argv[0] === 'bwrap' (产品路径不裸 spawn 命令)", async () => {
    spawnMock.mockImplementation(() => makeFakeChild());
    await defaultBackgroundSpawn({
      command: "echo hi",
      cwd: CWD,
      env: { PATH: "/bin" },
      home: "/home/user",
    });
    const call = spawnMock.mock.calls[0];
    expect(call).toBeDefined();
    const cmd = call?.[0] as string;
    assert.equal(
      cmd,
      "bwrap",
      "spawn cmd must be bwrap, not the raw bash command"
    );
    // argv 至少包含 cwd bind verb + /tmp + --clearenv(隔离护栏存在)。
    const argv = call?.[1] as readonly string[];
    assert.ok(argv.includes(CWD), "argv must include cwd");
    assert.ok(argv.includes("--tmpfs"), "argv must include --tmpfs");
    assert.ok(argv.includes("--clearenv"), "argv must include --clearenv");
  });

  it("bg spawn argv 包含 detached 生命周期护栏 (--die-with-parent)", async () => {
    spawnMock.mockImplementation(() => makeFakeChild());
    await defaultBackgroundSpawn({
      command: "echo hi",
      cwd: CWD,
      env: { PATH: "/bin" },
      home: "/home/user",
    });
    const argv = (spawnMock.mock.calls[0]?.[1] as readonly string[]) ?? [];
    assert.ok(
      argv.includes("--die-with-parent"),
      "bg argv must include --die-with-parent (ADR-0021 lifecycle)"
    );
  });
});
