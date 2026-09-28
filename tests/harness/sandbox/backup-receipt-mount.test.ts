/**
 * T7 mount layer — the protected-target block has no writable branch left:
 * every present, mountable target is `--ro-bind`, in inventory order, and no
 * input can substitute a `--bind` at a protected path. These pins are the
 * surviving half of the removed authorized-cleanup argv suite; the effect
 * level lives in backup-receipt-fence.test.ts.
 *
 * Pure argv-shape surface over mkdtemp fixtures (extraTargets only — the
 * seeded credential classes are never touched); no bwrap dependency.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import {
  createProtectedTargetInventory,
  type ProtectedTargetInventory,
} from "../../../src/harness/sandbox/protected-targets.js";

const FIX_ROOT = mkdtempSync(join(tmpdir(), "iknow-t9-mount-"));
const HOME = join(FIX_ROOT, "home");
const TASK = join(FIX_ROOT, "task");
const TMP = join(FIX_ROOT, "tmp");
const PROTECTED = join(FIX_ROOT, "protected");

// A sibling inventory target pair — pin that one target's mount decision
// never spills into its siblings.
const EXTRA_A = join(PROTECTED, "a");
const EXTRA_B = join(PROTECTED, "b");

beforeAll(() => {
  mkdirSync(join(HOME, ".ssh"), { recursive: true });
  mkdirSync(TASK, { recursive: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(EXTRA_A, { recursive: true });
  mkdirSync(EXTRA_B, { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
});

function inventory(): ProtectedTargetInventory {
  return createProtectedTargetInventory({
    home: HOME,
    scanRoot: HOME,
    extraTargets: [
      {
        targetClass: "fixture_backup_root_a",
        arm: "filesystem",
        path: EXTRA_A,
      },
      {
        targetClass: "fixture_backup_root_b",
        arm: "filesystem",
        path: EXTRA_B,
      },
    ],
  });
}

function assemble(opts: {
  readonly protectedTargets?: ProtectedTargetInventory;
}): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({ tmpDir: TMP, mode: "global" }),
    env: { PATH: "/bin" },
    cwd: TASK,
    protectedTargets: opts.protectedTargets ?? inventory(),
  }).argv;
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

describe("T7 mount layer — protected targets are never made writable", () => {
  it("a cleanup attempt at a protected target → ro-bind stays (kernel refusal), never an allow, never a skip", () => {
    const argv = assemble({});
    assert.notEqual(tripleIdx(argv, "--ro-bind", EXTRA_A), -1);
    assert.equal(tripleIdx(argv, "--bind", EXTRA_A), -1);
    assert.equal(tripleIdx(argv, "--bind", EXTRA_B), -1);
  });

  it("no input makes any protected target writable: repeated assemblies stay identical and ro-only", () => {
    const first = assemble({});
    const second = assemble({});
    assert.deepEqual([...second], [...first]);
    for (const p of [EXTRA_A, EXTRA_B, join(HOME, ".ssh")]) {
      assert.notEqual(tripleIdx(first, "--ro-bind", p), -1, `${p} is ro-bound`);
      assert.equal(
        tripleIdx(first, "--bind", p),
        -1,
        `${p} is never re-bound writable`
      );
    }
  });

  it("protected triples stay inside the protected block (above the root bind, before --proc)", () => {
    const argv = assemble({});
    const rootBind = tripleIdx(argv, "--bind", "/");
    const procIdx = argv.indexOf("--proc");
    const aIdx = tripleIdx(argv, "--ro-bind", EXTRA_A);
    const bIdx = tripleIdx(argv, "--ro-bind", EXTRA_B);
    assert.ok(rootBind >= 0, "the host root base bind stands");
    assert.ok(aIdx > rootBind && aIdx < procIdx);
    assert.ok(bIdx > aIdx, "sibling order follows inventory order");
  });
});
