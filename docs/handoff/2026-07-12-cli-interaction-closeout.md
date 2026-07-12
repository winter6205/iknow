# Handoff — 2026-07-12 · CLI interaction closeout

## Session outcomes

- Product **CLI chat** (not test-only harness): TTY REPL + pipe serial turns
- Host **ConversationState** + human/JSON format + slash commands
- Agents accept `answer(query, { prior_chunks, history })` without new tools
- Review repairs for interactive + CLI commits (`701a378`, `ffc475e`, `f431436` lines)
- STATUS map: `docs/STATUS.md`
- Operator preparing **next stage: interaction polish**

## Verification (evidence)

```text
npm run typecheck → exit 0
npm test          → 148 pass (at last full run before ritual)
npm run eval      → hard_pass_rate 1.0, violations []
Tip commits (local; push only if authorized):
  ffc475e — product CLI session polish
  f431436 — SIGINT/chain/usage review fixes
```

## Key paths

| Area | Path |
|------|------|
| CLI entry | `src/cli.ts` |
| Chat session | `src/cli/chat-session.ts` |
| Host interaction | `src/interaction/*` |
| Design | `docs/design/interaction-surface-v0.md` |
| Status map | `docs/STATUS.md` |
| Review skill | `.claude/skills/review-report-repair/SKILL.md` |

## Decisions in force

- 4 tools unchanged; G2 every turn; priors capped/sanitized
- Explicit CLI `--mode` overrides env
- Empty oneshot does not invent demo queries
- No commit/push without explicit user authorization

## Next stage (operator intent)

**打磨交互** — UX and multi-turn quality on the existing CLI, not protocol redesign.

Suggested slices:

1. TTY human smoke checklist (deterministic / embeddings / llm)
2. Multi-turn quality (referents, priors usefulness, error copy)
3. Optional: session export/import, quieter defaults, streaming later

## Do not

- Reopen 4-tool topology for chat
- Treat unit `processChatLine` tests as substitute for product TTY UX
- Silent commit/push
