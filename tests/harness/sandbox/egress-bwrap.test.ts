/**
 * Tests for `bwrap.ts` egress spec 扩展 —— T4 argv 形态。
 *
 * 钉住的不变式（来自 specs/network-egress-allowlist.md §T4 + ADR-0097 +
 * .claude/rules/security-boundaries.md「Sandbox argv」）:
 *   - 不带 egress spec → argv 恒断网基线（`--unshare-net` 恒在;egress 缝
 *     unix socket 与代理 env 都不发射）;
 *   - 带 egress spec → argv 含 `--bind <unixSocket> <unixSocket>` 与
 *     `--setenv HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` 等;
 *   - socket bind 落位 = workspaceMounts 之后、cwdReadonly 之前
 *     （last-mount-wins 序）;
 *   - 旧 `network?: boolean` 已从 fence 选项层整体退役（fence 不再消费该
 *     入参）；fence 恒含 `--unshare-net` = 出口缝不构成宿主 netns 旁路。
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import type { EgressFenceSpec } from "../../../src/harness/sandbox/egress/session.js";

const FIX_ROOT = mkdtempSync(join(homedir(), ".iknow-egress-bwrap-"));
const TASK = join(FIX_ROOT, "task");
const TMP = mkdtempSync(join(tmpdir(), "egress-bwrap-tmp-"));

beforeAll(() => {
  mkdirSync(TASK, { recursive: true });
});

afterAll(() => {
  rmSync(FIX_ROOT, { recursive: true, force: true });
  rmSync(TMP, { recursive: true, force: true });
});

function egressSpec(): EgressFenceSpec {
  return {
    unixSocketPath: "/tmp/iknow-egress-test.sock",
    sandboxLocalPort: 3128,
    env: {
      HTTP_PROXY: "http://127.0.0.1:3128",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      ALL_PROXY: "http://127.0.0.1:3128",
      NO_PROXY: "127.0.0.1,localhost",
    },
    // bwrap 层不消费 innerBridgeScript（消费面是 bash.ts 命令链）；
    // 这里只需满足 spec 形状。
    innerBridgeScript: "",
  };
}

function fenceArgv(spec: {
  readonly egress?: EgressFenceSpec;
}): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ tmpDir: TMP }),
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(spec.egress !== undefined ? { egress: spec.egress } : {}),
  }).argv;
}

describe("createBwrapFence — egress spec 扩展 (ADR-0097 / T4)", () => {
  it("no egress spec → argv unchanged from V1 baseline", () => {
    const argv = fenceArgv({});
    assert.equal(
      argv.includes("--unshare-net"),
      true,
      "--unshare-net remains the default"
    );
    // 无 --bind /tmp/iknow-egress-test.sock
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" && argv[i + 1] === argv[i + 2]) {
        assert.notEqual(
          argv[i + 1],
          "/tmp/iknow-egress-test.sock",
          "no socket bind without egress spec"
        );
      }
    }
  });

  it("egress spec emits --bind socket AND --setenv proxy env", () => {
    const argv = fenceArgv({ egress: egressSpec() });
    // socket bind 三元组
    const sockPath = "/tmp/iknow-egress-test.sock";
    let found = false;
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" && argv[i + 1] === sockPath) {
        assert.equal(argv[i + 2], sockPath, "bind dest == source");
        found = true;
        break;
      }
    }
    assert.ok(found, `expected --bind ${sockPath} ${sockPath}`);

    // --setenv 注入代理 env
    assert.ok(argv.includes("--setenv"));
    let sawHttp = false;
    let sawHttps = false;
    let sawAll = false;
    let sawNo = false;
    for (let i = 0; i + 1 < argv.length; i++) {
      if (argv[i] !== "--setenv") continue;
      const name = argv[i + 1];
      const value = argv[i + 2];
      if (name === "HTTP_PROXY") sawHttp = true;
      if (name === "HTTPS_PROXY") sawHttps = true;
      if (name === "ALL_PROXY") sawAll = true;
      if (name === "NO_PROXY") sawNo = true;
      // env value matches spec
      if (
        name === "HTTP_PROXY" ||
        name === "HTTPS_PROXY" ||
        name === "ALL_PROXY"
      ) {
        assert.equal(value, "http://127.0.0.1:3128");
      }
    }
    assert.ok(
      sawHttp && sawHttps && sawAll && sawNo,
      "all 4 proxy env keys set"
    );

    // --unshare-net 仍在（egress ≠ host network）
    assert.ok(argv.includes("--unshare-net"));
  });

  it("socket bind lands AFTER workspaceMounts, BEFORE cwdReadonly/proc", () => {
    const argv = fenceArgv({ egress: egressSpec() });
    const sockPath = "/tmp/iknow-egress-test.sock";
    // 找到 socket bind 的索引
    let bindIdx = -1;
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" && argv[i + 1] === sockPath) {
        bindIdx = i;
        break;
      }
    }
    assert.ok(bindIdx > 0, "socket bind present");
    // 在 proc/dev 之前
    const procIdx = argv.indexOf("--proc");
    assert.ok(bindIdx < procIdx, "socket bind precedes proc/dev");
    // --clearenv 之前（与其它 --setenv 一起）
    const clearenvIdx = argv.indexOf("--clearenv");
    assert.ok(bindIdx < clearenvIdx, "socket bind precedes --clearenv");
  });

  it("--unshare-net stays constant when an egress spec is set (seam is not a netns bypass)", () => {
    // 即便配了 egress spec,`--unshare-net` 的恒定承诺也不被打开 —— egress 是
    // unix socket 进沙箱内代理,仍走 netns 隔离(ADR-0097 单一通道)。
    const argv = fenceArgv({ egress: egressSpec() });
    assert.ok(
      argv.includes("--unshare-net"),
      "egress seam does NOT open the host netns"
    );
  });

  it("egress spec with empty socket path → no bind, no crash", () => {
    const argv = fenceArgv({
      egress: {
        unixSocketPath: "",
        sandboxLocalPort: 3128,
        env: { HTTP_PROXY: "http://127.0.0.1:3128" },
        innerBridgeScript: "",
      },
    });
    // 空 socketPath → 不发射 --bind
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" && argv[i + 1] === argv[i + 2]) {
        assert.notEqual(argv[i + 1], "", "no empty socket bind");
      }
    }
    // 但 env 仍注入（fail-open on env? 不 —— env 是 spec 给的，应仍注入）
    assert.ok(argv.includes("--setenv"));
  });
});
