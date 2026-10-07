/**
 * Contract phase closing the original bug: the gate reads the LIVE `taskRoot`
 * cell instead of the assembly-time-frozen `root`. After `create-worktree`
 * succeeds inside a run, the same engine's next wave of mutate tool calls
 * lands in the new task worktree.
 *
 * Pinned invariants:
 *   - red -> green: once the gate reads the live root, "turn 0 of a run runs
 *     `create-worktree` successfully -> later turns' mutates land in the new
 *     tree" flips from red to green.
 *   - Batch snapshot: a live-root flip is NOT observed within the same
 *     executeAll wave (one root per wave); it takes effect only across waves.
 *   - Consistency invariant: for every mutate the gate admits, the executing
 *     consumer's root and the gate's decision root are the same wave-snapshot
 *     value (no admit-but-write-old-root window).
 *   - fail-closed — unboundMutateNotice() still blocks when no tree exists.
 *   - Without a rebind, behavior is byte-for-byte unchanged.
 *
 * These tests pin those invariants against `createWorktreeIsolationExecutor`
 * with a fake inner executor so the gate's wire-level contract is exercised
 * directly (no buildHarnessEngine plumbing).
 */
import { describe, expect, it } from "vitest";

import {
  CREATE_WORKTREE_TOOL_HINT,
  createWorktreeIsolationExecutor,
  WORKTREE_ISOLATION_PREFIX,
} from "../../../src/harness/isolation/worktree-gate.ts";
import {
  createLiveTaskRoot,
  writeLiveTaskRoot,
} from "../../../src/harness/session-roots.ts";
import type { LiveTaskRoot } from "../../../src/harness/session-roots.ts";

import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

// -- helpers -----------------------------------------------------------------

/**
 * Narrow a receipt to its `execution_failed` variant and return the
 * model-visible failure label. Keeps the `kind` assertion these tests already
 * made — TypeScript cannot narrow through `expect().toBe()`.
 */
function failureMessage(result: ToolExecutionResult | undefined): string {
  expect(result?.kind).toBe("execution_failed");
  if (result?.kind !== "execution_failed") {
    throw new Error(`expected an execution_failed result, got ${result?.kind}`);
  }
  return result.message;
}

/** Fake inner executor: records executeAll invocations. */
function fakeInner(): {
  readonly inner: Executor;
  readonly invocations: ReadonlyArray<{
    calls: ReadonlyArray<ToolCall>;
    conversationId: string | undefined;
  }>;
} {
  const invocations: {
    calls: ReadonlyArray<ToolCall>;
    conversationId: string | undefined;
  }[] = [];
  const inner: Executor = {
    executeAll: async (
      batch,
      _signal,
      _timeoutMs,
      conversationId,
      onSettled,
      _turnId,
      _onStream
    ) => {
      invocations.push({ calls: batch, conversationId });
      const out: ToolExecutionResult[] = batch.map((c) => ({
        kind: "ok",
        toolUseId: c.id,
        payload: [{ type: "text", text: "ok" }],
      }));
      for (const [i, r] of out.entries()) await onSettled?.(r, i);
      return out;
    },
  };
  return { inner, invocations };
}

const writeCall = (id = "c1"): ToolCall => ({
  id,
  name: "write_file",
  input: { path: "hello.txt", content: "hi" },
});

const WORKTREE_ROOT = "/repo/.iknow/worktrees/conv-1";

/** Build a gate that snapshots liveTaskRoot at executeAll entry. */
function makeGate(opts: {
  readonly liveTaskRoot: LiveTaskRoot;
  readonly provision: (ctx: {
    conversationId?: string;
    root: string;
  }) => Promise<string>;
  readonly inner: Executor;
  readonly initiallyBound?: boolean;
}): Executor {
  return createWorktreeIsolationExecutor({
    enabled: { get: () => true },
    liveTaskRoot: opts.liveTaskRoot,
    provision: opts.provision,
    ...(opts.initiallyBound !== undefined
      ? { initiallyBound: opts.initiallyBound }
      : {}),
    inner: opts.inner,
  });
}

// ============================================================================
// RED → GREEN: gate reads live taskRoot, mutate after rebind lands in new tree
// ============================================================================

describe("T10 — gate reads live taskRoot (red→green of the original bug)", () => {
  it("after `create-worktree` flips the cell, the next wave's mutate lands in the new tree", async () => {
    // The live cell is initialised at the assembly-time sandboxRoot (main repo).
    const cell = createLiveTaskRoot("/main");
    const { inner, invocations } = fakeInner();
    let provisionCalls = 0;
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async ({ root }) => {
        provisionCalls += 1;
        // Simulate the host provision seam rebinding this conversation to
        // its task worktree (mirrors session-api worktree-rebind.ts).
        return root === "/main" ? WORKTREE_ROOT : root;
      },
      inner,
    });

    // 1) Initial wave on the main repo: unbound mutate blocks. State stays
    //    open; provision is NEVER called (model-provision contract).
    const blocked = await gate.executeAll([writeCall("m1")]);
    const blockedMessage = failureMessage(blocked[0]);
    expect(blockedMessage.startsWith(`${WORKTREE_ISOLATION_PREFIX} `)).toBe(
      true
    );
    expect(blockedMessage).toContain(CREATE_WORKTREE_TOOL_HINT);
    expect(provisionCalls).toBe(0); // never provisions on the blocked path
    expect(invocations).toHaveLength(0); // inner never reached

    // 2) Model calls `create-worktree` in the SAME run. The tool's
    //    handler calls `provision` (host seam), which updates the live cell
    //    via withLiveTaskRootWrite. We simulate that here by
    //    writing the new taskRoot into the cell directly.
    writeLiveTaskRoot(cell, WORKTREE_ROOT);

    // 3) Next wave: mutate is admitted (gate snapshots the live cell = new
    //    task worktree, sees the task-worktree-shaped root, calls provision
    //    which returns the same root, sets state bound + boundRoot=root
    //    → passthrough). Mutate reaches inner.
    const admitted = await gate.executeAll([writeCall("m2")]);
    expect(admitted[0]!.kind).toBe("ok");
    expect(provisionCalls).toBe(1); // provision invoked once for adjudication
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.calls[0]!.id).toBe("m2");
  });

  it("without rebind the gate still blocks every mutate (fail-closed, unchanged behaviour)", async () => {
    // Cell stays at the main repo root for the entire test — never written.
    const cell = createLiveTaskRoot("/main");
    const { inner, invocations } = fakeInner();
    let provisionCalls = 0;
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async () => {
        provisionCalls += 1;
        return WORKTREE_ROOT;
      },
      inner,
    });

    for (const id of ["m1", "m2", "m3"]) {
      const out = await gate.executeAll([writeCall(id)]);
      expect(failureMessage(out[0])).toContain(CREATE_WORKTREE_TOOL_HINT);
    }
    expect(provisionCalls).toBe(0); // never provisions
    expect(invocations).toHaveLength(0); // inner never reached
  });
});

// ============================================================================
// D2 — batch snapshot: one wave = one root, mid-wave rebind does NOT split it
// ============================================================================

describe("T10 — D2 batch snapshot (one wave = one root)", () => {
  it("a wave that contains both create-worktree and a mutate uses the OLD root for the mutate (no half-write to two trees)", async () => {
    // The wave snapshot is taken at executeAll entry. Even though
    // create-worktree updates the cell mid-wave, the mutate that follows
    // in the same wave is still adjudicated against the old root (D2). This
    // is the "one wave = one root" invariant: a single logical change cannot
    // get split across two trees.
    const cell = createLiveTaskRoot("/main");

    // Instrument a fake inner that flips the cell mid-wave when it sees
    // create-worktree. This is the same effect the production handler
    // would have via withLiveTaskRootWrite(provision, cell), but we trigger
    // it directly so the test exercises only the gate's snapshot logic.
    const recorded: Array<{ calls: ReadonlyArray<ToolCall> }> = [];
    const flippingInner: Executor = {
      executeAll: async (batch) => {
        recorded.push({ calls: batch });
        for (const c of batch) {
          if (c.name === "create-worktree") {
            writeLiveTaskRoot(cell, WORKTREE_ROOT);
          }
        }
        return batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: "ok" }],
        }));
      },
    };

    let provisionCalls = 0;
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async () => {
        provisionCalls += 1;
        return WORKTREE_ROOT;
      },
      inner: flippingInner,
    });

    // Wave: [create-worktree (classified "read" → bypasses gate,
    // reaches inner directly), write_file (classified "mutate" → gateMutate)].
    const calls: ToolCall[] = [
      { id: "ctw", name: "create-worktree", input: {} },
      writeCall("w1"),
    ];
    const out = await gate.executeAll(calls);

    // create-worktree goes through (it is classified as "read" by the
    // gate, so it reaches inner directly and is allowed even on the main repo).
    expect(out[0]!.kind).toBe("ok");
    // write_file is adjudicated against the OLD snapshot ("/main") and
    // blocked — because the wave started with the cell at "/main", even
    // though the cell now reads the new task worktree, the snapshot is
    // already taken and the wave is locked to one root.
    expect(out[1]!.kind).toBe("execution_failed");
    expect(failureMessage(out[1])).toContain(CREATE_WORKTREE_TOOL_HINT);

    // D2 evidence: the gate did NOT invoke provision — the gate's snapshot
    // was "/main" (not task-worktree-shaped), so the mutate went straight to
    // block without ever calling the seam. The cell flip is a mid-wave
    // side effect, but the gate's snapshot already captured the pre-flip
    // value. The rebind takes effect on the NEXT wave.
    expect(provisionCalls).toBe(0);
    // create-worktree reached inner; write_file did NOT.
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.calls[0]!.id).toBe("ctw");
  });

  it("consecutive waves observe the rebind from the next wave onward", async () => {
    // Wave 1: mutate blocks (cell at /main).
    // Rebind: writeLiveTaskRoot(cell, WORKTREE_ROOT).
    // Wave 2: mutate is admitted (cell at WORKTREE_ROOT).
    // The state boundRoot follows the cell, so the gate's snapshot in wave 2
    // is the worktree root and the mutate passes.
    const cell = createLiveTaskRoot("/main");
    const { inner, invocations } = fakeInner();
    let provisionCalls = 0;
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async ({ root }) => {
        provisionCalls += 1;
        return root === "/main" ? WORKTREE_ROOT : root;
      },
      inner,
    });

    const w1 = await gate.executeAll([writeCall("w1")]);
    expect(w1[0]!.kind).toBe("execution_failed");
    expect(provisionCalls).toBe(0);

    writeLiveTaskRoot(cell, WORKTREE_ROOT);

    const w2 = await gate.executeAll([writeCall("w2")]);
    expect(w2[0]!.kind).toBe("ok");
    expect(provisionCalls).toBe(1);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.calls[0]!.id).toBe("w2");
  });
});

// ============================================================================
// D11 — admit-but-write-old-root: gate adjudication root == consumer root
// ============================================================================

describe("T10 — D11 invariant (gate adjudication root == consumer handler root)", () => {
  it("the consumer's handler observes the SAME root as the gate's snapshot", async () => {
    // We pin the invariant by recording the root the consumer SEES via a
    // call-time read of liveTaskRoot. The gate's snapshot is the wave-entry
    // read; the handler's read happens during inner.executeAll. Because
    // executeAll is sequential within a single wave (the gate awaits each
    // inner call before iterating to the next), there is no opportunity for
    // a mid-wave flip — the only tool that flips the cell is
    // create-worktree, and when it appears with a mutate in the same
    // wave the gate's snapshot is the OLD root (D2), so the consumer also
    // sees the OLD root from its call-time read (no flip happened yet).
    const cell = createLiveTaskRoot("/main");
    const observedRootsAtCall: string[] = [];

    const recordingInner: Executor = {
      executeAll: async (batch) => {
        // Each call records the cell's value as the consumer would see it.
        // In production this is what write-file.ts:readRoot does at handler
        // call time (`opts.liveTaskRoot.read()` at handler invocation).
        const rootAtCall = cell.read();
        for (const _c of batch) observedRootsAtCall.push(rootAtCall);
        return batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: "ok" }],
        }));
      },
    };

    // Wave that already starts on the new task worktree (post-rebind).
    writeLiveTaskRoot(cell, WORKTREE_ROOT);
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async ({ root }) => root,
      inner: recordingInner,
    });

    const out = await gate.executeAll([writeCall("m1"), writeCall("m2")]);
    expect(out[0]!.kind).toBe("ok");
    expect(out[1]!.kind).toBe("ok");

    // D11 evidence: every consumer call observed the SAME root — the
    // worktree root — and the gate admitted every call. No consumer wrote
    // to a different root than the gate saw. There is no
    // admit-but-write-old-root window.
    expect(observedRootsAtCall).toEqual([WORKTREE_ROOT, WORKTREE_ROOT]);
  });
});

// ============================================================================
// Root-flip lifecycle tools in a mixed wave
// ============================================================================

/**
 * The enter/exit lifecycle tools are executed through inner and their
 * handlers flip the live cell mid-wave (via the withLiveTaskRootWrite-wrapped
 * host seams). A mutate later in the SAME wave must NOT be adjudicated on the
 * wave-entry snapshot while its handler would consume the flipped cell —
 * that is the admit-but-write-other-root window D11 forbids. Fail-closed:
 * the mutate is blocked and must be re-issued in the next wave.
 */
describe("D11 — root-flip lifecycle tool flips the cell mid-wave: later mutates are blocked", () => {
  /** Inner executor mirroring production: an enter/exit-worktree call
   * reaches inner (lifecycle tools are not workspace mutates), and its
   * handler resolves the wrapped host seam, which flips the live cell. */
  function flippingRootInner(
    cell: LiveTaskRoot,
    flipTo: string
  ): {
    readonly inner: Executor;
    readonly reached: string[];
  } {
    const reached: string[] = [];
    const inner: Executor = {
      executeAll: async (batch) => {
        for (const c of batch) {
          reached.push(c.id);
          if (c.name === "exit-worktree" || c.name === "enter-worktree") {
            writeLiveTaskRoot(cell, flipTo);
          }
        }
        return batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: "ok" }],
        }));
      },
    };
    return { inner, reached };
  }

  it("[exit-worktree, write_file] same wave: write_file is blocked (never written to the flipped main-repo root)", async () => {
    // Session bound on its task worktree; the wave starts with the cell at
    // WORKTREE_ROOT (that is the gate's snapshot) and the exit handler flips
    // it to the main repo mid-wave.
    const cell = createLiveTaskRoot(WORKTREE_ROOT);
    const { inner, reached } = flippingRootInner(cell, "/main");
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async ({ root }) => root,
      inner,
    });

    const out = await gate.executeAll([
      { id: "exit-1", name: "exit-worktree", input: {} },
      writeCall("w1"),
    ]);

    // exit executed and flipped the cell mid-wave
    expect(out[0]!.kind).toBe("ok");
    expect(cell.read()).toBe("/main");
    // the mutate is fail-closed blocked, never written to the flipped root
    const reboundMessage = failureMessage(out[1]);
    expect(reboundMessage).toContain(WORKTREE_ISOLATION_PREFIX);
    // the block message points at re-issuing in the next wave of this run
    expect(reboundMessage).toContain("next wave of tool calls in this run");
    // D11 evidence: write_file never reached a handler after the flip
    expect(reached).toEqual(["exit-1"]);
  });

  it("[enter-worktree, write_file] same wave: write_file is blocked (never written to the entered foreign tree)", async () => {
    // Session bound on its own tree; enter adopts another conversation's
    // tree mid-wave (the wrapped enter seam flips the cell to OTHER_TREE).
    const cell = createLiveTaskRoot(WORKTREE_ROOT);
    const { inner, reached } = flippingRootInner(
      cell,
      "/repo/.iknow/worktrees/conv-2"
    );
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async ({ root }) => root,
      inner,
    });

    const out = await gate.executeAll([
      {
        id: "enter-1",
        name: "enter-worktree",
        input: { conversationId: "conv-2" },
      },
      writeCall("w1"),
    ]);

    expect(out[0]!.kind).toBe("ok");
    expect(cell.read()).toBe("/repo/.iknow/worktrees/conv-2");
    const reboundMessage = failureMessage(out[1]);
    expect(reboundMessage).toContain(WORKTREE_ISOLATION_PREFIX);
    expect(reached).toEqual(["enter-1"]);
  });

  it("a mutate BEFORE the root-flip call in the same wave is still adjudicated on the wave snapshot (ordering preserved)", async () => {
    // [write_file, exit-worktree]: the mutate executes first against the
    // wave-entry snapshot (== the cell value at its call time), then the exit
    // flips. No window — the pre-flip adjudication matches the pre-flip write.
    const cell = createLiveTaskRoot(WORKTREE_ROOT);
    const { inner, reached } = flippingRootInner(cell, "/main");
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async ({ root }) => root,
      inner,
    });

    const out = await gate.executeAll([
      writeCall("w1"),
      { id: "exit-1", name: "exit-worktree", input: {} },
    ]);

    expect(out[0]!.kind).toBe("ok");
    expect(out[1]!.kind).toBe("ok");
    expect(reached).toEqual(["w1", "exit-1"]);
  });

  it("a wave with only lifecycle + read calls still bypasses the gate (unchanged behaviour)", async () => {
    const cell = createLiveTaskRoot(WORKTREE_ROOT);
    const { inner, reached } = flippingRootInner(cell, "/main");
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async ({ root }) => root,
      inner,
    });

    const out = await gate.executeAll([
      { id: "exit-1", name: "exit-worktree", input: {} },
      { id: "r1", name: "read_file", input: { path: "a.txt" } },
    ]);

    expect(out[0]!.kind).toBe("ok");
    expect(out[1]!.kind).toBe("ok");
    expect(reached).toEqual(["exit-1", "r1"]);
    expect(cell.read()).toBe("/main");
  });
});

// ============================================================================
// initiallyBound — pre-rebound engines with liveTaskRoot initialised to the
// task worktree behave identically to today (D3 stable, byte-equivalent).
// ============================================================================

describe("T10 — initiallyBound with liveTaskRoot initialised at the worktree", () => {
  it("engine pre-rebound to its task worktree: mutate passes through without further provision", async () => {
    // Same shape as the test "engine rooted at a task-worktree-shaped root
    // (rebound engine)" — uses the liveTaskRoot API and asserts identical
    // passthrough semantics.
    const cell = createLiveTaskRoot(WORKTREE_ROOT);
    const { inner, invocations } = fakeInner();
    let provisionCalls = 0;
    const gate = makeGate({
      liveTaskRoot: cell,
      provision: async () => {
        provisionCalls += 1;
        return WORKTREE_ROOT;
      },
      initiallyBound: true,
      inner,
    });

    const out = await gate.executeAll([writeCall("m1")]);
    expect(out[0]!.kind).toBe("ok");
    expect(provisionCalls).toBe(0); // bound already → no adjudication call
    expect(invocations).toHaveLength(1);
  });
});
