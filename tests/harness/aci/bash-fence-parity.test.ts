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
 *
 * #D2 (per-call concurrency safety) — what this file's foreground mirror
 * mirrors, and what it does not:
 *
 *   The production foreground fence env is assembled in the `bash` handler
 *   (`src/harness/aci/tools/bash.ts`, the `fenceEnv` spread next to
 *   `applyCwdReadonlyFenceEnv`): the handler computes the per-call
 *   concurrency-safety verdict for the call's RAW input with
 *   `isReadonlyBashConcurrencySafe`
 *   (`src/harness/aci/tools/bash-concurrency.ts`) and injects
 *   `GIT_OPTIONAL_LOCKS=0` into the fence env WHEN THAT VERDICT IS TRUE AND
 *   the command actually runs git
 *   (`...gitOptionalLocksFenceEnv(command, concurrencySafe)`). A call the
 *   predicate rejects gets nothing added — the env stays exactly as it was;
 *   and so does a read-only call that never runs git (`ls`, `pwd`), because
 *   the variable is git-specific.
 *
 *   This file's `foregroundFenceArgv` reproduces that assembly:
 *     - it CALLS the production predicate for the verdict instead of
 *       re-implementing its rules, so the mirror cannot drift from the
 *       predicate (a re-implementation of the decision rule would be a second
 *       copy of the policy tables, free to diverge silently);
 *     - it CALLS the production `gitOptionalLocksFenceEnv` for the #D2
 *       injection itself (imported from `bash.ts` below), so the trigger
 *       rule — verdict AND git invocation — has exactly ONE copy in the
 *       repository and this file cannot drift from it;
 *     - it applies the same two guards in the same order — the readonly
 *       guard (`applyCwdReadonlyFenceEnv`) and then the #D2 concurrency
 *       guard;
 *     - it does NOT reproduce the handler's `TMPDIR` wiring nor the secret
 *       registry's restore step: neither reaches an axis this file compares
 *       (the comparison is over isolation-axis FLAGS, not env values), and
 *       the background side builds its own `TMPDIR` from its fs policy.
 *
 *   Consequence for the fg/bg comparison: the background arm of the handler
 *   returns BEFORE the fence-env assembly (bash.ts), and the predicate
 *   rejects every `background: true` call, so the background fence never
 *   carries the #D2 injection. The two fences are therefore set-equal only
 *   for a call the predicate REJECTS — the parity fixture below uses such a
 *   command, and the fg-only injection is covered on its own.
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
// The production per-call concurrency verdict the bash handler uses (#D2).
// The mirror below CALLS it, so the mirror cannot drift from the predicate.
import {
  commandInvokesGit,
  isReadonlyBashConcurrencySafe,
} from "../../../src/harness/aci/tools/bash-concurrency.ts";
// The production #D2 fence-env trigger itself (the narrow rule: the verdict
// AND a command that runs git). The mirror CALLS it — there is no second
// copy of the trigger rule in this file.
import { gitOptionalLocksFenceEnv } from "../../../src/harness/aci/tools/bash.ts";

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
 *   (product seam bash.ts, post-filter additive), then the #D2 concurrency
 *   guard: GIT_OPTIONAL_LOCKS=0 when the production predicate
 *   (`isReadonlyBashConcurrencySafe`, the same call bash.ts makes with the
 *   call's RAW input) judges the call concurrency-safe
 * - fence options: cwdReadonly passes through from opts; no network opt-in
 *   (`--unshare-net` is a constant)
 * - fsPolicy: global mode carries only tmpRoot, it does not shape argv mounts
 */
function foregroundFenceArgv(opts: {
  readonly cwd: string;
  readonly cwdReadonly: boolean;
  /** The command the call runs — the verdict is computed FROM it. */
  readonly command: string;
}): readonly string[] {
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  // The production verdict, computed the way bash.ts computes it: the
  // predicate takes the call's RAW input (a foreground call carries
  // `command` and no `background`).
  const concurrencySafe = isReadonlyBashConcurrencySafe({
    command: opts.command,
  });
  const fenceEnv = {
    ...applyCwdReadonlyFenceEnv(
      envIsolation.filter({ PATH: "/bin" }),
      opts.cwdReadonly
    ),
    ...gitOptionalLocksFenceEnv(opts.command, concurrencySafe),
  };
  return createBwrapFence({
    command: "bash",
    args: ["-c", opts.command],
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
  // GIT_OPTIONAL_LOCKS=0 (injected by foreground cwdReadonly and by the #D2
  // concurrency-safe verdict, bash.ts).
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
  /** The command the call runs — the same command the foreground side runs. */
  readonly command: string;
}): Promise<readonly string[]> {
  spawnMock.mockImplementation(() => makeFakeChild());
  await defaultBackgroundSpawn({
    command: opts.command,
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

/**
 * The command both sides of the fg/bg comparison run.
 *
 * It is deliberately a command the #D2 predicate REJECTS. The background arm
 * of the handler returns BEFORE the fence-env assembly (bash.ts), and the
 * predicate rejects every `background: true` call, so the background fence
 * never carries the concurrency injection: the two fences are set-equal only
 * for a call the predicate rejects. `touch` is not readonly-safe (the
 * command roster denies it), so the verdict is false.
 *
 * Nothing is ever executed — the background side's spawn is intercepted by
 * the vi.mock above, and the foreground side only builds an argv.
 */
const PARITY_COMMAND = "touch parity-probe.txt";

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
        command: PARITY_COMMAND,
      });
      const bg = await backgroundFenceArgv({
        cwd: CWD,
        cwdReadonly: fx.cwdReadonly,
        command: PARITY_COMMAND,
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

  it("fixture precondition: the parity command is NOT concurrency-safe (fg and bg fences must agree)", () => {
    // The fg/bg set-equality above is only truthful for a call the #D2
    // predicate REJECTS: the background arm of the handler returns before the
    // fence-env assembly, so the background fence never carries the #D2
    // injection. If the predicate ever starts accepting this command, the
    // fixture must change — the equality would otherwise assert a parity the
    // product does not have.
    assert.equal(
      isReadonlyBashConcurrencySafe({ command: PARITY_COMMAND }),
      false,
      "the parity fixture command must be one the #D2 predicate rejects"
    );
  });

  it("cwdReadonly:true → bg argv contains --ro-bind <cwd>", async () => {
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: true,
      command: PARITY_COMMAND,
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
      command: PARITY_COMMAND,
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
      command: PARITY_COMMAND,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: PARITY_COMMAND,
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
      command: PARITY_COMMAND,
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
      command: PARITY_COMMAND,
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

// ── #D2: the foreground fence env carries the per-call concurrency injection ──

describe("bash fence parity — #D2 concurrency-safe fence env (foreground)", () => {
  /** Does the argv carry the `--setenv GIT_OPTIONAL_LOCKS 0` triple? */
  function injectsGitOptionalLocks(argv: readonly string[]): boolean {
    return argv.some(
      (arg, idx) =>
        arg === "--setenv" &&
        argv[idx + 1] === "GIT_OPTIONAL_LOCKS" &&
        argv[idx + 2] === "0"
    );
  }

  it("a concurrency-safe GIT call → fg fence injects GIT_OPTIONAL_LOCKS=0 (mirror bash.ts)", () => {
    // The production condition (bash.ts): the handler computes the per-call
    // concurrency-safety verdict for the command AND asks whether the
    // command runs git; GIT_OPTIONAL_LOCKS=0 goes into the fence env only
    // when BOTH hold.
    const fg = foregroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: "git status",
    });
    assert.ok(
      injectsGitOptionalLocks(fg),
      `fg fence must carry GIT_OPTIONAL_LOCKS=0 for a concurrency-safe git call, got ${JSON.stringify(fg)}`
    );
  });

  it("a concurrency-safe NON-git call → fg fence does NOT inject GIT_OPTIONAL_LOCKS", () => {
    // The variable is git-specific: `ls` is concurrency-safe but never runs
    // git, so it must not carry it. Widening the trigger back to "the
    // verdict alone" turns this case RED.
    const fg = foregroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: "ls",
    });
    assert.equal(
      injectsGitOptionalLocks(fg),
      false,
      "fg fence must not inject GIT_OPTIONAL_LOCKS for a call that does not run git"
    );
  });

  it("a rejected call → fg fence does NOT inject GIT_OPTIONAL_LOCKS", () => {
    const fg = foregroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: PARITY_COMMAND,
    });
    assert.equal(
      injectsGitOptionalLocks(fg),
      false,
      "fg fence must not inject GIT_OPTIONAL_LOCKS for a call the predicate rejects"
    );
  });

  it("fg injection follows the production rule exactly (mirror cannot drift)", () => {
    // The production rule is the AND of two facts: the per-call verdict and
    // "the command runs git" (`commandInvokesGit`). The mirror calls both
    // production functions, so this case pins the COMPOSITION as well.
    for (const command of [
      "git status",
      "git log --oneline -5",
      "pwd",
      "ls",
      "cat file",
      PARITY_COMMAND,
    ]) {
      const expected =
        isReadonlyBashConcurrencySafe({ command }) &&
        commandInvokesGit(command);
      const fg = foregroundFenceArgv({
        cwd: CWD,
        cwdReadonly: false,
        command,
      });
      assert.equal(
        injectsGitOptionalLocks(fg),
        expected,
        `fg fence env disagrees with the production rule for ${JSON.stringify(command)}`
      );
    }
  });

  it("bg fence never carries the injection (the bg arm returns before the fg fence env)", async () => {
    // The background arm of the handler returns BEFORE the fence-env
    // assembly, and the predicate rejects every `background: true` call —
    // so the bg fence never carries the #D2 injection. This is why the
    // fg/bg set-equality fixture uses a command the predicate rejects.
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: "pwd",
    });
    assert.equal(
      injectsGitOptionalLocks(bg),
      false,
      "the background arm of the handler never reaches the fg fence-env assembly"
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
      command: PARITY_COMMAND,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: PARITY_COMMAND,
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
      command: PARITY_COMMAND,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: PARITY_COMMAND,
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
      command: PARITY_COMMAND,
    });
    const bg = await backgroundFenceArgv({
      cwd: CWD,
      cwdReadonly: false,
      command: PARITY_COMMAND,
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
