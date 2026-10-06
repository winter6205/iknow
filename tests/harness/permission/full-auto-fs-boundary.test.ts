/**
 * ADR-0140 §1/§3 — `full_auto` is BOUNDED: inside what the current `fsMode`
 * permits it asks nothing, and outside it raises the product's existing `ask`
 * decision — once, about that one call.
 *
 * What this file is (and is not) responsible for:
 *   - The QUESTION half of class (c): the crossing raises exactly one `ask`,
 *     the answer decides that call, and the operator's `fsMode` holder is never
 *     written. The refusal arm when the answer is "no" is the fence's `[fs_denied]`
 *     channel (a sibling ticket) — what is proved here is the offline half:
 *     allow → the tool runs, deny → it does not.
 *   - Class (d) adds NO code: the construction-time `ask_inlet_missing` guard and
 *     the `askUser` catch are asserted, not reimplemented.
 *
 * The reader this suite wires is built from the REAL sandbox vocabulary
 * (`fsBoundarySnapshot` / `fsBoundaryIsActive` / `isWithinFsBoundary`) so the
 * seam is exercised against the one boundary derivation both layers must share.
 * The production wiring of that reader is proved separately in
 * `full-auto-fs-boundary-wiring.test.ts`.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, it } from "vitest";

import {
  checkPermission,
  createPermissionPolicy,
  type CheckPermissionInput,
  type FsBoundaryReader,
} from "../../../src/harness/permission/policy.js";
import { createPermissionModeContext } from "../../../src/harness/permission/modes.js";
import { createPermissionExecutor } from "../../../src/harness/permission/permission-executor.js";
import {
  fsBoundaryIsActive,
  fsBoundarySnapshot,
  isWithinFsBoundary,
} from "../../../src/harness/sandbox/fs-boundary.js";
import {
  createFsModeContext,
  type FsIsolationMode,
} from "../../../src/harness/sandbox/fs-mode.js";
import type {
  AciCategory,
  AciToolDef,
} from "../../../src/harness/aci/types.js";
import type { AskUser } from "../../../src/harness/permission/types.js";
import type {
  Executor,
  Registry,
  ToolCall,
  ToolDef,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.js";

/* ------------------------------------------------------------------ */
/* fixture                                                             */
/* ------------------------------------------------------------------ */

const root = realpathSync(mkdtempSync(join(tmpdir(), "full-auto-boundary-")));
/** The live `taskRoot` — the workspace tier's first writable root. */
const taskRoot = join(root, "repo");
/** This identity's session pad — the workspace tier's second writable root. */
const pad = join(root, "pool", "conv-1", "fence-tmp");
/** Writable under neither: home is `--ro-bind`, so no write may land here. */
const outside = join(root, "outside", "note.md");

mkdirSync(taskRoot, { recursive: true });
mkdirSync(pad, { recursive: true });
mkdirSync(join(root, "outside"), { recursive: true });

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * The reader the composition root builds: one snapshot per call, the tier read
 * from the holder, and the target resolved against the call's own cwd
 * (`taskRoot`) — the same base the write tools resolve against, so a relative
 * spelling is judged where it will land.
 */
function readerFor(mode: () => FsIsolationMode): FsBoundaryReader {
  return (target) => {
    const snapshot = fsBoundarySnapshot(
      { tmpDir: () => pad, mode: mode() },
      { workspaceRoot: taskRoot, tmpRoot: pad }
    );
    if (!fsBoundaryIsActive(snapshot)) return true;
    return isWithinFsBoundary(resolve(taskRoot, target), snapshot);
  };
}

/* ------------------------------------------------------------------ */
/* scaffolding                                                         */
/* ------------------------------------------------------------------ */

function makeAciTool(name: string, category: AciCategory): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior:
        category === "write" ? ("block" as const) : ("cancel" as const),
      timeoutTier: "default" as const,
    }),
  });
}

const WRITE = makeAciTool("edit_file", "write");
const READ = makeAciTool("read_file", "read-only");

function makeRegistry(defs: ReadonlyArray<AciToolDef>): Registry {
  const all: ToolDef[] = [...defs];
  return Object.freeze({
    list: () => all,
    get: (name: string) => all.find((t) => t.name === name),
  });
}

function makeInnerSpy(): { executor: Executor; calls: ToolCall[][] } {
  const calls: ToolCall[][] = [];
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      calls.push([...batch]);
      return batch.map((c) => ({
        kind: "ok" as const,
        toolUseId: c.id,
        payload: [{ type: "text" as const, text: `executed:${c.name}` }],
      }));
    },
  });
  return { executor, calls };
}

function outcomeOf(input: {
  readonly mode: "default" | "plan" | "full_auto";
  readonly def?: AciToolDef;
  readonly toolInput: unknown;
  readonly fsBoundary?: FsBoundaryReader;
}) {
  const policy = createPermissionPolicy({
    mode: createPermissionModeContext(input.mode),
  });
  const built: CheckPermissionInput = {
    def: input.def ?? WRITE,
    input: input.toolInput,
    sources: policy.sources,
    hardWalls: policy.hardWalls,
    defaultByCategory: policy.defaultByCategory,
    mode: policy.mode,
    ...(input.fsBoundary !== undefined ? { fsBoundary: input.fsBoundary } : {}),
  };
  return checkPermission(built);
}

/** Run one call through the real executor with a counting ask surface. */
async function runCall(input: {
  readonly mode: "default" | "plan" | "full_auto";
  readonly fsBoundary?: FsBoundaryReader;
  readonly def?: AciToolDef;
  readonly toolInput: unknown;
  readonly askUser?: AskUser;
  readonly defs?: ReadonlyArray<AciToolDef>;
}): Promise<{
  readonly result: ToolExecutionResult;
  readonly asked: number;
  readonly innerCalls: ToolCall[][];
}> {
  const asked = { n: 0 };
  const answer = input.askUser ?? (async () => true);
  const { executor: inner, calls } = makeInnerSpy();
  const policy = createPermissionPolicy({
    mode: createPermissionModeContext(input.mode),
    ...(input.fsBoundary !== undefined ? { fsBoundary: input.fsBoundary } : {}),
  });
  const def = input.def ?? WRITE;
  const ex = createPermissionExecutor({
    inner,
    registry: makeRegistry(input.defs ?? [def]),
    policy,
    askUser: async (ctx) => {
      asked.n += 1;
      return answer(ctx);
    },
  });
  const [result] = await ex.executeAll([
    { id: "call-1", name: def.name, input: input.toolInput },
  ]);
  return { result: result!, asked: asked.n, innerCalls: calls };
}

function messageOf(result: ToolExecutionResult): string {
  return result.kind === "execution_failed" ? result.message : "";
}

/* ------------------------------------------------------------------ */
/* (a) yolo / unbounded reach — no question                            */
/* ------------------------------------------------------------------ */

describe("(a) no boundary to attribute — full_auto asks nothing", () => {
  it("allows an out-of-workspace write with no question under an unbounded tier", async () => {
    // What yolo and the global tier have in common, expressed the only way the
    // permission layer can see it: there is no declared writable set, so there
    // is no edge to cross. The permission layer re-checks nothing about yolo.
    const { result, asked, innerCalls } = await runCall({
      mode: "full_auto",
      fsBoundary: readerFor(() => "global"),
      toolInput: { path: outside },
    });

    assert.equal(result.kind, "ok", messageOf(result));
    assert.equal(asked, 0, "an unbounded tier must raise no question");
    assert.equal(innerCalls.length, 1);
  });

  it("an assembly that wired no boundary is byte-identical to before", () => {
    const outcome = outcomeOf({
      mode: "full_auto",
      toolInput: { path: outside },
    });
    assert.equal(outcome.decision, "allow");
    assert.equal(outcome.reason, "mode: full_auto → allow (write)");
  });
});

/* ------------------------------------------------------------------ */
/* (b) inside the current tier's reach — unchanged in every mode       */
/* ------------------------------------------------------------------ */

describe("(b) a write INSIDE the current tier's reach is unchanged", () => {
  const inside = readerFor(() => "workspace");

  it("full_auto + inside → allow, no question", async () => {
    const { result, asked, innerCalls } = await runCall({
      mode: "full_auto",
      fsBoundary: inside,
      toolInput: { path: join(taskRoot, "sub", "deep", "file.ts") },
    });
    assert.equal(result.kind, "ok", messageOf(result));
    assert.equal(asked, 0);
    assert.equal(innerCalls.length, 1);
  });

  it("full_auto + inside via the session pad → allow (the pad is a reachable root)", () => {
    const outcome = outcomeOf({
      mode: "full_auto",
      fsBoundary: inside,
      toolInput: { path: join(pad, "scratch.md") },
    });
    assert.equal(outcome.decision, "allow");
  });

  it("a relative spelling is judged against the call's cwd, not the process cwd", () => {
    const outcome = outcomeOf({
      mode: "full_auto",
      fsBoundary: inside,
      toolInput: { path: "src/index.ts" },
    });
    assert.equal(
      outcome.decision,
      "allow",
      "src/index.ts resolves inside taskRoot"
    );
  });

  it("default + inside → the pre-existing category ask, unchanged", () => {
    const outcome = outcomeOf({
      mode: "default",
      fsBoundary: inside,
      toolInput: { path: join(taskRoot, "a.ts") },
    });
    assert.equal(outcome.reason, "category default: write → ask user");
  });

  it("plan + inside → the pre-existing plan deny, unchanged", () => {
    const outcome = outcomeOf({
      mode: "plan",
      fsBoundary: inside,
      toolInput: { path: join(taskRoot, "a.ts") },
    });
    assert.equal(outcome.decision, "deny");
    assert.equal(outcome.reason, "mode: plan blocks mutating tools (write)");
  });

  it("a read OUTSIDE the tier never asks (home is --ro-bind; reads are the fence's business)", () => {
    const outcome = outcomeOf({
      mode: "full_auto",
      def: READ,
      fsBoundary: inside,
      toolInput: { path: outside },
    });
    assert.equal(outcome.decision, "allow");
  });
});

/* ------------------------------------------------------------------ */
/* (c) outside — exactly ONE question, the answer decides the call    */
/* ------------------------------------------------------------------ */

describe("(c) a write OUTSIDE the tier asks exactly once", () => {
  const outsideReader = readerFor(() => "workspace");

  it("the outcome is `ask`, and it names the boundary rather than a passed scan", () => {
    const outcome = outcomeOf({
      mode: "full_auto",
      fsBoundary: outsideReader,
      toolInput: { path: outside },
    });
    assert.equal(outcome.decision, "ask");
    assert.match(outcome.reason, /full_auto/);
    assert.match(outcome.reason, /boundary/);
    assert.ok(
      !outcome.reason.includes("[hard_wall]") &&
        !outcome.reason.includes("scan"),
      "the ask must not claim a scan passed"
    );
  });

  it("answering yes → the tool runs, once", async () => {
    const { result, asked, innerCalls } = await runCall({
      mode: "full_auto",
      fsBoundary: outsideReader,
      toolInput: { path: outside },
    });
    assert.equal(asked, 1, "exactly one question");
    assert.equal(innerCalls.length, 1);
    assert.equal(result.kind, "ok", messageOf(result));
  });

  it("answering no → the tool does not run", async () => {
    const { result, asked, innerCalls } = await runCall({
      mode: "full_auto",
      fsBoundary: outsideReader,
      toolInput: { path: outside },
      askUser: async () => false,
    });
    assert.equal(asked, 1);
    assert.equal(
      innerCalls.length,
      0,
      "a declined boundary ask must not run the tool"
    );
    assert.equal(
      messageOf(result),
      "[user_denied] user declined tool call: edit_file"
    );
  });

  it("the fsMode holder is never written by the answer", async () => {
    const fsMode = createFsModeContext("workspace");
    await runCall({
      mode: "full_auto",
      fsBoundary: readerFor(() => fsMode.get()),
      toolInput: { path: outside },
      askUser: async () => true,
    });
    assert.equal(
      fsMode.get(),
      "workspace",
      "the answer decides the call, not the mode"
    );
  });
});

/* ------------------------------------------------------------------ */
/* (d) no ask surface / throwing ask surface → fail closed            */
/* ------------------------------------------------------------------ */

describe("(d) a degraded ask surface refuses — existing guards, no new code", () => {
  const outsideReader = readerFor(() => "workspace");

  it("no ask surface at all → construction throws ask_inlet_missing", () => {
    assert.throws(
      () =>
        createPermissionExecutor({
          inner: makeInnerSpy().executor,
          registry: makeRegistry([WRITE]),
          policy: createPermissionPolicy({
            mode: createPermissionModeContext("full_auto"),
            fsBoundary: outsideReader,
          }),
          // @ts-expect-error: intentional — the runtime guard is the subject
          askUser: undefined,
        }),
      /ask_inlet_missing/
    );
  });

  it("a throwing ask surface → user_denied, tool never runs", async () => {
    const { result, innerCalls } = await runCall({
      mode: "full_auto",
      fsBoundary: outsideReader,
      toolInput: { path: outside },
      askUser: async () => {
        throw new Error("approval inlet failed");
      },
    });
    assert.equal(innerCalls.length, 0);
    assert.equal(
      messageOf(result),
      "[user_denied] user declined tool call: edit_file"
    );
  });
});

/* ------------------------------------------------------------------ */
/* ADR-0140 §3 — no session memory                                    */
/* ------------------------------------------------------------------ */

describe("ADR-0140 §3 — the answer is NOT remembered (unlike the egress gate)", () => {
  it("the SAME out-of-boundary call asks AGAIN after a permissive answer", async () => {
    const fsBoundary = readerFor(() => "workspace");
    const asked: number[] = [];
    const askUser: AskUser = async () => {
      asked.push(Date.now());
      return true;
    };

    const first = await runCall({
      mode: "full_auto",
      fsBoundary,
      toolInput: { path: outside },
      askUser,
    });
    const second = await runCall({
      mode: "full_auto",
      fsBoundary,
      toolInput: { path: outside },
      askUser,
    });

    assert.equal(first.asked, 1);
    assert.equal(second.asked, 1, "a second crossing must ask again");
    assert.equal(asked.length, 2, "no answer may be memoized between calls");
    assert.equal(second.innerCalls.length, 1);
  });

  it("a permissive answer does not widen the fence for the NEXT call either", () => {
    // Same reader instance, same tier: the crossing is still a crossing.
    const fsBoundary = readerFor(() => "workspace");
    const outcome = outcomeOf({
      mode: "full_auto",
      fsBoundary,
      toolInput: { path: outside },
    });
    assert.equal(outcome.decision, "ask");
  });
});

/* ------------------------------------------------------------------ */
/* plan must stay unreachable by the question                          */
/* ------------------------------------------------------------------ */

describe("plan is not a route to the boundary question", () => {
  it("plan + a write outside the tier → deny, no question, plan's own reason", async () => {
    const { result, asked, innerCalls } = await runCall({
      mode: "plan",
      fsBoundary: readerFor(() => "workspace"),
      toolInput: { path: outside },
    });
    assert.equal(
      asked,
      0,
      "the boundary question must not reach a plan session"
    );
    assert.equal(innerCalls.length, 0);
    assert.equal(
      messageOf(result),
      "[permission_denied] mode: plan blocks mutating tools (write)"
    );
  });
});

/* ------------------------------------------------------------------ */
/* the narrowing point                                                */
/* ------------------------------------------------------------------ */

describe("the narrowing lives BELOW the pre-filters", () => {
  it("a hard-walled write is still denied, and never asked", () => {
    const outcome = outcomeOf({
      mode: "full_auto",
      fsBoundary: readerFor(() => "workspace"),
      toolInput: { path: "/home/u/.ssh/authorized_keys" },
    });
    assert.equal(outcome.decision, "deny");
    assert.match(outcome.reason, /hard_wall/);
  });
});
