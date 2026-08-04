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
});
