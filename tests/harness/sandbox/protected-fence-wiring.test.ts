/**
 * The single wiring point's arm choice (`prepareProtectedFenceWiring`).
 *
 * This is the one place that decides WHICH arm an assembling call takes, so the
 * two halves of that decision are pinned here rather than at each route:
 *   - a retired fence (ADR-0141), so the seam must not pay for
 *     a walk of the workspace that nothing will read;
 *   - every other call walks behind the name arm with awaited reads, and the
 *     bundle it returns is the one the assembly consumes — a walk that the
 *     fence did not take would re-enumerate on the thread that renders the UI.
 *
 * `prewalkProtectedTargets` is spied THROUGH (passthrough mock: the real walk
 * still runs), so nothing here weakens the argv pins elsewhere.
 *
 * Fixture discipline: an mkdtemp home and workspace; no real home, credential,
 * or session is read.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "../../../src/harness/sandbox/protected-targets.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/harness/sandbox/protected-targets.js")
      >();
    return {
      ...actual,
      prewalkProtectedTargets: vi.fn(actual.prewalkProtectedTargets),
    };
  }
);

import {
  materializeProtectedTargets,
  type ProtectedTargetInventory,
} from "../../../src/harness/sandbox/protected-targets.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";
import {
  prepareProtectedFenceWiring,
  protectedFenceWiring,
} from "../../../src/harness/sandbox/protected-fence-wiring.js";

const prewalkSpy = (
  await import("../../../src/harness/sandbox/protected-targets.js")
).prewalkProtectedTargets as unknown as ReturnType<typeof vi.fn>;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { home: string; workspaceRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "fence-wiring-"));
  roots.push(root);
  const home = join(root, "home");
  const workspaceRoot = join(root, "ws");
  mkdirSync(join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(join(workspaceRoot, "src", "server.pem"), "p\n", "utf8");
  return { home, workspaceRoot };
}

let home: string;
let workspaceRoot: string;
beforeEach(() => {
  prewalkSpy.mockClear();
  ({ home, workspaceRoot } = fixture());
});

describe("prepareProtectedFenceWiring — the arm choice at the single wiring point", () => {
  it("a retired fence takes the synchronous arm and enumerates nothing", async () => {
    const wiring = await prepareProtectedFenceWiring({
      homeRoot: home,
      workspaceRoot,
      fenceRetired: true,
    });
    expect(prewalkSpy).not.toHaveBeenCalled();
    // The arm changes WHEN the tree is walked, never WHAT is protected: the
    // credential mask still rides with the call, and the roster is the roster
    // the synchronous wiring point resolves for the same scope. (The inventory's
    // own methods are per-instance closures, so the data half is what compares.)
    assert.equal(wiring.protectCredentialReads, true);
    assert.deepEqual(
      wiring.protectedTargets.entries,
      protectedFenceWiring({ homeRoot: home, workspaceRoot }).protectedTargets
        .entries
    );
  });

  it("a fenced call walks the bundle it returns, once", async () => {
    const wiring = await prepareProtectedFenceWiring({
      homeRoot: home,
      workspaceRoot,
      fenceRetired: false,
    });
    expect(prewalkSpy).toHaveBeenCalledTimes(1);
    assert.equal(
      prewalkSpy.mock.calls[0]?.[0] as ProtectedTargetInventory,
      wiring.protectedTargets,
      "the walk was parked for the inventory this call hands the fence"
    );
  });

  it("the assembly refuses a changed walk and the next assembly sees the new match", async () => {
    const wiring = await prepareProtectedFenceWiring({
      homeRoot: home,
      workspaceRoot,
      fenceRetired: false,
    });
    const lateCredential = join(workspaceRoot, "src", "late.key");
    writeFileSync(lateCredential, "k\n", "utf8");
    assert.throws(
      () => materializeProtectedTargets(wiring.protectedTargets),
      (error: unknown) => {
        assert.ok(
          error instanceof ToolExecutionError &&
            /protected-targets: materialization/.test(error.message),
          `expected a typed materialization refusal, got ${String(error)}`
        );
        // Name the guard, not just the shared prefix: ~20 refusal sites emit
        // `protected-targets: materialization`, so the prefix alone cannot tell
        // the precise per-item guard from some broader refusal that happens to
        // fire first.
        assert.ok(
          error.message.includes(
            `contains a new protected match ${lateCredential}`
          ),
          `expected the refusal to name the new protected match, got: ${error.message}`
        );
        return true;
      },
      "a fence cannot consume a pre-walk after its directory contents changed"
    );

    // The refused assembly consumed the one-shot result. The following call
    // must take the synchronous fallback and include the file that was added.
    const fresh = materializeProtectedTargets(wiring.protectedTargets);
    assert.ok(
      fresh.targets.some((target) => target.path === lateCredential),
      "the next assembly must enumerate current filesystem contents"
    );
  });
});
