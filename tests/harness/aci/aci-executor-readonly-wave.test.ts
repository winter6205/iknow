/**
 * ACI executor — the READ-ONLY BASH wave (per-call concurrency safety, #D2).
 *
 * The bash tool declares `aci.isConcurrencySafeForInput`: a per-call predicate
 * that answers whether THIS call may share a wave with its neighbours. The
 * tool-level flag stays `false` (most bash calls mutate the filesystem), so
 * the predicate is the only thing that can put a bash call into a wave.
 *
 * What this file authenticates, with the REAL bash tool definition driving the
 * decision (its `aci` metadata carries the predicate):
 *   - five read-only bash calls share ONE wave;
 *   - a read-only bash call joins a wave of read-only stub tools;
 *   - every write form gets its OWN wave and pulls no neighbour into it;
 *   - a write between two read-only calls splits the wave in three;
 *   - the settled results keep the INPUT order.
 *
 * NOTE on the observation: the permission runtime calls `inner.executeAll([call])`
 * per CALL (ADR-0147's two-stage wave gate runs one call at a time through
 * inner), so the inner executor's batch sizes cannot show a wave. The wave is
 * observed the way it is actually observable — the calls of one wave START
 * CONCURRENTLY: a call that starts before the previous wave's last call
 * finished belongs to the same wave. The group derivation below is the same
 * rule the sibling suite (`aci-executor-per-call-concurrency.test.ts`) uses.
 *
 * The bash tool's HANDLER never runs here: the stub inner executor intercepts
 * every call, so no sandbox and no bwrap are needed. The tool is built with
 * the fence retired, which also makes the factory skip its construction-time
 * bwrap probe.
 *
 * The permission policy allows bash (`defaultRule: "allow"`): an "ask" verdict
 * moves the call to the executor's approval stage, which runs ONE AT A TIME by
 * design — the wave's concurrency lives in the "allow" stage, and it is the
 * stage this file observes.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createPermissionPolicy } from "../../../src/harness/aci/permission.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import type { AciCatalog, AciToolDef } from "../../../src/harness/aci/types.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

/* ---------------------------------------------------------------------------
 * helpers
 * ------------------------------------------------------------------------- */

/** One recorded inner execution: when the call entered and left the inner. */
interface Interval {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

interface Recorder {
  readonly executor: Executor;
  readonly intervals: Map<string, Interval>;
}

/**
 * Recording executor: logs the start/end of every call's inner execution.
 * The per-call sleep keeps the execution windows open long enough for the
 * concurrent starts of one wave to be observable.
 */
function makeRecordingExecutor(sleepMs = 20): Recorder {
  const intervals = new Map<string, Interval>();
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const results: ToolExecutionResult[] = [];
      for (const c of batch) {
        const start = Date.now();
        await new Promise((r) => setTimeout(r, sleepMs));
        const end = Date.now();
        intervals.set(c.id, { id: c.id, start, end });
        results.push({
          kind: "ok",
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: `done:${c.name}` }],
        });
      }
      return results;
    },
  });
  return { executor, intervals };
}

/**
 * The wave structure the executor produced, derived from the inner intervals:
 * a call belongs to the previous group when it STARTED before that group's
 * last call FINISHED (a concurrent start = the same wave).
 */
function concurrencyGroups(
  recorder: Recorder,
  ids: readonly string[]
): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let currentEnd = -1;
  for (const id of ids) {
    const interval = recorder.intervals.get(id);
    assert.ok(
      interval !== undefined,
      `call ${id} never reached the inner executor`
    );
    if (current.length > 0 && interval.start < currentEnd) {
      current.push(id);
      currentEnd = Math.max(currentEnd, interval.end);
      continue;
    }
    if (current.length > 0) groups.push(current);
    current = [id];
    currentEnd = interval.end;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function makeCatalog(tools: AciToolDef[]): AciCatalog {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (n: string) => byName.get(n),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

function makeLatch(): { readonly promise: Promise<void>; release(): void } {
  let releasePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    releasePromise = resolve;
  });
  return { promise, release: () => releasePromise() };
}

function makeLatchedExecutor(
  gatedCallId: string,
  gate: Promise<void>,
  onStart: (id: string) => void
): Executor {
  return Object.freeze({
    executeAll: async (batch: ReadonlyArray<ToolCall>) => {
      assert.equal(batch.length, 1);
      const call = batch[0]!;
      onStart(call.id);
      if (call.id === gatedCallId) await gate;
      return [
        {
          kind: "ok" as const,
          toolUseId: call.id,
          payload: [{ type: "text" as const, text: `done:${call.name}` }],
        },
      ];
    },
  });
}

async function advanceExecutorTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A read-only stub tool: the static concurrency-safe flag, no predicate. */
function makeReadOnlyStubTool(name: string): AciToolDef {
  return Object.freeze({
    name,
    description: `read-only stub ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

/**
 * The REAL bash tool definition — its `aci` metadata is what drives the wave
 * split. The fence is retired so the factory skips its construction-time
 * bwrap probe; the handler never runs (the stub inner intercepts every call).
 */
function makeBashTool(): AciToolDef {
  return createBashTool(process.cwd(), { fenceRetired: { get: () => true } });
}

/** The policy under test: bash is allowed, so the calls start concurrently. */
function allowAllPolicy(): ReturnType<typeof createPermissionPolicy> {
  return createPermissionPolicy({ defaultRule: "allow" });
}

/** A bash call for the given command. */
function bashCall(id: string, command: string): ToolCall {
  return { id, name: "bash", input: { command } };
}

/* ---------------------------------------------------------------------------
 * tests
 * ------------------------------------------------------------------------- */

/** The five write forms, each with the reason it is not provably read-only. */
const WRITE_FORMS: ReadonlyArray<{
  readonly title: string;
  readonly command: string;
}> = Object.freeze([
  {
    title: "an output redirect (echo x > /tmp/a)",
    command: "echo x > /tmp/a",
  },
  {
    title: "a tee in the pipeline (cat a | tee b)",
    command: "cat a | tee b",
  },
  {
    title: "an output argument (curl -o f URL)",
    command: "curl -o f URL",
  },
  {
    title: "a chained write (git status && touch x)",
    command: "git status && touch x",
  },
  {
    title:
      "a command the readonly validator rejects for another reason (touch newfile)",
    command: "touch newfile",
  },
]);

describe("createAciExecutor — the read-only bash wave (#D2)", () => {
  it("starts literal-cd read-only calls in one wave before a held call settles", async () => {
    const gate = makeLatch();
    const gatedCallStarted = makeLatch();
    const startedIds: string[] = [];
    const inner = makeLatchedExecutor("cd-a", gate.promise, (id) => {
      startedIds.push(id);
      if (id === "cd-a") gatedCallStarted.release();
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: makeCatalog([makeBashTool()]),
      policy: allowAllPolicy(),
    });

    const execution = aciExec.executeAll([
      bashCall("cd-a", "cd /tmp && ls"),
      bashCall("cd-b", "cd /tmp && pwd"),
    ]);
    await gatedCallStarted.promise;
    await advanceExecutorTurn();
    const siblingStartedBeforeRelease = startedIds.includes("cd-b");
    gate.release();
    const results = await execution;

    assert.equal(siblingStartedBeforeRelease, true);
    assert.ok(results.every((result) => result.kind === "ok"));
  });

  it("keeps a cd chain with a write serial before the next read-only call", async () => {
    const gate = makeLatch();
    const gatedCallStarted = makeLatch();
    const startedIds: string[] = [];
    const inner = makeLatchedExecutor("write", gate.promise, (id) => {
      startedIds.push(id);
      if (id === "write") gatedCallStarted.release();
    });
    const aciExec = createAciExecutor({
      inner,
      catalog: makeCatalog([makeBashTool()]),
      policy: allowAllPolicy(),
    });

    const execution = aciExec.executeAll([
      bashCall("write", "cd /tmp && touch output.txt"),
      bashCall("read", "pwd"),
    ]);
    await gatedCallStarted.promise;
    await advanceExecutorTurn();
    const readStartedBeforeRelease = startedIds.includes("read");
    gate.release();
    const results = await execution;

    assert.equal(readStartedBeforeRelease, false);
    assert.deepEqual(startedIds, ["write", "read"]);
    assert.ok(results.every((result) => result.kind === "ok"));
  });

  it("5 read-only bash calls share ONE wave", async () => {
    const bash = makeBashTool();
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([bash]),
      policy: allowAllPolicy(),
    });

    const commands = [
      "pwd",
      "ls",
      "cat package.json",
      "git status",
      "ls src/harness",
    ];
    const ids = ["b0", "b1", "b2", "b3", "b4"];
    const results = await aciExec.executeAll(
      commands.map((command, i) => bashCall(ids[i]!, command))
    );

    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.kind === "ok"));
    // ONE wave of five: every call started before the previous one finished.
    assert.deepEqual(concurrencyGroups(recorder, ids), [
      ["b0", "b1", "b2", "b3", "b4"],
    ]);
    // The settled results keep the input order.
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ids
    );
  });

  it("[read_file, read-only bash, read_file] share ONE wave", async () => {
    const bash = makeBashTool();
    const readFile = makeReadOnlyStubTool("read_file");
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([bash, readFile]),
      policy: allowAllPolicy(),
    });

    const ids = ["f1", "b1", "f2"];
    const results = await aciExec.executeAll([
      { id: "f1", name: "read_file", input: { path: "a.ts" } },
      bashCall("b1", "cat package.json"),
      { id: "f2", name: "read_file", input: { path: "b.ts" } },
    ]);

    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.kind === "ok"));
    // ONE wave of three: the bash call joins its read-only neighbours.
    assert.deepEqual(concurrencyGroups(recorder, ids), [["f1", "b1", "f2"]]);
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ids
    );
  });

  it.each(WRITE_FORMS)(
    "$title gets its OWN wave: [read-only, write, read-only] → three groups",
    async ({ command }) => {
      const bash = makeBashTool();
      const recorder = makeRecordingExecutor();
      const aciExec = createAciExecutor({
        inner: recorder.executor,
        catalog: makeCatalog([bash]),
        policy: allowAllPolicy(),
      });

      const ids = ["ro1", "w", "ro2"];
      const results = await aciExec.executeAll([
        bashCall("ro1", "pwd"),
        bashCall("w", command),
        bashCall("ro2", "ls"),
      ]);

      assert.equal(results.length, 3);
      assert.ok(results.every((r) => r.kind === "ok"));
      // The write breaks the wave: it runs alone, and it pulls no read-only
      // neighbour into its own group.
      assert.deepEqual(concurrencyGroups(recorder, ids), [
        ["ro1"],
        ["w"],
        ["ro2"],
      ]);
      assert.deepEqual(
        results.map((r) => r.toolUseId),
        ids
      );
    }
  );

  it("all five write forms keep their own group, in input order", async () => {
    const bash = makeBashTool();
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([bash]),
      policy: allowAllPolicy(),
    });

    // [read-only, write, read-only, write, …] — every write is alone.
    const calls: ToolCall[] = [];
    const ids: string[] = [];
    WRITE_FORMS.forEach((form, i) => {
      calls.push(bashCall(`ro${i}`, "pwd"));
      ids.push(`ro${i}`);
      calls.push(bashCall(`w${i}`, form.command));
      ids.push(`w${i}`);
    });
    calls.push(bashCall("ro5", "ls"));
    ids.push("ro5");

    const results = await aciExec.executeAll(calls);

    assert.equal(results.length, ids.length);
    assert.ok(results.every((r) => r.kind === "ok"));
    assert.deepEqual(concurrencyGroups(recorder, ids), [
      ["ro0"],
      ["w0"],
      ["ro1"],
      ["w1"],
      ["ro2"],
      ["w2"],
      ["ro3"],
      ["w3"],
      ["ro4"],
      ["w4"],
      ["ro5"],
    ]);
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ids
    );
  });

  it("a write between two read-only calls splits the wave in three", async () => {
    const bash = makeBashTool();
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([bash]),
      policy: allowAllPolicy(),
    });

    const ids = ["ro1", "w", "ro2"];
    const results = await aciExec.executeAll([
      bashCall("ro1", "ls src/harness"),
      bashCall("w", "echo x > /tmp/a"),
      bashCall("ro2", "git status"),
    ]);

    assert.equal(results.length, 3);
    assert.ok(results.every((r) => r.kind === "ok"));
    // Three waves, none of them overlapping.
    assert.deepEqual(concurrencyGroups(recorder, ids), [
      ["ro1"],
      ["w"],
      ["ro2"],
    ]);
  });

  it("the settled results keep the input order even though the calls are concurrent", async () => {
    const bash = makeBashTool();
    const recorder = makeRecordingExecutor();
    const aciExec = createAciExecutor({
      inner: recorder.executor,
      catalog: makeCatalog([bash]),
      policy: allowAllPolicy(),
    });

    const ids = ["b0", "b1", "b2", "b3", "b4"];
    const results = await aciExec.executeAll(
      ["pwd", "ls", "cat package.json", "git status", "ls src/harness"].map(
        (command, i) => bashCall(ids[i]!, command)
      )
    );

    // The calls ran concurrently (one wave) …
    assert.deepEqual(concurrencyGroups(recorder, ids), [
      ["b0", "b1", "b2", "b3", "b4"],
    ]);
    // … and the executor settled them by wave index, not by completion order.
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ids
    );
  });
});
