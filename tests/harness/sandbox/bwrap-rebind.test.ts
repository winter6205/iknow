import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createBwrapFence,
  OPTIONAL_HOST_RO_PREFIXES,
} from "../../../src/harness/sandbox/bwrap.js";
import {
  READ_ONLY_SYSTEM_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";

/**
 * ADR-0092 global-mode mount ordering — the invariant that survived retiring
 * the old closed-world /tmp workaround.
 *
 * The old scheme leaned on `--tmpfs /tmp` plus a post-tmpfs rebind, but tmpfs
 * shadowing of previously bound /tmp/* subtrees was the pathology itself.
 * Global mode mounts nothing under /tmp: a cwd inside a /tmp subtree is
 * covered once by `--bind / /` — no shadowing, hence no rebind. This file
 * pins the ordering invariant (host root base, system prefixes read-only on
 * top, cwdReadonly override after them, command tail unchanged) and asserts
 * the absence of any rebind token as a positive proposition.
 */

const OUTSIDE_ROOT = mkdtempSync(join(homedir(), ".iknow-bwrap-global-order-"));

afterAll(() => {
  rmSync(OUTSIDE_ROOT, { recursive: true, force: true });
});

interface Spec {
  readonly cwd: string;
  readonly cwdReadonly?: boolean;
}

function fenceArgs(spec: Spec): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({
      tmpDir: spec.cwd,
    }),
    env: { PATH: "/bin" },
    cwd: spec.cwd,
    ...(spec.cwdReadonly ? { cwdReadonly: true } : {}),
  }).argv;
}

function tripleIdx(
  slice: readonly string[],
  verb: string,
  target: string
): number {
  return slice.findIndex(
    (arg, i) =>
      arg === verb && slice[i + 1] === target && slice[i + 2] === target
  );
}

describe("createBwrapFence — 全局档挂载排序 (/tmp 子树不再是特例)", () => {
  it("cwd inside /tmp is covered by the host-root bind — no rebind token exists", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bwrap-global-cwd-"));
    try {
      const argv = fenceArgs({ cwd });
      const rootBindIdx = tripleIdx(argv, "--bind", "/");
      assert.notEqual(rootBindIdx, -1, "host root bind is present");
      // no per-cwd writable bind remains — the `/` mount already covers the subtree.
      assert.equal(
        tripleIdx(argv, "--bind", cwd),
        -1,
        "no per-cwd writable rebind in global mode"
      );
      // system block still follows `/` (a cwd inside /tmp does not affect the read-only system overrides).
      const etcIdx = tripleIdx(argv, "--ro-bind", "/etc");
      assert.ok(etcIdx > rootBindIdx);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("cwd outside /tmp ⇒ identical shape (no /tmp special case at all)", () => {
    const cwd = join(OUTSIDE_ROOT, "task");
    mkdirSync(cwd, { recursive: true });
    const insideTmp = fenceArgs({ cwd: OUTSIDE_ROOT });
    const outside = fenceArgs({ cwd });
    // the two shapes differ only in cwd tokens; the mount skeleton is byte-identical.
    const mountOf = (argv: readonly string[]): readonly string[] =>
      argv.slice(0, argv.indexOf("--clearenv"));
    assert.deepEqual([...mountOf(outside)], [...mountOf(insideTmp)]);
    assert.equal(tripleIdx(outside, "--bind", cwd), -1);
    assert.equal(tripleIdx(outside, "--ro-bind", cwd), -1);
  });

  it("cwdReadonly stays read-only regardless of cwd location and precedes proc/dev", () => {
    const cwd = mkdtempSync(join(tmpdir(), "bwrap-global-ro-"));
    try {
      const argv = fenceArgs({ cwd, cwdReadonly: true });
      assert.equal(tripleIdx(argv, "--bind", cwd), -1);
      const roIdx = tripleIdx(argv, "--ro-bind", cwd);
      assert.notEqual(roIdx, -1, "readonly cwd is ro-bound exactly once");
      // cwd appears exactly 3 times = the `--ro-bind cwd cwd` triple (2) plus `--chdir cwd` (1).
      // Any extra occurrence would be residue of the retired post-mount rebind.
      assert.equal(
        argv.filter((a) => a === cwd).length,
        3,
        "cwd appears only as the ro bind triple plus the --chdir arg"
      );
      const rootBindIdx = tripleIdx(argv, "--bind", "/");
      const procIdx = argv.indexOf("--proc");
      assert.ok(rootBindIdx < roIdx && roIdx < procIdx);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("system prefixes are always bound after the host root, in list order", () => {
    const argv = fenceArgs({ cwd: OUTSIDE_ROOT });
    let cursor = tripleIdx(argv, "--bind", "/");
    assert.notEqual(cursor, -1);
    for (const target of [
      ...READ_ONLY_SYSTEM_PATHS,
      ...OPTIONAL_HOST_RO_PREFIXES,
    ]) {
      const idx = tripleIdx(argv, "--ro-bind", target);
      if (idx === -1) continue; // optional prefix absent on host
      assert.ok(idx > cursor, `${target} must follow the previous mount`);
      cursor = idx;
    }
  });
});
