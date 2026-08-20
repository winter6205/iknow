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
import { ACI_TOOLSET_NAMES } from "../../../src/harness/aci/tools/registry.ts";

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
    // #358 T7: 接口新增只读枚举面 —— fake 补全保持结构兼容。
    listSubagents() {
      return [];
    },
  };
  return { manager, captured: () => captured };
}

/**
 * #357 T2 — 判官 allow-list 推导真值。
 *
 * 判官白名单基线（spec 357 Objective 2 + plans T2 acceptance 2）：
 * 「只许本地纯只读」= read_file / grep / glob。fail-closed 推导：
 *   disallowedTools = ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE
 *
 * 加白名单 = 显式改 JUDGE_ALLOWED_BASELINE 常量 + operator 拍板。
 */
const JUDGE_ALLOWED_BASELINE: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** 推导真值 = 全量 ACI 工具面 − 白名单基线（与 run-classifier-adapter 推导公式同源）。 */
const JUDGE_DISALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze(
  [...ACI_TOOLSET_NAMES].filter((n) => !JUDGE_ALLOWED_BASELINE.includes(n))
);

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

  it("SC9: def.disallowedTools = 全量 ACI 工具面 − 白名单基线（fail-closed allow-list 推导）", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    await runClassifier({
      task: "x",
      summary: "",
      finalText: null,
      cwd: "/tmp",
    });
    const def = captured()!;
    assert.equal(def.excludeFromHostDrain, true, "判官结果不得进 host-drain");
    // fail-closed: 全量面减去白名单三件 = 全量面 − {read_file, grep, glob}。
    assert.deepEqual(
      [...def.disallowedTools].sort(),
      [...JUDGE_DISALLOWED_TOOLS].sort(),
      "disallowedTools must equal ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE"
    );
    // 白名单三件必须缺席（允许判官使用）。
    for (const allowed of JUDGE_ALLOWED_BASELINE) {
      assert.ok(
        !def.disallowedTools!.includes(allowed),
        `白名单工具 ${allowed} 必须不在 disallowedTools 内`
      );
    }
  });

  it("#357 T2: 白名单为空时判官零工具可装配（pure-text 路径边界）", () => {
    // 推导公式: deny = 全量面 − 白名单。白名单 = ∅ → deny = 全量面。
    // 这条 spec Testing Strategy「白名单空 → 判官零工具仍可装配」边界条件
    // 由本测试守护（fail-closed 推导边界）。判官工厂实际产物是 deny 数组,
    // 真零工具的运行时验证在 worker-tool-surface.test.ts C 段「deny 全量」
    // 已覆盖等价语义——此处仅锁推导公式正确性。
    const emptyAllow: ReadonlyArray<string> = Object.freeze([]);
    const computedDeny = [...ACI_TOOLSET_NAMES].filter(
      (n) => !emptyAllow.includes(n)
    );
    assert.deepEqual(
      computedDeny,
      [...ACI_TOOLSET_NAMES],
      "白名单空 → deny = 全量面（fail-closed）"
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

/* ------------------------------ #357 code-review fix: 判官 sandboxRoot 继承 ------------------------------ */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createSubAgentManager } from "../../../src/harness/subagent/manager.js";
import type { WorkerEnvelope } from "../../../src/harness/subagent/envelope.js";

/**
 * #357 code-review fix 回归测试（Standards+Spec 双轴 Medium）：
 * 判官 def 不显式传 sandboxRoot → manager 单点校验走 SC8 继承路径。
 *
 * 修复前形态：adapter 把 `sandboxRoot: cwd`（= process.cwd()）钉进 def ——
 * serve 显式 sandboxRoot 配置下 cwd ≠ manager parent root，判官 spawn 每轮
 * 被 T1 校验拒绝（SubAgentSandboxRootError）→ catch 吞成 crashed envelope，
 * verify 静默空转。修复后：字段省略 → envelope.sandboxRoot = parent root。
 */
describe("#357 判官 spawn 锚 — 省略 sandboxRoot 走 SC8 继承（parent ≠ cwd 场景）", () => {
  it("真实 manager（parent sandboxRoot ≠ process.cwd()）→ 判官 spawn 成功且继承父根", async () => {
    const parent = mkdtempSync(join(tmpdir(), "judge-anchor-"));
    try {
      const spawnCalls: {
        def: SubAgentDefinition;
        payload: WorkerEnvelope;
      }[] = [];
      const manager = createSubAgentManager({
        spawn: (def, _taskId, payload) => {
          spawnCalls.push({ def, payload });
          const stdout = new PassThrough();
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout,
            stderr: new PassThrough(),
            pid: 99,
            kill: () => true,
            exitCode: null,
            signalCode: null,
          });
          // spawn 后异步 emit 合法 pass envelope → manager completed 终态，
          // waitFor 快速收敛（不挂 120s 缺省 timeout）。
          setImmediate(() => {
            stdout.write(
              JSON.stringify({
                status: "ok",
                summary: "judge done",
                result: PASS_JUDGE_JSON,
              }) + "\n"
            );
            (child as EventEmitter).emit("exit", 0, null);
          });
          return child as unknown as ChildProcess;
        },
        sandboxRoot: parent,
      });
      const runClassifier = createRunClassifierFromManager({
        manager,
        timeoutMs: 10_000,
      });
      // cwd 显式传 process.cwd()（≠ parent）——修复前该值会被钉进 def.sandboxRoot
      // 触发越界拒绝；修复后 adapter 不消费 cwd。
      const result = await runClassifier({
        task: "judge the work",
        summary: "",
        finalText: null,
        cwd: process.cwd(),
      });
      assert.equal(result.status, "ok", "判官全链路正常收尾（未被校验拒绝）");
      assert.equal(spawnCalls.length, 1, "判官 spawn 未被收窄校验拒绝");
      assert.equal(
        spawnCalls[0]!.def.sandboxRoot,
        undefined,
        "def 不显式钉 sandboxRoot（省略 = 继承）"
      );
      assert.equal(
        spawnCalls[0]!.payload.sandboxRoot,
        realpathSync(parent),
        "envelope 继承 manager parent sandboxRoot（SC8），不是 process.cwd()"
      );
      assert.notEqual(spawnCalls[0]!.payload.sandboxRoot, process.cwd());
      await manager.shutdown();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
