# CONTEXT.md — Project Domain Language

> **Format**: be opinionated, pick the best word, list others under `_Avoid_`
> **Rule**: Keep definitions tight. One or two sentences max. Only project-specific terms.

## Language

**Chunk**:
A retrievable text unit from the enterprise KB, identified and returned by `kb_retrieve` with ranking metadata.
_Avoid_: Document fragment, passage, snippet (unless speaking of UI display only)

**Fact**:
A compiled, deduplicated claim produced by `kb_compile` (content_hash–stable) for later citation and governance.
_Avoid_: Assertion, take, note, summary blob

**snapshot_id**:
An opaque governance identifier for a point-in-time KB / fact view used by `kb_governance` freshness and conflict checks.
_Avoid_: Version, tag, checkpoint, revision (unless mapping to external VCS)

**source_span**:
A precise location into source material (chunk + offsets or equivalent) that grounds a citation in `kb_verify_citation`.
_Avoid_: Quote range, highlight, bookmark

**G2**:
The agent response envelope that must carry `snapshot_id` (and citation fields when answering from KB) before return to the user.
_Avoid_: Final answer bag, response wrapper, JSON reply shell

**kb_retrieve**:
Tool that dual-arm ranks and merges candidates (keyword/overlap → RRF, k=60) into ranked Chunks for the agent loop.
_Avoid_: search, RAG query, vector lookup (alone)

**kb_verify** / **kb_verify_citation**:
Tool that pure three-state checks whether a claim is supported by a given `source_span` / chunk evidence.
_Avoid_: fact-check, NLI pass, trust score, confidence float

**kb_compile**:
Tool that turns evidence into Facts with content_hash dedup for stable reuse.
_Avoid_: summarize, extract, ingest

**kb_governance**:
Tool that checks freshness, conflicts, and stamps `snapshot_id` (B-position independent tool).
_Avoid_: ACL admin, content moderation, CMS publish

**max_hops**:
Hard budget on hop-counted tool rounds (`kb_retrieve` + `kb_verify_citation` only; default 5) before forced exit.
_Avoid_: retries, steps, turns (unless clearly UI chat turns)

**trajectory** / **trajectory_score**:
Path-quality score over tool sequence vs required/recommended tools, efficiency, and hard-gate outcome (P2 formula).
_Avoid_: accuracy alone, pass rate only, LLM-as-judge score (those are outcome/soft metrics)

**tool_calls log**:
Structured per-answer list `{ tool, args, ordinal }` for trajectory scoring; `tool_trace` is names-only compat.
_Avoid_: ts (ambiguous with timestamp), stack, audit log (unless product audit)

**release_gates**:
Named milestone targets for suite rollup (`hard_pass_rate`, `mean_trajectory`) under `SuiteAggregate.release_gates`.
_Avoid_: sprint1_gates (legacy name), CI green alone

**session_overrides**:
Eval-sample fields that configure harness session (e.g. `simulate_governance_timeout`) without hardcoding sample ids in the runner.
_Avoid_: special-case if id === "qa-edge-006" in code

**deterministic agent**:
Rule-based `IknowAgent` loop used for CI and baseline eval; no external LLM/tool_calls API.
_Avoid_: mock agent, stub brain (unless truly empty fakes)

**lexicon (eval)**:
Shared note markers and answer regexes in `src/eval/lexicon.ts` used by both loop notes and scorer.
_Avoid_: duplicated string literals in loop and score-trajectory

**ConversationState**:
Host-layer multi-turn bag: turns, `last_priors`, short `history_finals`, json_mode — not part of tool schema.
_Avoid_: SessionContext (auth only), chat memory tool, stuffing full tool transcripts into session

**prior_chunks (cross-turn)**:
Protocol bridge for the next retrieve: `{ chunk_id, summary }[]` derived from last answer spans (capped/sanitized).
_Avoid_: pasting full chunk text, unlimited host arrays, using priors on sensitive edge-001 pre-check path

**chat REPL** / **product CLI**:
TTY interactive `iknow chat` (or bare TTY invoke) with human view; pipe mode is serial non-terminal turns.
_Avoid_: treating one-shot JSON ask as the interactive product; `terminal: true` on pipes; default demo query on empty ask

**oneshot / ask**:
Script/CI path: single question → full G2 JSON on stdout; empty query → usage + exit 1.
_Avoid_: inventing a demo Chinese query when args are empty

**processChatLine**:
Pure-ish turn handler used by REPL and unit tests (slash + agent.answer + format).
_Avoid_: embedding readline/TTY side effects inside this function

**Session HTTP API** / **session-api**:
Host multi-conversation surface over `node:http` (`src/session-api/`): create/message/command/reset; every message returns full G2; not tool schema.
_Avoid_: fifth chat tool, REST wrapping of individual kb_* tools

**iknow serve**:
CLI host that runs Session API + static product UI (`web/dist` preferred, fallback `web/`).
_Avoid_: separate frontend-only server as the production path without proxying `/api`

**product SPA (web/)**:
Vite + React + TypeScript chat console; same-origin Session client; G2 side panel required.
_Avoid_: zero-dep static shell as product; dropping `snapshot_id` for “clean UI”

**parseLlmResponseJson**:
LLM body parser that accepts plain JSON or JSON followed by SSE trailer (`data: [DONE]`); client also sends `stream: false`.
_Avoid_: bare `JSON.parse(raw)` on 9router chat responses

**I4 smoke**:
Documented three-mode + HTTP interaction smoke under `docs/handoff/i4-smoke/` (no secrets in artifacts).
_Avoid_: claiming interactive product complete without I4 evidence

**NINE_ROUTER_API_KEY**:
Env name for 9router API key (via `IKNOW_LLM_API_KEY_ENV` / embedding key env defaults). Value must be the active key 9router accepts for the endpoint in use.
_Avoid_: renaming the env var for “alignment”; treating `GET /v1/models` 200 as proof that chat/embeddings will 200

## Relationships

- **Query → kb_retrieve → Chunk[]**: agent issues a retrieve hop; store returns ranked chunks
- **Chunk + claim → kb_verify_citation → three-state**: verify binds claim to `source_span`
- **Verified evidence → kb_compile → Fact**: compile emits content_hash–stable facts
- **Fact / KB view → kb_governance → snapshot_id status**: governance stamps freshness/conflict
- **Agent loop → max_hops → G2**: loop terminates with G2 envelope when done or budget exhausted
- **tool_calls log → scoreTrajectory → trajectory_score / release_gates**: suite aggregates hard + soft gates
- **session_overrides → createSession → agent run**: data-driven timeout/role without runner special cases
- **User line → processChatLine → answer(opts) → IknowAnswer → ConversationState**: multi-turn host path
- **last_priors → answer prior_chunks → kb_retrieve**: cross-turn retrieve bridge only
- **Browser → Session HTTP → ConversationState → Agent.answer → G2**: product SPA / API host path
- **chat/completions body → parseLlmResponseJson → tool_calls loop**: LLM agent path

## Flagged ambiguities

- **gbrain vs iknow runtime**: `_upstream_gbrain/` is READ-ONLY design reference; product runtime is standalone `iknow` with **zero** import/link to gbrain
- **"verify" alone**: prefer `kb_verify_citation` / `kb_verify` tool name in code; "verify" in prose means citation support check, not human QA sign-off
- **snapshot vs Snapshot (template)**: project term is `snapshot_id` (governance), not generic project backup
- **hops vs tool_calls.length**: hops only count retrieve+verify; compile/governance do not consume hop budget
- **ordinal vs ts**: log field is `ordinal` (1-based sequence); do not use `ts` for tool call order
- **draft eval set**: `eval-set.draft.json` is DRAFT-EVAL-SET; hard_pass on draft ≠ production gate until real queries replace samples
- **chat vs test harness**: product CLI is TTY/pipe-aware session code under `src/cli/`; unit tests call `processChatLine` without claiming that is the product UX
- **--mode vs env**: explicit CLI `--mode` wins over `IKNOW_AGENT_MODE`; env alone may still select llm when flag omitted
- **9router key vs endpoint**: same `NINE_ROUTER_API_KEY` can yield `models` 200 while `chat/completions` or `embeddings` return 401; agent shell env may differ from operator interactive shell
- **SSE trailer vs stream flag**: gateway may return `text/event-stream` trailer even when client requested non-stream; use `parseLlmResponseJson`, not only `stream: false`
- **next phase focus**: multi-turn quality / message persistence / real KB data — not reopening the 4-tool protocol; I4 smoke archived

---

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

```bash
bash scripts/bootstrap.sh --interactive
```

---

**Maintenance cadence**: monthly review per project memory rules.
