/**
 * review-fix (H3): registry threads `workspaceRoot` to the bash factory.
 *
 * The bash factory closes over `workspaceRoot` to build its `createFsPolicy`
 * so the fence binds `<workspaceRoot>` and the protected-state pathset
 * covers `<workspaceRoot>/.iknow` at parity with `<home>/.iknow`. Without
 * the spread-guard in registry.ts (and the equivalent one in worker.ts),
 * the registry silently falls back to `sandboxRoot` and the protection
 * never moves to the per-root anchor the user asked for.
 *
 * Verification strategy: module-mock `bash.js` so the registry's named-import
 * of `createBashTool` resolves to a spy we control. A module mock (vs
 * `vi.spyOn` on the namespace) is required here: the registry imports
 * `createBashTool` as an ESM named binding, and spyOn on the namespace only
 * patches the property on the namespace object — the registry's internal
 * binding still points at the real function, so the real factory runs,
 * hits `requireBwrap()`, and `createDefaultAciRegistry` assembly depends on
 * the CI runner having bubblewrap installed. This test must pass regardless
 * of bwrap presence, so the factory is fully replaced by the spy.
 *
 * The mock spreads the real module but replaces only `createBashTool`
 * (same pattern as tests/harness/aci/lsp.test.ts's `getClient`). The other
 * tools (read_file / grep / glob / ...) stay real; only `bash` triggers
 * `requireBwrap` at assembly time, so replacing it is sufficient for a
 * bwrap-free path through `createDefaultAciRegistry`.
 *
 * Then assert the spy received the exact workspaceRoot passed in. The
 * third case mirrors the call site bash.ts uses internally
 * (`createFsPolicy({ cwd: sandboxRoot, home, tmpDir, workspaceRoot })`) and
 * asserts the resulting policy refuses `<workspaceRoot>/.iknow/...` —
 * proving the threading + the protective semantics together. The two halves
 * fail independently if either piece regresses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";

// Module mock must be registered before the dynamic import of the registry.
// `createBashTool` becomes a vitest mock fn; registry.ts's `import {
// createBashTool } from "./bash.js"` resolves to this spy at load time.
//
// The mock must return a valid AciToolDef stub: `createDefaultAciRegistry`
// eagerly assembles all factories into `tools = toolsetNames.map((n) =>
// factories[n]!())`, then `createAciRegistry` walks `tools` to enforce
// Gates 1/2 (e.g. `t.aci.lazy === true` for `tool_search`). The real
// `createBashTool` returns a full AciToolDef; our spy must do likewise or
// the assembly throws `RegistryConstructionError`. Only the structural
// fields read during construction are required — `aci.lazy: false` is the
// minimum (Gate 1 short-circuits when `!== true`).
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

import { createDefaultAciRegistry } from "../../../src/harness/aci/tools/registry.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createFsPolicy } from "../../../src/harness/sandbox/fs-policy.ts";

const FAKE = "/fake-root";
const SANDBOX = "/workspace";

beforeEach(() => {
  vi.mocked(createBashTool).mockClear();
});

describe("createDefaultAciRegistry — workspaceRoot threaded to bash factory (review-fix H3)", () => {
  it("bash factory receives workspaceRoot verbatim when caller passes it", () => {
    createDefaultAciRegistry({
      env: { web: { proxy: undefined, searchUrl: undefined } },
      sandboxRoot: SANDBOX,
      workspaceRoot: FAKE,
    });
    // bash factory must have been called with workspaceRoot: FAKE.
    const bashCall = vi.mocked(createBashTool).mock.calls[0];
    assert.ok(bashCall, "bash factory should have been invoked");
    // call args: (cwd, opts). opts.workspaceRoot must equal FAKE.
    const opts = bashCall[1] as { workspaceRoot?: string } | undefined;
    assert.equal(opts?.workspaceRoot, FAKE);
  });

  it("bash factory receives sandboxRoot as workspaceRoot fallback when caller omits it", () => {
    // registry.ts: `workspaceRoot = opts.workspaceRoot ?? sandboxRoot` —
    // when caller omits, the registry collapses to sandboxRoot, preserving
    // the legacy single-root shape (bash fence binds the same root for
    // both the soft sandbox and the per-root state anchor).
    createDefaultAciRegistry({
      env: { web: { proxy: undefined, searchUrl: undefined } },
      sandboxRoot: SANDBOX,
      // workspaceRoot intentionally omitted
    });
    const bashCall = vi.mocked(createBashTool).mock.calls[0];
    assert.ok(bashCall);
    const opts = bashCall[1] as { workspaceRoot?: string } | undefined;
    assert.equal(opts?.workspaceRoot, SANDBOX);
  });

  it("fs-policy protects <workspaceRoot>/.iknow at parity with <home>/.iknow", () => {
    // Mirrors what `createBashTool(sandboxRoot, { workspaceRoot })` does
    // internally: createFsPolicy({ cwd: sandboxRoot, home, tmpDir,
    // workspaceRoot }). If the registry correctly threads workspaceRoot,
    // then THIS is exactly the policy bash enforces — and the protected
    // state set must include the per-root anchor. (No real bwrap needed;
    // the policy surface is the same one exercised by
    // tests/harness/sandbox/fs-policy.test.ts.)
    const policy = createFsPolicy({
      cwd: SANDBOX,
      home: "/home/user",
      tmpDir: "/tmp/job",
      workspaceRoot: FAKE,
    });
    assert.throws(
      () => policy.assertWithin(`${FAKE}/.iknow/state.json`),
      (err: unknown) =>
        err instanceof Error &&
        err.message ===
          "[fs_denied] path outside fence: /fake-root/.iknow/state.json"
    );
    assert.throws(
      () => policy.assertWithin(`${FAKE}/.iknow/user.md`),
      /\[fs_denied\]/
    );
    assert.doesNotThrow(() => policy.assertWithin(`${FAKE}/AGENTS.md`));
    assert.doesNotThrow(() => policy.assertWithin(`${FAKE}/README.md`));
  });
});
