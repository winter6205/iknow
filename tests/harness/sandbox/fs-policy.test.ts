import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  OPTIONAL_HOST_RO_PREFIXES,
  READ_ONLY_SYSTEM_PATHS,
  createFsPolicy,
} from "../../../src/harness/sandbox/fs-policy.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/**
 * ADR-0092 global-mode fs-policy contract (dead-surface removal).
 *
 * With the closed world (read/write allowlists + assertWithin / SENSITIVE_PATHS
 * / isSensitive) retired, the policy keeps a single surface:
 *   - `tmpRoot()`: this identity's session-tmp host path (used for `$TMPDIR`
 *     and writable tool roots), not a bind target for a guest `/tmp`.
 *
 * There are no home / workspaceRoot state-anchor predicates, no allowlists, no
 * isSensitive surface; write protection is carried by the bwrap mount layer
 * (host root + read-only system-prefix rebinding) plus the permission chain and
 * the hard wall. The only contract input is `tmpDir` (blank or absent on disk →
 * typed fail-loud, no spawn).
 */

describe("createFsPolicy — global-mode tmpRoot (ADR-0092)", () => {
  let fixtureRoot: string;
  let tmp: string;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "fs-policy-global-"));
    mkdirSync(fixtureRoot, { recursive: true });
    tmp = mkdtempSync(join(tmpdir(), "fs-policy-global-tmp-"));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  function policyFor(
    extra: Partial<Parameters<typeof createFsPolicy>[0]> = {}
  ): ReturnType<typeof createFsPolicy> {
    return createFsPolicy({
      tmpDir: tmp,
      ...extra,
    });
  }

  it("exposes only tmpRoot — the closed-world root axes and isSensitive are gone", () => {
    const policy = policyFor();
    assert.equal(policy.tmpRoot(), resolve(tmp));
    // every retired closed-world accessor and the retired placeholder predicates must be gone — any survivor is a regression.
    const surface = policy as unknown as Record<string, unknown>;
    for (const retired of [
      "writeRoots",
      "readRoots",
      "optionalReadRoots",
      "assertWithin",
      "isSensitive",
    ]) {
      assert.equal(
        retired in surface,
        false,
        `retired closed-world accessor must not survive: ${retired}`
      );
    }
  });

  it("fails loud on a blank or missing tmpDir contract root (config-fault class)", () => {
    assert.throws(
      () => policyFor({ tmpDir: "" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
    assert.throws(
      () => policyFor({ tmpDir: "   " }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
    assert.throws(
      () => policyFor({ tmpDir: "/nonexistent-global-tmp" }),
      (err: unknown) =>
        err instanceof ToolExecutionError && /tmpDir/.test(err.message)
    );
  });

  it("keeps the frozen host-prefix sources single-source (system + optional)", () => {
    assert.ok(Object.isFrozen(READ_ONLY_SYSTEM_PATHS));
    assert.ok(Object.isFrozen(OPTIONAL_HOST_RO_PREFIXES));
    assert.deepEqual(
      [...READ_ONLY_SYSTEM_PATHS],
      ["/usr", "/bin", "/lib", "/lib64", "/etc"]
    );
    assert.deepEqual([...OPTIONAL_HOST_RO_PREFIXES], ["/opt", "/snap"]);
  });

  it("tmpRoot is the exact host path passed in (never a guest /tmp alias)", () => {
    const policy = policyFor();
    assert.equal(policy.tmpRoot(), resolve(tmp));
    assert.notEqual(policy.tmpRoot(), "/tmp");
  });
});
