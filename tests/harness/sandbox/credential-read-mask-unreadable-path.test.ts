/**
 * The credential read-mask plan cache must never SERVE a plan that was built
 * on a path it could not read.
 *
 * The pinned behaviour: a path whose `lstat` fails for a reason OTHER than
 * ENOENT (EACCES / EIO / ENOTDIR …) is an UNKNOWN observable, never "the path
 * does not exist". The plan records such a path as "unreadable", and an
 * unreadable identity NEVER validates as unchanged — so the next call REBUILDS
 * the plan instead of serving one that was built on an unreadable path (the
 * fail-safe direction: any doubt → rebuild).
 *
 * Observability: the credential-subtree walk is counted at the `node:fs` level
 * (the same technique the plan-cache suite uses): `vi.mock("node:fs", …)`
 * wraps `importActual` and counts the `readdirSync` calls the mask plan makes
 * under the credential subtree. Every call is delegated to the real
 * implementation, so the mock observes a DEPENDENCY of the subject and fakes
 * none of the subject's behaviour. The rebuild is proved by the walk happening
 * again.
 *
 * The unreadable path is produced WITHOUT permissions: a path whose parent
 * component is a regular file fails `lstat` with ENOTDIR on every platform and
 * for every uid (root included) — a deterministic stand-in for EACCES that no
 * test environment can accidentally turn into a readable path.
 *
 * Fixture discipline: the home, the scan scope and the session tmp root live in
 * mkdtemp scratch roots, cleaned with the suite. No host credential file is
 * read or written.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, vi } from "vitest";

import {
  createMaskPlanCache,
  type CredentialReadMaskArgs,
} from "../../../src/harness/sandbox/credential-read-mask.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";

// The fs-level call counter. `vi.hoisted` puts it in scope before the hoisted
// `vi.mock` factory below runs.
const fsCounter = vi.hoisted(() => ({ readdirPaths: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (path: string, options?: unknown) => {
      fsCounter.readdirPaths.push(String(path));
      return options === undefined
        ? actual.readdirSync(path)
        : actual.readdirSync(path, options as never);
    },
  };
});

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

/** The `readdirSync` calls made under `root` since the last counter reset. */
function readsUnder(root: string): readonly string[] {
  return fsCounter.readdirPaths.filter(
    (path) => path === root || path.startsWith(`${root}/`)
  );
}

function resetFsCounter(): void {
  fsCounter.readdirPaths.length = 0;
}

describe("credential read-mask plan — 读不到的路径不是「不存在」", () => {
  it("lstat 非 ENOENT 失败(ENOTDIR)的路径:计划被重建,而不是被缓存复用", () => {
    const home = scratchDir("iknow-mask-unreadable-home-");
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(join(sshDir, "config"), "k\n");
    // A regular file standing where a directory would be: `lstat` on
    // `<file>/child` fails with ENOTDIR — an UNREADABLE path, not an absent
    // one.
    const notADir = join(home, "not-a-dir");
    writeFileSync(notADir, "x\n");
    const unreadablePath = join(notADir, "child");

    const scanRoot = scratchDir("iknow-mask-unreadable-scan-");
    const sessionTmpRoot = scratchDir("iknow-mask-unreadable-tmp-");
    const inventory = createProtectedTargetInventory({
      home,
      scanRoot,
      extraTargets: [
        {
          targetClass: "ssh_key_material",
          arm: "credential",
          path: unreadablePath,
        },
      ],
    });
    const args: CredentialReadMaskArgs = { inventory, sessionTmpRoot };
    const cache = createMaskPlanCache();

    resetFsCounter();
    cache.resolve(args);
    assert.ok(
      readsUnder(sshDir).length > 0,
      "the first call builds the plan (the credential subtree is walked)"
    );

    resetFsCounter();
    cache.resolve(args);
    assert.ok(
      readsUnder(sshDir).length > 0,
      "the plan must be REBUILT: an unreadable path is an unknown observable, never an absent one"
    );
  });

  it("读不到的路径不产生掩码,但也不会让计划被当作「已验证」复用", () => {
    const home = scratchDir("iknow-mask-unreadable-nomask-home-");
    const notADir = join(home, "not-a-dir");
    writeFileSync(notADir, "x\n");
    const unreadablePath = join(notADir, "child");

    const scanRoot = scratchDir("iknow-mask-unreadable-nomask-scan-");
    const sessionTmpRoot = scratchDir("iknow-mask-unreadable-nomask-tmp-");
    const inventory = createProtectedTargetInventory({
      home,
      scanRoot,
      extraTargets: [
        {
          targetClass: "ssh_key_material",
          arm: "credential",
          path: unreadablePath,
        },
      ],
    });
    const args: CredentialReadMaskArgs = { inventory, sessionTmpRoot };
    const cache = createMaskPlanCache();

    const first = cache.resolve(args);
    assert.ok(
      !first.exactFileMaskPaths.includes(unreadablePath),
      "an unreadable path is never masked (it is not an observable regular file)"
    );
    assert.ok(
      !first.args.includes(unreadablePath),
      "no bind token names the unreadable path"
    );
  });
});
