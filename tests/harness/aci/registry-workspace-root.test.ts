/**
 * review-fix (H3): registry threads `workspaceRoot` to the bash factory.
 *
 * The bash factory closes over `workspaceRoot` to build its `createFsPolicy`
 * so the protected-state pathset covers `<workspaceRoot>/.iknow` at parity
 * with `<home>/.iknow`. Without the spread-guard in registry.ts (and the
 * equivalent one in worker.ts), the registry silently falls back to
 * `sandboxRoot` and the protection never moves to the per-root anchor the
 * user asked for.
 *
 * ADR-0092: `workspaceRoot` is a state anchor only — it no longer
 * contributes a bind root or a read whitelist, and the closed-world
 * `installRoot` option retired with the global mode.
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
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it, vi } from "vitest";
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
    // the legacy single-root shape for the per-root state anchor.
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

  it("fs-policy marks <workspaceRoot>/.iknow sensitive at parity with <home>/.iknow", () => {
    // Mirrors what `createBashTool(sandboxRoot, { workspaceRoot })` does
    // internally: createFsPolicy({ home, tmpDir, workspaceRoot }). If the
    // registry correctly threads workspaceRoot, then THIS is exactly the
    // policy bash enforces — and the protected-state predicate must cover
    // the per-root anchor. (No real bwrap needed; the policy surface is the
    // same one exercised by tests/harness/sandbox/fs-policy.test.ts.)
    //
    // ADR-0092: workspaceRoot is a state anchor only — its non-.iknow paths
    // are ordinary host paths (not bind roots) and createFsPolicy no longer
    // exposes assertWithin/readRoots. The predicate names only sensitive /
    // protected-state paths.
    const tmp = mkdtempSync(join(tmpdir(), "registry-ws-root-tmp-"));
    try {
      const policy = createFsPolicy({
        home: "/home/user",
        tmpDir: tmp,
        workspaceRoot: FAKE,
      });
      assert.equal(
        policy.isSensitive(`${FAKE}/.iknow/state.json`),
        true,
        "workspaceRoot anchor must cover <workspaceRoot>/.iknow"
      );
      assert.equal(
        policy.isSensitive(`${FAKE}/.iknow/user.md`),
        true,
        "the whole <workspaceRoot>/.iknow subtree is protected"
      );
      assert.equal(
        policy.isSensitive("/home/user/.iknow/state.json"),
        true,
        "home anchor parity"
      );
      assert.equal(
        policy.isSensitive(`${FAKE}/AGENTS.md`),
        false,
        "workspaceRoot is a state anchor only — not a bind root / sensitive path"
      );
      assert.equal(
        policy.isSensitive(join(tmp, "scratch.txt")),
        false,
        "the session tmp is not sensitive state"
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
