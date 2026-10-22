/**
 * D1 — the permission verdict is taken in the WAVE SCAN, per wave; the
 * two-stage wave gate.
 *
 * Authenticates:
 *  - (a) each call's pure decision is evaluated exactly once; a call that goes
 *        through the approval path is decided once at the gate plus EXACTLY ONE
 *        re-decision before its prompt;
 *  - (b) a wave [allow, ask, allow] starts BOTH allow calls before the ask is
 *        answered, and the results stay in input order;
 *  - (c) an "always allow" answer — recorded the way the TUI records it, as a
 *        tool-scoped session grant — is honoured by the NEXT same-tool call:
 *        that call is not asked again;
 *  - (d) under the effective permission `full_auto` the single decision equals
 *        the enforcing verdict (allow, no prompt).
 *
 * The repair round adds the cases the review found unwitnessed:
 *  - (e) a MULTI-WAVE batch whose live permission mode changes between the
 *        waves: the later wave's verdict is taken in ITS wave's scan, not at
 *        the batch's plan time (the fail-open the review reproduced);
 *  - (f) at most one approval request is in flight at any moment, and the
 *        prompts follow the tool_use order;
 *  - (g) an inner execution that rejects while an approval is still pending
 *        does not kill the process, and the wave still delivers its results;
 *  - (h) the observer reports the scan's verdict, even when the enforced
 *        verdict comes from the re-decision ("always allow");
 *  - (i) the documented order inside a wave: each call's observer event, then
 *        its pre-hook — all of them before the wave's first prompt;
 *  - (j) the real yolo preset chain: preset → overlay → permission holder →
 *        decision (allow, no prompt);
 *  - (k) a DENIED call still rides along in its neighbours' wave (#653): the
 *        wave's shape rule is unchanged, only the moment the verdict is taken
 *        moved from the batch to the wave.
 *
 * The two review gaps this file still did not witness:
 *  - (l) the wave path keeps ADR-0127: a call carrying a security-review
 *        requirement is put to the review ROUTE and to nothing else — the
 *        ordinary approval inlet is never its answer;
 *  - (m) the same call with NO review route denies typed
 *        ([security_review_unavailable]) and still never asks the ordinary
 *        inlet;
 *  - (n) the onSettled contract: every result settles EXACTLY once, and the
 *        index it carries is the wave-relative INPUT index (0..n-1 across the
 *        waves);
 *  - (o) the inner-rejection scenario: the rejected call's slot settles
 *        exactly once, with an `execution_failed` result.
 *  - (p) the window ADR-0147 §10 names: a permission-mode change that lands
 *        while a wave's question is pending is NOT seen by that wave's
 *        already-started allowed calls (their verdicts were sampled in the
 *        wave's scan), while the NEXT wave samples it fresh. Pinned on
 *        purpose: the divergence is a sampling-time difference, fail-open by
 *        construction, and it must not drift silently.
 *  - (q) the settlement callback itself throws: the slot is settled exactly
 *        once, the call's own result is what was settled, and the callback's
 *        error travels out of `executeAll` instead of being turned into a
 *        fabricated `execution_failed` result (which would settle the slot a
 *        second time).
 *
 * The decision counter is NOT a mock: the policy's `check` seam delegates to
 * the real `checkPermission` and only records what it returned. The session
 * source counts the rule-layer reads — one per top-level decision that
 * reaches the rule layers — as a second, seam-independent witness.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import type {
  AciCatalog,
  AciCategory,
  AciToolDef,
} from "../../../src/harness/aci/types.ts";
import {
  checkPermission,
  createPermissionPolicy,
  type CheckPermissionInput,
  type PermissionPolicy,
} from "../../../src/harness/permission/policy.ts";
import {
  SECURITY_REVIEW_DENY_PREFIX,
  type SecurityReviewRequest,
  type SecurityReviewRoute,
} from "../../../src/harness/permission/security-review.ts";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.ts";
import {
  createPermissionModeContext,
  type PermissionMode,
  type PermissionModeContext,
} from "../../../src/harness/permission/modes.ts";
import type {
  AskUserOutcome,
  PermissionOutcome,
} from "../../../src/harness/permission/types.ts";
import type { HarnessStreamEvent } from "../../../src/harness/stream.ts";
import { createFsModeContext } from "../../../src/harness/sandbox/fs-mode.ts";
import { createPresetOverlay } from "../../../src/harness/sandbox/no-sandbox-marker.ts";
import {
  createYoloContext,
  createYoloController,
} from "../../../src/harness/sandbox/yolo.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../../../src/harness/tools/types.ts";

/* ---------------------------------------------------------------------------
 * helpers
 * ------------------------------------------------------------------------- */

function makeTool(
  name: string,
  category: AciCategory,
  opts?: { readonly isConcurrencySafe?: boolean }
): AciToolDef {
  return Object.freeze({
    name,
    description: `tool ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      // concurrency-safe by default, so one wave can hold [allow, ask, allow]
      // together; a non-safe tool is what splits a batch into several waves.
      isConcurrencySafe: opts?.isConcurrencySafe ?? true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    }),
  });
}

function makeCatalog(tools: ReadonlyArray<AciToolDef>): AciCatalog {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return Object.freeze({
    get: (name: string) => byName.get(name),
    all: () => Object.freeze([...tools]) as ReadonlyArray<AciToolDef>,
  });
}

/** Inner executor that records the order in which calls START. */
function makeRecordingExecutor(opts?: {
  readonly sleepMsById?: Record<string, number>;
  /** Ids whose inner execution REJECTS — the failure path of case (g). */
  readonly failIds?: ReadonlyArray<string>;
  /** Called when a call starts, before it settles. */
  readonly onStart?: (id: string) => void;
}): {
  readonly executor: Executor;
  readonly started: string[];
  readonly intervals: ReadonlyArray<{
    readonly id: string;
    readonly start: number;
    readonly end: number;
  }>;
} {
  const started: string[] = [];
  const intervals: Array<{
    readonly id: string;
    readonly start: number;
    readonly end: number;
  }> = [];
  const failIds = new Set(opts?.failIds ?? []);
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      const results: ToolExecutionResult[] = [];
      for (const c of batch) {
        started.push(c.id);
        opts?.onStart?.(c.id);
        const start = Date.now();
        if (failIds.has(c.id)) {
          throw new Error(`BOOM-inner-throw:${c.id}`);
        }
        const sleep = opts?.sleepMsById?.[c.id] ?? 0;
        if (sleep > 0) {
          await new Promise((r) => setTimeout(r, sleep));
        }
        intervals.push({ id: c.id, start, end: Date.now() });
        results.push({
          kind: "ok",
          toolUseId: c.id,
          payload: [{ type: "text", text: `done:${c.name}` }],
        });
      }
      return results;
    },
  });
  return { executor, started, intervals };
}

interface CountedDecision {
  readonly tool: string;
  readonly outcome: PermissionOutcome;
}

/**
 * A policy that COUNTS the pure decision evaluations.
 *
 * `policy.check` is the production seam: it delegates to the real
 * `checkPermission` and records what came back, so the count observes the
 * real decision instead of standing in for it. The session source counts the
 * rule-layer reads — one per top-level decision that reaches the rule layers
 * — as a second, seam-independent witness.
 */
function makeCountingPolicy(opts?: {
  readonly mode?: PermissionMode | PermissionModeContext;
  readonly session?: ReturnType<typeof createSessionGrants>;
}): {
  readonly policy: PermissionPolicy;
  readonly decisions: CountedDecision[];
  readonly layerReads: () => number;
} {
  const decisions: CountedDecision[] = [];
  const grants = opts?.session ?? createSessionGrants();
  let layerReads = 0;
  const base = createPermissionPolicy({
    ...(opts?.mode !== undefined ? { mode: opts.mode } : {}),
    session: {
      kind: "session" as const,
      rules: () => {
        layerReads += 1;
        return grants.rules();
      },
    },
  });
  const policy: PermissionPolicy = Object.freeze({
    ...base,
    check: (input: CheckPermissionInput): PermissionOutcome => {
      const outcome = checkPermission(input);
      decisions.push({ tool: input.def.name, outcome });
      return outcome;
    },
  });
  return { policy, decisions, layerReads: () => layerReads };
}

/**
 * A command the security-review scan cannot prove inert (ADR-0127): it
 * carries an `execution-unresolved` requirement, so the call that carries it
 * must be put to the review route.
 */
const REVIEW_COMMAND = "chroot /srv rm -rf /tmp/x";

/** One settlement observed through the executor's `onSettled` seam. */
interface Settled {
  readonly index: number;
  readonly kind: string;
  readonly toolUseId: string;
  readonly message: string | undefined;
}

/** Wait until a predicate holds — the async seam the prompt cases need. */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timeout while waiting for ${label}`);
}

/** Let the microtask queue and one timer turn pass. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

/**
 * Split a held call's message into its ending text and the R3 note line
 * every shown question appends (`undefined` when no note was appended).
 */
function splitApprovalLine(message: string): {
  readonly ending: string;
  readonly note: string | undefined;
} {
  const [ending = "", ...rest] = message.split("\n");
  return { ending, note: rest.length === 0 ? undefined : rest.join("\n") };
}

/* ---------------------------------------------------------------------------
 * tests
 * ------------------------------------------------------------------------- */

describe("D1 — 判定在闸门处当场作出 + 两段式波次闸门", () => {
  it("(a) 每次调用的纯判定只跑 1 次（allow 路径）", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    const { policy, decisions, layerReads } = makeCountingPolicy();
    const observed: Array<{ id: string; decision: string }> = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
      askUser: async () => true,
      // The observer reports the wave scan's verdict — the very verdict the
      // gate enforces, so the two cannot diverge.
      onDecision: (call, outcome) =>
        observed.push({ id: call.id, decision: outcome.decision }),
    });

    const results = await aciExec.executeAll([
      { id: "c1", name: "read_tool", input: {} },
      { id: "c2", name: "write_tool", input: { note: "n" } },
    ]);

    assert.equal(results.length, 2);
    // The seam-independent witness first: one top-level decision per call,
    // plus the single re-decision before the approval prompt.
    assert.equal(
      layerReads(),
      3,
      "three top-level decisions in total (1 for the allowed call + 2 for the approval-path call)"
    );
    assert.deepEqual(
      observed.map((o) => o.decision),
      ["allow", "ask"],
      "the observer reports the same decision the gate enforces"
    );
    assert.equal(
      decisions.filter((d) => d.tool === "read_tool").length,
      1,
      "an allowed call must be decided exactly once"
    );
    // An approval-path call is decided ONCE at the gate plus EXACTLY ONE
    // re-decision before its prompt — the re-decision is what lets an earlier
    // "always allow" answer reach the next same-tool call.
    assert.equal(
      decisions.filter((d) => d.tool === "write_tool").length,
      2,
      "an approval-path call is decided once at the gate plus exactly one re-decision before its prompt"
    );
  });

  it("(b) wave [allow, ask, allow]: 两个 allow 在 ask 应答前已开始执行,结果按输入顺序", async () => {
    const { executor, started } = makeRecordingExecutor({
      sleepMsById: { a1: 40, a2: 40 },
    });
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    let askEntered!: () => void;
    const askEnteredPromise = new Promise<void>((resolve) => {
      askEntered = resolve;
    });
    let releaseAsk!: () => void;
    const askAnswered = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    let startedBeforeAsk: string[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => {
        startedBeforeAsk = [...started];
        askEntered();
        await askAnswered;
        return true;
      },
    });

    const pending = aciExec.executeAll([
      { id: "a1", name: "read_tool", input: {} },
      { id: "w1", name: "write_tool", input: { note: "n" } },
      { id: "a2", name: "read_tool", input: {} },
    ]);

    await askEnteredPromise;
    releaseAsk();
    const results = await pending;

    assert.deepEqual(
      startedBeforeAsk,
      ["a1", "a2"],
      "both allow calls must have started before the ask was answered"
    );
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["a1", "w1", "a2"],
      "results must stay in input order"
    );
    assert.ok(results.every((r) => r.kind === "ok"));
  });

  it("(c) 第一个 ask 选「总是允许」后,第二个同类调用不再询问", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("write_tool", "write")]);
    const grants = createSessionGrants();
    let askCount = 0;
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy({ session: grants }),
      askUser: async () => {
        askCount += 1;
        // The TUI records an "always allow" answer as a tool-scoped session
        // grant (src/tui/app.tsx) — the live source the next decision reads.
        grants.add({
          id: "always-allow-write-tool",
          match: ({ tool }) => tool === "write_tool",
          decision: "allow",
          reason: "test: always allow",
        });
        return true;
      },
    });

    const results = await aciExec.executeAll([
      { id: "w1", name: "write_tool", input: { note: "1" } },
      { id: "w2", name: "write_tool", input: { note: "2" } },
    ]);

    assert.equal(
      askCount,
      1,
      "the second same-tool call must not be asked again"
    );
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["w1", "w2"]
    );
    assert.ok(results.every((r) => r.kind === "ok"));
  });

  it("(d) 有效权限 full_auto: 判定与现行强制判定一致（allow,不弹窗）", async () => {
    const { executor } = makeRecordingExecutor();
    const def = makeTool("write_tool", "write");
    const catalog = makeCatalog([def]);
    const { policy, decisions } = makeCountingPolicy({ mode: "full_auto" });
    let askCount = 0;
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
      askUser: async () => {
        askCount += 1;
        return true;
      },
    });

    const results = await aciExec.executeAll([
      { id: "w1", name: "write_tool", input: { note: "n" } },
    ]);

    // The verdict the enforcing gate applies today (the mode-aware one).
    const enforcing = checkPermission({
      def,
      input: { note: "n" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });
    assert.equal(enforcing.decision, "allow");
    assert.equal(decisions.length, 1, "the call is decided exactly once");
    assert.equal(decisions[0]!.outcome.decision, "allow");
    assert.equal(decisions[0]!.outcome.reason, enforcing.reason);
    assert.equal(askCount, 0, "full_auto must not prompt");
    assert.equal(results[0]!.kind, "ok");
  });

  it("(e) 多波次批次:后一个波次的判定在它自己的闸门处作出(现场模式生效)", async () => {
    // The batch splits into three waves: the write tool is not concurrency
    // safe, so it occupies a singleton wave between the two reads.
    // The live mode holder: full_auto at the start, flipped to plan while the
    // FIRST wave runs. The mutating call in the SECOND wave must see plan.
    const mode = createPermissionModeContext("full_auto");
    const { executor, started } = makeRecordingExecutor({
      onStart: (id) => {
        if (id === "r1") mode.set("plan");
      },
    });
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write", { isConcurrencySafe: false }),
    ]);
    const { policy, decisions } = makeCountingPolicy({ mode });
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
      askUser: async () => true,
    });

    const results = await aciExec.executeAll([
      { id: "r1", name: "read_tool", input: {} },
      { id: "w1", name: "write_tool", input: { note: "n" } },
      { id: "r2", name: "read_tool", input: {} },
    ]);

    // The mode flipped between the waves, so the second wave's mutating call
    // is judged under `plan` — and denied.
    assert.equal(mode.get(), "plan", "the holder was flipped mid-batch");
    assert.equal(
      results[1]!.kind,
      "execution_failed",
      "the mutating call in the second wave must be denied under plan"
    );
    assert.ok(
      (results[1] as { message: string }).message.startsWith(
        "[permission_denied]"
      ),
      `expected a permission_denied message, got ${JSON.stringify(results[1])}`
    );
    assert.ok(
      (results[1] as { message: string }).message.includes("plan"),
      `expected the plan-mode reason, got ${JSON.stringify(results[1])}`
    );
    assert.deepEqual(
      started,
      ["r1", "r2"],
      "the denied call must never reach the inner executor"
    );
    // One decision per call, taken at that call's own wave's scan — plus the
    // boundary probe: the write call broke the first wave, so it was decided
    // once when the first wave's scan probed it and once in its own wave's
    // scan. The two reads are decided once each.
    assert.equal(
      decisions.length,
      4,
      "two reads + the write's boundary probe + the write's own wave"
    );
    assert.equal(decisions.filter((d) => d.tool === "read_tool").length, 2);
    const writeDecisions = decisions.filter((d) => d.tool === "write_tool");
    assert.equal(
      writeDecisions.length,
      2,
      "the boundary probe plus its own wave's verdict"
    );
    assert.equal(
      writeDecisions[0]!.outcome.decision,
      "allow",
      "the boundary probe was taken under full_auto"
    );
    assert.equal(
      writeDecisions[1]!.outcome.decision,
      "deny",
      "its own wave's verdict was taken under plan"
    );
  });

  it("(f) 同一时刻最多一个审批请求;提示顺序等于 tool_use 顺序", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([
      makeTool("write_a", "write"),
      makeTool("write_b", "write"),
    ]);
    const promptOrder: string[] = [];
    let openPrompts = 0;
    let maxOpenPrompts = 0;
    const releases: Array<() => void> = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async ({ tool }) => {
        promptOrder.push(tool);
        openPrompts += 1;
        maxOpenPrompts = Math.max(maxOpenPrompts, openPrompts);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        openPrompts -= 1;
        return true;
      },
    });

    const pending = aciExec.executeAll([
      { id: "x1", name: "write_a", input: {} },
      { id: "x2", name: "write_b", input: {} },
    ]);

    await waitFor(() => promptOrder.length >= 1, "the first prompt");
    // While the first question is open, no second one may be in flight.
    await tick();
    assert.equal(
      maxOpenPrompts,
      1,
      "at most one approval request may be in flight at a time"
    );
    assert.deepEqual(
      promptOrder,
      ["write_a"],
      "the second prompt must not be raised while the first is open"
    );

    releases[0]!();
    await waitFor(() => promptOrder.length === 2, "the second prompt");
    assert.deepEqual(
      promptOrder,
      ["write_a", "write_b"],
      "the prompts follow the tool_use order"
    );
    assert.equal(maxOpenPrompts, 1, "at most one prompt may be in flight");

    releases[1]!();
    const results = await pending;
    assert.equal(maxOpenPrompts, 1, "at most one prompt may be in flight");
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["x1", "x2"]
    );
    assert.ok(results.every((r) => r.kind === "ok"));
  });

  it("(g) 内层执行在审批挂起时 reject:进程不死,波次仍交付结果", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { executor, started } = makeRecordingExecutor({
        failIds: ["boom"],
      });
      const catalog = makeCatalog([
        makeTool("read_tool", "read-only"),
        makeTool("write_tool", "write"),
      ]);
      let releaseAsk!: () => void;
      const askAnswered = new Promise<void>((resolve) => {
        releaseAsk = resolve;
      });
      const aciExec = createAciExecutor({
        inner: executor,
        catalog,
        policy: createPermissionPolicy(),
        askUser: async () => {
          await askAnswered;
          return true;
        },
      });

      const pending = aciExec.executeAll([
        { id: "boom", name: "read_tool", input: {} },
        { id: "w1", name: "write_tool", input: {} },
      ]);

      // The inner call rejects while the approval question is still open.
      await waitFor(() => started.includes("boom"), "the failing inner call");
      await tick();
      releaseAsk();
      const results = await pending;

      assert.deepEqual(
        unhandled,
        [],
        "an inner rejection must not become an unhandled rejection"
      );
      assert.equal(
        results.length,
        2,
        "the wave still delivers one result per call"
      );
      assert.equal(
        results[0]!.kind,
        "execution_failed",
        "the rejected call reports its failure as a result"
      );
      assert.ok(
        (results[0] as { message: string }).message.includes(
          "BOOM-inner-throw"
        ),
        `expected the inner failure message, got ${JSON.stringify(results[0])}`
      );
      assert.equal(results[1]!.kind, "ok", "the other call still runs");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("(h) 观察者报告闸门处的判定;「总是允许」后的再判定才是被强制执行的那一个", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("write_tool", "write")]);
    const grants = createSessionGrants();
    const observed: Array<{ id: string; decision: string }> = [];
    let askCount = 0;
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy({ session: grants }),
      onDecision: (call, outcome) =>
        observed.push({ id: call.id, decision: outcome.decision }),
      askUser: async () => {
        askCount += 1;
        grants.add({
          id: "always-allow-write-tool",
          match: ({ tool }) => tool === "write_tool",
          decision: "allow",
          reason: "test: always allow",
        });
        return true;
      },
    });

    const results = await aciExec.executeAll([
      { id: "w1", name: "write_tool", input: { note: "1" } },
      { id: "w2", name: "write_tool", input: { note: "2" } },
    ]);

    // Both calls were ASKED at their own gate: the session grant only exists
    // after the first answer, so the second call's scan verdict is "ask".
    assert.deepEqual(
      observed,
      [
        { id: "w1", decision: "ask" },
        { id: "w2", decision: "ask" },
      ],
      "the observer reports the scan's verdict for both calls"
    );
    // The enforced verdict for the second call comes from the re-decision,
    // which sees the "always allow" grant — so it is not asked again.
    assert.equal(askCount, 1, "the second same-tool call is admitted silently");
    assert.deepEqual(
      results.map((r) => r.toolUseId),
      ["w1", "w2"]
    );
    assert.ok(results.every((r) => r.kind === "ok"));
  });

  it("(i) 波次内的顺序:每个调用先观察者事件后 pre-hook,且都早于本波第一次提示", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    const order: string[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      hooks: {
        preToolUse: ({ tool }) => {
          order.push(`pre:${tool}`);
          return undefined;
        },
      },
      onDecision: (call) => {
        order.push(`obs:${call.name}`);
      },
      askUser: async ({ tool }) => {
        order.push(`prompt:${tool}`);
        return true;
      },
    });

    await aciExec.executeAll([
      { id: "r1", name: "read_tool", input: {} },
      { id: "w1", name: "write_tool", input: {} },
      { id: "r2", name: "read_tool", input: {} },
    ]);

    assert.deepEqual(
      order,
      [
        "obs:read_tool",
        "pre:read_tool",
        "obs:write_tool",
        "pre:write_tool",
        "obs:read_tool",
        "pre:read_tool",
        "prompt:write_tool",
      ],
      "the whole wave's observer events and pre-hooks precede the first prompt"
    );
  });

  it("(k) 被拒的非并发安全调用仍然搭邻居的波次(#653 行为)", async () => {
    // A denied call has no side effect, so it may ride along in its
    // neighbours' wave: the write tool is NOT concurrency-safe, and the
    // denial is what keeps the two reads in one wave. The wave's shape rule
    // is unchanged — what changed is WHEN the verdict is taken (per wave,
    // not per batch).
    const { executor, started, intervals } = makeRecordingExecutor({
      sleepMsById: { r1: 40, r2: 40 },
    });
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write", { isConcurrencySafe: false }),
    ]);
    // A live session rule that denies the write tool.
    const grants = createSessionGrants();
    grants.add({
      id: "deny-write-tool",
      match: ({ tool }) => tool === "write_tool",
      decision: "deny",
      reason: "test: denied by rule",
    });
    const { policy, decisions } = makeCountingPolicy({ session: grants });
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
      askUser: async () => true,
    });

    const results = await aciExec.executeAll([
      { id: "r1", name: "read_tool", input: {} },
      { id: "w1", name: "write_tool", input: {} },
      { id: "r2", name: "read_tool", input: {} },
    ]);

    assert.equal(results.length, 3);
    assert.equal(results[1]!.kind, "execution_failed");
    assert.ok(
      (results[1] as { message: string }).message.startsWith(
        "[permission_denied]"
      )
    );
    assert.deepEqual(
      started,
      ["r1", "r2"],
      "the denied call never reaches the inner executor"
    );
    // The two reads are in ONE wave, so they overlap: the denied call rode
    // along with them.
    const r1 = intervals.find((i) => i.id === "r1")!;
    const r2 = intervals.find((i) => i.id === "r2")!;
    assert.ok(
      r1.start < r2.end && r2.start < r1.end,
      `the two reads must overlap in one wave; got ${JSON.stringify(r1)} ${JSON.stringify(r2)}`
    );
    // One wave, one decision per call — the denied call never broke a wave,
    // so it was not probed twice.
    assert.equal(decisions.length, 3, "one decision per call, in one wave");
  });

  it("(j) 真实 yolo 预设链:预设 → overlay → 权限 holder → 判定 allow,不弹窗", async () => {
    // The real preset chain (ADR-0141): the controller declares the preset
    // into the overlay AND writes the declared permission tier into the
    // holder, because the policy reads the holder and nothing else.
    const permission = createPermissionModeContext("default");
    const overlay = createPresetOverlay({
      settingsFsMode: "global",
      settingsPermission: "default",
    });
    const controller = createYoloController({
      yolo: createYoloContext(false),
      permission,
      fsMode: createFsModeContext("global"),
      overlay,
      // The bwrap probe is injected: this case is about the permission axis.
      probe: () => undefined,
    });

    const entered = controller.enter();
    assert.equal(entered.ok, true, "the yolo preset enters");
    assert.equal(overlay.preset(), "yolo", "the overlay declares the preset");
    assert.equal(
      overlay.effectivePermission(),
      "full_auto",
      "the overlay declares the permission tier"
    );
    assert.equal(
      permission.get(),
      "full_auto",
      "the declared tier reaches the holder the policy reads"
    );

    const { executor } = makeRecordingExecutor();
    const def = makeTool("write_tool", "write");
    const catalog = makeCatalog([def]);
    const { policy, decisions } = makeCountingPolicy({ mode: permission });
    const observed: string[] = [];
    let askCount = 0;
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
      onDecision: (_call, outcome) => {
        observed.push(outcome.decision);
      },
      askUser: async () => {
        askCount += 1;
        return true;
      },
    });

    const results = await aciExec.executeAll([
      { id: "w1", name: "write_tool", input: { note: "n" } },
    ]);

    assert.equal(decisions.length, 1, "the call is decided exactly once");
    assert.equal(
      decisions[0]!.outcome.decision,
      "allow",
      "the preset's declared permission reaches the decision"
    );
    assert.deepEqual(
      observed,
      ["allow"],
      "the observer reports the same verdict the gate enforces"
    );
    assert.equal(askCount, 0, "the preset must not prompt");
    assert.equal(results[0]!.kind, "ok");
  });

  it("(l) 波次路径上的安全审查:只走 review 路由,绝不落回普通审批入口", async () => {
    // ADR-0127 on the WAVE path: the call's verdict carries a review
    // requirement, so the wave gate must put it to the review route. Were the
    // approval re-decision to drop the requirement, the call would silently
    // fall back to the ordinary `askUser` inlet — this case fails then.
    const { executor, started } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("bash", "execute")]);
    const requests: SecurityReviewRequest[] = [];
    const route: SecurityReviewRoute = {
      interactive: true,
      request: async (req) => {
        requests.push(req);
        return true;
      },
    };
    let askCount = 0;
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      securityReview: route,
      askUser: async () => {
        askCount += 1;
        return true;
      },
    });

    const results = await aciExec.executeAll([
      { id: "b1", name: "bash", input: { command: REVIEW_COMMAND } },
    ]);

    assert.equal(
      requests.length,
      1,
      "the wave gate must put the review requirement to the route"
    );
    assert.equal(
      requests[0]!.requirement.cause,
      "execution-unresolved",
      "the route sees the very requirement the decision carried"
    );
    assert.equal(requests[0]!.tool, "bash");
    assert.ok(
      requests[0]!.requestId.startsWith("b1"),
      `expected the request id to name the call, got ${requests[0]!.requestId}`
    );
    assert.equal(
      askCount,
      0,
      "the ordinary approval inlet must never answer a security review"
    );
    assert.deepEqual(started, ["b1"], "the approved call runs");
    assert.equal(results[0]!.kind, "ok");
  });

  it("(m) 波次路径上的安全审查没有路由:类型化拒绝,普通审批入口不被调用", async () => {
    // No route → the review denies typed, and it denies WITHOUT asking the
    // ordinary inlet: a permissive askUser must not answer a review.
    const { executor, started } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("bash", "execute")]);
    let askCount = 0;
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => {
        askCount += 1;
        return true;
      },
    });

    const results = await aciExec.executeAll([
      { id: "b1", name: "bash", input: { command: REVIEW_COMMAND } },
    ]);

    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.equal(result.kind, "execution_failed");
    const message = (result as { message: string }).message;
    assert.ok(
      message.startsWith(SECURITY_REVIEW_DENY_PREFIX),
      `expected the typed review deny, got ${JSON.stringify(result)}`
    );
    assert.ok(
      message.includes("cause=execution-unresolved"),
      `expected the cause in the deny message, got ${message}`
    );
    assert.ok(
      message.includes("(bash)"),
      `expected the tool in the deny message, got ${message}`
    );
    assert.equal(
      askCount,
      0,
      "the ordinary approval inlet must never answer a security review"
    );
    assert.deepEqual(
      started,
      [],
      "a denied call never reaches the inner executor"
    );
  });

  it("(n) onSettled 契约:每个结果恰好结算一次,索引是波次相对输入下标", async () => {
    // Four calls in three waves: the write tool is not concurrency-safe, so it
    // breaks the wave it would otherwise join, and the denied call rides
    // along in its neighbours' wave. The index handed to onSettled must be
    // the INPUT index — the wave-relative one plus the waves already settled.
    const { executor } = makeRecordingExecutor({ failIds: ["boom"] });
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("denied_tool", "write"),
      makeTool("write_tool", "write", { isConcurrencySafe: false }),
    ]);
    // A live session rule that denies one tool — that call never runs, but
    // its slot is settled all the same.
    const grants = createSessionGrants();
    grants.add({
      id: "deny-denied-tool",
      match: ({ tool }) => tool === "denied_tool",
      decision: "deny",
      reason: "test: denied by rule",
    });
    const settled: Settled[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy({ session: grants }),
      askUser: async () => true,
    });

    const results = await aciExec.executeAll(
      [
        { id: "r1", name: "read_tool", input: {} },
        { id: "d1", name: "denied_tool", input: {} },
        { id: "w1", name: "write_tool", input: {} },
        { id: "boom", name: "read_tool", input: {} },
      ],
      undefined,
      undefined,
      undefined,
      (result, index) => {
        settled.push({
          index,
          kind: result.kind,
          toolUseId: result.toolUseId,
          message:
            result.kind === "execution_failed" ? result.message : undefined,
        });
      }
    );

    assert.equal(results.length, 4, "the wave delivers one result per call");
    assert.equal(
      settled.length,
      4,
      "every result settles exactly once — none settles twice, none is skipped"
    );
    assert.deepEqual(
      settled.map((s) => s.index).sort((a, b) => a - b),
      [0, 1, 2, 3],
      "the indexes are the wave-relative input indexes 0..n-1"
    );
    // The index identifies the INPUT call, whichever wave settled it: a bare
    // wave-relative index would repeat 0 for every wave.
    const byIndex = new Map(settled.map((s) => [s.index, s]));
    assert.equal(byIndex.get(0)?.toolUseId, "r1");
    assert.equal(byIndex.get(1)?.toolUseId, "d1");
    assert.equal(byIndex.get(2)?.toolUseId, "w1");
    assert.equal(byIndex.get(3)?.toolUseId, "boom");
    assert.equal(byIndex.get(0)?.kind, "ok");
    assert.equal(byIndex.get(2)?.kind, "ok");
    // The denied call settles too — it never ran, but its slot is settled.
    assert.equal(byIndex.get(1)?.kind, "execution_failed");
    assert.ok(
      (byIndex.get(1)?.message ?? "").startsWith("[permission_denied]"),
      `expected the denied result's message, got ${byIndex.get(1)?.message}`
    );
  });

  it("(o) onSettled 契约:内层 reject 的槽位恰好结算一次,结果是 execution_failed", async () => {
    // Case (g)'s scenario with the settlement contract watched: the rejected
    // call's slot settles exactly once, with the failure as an
    // `execution_failed` result — the third settlement site, the one the
    // base never had.
    const { executor, started } = makeRecordingExecutor({
      failIds: ["boom"],
    });
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    let releaseAsk!: () => void;
    const askAnswered = new Promise<void>((resolve) => {
      releaseAsk = resolve;
    });
    const settled: Settled[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => {
        await askAnswered;
        return true;
      },
    });

    const pending = aciExec.executeAll(
      [
        { id: "boom", name: "read_tool", input: {} },
        { id: "w1", name: "write_tool", input: {} },
      ],
      undefined,
      undefined,
      undefined,
      (result, index) => {
        settled.push({
          index,
          kind: result.kind,
          toolUseId: result.toolUseId,
          message:
            result.kind === "execution_failed" ? result.message : undefined,
        });
      }
    );

    // The inner call rejects while the approval question is still open.
    await waitFor(() => started.includes("boom"), "the failing inner call");
    await tick();
    releaseAsk();
    const results = await pending;

    assert.equal(
      results.length,
      2,
      "the wave still delivers one result per call"
    );
    assert.equal(
      settled.length,
      2,
      "each call settles exactly once — the rejected one included"
    );
    const boomSettlements = settled.filter((s) => s.toolUseId === "boom");
    assert.equal(
      boomSettlements.length,
      1,
      "the rejected call's slot settles exactly once"
    );
    assert.equal(
      boomSettlements[0]!.kind,
      "execution_failed",
      "the rejected slot settles with the failure, not with a throw"
    );
    assert.ok(
      (boomSettlements[0]!.message ?? "").includes("BOOM-inner-throw"),
      `expected the inner failure message, got ${boomSettlements[0]!.message}`
    );
    assert.equal(
      boomSettlements[0]!.index,
      0,
      "the rejected slot carries its wave-relative input index"
    );
    const w1Settlements = settled.filter((s) => s.toolUseId === "w1");
    assert.equal(
      w1Settlements.length,
      1,
      "the other slot settles exactly once"
    );
    assert.equal(w1Settlements[0]!.kind, "ok");
    assert.equal(
      w1Settlements[0]!.index,
      1,
      "the other slot carries its wave-relative input index"
    );
  });

  it("(p) 一波之内的权限变更:该波已开跑的 allow 调用不回头改判,下一波取新判定", async () => {
    // The window ADR-0147 §10 names. A wave's verdicts are sampled in that
    // wave's SCAN, and the wave's allowed calls start before the wave's
    // question is answered (case (b)). A permission-state change that lands
    // WHILE the question is pending is therefore not seen by the wave's
    // already-started allowed calls — the base, which decided each call at its
    // own turn, would have re-read the new state for the later call.
    //
    // ONE batch, TWO waves: `write_d` is not concurrency-safe, so it breaks
    // the wave and starts the next one. Wave 1 = [write_a, bash, write_c] is
    // scanned under full_auto; the review inside wave 1 flips the mode to
    // plan; wave 2 = [write_d] is scanned afterwards, under the new mode.
    //
    // This case pins the window on purpose: the divergence is a SAMPLING-TIME
    // difference, not a policy difference, and it is fail-open by
    // construction. The test would fail if the wave ever stopped starting its
    // allowed calls before the answer (case (b) would fail first) and it
    // fails if the next wave stopped sampling the live state.
    const mode = createPermissionModeContext("full_auto");
    const { executor, started } = makeRecordingExecutor();
    const catalog = makeCatalog([
      makeTool("write_a", "write"),
      makeTool("bash", "execute"),
      makeTool("write_c", "write"),
      // Not concurrency-safe: it breaks wave 1 and starts wave 2.
      makeTool("write_d", "write", { isConcurrencySafe: false }),
    ]);

    let startedBeforeReview: string[] = [];
    const route: SecurityReviewRoute = {
      interactive: true,
      request: async () => {
        // The operator flips the permission mode while the question is open.
        startedBeforeReview = [...started];
        mode.set("plan");
        return true; // approve the review
      },
    };

    const { policy, decisions } = makeCountingPolicy({ mode });
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy,
      securityReview: route,
      askUser: async () => true,
    });

    const results = await aciExec.executeAll([
      { id: "a", name: "write_a", input: { note: "1" } },
      { id: "b", name: "bash", input: { command: REVIEW_COMMAND } },
      { id: "c", name: "write_c", input: { note: "2" } },
      { id: "d", name: "write_d", input: { note: "3" } },
    ]);

    assert.equal(mode.get(), "plan", "the holder was flipped mid-wave");
    assert.deepEqual(
      startedBeforeReview,
      ["a", "c"],
      "the wave's allowed calls started before the review was answered"
    );
    // The window: write_c's verdict was sampled in wave 1's scan, before the
    // flip, so it keeps that verdict. The base judged write_c only after the
    // review had been answered, under plan, and denied it.
    assert.equal(
      results[2]!.kind,
      "ok",
      "the already-started allowed call keeps the verdict its wave sampled"
    );
    assert.ok(
      decisions.some(
        (d) => d.tool === "write_c" && d.outcome.decision === "allow"
      ),
      "write_c was sampled as allow, in its wave's scan"
    );

    // The window is BOUNDED, and the bound is the NEXT WAVE of this same
    // batch: wave 2 is scanned after wave 1 ran, so it samples the live state
    // and denies the mutating call.
    assert.equal(
      results[3]!.kind,
      "execution_failed",
      "the next wave must sample the new mode and deny the mutating call"
    );
    assert.ok(
      (results[3] as { message: string }).message.startsWith(
        "[permission_denied]"
      ),
      `expected a permission_denied message, got ${JSON.stringify(results[3])}`
    );
  });

  it("(q) 结算回调自己抛错:该槽位只结算一次,错误向上传播(不伪造 execution_failed)", async () => {
    // The settlement callback (`onSettled`) is the engine's prefix commit. If
    // IT throws, the call did not fail — it produced its result, and that
    // result was committed (or the commit failed). Turning the callback's
    // error into the call's `execution_failed` result would be a lie AND
    // would settle the same slot a second time, breaking the plan's
    // "every result settles exactly once" row.
    //
    // The base propagated a settlement failure out of `executeAll`; so does
    // this, and the slot is settled exactly once.
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("read_tool", "read-only")]);
    const settlements: Array<{ index: number; kind: string }> = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => true,
    });

    await assert.rejects(
      () =>
        aciExec.executeAll(
          [{ id: "r1", name: "read_tool", input: {} }],
          undefined,
          undefined,
          undefined,
          (result, index) => {
            settlements.push({ index, kind: result.kind });
            throw new Error("BOOM-settlement");
          }
        ),
      /BOOM-settlement/,
      "the settlement callback's failure must travel out of executeAll"
    );

    assert.equal(
      settlements.length,
      1,
      "the slot must be settled exactly once, even when the callback throws"
    );
    assert.equal(
      settlements[0]!.index,
      0,
      "the settlement carries the input index"
    );
    assert.equal(
      settlements[0]!.kind,
      "ok",
      "the call's own result is what was settled — not a fabricated failure"
    );
  });

  it("(r) 审批口收到调用的 toolUseId 与波次的 conversationId", async () => {
    // ADR-0147 R1: the question is addressed to the call it is about. The
    // inlet's input carries the call's tool_use id and the wave's conversation.
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("write_tool", "write")]);
    const seen: Array<{
      toolUseId: string;
      conversationId: string | undefined;
    }> = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async ({ toolUseId, conversationId }) => {
        seen.push({ toolUseId, conversationId });
        return true;
      },
    });

    const results = await aciExec.executeAll(
      [{ id: "w1", name: "write_tool", input: {} }],
      undefined,
      undefined,
      "conv-1"
    );

    assert.deepEqual(
      seen,
      [{ toolUseId: "w1", conversationId: "conv-1" }],
      "the approval inlet must receive the call identity and the wave's conversation"
    );
    assert.equal(results[0]!.kind, "ok");
  });

  it("(s) 明确拒绝:精确文案是 user declined tool call", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("write_tool", "write")]);
    const events: HarnessStreamEvent[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => false,
    });

    const results = await aciExec.executeAll(
      [{ id: "w1", name: "write_tool", input: {} }],
      undefined,
      undefined,
      "conv-1",
      undefined,
      undefined,
      (event) => events.push(event)
    );

    assert.deepEqual(
      events.filter((e) => e.type === "approval_resolved"),
      [{ type: "approval_resolved", toolUseId: "w1", outcome: "declined" }],
      "a decline must resolve the shown question as declined — the ending the result text reports"
    );
    const result = results[0]!;
    assert.equal(result.kind, "execution_failed");
    const { ending, note } = splitApprovalLine(
      (result as { message: string }).message
    );
    assert.equal(
      ending,
      "[user_denied] user declined tool call: write_tool",
      "an explicit decline keeps the unchanged declined text"
    );
    assert.equal(
      note,
      "[approval] held for user approval (declined); calls that ran in this wave meanwhile under the wave-start verdict: none"
    );
  });

  it("(s) 配置超时:精确文案说出等待秒数", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("write_tool", "write")]);
    const events: HarnessStreamEvent[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async (): Promise<AskUserOutcome> => ({
        kind: "timeout",
        afterMs: 5000,
      }),
    });

    const results = await aciExec.executeAll(
      [{ id: "w1", name: "write_tool", input: {} }],
      undefined,
      undefined,
      "conv-1",
      undefined,
      undefined,
      (event) => events.push(event)
    );

    assert.deepEqual(
      events.filter((e) => e.type === "approval_resolved"),
      [{ type: "approval_resolved", toolUseId: "w1", outcome: "timeout" }],
      "a timed-out question must resolve as timeout — the ending the result text reports"
    );
    const result = results[0]!;
    assert.equal(result.kind, "execution_failed");
    const { ending, note } = splitApprovalLine(
      (result as { message: string }).message
    );
    assert.equal(
      ending,
      "[user_denied] approval timed out after 5s with no answer: write_tool",
      "a 5000 ms timeout is reported in seconds"
    );
    assert.equal(
      note,
      "[approval] held for user approval (timeout); calls that ran in this wave meanwhile under the wave-start verdict: none"
    );
  });

  it("(s) 提示抛错:精确文案带已净化的原因", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("write_tool", "write")]);
    const events: HarnessStreamEvent[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async (): Promise<AskUserOutcome> => {
        throw new Error("boom");
      },
    });

    const results = await aciExec.executeAll(
      [{ id: "w1", name: "write_tool", input: {} }],
      undefined,
      undefined,
      "conv-1",
      undefined,
      undefined,
      (event) => events.push(event)
    );

    assert.deepEqual(
      events.filter((e) => e.type === "approval_resolved"),
      [
        {
          type: "approval_resolved",
          toolUseId: "w1",
          outcome: "prompt_failed",
        },
      ],
      "a throwing inlet must resolve the shown question as prompt_failed — the ending the result text reports"
    );
    const result = results[0]!;
    assert.equal(result.kind, "execution_failed");
    const { ending, note } = splitApprovalLine(
      (result as { message: string }).message
    );
    assert.equal(
      ending,
      "[user_denied] approval prompt failed (Error: boom): write_tool",
      "a throwing inlet is reported with its sanitized cause"
    );
    assert.equal(
      note,
      "[approval] held for user approval (prompt_failed); calls that ran in this wave meanwhile under the wave-start verdict: none"
    );
  });

  it("(s) 取消:结果是 cancelled,内层调用不启动", async () => {
    const { executor, started } = makeRecordingExecutor();
    const catalog = makeCatalog([makeTool("write_tool", "write")]);
    const controller = new AbortController();
    const events: HarnessStreamEvent[] = [];
    let askEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      askEntered = resolve;
    });
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: ({ signal }) =>
        new Promise<AskUserOutcome>((resolve) => {
          askEntered();
          signal?.addEventListener(
            "abort",
            () => resolve({ kind: "cancelled" }),
            { once: true }
          );
        }),
    });

    const pending = aciExec.executeAll(
      [{ id: "w1", name: "write_tool", input: {} }],
      controller.signal,
      undefined,
      "conv-1",
      undefined,
      undefined,
      (event) => events.push(event)
    );
    await entered;
    controller.abort();
    const results = await pending;

    assert.deepEqual(
      events.filter((e) => e.type === "approval_resolved"),
      [{ type: "approval_resolved", toolUseId: "w1", outcome: "cancelled" }],
      "an aborted question must resolve as cancelled — the ending the result text reports"
    );
    assert.equal(results[0]!.kind, "execution_failed");
    const { ending, note } = splitApprovalLine(
      (results[0] as { message: string }).message
    );
    assert.equal(
      ending,
      "cancelled",
      "a cancelled question keeps the cancelled result"
    );
    assert.equal(
      note,
      "[approval] held for user approval (cancelled); calls that ran in this wave meanwhile under the wave-start verdict: none"
    );
    assert.deepEqual(
      started,
      [],
      "a cancelled approval must never start the inner call"
    );
  });

  it("(t) [allow, ask, allow]: 恰好一对审批事件,pending 早于 resolved", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    const events: HarnessStreamEvent[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => true,
    });

    const results = await aciExec.executeAll(
      [
        { id: "a1", name: "read_tool", input: {} },
        { id: "w1", name: "write_tool", input: {} },
        { id: "a2", name: "read_tool", input: {} },
      ],
      undefined,
      undefined,
      "conv-1",
      undefined,
      undefined,
      (event) => events.push(event)
    );

    const approvals = events.filter(
      (e) => e.type === "approval_pending" || e.type === "approval_resolved"
    );
    assert.equal(
      approvals.length,
      2,
      "exactly one pending/resolved pair for the one shown question"
    );
    assert.deepEqual(approvals[0], {
      type: "approval_pending",
      toolUseId: "w1",
      tool: "write_tool",
      conversationId: "conv-1",
    });
    assert.deepEqual(approvals[1], {
      type: "approval_resolved",
      toolUseId: "w1",
      outcome: "approved",
    });
    assert.ok(results.every((r) => r.kind === "ok"));
  });

  it("(t) §7 再判直接放行(总是允许):不提问,也不发审批事件", async () => {
    // The wave scan judged w1 "ask" (the grant did not exist yet), but the
    // allowed call starts first and records the grant; the re-decision before
    // the prompt sees it — no question is shown, so no event is emitted.
    const grants = createSessionGrants();
    const { executor } = makeRecordingExecutor({
      onStart: (id) => {
        if (id === "a1") {
          grants.add({
            id: "always-allow-write-tool",
            match: ({ tool }) => tool === "write_tool",
            decision: "allow",
            reason: "test: always allow",
          });
        }
      },
    });
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    const events: HarnessStreamEvent[] = [];
    let askCount = 0;
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy({ session: grants }),
      askUser: async () => {
        askCount += 1;
        return true;
      },
    });

    const results = await aciExec.executeAll(
      [
        { id: "a1", name: "read_tool", input: {} },
        { id: "w1", name: "write_tool", input: {} },
      ],
      undefined,
      undefined,
      "conv-1",
      undefined,
      undefined,
      (event) => events.push(event)
    );

    assert.equal(askCount, 0, "the re-decision admits the call silently");
    assert.deepEqual(
      events.filter(
        (e) => e.type === "approval_pending" || e.type === "approval_resolved"
      ),
      [],
      "no question was shown, so no approval event may be emitted"
    );
    assert.ok(results.every((r) => r.kind === "ok"));
  });

  it("(u) [allow, ask, allow] 批准:ask 结果列出两个 allow 的 id,allow 结果无说明行", async () => {
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => true,
    });

    const results = await aciExec.executeAll([
      { id: "a1", name: "read_tool", input: {} },
      { id: "w1", name: "write_tool", input: {} },
      { id: "a2", name: "read_tool", input: {} },
    ]);

    const askResult = results[1]!;
    assert.equal(askResult.kind, "ok");
    const payload = (askResult as Extract<ToolExecutionResult, { kind: "ok" }>)
      .payload;
    const last = payload[payload.length - 1]!;
    assert.equal(last.type, "text");
    assert.equal(
      last.type === "text" ? last.text : "",
      "[approval] held for user approval (approved); calls that ran in this wave meanwhile under the wave-start verdict: a1, a2",
      "the held call's result names the allow calls that ran while it waited"
    );
    // The allow calls were never held: their results must not carry the line.
    assert.ok(
      !JSON.stringify(results[0]).includes("[approval]"),
      `an allow call's result must not carry an approval line: ${JSON.stringify(results[0])}`
    );
    assert.ok(
      !JSON.stringify(results[2]).includes("[approval]"),
      `an allow call's result must not carry an approval line: ${JSON.stringify(results[2])}`
    );
  });

  it("(v) 提问挂起期间权限切到 plan:再判为 deny 的结果列出已开跑的调用", async () => {
    // The window ADR-0147 §10 names, told to the agent (R3): the first held
    // call is asked under the mode its question was raised in (its re-decision
    // already ran); the NEXT approval entry re-decides against the live mode
    // and denies. Its result must name the calls that started meanwhile.
    //
    // One wave of four: both allow calls start in stage 2; the first question
    // flips the holder to plan and is answered; the second approval entry's
    // re-decision then denies.
    const mode = createPermissionModeContext("default");
    const { executor } = makeRecordingExecutor();
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy({ mode }),
      askUser: async ({ toolUseId }) => {
        if (toolUseId === "w1") mode.set("plan");
        return true;
      },
    });

    const results = await aciExec.executeAll([
      { id: "a1", name: "read_tool", input: {} },
      { id: "w1", name: "write_tool", input: {} },
      { id: "w2", name: "write_tool", input: {} },
      { id: "a2", name: "read_tool", input: {} },
    ]);

    assert.equal(mode.get(), "plan", "the holder was flipped while w1 awaited");
    // The first held call keeps its question-time ending; it is already
    // started when the second re-decision runs.
    assert.equal(results[1]!.kind, "ok", "w1 was asked under the old mode");
    const denied = results[2]!;
    assert.equal(denied.kind, "execution_failed");
    const message = (denied as { message: string }).message;
    assert.ok(
      message.startsWith("[permission_denied]"),
      `expected a permission_denied message, got ${message}`
    );
    assert.ok(
      message.includes(
        "\n[approval] permission state changed while this wave was running; calls already started under the wave-start verdict: a1, a2, w1"
      ),
      `expected the redecided-deny note naming the started calls, got ${message}`
    );
    assert.ok(
      message.includes("a1") && message.includes("a2"),
      "both already-started allow calls must be named"
    );
    assert.equal(results[0]!.kind, "ok");
    assert.equal(results[3]!.kind, "ok");
  });

  it("(w) 批准的 ask 调用内层 reject:失败结果带内层失败文本与 [approval] 行(命名两个 allow)", async () => {
    // ADR-0147 R3 says the held call's result says it was held "whatever the
    // outcome" — and the rejected inner execution IS an outcome. That result
    // is rebuilt in `collectWaveResults` from the rejection reason, so the R3
    // line has to reach THAT message; the fulfilment path's note never runs
    // for a rejection.
    const { executor } = makeRecordingExecutor({ failIds: ["w1"] });
    const catalog = makeCatalog([
      makeTool("read_tool", "read-only"),
      makeTool("write_tool", "write"),
    ]);
    const settled: Settled[] = [];
    const aciExec = createAciExecutor({
      inner: executor,
      catalog,
      policy: createPermissionPolicy(),
      askUser: async () => true,
    });

    const results = await aciExec.executeAll(
      [
        { id: "a1", name: "read_tool", input: {} },
        { id: "w1", name: "write_tool", input: {} },
        { id: "a2", name: "read_tool", input: {} },
      ],
      undefined,
      undefined,
      undefined,
      (result, index) => {
        settled.push({
          index,
          kind: result.kind,
          toolUseId: result.toolUseId,
          message:
            result.kind === "execution_failed" ? result.message : undefined,
        });
      }
    );

    assert.equal(
      results.length,
      3,
      "the wave still delivers one result per call"
    );
    const askResult = results[1]!;
    assert.equal(
      askResult.kind,
      "execution_failed",
      "the rejected held call reports its failure as a result"
    );
    const { ending, note } = splitApprovalLine(
      (askResult as { message: string }).message
    );
    assert.equal(
      ending,
      "BOOM-inner-throw:w1",
      "the message starts with the inner failure text"
    );
    assert.equal(
      note,
      "[approval] held for user approval (approved); calls that ran in this wave meanwhile under the wave-start verdict: a1, a2",
      "a held call's failure still says it was held, naming the calls that ran meanwhile"
    );
    // The two allow calls were never held: their results are unchanged, and
    // they carry no approval line.
    assert.equal(results[0]!.kind, "ok");
    assert.equal(results[2]!.kind, "ok");
    for (const index of [0, 2]) {
      assert.ok(
        !JSON.stringify(results[index]).includes("[approval]"),
        `an allow call's result must not carry an approval line: ${JSON.stringify(results[index])}`
      );
    }
    // Exactly-once settlement survives the added line: three calls, three
    // settlements, the failing one included. The ORDER of the settlements is
    // the pre-existing one (a2's inner call settles before the aggregation
    // rebuilds w1's result), so the contract checked here is one settlement
    // per input index, not their arrival order.
    assert.deepEqual(
      [...settled]
        .sort((a, b) => a.index - b.index)
        .map((s) => [s.index, s.kind, s.toolUseId]),
      [
        [0, "ok", "a1"],
        [1, "execution_failed", "w1"],
        [2, "ok", "a2"],
      ],
      "every result settles exactly once, at its input index"
    );
    assert.equal(
      settled.find((s) => s.index === 1)?.message,
      (askResult as { message: string }).message,
      "the settled result carries the same noted message the caller receives"
    );
  });
});
