# Agent-standard LLM call defaults

## Summary

Stop bumping `maxOutputTokens` per incident (2048 → 8192 → 16384). Align iknow per-call defaults with a normal coding agent (Claude Code): **32_000** output tokens, **300_000 ms** (5 min) request timeout. Billing is actual tokens, not the cap. MCP `connectTimeoutMs` stays 60s.

## Affects

- src/config/env.ts
- src/config/settings.ts
- tests/config/env.test.ts
- tests/config/subagent-settings.test.ts
- docs/llm-config-quickstart.md
- docs/integration-materials.env.example
- CHANGELOG.md

## 5-line verdict block

bounded-context-guardian: yes — only config/env SSOT + locking tests/docs; no new module.
defensive-contract-validator: yes — empty/unset env, illegal env, explicit override already covered; update expected fallback numbers.
error-handling-enforcer: yes — no new catch; invalid env still falls through to the third-tier default.
complexity-anti-drift: yes — constant replacement + comments.
minimal-change-verifier: yes — 1 logical task, 1 commit; do not touch loop-engine truncation or MCP timeout.
