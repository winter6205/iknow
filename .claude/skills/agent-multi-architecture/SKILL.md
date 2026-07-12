---
name: agent-multi-architecture
description: "Multi-agent architecture patterns: orchestration, handoffs, state machines, and sandboxed execution. Use when designing multi-agent systems, implementing handoffs, or setting up sandboxed execution."
version: 0.2.0
author: Hermes
tags: [Agent, MultiAgent, Orchestration, Handoffs, StateMachine, Sandbox]
related_skills: [agent-development-lifecycle]
---

# Agent Multi-Architecture Patterns

## Overview

Multi-agent architecture patterns for AI agent systems. Covers orchestration strategies, agent handoffs, state machine design, and sandboxed execution environments.

This skill is part of the agent development suite. Load `agent-development-lifecycle` for the umbrella process.

## When to Use

- Designing multi-agent systems (router-specialist, hierarchical, peer-to-peer)
- Implementing agent handoffs (transferring control between agents)
- Building state machines for agent lifecycle management
- Setting up sandboxed execution environments
- Orchestrating complex workflows with dynamic task decomposition

## Prerequisites

- Single agent system working in production
- Understanding of agent loop and tool calling
- Access to agent orchestration framework (or custom implementation)
- Sandbox environment for isolated execution (Docker, VM, or cloud sandbox)

## How to Run

This is a process skill. Reference during development:

1. Load with `skill_view(name='agent-multi-architecture')`
2. Follow Procedure to design multi-agent patterns
3. Use Quick Reference for handoff protocols and state transitions

## Quick Reference

**Five-Layer Architecture:**
```
L1: Interaction Layer (CLI/Web/Chat/API/Voice)
L2: Orchestration Layer (Agent Loop, Control Flow, State Manager)
L3: Reasoning Layer (LLM calls, Prompt Builder, Context Assembler)
L4: Tool Layer (Tool Registry, MCP Client, Tool Executor)
L5: Integration Layer (DB/API/FS/Git/Sandbox/External Services)
```

**Framework Selection Matrix:**
| Framework | Strength | Use When |
|---|---|---|
| No framework (bare loop) | Zero dependency, full control | First agent, ≤2 people, <10 tools |
| LangGraph | Graph-based orchestration | Complex multi-step workflows, conditional branching |
| CrewAI | Role-based multi-agent | Team collaboration, clear role separation |
| AutoGen | Conversational multi-agent | Dialogue-heavy collaboration, code execution |
| OpenAI Agents SDK | Production-ready, handoffs | Enterprise deployment, model-agnostic |
| Claude Agent SDK | Tool-use optimization | Claude models, complex tool chains |

**Agent Loop Minimal Implementation:**
→ Lazy-load: `skill_view(name='agent-multi-architecture', file_path='references/agent-loop-implementation.md')`

**State Machine Pattern:**
→ Lazy-load: `skill_view(name='agent-multi-architecture', file_path='references/state-machine-pattern.md')`

**Multi-Agent Patterns:**
- Router-Specialist: router classifies input → dispatches to specialist agent
- Hierarchical: manager agent delegates to worker agents (tree structure)
- Peer-to-Peer: agents collaborate as equals, passing messages
- Orchestrator-Workers: central orchestrator dynamically decomposes tasks

**Handoff Protocol:**
- Trigger: agent detects task outside its capability
- Handoff data: task description, context summary, expected output format
- Receiving agent: validates handoff, acknowledges receipt, executes task
- Return: result passed back to originating agent (or next agent in chain)

**State Machine (Agent Lifecycle):**
- IDLE: waiting for task
- PLANNING: decomposing task, selecting tools
- EXECUTING: running tool calls
- WAITING_APPROVAL: paused for human approval
- EVALUATING: checking result quality
- COMPLETED: task finished successfully
- FAILED: task failed (error or step limit)

**Sandbox Execution:**
- Isolated environment (Docker container, VM, or cloud sandbox)
- File system isolation (read-only mount or ephemeral storage)
- Network restrictions (whitelist allowed domains)
- Resource limits (CPU, memory, execution time)
- Checkpoint support (save/restore state)

**Orchestration Strategies:**
- Static: predefined workflow (fixed sequence of agents)
- Dynamic: orchestrator decides next agent based on task state
- Hybrid: static skeleton with dynamic branches

## Instructions

### Step 1: Choose Multi-Agent Pattern

**Selection criteria:**
- **Single agent sufficient when**: <5 tools, <10 step tasks, no specialized expertise needed. Multi-agent adds coordination overhead; only use when complexity justifies it.
- **Router-Specialist**: Use when input types are distinct (e.g., billing vs technical vs sales) and each type needs different tools/prompts. Router classifies → specialist executes.
- **Hierarchical**: Use when task decomposes into independent subtasks (e.g., "research X, analyze Y, write Z"). Manager delegates → workers execute → manager aggregates.
- **Peer-to-Peer**: Use when agents need to collaborate iteratively (e.g., researcher → analyst → writer → reviewer). No central coordinator; agents pass messages.
- **Orchestrator-Workers**: Use when workflow is dynamic and depends on runtime data (e.g., "find best flight, then book hotel, then arrange transport"). Orchestrator decides next step based on previous results.

1. **Router-Specialist** (best for classification tasks):
   - Router agent classifies input (e.g., customer intent: billing/technical/sales)
   - Dispatches to specialist agent (billing agent, tech support agent, sales agent)
   - Each specialist has focused tools and prompts
   - Use when: input types are distinct, specialists need different tools

2. **Hierarchical** (best for complex decomposition):
   - Manager agent breaks task into subtasks
   - Assigns subtasks to worker agents
   - Aggregates results from workers
   - Use when: task requires multiple independent subtasks

3. **Peer-to-Peer** (best for collaborative reasoning):
   - Agents pass messages to each other
   - Each agent contributes expertise (e.g., researcher, analyst, writer)
   - No central coordinator
   - Use when: task requires iterative collaboration

4. **Orchestrator-Workers** (best for dynamic workflows):
   - Orchestrator dynamically decides next step
   - Workers execute specific actions
   - Orchestrator adapts plan based on worker results
   - Use when: workflow is not predictable, requires runtime decisions

### Step 2: Implement Handoff Protocol

1. **Define handoff trigger conditions**:
   - Agent confidence < threshold (e.g., <0.7)
   - Task requires tools agent doesn't have
   - Task outside agent's domain (detected by classifier)
   - Step count exceeds limit (agent stuck)

2. **Design handoff data structure**:
   ```
   {
     "from_agent": "billing_agent",
     "to_agent": "tech_support_agent",
     "task": "Customer reports login error after password reset",
     "context_summary": "Customer ID: 12345, issue started 2024-01-15...",
     "expected_output": "Diagnosis and resolution steps",
     "priority": "high",
     "deadline": "2024-01-16T12:00:00Z"
   }
   ```

3. **Implement handoff execution**:
   - Originating agent pauses execution
   - Serializes context and task description
   - Calls handoff tool (passes data to receiving agent)
   - Receiving agent validates handoff data
   - Receiving agent acknowledges receipt
   - Receiving agent executes task
   - Result passed back (or forwarded to next agent)

4. **Handle handoff failures**:
   - Receiving agent unavailable → retry with backoff
   - Receiving agent fails → escalate to human or fallback agent
   - Handoff timeout → alert and log for debugging

### Step 3: Design State Machine

1. **Define agent states**:
   - IDLE: waiting for task assignment
   - PLANNING: decomposing task, selecting tools/agents
   - EXECUTING: running tool calls
   - WAITING_APPROVAL: paused for human approval
   - EVALUATING: checking result quality (running eval)
   - COMPLETED: task finished successfully
   - FAILED: task failed (error, step limit, or handoff failure)

2. **Define state transitions**:
   - IDLE → PLANNING: task assigned
   - PLANNING → EXECUTING: plan approved (or auto-approved)
   - EXECUTING → WAITING_APPROVAL: high-risk action detected
   - EXECUTING → EVALUATING: all tool calls complete
   - EVALUATING → COMPLETED: result passes quality check
   - EVALUATING → EXECUTING: result fails quality check (retry)
   - Any state → FAILED: unrecoverable error or step limit exceeded

3. **Implement state persistence**:
   - Store state in database (not in memory)
   - Include: agent_id, current_state, task_id, context_summary, timestamp
   - On restart: load state from database, resume from last state
   - Log all state transitions (for debugging and audit)

4. **Handle state machine edge cases**:
   - Agent crash during EXECUTING → resume from last checkpoint
   - Agent stuck in EXECUTING (no progress) → timeout → FAILED
   - Multiple agents in WAITING_APPROVAL → prioritize by task urgency
   - State corruption → fallback to IDLE, alert human

### Step 4: Set Up Sandboxed Execution

1. **Choose sandbox type**:
   - Docker container: lightweight, fast startup, good for code execution
   - Virtual machine: stronger isolation, good for untrusted code
   - Cloud sandbox (e.g., E2B, Modal): managed, scalable, pay-per-use

2. **Configure sandbox restrictions**:
   - File system: read-only mount or ephemeral storage (no persistent writes)
   - Network: whitelist allowed domains (block all others)
   - Resources: CPU limit (e.g., 2 cores), memory limit (e.g., 4GB), time limit (e.g., 5 minutes)
   - Tools: only allow approved tools (block dangerous operations)

3. **Implement checkpoint/restore**:
   - Save sandbox state after each subtask (snapshot or event log)
   - On failure: restore from last checkpoint, retry subtask
   - On success: archive checkpoint (for debugging or audit)

4. **Monitor sandbox execution**:
   - Log all tool calls and outputs
   - Track resource usage (CPU, memory, network)
   - Alert on resource limit violations
   - Alert on suspicious behavior (e.g., network access to blocked domain)

### Step 5: Implement Orchestration Logic

1. **Static orchestration** (predefined workflow):
   - Define workflow as sequence of agents (A → B → C)
   - Each agent executes, passes result to next
   - Use when: workflow is predictable, no runtime decisions needed

2. **Dynamic orchestration** (runtime decisions):
   - Orchestrator agent analyzes task and current state
   - Orchestrator decides next agent (or tool) to call
   - Orchestrator adapts plan based on agent results
   - Use when: workflow depends on runtime data, requires flexibility

3. **Hybrid orchestration** (static skeleton + dynamic branches):
   - Define workflow skeleton (high-level sequence)
   - Allow dynamic branches (orchestrator decides sub-workflow)
   - Use when: workflow has predictable structure but variable details

4. **Implement orchestration loop**:
   ```
   while task not complete:
     orchestrator analyzes state
     orchestrator selects next agent/tool
     agent/tool executes
     orchestrator evaluates result
     if result passes quality check:
       update task state
     else:
       retry or escalate
   ```

5. **Handle orchestration failures**:
   - Agent fails → retry with different agent or fallback
   - Orchestration loop exceeds step limit → FAILED
   - No agent available for subtask → escalate to human
   - Orchestration deadlock (agents waiting on each other) → detect and break cycle

## Common Pitfalls

- **Over-engineering multi-agent**: Single agent with good tools is simpler and often sufficient. Only use multi-agent when task requires distinct expertise or dynamic decomposition.
- **No handoff protocol**: Agents can't transfer control cleanly. Define handoff data structure and execution flow.
- **State in memory**: Agent crash = lost state. Persist state to database.
- **No sandbox isolation**: Untrusted code execution = security risk. Always sandbox.
- **Static-only orchestration**: Can't handle runtime variability. Use dynamic or hybrid orchestration for complex tasks.
- **No checkpoint/restore**: Long-running agents lose progress on failure. Checkpoint after each subtask.
- **Ignoring handoff failures**: Handoff timeout or rejection = task failure. Implement retry and escalation.
- **No state machine**: Agent behavior is unpredictable. Define explicit states and transitions.
- **Sandbox too restrictive**: Agent can't complete task. Balance security with functionality.
- **Orchestration deadlock**: Agents waiting on each other = infinite loop. Detect cycles and break them.

## Verification Checklist

Test multi-agent system and verify:
1. Handoff success rate ≥95% (handoffs complete without error)
2. State machine transitions are logged and auditable
3. Sandbox execution completes within resource limits
4. Orchestration loop completes within step limit (≤10 steps typical)
5. Zero deadlocks (no infinite loops or circular dependencies)
6. Checkpoint/restore success rate ≥90%
7. Multi-agent system outperforms single-agent baseline (accuracy or cost)

## References

Changelog: `skill_view(name='agent-multi-architecture', file_path='references/CHANGELOG.md')`
