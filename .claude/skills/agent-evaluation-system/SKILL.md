---
name: agent-evaluation-system
description: "Eval-first testing for agent systems: trajectory, outcome, and iterative improvement. Use when building evaluation sets, diagnosing agent quality issues, or establishing quality gates."
version: 0.2.0
author: Hermes
tags: [Agent, Evaluation, Testing, Trajectory, QualityAssurance]
related_skills: [agent-development-lifecycle]
---
# Agent Evaluation System

## Overview

Eval-first testing methodology for AI agent systems. Covers evaluation set construction, trajectory evaluation, iterative improvement discipline, and quantitative quality gates.

This skill is part of the agent development suite. Load `agent-development-lifecycle` for the umbrella process.

## When to Use

- Building eval set before or during agent development
- Diagnosing why agent quality is insufficient
- Deciding what to iterate on next (tool description vs prompt vs model)
- Setting up trajectory evaluation (not just outcome)
- Establishing quantitative quality gates for production

## Prerequisites

- Agent with at least 2 tools implemented
- Access to LLM API for batch evaluation
- Real-world task examples (not synthetic data)
- Understanding of agent loop and tool calling

## How to Run

This is a process skill. Reference during development:

1. Load with `skill_view(name='agent-evaluation-system')`
2. Follow Procedure to build eval set and run evaluations
3. Use Quick Reference for quality gates and iteration priority

## Quick Reference

**Eval Set Scale:**
- Sprint 1: ≥30 real cases (Easy 60% / Hard 25% / Edge 15%)
- Production: ≥100 cases with regression suite
- Never use synthetic data for core eval set

**Evaluation Types:**
- *Outcome eval*: Did the agent produce the correct final answer?
- *Trajectory eval*: Did the agent call the right tools in the right order?
- *Policy eval*: Did the agent follow constraints (cost, safety, format)?

**Iteration Priority (fixed order):**
1. Tool description (highest leverage)
2. Prompt refinement
3. Output format
4. Tool boundary (split/merge tools)
5. Model swap (lowest leverage, highest cost)

**Quality Gates:**
- Sprint 1: ≥70% outcome accuracy, ≥60% trajectory accuracy
- Production: ≥95% outcome, ≥85% trajectory, zero policy violations
- Cost per run: $0.05–$0.30 typical; >$1.00 → scope too broad

## Instructions

### Step 1: Build Eval Set Before Code

1. Collect 30+ real-world task examples from actual users or use cases
2. Categorize: Easy (60%), Hard (25%), Edge (15%)
   - Easy: single tool, clear input, obvious output
   - Hard: multi-tool, ambiguous input, requires reasoning
   - Edge: error cases, missing data, policy boundaries
3. For each case, document:
   - Input (what user says)
   - Expected tool sequence (trajectory)
   - Expected output properties (outcome)
   - Max allowed steps (efficiency)
   - Mock tool responses (for reproducibility)

**Distribution rationale (60/25/15):**
- 60% Easy: Ensures baseline functionality works consistently
- 25% Hard: Tests complex reasoning and multi-step workflows
- 15% Edge: Catches failure modes and boundary conditions
- This ratio mirrors real-world usage patterns where most requests are simple but edge cases cause production incidents

### Step 2: Define Trajectory Evaluation

For each eval case, specify expected tool calls:
- Which tools should be called
- In what order
- With what parameters (or parameter ranges)
- How many times (no loops unless intentional)

**Trajectory scoring:**
- Exact match: 1.0
- Correct tools, wrong order: 0.5
- Missing critical tool: 0.0
- Extra unnecessary tools: -0.2 per tool

**Eval case schema (YAML):**
```yaml
- id: "unique_identifier"
  description: "场景描述"
  category: "easy | hard | edge"
  input: "Agent 接收的输入"
  expected:
    tools: ["期望工具序列"]
    output_properties: ["必须包含的属性"]
    policies: ["必须遵守的策略"]
  max_steps: 最大允许步数
  mock_tools:
    tool_name: "mock 返回值或错误类型"
```

Run trajectory eval separately from outcome eval.

### Step 3: Run Batch Evaluation

1. Execute all eval cases via LLM API in batch
2. Collect metrics per case:
   - Outcome: correct/incorrect/partial
   - Trajectory: tool sequence match score
   - Steps: actual vs max allowed
   - Tokens: input + output + tool calls
   - Cost: total API cost per case
   - Latency: wall-clock time
3. Aggregate across categories (Easy/Hard/Edge)

### Step 4: Iterate with Fixed Priority

1. Sort failures by category (Easy first, then Hard, then Edge)
2. For each failure, apply iteration priority:
   - **Tool description**: Is the tool name/description clear? Does it guide the agent correctly?
   - **Prompt**: Is the system prompt missing guidance for this case?
   - **Output format**: Is the agent returning wrong structure?
   - **Tool boundary**: Should this tool be split or merged?
   - **Model swap**: Only if all above fail (expensive, risky)
3. After each change, re-run full eval suite (regression test)
4. One change at a time; never combine multiple fixes

### Step 5: Production Quality Gates

1. Before deployment, verify:
   - Outcome accuracy ≥95% on full eval set
   - Trajectory accuracy ≥85%
   - Zero policy violations (safety, cost, format)
   - Cost per run within budget ($0.05–$0.30 typical)
   - No infinite loops or step limit breaches
2. Set up continuous evaluation:
   - Log all production runs
   - Sample 10% for manual review
   - Alert on accuracy drop >5% week-over-week

## Common Pitfalls

- **Synthetic eval data**: Real users make real mistakes; synthetic data doesn't capture edge cases. Use real data only.
- **Outcome-only evaluation**: Agent can get right answer via wrong path (lucky guess, expensive detour). Always eval trajectory.
- **Changing multiple things at once**: Can't attribute improvement. One change per iteration.
- **Skipping trajectory eval**: Agent may be calling unnecessary tools, wasting cost and latency. Trajectory eval catches this.
- **No regression suite**: Fix one case, break three others. Always re-run full suite after changes.
- **Model swap as first resort**: Expensive, risky, often unnecessary. Tool description changes have 10x more leverage.
- **Eval set too small**: <30 cases = no statistical significance. <100 cases = can't catch rare failures.
- **Ignoring cost metrics**: Agent may be accurate but economically unviable. Track cost per run from day one.

## Verification Checklist

Run eval suite and verify:
1. Outcome accuracy ≥95% (or ≥70% for Sprint 1)
2. Trajectory accuracy ≥85% (or ≥60% for Sprint 1)
3. Cost per run within budget
4. Zero infinite loops
5. All policy constraints satisfied

If any gate fails, follow iteration priority to fix.

## References

Changelog: `skill_view(name='agent-evaluation-system', file_path='references/CHANGELOG.md')`
