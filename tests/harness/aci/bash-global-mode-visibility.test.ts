/**
 * ADR-0092 — global-mode visibility wiring (foreground + background).
 *
 * Replaces `bash-closed-world-read-roots.test.ts`: the closed-world read
 * whitelist (per-root `--ro-bind` of installRoot / global git config) retired
 * with global mode — `--bind / /` already exposes real host paths, so no
 * per-root read channel is needed. This file authenticates what remains true:
 *   - host root `--bind / /` is the same on both fg and bg sides;
 *   - read-only system-prefix rebinding remains (readable, writes denied);
 *   - no per-root `--ro-bind <home|installRoot>` whitelist emission anymore
 *     (that channel no longer exists to authenticate); absent options must not
 *     break construction.
 *
 * Foreground goes through the spawn-mock interception; background drives
 * defaultBackgroundSpawn directly (same mock).
 */
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";

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
const { defaultBackgroundSpawn } =
  await import("../../../src/harness/background/manager.ts");
const { READ_ONLY_SYSTEM_PATHS, OPTIONAL_HOST_RO_PREFIXES } =
  await import("../../../src/harness/sandbox/fs-policy.ts");
const {
  createProtectedTargetInventory,
  protectedTargetBindPaths,
  materializeProtectedTargets,
} = await import("../../../src/harness/sandbox/protected-targets.ts");

function makeFakeChild(pid = 47181) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  // The foreground path waits for child exit inside runInSandbox — emit
  // close(code 0) asynchronously to mimic bwrap returning instantly, so the
  // fake spawn never slows or times out the test.
  queueMicrotask(() => {
    child.emit("close", 0);
  });
  return child;
}

const REAL_DIRS: string[] = [];
function makeRealDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  REAL_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of REAL_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
});
afterEach(() => {
  spawnMock.mockReset();
});

function roBindIndex(argv: readonly string[], root: string): number {
  return argv.findIndex(
    (arg, i) =>
      arg === "--ro-bind" && argv[i + 1] === root && argv[i + 2] === root
  );
}

function hasHostRootBind(argv: readonly string[]): boolean {
  return argv.some(
    (arg, i) => arg === "--bind" && argv[i + 1] === "/" && argv[i + 2] === "/"
  );
}

/** A synthetic gh config and its immutable source are one paired cover,
 * not a per-root home/install read whitelist. Accept neither mount alone. */
function isDefaultGhConfigBind(
  argv: readonly string[],
  index: number
): boolean {
  const src = argv[index + 1] ?? "";
  const dest = argv[index + 2] ?? "";
  const hostConfig = join(homedir(), ".config", "gh", "config.yml");
  const sourceRoot = src === dest ? src : dirname(dirname(src));
  if (basename(sourceRoot) !== "protected-credential-cover") return false;
  const hasConfigCover = argv.some(
    (arg, i) =>
      arg === "--ro-bind" &&
      argv[i + 2] === hostConfig &&
      dirname(dirname(argv[i + 1] ?? "")) === sourceRoot &&
      basename(dirname(argv[i + 1] ?? "")).startsWith("gh-default-config-")
  );
  const hasSourceProtection = argv.some(
    (arg, i) =>
      arg === "--ro-bind" &&
      argv[i + 1] === sourceRoot &&
      argv[i + 2] === sourceRoot
  );
  return (
    hasConfigCover &&
    hasSourceProtection &&
    ((basename(src) === "config.yml" && dest === hostConfig) ||
      (src === sourceRoot && dest === sourceRoot))
  );
}

async function driveForeground(
  tool: ReturnType<typeof createBashTool>,
  command: string
): Promise<readonly string[]> {
  spawnMock.mockClear();
  await tool.handler({ command });
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  return (call?.[1] as readonly string[]) ?? [];
}

async function driveBackground(
  req: Parameters<typeof defaultBackgroundSpawn>[0]
): Promise<readonly string[]> {
  spawnMock.mockClear();
  await defaultBackgroundSpawn(req);
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  return (call?.[1] as readonly string[]) ?? [];
}

describe("bash global-mode visibility (ADR-0092 wiring)", () => {
  it("foreground fence binds the host root and never emits a per-root read whitelist", async () => {
    const taskRoot = makeRealDir("bash-global-task-");
    // `workspaceRoot` is the frozen name-pattern scan scope; without it the
    // handler resolves through `resolveWorkspaceRoot`, which on a test run is
    // `process.cwd()` — the whole repository checkout, walked on every
    // handler call and again for this test's reference inventory.
    const tool = createBashTool(taskRoot, { workspaceRoot: taskRoot });
    const argv = await driveForeground(tool, "echo fg");
    assert.ok(
      hasHostRootBind(argv),
      `foreground fence must --bind / /; argv=${JSON.stringify(argv)}`
    );
    // Only fixed ro-binds of system prefixes (plus optional host prefixes)
    // and the protected-target layer (T7 real ro-binds + T8 credential
    // covers) are allowed; the closed-world per-root read whitelist
    // (installRoot / git config) retired with global mode.
    const allowedRoBindTargets = new Set<string>([
      ...READ_ONLY_SYSTEM_PATHS,
      ...OPTIONAL_HOST_RO_PREFIXES,
    ]);
    // NOT SC5 evidence: this test's reference inventory is re-derived with the
    // very call production makes, so it can only ever agree with itself. The
    // real SC5 pins live in `bwrap-protected-mounts.test.ts` (argv
    // byte-identity vs. a no-inventory baseline).
    //
    // The scan root must match the tool's own: it does, because both sides
    // freeze it from `taskRoot` — passing `process.cwd()` here instead made
    // both the tool and this reference walk the whole repository checkout on
    // every run, for an allow-list entry that could never match.
    const inventory = createProtectedTargetInventory({
      home: homedir(),
      scanRoot: taskRoot,
    });
    // This assembly's materialized name-pattern matches are protected targets
    // like any concrete entry, so they belong in the allow-list too (#1155);
    // the retired per-root read whitelist stays retired either way.
    const materializedDests = materializeProtectedTargets(
      inventory
    ).targets.map((b) => b.path);
    const protectedDests = new Set([
      ...protectedTargetBindPaths(inventory).map((b) => b.path),
      ...materializedDests,
    ]);
    // The read-mask layer only ever emits per-file covers under CREDENTIAL-arm
    // bind paths, so subtree acceptance is restricted to that arm; the
    // filesystem arm stays exact-equality only (T7 block).
    const credentialDests = [
      ...protectedTargetBindPaths(inventory),
      ...materializeProtectedTargets(inventory).targets,
    ]
      .filter((b) => b.arm === "credential")
      .map((b) => b.path);
    const strayRoBind = argv.find((arg, i) => {
      if (arg !== "--ro-bind") return false;
      const src = argv[i + 1] ?? "";
      const dest = argv[i + 2] ?? "";
      if (allowedRoBindTargets.has(src) || src === taskRoot) return false;
      if (isDefaultGhConfigBind(argv, i)) return false;
      if (src === dest && protectedDests.has(src)) return false; // T7 block
      if (
        // T8 per-file covers sit UNDER a credential-arm subtree bind (e.g.
        // ~/.config/gh/config.yml under ~/.config/gh), so dest membership is
        // subtree coverage, not exact inventory equality.
        credentialDests.some((p) => dest === p || dest.startsWith(`${p}/`)) &&
        (src === "/dev/null" || src.includes("protected-credential-cover"))
      ) {
        return false; // T8 cover block
      }
      return true;
    });
    assert.equal(
      strayRoBind,
      undefined,
      "no per-root installRoot / home read whitelist in global mode"
    );
    assert.equal(
      argv.some((arg, i) => arg === "--bind" && argv[i + 1] === taskRoot),
      false,
      "retired: no per-root writable cwd bind in global mode"
    );
  });

  it("system prefixes stay read-only (visible but not writable)", async () => {
    const taskRoot = makeRealDir("bash-global-task2-");
    const tool = createBashTool(taskRoot, { workspaceRoot: taskRoot });
    const argv = await driveForeground(tool, "echo ro");
    for (const path of READ_ONLY_SYSTEM_PATHS) {
      assert.notEqual(
        roBindIndex(argv, path),
        -1,
        `system prefix ${path} must stay ro-bound`
      );
    }
  });

  it("background fence consumes the SAME host-root token as foreground (D2)", async () => {
    const taskRoot = makeRealDir("bash-global-task3-");
    const fg = await driveForeground(
      createBashTool(taskRoot, { workspaceRoot: taskRoot }),
      "echo parity"
    );
    const bg = await driveBackground({
      command: "echo parity",
      cwd: taskRoot,
      workspaceRoot: taskRoot,
    });
    assert.ok(hasHostRootBind(fg), "fg must --bind / /");
    assert.ok(hasHostRootBind(bg), "bg must --bind / /");
  });

  it("background fence without installRoot stays constructible (legacy callers)", async () => {
    const taskRoot = makeRealDir("bash-global-task4-");
    const argv = await driveBackground({
      command: "echo legacy",
      cwd: taskRoot,
    });
    assert.notEqual(argv.length, 0);
    assert.equal(argv[0], "--unshare-user-try");
  });
});
