/**
 * ADR-0092 工作区档 fs-policy / bwrap argv 形态 (specs/fs-isolation-modes.md
 * SC11/SC12, ADR-0092 Amendment 2026-09-13).
 *
 * 本文件只断言 argv 形态 (纯白盒,无 bwrap 依赖);真围栏行为 (写 home 失败 /
 * 写 taskRoot 成功) 见 `tests/harness/aci/bash-workspace-mode-fence.test.ts`
 * 的 `it.skipIf(!hasBwrap())` 用例。
 *
 * 顺序约束（bwrap last-mount-wins, 见 ADR-0092 Amendment 段「围栏形态」:
 *   `--bind / /` 打底 → 系统 `--ro-bind` → `--ro-bind <home> <home>` →
 *   `--bind <workspaceRoot> <workspaceRoot>` + `--bind <tmpRoot> <tmpRoot>` →
 *   `--proc` / `--dev-bind`。
 *
 * 边界（ADR-0092 Amendment 段「围栏形态」 + brief 「workspaceRoot / tmpRoot 缺失
 * → 不发射该 bind」）：
 *   - global 档 argv 与 V1 逐字节不变（回归钉，下面 bwrap.test.ts / bwrap-rebind.test.ts
 *     另有同形态断言）；
 *   - workspace 档 homeRoot 缺失 / 空串 → **typed fail-loud**（本档语义就是
 *     home ro-bind；跳过该层 = 静默退化成全局档 = home 恢复可写且无信号）；
 *   - workspaceRoot / tmpRoot 缺失 → 不发射对应 bind（这两层是**收紧**方向：
 *     少发射 = 少一处可写，fail-closed 无洞）；
 *   - mode 非法值 → 回落 global（S2 exception）。
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
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";

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
    networkPolicy: createNetworkPolicy(),
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
    // home ro-bind:既不在场,也不该被任何 verb 引用。
    assert.equal(
      tripleIndices(argv, "--ro-bind", HOME_FIX).length,
      0,
      `global mode must not emit home ro-bind; argv=${JSON.stringify(argv)}`
    );
    // 两处白名单 bind (workspaceRoot / tmpRoot):用 taskRoot 与 tmp fixture 试探。
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
    // 全局档 argv 与 V1 形态一致:`--bind / /` 是第一个 mount,系统前缀逐项只读。
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
    // brief 硬约束:全局档 argv 必须与今日逐字节一致。三种输入形态都要钉:
    //   1. 三个 opt 全缺(legacy 调用方);
    //   2. 三个 opt 全在场(workspace 档装配路径沿同一工厂,只是 mode 是 global);
    //   3. 只有 homeRoot 在场(部分装配)。
    // 任一形态产生不同 argv = 回归钉断,必须 fail-loud。
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
    // home ro-bind 在系统前缀块之后 (mount 序)。
    const etcIdx = tripleIdx(argv, "--ro-bind", "/etc");
    assert.ok(etcIdx < homeRoIdx, "home ro-bind follows the system block");
    // home ro-bind 在 --proc 之前。
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
    // 两处白名单都在 --proc 之前。
    const procIdx = argv.indexOf("--proc");
    assert.ok(taskBindIdx < procIdx && tmpBindIdx < procIdx);
  });

  it("workspace 档 homeRoot 缺失 / 空串 → typed fail-loud（不得静默退化成全局档）", () => {
    // 工作区档的语义本体就是 home ro-bind;homeRoot 缺席时若静默跳过该层,
    // argv 退化成全局档形态(home 恢复可写)且无任何信号 —— 这是安全洞,不是
    // 边界容错。与 `fs-policy.ts` 的合同根纪律(blank/missing → typed、不
    // spawn)同款:装配层抛 ToolExecutionError,caller 不会拿到 fence。
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
    // 判别力对照:同一 factory 在 homeRoot 在场时正常返回 argv —— 上面抛错
    // 不是「函数恒抛」造成的假绿。
    const ok = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: HOME_FIX,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    assert.notEqual(tripleIdx(ok, "--ro-bind", HOME_FIX), -1);
  });

  it("global 档 homeRoot 缺失不抛（收紧面无 home，与 workspace 档判别）", () => {
    // fail-loud 只对 workspace 档生效:global 档本来就不发射 home ro-bind,
    // 缺席不是降级。没有这条,「workspace 抛错」可能被实现成「一律抛错」而
    // 测试仍绿。
    const argv = workspaceFenceArgv({ mode: "global" });
    assert.notEqual(tripleIdx(argv, "--bind", "/"), -1);
  });

  it("workspace 档 workspaceRoot / tmpRoot 缺失 → 不发射对应 bind（S2 negative）", () => {
    // workspaceRoot 缺失 → 不发射对应 bind;tmpRoot 仍在场。
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
    // tmpRoot 缺失 → 不发射;workspaceRoot 仍在场。
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
    // 非法字符串不该让 createFsPolicy 抛 —— 与 settings 段非法值回退的纪律同款。
    const policy = createFsPolicy({
      tmpDir: TMP,
      mode: "bogus" as unknown as FsIsolationMode,
    });
    assert.equal(
      policy.mode,
      "global",
      "illegal mode must fail-closed to global"
    );
    // bwrap argv 不该发射 home ro-bind / 两处白名单。
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "true"],
      fsPolicy: policy,
      networkPolicy: createNetworkPolicy(),
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
    // 临时把 HOME_FIX / TASK / TMP 拉长成 ~4000 字符的路径,只验 argv 字面不变。
    const longHome = join(HOME_FIX, "x".repeat(4000 - HOME_FIX.length - 2));
    // mkdirSync 不必调用 —— bwrap fence 不要求源端盘上存在 (OPTIONAL_HOST_RO_PREFIXES
    // 同款纪律)。
    const argv = workspaceFenceArgv({
      mode: "workspace",
      homeRoot: longHome,
      workspaceRoot: TASK,
      tmpRoot: TMP,
    });
    // 超长 homeRoot 原样出现在 argv,未被截断。
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
    // cwdReadonly + workspaceRoot 都是 TASK 时 argv 同时含:
    //   - `--bind TASK TASK`(workspaceRoot 写白名单)
    //   - `--ro-bind TASK TASK`(cwdReadonly EROFS)
    // bwrap last-mount-wins:`--ro-bind` 在后,取 EROFS —— 这是与 V1 同款形态
    // (原 cwdReadonly 与 workspaceRoot 重叠时 cwd 不可写)。本测试只断言
    // 两者都在场且顺序 cwdReadonly > workspaceRoot。
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
    // 非字符串 → undefined（fail-closed 纪律与 settings 同款）。
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
    // set 期待 FsIsolationMode;非法字符串应在编译期即被挡 —— 但运行期若有人
    // 用 `as any` 强塞,holder 不应破坏其它消费者:本测试以直接读 holder.get()
    // 验证非法字符串不会被存到 internal state。
    ctx.set("bogus" as unknown as FsIsolationMode);
    assert.equal(
      ctx.get(),
      "global",
      "illegal value must not overwrite a valid initial state"
    );
  });
});

// OPTIONAL_HOST_RO_PREFIXES 与主机盘上存在性联动;该守卫与本文件 home ro-bind
// 顺序无关,但保留一处确保工作区档 argv 在盘上 / /snap 也存在时不破顺序。
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
