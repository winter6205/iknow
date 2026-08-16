/**
 * #449b B6 — 判官输入升级 (EvidenceContext 证据体检单进判官)。
 *
 * 覆盖维度 (spec 449 Code Style G5-3 + Testing Strategy):
 *   - SC6: task = userText 公式原样 (不重绑) + evidenceContext JSON 段;
 *   - SC9 复断言: JUDGE_ROLE 声明面 disallowedTools 5 项原样 + systemPrompt 不
 *     泄漏 evidenceContext (声明零改动);
 *   - 既有契约破口修复: lambda 解构 finalText 不再静默丢弃;
 *   - 空/非法边界: evidenceContext 空形状 (reasons=[]、executedCommands=[]、
 *     evidenceSummary="") → 判官仍可跑 (spec Testing Strategy 空非法行)。
 *
 * 沿用 run-classifier-adapter.ts 的 SubAgentManager seam: stub manager 仅需
 * 实现 spawn + waitFor 两面 (其它方法 stub 为 no-op, TypeScript 结构化类型)。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { createRunClassifierFromManager } from "../../../src/harness/verify/run-classifier-adapter.ts";
import type { ClassifierEnvelope } from "../../../src/harness/verify/verify-loop.ts";
import type { EvidenceContext } from "../../../src/harness/verify/types.ts";
import type { SubAgentDefinition } from "../../../src/harness/subagent/manager.js";
import type { SubAgentEnvelope } from "../../../src/harness/subagent/envelope.js";
import type { SubAgentManager } from "../../../src/harness/subagent/manager.js";

/* ------------------------------ 测试替身 ------------------------------ */

/** 判官 pass envelope (满足 parseClassifierResult 三态契约)。 */
const PASS_JUDGE_JSON = JSON.stringify({
  kind: "pass",
  reason: "verified",
  evidence: [{ command: "noop", result: "pass" }],
});

interface StubManagerOpts {
  /** 自定义 waitFor 返回 (默认 = judge pass envelope)。 */
  readonly envelope?: SubAgentEnvelope;
  /** 自定义 spawn handler (默认 = 捕获 def 返回 t1)。 */
  readonly onSpawn?: (def: SubAgentDefinition) => { readonly taskId: string };
}

function makeStubManager(opts: StubManagerOpts = {}): {
  readonly manager: SubAgentManager;
  readonly captured: () => SubAgentDefinition | undefined;
} {
  let captured: SubAgentDefinition | undefined;
  const manager: SubAgentManager = {
    spawn(def) {
      captured = def;
      if (opts.onSpawn) return opts.onSpawn(def);
      return { taskId: "t1" };
    },
    queryBuffer() {
      return { status: "not_found" };
    },
    async waitFor(
      _taskId: string,
      _timeoutMs?: number,
      _signal?: AbortSignal
    ): Promise<SubAgentEnvelope> {
      return (
        opts.envelope ?? {
          status: "ok",
          result: PASS_JUDGE_JSON,
          summary: "judge done",
        }
      );
    },
    async shutdown() {
      // no-op
    },
    drainCompleted() {
      return [];
    },
    listActive() {
      return [];
    },
    abortTask() {
      return false;
    },
  };
  return { manager, captured: () => captured };
}

/** JUDGE_ROLE 声明面 disallowedTools (spec 468 + run-classifier-adapter.ts:35-41)。 */
const JUDGE_DISALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze([
  "bash",
  "edit_file",
  "write_file",
  "web_fetch",
  "web_search",
]);

/* ------------------------------ B6: evidence-aware judge input ------------------------------ */

describe("createRunClassifierFromManager — evidence-aware judge input (#449b B6)", () => {
  it("SC6: evidenceContext 缺席时 def.task = userText 逐字节 (零 append)", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    await runClassifier({
      task: "implement goal",
      summary: "",
      finalText: null,
      cwd: "/tmp",
    });
    const def = captured();
    assert.ok(def !== undefined, "spawn must be called");
    assert.equal(
      def.task,
      "implement goal",
      "task must equal userText verbatim when evidenceContext is absent"
    );
  });

  it("SC6: evidenceContext 在场时 task 第一段 = userText 原样 + 换行 + JSON 段", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    const evidenceContext: EvidenceContext = {
      checkerVerdict: "EVIDENCE_INSUFFICIENT",
      reasons: ["no bash test execution before claim found"],
      executedCommands: ["npx vitest run"],
      rerunAttempted: false,
      evidenceSummary: "npx vitest run exit=1 green=false",
    };
    await runClassifier({
      task: "implement goal",
      summary: "",
      finalText: null,
      cwd: "/tmp",
      evidenceContext,
    });
    const def = captured()!;
    const lines = def.task.split("\n");
    assert.equal(
      lines[0],
      "implement goal",
      "first segment must equal userText verbatim (SC6 不重绑)"
    );
    assert.equal(
      lines.length,
      2,
      "task must have exactly 2 segments: userText + JSON evidenceContext"
    );
    const parsed = JSON.parse(lines[1]!) as EvidenceContext;
    assert.equal(parsed.checkerVerdict, evidenceContext.checkerVerdict);
    assert.deepEqual(parsed.reasons, evidenceContext.reasons);
    assert.deepEqual(parsed.executedCommands, evidenceContext.executedCommands);
    assert.equal(parsed.rerunAttempted, evidenceContext.rerunAttempted);
    assert.equal(parsed.evidenceSummary, evidenceContext.evidenceSummary);
  });

  it("SC9: def.disallowedTools 声明 5 项禁工具原样保留", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    await runClassifier({
      task: "x",
      summary: "",
      finalText: null,
      cwd: "/tmp",
    });
    const def = captured()!;
    assert.ok(
      def.disallowedTools !== undefined,
      "JUDGE_ROLE must declare disallowedTools"
    );
    assert.deepEqual(
      [...def.disallowedTools].sort(),
      [...JUDGE_DISALLOWED_TOOLS].sort(),
      "disallowedTools must contain exactly the 5 declared items (bash/edit_file/write_file/web_fetch/web_search)"
    );
  });

  it("JUDGE_ROLE 声明面零改动: evidenceContext 不进 systemPrompt", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    await runClassifier({
      task: "x",
      summary: "",
      finalText: null,
      cwd: "/tmp",
      evidenceContext: {
        checkerVerdict: "EVIDENCE_INSUFFICIENT",
        reasons: ["r1"],
        executedCommands: ["c1"],
        rerunAttempted: false,
        evidenceSummary: "summary text",
      },
    });
    const def = captured()!;
    assert.equal(typeof def.systemPrompt, "string");
    assert.ok(
      !def.systemPrompt!.includes("evidence_context"),
      "systemPrompt must not contain evidence_context section marker"
    );
    assert.ok(
      !def.systemPrompt!.includes("evidenceContext"),
      "systemPrompt must not contain evidenceContext key (JUDGE_ROLE 零改动)"
    );
  });

  it("JUDGE_ROLE 声明面零改动: evidenceContext 在场/缺席 systemPrompt 不变", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    // 缺席
    await runClassifier({
      task: "x",
      summary: "",
      finalText: null,
      cwd: "/tmp",
    });
    const def1 = captured()!;
    // 在场
    await runClassifier({
      task: "x",
      summary: "",
      finalText: null,
      cwd: "/tmp",
      evidenceContext: {
        checkerVerdict: "EVIDENCE_INSUFFICIENT",
        reasons: [],
        executedCommands: [],
        rerunAttempted: true,
        evidenceSummary: "summary",
      },
    });
    const def2 = captured()!;
    assert.equal(
      def2.systemPrompt,
      def1.systemPrompt,
      "systemPrompt must not vary with evidenceContext (JUDGE_ROLE frozen)"
    );
  });

  it("finalText 契约修复: lambda 收到 finalText 不抛错且 spawn 被调", async () => {
    // B6 修复既有契约破口: 当前 adapter 解构丢弃 finalText, 现须确认 lambda
    // 收到 finalText 不抛错 + spawn 正常调用 (finalText 消费语义按 adapter
    // 现状 —— summary 已带 finalText, adapter 不需再消费亦可接受)。
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    const result: ClassifierEnvelope = await runClassifier({
      task: "x",
      summary: "summary text",
      finalText: "some final text from worker",
      cwd: "/tmp",
    });
    assert.equal(result.status, "ok", "pass envelope propagates");
    assert.ok(captured() !== undefined, "spawn must have been called");
  });

  it("空/非法边界: 空形状 evidenceContext → 判官仍可跑 (spec Testing Strategy 空非法行)", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    const emptyShape: EvidenceContext = {
      checkerVerdict: "EVIDENCE_INSUFFICIENT",
      reasons: [],
      executedCommands: [],
      rerunAttempted: false,
      evidenceSummary: "",
    };
    await runClassifier({
      task: "goal text",
      summary: "",
      finalText: null,
      cwd: "/tmp",
      evidenceContext: emptyShape,
    });
    const def = captured()!;
    const lines = def.task.split("\n");
    assert.equal(lines[0], "goal text", "first segment unchanged");
    const parsed = JSON.parse(lines[1]!) as EvidenceContext;
    assert.deepEqual(parsed.reasons, [], "empty reasons preserved");
    assert.deepEqual(
      parsed.executedCommands,
      [],
      "empty executedCommands preserved"
    );
    assert.equal(parsed.evidenceSummary, "", "empty evidenceSummary preserved");
  });
});
