/**
 * registry threads `workspaceRoot` to the read_file factory (review-fix H3).
 *
 * ADR-0092 dead-surface review (Round-2 removal): the registry no longer
 * threads `workspaceRoot` to the bash factory — bash's fs-policy has no
 * `home` / `workspaceRoot` surface (no predicate, no per-root mount;
 * global mode binds the host root + system ro-binds). The surviving true
 * proposition: registry threads `workspaceRoot` to the read_file factory
 * as its `extraReadRoots` per-root anchor — `<workspaceRoot>/.iknow` stays
 * reachable at parity with the home profile. `traceReadDir` also resolves
 * under it for the trace read side.
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
  it("bash factory no longer receives workspaceRoot (Round-2 dead-surface removal)", () => {
    // ADR-0092: bash's fs-policy has no home/workspaceRoot surface; the
    // global fence binds the host root + system ro-binds. workspaceRoot
    // is still live for read_file's extraReadRoots but not for bash.
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
      undefined,
      "bash factory must not receive workspaceRoot (ADR-0092 global mode)"
    );
  });

  it("bash factory still receives sandboxRoot as the primary sandbox cwd", () => {
    // Legacy shape: bash is rooted at `sandboxRoot` (its `cwd` parameter).
    // workspaceRoot is unrelated to bash since the dead-surface removal.
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
