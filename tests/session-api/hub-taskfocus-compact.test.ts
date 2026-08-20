/**
 * #458 T7 (SC11): hub 接线 boundaryAttachment — 集成真实 SessionHub + deps
 * + 长 messages 触发 proactive compact,断言 attachment user 消息在 messages
 * 内,且焦点截 240、history 截 120、history cap 3(最近 3 条)。
 *
 * 渲染形态(plan T7 acceptance):`[当前焦点 (≤240)]` + `\n---\n` + `[历史 (≤120)]` × 3。
 * 总长 cap 720(防御)。harness 不 import session-api;`renderTaskFocusBoundary`
 * 是 hub 内私有 closure,通过 `boundaryAttachment` 可选缝注入 runDeps。
 *
 * 测试矩阵:
 *   a. 长 messages → proactive compact 触发 → attachment 注入;
 *   b. 焦点 text > 240 → 截 240(attachment 文本含 ≤240,不超 240);
 *   c. history entries > 120 → 每条截 120;
 *   d. history 5 条 → 仅最近 3 条进 attachment;
 *   e. session.taskFocus undefined → runDeps 不注入 boundaryAttachment →
 *      行为 byte-identical(helper 早退)。
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

// Stub runVerifyLoop BEFORE importing the hub (mirrors goal-seam.test.ts
// pattern). vi.mock is hoisted, so the mock fn must be declared via
// vi.hoisted to be initialized before the factory runs.
const { runVerifyLoopMock } = vi.hoisted(() => {
  const fn = vi.fn(
    async (opts: {
      runFn: (
        text: string,
        o?: { signal?: AbortSignal; priorMessages?: ReadonlyArray<unknown> }
      ) => Promise<{
        result: {
          readonly finalText: string | null;
          readonly messages: ReadonlyArray<unknown>;
          readonly turnCount: number;
          readonly stopReason: "completed";
          readonly lastUsage: null;
        };
        trace: unknown;
      }>;
    }) => {
      const r = await opts.runFn("ignored", {});
      return {
        result: r.result,
        trace: r.trace,
        rounds: 0,
        enabled: true,
        outcome: "passed" as const,
        records: [],
      };
    }
  );
  return { runVerifyLoopMock: fn };
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

import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  pinGoal,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
  type TaskFocusHistoryEntry,
  type TaskFocusState,
} from "../../src/session-api/store/index.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { VerifyConfig } from "../../src/harness/verify/types.ts";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";

let baseDir: string;
let sessionDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-taskfocus-compact-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

afterEach(() => {
  runVerifyLoopMock.mockClear();
});

/** Build a long user message (~33 tokens via estimate: ceil(132/4) * 4/3 ≈ 44). */
function longUserMessage(index: number): AnthropicNativeMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `prior-msg-${index} ${"z".repeat(120)}`,
      },
    ],
  };
}

/** Seed a session file with `messages` + `taskFocus` (current focus + history). */
async function seedSession(opts: {
  readonly id: string;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly taskFocus?: TaskFocusState;
  readonly goal?: SessionFileV1["goal"];
}): Promise<void> {
  const base = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    messages: opts.messages,
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    title: "",
    cwd: process.cwd(),
    sanitized_at: new Date().toISOString(),
    checkpoints: [],
    ...(opts.taskFocus !== undefined ? { taskFocus: opts.taskFocus } : {}),
    ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
  } satisfies Omit<SessionFileV1, never>;
  await store.save({ id: opts.id, file: base });
}

/** Extract text from a user message (first text block). */
function textOf(msg: AnthropicNativeMessage): string {
  const block = msg.content.find(
    (b): b is { type: "text"; text: string } => b.type === "text"
  );
  return block ? block.text : "";
}

describe("hub boundaryAttachment 接线 — taskFocus compact 边界 (#458 T7 SC11)", () => {
  /**
   * Multi-turn stub responses: 20 tool-call turns + 1 completed turn.
   * Proactive compact check fires when `state.turnCount > lastCompactTurn`,
   * so the run must have at least one continuing turn (tool call) before
   * the threshold check can run on iteration 2+. The 50 prior messages
   * (~2200 estimated tokens) easily exceed the 1000-token threshold.
   */
  function buildResponses(n: number) {
    const BIG_TEXT = "payload ".repeat(40);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(
        assistantResult({
          texts: [BIG_TEXT],
          toolCalls: [{ id: `call-${i}`, name: "noop", input: { i } }],
        })
      );
    }
    out.push(
      assistantResult({
        texts: ["completed"],
        toolCalls: [],
        supplierStop: "success",
      })
    );
    return out;
  }

  it("taskFocus 在场 + 长 messages → proactive compact 触发 → attachment user 消息在 messages 内", async () => {
    const id = "long-with-focus";
    // 当前焦点 300+ 字符,history 5 条各 200+ 字符 — 验证 truncation 与 cap 3。
    const longFocus = "FOCUS-" + "x".repeat(300);
    const history: ReadonlyArray<TaskFocusHistoryEntry> = [
      { text: "H1-" + "y".repeat(200), updatedAt: "2026-01-01T00:00:00.000Z" },
      { text: "H2-" + "y".repeat(200), updatedAt: "2026-01-01T00:00:01.000Z" },
      { text: "H3-" + "y".repeat(200), updatedAt: "2026-01-01T00:00:02.000Z" },
      { text: "H4-" + "y".repeat(200), updatedAt: "2026-01-01T00:00:03.000Z" },
      { text: "H5-" + "y".repeat(200), updatedAt: "2026-01-01T00:00:04.000Z" },
    ];
    const taskFocus: TaskFocusState = {
      text: longFocus,
      updatedAt: "2026-01-01T00:00:10.000Z",
      history,
    };
    // 50 条长 prior(每条 ~33 tokens → estimate 总 ~2200 tokens > 1000 阈值)。
    const prior = Array.from({ length: 50 }, (_, i) => longUserMessage(i));
    await seedSession({ id, messages: prior, taskFocus });

    // deps: 带 compress 配置 + 高 maxTurns(脚本化 stub 20+1 turns,默认 5 不足)。
    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const verifyConfig: VerifyConfig = { command: "/bin/true" };
    const hub = new SessionHub({ store, deps, verifyConfig });

    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    // 从 store 重新读盘:attachment 是 conditionalSave 落盘 result.messages
    // 的一部分,DTO 的 turn.answer 不直接暴露中间 messages。
    const loaded = await store.load(id);

    // 找到 attachment user 消息:文本以 focus 截 240 开头 + 含历史标记。
    const attachmentMsg = loaded.messages.find((m) => {
      if (m.role !== "user") return false;
      const t = textOf(m);
      // 必须含 focus 截 240 的前 8 字符(避免与首条 prior "prior-msg-..." 冲突)。
      return t.startsWith("FOCUS-" + "x".repeat(8));
    });
    expect(attachmentMsg).toBeDefined();
    const attachmentText = textOf(attachmentMsg!);

    // (b) 当前焦点截 240:attachment 文本以 focus 前 240 字符开头。
    const focusSegment = "FOCUS-" + "x".repeat(234); // 6 + 234 = 240 chars
    assert.ok(
      attachmentText.startsWith(focusSegment),
      `attachment must start with focus truncated to 240 chars; got prefix: ${attachmentText.slice(
        0,
        30
      )}...`
    );
    // 紧接的字符不应是 "x"(因为 focus 已被切到 240;再下一段是 "\n---\n")。
    assert.equal(
      attachmentText.slice(240, 245),
      "\n---\n",
      "focus 240 字符后必须紧接 '\n---\n' 分隔"
    );

    // (c) history 每条截 120:H1 文本前 120 字符为 "H1-" + "y".repeat(117)。
    assert.ok(
      attachmentText.includes("H1-" + "y".repeat(117)),
      "history[0] 前 120 字符必须出现 (截 120)"
    );
    // 121+ 字符不应出现:确认 truncation 而非原样保留。
    assert.ok(
      !attachmentText.includes("H1-" + "y".repeat(118)),
      "history[0] >120 字符必须被截断 (slice 120)"
    );

    // (d) history cap 3:最近 3 条 H1/H2/H3 出现,H4/H5 不出现。
    assert.ok(attachmentText.includes("H1-"), "history[0] 必须在");
    assert.ok(attachmentText.includes("H2-"), "history[1] 必须在");
    assert.ok(attachmentText.includes("H3-"), "history[2] 必须在");
    assert.ok(!attachmentText.includes("H4-"), "history[3] 必须不在 (cap 3)");
    assert.ok(!attachmentText.includes("H5-"), "history[4] 必须不在 (cap 3)");

    // (e) attachment 文本以最终 history 段结尾(≤120),无截断超 720 后残留。
    assert.ok(
      attachmentText.length <= 720,
      `总长 cap 720 字符;实际 ${attachmentText.length}`
    );
  });

  it("session.taskFocus undefined → runDeps 不注入 boundaryAttachment → attachment 不出现", async () => {
    const id = "no-task-focus";
    // 长 messages 但 taskFocus undefined。
    const prior = Array.from({ length: 50 }, (_, i) => longUserMessage(i));
    await seedSession({ id, messages: prior });

    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const hub = new SessionHub({ store, deps });

    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");

    const loaded = await store.load(id);
    // compact 触发 → 有 placeholder;但 attachment 不出现(taskFocus 缺席)。
    const serialized = JSON.stringify(loaded.messages);
    assert.ok(
      serialized.includes("[compaction boundary — earlier messages cleared]"),
      "taskFocus 缺席时 compact 仍应触发 (compress 配置),有 placeholder"
    );
    // attachment 仅由 boundaryAttachment 渲染;hub 未注入 → 不出现。
    // The FOCUS- prefix is the test-only marker used by renderTaskFocusBoundary
    // (when taskFocus present); its absence proves boundaryAttachment was NOT
    // attached — helper 早退 = byte-stable.
    assert.ok(
      !serialized.includes("FOCUS-"),
      "taskFocus undefined → attachment 不应出现 (boundaryAttachment 未注入)"
    );
    // T2/T5 SC2:首次 postMessage 后 conditionalSave 会 seed taskFocus
    // (extractGoal(result.messages) → placeholder text post-compact,非"go")。
    // 这里仅断言 seed 路径生效, 不断言 seed 文本(compact 后首个 user message
    // 是 boundary placeholder,与 pre-#458 byte-identical)。
    assert.ok(
      loaded.taskFocus !== undefined,
      "taskFocus undefined → conditionalSave 应 seed taskFocus (T2/T5 SC2)"
    );
    assert.ok(
      (loaded.taskFocus?.text ?? "").length > 0,
      "seeded taskFocus.text 非空"
    );
  });

  it("active /goal: compact does not inject taskFocus as the mission", async () => {
    const id = "goal-active-no-focus-mission";
    const taskFocus: TaskFocusState = {
      text: "FOCUS-" + "x".repeat(40),
      updatedAt: "2026-01-01T00:00:10.000Z",
      history: [],
    };
    const prior = Array.from({ length: 50 }, (_, i) => longUserMessage(i));
    await seedSession({
      id,
      messages: prior,
      taskFocus,
      goal: pinGoal({
        current: undefined,
        text: "ship the type checker",
        now: "2026-01-01T00:00:00.000Z",
      }),
    });
    const baseDeps = makeDeps(buildResponses(20));
    const deps = {
      ...baseDeps,
      maxTurns: 30,
      compress: { contextWindow: 200_000, thresholdTokens: 1000 },
    };
    const hub = new SessionHub({
      store,
      deps,
      verifyConfig: { command: "/bin/true" },
    });
    const res = await hub.postMessage({ conversationId: id, text: "go" });
    assert.equal(res.turn.answer.stopReason, "completed");
    const loaded = await store.load(id);
    const serialized = JSON.stringify(loaded.messages);
    assert.ok(
      serialized.includes("[compaction boundary — earlier messages cleared]"),
      "compact still fires"
    );
    assert.ok(
      !serialized.includes("FOCUS-"),
      "auto mode must not inject taskFocus attachment"
    );
  });
});
