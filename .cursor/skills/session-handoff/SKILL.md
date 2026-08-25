---
name: session-handoff
description: Reference for compressing the live thread into a lean handoff pointer in docs/handoff/ that references committed artifacts instead of duplicating them.
bucket: productivity
related_skills:
  [using-agent-skills, domain-modeling, verification-before-completion]
type: discipline
disable-model-invocation: true
---

# Session Handoff

Handoff is a **pointer**: this session's live state plus one `[NEXT]`, and paths to CONTEXT / ADR / plan / map / ticket. Not a second spec.

## When to use

Unfinished work another session must continue — a multi-session thread, or a long debug/implement summary the next agent needs.

Skip when nothing is left, the leftover is a one-line obvious fix, the operator said not to write a handoff, or spec / plan / ADR already holds the full live state.

## Procedure

1. **Fill** [`references/handoff-template.md`](references/handoff-template.md) from this session only. Frozen artifacts are paths, never copied. Changes: path + one-line effect; committed rows cite SHA. Verified state: commands actually run, plus passed/failed tests and whether a failure was expected; at least one command or test with an exit marker. Credentials are env names (`GITHUB_TOKEN`, `MINIMAX_API_KEY`). Exactly one concrete `[NEXT]` a next agent can execute in one session. Pressure excuses: [`references/pressure-and-antipatterns.md`](references/pressure-and-antipatterns.md). Done when every template section is filled or deleted, and `[NEXT]` does not need the chat.

2. **Write** `docs/handoff/YYYY-MM-DD-<slug>.md` (slug = task name), in the project tree. Done when that file exists.

3. **Measure** with the Verification commands. Over 300 lines: push detail back to cited artifacts. Done when all three commands echo `OK`.

## Acceptance Criteria

- [ ] File at `docs/handoff/YYYY-MM-DD-<slug>.md`
- [ ] Exactly one concrete `[NEXT]`
- [ ] Frozen artifacts referenced, not copied
- [ ] No API key / token / password / credential values
- [ ] This-session changes: path + one-line effect
- [ ] Verified state: at least one command or test + exit marker

## Verification

```
Skill type: discipline
Bar level:  discipline
```

```bash
test -f docs/handoff/YYYY-MM-DD-<slug>.md && echo "OK: handoff present"
grep -c "\[NEXT\]" docs/handoff/YYYY-MM-DD-<slug>.md | grep -q "^1$" && echo "OK: one next step"
# value-shape; extend pattern list when new token types observed
grep -Eiq "(=[A-Za-z0-9_\-\.=]{16,}|Bearer\s+[A-Za-z0-9_\-\.=]+|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|xox[bp]-[A-Za-z0-9\-]{10,}|sk-ant-[A-Za-z0-9_\-]{20,}|AIza[A-Za-z0-9_\-]{30,})" docs/handoff/YYYY-MM-DD-<slug>.md && echo "FAIL: secret found" || echo "OK: no secret"
```

## References

- [`references/handoff-template.md`](references/handoff-template.md)
- [`references/pressure-and-antipatterns.md`](references/pressure-and-antipatterns.md)
