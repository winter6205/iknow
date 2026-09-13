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
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";

/**
 * ADR-0092 全局档挂载排序(#196 T12b 病灶退役后的不变式)。
 *
 * 旧闭世界靠 `--tmpfs /tmp` + post-tmpfs 重绑兜底,tmpfs 遮蔽此前绑入的
 * /tmp/* 子树是病灶本体。全局档没有任何 /tmp 挂载,/tmp 子树里的 cwd
 * 由 `--bind / /` 一次性覆盖 —— 不存在遮蔽,也就不需要重绑。本文件钉住
 * 排序不变式:宿主根打底、系统前缀只读覆盖、cwdReadonly 覆盖在其后、
 * 命令尾部不变;并把 "不再有重绑 token" 作为正命题。
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
    networkPolicy: createNetworkPolicy(),
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
      // cwd 子树不再有独立可写 bind —— `/` 已覆盖。
      assert.equal(
        tripleIdx(argv, "--bind", cwd),
        -1,
        "no per-cwd writable rebind in global mode"
      );
      // 系统块仍在 `/` 之后(cwd ∈ /tmp 不影响系统前缀只读覆盖)。
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
    // 两形态只在 cwd token 上不同;mount 骨架逐字节一致。
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
      // cwd 恰好出现 3 次 = `--ro-bind cwd cwd` 三元组(2) + `--chdir cwd`(1)。
      // 任何额外出现即退役的 post-mount 重绑残留。
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
