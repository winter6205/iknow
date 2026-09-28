/**
 * T7 real-bwrap effect level: an unlink at a protected target is refused by
 * the kernel (EROFS) by BOTH spellings — `rm -f` and `python3 -c 'import os;
 * os.remove(...)'` — and the file survives on the host. These cases are the
 * surviving half of the removed authorized-cleanup suite: with no cleanup
 * authorization mechanism there is no spelling of the unlink that succeeds,
 * and nothing about the agent having just created a backup changes that.
 *
 * Discipline (mirrors protected-target-mount.test.ts): fixture home + all
 * protected targets live in per-run mkdtemp scratch roots, HOME is redirected
 * through the fence env, the operator's real home/credentials are never read
 * or written; skipped entirely when the host has no bwrap.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createProtectedTargetInventory } from "../../../src/harness/sandbox/protected-targets.js";

function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

function hasPython3(): boolean {
  return spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
}

const SKIP = !hasBwrap();

const scratch: string[] = [];
function scratchDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

const FAKE_HOME = scratchDir("iknow-t9-fence-home-");
const TASK = scratchDir("iknow-t9-fence-task-");
const TMP = scratchDir("iknow-t9-fence-tmp-");
// The protected target: a fixture inventory extra entry, never an operator
// path. Separate file slots per spelling so cases never leak state.
const PROTECTED = scratchDir("iknow-t9-fence-protected-");

beforeAll(() => {
  if (SKIP) return;
  mkdirSync(join(FAKE_HOME, ".ssh"), { recursive: true, mode: 0o700 });
});

afterAll(() => {
  for (const p of scratch.splice(0)) {
    rmSync(p, { recursive: true, force: true });
  }
});

function agentBackup(name: string): string {
  const path = join(PROTECTED, name);
  writeFileSync(path, `agent-created backup payload for ${name}\n`);
  return path;
}

function runFence(script: string): { status: number; stderr: string } {
  const argv = createBwrapFence({
    command: "bash",
    args: ["-c", script],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode: "global" }),
    env: { HOME: FAKE_HOME, PATH: "/usr/bin:/bin" },
    cwd: TASK,
    protectedTargets: createProtectedTargetInventory({
      home: FAKE_HOME,
      scanRoot: FAKE_HOME,
      extraTargets: [
        {
          targetClass: "fixture_backup_root",
          arm: "filesystem",
          path: PROTECTED,
        },
      ],
    }),
  }).argv;
  const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
  return { status: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("T7 real-bwrap: a protected target refuses every unlink spelling", () => {
  it.skipIf(SKIP)(
    "rm -f refused (EROFS) at the protected target",
    () => {
      const backup = agentBackup("protected-rm");
      const r = runFence(`rm -f '${backup}'`);
      assert.notEqual(r.status, 0, "rm at a protected target must fail");
      assert.match(r.stderr.toLowerCase(), /read-only file system|erofs/);
      assert.ok(existsSync(backup), "the file survives the refused attempt");
    }
  );

  it.skipIf(SKIP || !hasPython3())(
    "python3 os.remove refused (EROFS) at the same protected target",
    () => {
      const backup = agentBackup("protected-py");
      const r = runFence(`python3 -c "import os; os.remove('${backup}')"`);
      assert.notEqual(r.status, 0, "os.remove at a protected target must fail");
      assert.match(r.stderr, /Read-only file system|errno 30/i);
      assert.ok(existsSync(backup), "the file survives the refused attempt");
    }
  );
});
