/**
 * Judge-input upgrade: EvidenceContext (the evidence checklist) reaches the judge.
 *
 * Coverage:
 *   - task = userText byte-for-byte (no re-binding); evidenceContext is never
 *     concatenated into task;
 *   - JUDGE_ROLE declaration side: the derived disallowedTools stays as-is
 *     and systemPrompt must not leak evidenceContext (declaration frozen);
 *   - fix for an existing contract breach: the lambda destructuring finalText
 *     no longer silently drops it;
 *   - empty/invalid boundary: empty-shape evidenceContext (reasons=[],
 *     executedCommands=[], evidenceSummary="") still lets the judge run.
 *
 * Reuses the SubAgentManager seam from run-classifier-adapter.ts: the stub
 * manager only implements spawn + waitFor (other methods are no-ops, relying
 * on TypeScript structural typing).
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

/* ------------------------------ test doubles ------------------------------ */

/** Judge pass envelope (satisfies the parseClassifierResult three-state contract). */
const PASS_JUDGE_JSON = JSON.stringify({
  kind: "pass",
  reason: "verified",
  evidence: [{ command: "noop", result: "pass" }],
});

interface StubManagerOpts {
  /** Custom waitFor return (default = judge pass envelope). */
  readonly envelope?: SubAgentEnvelope;
  /** Custom spawn handler (default = capture def and return t1). */
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
    getCapacity() {
      return 15;
    },
    subscribe() {
      return () => {};
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
    // The manager interface gained a read-only enumeration surface; the fake
    // implements it to stay structurally compatible.
    listSubagents() {
      return [];
    },
  };
  return { manager, captured: () => captured };
}

/**
 * Judge allow-list derivation ground truth.
 *
 * Judge whitelist baseline — "local pure read-only only" = read_file / grep /
 * glob. fail-closed derivation:
 *   disallowedTools = ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE
 *
 * Widening the whitelist = explicitly changing the JUDGE_ALLOWED_BASELINE
 * constant with operator sign-off.
 */
const JUDGE_ALLOWED_BASELINE: ReadonlyArray<string> = Object.freeze([
  "read_file",
  "grep",
  "glob",
]);

/** Derived ground truth = full ACI tool surface − whitelist baseline (same formula as run-classifier-adapter). */
const JUDGE_DISALLOWED_TOOLS: ReadonlyArray<string> = Object.freeze(
  [...ACI_TOOLSET_NAMES].filter((n) => !JUDGE_ALLOWED_BASELINE.includes(n))
);

/* ------------------------------ evidence-aware judge input ------------------------------ */

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

  it("SC6: evidenceContext 在场时 def.task === userText 且不含 evidence JSON", async () => {
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
      finalText: "truncated transcript stays out of task",
      cwd: "/tmp",
      evidenceContext,
    });
    const def = captured()!;
    assert.equal(
      def.task,
      "implement goal",
      "task must equal userText / goal.text"
    );
    assert.ok(
      !def.task.includes("checkerVerdict"),
      "task must not contain evidenceContext JSON"
    );
    assert.ok(
      !def.task.includes("truncated transcript"),
      "finalText must not be concatenated into task"
    );
    assert.equal(def.maxTurns, 2, "judge inner maxTurns stays 2");
    assert.equal(
      def.role,
      "judge",
      "judge spawn must not use default iknow role"
    );
  });

  it("Spec High: spawn def.task 是 identity；截断对话与 evidenceContext 在非 task 字段", async () => {
    const { manager, captured } = makeStubManager();
    const runClassifier = createRunClassifierFromManager({ manager });
    const goalText = "ship the verify goal gate";
    const truncated = "TRUNCATED_HOST_DIALOGUE_NOT_IN_TASK";
    const evidenceContext: EvidenceContext = {
      checkerVerdict: "EVIDENCE_INSUFFICIENT",
      reasons: ["no bash test execution before claim found"],
      executedCommands: ["npx vitest run"],
      rerunAttempted: false,
      evidenceSummary: "npx vitest run exit=1 green=false",
    };
    await runClassifier({
      task: goalText,
      summary: "",
      finalText: truncated,
      cwd: "/tmp",
      evidenceContext,
    });
    const def = captured()!;
    assert.equal(def.task, goalText, "task must equal goal.text identity");
    assert.ok(
      !def.task.includes("checkerVerdict"),
      "task must not include checkerVerdict JSON"
    );
    assert.ok(
      !def.task.includes(truncated),
      "truncated dialogue must not be concatenated into task"
    );
    assert.equal(
      def.finalText,
      truncated,
      "truncated dialogue must be an independent spawn field"
    );
    assert.deepEqual(
      def.evidenceContext,
      evidenceContext,
      "evidenceContext must be an independent spawn field"
    );
    assert.equal(def.maxTurns, 2, "judge inner maxTurns stays 2");
    assert.equal(def.role, "judge");
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
    // fail-closed: full ACI surface minus the 3 whitelist items = surface − {read_file, grep, glob}.
    assert.deepEqual(
      [...def.disallowedTools].sort(),
      [...JUDGE_DISALLOWED_TOOLS].sort(),
      "disallowedTools must equal ACI_TOOLSET_NAMES − JUDGE_ALLOWED_BASELINE"
    );
    // The 3 whitelist tools must be absent (the judge is allowed to use them).
    for (const allowed of JUDGE_ALLOWED_BASELINE) {
      assert.ok(
        !def.disallowedTools!.includes(allowed),
        `白名单工具 ${allowed} 必须不在 disallowedTools 内`
      );
    }
  });

  it("#357 T2: 白名单为空时判官零工具可装配（pure-text 路径边界）", () => {
    // Derivation formula: deny = full surface − whitelist. whitelist = ∅ → deny
    // = full surface. This guards the "empty whitelist → judge still assembles
    // with zero tools" boundary (fail-closed derivation edge). The judge factory
    // actually produces a deny array; the real zero-tool runtime verification is
    // covered by worker-tool-surface.test.ts section C ("deny everything") —
    // this test only pins the derivation formula's correctness.
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
    // absent
    await runClassifier({
      task: "x",
      summary: "",
      finalText: null,
      cwd: "/tmp",
    });
    const def1 = captured()!;
    // present
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
    // Fixes an existing contract breach: the old adapter dropped finalText in
    // destructuring. Here we only confirm the lambda accepts finalText without
    // throwing and spawn is called normally (consumption follows the adapter's
    // current state — summary already carries finalText, so the adapter need
    // not consume it again).
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
    assert.equal(
      def.task,
      "goal text",
      "empty-shape evidenceContext must not alter task"
    );
    assert.ok(
      !def.task.includes("checkerVerdict"),
      "empty-shape evidenceContext must not be JSON-appended onto task"
    );
  });
});

/* ------------------------------ judge sandboxRoot inheritance ------------------------------ */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createSubAgentManager } from "../../../src/harness/subagent/manager.js";
import type { WorkerEnvelope } from "../../../src/harness/subagent/envelope.js";

/**
 * Regression test: the judge def omits sandboxRoot → the manager's single-point
 * validation inherits the parent sandbox root.
 *
 * Before the fix: the adapter pinned `sandboxRoot: cwd` (= process.cwd()) into
 * the def — under an explicit serve sandboxRoot config, cwd ≠ the manager
 * parent root, so every judge spawn was rejected by sandbox-root validation
 * (SubAgentSandboxRootError); the catch swallowed it into a crashed envelope
 * and verify silently spun. After the fix: field omitted →
 * envelope.sandboxRoot = parent root.
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
          // Emit a valid pass envelope asynchronously after spawn → manager
          // reaches the completed terminal state and waitFor converges fast
          // (never hangs on the 120s default timeout).
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
      // cwd is explicitly process.cwd() (≠ parent) — before the fix this value
      // was pinned into def.sandboxRoot and rejected as out-of-bounds; after the
      // fix the adapter does not consume cwd.
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
