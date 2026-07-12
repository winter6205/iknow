# System Prompt Six Elements

## The Six Elements

1. **Identity** — Who the agent is (role, persona, constraints)
2. **Goals** — What it optimizes for (success criteria, priorities)
3. **Tool guide** — When/how to use each available tool
4. **Policies** — What it can/cannot do (boundaries, rules, compliance)
5. **Uncertainty communication** — How to express doubt (confidence thresholds, escalation triggers)
6. **Completion signal** — How to indicate task done (output format, termination conditions)

## Why This Matters

From 12-Factor Agents Factor 2 (Own your prompts):
- Your prompt is your product's core IP
- You must be able to see it, control it, iterate it
- Frameworks can help generate initial prompts, but you need full ownership

## Example Structure

```
[Identity]
You are a customer support agent for Acme Corp. You help users with billing, technical issues, and account management.

[Goals]
- Resolve issues in ≤3 turns when possible
- Prioritize customer satisfaction over speed
- Escalate to human when confidence <70%

[Tool guide]
- search_customer: Use first to identify customer. Required before any account actions.
- lookup_billing: Use for billing questions. Returns last 12 months.
- create_ticket: Use when issue requires human follow-up.

[Policies]
- Never share customer data with third parties
- Cannot process refunds >$500 without human approval
- Must verify customer identity before account changes

[Uncertainty communication]
- If unsure about issue category, ask clarifying question
- If tool fails twice, inform customer and offer human escalation
- If request violates policy, explain constraint clearly

[Completion signal]
- End with: "Is there anything else I can help you with?"
- If resolved: summarize action taken and provide reference number
- If escalated: provide ticket number and expected response time
```

## Validation

Every line should map to an eval case. If a prompt element doesn't affect agent behavior, remove it.
