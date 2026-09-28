/**
 * chat-session verify-loop userText = `goal.text ?? query`.
 *
 * The taskFocus segment was removed from the consumer side: taskFocus is a
 * stable focus anchor (unchanged after the first seed), so feeding it into every
 * verify round would let a stale focus mask a new task and mis-judge it as PASS.
 * The data-side three-segment formula (`goal ?? taskFocus ?? query`) is
 * unaffected —— see tests/session-api/goal-seam.test.ts.
 *
 * The equivalent hub-side wiring is already covered by
 * `tests/session-api/goal-seam.test.ts`; this file guards the chat side.
 * chat-session reads session state through `ctx.checkpointStore.load(
 * conversationId)` (same read-from-disk pattern as `goalStatus` / `goalClear` /
 * `goalPin`) and applies `goal.text ?? query` to the verify-loop userText field
 * (only consumed when verifyConfig is present).
 *
 * Mock seam: `vi.mock("../../src/harness/verify/index.ts")` replaces
 * `runVerifyLoop` and captures the entry opts to read userText (same mock
 * pattern as tests/session-api/goal-seam.test.ts). A real SessionStore on a
 * tmpdir (typed-error contract as in production), a real conversationId, and a
 * stub model via makeDeps (no bwrap / no sandbox dependency).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub runVerifyLoop BEFORE importing chat-session. vi.mock is hoisted, so
// the captured state must live in vi.hoisted.
const { runVerifyLoopMock, getLastVerifyLoopOpts } = vi.hoisted(() => {
  let lastOpts: unknown = undefined;
  const fn = vi.fn(async (opts: unknown) => {
    lastOpts = opts;
    const o = opts as {
      runFn: (
        text: string,
        o?: unknown
      ) => Promise<{
        result: {
          readonly finalText: string | null;
          readonly messages: ReadonlyArray<unknown>;
          readonly turnCount: number;
          readonly stopReason: "completed" | "maxTurns" | "cancelled";
          readonly lastUsage: null;
        };
        trace: unknown;
      }>;
    };
    const r = await o.runFn("ignored-then-overridden-by-userText", {});
    return {
      result: r.result,
      trace: r.trace,
      rounds: 0,
      enabled: true,
      outcome: "passed",
      records: [],
    };
  });
  return {
    runVerifyLoopMock: fn,
    getLastVerifyLoopOpts: () => lastOpts,
  };
});

vi.mock("../../src/harness/verify/index.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/harness/verify/index.ts")
  >("../../src/harness/verify/index.ts");
  return {
    ...actual,
    runVerifyLoop: runVerifyLoopMock,
  };
});

import {
  processChatLine,
  type ChatLineContext,
} from "../../src/cli/chat-session.ts";
import {
  CURRENT_SCHEMA_VERSION,
  pinGoal,
  SessionStore,
  type GoalState,
  type SessionFileV1,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import { ensureMainSessionFenceTmpForConversation } from "../../src/harness/sandbox/fence-tmp.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";

/** Legacy on-disk shape —— its runtime type was retired; we pass this through
 *  the `as SessionFileV1` cast below to exercise the sanitize-drop path
 *  (assertion: the legacy taskFocus key disappears on load). */
interface LegacyTaskFocusState {
  text: string;
  updatedAt: string;
  history?: ReadonlyArray<{ text: string; updatedAt: string }>;
}

let baseDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-chat-usertext-"));
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

async function seedSession(opts: {
  readonly id: string;
  readonly goal?: GoalState;
  readonly taskFocus?: LegacyTaskFocusState;
}): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    title: "",
    cwd: process.cwd(),
    sanitized_at: now,
    checkpoints: [],
  } satisfies Omit<SessionFileV1, "goal" | "taskFocus">;
  await store.save({
    id: opts.id,
    file:
      opts.goal !== undefined || opts.taskFocus !== undefined
        ? ({
            ...base,
            ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
            ...(opts.taskFocus !== undefined
              ? { taskFocus: opts.taskFocus }
              : {}),
          } as SessionFileV1)
        : (base as SessionFileV1),
  });
}

interface MakeChatCtxOpts {
  readonly id: string;
  readonly verifyConfig?: VerifyConfig;
  readonly withStore?: boolean;
  /** When true, verifyConfig is not assembled (processChatLine takes its bare
   *  runHarness branch). */
  readonly withoutVerifyConfig?: boolean;
}

function makeChatCtx(opts: MakeChatCtxOpts): ChatLineContext {
  const ctx = makeCtx({
    responses: [assistantResult({ texts: ["ok"] })],
    stateOverrides: { conversationId: opts.id },
    ...(opts.withStore !== false ? { checkpointStore: store } : {}),
  });
  if (opts.withoutVerifyConfig === true) {
    return ctx; // verifyConfig absent → the runVerifyLoop branch is unreachable
  }
  // verifyConfig present by default (runVerifyLoop gets called).
  const verifyConfig: VerifyConfig = opts.verifyConfig ?? {
    command: "/bin/true",
  };
  return {
    ...ctx,
    verifyConfig,
  };
}

function capturedUserText(): string {
  const opts = getLastVerifyLoopOpts() as { userText?: unknown } | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  assert.equal(
    typeof opts.userText,
    "string",
    `expected string userText, got ${typeof opts.userText}`
  );
  return opts.userText as string;
}

function capturedCompletionMode(): unknown {
  const opts = getLastVerifyLoopOpts() as
    { completionMode?: unknown } | undefined;
  assert.ok(opts !== undefined, "runVerifyLoop was not called");
  return opts.completionMode;
}

describe("chat-session verify-loop seam: HITL vs auto dispatch (plan T1)", () => {
  it("session without goal/taskFocus → userText === query and HITL skip judge", async () => {
    const id = "chat-no-goal-baseline";
    // Not seeded —— store.load throws not_found inside resolveVerifyUserText.
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "build it", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "build it");
    assert.equal(capturedCompletionMode(), "hitl");
  });

  it("goal absent + taskFocus present → userText === query (taskFocus 不遮蔽当前 query, #473)", async () => {
    const id = "chat-taskfocus-binds";
    await seedSession({
      id,
      taskFocus: {
        text: "TF: chat-session implements three-segment",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal 缺席 + taskFocus 在场 → chat 端 userText 应取当前 query (taskFocus 不进 verify 输入, #473)"
    );
    assert.equal(capturedCompletionMode(), "hitl");
  });

  it("goal.text === '' + taskFocus present → userText === query (空 goal 按缺席算 → 兜底 query, #473)", async () => {
    const id = "chat-empty-goal-taskfocus";
    await seedSession({
      id,
      goal: {
        text: "",
        source: "user_pin",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
      taskFocus: {
        text: "TF chat takes over",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "Q",
      "goal.text === '' 跳过第一段 → 兜底 query (taskFocus 不进 verify 输入, #473)"
    );
  });

  it("goal present + taskFocus present → userText === goal.text (第一段优先, 与 hub 同纪律)", async () => {
    const id = "chat-both-present";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "G dominates chat",
        now: "2026-01-01T00:00:00.000Z",
      }),
      taskFocus: {
        text: "TF subordinate chat",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "G dominates chat");
    assert.equal(capturedCompletionMode(), "auto");
  });

  it("taskFocus.text === '' → userText === query (空 taskFocus 按缺席算)", async () => {
    const id = "chat-empty-taskfocus";
    await seedSession({
      id,
      taskFocus: {
        text: "",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "Q");
  });

  it("user_pin goal alone → userText === goal.text (回归:既有 goal-pin 行为保持)", async () => {
    const id = "chat-goal-only";
    await seedSession({
      id,
      goal: pinGoal({
        current: undefined,
        text: "G: ship chat-side B8",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(capturedUserText(), "G: ship chat-side B8");
  });

  it("verifyConfig 缺席 → runVerifyLoop 不被调 (非 verify 路径不受影响, byte-identical to pre-#449)", async () => {
    const id = "chat-no-verify-config";
    await seedSession({
      id,
      taskFocus: {
        text: "TF should not bind without verifyConfig",
        updatedAt: "2026-01-01T00:00:00.000Z",
        history: [],
      },
    });
    // verifyConfig undefined → the runVerifyLoop branch is not entered,
    // the userText formula is unreachable —— it goes through plain runHarness(query, ...).
    const ctx = makeChatCtx({
      id,
      withoutVerifyConfig: true,
    });
    const r = await processChatLine({ line: "raw query", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).not.toHaveBeenCalled();
    // Nothing to assert while the fallback branch is not consumed —— the runHarness
    // path is independent of userText. Sanity placeholder: the call must still
    // report ranQuery (matching the baseline).
    assert.ok(r.output.length > 0);
  });

  it("checkpointStore 缺席 + conversationId 在场 → userText === query (ask / pipe 路径无 store, fail-open)", async () => {
    const id = "chat-no-store";
    // checkpointStore undefined (ask / pipe / tests assemble no store).
    const ctx = makeChatCtx({ id, withStore: false });
    const r = await processChatLine({ line: "fallback Q", ctx });
    assert.equal(r.ranQuery, true);
    expect(runVerifyLoopMock).toHaveBeenCalledTimes(1);
    assert.equal(
      capturedUserText(),
      "fallback Q",
      "store 缺席 → run uses query; HITL must not treat query as judge task"
    );
    assert.equal(capturedCompletionMode(), "hitl");
  });
});

/**
 * ADR-0092: chat's verify call site must pass the session tmp through into the
 * loop —— otherwise, in workspace mode, `$TMPDIR` is absent and the write
 * whitelist is the process tmpdir(), while the session tmp (inside the home
 * subtree) gets covered by `--ro-bind <home>`.
 *
 * Resolution must share one source with the bash tool surface:
 * `ctx.checkpointStore.getProjectDir()` + `state.conversationId` derive
 * `<projectDir>/<sanitized convId>/fence-tmp` via `resolveSessionFenceTmp`.
 */
describe("chat-session verify-loop seam: session tmp wiring (ADR-0092 SC12)", () => {
  it("tmpDir = <projectDir>/<convId>/fence-tmp（与 bash 面同一 helper）", async () => {
    const id = "chat-fence-tmp";
    const ctx = makeChatCtx({ id });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    const opts = getLastVerifyLoopOpts() as { tmpDir?: unknown } | undefined;
    assert.ok(opts !== undefined, "runVerifyLoop was not called");
    assert.equal(
      opts.tmpDir,
      ensureMainSessionFenceTmpForConversation(store.getProjectDir(), id),
      "tmpDir 必须是与 bash 面同源的会话 tmp 宿主真路径"
    );
  });

  it("checkpointStore 缺席 → 不产出 tmpDir key（verify-loop 回退进程 tmpdir）", async () => {
    const id = "chat-fence-tmp-no-store";
    const ctx = makeChatCtx({ id, withStore: false });
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    const opts = getLastVerifyLoopOpts() as { tmpDir?: unknown } | undefined;
    assert.ok(opts !== undefined, "runVerifyLoop was not called");
    assert.equal(
      "tmpDir" in opts,
      false,
      "store 缺席 → 解析不出会话 tmp → key 不出现（fallback 由 verify-loop 承担）"
    );
  });
});

describe("chat-session verify fence cwd is the SESSION root, not the process cwd", () => {
  // `makeDefaultRunVerify` feeds `opts.cwd` to BOTH the fence cwd and the
  // protected-target name-pattern SCAN SCOPE. The hub entry passes `boundRoot`
  // here; chat passed `process.cwd()`, so a session launched under
  // `--workspace-root` / a `.env` root made the verify fence enumerate a
  // DIFFERENT tree than the bash fence protects — two protection surfaces in
  // one session. Pinned on the discriminating case: the session root and the
  // process cwd are different values.
  it("threads ctx.workspaceRoot, not process.cwd()", async () => {
    const sessionRoot = await mkdtemp(
      join(tmpdir(), "iknow-chat-verify-root-")
    );
    const id = "chat-verify-cwd-session-root";
    const ctx: ChatLineContext = {
      ...makeChatCtx({ id }),
      workspaceRoot: sessionRoot,
    };
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    const opts = getLastVerifyLoopOpts() as { cwd?: unknown } | undefined;
    assert.ok(opts !== undefined, "runVerifyLoop was not called");
    assert.equal(
      opts.cwd,
      sessionRoot,
      "verify fence cwd / scan scope must be the session's bound root"
    );
    assert.notEqual(
      sessionRoot,
      process.cwd(),
      "fixture guard: the two roots must disagree for this test to discriminate"
    );
  });

  it("falls back to engineRoot when the assembly threaded no workspaceRoot", async () => {
    const engineRoot = await mkdtemp(
      join(tmpdir(), "iknow-chat-verify-engine-")
    );
    const id = "chat-verify-cwd-engine-root";
    const ctx: ChatLineContext = {
      ...makeChatCtx({ id }),
      engineRoot,
    };
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    const opts = getLastVerifyLoopOpts() as { cwd?: unknown } | undefined;
    assert.ok(opts !== undefined, "runVerifyLoop was not called");
    assert.equal(opts.cwd, engineRoot);
  });

  it("prefers engineRoot (the live root) over the assembly-time workspaceRoot", async () => {
    // A worktree rebind rewrites `engineRoot` at the switch point; the
    // assembly-time `workspaceRoot` still names the pre-rebind root. The
    // verify fence must follow the LIVE root, or a rebound session's verify
    // would enumerate the tree it just left.
    const assemblyRoot = await mkdtemp(
      join(tmpdir(), "iknow-chat-verify-assembly-")
    );
    const liveRoot = await mkdtemp(join(tmpdir(), "iknow-chat-verify-live-"));
    const id = "chat-verify-cwd-rebind";
    const ctx: ChatLineContext = {
      ...makeChatCtx({ id }),
      workspaceRoot: assemblyRoot,
      engineRoot: liveRoot,
    };
    const r = await processChatLine({ line: "Q", ctx });
    assert.equal(r.ranQuery, true);
    const opts = getLastVerifyLoopOpts() as { cwd?: unknown } | undefined;
    assert.ok(opts !== undefined, "runVerifyLoop was not called");
    assert.equal(opts.cwd, liveRoot);
  });
});
