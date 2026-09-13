# Procedure — expansion

## How many workers

Three inputs, in this order:

1. **Shape** — independent modules / compile boundaries → one worker each.
2. **Cost** — N × context vs speed. Trivial work stays on the current agent.
3. **Dependency** — shared mutable state, overlapping writes, or peer output → sequence.

## Shared-state gate (any hit → not parallel)

- Two workers would modify the same file
- Same database / config / lock
- Overlapping uncommitted writes on the same paths
- Task B needs task A's artifact (build output, temp file, in-memory object)

Same git branch is the default, not a blocker. The blocker is shared **paths**, not "the same commit".

## One message

```
# current agent, one message, N worker invokes
Agent(subagent_type="general-purpose", description="review module A", prompt="...")
Agent(subagent_type="general-purpose", description="review module B", prompt="...")
```

Named workers (`spec-reviewer-agent`, `standards-reviewer-agent`, S1–S6 verifiers) follow the same rule: the **current** agent launches them.

Three sequential messages = sequence.

## After collect

Cross-check before synthesize (see `verification.md`). Integration is the merged report. Git commit belongs to a later implementing turn, not this skill.
