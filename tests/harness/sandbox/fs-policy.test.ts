import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  READ_ONLY_SYSTEM_PATHS,
  SENSITIVE_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";

describe("createFsPolicy", () => {
  const policy = createFsPolicy({
    cwd: "/workspace",
    home: "/home/user",
    tmpDir: "/tmp/job",
  });

  it("freezes exported path lists and excludes sensitive home paths", () => {
    assert.ok(Object.isFrozen(SENSITIVE_PATHS));
    assert.ok(Object.isFrozen(READ_ONLY_SYSTEM_PATHS));
    assert.equal(policy.isSensitive("/home/user/.ssh/id_ed25519"), true);
    assert.equal(
      policy.allowedPaths().some((path) => path.endsWith("/.ssh")),
      false
    );
  });

  it("rejects sensitive and outside paths with a typed denial", () => {
    assert.throws(
      () => policy.assertWithin("/home/user/.ssh/config"),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "[fs_denied] path outside fence: /home/user/.ssh/config"
    );
    assert.throws(() => policy.assertWithin("/etc/passwd"), /\[fs_denied\]/);
  });

  it("allows paths within cwd and identifies read-only system roots", () => {
    assert.doesNotThrow(() => policy.assertWithin("/workspace/src/index.ts"));
    assert.equal(policy.isReadOnlySystem("/etc/hosts"), true);
    assert.equal(policy.isReadOnlySystem("/workspace/file"), false);
  });

  it("does not turn a recursive find root into an allowlisted sensitive path", () => {
    assert.equal(policy.allowedPaths().includes("/"), false);
    assert.equal(policy.isSensitive("/home/user/.docker/config.json"), true);
  });
});
