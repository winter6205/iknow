# Trajectory Eval Harness 规格（iknow）

> 状态：**IMPLEMENTED**（独立 iknow 运行时）。  
> 运行：`npm run eval` → 写入 `docs/eval/results/trajectory-suite-latest.json`（gitignore）。  
> 实现：`src/eval/score-trajectory.ts` + `src/eval/run-suite.ts`。  
> 评分框架来源：P2-plan.md §1.2。

## 1. 输入

### 1.1 eval 集

`eval-set.draft.json` 的 `samples[]`，每条含：

- `id`, `category`, `input`
- `expected.required_tools` / `recommended_tools` / `optional_tools`
- `expected.policies`（如 "G2必填", "hops<=5"）
- `max_steps`

### 1.2 tool_call 日志（Phase 3 产出）

Agent 跑完一条 sample 后产出的调用序列：

```json
{
  "sample_id": "qa-hard-001",
  "tool_calls": [
    { "tool": "kb_retrieve", "args": {...}, "ts": 1 },
    { "tool": "kb_governance", "args": {...}, "ts": 2 },
    { "tool": "kb_verify_citation", "args": {...}, "ts": 3 }
  ],
  "final_answer": "...",
  "output_fields": { "source_span": [...], "snapshot_id": [...] }
}
```

## 2. 打分公式（P2-plan §1.2 落地）

```
required_coverage = |called ∩ required| / |required|
recommended_coverage = |called ∩ recommended| / |recommended|   # 分母为0时记1.0
efficiency = 1 - max(0, len(tool_calls) - max_steps) / max_steps  # 超步数线性扣分，下限0
outcome_match = 1.0 if 硬约束全过 and 答案与 expected 一致 else 0.0

trajectory_score = (required_coverage*0.6 + recommended_coverage*0.3 + efficiency*0.1) * outcome_match
```

**示例**：`qa-hard-001`（required=[retrieve,governance], recommended=[verify], max_steps=10）

- 实际调用 [retrieve, governance, verify]，步数 3 → required=1.0, recommended=1.0, efficiency=1.0
- outcome_match=1.0（硬约束过、答案一致）
- trajectory_score = (0.6+0.3+0.1)*1.0 = **1.0**

## 3. 硬约束检查（一票否决，先于软分）

逐条比对 `expected.policies` + 全局硬约束（eval-gate.draft.md §1）：

- G2 必填：output_fields.snapshot_id 非空
- 溯源三层：claim→source_span→snapshot_id 齐全
- 空结果不编造（edge-002）
- 冲突走治理（hard-001）
- 过期拦截（edge-003）
- 权限拒绝（edge-004）
- hops<=5：tool_calls 跳数 ≤ max_steps 且 ≤5

任一失败 → outcome_match=0，整体 sample 判 FAIL。

## 4. 输出 schema

```json
{
  "sample_id": "qa-hard-001",
  "trajectory_score": 1.0,
  "hard_constraints": { "all_pass": true, "failed": [] },
  "policy_violations": [],
  "notes": ""
}
```

聚合：`per_category_pass_rate` + `global_hard_violation_list`（供 eval-gate 门禁比对）。

## 5. 与 eval-gate 的绑定

- eval-gate.draft.md §1 硬约束 → 本文 §3 检查项（逐条映射）
- eval-gate.draft.md §2 软指标 → 本文 §2 trajectory_score 为其中一项，其余（Hit@K 等）需 gbrain 后端
- eval-gate §4 分层通过线 → 用本文输出按 category 聚合比对

## 6. 运行方式（已实现）

```bash
npm run typecheck
npm test          # includes tests/trajectory.test.ts
npm run eval      # 32 samples → docs/iknow-spec/docs/eval/results/trajectory-suite-latest.json
```

| 模块         | 路径                                                                         |
| ------------ | ---------------------------------------------------------------------------- |
| CLI          | `src/eval/cli.ts`                                                            |
| Suite runner | `src/eval/run-suite.ts`（`runEvalSuite` / `runSample` / `loadEvalSet`）      |
| Scorer       | `src/eval/score-trajectory.ts`（`scoreTrajectory` / `checkHardConstraints`） |
| Types        | `src/eval/types.ts`                                                          |
| Agent logs   | `IknowAnswer.tool_calls` via `src/agent-loop/trace.ts`                       |

Sprint-1 gates（report + CLI exit）：`hard_pass_rate >= 1.0`，`mean_trajectory_score >= 0.6`。

后续可选：真实索引 / LLM tool_calls 历史（ADR §1）接入后复用同一 scorer 契约。
