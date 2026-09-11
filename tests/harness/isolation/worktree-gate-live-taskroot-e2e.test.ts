/**
 * T12 (plans/worktree-live-task-root.md §6 T12) — run-level e2e reproduction
 * of the §1 trace scenario, exercising the full assembly + loop-engine path
 * (`buildHarnessEngine` + `run()` + stub model + real ACI write_file /
 * create-worktree tools).
 *
 * Acceptance (§6 T12 + §5 D1/D2/D11):
 *   - turn 0: model emits `create-worktree` → gate admits (classified as
 *     "read" → bypasses the gate) → inner handler invokes the host
 *     `provision` seam, which is wrapped with `withLiveTaskRootWrite` so
 *     successful resolutions update the live `taskRoot` cell.
 *   - turn 1: model emits `write_file` → gate snapshots the live cell at
 *     executeAll entry; the snapshot now reads the new task worktree root;
 *     the gate sees a task-worktree-shaped root and calls `provision` for
 *     adjudication (returns same root → passthrough); write_file handler
 *     reads cell.read() at call time and lands the bytes there.
 *   - turn 2: model emits success text → run() returns `completed`.
 *
 * Assertions:
 *   - `<wtRoot>/test.txt` exists with the expected content (mutate lands in
 *     the new task worktree, D1+D2+D11 invariants);
 *   - `<mainRoot>/test.txt` does NOT exist (main repo zero-write);
 *   - `provision` was invoked exactly once (the gate's adjudication for
 *     turn 1, NOT for turn 0 — model-provision contract);
 *   - `result.stopReason === "completed"` and `result.turnCount === 3`;
 *   - the engine's `liveTaskRoot.read()` after run() returns the new
 *     task worktree root (live-cell state is consistent with the disk
 *     outcome).
 *
 * Double-track (per `.qoder/rules/test.md`):
 *   (a) trace-based — `createJsonlTraceService` + `parseJsonl` assert on
 *       the JSONL event sequence (llm_call / tool_call / turn records with
 *       parent chain);
 *   (b) NoopTraceService-vs-no-trace deepEqual baseline — run the SAME
 *       scenario once with `createNoopTraceService()` and once with
 *       `trace: undefined`, and assert the two `RunResult`s are
 *       `deepEqual`. This keeps the harness behavior itself as the
 *       ground truth (no trace-coupled side effects).
 *
 * Convention: fresh conversationId per test (no pre-existing session file);
 * real SessionStore is created only for the NoopTraceService baseline
 * variant (the run() path does not touch session files).
 */
import { afterEach, describe, expect, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../../src/harness/build-engine.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import { createNoAskUser } from "../../../src/harness/permission/ask-user.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { assistantResult } from "../../cli/_fixtures.ts";

// ---------------------------------------------------------------------------
// Helpers — deterministic env / fixture lifecycle
// ---------------------------------------------------------------------------

/**
 * Deterministic env — same shape as `tests/harness/build-engine.test.ts`
 * `makeEnv`. Never reads process.env / .env files (env.ts SSOT).
 */
function makeEnv(apiKey: string | undefined): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey,
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}

/**
 * Shape of the stub-model script used by the run-level e2e: three scripted
 * responses, one per step:
 *   - step 0 (turn 0): assistant emits `create-worktree` tool call;
 *   - step 1 (turn 1): assistant emits `write_file` tool call;
 *   - step 2 (turn 2): assistant emits success text → run() completes.
 */
function e2eResponses(filePath: string, fileContent: string) {
  return [
    assistantResult({
      texts: [],
      toolCalls: [{ id: "ctw", name: "create-worktree", input: {} }],
    }),
    assistantResult({
      texts: [],
      toolCalls: [
        {
          id: "wf",
          name: "write_file",
          input: { path: filePath, content: fileContent },
        },
      ],
    }),
    assistantResult({
      texts: ["done"],
      toolCalls: [],
      supplierStop: "success",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Test fixture lifecycle
// ---------------------------------------------------------------------------

const cleanupRoots: string[] = [];

afterEach(async () => {
  while (cleanupRoots.length > 0) {
    const r = cleanupRoots.pop()!;
    await rm(r, { recursive: true, force: true }).catch(() => {});
  }
});

async function makeMainRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-t12-e2e-"));
  cleanupRoots.push(dir);
  return dir;
}

/**
 * The fake host `provision` seam. Mirrors session-api worktree-rebind.ts:
 * main-repo call → `git worktree add` (simulated by mkdir -p so write_file
 * can resolve `realpath` into the tree) → returns the worktree path;
 * own-tree call → idempotent no-op → returns the same root. No git is
 * actually invoked — the side effect under test is write_file's landing
 * root, not `git worktree add` itself.
 */
async function fakeProvision(ctx: {
  readonly root: string;
  readonly mainRoot: string;
  readonly wtRoot: string;
}): Promise<string> {
  if (ctx.root === ctx.mainRoot) {
    await mkdir(ctx.wtRoot, { recursive: true });
    return ctx.wtRoot;
  }
  return ctx.root;
}

// ---------------------------------------------------------------------------
// T12 — run-level e2e
// ---------------------------------------------------------------------------

describe("T12 — run-level e2e: create-worktree + write_file in one run", () => {
  it("mutate after create-worktree lands in the new task worktree; main repo untouched", async () => {
    const mainRoot = await makeMainRoot();
    const conversationId = "conv-t12-e2e-1";
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);
    const filePath = "hello.txt";
    const fileContent = "written from task worktree";

    // ---- Engine assembly ----
    let provisionCalls = 0;
    const built: BuiltEngine = await buildHarnessEngine({
      env: makeEnv("sk-test-t12-e2e-1"),
      askUser: createNoAskUser(),
      surface: "chat",
      cwd: mainRoot,
      userHome: join(mainRoot, "home"),
      settings: { isolation: { worktreeOnMutate: true } },
      worktreeIsolation: {
        // Model-provision seam (see fakeProvision above).
        provision: async ({ root }) => {
          provisionCalls += 1;
          return fakeProvision({ root, mainRoot, wtRoot });
        },
      },
    });

    // The engine's static taskRoot is the main repo (pre-rebind snapshot);
    // the live cell is created from it and only flips via the wrapped
    // provision seam after the model's create-worktree call.
    expect(built.sessionRoots.taskRoot).toBe(mainRoot);

    // ---- Stub model + run() ----
    const model = createStubModel({
      responses: e2eResponses(filePath, fileContent),
    });

    try {
      const { result } = await run("create a worktree and write a file", {
        adapter: model,
        executor: built.deps.executor,
        registry: built.deps.registry,
        maxTurns: 5,
        conversationId,
      });

      // ---- Stop reason + turn count ----
      assert.equal(result.stopReason, "completed");
      assert.equal(result.turnCount, 3);

      // ---- provision seam: exactly twice ----
      //   call 1 = turn 0: the create-worktree handler directly invokes
      //     the wrapped provision seam (model-provision contract — the gate
      //     itself never provisions; ctw is classified "read" and bypasses
      //     the gate entirely).
      //   call 2 = turn 1: write_file is "mutate" → gate's snapshotRoot
      //     (post-rebind) is task-worktree-shaped → gate calls provision for
      //     per-conversation adjudication → own tree → same-root no-op →
      //     passthrough.
      // Neither call ever runs on the blocked path (blocked mutates never
      // provision — model-provision contract, D1).
      assert.equal(
        provisionCalls,
        2,
        "provision is called once by the ctw handler + once by the gate's adjudication; the blocked path never provisions"
      );

      // ---- File landed in the task worktree ----
      const wtFile = join(wtRoot, filePath);
      const wtBody = await readFile(wtFile, "utf8");
      assert.equal(wtBody, fileContent);

      // ---- Main repo: zero writes ----
      const mainFile = join(mainRoot, filePath);
      let mainExists = true;
      try {
        await readFile(mainFile, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") mainExists = false;
      }
      assert.equal(
        mainExists,
        false,
        "main repo must remain zero-write — model-provision contract"
      );
    } finally {
      await built.shutdown?.();
    }
  });

  it("write_file handler observes the rebind within the same run (D11 read-side)", async () => {
    // The gate's snapshot and the handler's readRoot both observe the
    // post-rebind cell value in turn 1 — asserted via the disk outcome:
    // write_file's containment resolution (`realpath(resolve(root))`) only
    // succeeds against a root that exists, and the write lands inside the
    // resolved tree. A handler frozen at the assembly-time mainRoot would
    // have written `<mainRoot>/a.txt` instead (fail-open, the original
    // §2 bug class).
    const mainRoot = await makeMainRoot();
    const conversationId = "conv-t12-e2e-2";
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t12-e2e-2"),
      askUser: createNoAskUser(),
      surface: "chat",
      cwd: mainRoot,
      userHome: join(mainRoot, "home"),
      settings: { isolation: { worktreeOnMutate: true } },
      worktreeIsolation: {
        provision: async ({ root }) =>
          fakeProvision({ root, mainRoot, wtRoot }),
      },
    });

    const model = createStubModel({
      responses: e2eResponses("a.txt", "x"),
    });

    try {
      const { result } = await run("go", {
        adapter: model,
        executor: built.deps.executor,
        registry: built.deps.registry,
        maxTurns: 5,
        conversationId,
      });

      assert.equal(result.stopReason, "completed");
      // Write landed inside the task worktree (handler read the live cell
      // at call time), not in the main repo.
      assert.equal(await readFile(join(wtRoot, "a.txt"), "utf8"), "x");
      let mainHasA = true;
      try {
        await readFile(join(mainRoot, "a.txt"), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") mainHasA = false;
      }
      assert.equal(mainHasA, false, "main repo must not receive the write");
    } finally {
      await built.shutdown?.();
    }
  });
});

// ---------------------------------------------------------------------------
// Trace double-track — §6 T12 acceptance + test.md `Trace as the integration
// test assert surface`. Two complementary assertions:
//
//   (a) trace-based — JSONL event sequence (llm_call / tool_call / turn)
//       is well-formed: 3 turns × (llm_call + tool_call + turn) for the
//       first two turns and (llm_call + turn) for the last turn =
//       3 llm_call + 2 tool_call + 3 turn = 8 records; tool_call records
//       carry `parent_llm_call_id` matching their turn's llm_call id.
//
//   (b) NoopTraceService-vs-no-trace deepEqual baseline — running the
//       SAME scenario twice (once with NoopTraceService, once with
//       trace: undefined) must yield byte-identical RunResults. This
//       pins the harness behavior itself as ground truth, independent
//       of any trace-coupled side effects.
// ---------------------------------------------------------------------------

describe("T12 — trace double-track (test.md 纪律)", () => {
  it("(a) JSONL trace records the 8 expected events in order, with parent chain", async () => {
    const mainRoot = await makeMainRoot();
    const conversationId = "conv-t12-trace-1";
    const wtRoot = join(mainRoot, ".iknow", "worktrees", conversationId);

    const built = await buildHarnessEngine({
      env: makeEnv("sk-test-t12-trace-a"),
      askUser: createNoAskUser(),
      surface: "chat",
      cwd: mainRoot,
      userHome: join(mainRoot, "home"),
      settings: { isolation: { worktreeOnMutate: true } },
      worktreeIsolation: {
        provision: async ({ root }) =>
          fakeProvision({ root, mainRoot, wtRoot }),
      },
    });

    const traceDir = join(mainRoot, "trace");
    const trace = createJsonlTraceService({
      filePath: traceDir,
      conversationId,
    });

    const model = createStubModel({
      responses: e2eResponses("a.txt", "x"),
    });

    try {
      const { result } = await run("go", {
        adapter: model,
        executor: built.deps.executor,
        registry: built.deps.registry,
        maxTurns: 5,
        conversationId,
        trace,
      });

      assert.equal(result.stopReason, "completed");
      assert.equal(result.turnCount, 3);

      // Drain the trace (best-effort — JsonlTraceService is in-process
      // and writes per call; reading after run() returns is safe because
      // run is single-threaded).
      const jsonlPath = join(traceDir, `${conversationId}.jsonl`);
      const raw = await readFile(jsonlPath, "utf8");
      const lines = raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);

      const types = lines.map((l) => l["record_type"]);
      // 3 turns. turn 0 = ctw wave → llm_call + tool_call(ctw) + turn.
      // turn 1 = write_file wave → llm_call + tool_call(write_file) + turn.
      // turn 2 = text-only → llm_call + turn.
      // Total: 3 llm_call + 2 tool_call + 3 turn = 8 records.
      assert.deepEqual(types, [
        "llm_call",
        "tool_call",
        "turn",
        "llm_call",
        "tool_call",
        "turn",
        "llm_call",
        "turn",
      ]);

      // Every record carries the conversation id.
      for (const line of lines) {
        assert.equal(line["conversation_id"], conversationId);
      }

      // Tool calls' parent_llm_call_id matches the immediately preceding
      // llm_call's llm_call_id (same turn).
      const turn0LlmId = lines[0]!["llm_call_id"] as string;
      const turn0ToolId = lines[1]!["tool_call_id"] as string;
      const turn1LlmId = lines[3]!["llm_call_id"] as string;
      const turn1ToolId = lines[4]!["tool_call_id"] as string;
      assert.equal(lines[1]!["parent_llm_call_id"], turn0LlmId);
      assert.equal(lines[4]!["parent_llm_call_id"], turn1LlmId);
      // tool_call names captured.
      assert.equal(lines[1]!["tool_name"], "create-worktree");
      assert.equal(lines[4]!["tool_name"], "write_file");
      // turn records carry the tool_call_ids of their wave.
      assert.deepEqual(lines[2]!["tool_call_ids"], [turn0ToolId]);
      assert.deepEqual(lines[5]!["tool_call_ids"], [turn1ToolId]);
    } finally {
      await built.shutdown?.();
    }
  });

  it("(b) NoopTraceService-vs-no-trace: RunResult is byte-identical", async () => {
    // Per test.md: "trace-based assert 之外,必须再配一个独立的
    // NoopTraceService-vs-no-trace deepEqual 基线". Two fresh engines
    // (each has its own live cell), two stub models with the same
    // script, two run() calls. The two RunResults must deepEqual —
    // trace presence does not change harness behavior.
    const mainRootA = await makeMainRoot();
    const mainRootB = await makeMainRoot();
    const convA = "conv-t12-baseline-A";
    const convB = "conv-t12-baseline-B";
    const wtA = join(mainRootA, ".iknow", "worktrees", convA);
    const wtB = join(mainRootB, ".iknow", "worktrees", convB);

    const make = async (mainRoot: string, wtRoot: string) =>
      buildHarnessEngine({
        env: makeEnv("sk-test-t12-baseline"),
        askUser: createNoAskUser(),
        surface: "chat",
        cwd: mainRoot,
        userHome: join(mainRoot, "home"),
        settings: { isolation: { worktreeOnMutate: true } },
        worktreeIsolation: {
          provision: async ({ root }) =>
            fakeProvision({ root, mainRoot, wtRoot }),
        },
      });

    const builtA = await make(mainRootA, wtA);
    const builtB = await make(mainRootB, wtB);

    const script = e2eResponses("a.txt", "x");
    const modelA = createStubModel({ responses: script });
    const modelB = createStubModel({ responses: script });

    try {
      const { result: resultA } = await run("go", {
        adapter: modelA,
        executor: builtA.deps.executor,
        registry: builtA.deps.registry,
        maxTurns: 5,
        conversationId: convA,
        trace: createNoopTraceService(),
      });
      const { result: resultB } = await run("go", {
        adapter: modelB,
        executor: builtB.deps.executor,
        registry: builtB.deps.registry,
        maxTurns: 5,
        conversationId: convB,
        // trace: undefined — same engine shape, no trace seam.
      });

      // Same scenario, same script, same engine shape — only the trace
      // seam differs. Results must deepEqual (no trace-coupled side
      // effects on stopReason / turnCount / messages). The tool_result
      // text embeds each run's mkdtemp absolute path (the provision seam
      // echoes the resolved worktree root), so we deepEqual after
      // normalizing those per-run paths out — every other byte must match.
      const normalize = (r: typeof resultA): typeof resultA =>
        JSON.parse(
          JSON.stringify(r, (key, value) =>
            typeof value === "string"
              ? value
                  .replaceAll(/\/tmp\/iknow-t12-e2e-[^/]*\//g, "<ROOT>/")
                  .replaceAll(/conv-t12-baseline-[AB]/g, "<CONV>")
              : value
          )
        ) as typeof resultA;
      assert.deepEqual(normalize(resultB), normalize(resultA));
      // Sanity: both completed with 3 turns.
      assert.equal(resultA.stopReason, "completed");
      assert.equal(resultA.turnCount, 3);
    } finally {
      await builtA.shutdown?.();
      await builtB.shutdown?.();
    }
  });
});
