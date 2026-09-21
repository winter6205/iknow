# 0098. Skill-model index frozen at opening; newly created only appended to messages; entry history follows the session

Date: 2026-09-17
Status: accepted

## Context

The opening `<available_skills>` block is a system session snapshot (prefix qualification line / ADR-0043 enforcement). Skill names can nevertheless be created mid-session under the current scan roots, and the model must learn them without breaking the frozen prefix.

## Decision

Names newly appearing in the **skill-model index** within a session must not rewrite that block; before the next model call, a same-shape listing containing **only the newly created** entries is appended as a user message to the tail of messages, and the names are recorded in an **index entry history** that is persisted with the session. Compact does not re-attach the listing based on "whether the increment message is still there". Wording changes of already-entered entries take effect via a new conversation's re-freeze, not via another append.

**Why not edit the frozen system table:** violates the adjacent-round tools+system deep-equal.
**Why not refresh the whole table into messages each round:** duplicates the frozen table, wastes tokens, and two listings fight.
**Why not replay the entry history from the current transcript only:** once compact eats the increment, the listing would be re-attached — equivalent to remounting it.
**Why not have the subagent do its own diff:** at spawn, writing the parent session's complete model index at that moment into the worker's own frozen table is enough.

## Consequences

- Amends ADR-0043 (skill names changing within a session → to the messages tail, same tier as the manual MCP-reconnect notification, without touching system).
- Amends ADR-0046 (the 10% downgrade still applies only to the opening frozen table; newly created lines in messages carry the full description).
- Human-side slash and `skill()` eligibility are in `specs/skill-index-increment.md`; the host projection is not expanded in this ADR.
