import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createBwrapFence } from "../../../src/harness/sandbox/bwrap.js";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.js";
import { createNetworkPolicy } from "../../../src/harness/sandbox/network-policy.js";
import {
  createResourceLimits,
  TMP_BYTES,
} from "../../../src/harness/sandbox/resource-limits.js";

describe("createBwrapFence", () => {
  // Shared construction helper (mirrors the canonical assembly). Pure argv
  // logic — no spawn. `network` is only set when explicitly passed so the
  // absent (default) path is exercised by the same call shape.
  function fenceArgv(network?: boolean): string[] {
    const cwd = "/workspace";
    const opts: {
      command: string;
      args: string[];
      fsPolicy: ReturnType<typeof createFsPolicy>;
      networkPolicy: ReturnType<typeof createNetworkPolicy>;
      resourceLimits: ReturnType<typeof createResourceLimits>;
      env: NodeJS.ProcessEnv;
      cwd: string;
      network?: boolean;
    } = {
      command: "bash",
      args: ["-c", "echo hi"],
      fsPolicy: createFsPolicy({ cwd, home: "/home/user", tmpDir: "/tmp/job" }),
      networkPolicy: createNetworkPolicy(),
      resourceLimits: createResourceLimits(),
      env: { PATH: "/bin" },
      cwd,
    };
    if (network !== undefined) {
      opts.network = network;
    }
    return createBwrapFence(opts).argv;
  }

  // Spot-check helper asserting the canonical fence key flags are present,
  // mirroring the assertion style of the first test.
  function assertCanonicalFenceFlags(argv: string[], cwd: string): void {
    assert.equal(argv[0], "bwrap");
    assert.equal(argv[1], "--unshare-user-try");
    assert.ok(argv.includes("--die-with-parent"));
    const etcIndex = argv.indexOf("/etc");
    assert.deepEqual(argv.slice(etcIndex - 1, etcIndex + 2), [
      "--ro-bind",
      "/etc",
      "/etc",
    ]);
    const bindCwdIndex = argv.findIndex(
      (arg, index) => arg === "--bind" && argv[index + 1] === cwd
    );
    assert.notEqual(bindCwdIndex, -1, "expected --bind <cwd> <cwd> in argv");
    assert.ok(argv.includes("--clearenv"));
    assert.ok(
      argv.includes("--tmpfs") && argv.includes("/tmp"),
      "expected --tmpfs /tmp in argv"
    );
    assert.equal(argv.includes("--rlimit-as"), false);
    const commandIdx = argv.indexOf("--");
    assert.deepEqual(argv.slice(commandIdx, commandIdx + 3), [
      "--",
      "bash",
      "-c",
    ]);
  }

  it("builds the ordered v0 fence argv", () => {
    const cwd = "/workspace";
    const argv = createBwrapFence({
      command: "node",
      args: ["-v"],
      fsPolicy: createFsPolicy({ cwd, home: "/home/user", tmpDir: "/tmp/job" }),
      networkPolicy: createNetworkPolicy(),
      resourceLimits: createResourceLimits(),
      env: { PATH: "/bin" },
      cwd,
    }).argv;
    assert.equal(argv[0], "bwrap");
    assert.equal(argv[1], "--unshare-user-try");
    assert.ok(argv.includes("--unshare-net"));
    const etcIndex = argv.indexOf("/etc");
    assert.deepEqual(argv.slice(etcIndex - 1, etcIndex + 2), [
      "--ro-bind",
      "/etc",
      "/etc",
    ]);
    const lib64Index = argv.indexOf("/lib64");
    assert.deepEqual(argv.slice(lib64Index - 1, lib64Index + 2), [
      "--ro-bind",
      "/lib64",
      "/lib64",
    ]);
    assert.ok(argv.includes("--bind"));
    assert.ok(argv.includes(cwd));
    assert.equal(argv.includes("--rlimit-as"), false);
    const bindCwdIndex = argv.findIndex(
      (arg, index) => arg === "--bind" && argv[index + 1] === cwd
    );
    const tmpfsIndex = argv.indexOf("--tmpfs", bindCwdIndex);
    assert.deepEqual(argv.slice(tmpfsIndex - 1, tmpfsIndex + 2), [
      String(TMP_BYTES),
      "--tmpfs",
      "/tmp",
    ]);
    assert.ok(bindCwdIndex < tmpfsIndex);
    assert.equal(argv.includes("--seccomp"), false);
    // --clearenv must precede --dev-bind and every --setenv so the sandbox
    // inherits only whitelisted entries (env leak fix, #225).
    const clearenvIndex = argv.indexOf("--clearenv");
    assert.notEqual(clearenvIndex, -1, "expected --clearenv in argv");
    const devBindIndex = argv.indexOf("--dev-bind");
    assert.ok(
      clearenvIndex > devBindIndex,
      "--clearenv must come after --dev-bind"
    );
    const setenvIndices = argv
      .map((arg, index) => (arg === "--setenv" ? index : -1))
      .filter((index) => index !== -1);
    assert.ok(setenvIndices.length > 0, "expected at least one --setenv");
    for (const idx of setenvIndices) {
      assert.ok(
        clearenvIndex < idx,
        `--clearenv (${clearenvIndex}) must precede --setenv (${idx})`
      );
    }
    assert.deepEqual(argv.slice(-3), ["--", "node", "-v"]);
  });

  it("network:true drops --unshare-net but keeps every other fence flag (T9 opt-in)", () => {
    const argv = fenceArgv(true);
    assert.equal(argv.includes("--unshare-net"), false);
    assertCanonicalFenceFlags(argv, "/workspace");
  });

  it("network:false and absent network both keep --unshare-net (default isolation)", () => {
    const argvFalse = fenceArgv(false);
    assert.ok(argvFalse.includes("--unshare-net"));
    assertCanonicalFenceFlags(argvFalse, "/workspace");
    const argvAbsent = fenceArgv();
    assert.ok(argvAbsent.includes("--unshare-net"));
    assertCanonicalFenceFlags(argvAbsent, "/workspace");
  });

  it("throws a ToolExecutionError when fsPolicy.allowedPaths() is empty (M4 fail-loud)", () => {
    // Misconfigured fsPolicy with no roots — must refuse to bind rather than
    // silently falling back to process.cwd() (which would unbind the fence).
    const fakeFsPolicy = {
      allowedPaths: (): readonly string[] => [],
      isSensitive: () => false,
      isReadOnlySystem: () => false,
      assertWithin: () => undefined,
    };
    assert.throws(
      () =>
        createBwrapFence({
          command: "node",
          args: ["-v"],
          fsPolicy: fakeFsPolicy,
          networkPolicy: createNetworkPolicy(),
          resourceLimits: createResourceLimits(),
          env: { PATH: "/bin" },
          cwd: "/workspace",
        }),
      (err: unknown) => {
        return (
          err instanceof Error &&
          err.message.includes(
            "fsPolicy.allowedPaths() must contain at least cwd+home"
          )
        );
      }
    );
  });

  it("throws a ToolExecutionError when fsPolicy.allowedPaths() has a single entry (M4 fail-loud)", () => {
    // Even one entry (cwd-only) is treated as misconfiguration: the home bind
    // would be impossible to synthesize without a guess.
    const fakeFsPolicy = {
      allowedPaths: (): readonly string[] => ["/workspace"],
      isSensitive: () => false,
      isReadOnlySystem: () => false,
      assertWithin: () => undefined,
    };
    assert.throws(
      () =>
        createBwrapFence({
          command: "node",
          args: ["-v"],
          fsPolicy: fakeFsPolicy,
          networkPolicy: createNetworkPolicy(),
          resourceLimits: createResourceLimits(),
          env: { PATH: "/bin" },
          cwd: "/workspace",
        }),
      /fsPolicy\.allowedPaths\(\) must contain at least cwd\+home/
    );
  });
});
