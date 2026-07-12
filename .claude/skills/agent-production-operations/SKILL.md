---
name: agent-production-operations
description: "Production operations for agents: error handling, observability, human-in-the-loop, deployment. Use when implementing error handling, setting up observability, or planning deployment strategies."
version: 0.2.0
author: Hermes
tags: [Agent, Production, ErrorHandling, Observability, HumanInTheLoop, Deployment]
related_skills: [agent-development-lifecycle]
---
# Agent Production Operations

## Overview

Production operations for AI agent systems. Covers standardized error handling, three-layer observability, human-in-the-loop patterns, and deployment strategies.

This skill is part of the agent development suite. Load `agent-development-lifecycle` for the umbrella process.

## When to Use

- Designing error handling and retry strategies for agent tools
- Setting up observability (tracing, metrics, alerting) for production agents
- Implementing human-in-the-loop approval workflows
- Planning deployment strategy (gray release, rollback, feature flags)
- Monitoring agent performance and cost in production

## Prerequisites

- Agent deployed to staging or production environment
- Access to logging/monitoring infrastructure (Langfuse, Grafana, etc.)
- Error tracking system integrated
- Understanding of agent loop and tool calling

## How to Run

This is a process skill. Reference during development:

1. Load with `skill_view(name='agent-production-operations')`
2. Follow Procedure to implement error handling and observability
3. Use Quick Reference for error dictionary and alert thresholds

## Quick Reference

**Standardized Error Dictionary:**
- TIMEOUT: retry 3x with exponential backoff (1s, 2s, 4s)
- RATE_LIMITED: retry 5x, respect Retry-After header
- INVALID_PARAM: retry 1x, fix parameters immediately
- PERMISSION_DENIED: no retry, escalate to human
- TOOL_NOT_FOUND: no retry, inform agent of available tools
- EXTERNAL_API_ERROR: retry 2x with fixed 2s delay

**Three-Layer Observability:**
- Layer 1 (Trace): Langfuse/Phoenix for detailed trace logging
- Layer 2 (Metrics): Grafana for online metrics (success rate, latency, cost)
- Layer 3 (Drift): Week-over-week comparison for performance drift detection

**Alert Thresholds:**
- Success rate <90% → immediate alert
- Step limit trigger rate >10% → investigate scope
- Tool failure rate >5% → check tool health
- Approval pass rate >95% → reduce human oversight
- Token day-over-day >50% → check for context bloat

**Human-in-the-Loop Patterns:**
- Pre-operation approval: low-frequency, high-risk operations
- Sampling audit: 10–20% of cases for routine operations
- Confidence routing: low-confidence decisions → human review

**Deployment Strategy:**
- Gray release: 5% → 20% → 50% → 100%
- Feature flags: one-click degradation support
- Model upgrade: always run full eval suite before production
- Cost control: caching, context compression, subtask model downgrade

## Instructions

### Step 1: Implement Standardized Error Handling

1. **Define error types** (use standardized dictionary):
   - TIMEOUT: network timeout, tool execution timeout
   - RATE_LIMITED: API rate limit exceeded
   - INVALID_PARAM: parameter validation failed
   - PERMISSION_DENIED: insufficient permissions
   - TOOL_NOT_FOUND: agent called non-existent tool
   - EXTERNAL_API_ERROR: third-party API failure

2. **Implement retry strategies**:
   - TIMEOUT: 3 retries, exponential backoff (1s, 2s, 4s)
   - RATE_LIMITED: 5 retries, respect Retry-After header
   - INVALID_PARAM: 1 retry, fix parameters immediately
   - PERMISSION_DENIED: no retry, escalate to human
   - TOOL_NOT_FOUND: no retry, inform agent of available tools
   - EXTERNAL_API_ERROR: 2 retries, fixed 2s delay

**Retry strategy rationale:**
- Exponential backoff for TIMEOUT: avoids thundering herd when service recovers
- Respect Retry-After for RATE_LIMITED: API providers tell you when to retry; ignoring wastes quota
- No retry for PERMISSION_DENIED: retrying won't fix auth issues; escalate immediately saves cost
- Fixed 2s delay for EXTERNAL_API: third-party APIs have unpredictable recovery; fixed delay is simpler than exponential

3. **Error message format**:
   - Natural language description (not stack trace)
   - Suggested next action for agent
   - Error type code (for programmatic handling)
   - Example: "Customer not found (PERMISSION_DENIED). Verify customer_id format or escalate to human."

### Step 2: Set Up Three-Layer Observability

1. **Layer 1: Trace Logging** (Langfuse/Phoenix):
   - Log every LLM call (input, output, tokens, latency)
   - Log every tool call (name, parameters, result, duration)
   - Log agent decisions (reasoning, confidence, alternatives considered)
   - Generate unique trace_id per agent run
   - Enable drill-down from trace to individual tool calls

2. **Layer 2: Online Metrics** (Grafana):
   - Success rate (outcome accuracy)
   - Latency (p50, p95, p99)
   - Cost per run (tokens × price)
   - Tool call count and failure rate
   - Step count and step limit trigger rate
   - Human approval rate and approval latency

3. **Layer 3: Drift Detection** (week-over-week):
   - Compare metrics week-over-week
   - Alert on >5% degradation in success rate
   - Alert on >50% increase in token usage
   - Alert on >20% increase in cost per run
   - Track model version and prompt version changes

### Step 3: Implement Human-in-the-Loop

1. **Pre-operation approval** (low-frequency, high-risk):
   - Data deletion, financial transactions, production deployments
   - Show agent's proposed action and reasoning
   - Require explicit human approval before execution
   - Log approval decision and approver identity

2. **Sampling audit** (10–20% of cases):
   - Randomly sample routine operations for human review
   - Review agent's action, reasoning, and outcome
   - Identify patterns of poor decisions
   - Feed findings back into eval set and prompt refinement

3. **Confidence routing** (low-confidence → human):
   - Agent estimates confidence score (0–1)
   - If confidence <0.7 → route to human review
   - Human provides correct answer → add to eval set
   - Track confidence calibration (predicted vs. actual accuracy)

4. **Approval system must be built synchronously**:
   - Don't add approval after agent is deployed
   - Approval backlog accumulates in first month
   - Plan approval workflow before agent launch

### Step 4: Deploy with Gray Release

1. **Gray release strategy**:
   - Start with 5% of traffic (internal users or low-risk customers)
   - Monitor for 24–48 hours (success rate, cost, latency)
   - If stable → increase to 20% → 50% → 100%
   - If issues → rollback to previous version immediately

2. **Feature flags**:
   - Wrap agent in feature flag (can disable with one click)
   - Support degradation mode (fallback to rule-based system)
   - Enable A/B testing (compare agent vs. baseline)

3. **Model upgrade protocol**:
   - Never upgrade model in production without full eval run
   - Run eval suite on new model version
   - Compare metrics (accuracy, cost, latency) vs. current model
   - If regression >5% → delay upgrade, investigate

4. **Cost control**:
   - Implement caching (cache frequent tool results)
   - Compress context (see `agent-context-engineering`)
   - Downgrade model for subtasks (e.g., use smaller model for classification)
   - Set hard cost limit per run ($0.05–$0.30 typical)

### Step 5: Monitor and Maintain

1. **Daily monitoring**:
   - Check success rate (alert if <90%)
   - Check cost per run (alert if >$1.00)
   - Check step limit trigger rate (alert if >10%)
   - Review error logs (identify new error patterns)

2. **Weekly review**:
   - Compare metrics week-over-week (drift detection)
   - Review human approval decisions (identify patterns)
   - Update eval set with new edge cases from production
   - Refine tool descriptions based on agent misuse

3. **Monthly maintenance**:
   - Re-run full eval suite (regression test)
   - Update system prompt based on production learnings
   - Optimize tool implementations (performance, cost)
   - Review and update approval thresholds

## Common Pitfalls

- **No error standardization**: Agent gets confused by inconsistent error messages. Use standardized dictionary.
- **Stack traces in errors**: LLM can't parse stack traces. Use natural language + suggested action.
- **No retry strategy**: Agent gives up on transient failures. Implement retry with backoff.
- **Ignoring observability**: Can't debug what you can't see. Set up tracing from day one.
- **No alert thresholds**: Problems discovered by users, not team. Set up proactive alerts.
- **Adding approval after deployment**: Approval backlog accumulates. Build approval system before launch.
- **No gray release**: Full rollout = full risk. Start with 5% traffic.
- **Model upgrade without eval**: New model may regress on edge cases. Always run full eval.
- **No cost monitoring**: Agent may be accurate but economically unviable. Track cost per run.
- **Skipping weekly review**: Production learnings lost. Schedule weekly review cadence.

## Verification Checklist

Monitor production and verify:
1. Success rate ≥90% (alert if <90%)
2. Cost per run within budget ($0.05–$0.30)
3. Step limit trigger rate <10%
4. Tool failure rate <5%
5. Zero unhandled errors (all errors caught and logged)
6. Human approval backlog <24 hours
7. Gray release completed without rollback

## References

Changelog: `skill_view(name='agent-production-operations', file_path='references/CHANGELOG.md')`
