import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createBwrapFence,
  OPTIONAL_HOST_RO_PREFIXES,
} from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";

/**
 * T3 (plans/closed-world-bash-fence.md) — bwrap argv 闭世界反转。
 *
 * 新 argv 形态(ADR-0037 §9.2):
 *   系统 ro-bind(/usr /bin /lib /lib64 /etc + 可选 /opt /snap 存在性跳过)
 *   → 读白名单 ro-bind(合同根 + 可选成员)
 *   → 写白名单 bind(tmp + cwd/taskRoot)
 *   → --bind <pad> /tmp
 *   → post-/tmp 重绑(读根 ro 夺回 + cwd 可写夺回,cwd ∈ /tmp 子树时)
 *   → --proc /proc → --dev-bind /dev /dev。
 *
 * 反转合同:writable home 打底 token(`--bind home home`)彻底消失;
 * 写 bind 必须在所有读 ro-bind 之后(bwrap 后挂覆盖先挂——taskRoot 可能
 * 位于 identityRoot 树内);SENSITIVE_PATHS tmpfs 罩在闭世界下失效为无操作,
 * argv 发射删除(isSensitive/protected-state 谓词保留在 fs-policy)。
 *
 * 形状用 fixtures 建在 home 下(不在 /tmp 子树)→ 无 post-tmpfs 重绑噪声;
 * /tmp 子树的 rebind 形态见 bwrap-rebind.test.ts。合同根盘上校验 → 必须
 * 真实存在;home 保持假路径(状态锚,不校验)。
 */

const FIX_ROOT = mkdtempSync(join(homedir(), ".iknow-bwrap-t3-"));
const TASK = join(FIX_ROOT, "task");
const INSTALL = join(FIX_ROOT, "install");
const IDENTITY = join(FIX_ROOT, "repo");
const TMP = tmpdir();

beforeAll(() => {
  for (const dir of [TASK, INSTALL, IDENTITY]) {
    mkdirSync(dir, { recursive: true });
  }
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
});

/** `verb <target> <target>` 三元组的全部位置。 */
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

function assertTriple(
  argv: readonly string[],
  verb: string,
  target: string,
  message: string
): number {
  const indices = tripleIndices(argv, verb, target);
  assert.ok(indices.length > 0, `${message}; argv=${JSON.stringify(argv)}`);
  return indices[0] as number;
}

interface FenceSpec {
  readonly installRoot?: string;
  /** T5:identity 根经 policy 读白名单进 argv(单一入口);bwrap 层不再有
   *  独立选项。undefined = 装配层未提供,argv 不得出现该读根。 */
  readonly identityRoot?: string;
  readonly nodeToolchainRoot?: string;
  readonly cwdReadonly?: boolean;
  readonly network?: boolean;
}

function fenceArgv(spec: FenceSpec = {}): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({
      cwd: TASK,
      home: "/home/user",
      tmpDir: TMP,
      ...(spec.installRoot !== undefined
        ? { installRoot: spec.installRoot }
        : {}),
      ...(spec.identityRoot !== undefined
        ? { projectIdentityRoot: spec.identityRoot }
        : {}),
      ...(spec.nodeToolchainRoot !== undefined
        ? { nodeToolchainRoot: spec.nodeToolchainRoot }
        : {}),
    }),
    networkPolicy: createNetworkPolicy(),
    resourceLimits: createResourceLimits(),
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(spec.cwdReadonly ? { cwdReadonly: true } : {}),
    ...(spec.network ? { network: true } : {}),
  }).argv;
}

describe("createBwrapFence — closed-world argv shape (T3)", () => {
  it("builds system ro-binds → read whitelist → write binds → pad@/tmp → proc/dev, with no writable home token", () => {
    const argv = fenceArgv({ installRoot: INSTALL });
    assert.equal(argv[0], "bwrap");
    assert.equal(argv[1], "--unshare-user-try");
    assert.equal(argv[2], "--unshare-net");
    assert.equal(argv[3], "--die-with-parent");
    // 1. 系统块:/usr /bin /lib /lib64 /etc 全部 --ro-bind,位置递增。
    const systemTargets = ["/usr", "/bin", "/lib", "/lib64", "/etc"];
    let cursor = 0;
    for (const target of systemTargets) {
      const idx = assertTriple(argv, "--ro-bind", target, `system ${target}`);
      assert.ok(idx >= cursor, `${target} keeps the system block order`);
      cursor = idx;
    }
    // 2. 读白名单块:installRoot(合同读根)与 node 工具链根(默认推导),
    //    位于系统块之后、写块之前。
    const installIdx = assertTriple(
      argv,
      "--ro-bind",
      INSTALL,
      "installRoot is a contract read root"
    );
    assert.ok(installIdx > cursor, "read whitelist follows the system block");
    const nodeRoot = dirname(process.execPath);
    // §9.2 #5:node 工具链根落入系统前缀时塌缩(不冗余 ro-bind,靠系统块
    // 覆盖);否则必须单独 ro-bind。塌缩分支与 host 相关(CI runner 的
    // node 在 /opt 下,本地 WSL 在 home 下),断言两分支各自钉住不变式。
    const nodeCollapsed = [
      "/usr",
      "/bin",
      "/lib",
      "/lib64",
      "/etc",
      ...OPTIONAL_HOST_RO_PREFIXES,
    ]
      .filter((prefix) => existsSync(prefix))
      .some((prefix) => (nodeRoot + "/").startsWith(prefix + "/"));
    const nodeIdx = tripleIndices(argv, "--ro-bind", nodeRoot);
    if (nodeCollapsed) {
      assert.equal(
        nodeIdx.length,
        0,
        `collapsed node toolchain root must not be redundantly ro-bound; argv=${JSON.stringify(argv)}`
      );
    } else {
      assert.ok(
        nodeIdx.length > 0,
        `default node toolchain root must be ro-bound; argv=${JSON.stringify(argv)}`
      );
    }
    // 3. 写白名单块:tmp bind + cwd bind,均在读块之后(bwrap 后挂覆盖先挂:
    //    taskRoot 可能位于某读根树内,写 bind 必须最后夺回)。
    const tmpBindIdx = assertTriple(argv, "--bind", TMP, "tmp write bind");
    const cwdBindIdx = assertTriple(argv, "--bind", TASK, "cwd write bind");
    assert.ok(tmpBindIdx > installIdx, "write binds come after read ro-binds");
    assert.ok(cwdBindIdx > tmpBindIdx, "cwd is the last bind (reclaim)");
    // 4. writable home 打底 token 彻底消失(闭世界核心不变式)。
    assert.equal(
      tripleIndices(argv, "--bind", "/home/user").length,
      0,
      "no --bind home home in the closed world"
    );
    assert.equal(
      tripleIndices(argv, "--ro-bind", "/home/user").length,
      0,
      "home itself is not a read member either"
    );
    // 5. guest /tmp: --bind <pad> /tmp after write binds; no --tmpfs.
    assert.equal(
      argv.includes("--tmpfs"),
      false,
      "per-invocation tmpfs is retired (ADR-0074)"
    );
    let guestTmpIdx = -1;
    for (let i = 0; i + 2 < argv.length; i++) {
      if (
        argv[i] === "--bind" &&
        argv[i + 1] === TMP &&
        argv[i + 2] === "/tmp"
      ) {
        guestTmpIdx = i;
      }
    }
    assert.notEqual(guestTmpIdx, -1, "expected --bind <pad> /tmp");
    assert.ok(
      guestTmpIdx > cwdBindIdx,
      "guest /tmp mount covers the pre-binds"
    );
    // 6. proc/dev 收尾。
    const procIdx = argv.indexOf("--proc");
    const devIdx = argv.indexOf("--dev-bind");
    assert.ok(procIdx > guestTmpIdx && devIdx > procIdx);
    // 7. --clearenv 先于全部 --setenv(#225),且在 dev-bind 之后。
    const clearenvIdx = argv.indexOf("--clearenv");
    assert.ok(clearenvIdx > devIdx, "--clearenv follows the mount block");
    const setenvIndices = argv
      .map((arg, index) => (arg === "--setenv" ? index : -1))
      .filter((index) => index !== -1);
    assert.ok(setenvIndices.length > 0, "expected at least one --setenv");
    for (const idx of setenvIndices) {
      assert.ok(clearenvIdx < idx, "--clearenv must precede every --setenv");
    }
    // 8. chdir + 命令收尾。
    const chdirIdx = argv.indexOf("--chdir");
    assert.ok(chdirIdx > clearenvIdx);
    assert.equal(argv[chdirIdx + 1], TASK);
    assert.deepEqual(argv.slice(-4), ["--", "bash", "-c", "echo hi"]);
  });

  it("network:true drops --unshare-net and changes nothing else in the closed-world shape", () => {
    const argv = fenceArgv({ network: true, installRoot: INSTALL });
    assert.equal(argv.includes("--unshare-net"), false);
    assert.ok(argv.includes("--die-with-parent"));
    assert.ok(argv.includes("--clearenv"));
    assert.ok(tripleIndices(argv, "--bind", TASK).length > 0);
    assert.equal(tripleIndices(argv, "--bind", "/home/user").length, 0);
  });

  it("ro-binds optional host prefixes (/opt, /snap) when they exist", () => {
    const argv = fenceArgv();
    const etcIdx = assertTriple(argv, "--ro-bind", "/etc", "system /etc");
    const writeIdx = argv.indexOf("--bind");
    for (const prefix of OPTIONAL_HOST_RO_PREFIXES) {
      if (existsSync(prefix)) {
        const idx = assertTriple(
          argv,
          "--ro-bind",
          prefix,
          `optional host prefix ${prefix}`
        );
        assert.ok(
          etcIdx < idx && idx < writeIdx,
          `${prefix} belongs in the system block (after /etc, before write binds)`
        );
      } else {
        assert.equal(
          argv.includes(prefix),
          false,
          `absent host prefix ${prefix} must not appear in argv`
        );
      }
    }
  });

  it("collapses a node toolchain root that falls under a system prefix (no redundant bind)", () => {
    const argv = fenceArgv({ nodeToolchainRoot: "/usr/bin" });
    assert.equal(
      tripleIndices(argv, "--ro-bind", "/usr/bin").length,
      0,
      "node root under /usr must not emit a separate bind"
    );
    // 其余读根不受塌缩影响。
    assert.ok(tripleIndices(argv, "--bind", TASK).length > 0);
  });

  it("identity root (policy read-whitelist member) is ro-bound after the system block and before the writable cwd bind", () => {
    // T5:#891 的 overlay 排序合同(writable home → identity ro-bind → cwd)
    // 已随 writable home 打底消亡;identity 根是 policy 读白名单的普通成员
    // (ADR-0037 §9.2 #6,单一入口)。闭世界合同 = 读块 ro-bind → 写块 cwd
    // bind(taskRoot 在身份树内时由后挂 cwd bind 夺回可写)。
    const argv = fenceArgv({ identityRoot: IDENTITY });
    const identityIdx = assertTriple(
      argv,
      "--ro-bind",
      IDENTITY,
      "identity root is a read member"
    );
    const etcIdx = assertTriple(argv, "--ro-bind", "/etc", "system /etc");
    assert.ok(identityIdx > etcIdx, "read whitelist follows the system block");
    const cwdBindIdx = assertTriple(argv, "--bind", TASK, "cwd write bind");
    assert.ok(
      identityIdx < cwdBindIdx,
      "cwd (taskRoot inside the identity tree) must reclaim writability after the identity ro-bind"
    );
    assert.equal(tripleIndices(argv, "--bind", "/home/user").length, 0);
  });

  it("identity root absent from the policy → no identity ro-bind token (assembly layer gates by isolationEnabled)", () => {
    // T5 合并的 negative 用例(#891 T5 清理):policy 读白名单不含 identity
    // 根时,argv 不得出现该 token。
    const argv = fenceArgv();
    assert.equal(
      tripleIndices(argv, "--ro-bind", IDENTITY).length,
      0,
      "no projectIdentityRoot in the policy → no identity ro-bind"
    );
  });
});

describe("createBwrapFence — cwdReadonly (closed world, #562 T5 semantics retained)", () => {
  it("cwdReadonly:true binds cwd read-only, exactly once, with no writable mount covering it", () => {
    const argv = fenceArgv({ cwdReadonly: true, installRoot: INSTALL });
    // 无 --bind <cwd> <cwd>;恰好一处 --ro-bind <cwd> <cwd>(TASK 在 /tmp
    // 子树外 → 无 post-tmpfs 重绑)。
    assert.equal(
      tripleIndices(argv, "--bind", TASK).length,
      0,
      "no writable cwd bind when cwdReadonly:true"
    );
    const roIndices = tripleIndices(argv, "--ro-bind", TASK);
    assert.equal(
      roIndices.length,
      1,
      `exactly one ro cwd bind; argv=${JSON.stringify(argv)}`
    );
    const roIdx = roIndices[0] as number;
    let guestTmpIdx = -1;
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" && argv[i + 2] === "/tmp") guestTmpIdx = i;
    }
    assert.ok(roIdx < guestTmpIdx, "ro cwd bind precedes guest /tmp mount");
    const etcIdx = assertTriple(argv, "--ro-bind", "/etc", "system /etc");
    assert.ok(etcIdx < roIdx, "cwd ro-bind follows the system block");
    // 唯一的可写 bind 是 tmp 写通道;不存在可写 home/祖先罩住 ro cwd。
    assert.equal(tripleIndices(argv, "--bind", "/home/user").length, 0);
  });

  it("cwdReadonly:false and absent cwdReadonly produce byte-identical argv", () => {
    const argvDefault = fenceArgv();
    const argvFalse = fenceArgv({ cwdReadonly: false });
    assert.deepEqual(
      [...argvFalse],
      [...argvDefault],
      "cwdReadonly:false must produce byte-for-byte default argv"
    );
  });
});
