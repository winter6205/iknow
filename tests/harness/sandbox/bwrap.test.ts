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
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import { createResourceLimits } from "../../../src/harness/sandbox/resource-limits.js";

/**
 * ADR-0092 全局档 bwrap argv 形态。
 *
 * 固定骨架:`--bind / /`(宿主真实路径可见可写) → 系统前缀 `--ro-bind`
 * (/usr /bin /lib /lib64 /etc + 盘上 /opt /snap) → 可选 `--ro-bind cwd cwd`
 * (cwdReadonly) → `--proc /proc` → `--dev-bind /dev /dev`。无 guest /tmp
 * bind、无 `--tmpfs`、无可写 home 打底 / 每身份可写根表。会话 tmp 保持宿主
 * 路径,不参与 argv。
 */

const FIX_ROOT = mkdtempSync(join(homedir(), ".iknow-bwrap-global-"));
const TASK = join(FIX_ROOT, "task");
const TMP = mkdtempSync(join(tmpdir(), "bwrap-global-tmp-"));

beforeAll(() => {
  mkdirSync(TASK, { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
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

function fenceArgv(
  spec: { readonly cwdReadonly?: boolean; readonly network?: boolean } = {}
): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ home: "/home/user", tmpDir: TMP }),
    networkPolicy: createNetworkPolicy(),
    resourceLimits: createResourceLimits(),
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(spec.cwdReadonly ? { cwdReadonly: true } : {}),
    ...(spec.network ? { network: true } : {}),
  }).argv;
}

describe("createBwrapFence — 全局档 argv 形态 (ADR-0092)", () => {
  it("binds the host root first, then re-binds system prefixes read-only, then proc/dev", () => {
    const argv = fenceArgv();
    assert.equal(argv[0], "bwrap");
    assert.equal(argv[1], "--unshare-user-try");
    assert.equal(argv[2], "--unshare-net");
    assert.equal(argv[3], "--die-with-parent");
    // 1. 宿主根 `/` 是第一个 mount,且必须是最后一挂的基础(此处是唯一 `/` 挂载)。
    const rootBindIdx = assertTriple(argv, "--bind", "/", "host root bind");
    assert.equal(rootBindIdx, 4, "`--bind / /` is the first mount token");
    // 2. 系统块:固定前缀全部 --ro-bind,位于 / 之后、顺序递增。
    let cursor = rootBindIdx;
    for (const target of READ_ONLY_SYSTEM_PATHS) {
      const idx = assertTriple(argv, "--ro-bind", target, `system ${target}`);
      assert.ok(idx > cursor, `${target} keeps the system block order`);
      cursor = idx;
    }
    // 3. 盘上可选的 /opt /snap ro-bind 也在系统块内。
    for (const prefix of OPTIONAL_HOST_RO_PREFIXES) {
      if (existsSync(prefix)) {
        const idx = assertTriple(
          argv,
          "--ro-bind",
          prefix,
          `optional host prefix ${prefix}`
        );
        assert.ok(idx > cursor, `${prefix} follows the fixed system block`);
        cursor = idx;
      } else {
        assert.equal(
          argv.includes(prefix),
          false,
          `absent host prefix ${prefix} must not appear in argv`
        );
      }
    }
    // 4. proc/dev 收尾,均在 mount 块之后。
    const procIdx = argv.indexOf("--proc");
    const devIdx = argv.indexOf("--dev-bind");
    assert.ok(procIdx > cursor && devIdx > procIdx);
    // 5. --clearenv 先于全部 --setenv,且在 dev-bind 之后。
    const clearenvIdx = argv.indexOf("--clearenv");
    assert.ok(clearenvIdx > devIdx, "--clearenv follows the mount block");
    const setenvIndices = argv
      .map((arg, index) => (arg === "--setenv" ? index : -1))
      .filter((index) => index !== -1);
    assert.ok(setenvIndices.length > 0, "expected at least one --setenv");
    for (const idx of setenvIndices) {
      assert.ok(clearenvIdx < idx, "--clearenv must precede every --setenv");
    }
    // 6. chdir + 命令收尾。
    const chdirIdx = argv.indexOf("--chdir");
    assert.ok(chdirIdx > clearenvIdx);
    assert.equal(argv[chdirIdx + 1], TASK);
    assert.deepEqual(argv.slice(-4), ["--", "bash", "-c", "echo hi"]);
  });

  it("never emits a guest /tmp mount, a tmpfs, or a per-root write bind list", () => {
    const argv = fenceArgv();
    assert.equal(
      argv.includes("--tmpfs"),
      false,
      "per-invocation tmpfs is retired (ADR-0092)"
    );
    // 不存在任何以 /tmp 为终点或源点的 bind(guest /tmp 别名退役)。
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" || argv[i] === "--ro-bind") {
        assert.notEqual(
          argv[i + 1],
          TMP,
          "session tmp must not be a bind source"
        );
        assert.notEqual(
          argv[i + 2],
          "/tmp",
          "guest /tmp must not be a bind target"
        );
      }
    }
    // cwd 在全局档下由 `/` 挂载天然可写 —— 不再是显式 --bind cwd cwd。
    assert.equal(
      tripleIndices(argv, "--bind", TASK).length,
      0,
      "no per-root writable cwd bind in global mode"
    );
  });

  it("cwdReadonly:true appends exactly one --ro-bind cwd cwd AFTER the host-root bind", () => {
    const argv = fenceArgv({ cwdReadonly: true });
    const roIndices = tripleIndices(argv, "--ro-bind", TASK);
    assert.equal(
      roIndices.length,
      1,
      `exactly one ro cwd override; argv=${JSON.stringify(argv)}`
    );
    const roIdx = roIndices[0] as number;
    const rootBindIdx = assertTriple(argv, "--bind", "/", "host root bind");
    assert.ok(
      roIdx > rootBindIdx,
      "the ro cwd override must follow `--bind / /` (last mount wins)"
    );
    // 系统块仍在 ro cwd 之前。
    const etcIdx = assertTriple(argv, "--ro-bind", "/etc", "system /etc");
    assert.ok(etcIdx < roIdx, "cwd ro override follows the system block");
    const procIdx = argv.indexOf("--proc");
    assert.ok(roIdx < procIdx, "cwd ro override precedes proc/dev");
  });

  it("cwdReadonly:false and absent cwdReadonly produce byte-identical argv", () => {
    const argvDefault = fenceArgv();
    const argvFalse = createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({ home: "/home/user", tmpDir: TMP }),
      networkPolicy: createNetworkPolicy(),
      resourceLimits: createResourceLimits(),
      env: { PATH: "/bin" },
      cwd: TASK,
      cwdReadonly: false,
    }).argv;
    assert.deepEqual([...argvFalse], [...argvDefault]);
  });

  it("network:true drops --unshare-net and changes nothing else", () => {
    const argv = fenceArgv({ network: true });
    assert.equal(argv.includes("--unshare-net"), false);
    assert.ok(argv.includes("--die-with-parent"));
    assert.equal(assertTriple(argv, "--bind", "/", "host root bind"), 3);
  });
});
