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
    assert.deepEqual(argv.slice(-3), ["--", "node", "-v"]);
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
