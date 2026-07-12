---
name: agent-context-engineering
description: "Context window management for agents: memory layers, compression, and rot defense. Use when designing agent memory architecture, debugging context rot, or implementing compression strategies."
version: 0.2.0
author: Hermes
tags: [Agent, Context, Memory, Compression, ContextRot]
related_skills: [agent-development-lifecycle]
---
# Agent Context Engineering

## Overview

Context window management for AI agent systems. Covers three-layer memory architecture, context rot defense, tool result compression, and pre-fetching strategies.

This skill is part of the agent development suite. Load `agent-development-lifecycle` for the umbrella process.

## When to Use

- Designing agent memory architecture (working/session/long-term)
- Debugging context rot (agent quality degrading over long conversations)
- Implementing tool result compression to save tokens
- Deciding when to pre-fetch context vs. retrieve on-demand
- Building checkpoint/resume for long-running agents

## Prerequisites

- Understanding of LLM context window limits (8K–1M tokens)
- Agent with tool calling implemented
- Access to persistent storage (file system, database, or vector store)
- No specific framework required

## How to Run

This is a process skill. Reference during development:

1. Load with `skill_view(name='agent-context-engineering')`
2. Follow Procedure to design memory layers and compression
3. Use Quick Reference for compression triggers and rot defenses

## Quick Reference

**Three-Layer Memory:**
- L1 Working Memory: single task, context window (8K–1M tokens)
- L2 Session Memory: single session, checkpoint/event log (unlimited)
- L3 Long-term Memory: cross-session, RAG/structured storage (unlimited)

**Context Rot Defenses:**
- Summarize every N turns (N=5–10 typical)
- Detect stagnation: 3 consecutive rounds with no progress → human intervention
- Hard token budget limit (never exceed 80% of window)
- Pre-fetch likely-needed context before agent asks

**Dumb Zone:**
State where context pollution or prompt defects cause agent to enter low-quality loops. Defense: detect consecutive failures (3+), force context reset, escalate to human.

**12-Factor Agent Principles (context-related):**
- Factor 3: Own your context window (don't let framework manage it)
- Factor 9: Compress errors into context (structured error messages)
- Appendix 13: Pre-fetch all potentially needed context (not a core factor, see `appendix-13-pre-fetch.md` in 12-factor-agents repo)

**Compression Triggers:**
- Token count >70% of budget
- Tool calls >10 cumulative
- Subtask completed (archive results)

**Pre-fetching Strategy (12-Factor Agent Principle 13):**
- Identify context agent will likely need in next 2–3 steps
- Load into context before agent requests
- Reduces round-trip latency and tool calls

**Tool Result Compression:**
- Never append full JSON to context
- Extract key fields, summarize in natural language
- Offer `response_format` enum: "concise" | "detailed" (concise saves ~2/3 tokens)

## Instructions

### Step 1: Design Three-Layer Memory

1. **L1 Working Memory** (context window):
   - Current task description
   - Recent tool calls and results (last 3–5)
   - System prompt and agent instructions
   - Active subtask state
   - Keep under 80% of context window capacity

2. **L2 Session Memory** (checkpoint/event log):
   - Full conversation history (compressed summaries)
   - Tool call log with timestamps
   - Intermediate results from completed subtasks
   - Agent decisions and reasoning traces
   - Store as event log (append-only) or checkpoint (periodic snapshots)

3. **L3 Long-term Memory** (cross-session):
   - User preferences and profile
   - Past task outcomes and lessons learned
   - Domain knowledge (RAG index or structured DB)
   - Tool usage patterns and success rates

**Design trade-offs:**
- **L1 capacity (80% rule)**: Leaves 20% headroom for LLM response generation and tool result expansion. Exceeding 80% risks truncation or context overflow errors.
- **L2 storage choice**: Event log (append-only) provides full audit trail but requires replay on resume. Checkpoint (periodic snapshots) enables fast resume but loses intermediate state. Choose event log for debugging-heavy scenarios, checkpoint for performance-critical scenarios.
- **L3 retrieval strategy**: RAG (vector search) scales to millions of items but adds latency (100–500ms). Structured DB (key-value) is fast (<10ms) but requires predefined schema. Use RAG for unstructured knowledge, structured DB for user preferences and tool patterns.

### Step 2: Implement Context Rot Defense

1. **Periodic summarization**:
   - Every 5–10 turns, summarize conversation so far
   - Replace detailed history with compressed summary
   - Keep only last 2–3 turns in full detail

2. **Stagnation detection**:
   - Track progress metrics (subtasks completed, tools called, output generated)
   - If 3 consecutive rounds show no progress → trigger human intervention
   - Log stagnation events for post-mortem analysis

3. **Hard token budget**:
   - Set max token limit (e.g., 80% of context window)
   - Monitor token count after each tool call
   - If approaching limit → compress or archive older context

4. **Pre-fetching (12-Factor Principle 13)**:
   - Analyze current task state
   - Predict what context agent will need next
   - Load into context proactively (e.g., user profile, related past tasks)
   - Reduces round-trip latency and tool calls

### Step 3: Compress Tool Results

1. **Never append raw JSON**:
   - Extract key fields (id, name, status, critical data)
   - Summarize in natural language: "Found 3 customers matching query: Alice (active), Bob (inactive), Carol (active)"
   - Keep full JSON in L2 session memory if needed for later reference

2. **Offer response_format parameter**:
   - `response_format: "concise"` → summary only (~1/3 tokens)
   - `response_format: "detailed"` → full response (~all tokens)
   - Default to "concise" unless agent explicitly requests detail

3. **Pagination and filtering**:
   - If tool returns >50 items, paginate (return first 10, offer "next page" tool)
   - Allow agent to filter by criteria (reduces result size)
   - Truncate long text fields (e.g., descriptions >500 chars)

### Step 4: Implement Checkpoint/Resume

1. **Checkpoint strategy**:
   - Save agent state after each subtask completion
   - Include: task description, completed steps, pending steps, context summary
   - Store as JSON or event log entry

2. **Resume strategy**:
   - On resume, load checkpoint into L1 working memory
   - Reconstruct context summary
   - Continue from last completed step
   - Verify state consistency (no duplicate tool calls)

3. **Event sourcing (alternative)**:
   - Log every agent action as event (tool call, decision, output)
   - On resume, replay events to reconstruct state
   - More flexible than checkpoints but slower

### Step 5: Monitor and Optimize

1. **Track metrics**:
   - Token usage per task (input + output + tool calls)
   - Compression ratio (original vs. compressed size)
   - Context rot incidents (stagnation, quality degradation)
   - Pre-fetch hit rate (how often pre-fetched context was used)

2. **Optimize compression**:
   - If token usage >80% budget → increase compression aggressiveness
   - If pre-fetch hit rate <30% → refine prediction logic
   - If context rot incidents >5% → reduce summarization interval

## Common Pitfalls

- **Appending full tool results**: Wastes tokens, accelerates context rot. Always compress.
- **No compression triggers**: Agent runs out of context window mid-task. Set hard limits.
- **Ignoring context rot**: Agent quality degrades silently over long conversations. Monitor and summarize.
- **Reactive context loading**: Agent must wait for tool calls to get context. Pre-fetch to reduce latency.
- **No checkpoint/resume**: Long-running agents lose all progress on failure. Checkpoint after each subtask.
- **Over-compression**: Lose critical details needed for reasoning. Balance compression with fidelity.
- **No token monitoring**: Can't optimize what you don't measure. Track token usage from day one.
- **Static context window**: Different tasks need different context sizes. Adjust dynamically based on task complexity.

## Verification Checklist

Monitor production runs and verify:
1. Token usage per task <80% of context window
2. Context rot incidents <5% of runs
3. Pre-fetch hit rate >50%
4. Checkpoint/resume success rate >95%
5. Compression ratio >2x (compressed size <50% of original)

## References

Changelog: `skill_view(name='agent-context-engineering', file_path='references/CHANGELOG.md')`
