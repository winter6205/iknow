---
name: agent-development-lifecycle
description: "Process for building AI agents from design to production. Use when starting a new AI agent project, evaluating architecture choices, or reviewing agent system lifecycle compliance."
version: 0.2.0
author: Hermes
tags: [Agent, Development, Lifecycle, Workflow, ToolDesign]
related_skills: [agent-evaluation-system, agent-context-engineering, agent-production-operations, agent-multi-architecture]
---
# Agent Development Lifecycle

Standard process for developing AI agent systems. Combines Anthropic's architecture patterns and tool engineering, HumanLayer's 12-Factor Agents, OpenAI Agents SDK production practices, and ISO/IEC/IEEE 12207 lifecycle standards.

## Overview

This is the **umbrella skill** for the agent development skill suite. It provides the decision framework and lifecycle overview. Deep-dive topics are covered by companion skills:
- `agent-evaluation-system` — Eval-first testing methodology
- `agent-context-engineering` — Context window management and memory
- `agent-production-operations` — Error handling, observability, deployment
- `agent-multi-architecture` — Multi-agent patterns, state machines, sandboxes

This skill does NOT provide implementation code. It is a process guide for architectural decisions.

## When to Use

- Starting a new AI agent project needing structured development process
- Evaluating whether to build workflow vs. autonomous agent
- Designing tools for agent consumption
- Reviewing existing agent system for lifecycle compliance
- Planning agent evaluation and testing strategy

## Prerequisites

- Understanding of LLM capabilities and limitations
- Access to LLM API (Anthropic Claude, OpenAI, etc.)
- Basic software engineering practices (version control, testing)
- No specific framework required — applicable to any agent implementation

## Core Principles

### LLM as Pure Function

```
LLM(Context) → StructuredOutput
```

Output quality depends entirely on input Context. Same input is reproducible. Model is swappable. Treat LLM as deterministic function of its context.

### Decision-Execution Separation

```
LLM outputs JSON → Schema validation → Risk classification → Permission check → Execute / Escalate to human
```

LLM decides; deterministic code executes. Never let LLM directly mutate state.

### RPI Framework

Research → Plan → Implement: survey the landscape → make a plan → execute step by step. Apply to every non-trivial agent task.

## How to Run

This is a process skill, not an executable script. Reference during development:

1. Load with `skill_view(name='agent-development-lifecycle')`
2. Follow Instructions section for lifecycle guidance
3. Use companion skills for deep-dive topics

**Concrete workflow guides** (lazy-loaded):
- Phase 2 → Phase 3 transition (architecture gaps + tool spec + eval dataset): `skill_view(name='agent-development-lifecycle', file_path='references/phase-transition-workflow.md')`

## Instructions

### Phase 1: Requirements & Feasibility

1. Define the task scope: what inputs, outputs, and success criteria
2. Assess complexity: can a single LLM call with RAG + few-shot suffice?
3. If yes → stop here, build augmented LLM only
4. If no → determine if task has fixed steps (workflow) or dynamic steps (agent)
5. Document constraints: latency budget, cost ceiling, error tolerance

**Decision criteria:**
- **Tool count threshold (2–8 per agent)**: Based on cognitive load studies showing LLMs struggle with >8 tool choices. >8 tools → split into sub-agents with focused toolsets.
- **Iteration steps (max 10)**: Empirical observation that >10 steps indicates scope creep or unclear requirements. >30 steps → task is ill-defined, needs decomposition.
- **Cost per run ($0.05–$0.30)**: Industry benchmark for production agents. >$1.00/run → optimize tool descriptions or reduce tool calls.

### Phase 2: Architecture Selection

Choose the simplest pattern that meets requirements:

1. **Prompt Chaining** — task decomposes into fixed sequential steps
   - Each LLM call processes previous output
   - Add programmatic gates between steps for validation
2. **Routing** — input has distinct categories needing different handling
   - Classify input → dispatch to specialized handler
   - Good for cost optimization (small model for easy, large for hard)
3. **Parallelization** — subtasks are independent or need multiple perspectives
   - Segmentation: split into parallel subtasks, aggregate results
   - Voting: run same task multiple times, aggregate for confidence
4. **Orchestrator-Workers** — subtasks cannot be predicted upfront
   - Central LLM dynamically decomposes, delegates, synthesizes
5. **Evaluator-Optimizer** — clear evaluation criteria, iterative improvement helps
   - Generator produces output, evaluator provides feedback in loop
6. **Autonomous Agent** — open-ended, steps unpredictable
   - LLM loops with tools, reads environment feedback each step
   - Must include stop conditions (max iterations)

### Phase 3: Tool Design & Implementation

For each tool the agent will use:

1. **Define affordance, not API wrapper**
   - Ask: what does the agent need to accomplish? Not: what does the API expose?
   - Implement `search_contacts` not `list_contacts`; `schedule_event` not separate list/create
2. **Namespace tools**: `{service}_{resource}_{action}` (e.g., `asana_projects_search`)
3. **Write tool description as prompt engineering**
   - Description IS the prompt that guides agent behavior
   - Include: when to use, parameter semantics, expected return format, edge cases
4. **Design response format**
   - Return natural language names, not opaque UUIDs
   - Offer `response_format` enum: "concise" | "detailed" (concise saves ~2/3 tokens)
   - Implement pagination, filtering, truncation with sensible defaults
5. **Design error responses**
   - Errors must be specific and actionable
   - Include what went wrong and what to try next

### Tool Description Spec

→ Lazy-load: `skill_view(name='agent-development-lifecycle', file_path='references/tool-description-spec.md')`

### System Prompt Six Elements

→ Lazy-load: `skill_view(name='agent-development-lifecycle', file_path='references/system-prompt-six-elements.md')`

### AGENTS.md

Project-root instruction file that agents read at startup to understand project context, coding conventions, and tool availability. Version-control it alongside code.

### Phase 4: Prototype & Evaluation

1. Build tool prototype, wrap in MCP server or test harness
2. Test manually first — experience the tool as the agent would
3. Create evaluation tasks based on real-world use cases
   - Good task: "Schedule a meeting with Jane next week about the Acme project, attach notes from last planning meeting and book a room"
   - Bad task: "Schedule meeting with jane@acme.corp" (too simple, single tool call)
4. Run evaluations via LLM API in batch
5. Collect metrics: accuracy, runtime, tool call count, token consumption, error rate
6. Feed evaluation transcripts back to LLM for tool improvement iteration

### Phase 5: Integration & Testing

1. Integrate tools into agent loop: gather context → take action → verify work → repeat
2. Implement transparency: log agent's planning steps for debuggability
3. Test in sandboxed environment with guardrails
4. Verify: agent handles tool errors gracefully, respects stop conditions
5. Cross-validate with subagent: independent review of agent behavior

### Phase 6: Deployment & Operation

1. Deploy with monitoring: track cost, latency, error rates, tool usage patterns
2. Implement human-in-the-loop checkpoints for high-stakes decisions
3. Set up alerting for anomalous behavior (cost spikes, error loops)

### Phase 7: Maintenance & Improvement

1. Periodically review evaluation metrics against baselines
2. Update tool descriptions based on observed agent misuse
3. Add evaluation tasks for newly discovered edge cases
4. Iterate: prototype → evaluate → improve cycle continues

## Common Pitfalls

- **Over-engineering**: starting with multi-agent when single LLM call suffices. Only add complexity when it produces measurable improvement.
- **Framework dependency**: using frameworks without understanding underlying code. Wrong assumptions about framework internals are the most common error source.
- **API wrapping as tools**: exposing raw API endpoints as tools instead of designing for agent affordances.
- **Ignoring tool descriptions**: tool descriptions are loaded into agent context and directly guide behavior. Poor descriptions = poor agent decisions.
- **No stop conditions**: autonomous agents without max iterations or budget limits can run indefinitely.
- **Verbose tool responses**: returning full API responses wastes tokens. Default to concise, offer detailed on demand.
- **Evaluating with trivial tasks**: evaluation tasks must require multiple tool calls and test agent reasoning, not just API invocation.
- **Skipping sandbox testing**: agent autonomy means higher cost and compounding error risk. Always test in sandbox first.

## Verification Checklist

Run a 5-task evaluation suite covering:
1. Simple single-tool task (baseline)
2. Multi-tool sequential task (tests chaining)
3. Task requiring tool selection from alternatives (tests routing)
4. Task with ambiguous input (tests error handling)
5. Task requiring iteration/feedback (tests loop behavior)

Pass criteria: ≥80% accuracy, no infinite loops, token usage within budget, all errors handled gracefully.

## Quality Checklist

Before marking agent development complete, verify:

**Architecture:** Ruled out single-LLM solution, written decision record, defined interfaces
**Eval:** 30+ real cases, three-category coverage, trajectory eval, built before code
**Tools:** 2–8 tools, complete description spec, high-risk tools marked, results summarized
**Prompt:** Six elements present, version-controlled, AGENTS.md exists, eval regression tested
**Context:** Budget limit set, compression rules defined, rot defense implemented, pre-fetching active
**Control flow:** Programmatic management, state machine defined, max_steps=10
**State:** Externally persisted, resumable, single source of truth
**Human-in-loop:** Mode selected, mandatory approval list defined, built synchronously
**Error handling:** Standardized dictionary, translation layer, reasonable retries
**Observability:** Three-layer monitoring, structured logs, trace_id present
**Deployment:** Gray release + feature flags, rollback ready, runbook exists, full eval after model updates

## Development Rhythm

Typical 5-week timeline for production agent:

**Week 1:** Feasibility + architecture + eval set (≥30 cases)
**Week 2:** Single agent + 2 tools + bare loop implementation
**Week 3:** Router + specialists + eval passes quality gates
**Week 4:** Human-in-loop + error handling + observability
**Week 5:** Sandbox end-to-end testing + gray release

Adjust based on complexity. Simple agents (2–3 tools) may complete in 2–3 weeks. Complex multi-agent systems may need 8–10 weeks.

## References

**Lazy-loaded details:**
- Tool description spec (good vs bad examples): `skill_view(name='agent-development-lifecycle', file_path='references/tool-description-spec.md')`
- System prompt six elements: `skill_view(name='agent-development-lifecycle', file_path='references/system-prompt-six-elements.md')`
- Changelog: `skill_view(name='agent-development-lifecycle', file_path='references/CHANGELOG.md')`

**Primary sources (verified):**
- Anthropic, "Building effective agents" (2024-12) — architecture patterns, workflow vs agent distinction
- Anthropic, "Writing effective tools for agents — with agents" (2025-09) — tool design principles, ACI
- HumanLayer, "12-Factor Agents" (GitHub 24k stars) — 12 core factors + 1 appendix (Factor 13: Pre-fetch)
- OpenAI Agents SDK (GitHub 22k stars) — SandboxAgent, Handoffs, Guardrails, Sessions
- ISO/IEC/IEEE 12207:2026 — software lifecycle processes framework

**Key concepts from sources:**
- *Augmented LLM*: base building block with retrieval + tools + memory
- *Agent Loop*: gather context → take action → verify work → repeat
- *Trajectory Eval*: evaluate execution path (tool sequence, order, policy compliance), not just final output
- *Context Rot*: degradation from stale/contradictory info accumulating in context window
- *12-Factor principles*: 12 core factors + 1 appendix (Factor 13: Pre-fetch in appendix). Own your prompts, own your context, tools are structured output, stateless reducer, pre-fetch context
