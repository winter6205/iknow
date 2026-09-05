import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";

/**
 * Regression coverage for the `--tmpfs /tmp` home-shadowing bug:
 * `--tmpfs /tmp` mounts an empty tmpfs over /tmp and hides every /tmp/*
 * subtree bound earlier. When HOME lives under /tmp (tests/CI set
 * `HOME = mkdtemp(join(tmpdir(), …))`), the pre-tmpfs `--bind home home`
 * is shadowed, so writes to ~/.iknow inside the fence hit the throwaway
 * tmpfs and are lost on exit. baseArgs must re-bind home after `--tmpfs
 * /tmp` whenever home is a tmp descendant.
 */
function fenceArgs(opts: {
  cwd: string;
  home: string;
  tmpDir?: string;
}): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy: createFsPolicy({
      cwd: opts.cwd,
      home: opts.home,
      tmpDir: opts.tmpDir,
    }),
    networkPolicy: createNetworkPolicy(),
    resourceLimits: createResourceLimits(),
    env: { PATH: "/bin" },
    cwd: opts.cwd,
  }).argv;
}

function tmpfsIndex(argv: readonly string[]): number {
  const idx = argv.findIndex(
    (arg, i) => arg === "--tmpfs" && argv[i + 1] === "/tmp"
  );
  assert.notEqual(idx, -1, "expected `--tmpfs /tmp` in argv");
  return idx;
}

/** Returns true when the argv contains `--bind <home> <home>` AFTER `--tmpfs /tmp`. */
function hasHomeRebind(argv: readonly string[], home: string): boolean {
  const postTmpfs = argv.slice(tmpfsIndex(argv) + 2);
  return postTmpfs.some(
    (arg, i) => arg === "--bind" && postTmpfs[i + 1] === home
  );
}

function hasCwdRebind(argv: readonly string[], cwd: string): boolean {
  const postTmpfs = argv.slice(tmpfsIndex(argv) + 2);
  return postTmpfs.some(
    (arg, i) => arg === "--bind" && postTmpfs[i + 1] === cwd
  );
}

describe("bwrap baseArgs home rebind under tmpfs (#196 T12b regression)", () => {
  it("home under /tmp => --bind home home present after --tmpfs /tmp", () => {
    const cwd = "/workspace";
    const home = "/tmp/somewhere";
    const argv = fenceArgs({ cwd, home });
    assert.ok(hasHomeRebind(argv, home), "expected home rebind after --tmpfs");
    assert.ok(!hasCwdRebind(argv, cwd), "cwd outside /tmp needs no rebind");
    // home must not be dropped from the original pre-tmpfs bind set either.
    assert.ok(argv.includes(home), "home must still be bound pre-tmpfs");
  });

  it("home under /home/<user> => no home rebind (production argv unchanged)", () => {
    const cwd = "/workspace";
    const home = "/home/user";
    const argv = fenceArgs({ cwd, home });
    assert.ok(!hasHomeRebind(argv, home), "production home must not rebind");
    assert.ok(!hasCwdRebind(argv, cwd), "cwd outside /tmp needs no rebind");
  });

  it("cwd under /tmp but home under /home => only cwd rebind", () => {
    const cwd = "/tmp/cwd";
    const home = "/home/user";
    const argv = fenceArgs({ cwd, home });
    assert.ok(hasCwdRebind(argv, cwd), "expected cwd rebind after --tmpfs");
    assert.ok(!hasHomeRebind(argv, home), "home outside /tmp must not rebind");
  });

  it("cwd and home both under /tmp => both rebinds present, cwd first", () => {
    // V1 baseline（#891 review 后恢复）：identity overlay 缺席时 post-tmpfs
    // 重绑顺序保持 [cwd, home]（可写路径），argv 与 pre-#891 逐字节一致。
    // identity 在场时才切换为 [home, identity, cwd]（覆盖-夺回顺序），见
    // tests/harness/sandbox/bwrap-identity-overlay.test.ts。
    const cwd = "/tmp/cwd";
    const home = "/tmp/home";
    const argv = fenceArgs({ cwd, home });
    assert.ok(hasCwdRebind(argv, cwd), "expected cwd rebind after --tmpfs");
    assert.ok(hasHomeRebind(argv, home), "expected home rebind after --tmpfs");
    const postTmpfs = argv.slice(tmpfsIndex(argv) + 2);
    const cwdIdx = postTmpfs.findIndex(
      (arg, i) => arg === "--bind" && postTmpfs[i + 1] === cwd
    );
    const homeIdx = postTmpfs.findIndex(
      (arg, i) => arg === "--bind" && postTmpfs[i + 1] === home
    );
    assert.ok(
      cwdIdx < homeIdx,
      "cwd rebind must precede home rebind (V1 order)"
    );
  });
});
