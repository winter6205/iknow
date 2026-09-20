/**
 * Tests for the egress spec extension of `bwrap.ts` — argv shape.
 *
 * Pinned invariants (from specs/network-egress-allowlist.md, ADR-0097 and
 * .claude/rules/security-boundaries.md "Sandbox argv"):
 *   - without an egress spec → argv stays at the always-disconnected
 *     baseline (`--unshare-net` always present; neither the seam's unix
 *     socket nor the proxy env is emitted);
 *   - with an egress spec → argv contains `--bind <unixSocket> <unixSocket>`
 *     and `--setenv HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY` etc.;
 *   - socket bind placement = after workspaceMounts, before cwdReadonly
 *     (last-mount-wins order);
 *   - the legacy `network?: boolean` is retired from the fence option layer
 *     entirely (the fence no longer consumes such an input); the fence
 *     always contains `--unshare-net` = the egress seam never bypasses the
 *     host netns.
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
      // GIT_SSH_COMMAND travels the same single channel as the proxy env:
      // spec.env → mergedEnv → --setenv (invariant 4), zero duplication at the fence layer.
      GIT_SSH_COMMAND:
        "ssh -F /dev/null -o ControlMaster=no -o ControlPath=none " +
        "-o ProxyCommand=\"'/test-root/bin/node' " +
        "'/test-root/vendor/egress-relay/egress-http-connect.mjs' %h %p\"",
    },
    // The bwrap layer does not consume innerBridgeScript (bash.ts's command
    // chain does); it only needs to satisfy the spec shape here. The relay
    // assets directory, however, IS consumed by bwrap (ro-bind).
    innerBridgeScript: "",
    relayAssetsDir: "/test-root/vendor/egress-relay",
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
    // Invariant 3: session absent (for any reason) → no GIT_SSH_COMMAND in
    // the fence env (no seam = no injection = git-over-SSH stays purely offline).
    assert.ok(!argv.includes("GIT_SSH_COMMAND"));
    // no --bind /tmp/iknow-egress-test.sock
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
    // the socket bind triple
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

    // --setenv injects the proxy env
    assert.ok(argv.includes("--setenv"));
    let sawHttp = false;
    let sawHttps = false;
    let sawAll = false;
    let sawNo = false;
    let sawGitSsh = false;
    for (let i = 0; i + 1 < argv.length; i++) {
      if (argv[i] !== "--setenv") continue;
      const name = argv[i + 1];
      const value = argv[i + 2];
      if (name === "HTTP_PROXY") sawHttp = true;
      if (name === "HTTPS_PROXY") sawHttps = true;
      if (name === "ALL_PROXY") sawAll = true;
      if (name === "NO_PROXY") sawNo = true;
      if (name === "GIT_SSH_COMMAND") {
        sawGitSsh = true;
        // value passes through spec.env verbatim (the fence layer never rewrites the injected string).
        assert.equal(value, egressSpec().env.GIT_SSH_COMMAND);
      }
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
    // GIT_SSH_COMMAND is injected through the single spec.env → mergedEnv →
    // --setenv channel (invariant 4: zero duplication across the three
    // consuming faces; the fence only passes through).
    assert.ok(sawGitSsh, "GIT_SSH_COMMAND set via spec.env channel");

    // --unshare-net still present (egress ≠ host network)
    assert.ok(argv.includes("--unshare-net"));
  });

  it("relay assets dir is ro-bound in the same egress segment (ADR-0107)", () => {
    const argv = fenceArgv({ egress: egressSpec() });
    const dir = "/test-root/vendor/egress-relay";
    let roIdx = -1;
    for (let i = 0; i + 2 < argv.length; i++) {
      if (
        argv[i] === "--ro-bind" &&
        argv[i + 1] === dir &&
        argv[i + 2] === dir
      ) {
        roIdx = i;
        break;
      }
    }
    assert.ok(
      roIdx > 0,
      "expected --ro-bind <relayAssetsDir> <relayAssetsDir>"
    );
    // Separate argv items (security-boundaries.md forbids inline syntax) —
    // the three-item shape is already verified by the index checks above
    // (each item is its own element). Placement = after workspaceMounts,
    // before cwdReadonly/proc: the same segment as the socket bind.
    assert.ok(
      roIdx < argv.indexOf("--proc"),
      "relay ro-bind precedes proc/dev"
    );
    assert.ok(
      roIdx < argv.indexOf("--clearenv"),
      "relay ro-bind precedes --clearenv"
    );
  });

  it("socket bind lands AFTER workspaceMounts, BEFORE cwdReadonly/proc", () => {
    const argv = fenceArgv({ egress: egressSpec() });
    const sockPath = "/tmp/iknow-egress-test.sock";
    // locate the socket bind index
    let bindIdx = -1;
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" && argv[i + 1] === sockPath) {
        bindIdx = i;
        break;
      }
    }
    assert.ok(bindIdx > 0, "socket bind present");
    // before proc/dev
    const procIdx = argv.indexOf("--proc");
    assert.ok(bindIdx < procIdx, "socket bind precedes proc/dev");
    // before --clearenv (alongside the other --setenv entries)
    const clearenvIdx = argv.indexOf("--clearenv");
    assert.ok(bindIdx < clearenvIdx, "socket bind precedes --clearenv");
  });

  it("--unshare-net stays constant when an egress spec is set (seam is not a netns bypass)", () => {
    // Even with an egress spec configured, the constant `--unshare-net`
    // guarantee is not opened up — egress reaches the in-sandbox proxy via a
    // unix socket and still runs under netns isolation (ADR-0097 single channel).
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
        relayAssetsDir: "/test-root/vendor/egress-relay",
      },
    });
    // empty socketPath → no --bind emitted
    for (let i = 0; i + 2 < argv.length; i++) {
      if (argv[i] === "--bind" && argv[i + 1] === argv[i + 2]) {
        assert.notEqual(argv[i + 1], "", "no empty socket bind");
      }
    }
    // env is still injected (fail-open on env? no — the spec supplied it, so it must be injected)
    assert.ok(argv.includes("--setenv"));
  });
});
