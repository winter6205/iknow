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
import type { EgressFenceSpec } from "../../../src/harness/sandbox/egress/session.js";

/**
 * ADR-0092 global-mode bwrap argv shape.
 *
 * Fixed skeleton: `--bind / /` (host paths visible and writable) → system
 * prefixes `--ro-bind` (/usr /bin /lib /lib64 /etc plus /opt /snap when
 * present on disk) → optional `--ro-bind cwd cwd` (cwdReadonly) →
 * `--proc /proc` → `--dev-bind /dev /dev`. No guest /tmp bind, no `--tmpfs`,
 * no writable-home base or per-identity writable root table. Session tmp
 * stays on its host path and never enters argv.
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

/** All positions of the `verb <target> <target>` triple. */
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
  spec: { readonly cwdReadonly?: boolean } = {}
): readonly string[] {
  return createBwrapFence({
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ tmpDir: TMP }),
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(spec.cwdReadonly ? { cwdReadonly: true } : {}),
  }).argv;
}

describe("createBwrapFence — 全局档 argv 形态 (ADR-0092)", () => {
  it("binds the host root first, then re-binds system prefixes read-only, then proc/dev", () => {
    const argv = fenceArgv();
    assert.equal(argv[0], "bwrap");
    assert.equal(argv[1], "--unshare-user-try");
    assert.equal(argv[2], "--unshare-net");
    assert.equal(argv[3], "--die-with-parent");
    // 1. host root `/` is the first mount and the base the last mount wins over (the only `/` mount here).
    const rootBindIdx = assertTriple(argv, "--bind", "/", "host root bind");
    assert.equal(rootBindIdx, 4, "`--bind / /` is the first mount token");
    // 2. system block: all fixed prefixes are --ro-bind, after `/`, in strictly increasing order.
    let cursor = rootBindIdx;
    for (const target of READ_ONLY_SYSTEM_PATHS) {
      const idx = assertTriple(argv, "--ro-bind", target, `system ${target}`);
      assert.ok(idx > cursor, `${target} keeps the system block order`);
      cursor = idx;
    }
    // 3. optional on-disk /opt /snap ro-binds belong to the same system block.
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
    // 4. proc/dev close the block, both after all mounts.
    const procIdx = argv.indexOf("--proc");
    const devIdx = argv.indexOf("--dev-bind");
    assert.ok(procIdx > cursor && devIdx > procIdx);
    // 5. --clearenv precedes every --setenv and comes after dev-bind.
    const clearenvIdx = argv.indexOf("--clearenv");
    assert.ok(clearenvIdx > devIdx, "--clearenv follows the mount block");
    const setenvIndices = argv
      .map((arg, index) => (arg === "--setenv" ? index : -1))
      .filter((index) => index !== -1);
    assert.ok(setenvIndices.length > 0, "expected at least one --setenv");
    for (const idx of setenvIndices) {
      assert.ok(clearenvIdx < idx, "--clearenv must precede every --setenv");
    }
    // 6. chdir then the command tail.
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
    // no bind may use the session tmp as source or `/tmp` as target (the guest-/tmp alias is retired).
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
    // in global mode cwd is writable via the `/` mount itself — no explicit `--bind cwd cwd` anymore.
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
    // the system block still precedes the ro cwd override.
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
      fsPolicy: createFsPolicy({ tmpDir: TMP }),
      env: { PATH: "/bin" },
      cwd: TASK,
      cwdReadonly: false,
    }).argv;
    assert.deepEqual([...argvFalse], [...argvDefault]);
  });

  // ADR-0097: netns isolation is constant. There is no per-call network
  // input left on the fence API — `--unshare-net` is emitted for every
  // caller, and egress leaves only through the unix-socket seam.
  it("--unshare-net is always emitted (no per-call network input exists)", () => {
    const argv = createBwrapFence({
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({ tmpDir: TMP }),
      env: { PATH: "/bin" },
      cwd: TASK,
    }).argv;
    assert.ok(
      argv.includes("--unshare-net"),
      "constant netns isolation; spec SC1"
    );
    assert.ok(argv.includes("--die-with-parent"));
    assert.equal(assertTriple(argv, "--bind", "/", "host root bind"), 4);
  });
});

// ── ADR-0109: UNBOUND_FENCE segment ─────────────────────────────────────────

const MAIN = mkdtempSync(join(tmpdir(), "bwrap-unbound-main-"));
const PAD = mkdtempSync(join(tmpdir(), "bwrap-unbound-pad-"));

afterAll(() => {
  rmSync(MAIN, { recursive: true, force: true });
  rmSync(PAD, { recursive: true, force: true });
});

type UnboundSpec = {
  readonly cwdReadonly?: boolean;
  readonly egress?: boolean;
  readonly unboundFence?: { mainCheckout: string; tmpPad?: string } | undefined;
};

function unboundArgv(spec: UnboundSpec): readonly string[] {
  const fakeEgress: EgressFenceSpec = {
    unixSocketPath: "/tmp/iknow-bwrap-unbound-test.sock",
    sandboxLocalPort: 19099,
    env: {},
    innerBridgeScript: "",
    relayAssetsDir: "/tmp/iknow-bwrap-unbound-relay",
  };
  return createBwrapFence({
    command: "bash",
    args: ["-c", "echo hi"],
    fsPolicy: createFsPolicy({ tmpDir: TMP }),
    env: { PATH: "/bin" },
    cwd: TASK,
    ...(spec.cwdReadonly ? { cwdReadonly: true } : {}),
    ...(spec.egress ? { egress: fakeEgress } : {}),
    ...(spec.unboundFence !== undefined
      ? { unboundFence: spec.unboundFence }
      : {}),
  }).argv;
}

describe("createBwrapFence — UNBOUND_FENCE 段 (issue 1059)", () => {
  it("emits --ro-bind main after every writable bind, then re-binds the tmp pad writable, all before --proc/--dev-bind", () => {
    const argv = unboundArgv({
      unboundFence: { mainCheckout: MAIN, tmpPad: PAD },
    });
    const rootBindIdx = assertTriple(argv, "--bind", "/", "host root bind");
    const roMainIdx = assertTriple(
      argv,
      "--ro-bind",
      MAIN,
      "unbound main ro-bind"
    );
    const padIdx = assertTriple(argv, "--bind", PAD, "tmp pad rw rebind");
    const procIdx = argv.indexOf("--proc");
    const devIdx = argv.indexOf("--dev-bind");
    assert.ok(procIdx > 0 && devIdx > procIdx);
    // last-mount-wins contract: rw base → main checkout overridden ro → pad flipped back rw → proc/dev
    assert.ok(
      rootBindIdx < roMainIdx,
      "main ro-bind follows the writable host-root bind"
    );
    assert.ok(
      roMainIdx < padIdx,
      "the tmp pad rebind sits ON TOP of the main ro-bind"
    );
    assert.ok(
      padIdx < procIdx,
      "the whole unbound block precedes --proc/--dev-bind"
    );
    // exactly one of each — no duplicate segments
    assert.equal(tripleIndices(argv, "--ro-bind", MAIN).length, 1);
    assert.equal(tripleIndices(argv, "--bind", PAD).length, 1);
  });

  it("with cwdReadonly the unbound block still lands last (after the cwd ro override, before proc/dev)", () => {
    const argv = unboundArgv({
      cwdReadonly: true,
      unboundFence: { mainCheckout: MAIN, tmpPad: PAD },
    });
    const roCwdIdx = assertTriple(argv, "--ro-bind", TASK, "cwd ro override");
    const roMainIdx = assertTriple(argv, "--ro-bind", MAIN, "main ro-bind");
    const padIdx = assertTriple(argv, "--bind", PAD, "pad rw rebind");
    const procIdx = argv.indexOf("--proc");
    assert.ok(
      roCwdIdx < roMainIdx,
      "cwdReadonly mount precedes the unbound block"
    );
    assert.ok(roMainIdx < padIdx && padIdx < procIdx);
  });

  it("with an egress socket bind the unbound block lands after it (last writable mount stays inside the block)", () => {
    const argv = unboundArgv({
      egress: true,
      unboundFence: { mainCheckout: MAIN, tmpPad: PAD },
    });
    const socketIdx = assertTriple(
      argv,
      "--bind",
      "/tmp/iknow-bwrap-unbound-test.sock",
      "egress socket bind"
    );
    const roMainIdx = assertTriple(argv, "--ro-bind", MAIN, "main ro-bind");
    const padIdx = assertTriple(argv, "--bind", PAD, "pad rw rebind");
    const procIdx = argv.indexOf("--proc");
    assert.ok(socketIdx < roMainIdx, "egress bind precedes the unbound block");
    assert.ok(roMainIdx < padIdx && padIdx < procIdx);
  });

  it("absent unboundFence → argv byte-identical to the pre-flip baseline", () => {
    const withOpt = unboundArgv({});
    const baseline = fenceArgv();
    assert.deepEqual([...withOpt], [...baseline]);
    assert.equal(withOpt.includes(MAIN), false);
    assert.equal(withOpt.includes(PAD), false);
  });

  it("empty mainCheckout → typed fail-loud (silent skip would leave the main checkout writable)", () => {
    assert.throws(
      () => unboundArgv({ unboundFence: { mainCheckout: "", tmpPad: PAD } }),
      (err: unknown) =>
        err instanceof ToolExecutionError &&
        /mainCheckout/.test(err.message) &&
        /silently leave the main checkout writable/.test(err.message),
      "unbound fence with an empty mainCheckout must refuse to build"
    );
  });

  it("absent / empty tmpPad → ro-bind segment only, no pad bind (tightening direction, never a silent hole)", () => {
    for (const spec of [
      { mainCheckout: MAIN },
      { mainCheckout: MAIN, tmpPad: "" },
      { mainCheckout: MAIN, tmpPad: undefined },
    ]) {
      const argv = unboundArgv({ unboundFence: spec });
      assertTriple(argv, "--ro-bind", MAIN, "main ro-bind still emitted");
      assert.equal(
        tripleIndices(argv, "--bind", PAD).length,
        0,
        `no pad bind may be emitted for ${JSON.stringify(spec)}`
      );
    }
  });
});
