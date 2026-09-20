/**
 * Foreground / background bash sandbox discipline parity (argv isolation-axis
 * set equality).
 *
 * Coverage:
 *   - positive: under the same fixture input, foreground and background bwrap
 *     argv are set-equal on the isolation axes (at least one case each with
 *     cwdReadonly on and off).
 *   - negative: the product `bash` `background:true` path's spawn argv contains
 *     bwrap (or a test double proves it goes through the same fence-construction
 *     seam as the foreground); no "bare `nodeSpawn(command)` without fence"
 *     product branch may exist.
 *
 * ADR-0092: the default tier moved from closed-world to global mode — host `/`
 * base bind + read-only system-prefix rebinding; no guest `/tmp` pad bind
 * anymore; foreground and background share the same fence-construction seam.
 *
 * ADR-0097: the network axis is a **constant** at fence layer (netns always
 * severed, no per-call opt-in); egress goes through the egress-seam unix
 * socket proxy. The network axis is not a mutable dimension of the argv set —
 * `--unshare-net` is always present on both sides.
 *
 * Driving:
 *   - foreground: call createBwrapFence with env built through the product seam
 *     (filter + GIT_OPTIONAL_LOCKS=0 when cwdReadonly, mirroring bash.ts; never
 *     pass only the cwdReadonly flag while dropping fenceEnv).
 *   - background: module-level vi.mock("node:child_process", ...) intercepts
 *     spawn; call defaultBackgroundSpawn directly to capture the real fence.argv.
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

// Must precede the manager import: module-level vi.mock is hoisted by vitest,
// but placing it here also shows the interception point plainly — manager.ts's
// defaultBackgroundSpawn internally does
// `import { spawn as nodeSpawn } from "node:child_process"`, and that module's
// spawn is exactly what we intercept.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
  };
});

// Import the manager after the mock is set up — the spawn manager.ts references
// is then the mocked version.
const childProcessMock = await import("node:child_process");
const spawnMock = childProcessMock.spawn as unknown as ReturnType<typeof vi.fn>;

const { defaultBackgroundSpawn } =
  await import("../../../src/harness/background/manager.ts");
const { ToolExecutionError } = await import("../../../src/harness/errors.ts");

/**
 * Fake ChildProcess — EventEmitter + PassThrough streams + fake pid.
 * Lets the spawn factory fake a child without real detach, so argv can be captured.
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
 * Mirrors bash.ts foreground fence assembly (ADR-0092 global mode).
 * - env: envIsolation.filter(...), then GIT_OPTIONAL_LOCKS=0 when cwdReadonly
 *   (product seam bash.ts, post-filter additive)
 * - fence options: cwdReadonly passes through from opts; no network opt-in
 *   (`--unshare-net` is a constant)
 * - fsPolicy: global mode carries only tmpRoot, it does not shape argv mounts
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
 * The key isolation-flag set: project argv into a set so the comparison covers
 * isolation dimensions, not argv order or spelling differences.
 *
 * ADR-0097: the network axis is deliberately out of the set — `--unshare-net`
 * is a constant for both fg and bg, so including it stays identically true and
 * it never drives a diff. The function is kept for future axis expansion.
 */
function isolationAxisFlags(argv: readonly string[]): Set<string> {
  const flags = new Set<string>();
  // Network axis: --unshare-net always present (trivially equal on both sides).
  if (argv.includes("--unshare-net")) flags.add("unshare-net");
  // lifecycle axis (ADR-0021)
  if (argv.includes("--unshare-user-try")) flags.add("unshare-user-try");
  if (argv.includes("--die-with-parent")) flags.add("die-with-parent");
  // env isolation axis
  if (argv.includes("--clearenv")) flags.add("clearenv");
  // ADR-0092 global mode: host root `/` base bind + read-only system rebinding.
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
  // cwd read-only rebinding verb (--ro-bind); global mode has no writable --bind cwd form.
  if (argv.some((arg, idx) => arg === "--ro-bind" && argv[idx + 1] === CWD)) {
    flags.add("cwd-ro-bind");
  }
  // GIT_OPTIONAL_LOCKS=0 (injected by foreground cwdReadonly, bash.ts).
  // Scan every --setenv triple: indexOf would hit earlier keys like PATH and miss this axis.
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
 * Drives the real defaultBackgroundSpawn, capturing argv via the vi.mock
 * interception of child_process.spawn (no real child is started).
 *
 * ADR-0097: the background fence takes no network input — `--unshare-net` is constant.
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
  // spawn is called once — its first argument (argv) is the expansion of fence.argv.
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

// ── argv isolation-axis set equality ────────────────────────────────────────

// The contract root (cwd) is validated on disk → the fixture uses a real directory.
const CWD = mkdtempSync(join(tmpdir(), "bash-fence-parity-"));

afterAll(() => {
  rmSync(CWD, { recursive: true, force: true });
});

describe("bash fence parity (foreground vs background argv isolation axis SETS)", () => {
  // ADR-0097: the network axis is outside the isolation dimensions —
  // `--unshare-net` is constant, so fg / bg have no network-input difference.
  // The fixture matrix is just cwdReadonly's two values, each pinning
  // "fg/bg isolation-axis sets equal entry by entry".
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
    // Pins `--unshare-net` constantly present on both fg and bg sides.
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

// ── ADR-0092 global mode: fg/bg parity of host root + read-only system rebinding ──

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

// ── negative: the product bash background:true path goes through the fence-construction seam ──

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
    // The argv carries at least the host-root bind + --clearenv (isolation guardrails present).
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
    // Background is an independent call site (defaultBackgroundSpawn): in
    // workspace mode, if req.homeRoot were absent and the home ro-bind silently
    // skipped, the background fence would degrade to global mode (home writable)
    // while foreground stays workspace-mode — violating the fg/bg parity
    // discipline with no signal. Discriminative power: before the fix,
    // manager.ts's `fsMode === "workspace" && homeRoot !== undefined`
    // pre-filter let this spawn silently (test red); after the fix bwrap throws
    // a typed error.
    spawnMock.mockImplementation(() => makeFakeChild());
    await assert.rejects(
      () =>
        defaultBackgroundSpawn({
          command: "echo hi",
          cwd: CWD,
          env: { PATH: "/bin" },
          fsMode: "workspace",
          // homeRoot absent — that omission is the gap under test.
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

    // Discriminating control: with homeRoot present the same call site spawns
    // normally and the argv carries the home ro-bind.
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
