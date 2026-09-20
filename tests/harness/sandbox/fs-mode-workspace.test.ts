/**
 * ADR-0092 workspace-tier fs-policy / bwrap argv shape (ADR-0092 amendment).
 *
 * This file asserts only the argv shape (pure white-box, no bwrap dependency);
 * real fence behavior (home writes fail / taskRoot writes succeed) lives in the
 * `it.skipIf(!hasBwrap())` cases of
 * `tests/harness/aci/bash-workspace-mode-fence.test.ts`.
 *
 * Order constraint (bwrap last-mount-wins, per the fence-shape section of the
 * ADR-0092 amendment):
 *   `--bind / /` base → system `--ro-bind` → `--ro-bind <home> <home>` →
 *   `--bind <workspaceRoot> <workspaceRoot>` + `--bind <tmpRoot> <tmpRoot>` →
 *   `--proc` / `--dev-bind`.
 *
 * Boundaries (fence-shape section of the ADR-0092 amendment + the "missing
 * workspaceRoot / tmpRoot → that bind is not emitted" rule):
 *   - global mode's argv stays byte-identical to the pre-feature shape
 *     (regression pin; bwrap.test.ts / bwrap-rebind.test.ts assert the same shape);
 *   - workspace mode with a missing / empty homeRoot → **typed fail-loud** (this
 *     mode's very semantics is the home ro-bind; skipping that layer = silent
 *     degradation to global mode = home writable again with no signal);
 *   - missing workspaceRoot / tmpRoot → the corresponding bind is not emitted
 *     (these two layers tighten: one fewer bind = one fewer writable spot,
 *     fail-closed with no hole);
 *   - illegal mode value → falls back to global.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createBwrapFence,
  OPTIONAL_HOST_RO_PREFIXES,
} from "../../../src/harness/sandbox/bwrap.js";
import {
  READ_ONLY_SYSTEM_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import {
  createFsModeContext,
  parseFsModeFlag,
  type FsIsolationMode,
} from "../../../src/harness/sandbox/fs-mode.js";

const FIX_ROOT = mkdtempSync(join(homedir(), ".iknow-bwrap-workspace-"));
const TASK = join(FIX_ROOT, "task");
const TMP = mkdtempSync(join(tmpdir(), "bwrap-workspace-tmp-"));
const HOME_FIX = mkdtempSync(join(homedir(), ".iknow-bwrap-workspace-home-"));

beforeAll(() => {
  mkdirSync(TASK, { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
  rmSync(HOME_FIX, { recursive: true, force: true });
});

function tripleIdx(
  argv: readonly string[],
  verb: string,
  target: string
): number {
  return argv.findIndex(
    (arg, i) => arg === verb && argv[i + 1] === target && argv[i + 2] === target
  );
}

function tripleIndices(
  argv: readonly string[],
  verb: string,
  target: string
): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 < argv.length; i++) {
    if (argv[i] === verb && argv[i + 1] === target && argv[i + 2] === target) {
      out.push(i);
    }
  }
  return out;
}

interface FenceSpec {
  readonly mode?: FsIsolationMode;
  readonly homeRoot?: string;
  readonly workspaceRoot?: string;
  readonly tmpRoot?: string;
  readonly cwdReadonly?: boolean;
}

function workspaceFenceArgv(spec: FenceSpec): readonly string[] {
  const fsPolicy = createFsPolicy({
    tmpDir: TMP,
    ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
  });
  return createBwrapFence({
    command: "bash",
    args: ["-c", "true"],
    fsPolicy,
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(spec.homeRoot !== undefined ? { homeRoot: spec.homeRoot } : {}),
    ...(spec.workspaceRoot !== undefined
      ? { workspaceRoot: spec.workspaceRoot }
      : {}),
    ...(spec.tmpRoot !== undefined ? { tmpRoot: spec.tmpRoot } : {}),
    ...(spec.cwdReadonly ? { cwdReadonly: true } : {}),
  }).argv;
}

describe("createBwrapFence — 工作区档 argv 形态 (ADR-0092 SC11/SC12)", () => {
  it("global argv 不发射 home ro-bind 与两处白名单 bind（回归钉）", () => {
    const argv = workspaceFenceArgv({ mode: "global" });
    // home ro-bind: neither present nor referenced by any verb.
    assert.equal(
      tripleIndices(argv, "--ro-bind", HOME_FIX).length,
      0,
      `global mode must not emit home ro-bind; argv=${JSON.stringify(argv)}`
    );
    // the two allowlist binds (workspaceRoot / tmpRoot): probed with taskRoot and the tmp fixture.
    assert.equal(
      tripleIndices(argv, "--bind", TASK).length,
      0,
      "global mode must not emit a writable workspaceRoot bind"
    );
    assert.equal(
      tripleIndices(argv, "--bind", TMP).length,
      0,
      "global mode must not emit a writable tmpRoot bind"
    );
    // global-mode argv matches the legacy shape: `--bind / /` is the first mount, system prefixes read-only item by item.
    const rootBindIdx = tripleIdx(argv, "--bind", "/");
    assert.notEqual(rootBindIdx, -1, "host root bind is present");
    let cursor = rootBindIdx;
    for (const target of READ_ONLY_SYSTEM_PATHS) {
      const idx = tripleIdx(argv, "--ro-bind", target);
      assert.ok(idx > cursor, `${target} keeps the system block order`);
      cursor = idx;
    }
  });

  it("global 档下传入三个新 opt 仍与不传时逐字节相同（硬约束回归钉）", () => {
    // hard constraint: global-mode argv must stay byte-identical to today's. Pin three input shapes:
    //   1. all three opts absent (legacy callers);
    //   2. all three present (the workspace-mode assembly path shares the same factory, only mode is global);
    //   3. only homeRoot present (partial assembly).
    // Any shape producing a different argv = broken regression pin; must fail-loud.
    const legacy = workspaceFenceArgv({ mode: "global" });
    const allOpts = workspaceFenceArgv({
      mode: "global",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    const homeOnly = workspaceFenceArgv({ mode: "global", homeRoot: HOME_FIX });
    assert.deepEqual(
      [...allOpts],
      [...legacy],
      `global mode with all new opts must be byte-identical to legacy; got ${JSON.stringify(
        allOpts
      )}`
    );
    assert.deepEqual(
      [...homeOnly],
      [...legacy],
      "global mode with homeRoot only must be byte-identical to legacy"
    );
  });

  it("workspace argv 含 --ro-bind <home> 且在 --bind / / 之后（bwrap last-mount-wins 序）", () => {
    const argv = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    const homeRoIdx = tripleIdx(argv, "--ro-bind", HOME_FIX);
    assert.notEqual(
      homeRoIdx,
      -1,
      `workspace argv must include --ro-bind <home> <home>; argv=${JSON.stringify(
        argv
      )}`
    );
    const rootBindIdx = tripleIdx(argv, "--bind", "/");
    assert.ok(
      homeRoIdx > rootBindIdx,
      "home ro-bind must follow `--bind / /` (last-mount-wins)"
    );
    // home ro-bind comes after the system-prefix block (mount order).
    const etcIdx = tripleIdx(argv, "--ro-bind", "/etc");
    assert.ok(etcIdx < homeRoIdx, "home ro-bind follows the system block");
    // home ro-bind precedes --proc.
    const procIdx = argv.indexOf("--proc");
    assert.ok(homeRoIdx < procIdx, "home ro-bind precedes proc/dev");
  });

  it("workspace argv 含两处白名单 bind 且在 home ro-bind 之后", () => {
    const argv = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    const homeRoIdx = tripleIdx(argv, "--ro-bind", HOME_FIX);
    const taskBindIdx = tripleIdx(argv, "--bind", TASK);
    const tmpBindIdx = tripleIdx(argv, "--bind", TMP);
    assert.notEqual(taskBindIdx, -1, "workspaceRoot bind is present");
    assert.notEqual(tmpBindIdx, -1, "tmpRoot bind is present");
    assert.ok(
      taskBindIdx > homeRoIdx,
      "workspaceRoot bind must follow home ro-bind"
    );
    assert.ok(tmpBindIdx > homeRoIdx, "tmpRoot bind must follow home ro-bind");
    // both allowlist binds precede --proc.
    const procIdx = argv.indexOf("--proc");
    assert.ok(taskBindIdx < procIdx && tmpBindIdx < procIdx);
  });

  it("workspace 档 homeRoot 缺失 / 空串 → typed fail-loud（不得静默退化成全局档）", () => {
    // the workspace mode's semantic core is the home ro-bind itself; silently
    // skipping that layer when homeRoot is absent would degrade argv to the global
    // shape (home writable again) with no signal — a security hole, not boundary
    // tolerance. Same contract-root discipline as `fs-policy.ts` (blank/missing →
    // typed, no spawn): the assembly layer throws ToolExecutionError and the
    // caller never receives a fence.
    for (const homeRoot of [undefined, ""] as const) {
      assert.throws(
        () =>
          workspaceFenceArgv({
            mode: "workspace",
            ...(homeRoot !== undefined ? { homeRoot } : {}),
            workspaceRoot: TASK,
            tmpRoot: TMP,
          }),
        (err: unknown) =>
          err instanceof ToolExecutionError && /homeRoot/.test(err.message),
        `workspace mode with homeRoot=${JSON.stringify(
          homeRoot
        )} must throw a typed error naming homeRoot`
      );
    }
    // discriminating control: the same factory returns argv normally when homeRoot
    // is present — the throw above is not a false green from "always throws".
    const ok = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    assert.notEqual(tripleIdx(ok, "--ro-bind", HOME_FIX), -1);
  });

  it("global 档 homeRoot 缺失不抛（收紧面无 home，与 workspace 档判别）", () => {
    // fail-loud only applies to workspace mode: global mode never emits the home
    // ro-bind, so absence is not degradation there. Without this case, "workspace
    // throws" could be implemented as "always throws" and the tests would stay green.
    const argv = workspaceFenceArgv({ mode: "global" });
    assert.notEqual(tripleIdx(argv, "--bind", "/"), -1);
  });

  it("workspace 档 workspaceRoot / tmpRoot 缺失 → 不发射对应 bind（S2 negative）", () => {
    // workspaceRoot absent → that bind is not emitted; tmpRoot still present.
    const argvA = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      tmpRoot: TMP,
    });
    assert.equal(
      tripleIndices(argvA, "--bind", TASK).length,
      0,
      "absent workspaceRoot must not emit that bind"
    );
    assert.notEqual(
      tripleIdx(argvA, "--bind", TMP),
      -1,
      "tmpRoot bind is still present"
    );
    // tmpRoot absent → not emitted; workspaceRoot still present.
    const argvB = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
    });
    assert.equal(
      tripleIndices(argvB, "--bind", TMP).length,
      0,
      "absent tmpRoot must not emit that bind"
    );
    assert.notEqual(
      tripleIdx(argvB, "--bind", TASK),
      -1,
      "workspaceRoot bind is still present"
    );
  });

  it("mode 非法值 → createFsPolicy 回落 global（fail-closed,S2 exception）", () => {
    // an illegal string must not make createFsPolicy throw — same discipline as the settings-section illegal-value fallback.
    const policy = createFsPolicy({
      tmpDir: TMP,
      mode: "bogus" as unknown as FsIsolationMode,
    });
    assert.equal(
      policy.mode,
      "global",
      "illegal mode must fail-closed to global"
    );
    // bwrap argv must not emit the home ro-bind / the two allowlist binds.
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: policy,
      env: { PATH: "/bin" },
      cwd: TASK,
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    }).argv;
    assert.equal(
      tripleIndices(argv, "--ro-bind", HOME_FIX).length,
      0,
      "bogus mode must produce global argv shape"
    );
  });

  it("concurrent：两次 createFsPolicy 不同 tmpRoot 各发射各的 tmp bind（S2 concurrent）", () => {
    const tmpA = mkdtempSync(join(tmpdir(), "bwrap-workspace-tmpA-"));
    const tmpB = mkdtempSync(join(tmpdir(), "bwrap-workspace-tmpB-"));
    try {
      const argvA = workspaceFenceArgv({
        mode: "workspace",
        homeRoot: HOME_FIX,
        workspaceRoot: TASK,
        tmpRoot: tmpA,
      });
      const argvB = workspaceFenceArgv({
        mode: "workspace",
        homeRoot: HOME_FIX,
        workspaceRoot: TASK,
        tmpRoot: tmpB,
      });
      assert.notEqual(
        tripleIdx(argvA, "--bind", tmpA),
        -1,
        "tmpA bind present in argvA"
      );
      assert.equal(
        tripleIdx(argvA, "--bind", tmpB),
        -1,
        "tmpB bind absent in argvA"
      );
      assert.notEqual(
        tripleIdx(argvB, "--bind", tmpB),
        -1,
        "tmpB bind present in argvB"
      );
      assert.equal(
        tripleIdx(argvB, "--bind", tmpA),
        -1,
        "tmpA bind absent in argvB"
      );
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  });

  it("overflow：超长路径原样透传（S2 overflow）", () => {
    // temporarily stretch HOME_FIX / TASK / TMP to ~4000-char paths; only verify the argv literals are unchanged.
    const longHome = join(HOME_FIX, "x".repeat(4000 - HOME_FIX.length - 2));
    // no mkdirSync needed — the bwrap fence does not require the source to exist on disk (same discipline as OPTIONAL_HOST_RO_PREFIXES).
    const argv = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: longHome,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    // the over-long homeRoot appears verbatim in argv, untruncated.
    const idx = argv.findIndex(
      (arg, i) => arg === "--ro-bind" && argv[i + 1] === longHome
    );
    assert.notEqual(idx, -1, "long home path passes through to argv unchanged");
  });

  it("workspace argv 在 cwdReadonly 时 cwdReadonly 仍生效（与 home ro-bind 互不干扰）", () => {
    const argv = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
      cwdReadonly: true,
    });
    // when both cwdReadonly and workspaceRoot are TASK, argv contains both:
    //   - `--bind TASK TASK` (workspaceRoot write allowlist)
    //   - `--ro-bind TASK TASK` (cwdReadonly EROFS)
    // bwrap last-mount-wins: `--ro-bind` comes later, so EROFS prevails — the same
    // shape as before this feature (cwd unwritable when cwdReadonly overlaps
    // workspaceRoot). This test only asserts both are present with order
    // cwdReadonly > workspaceRoot.
    const roCwdIdx = tripleIndices(argv, "--ro-bind", TASK);
    const bindCwdIdx = tripleIndices(argv, "--bind", TASK);
    assert.equal(
      roCwdIdx.length,
      1,
      `cwdReadonly emits exactly one --ro-bind cwd cwd; argv=${JSON.stringify(argv)}`
    );
    assert.equal(
      bindCwdIdx.length,
      1,
      "workspaceRoot emits exactly one --bind workspaceRoot workspaceRoot"
    );
    assert.ok(
      (roCwdIdx[0] as number) > (bindCwdIdx[0] as number),
      "cwdReadonly follows workspaceRoot (last-mount-wins → EROFS)"
    );
  });
});

describe("FsMode holder — runtime flip is read by per-call snapshot", () => {
  it("createFsModeContext defaults to global and round-trips through get/set", () => {
    const ctx = createFsModeContext();
    assert.equal(ctx.get(), "global");
    ctx.set("workspace");
    assert.equal(ctx.get(), "workspace");
    ctx.set("global");
    assert.equal(ctx.get(), "global");
  });

  it("createFsModeContext honors the initial value and freezes it", () => {
    const ctx = createFsModeContext("workspace");
    assert.equal(ctx.get(), "workspace");
  });

  it("parseFsModeFlag admits only the two closed values (trim + lowercase)", () => {
    assert.equal(parseFsModeFlag("global"), "global");
    assert.equal(parseFsModeFlag("workspace"), "workspace");
    assert.equal(parseFsModeFlag("  global  "), "global");
    assert.equal(parseFsModeFlag("WORKSPACE"), "workspace");
    assert.equal(parseFsModeFlag(""), undefined);
    assert.equal(parseFsModeFlag("on"), undefined);
    assert.equal(parseFsModeFlag("off"), undefined);
    assert.equal(parseFsModeFlag("anything-else"), undefined);
    // non-string → undefined (same fail-closed discipline as settings).
    assert.equal(parseFsModeFlag(1), undefined);
    assert.equal(parseFsModeFlag(null), undefined);
    assert.equal(parseFsModeFlag(undefined), undefined);
    assert.equal(parseFsModeFlag({}), undefined);
  });

  it("createFsModeContext returns a frozen holder (mutation only via set)", () => {
    const ctx = createFsModeContext();
    assert.ok(Object.isFrozen(ctx));
  });

  it("set with an illegal value is a no-op (holder never leaves the closed set)", () => {
    const ctx = createFsModeContext("global");
    // set expects FsIsolationMode; illegal strings should already be blocked at
    // compile time — but if someone force-feeds one via `as any` at runtime, the
    // holder must not break other consumers: this test reads holder.get() directly
    // to verify the illegal string never reaches internal state.
    ctx.set("bogus" as unknown as FsIsolationMode);
    assert.equal(
      ctx.get(),
      "global",
      "illegal value must not overwrite a valid initial state"
    );
  });
});

// OPTIONAL_HOST_RO_PREFIXES couples with host-disk existence; this guard is
// unrelated to this file's home ro-bind ordering, but keep one place ensuring the
// workspace-mode argv order still holds when /opt or /snap also exist on disk.
describe("createBwrapFence — 工作区档 argv 与可选前缀", () => {
  it("盘上 /opt 或 /snap 存在时仍按系统块顺序排在 home ro-bind 之前", () => {
    const argv = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    const homeRoIdx = tripleIdx(argv, "--ro-bind", HOME_FIX);
    assert.notEqual(homeRoIdx, -1);
    for (const prefix of OPTIONAL_HOST_RO_PREFIXES) {
      if (existsSync(prefix)) {
        const idx = tripleIdx(argv, "--ro-bind", prefix);
        assert.ok(
          idx > -1 && idx < homeRoIdx,
          `${prefix} precedes home ro-bind`
        );
      }
    }
  });
});
