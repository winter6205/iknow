# Example: one message, three workers, synthesize

Read-only review of three disjoint modules. Six steps match the skill Procedure.

```
# Scene: three independent review requests, zero shared state

# 1 — Identify
#   A: cinema-site/src/components/Hero.vue
#   B: multi-agent-cli/multi_agent_cli/v5/run.py
#   C: project-rag-customer-service/src/api/orders.py

# 2 — 7-field prompts (ROLE / SCOPE / PERMISSION / REFERENCE / CONSTRAINTS / DELIVERABLE / OUTPUT RULES)

# 3 — Current agent, one message, three workers
Agent(subagent_type="general-purpose", description="review Hero.vue", prompt="<prompt 1>")
Agent(subagent_type="general-purpose", description="review run.py", prompt="<prompt 2>")
Agent(subagent_type="general-purpose", description="review orders.py", prompt="<prompt 3>")

# 4 — Structured results (findings + commands + exit codes)

# 5 — Cross-check
#   git diff --stat           → empty (review did not write)
#   claimed paths intersect   → empty

# 6 — Synthesize
#   dispatched 3, passed 3, failed 0
#   follow-up tickets optional; this skill does not commit
```
