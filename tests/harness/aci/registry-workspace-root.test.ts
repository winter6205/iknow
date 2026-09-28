/**
 * registry threads `workspaceRoot` to the read_file AND bash factories.
 *
 * ADR-0092 dead-surface review (Round-2 removal) dropped the bash leg on the
 * grounds that bash's fs-policy had no per-root mount; the protected-target
 * work restored it as the fence's NAME-PATTERN SCAN SCOPE
 * (specs/effect-boundary-protection.md "Scan scope") — a role that has nothing
 * to do with the fs tier. The read_file leg is unchanged: `<workspaceRoot>/.iknow`
 * stays reachable at parity with the home profile, and `traceReadDir` resolves
 * under the same anchor.
 *
 * Module-mock `bash.js` so the registry's named import of `createBashTool`
 * resolves to a spy we control. A module mock (vs `vi.spyOn` on the
 * namespace) is required here: the registry imports `createBashTool` as an
 * ESM named binding, and spyOn on the namespace only patches the property
 * on the namespace object — the registry's internal binding still points at
 * the real function, so the real factory runs, hits `requireBwrap()`, and
 * `createDefaultAciRegistry` assembly depends on the CI runner having
 * bubblewrap installed. This test must pass regardless of bwrap presence,
 * so the factory is fully replaced by the spy.
 */
import { beforeEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";

// Module mocks must be registered before the dynamic import of the registry.
vi.mock("../../../src/harness/aci/tools/bash.js", () => ({
  createBashTool: vi.fn(() => ({
    name: "bash",
    description: "stub",
    inputSchema: { type: "object" },
    handler: async () => ({}),
    aci: {
      category: "execute",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "build",
    },
  })),
}));

vi.mock(
  "../../../src/harness/aci/tools/read-file.ts",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/harness/aci/tools/read-file.ts")
      >();
    return {
      ...actual,
      createReadFileTool: vi.fn(actual.createReadFileTool),
    };
  }
);

import { createDefaultAciRegistry } from "../../../src/harness/aci/tools/registry.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createReadFileTool } from "../../../src/harness/aci/tools/read-file.ts";

const FAKE = "/fake-root";
const SANDBOX = "/workspace";

beforeEach(() => {
  vi.mocked(createBashTool).mockClear();
  vi.mocked(createReadFileTool).mockClear();
});

describe("createDefaultAciRegistry — workspaceRoot threaded to read_file factory (review-fix H3)", () => {
  it("bash factory receives workspaceRoot as the name-pattern scan scope", () => {
    // The Round-2 dead-surface removal is REVOKED: workspaceRoot was dead for
    // bash because ADR-0092 global mode has no per-root bind. It is live again
    // as the name-pattern scan scope (specs/effect-boundary-protection.md "Scan
    // scope") — which is fs-mode-independent, so global and workspace mode
    // materialize over the same root.
    createDefaultAciRegistry({
      env: { web: { proxy: undefined, searchUrl: undefined } },
      sandboxRoot: SANDBOX,
      workspaceRoot: FAKE,
    });
    const bashCall = vi.mocked(createBashTool).mock.calls[0];
    assert.ok(bashCall, "bash factory should have been invoked");
    const opts = bashCall[1] as { workspaceRoot?: string } | undefined;
    assert.equal(
      opts?.workspaceRoot,
      FAKE,
      "bash freezes this root at handler entry as the fence's scan scope"
    );
  });

  it("absent workspaceRoot leaves bash to resolve through resolveWorkspaceRoot", () => {
    // No site invents a fallback: with no registry-level root, bash resolves
    // the SAME value the resolver gives every other per-root consumer.
    createDefaultAciRegistry({
      env: { web: { proxy: undefined, searchUrl: undefined } },
      sandboxRoot: SANDBOX,
    });
    const bashCall = vi.mocked(createBashTool).mock.calls[0];
    assert.ok(bashCall, "bash factory should have been invoked");
    const opts = bashCall[1] as { workspaceRoot?: string } | undefined;
    assert.equal(
      opts?.workspaceRoot,
      undefined,
      "the registry adds no key; resolution stays with the shared resolver"
    );
  });

  it("bash factory still receives sandboxRoot as the primary sandbox cwd", () => {
    // Legacy shape: bash's own `cwd` parameter stays `sandboxRoot`. The
    // workspaceRoot option is a SEPARATE input — the fence's name-pattern
    // scan scope, not bash's working directory.
    createDefaultAciRegistry({
      env: { web: { proxy: undefined, searchUrl: undefined } },
      sandboxRoot: SANDBOX,
      workspaceRoot: FAKE,
    });
    const bashCall = vi.mocked(createBashTool).mock.calls[0];
    assert.ok(bashCall, "bash factory should have been invoked");
    // call args: (cwd, opts). The factory's cwd is sandboxRoot.
    assert.equal(bashCall[0], SANDBOX);
  });

  it("workspaceRoot is still threaded to the read_file factory (its surviving consumer)", () => {
    createDefaultAciRegistry({
      env: { web: { proxy: undefined, searchUrl: undefined } },
      sandboxRoot: SANDBOX,
      workspaceRoot: FAKE,
    });
    // read_file factory call: (root, opts). opts.workspaceRoot must equal FAKE.
    const readCalls = vi.mocked(createReadFileTool).mock.calls;
    const readCall = readCalls.find((c) => c[0] === SANDBOX);
    assert.ok(readCall, "read_file factory should have been invoked");
    const opts = readCall[1] as { workspaceRoot?: string } | undefined;
    assert.equal(
      opts?.workspaceRoot,
      FAKE,
      "read_file factory must receive workspaceRoot (extraReadRoots anchor)"
    );
  });

  it("workspaceRoot falls back to sandboxRoot for read_file when caller omits it", () => {
    createDefaultAciRegistry({
      env: { web: { proxy: undefined, searchUrl: undefined } },
      sandboxRoot: SANDBOX,
      // workspaceRoot intentionally omitted
    });
    const readCalls = vi.mocked(createReadFileTool).mock.calls;
    const readCall = readCalls.find((c) => c[0] === SANDBOX);
    assert.ok(readCall, "read_file factory should have been invoked");
    const opts = readCall[1] as { workspaceRoot?: string } | undefined;
    assert.equal(
      opts?.workspaceRoot,
      SANDBOX,
      "workspaceRoot must fall back to sandboxRoot (legacy shape) for read_file"
    );
  });
});
