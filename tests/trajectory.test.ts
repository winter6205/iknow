import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkHardConstraints,
  scoreTrajectory,
} from "../src/eval/score-trajectory.ts";
import { loadEvalSet, runEvalSuite, runSample } from "../src/eval/run-suite.ts";
import type { TrajectoryRunLog } from "../src/eval/types.ts";

describe("scoreTrajectory pure math", () => {
  it("scores full required+recommended coverage at 1.0 when hard pass", () => {
    const sample = {
      id: "qa-hard-001",
      category: "hard",
      input: "冲突",
      max_steps: 10,
      expected: {
        required_tools: ["kb_retrieve", "kb_governance"],
        recommended_tools: ["kb_verify_citation"],
        policies: ["G2必填", "hops<=5", "冲突走 kb_governance 而非臆断"],
      },
    };
    const log: TrajectoryRunLog = {
      sample_id: sample.id,
      tool_calls: [
        { tool: "kb_retrieve", args: {}, ts: 1 },
        { tool: "kb_verify_citation", args: {}, ts: 2 },
        { tool: "kb_governance", args: {}, ts: 3 },
      ],
      final_answer: "冲突 请以治理标注为准",
      output_fields: {
        source_span: [{ chunk_id: "c1", quote: "x" }],
        snapshot_id: "snap_abc",
        governance_status: "conflict",
        hops_used: 2,
      },
    };
    const s = scoreTrajectory(sample, log);
    assert.equal(s.required_coverage, 1);
    assert.equal(s.recommended_coverage, 1);
    assert.equal(s.efficiency, 1);
    assert.ok(s.hard_constraints.all_pass, s.hard_constraints.failed.join(","));
    assert.ok(Math.abs(s.trajectory_score - 1) < 1e-9, String(s.trajectory_score));
  });

  it("zeros outcome when G2 missing", () => {
    const sample = {
      id: "qa-easy-001",
      category: "easy",
      input: "退款",
      max_steps: 10,
      expected: {
        required_tools: ["kb_retrieve"],
        policies: ["G2必填", "hops<=5"],
      },
    };
    const log: TrajectoryRunLog = {
      sample_id: sample.id,
      tool_calls: [{ tool: "kb_retrieve", args: {}, ts: 1 }],
      final_answer: "根据企业知识库：\n• hi",
      output_fields: {
        source_span: [{ chunk_id: "c1" }],
        snapshot_id: "",
        governance_status: "ok",
        hops_used: 1,
      },
    };
    const s = scoreTrajectory(sample, log);
    assert.equal(s.outcome_match, 0);
    assert.equal(s.trajectory_score, 0);
    assert.ok(s.hard_constraints.failed.includes("G2必填"));
  });
});

describe("live agent trajectory", () => {
  it("qa-easy-001 produces tool_calls + G2", () => {
    const set = loadEvalSet();
    const sample = set.samples.find((s) => s.id === "qa-easy-001");
    assert.ok(sample);
    const { log, score } = runSample(sample!);
    assert.ok(log.tool_calls.length >= 1);
    assert.ok(log.tool_calls.every((c) => c.tool && c.ts >= 1));
    assert.ok(log.output_fields.snapshot_id.startsWith("snap_"));
    assert.ok(score.required_coverage > 0);
  });

  it("qa-edge-004 denies competitor", () => {
    const set = loadEvalSet();
    const sample = set.samples.find((s) => s.id === "qa-edge-004");
    assert.ok(sample);
    const { log, score } = runSample(sample!);
    assert.ok(log.tool_calls.some((c) => c.tool === "kb_governance"));
    assert.match(log.final_answer, /拒绝|越权/);
    assert.ok(
      score.hard_constraints.all_pass ||
        score.policy_violations.every((v) => !v.includes("G2")),
    );
  });
});

describe("runEvalSuite", () => {
  it("scores all 32 samples and writes aggregate", () => {
    const report = runEvalSuite();
    assert.equal(report.results.length, 32);
    assert.equal(report.aggregate.total, 32);
    assert.ok(report.aggregate.mean_trajectory_score >= 0);
    assert.ok(report.aggregate.hard_pass_rate >= 0);
    // Sprint-1: mean trajectory soft target
    assert.ok(
      report.aggregate.mean_trajectory_score >= 0.5,
      `mean=${report.aggregate.mean_trajectory_score}`,
    );
  });
});

describe("checkHardConstraints unit", () => {
  it("flags hops over 5", () => {
    const sample = {
      id: "x",
      category: "easy",
      input: "q",
      max_steps: 10,
      expected: { policies: ["hops<=5", "G2必填"], required_tools: ["kb_retrieve"] },
    };
    const r = checkHardConstraints(sample, {
      sample_id: "x",
      tool_calls: [{ tool: "kb_retrieve", args: {}, ts: 1 }],
      final_answer: "根据企业知识库：\n• a",
      output_fields: {
        source_span: [{ chunk_id: "c" }],
        snapshot_id: "snap_x",
        governance_status: "ok",
        hops_used: 9,
      },
    });
    assert.equal(r.all_pass, false);
    assert.ok(r.failed.includes("hops<=5"));
  });
});
