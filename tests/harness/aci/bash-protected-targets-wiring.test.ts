/**
 * T8/T9 wiring (specs/effect-boundary-protection.md SC4, closes c5ef36ba's
 * deferred "call sites not yet wired" note): the protected-fence pair from
 * the single wiring point `protectedFenceWiring` (inventory + credential
 * read mask) must reach the fence through the PRODUCT call
 * sites — the foreground bash tool and the background spawn — not only via
 * a direct createBwrapFence call. Authenticated at the argv level through
 * the spawn-mock interception (same shape as bash-global-mode-visibility
 * .test.ts; no real fence runs here). The fixture home (an mkdtemp root
 * carrying a fake `.ssh` file) is injected via the routes' `homeRoot`
 * option — the operator's real home contributes NO path strings to the
 * pins, and the expected mask tokens are computed from the fixture. The
 * real-fence end-to-end half lives in
 * tests/harness/verify/wired-fence-credential-read.test.ts — this file
 * mocks node:child_process, so a real spawn cannot run here.
 */

import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, it, vi } from "vitest";

import {
  createProtectedTargetInventory,
  protectedFenceWiring,
  protectedTargetBindPaths,
} from "../../../src/harness/sandbox/index.js";

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

function makeFakeChild(pid = 47291) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    child.emit("close", 0);
  });
  return child;
}

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

afterAll(() => {
  for (const d of scratch.splice(0))
    rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => makeFakeChild());
});
afterEach(() => {
  spawnMock.mockReset();
});

function firstSpawnArgv(): readonly string[] {
  const call = spawnMock.mock.calls[0] as readonly unknown[] | undefined;
  return (call?.[1] as readonly string[]) ?? [];
}

function hasTriple(
  argv: readonly string[],
  verb: string,
  src: string,
  dest: string
): boolean {
  return tripleIdx(argv, verb, src, dest) >= 0;
}

function tripleIdx(
  argv: readonly string[],
  verb: string,
  src: string,
  dest: string
): number {
  return argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === src && argv[i + 2] === dest
  );
}

// Fixture home with a present credential subtree carrying one regular file:
// the coordinated plan's per-file mask token for exactly that file is what
// the argv pins look for (computed from the fixture, not from the operator's
// host).
const FIX_HOME = scratchDir("t8-wire-home-");
const FIX_SSH = join(FIX_HOME, ".ssh");
const FIX_KEY = join(FIX_SSH, "id_ed25519");
mkdirSync(FIX_SSH, { recursive: true });
writeFileSync(FIX_KEY, "fixture key material\n");

// The bind paths the inventory resolves for the fixture home (pure path
// computation; existence filtering happens in the mount layer like always).
const inventoryDests = protectedTargetBindPaths(
  createProtectedTargetInventory({
    home: FIX_HOME,
    scanRoot: FIX_HOME,
  })
)
  .map((b) => b.path)
  .filter((p) => p.startsWith(`${FIX_HOME}/`));

describe("protected-target wiring — fence call sites carry the protectedFenceWiring pair", () => {
  it("foreground bash tool: T7 ro-bind + per-file T8 mask tokens reach the spawn argv", async () => {
    assert.ok(inventoryDests.length > 0, "home-relative inventory resolves");
    const taskRoot = scratchDir("t8-wire-fg-");
    const tmpRoot = scratchDir("t8-wire-fg-tmp-");
    const tool = createBashTool(taskRoot, {
      homeRoot: FIX_HOME,
      tmpDir: tmpRoot,
    });
    spawnMock.mockClear();
    await tool.handler({ command: "echo wired" });
    const argv = firstSpawnArgv();
    assert.ok(argv.length > 0, "foreground spawn consumed a fence argv");
    assert.ok(
      inventoryDests.some((dest) => hasTriple(argv, "--ro-bind", dest, dest)),
      `foreground argv must carry T7 ro-bind triples for fixture targets; bindPaths=${JSON.stringify(inventoryDests)}`
    );
    assert.ok(
      hasTriple(argv, "--ro-bind", "/dev/null", FIX_KEY),
      "foreground argv must carry the per-file credential mask token"
    );
    const subtreeRo = tripleIdx(argv, "--ro-bind", FIX_SSH, FIX_SSH);
    const maskIdx = tripleIdx(argv, "--ro-bind", "/dev/null", FIX_KEY);
    assert.ok(
      subtreeRo >= 0 && maskIdx > subtreeRo,
      "the mask lands above its read-only subtree bind (one coordinated plan)"
    );
  });

  it("background spawn: same protected-target segments as foreground (set-equal)", async () => {
    const taskRoot = scratchDir("t8-wire-bg-");
    const tmpRoot = scratchDir("t8-wire-bg-tmp-");
    spawnMock.mockClear();
    await defaultBackgroundSpawn({
      command: "echo wired",
      cwd: taskRoot,
      env: { PATH: "/bin" },
      homeRoot: FIX_HOME,
      tmpDir: tmpRoot,
    });
    const argv = firstSpawnArgv();
    assert.ok(
      inventoryDests.some((dest) => hasTriple(argv, "--ro-bind", dest, dest)),
      "background argv carries the T7 block"
    );
    assert.ok(
      hasTriple(argv, "--ro-bind", "/dev/null", FIX_KEY),
      "background argv carries the per-file credential mask token"
    );
  });

  it("all three routes assemble the identical pair from the wiring point", () => {
    // The drift class (different home defaults, inconsistent mask flags) is
    // pinned away at the helper's output: same input → same option bundle
    // shape for every route. The scan scope is a REQUIRED input — a route
    // that has none resolves one itself, so "absent" can never silently mean
    // "scanned something else".
    const wiring = protectedFenceWiring({
      homeRoot: FIX_HOME,
      workspaceRoot: FIX_HOME,
    });
    assert.equal(wiring.protectCredentialReads, true);
    assert.deepEqual(
      wiring.protectedTargets.entries.map((e) => [e.arm, e.bindPath]),
      createProtectedTargetInventory({
        home: FIX_HOME,
        scanRoot: FIX_HOME,
      }).entries.map((e) => [e.arm, e.bindPath]),
      "the helper's inventory is the route inventory, not a re-derived one"
    );
  });
});
