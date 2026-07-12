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
The agent response envelope shape (structured final answer contract after the hop loop).
_Avoid_: Final answer bag, response wrapper, JSON reply shell

**kb_retrieve**:
Tool that dual-arm ranks and merges candidates (e.g. RRF + filters) into ranked Chunks for the agent loop.
_Avoid_: search, RAG query, vector lookup (alone)

**kb_verify** / **kb_verify_citation**:
Tool that pure three-state checks whether a claim is supported by a given `source_span` / chunk evidence.
_Avoid_: fact-check, NLI pass, trust score

**kb_compile**:
Tool that turns verified evidence into Facts with content_hash dedup for stable reuse.
_Avoid_: summarize, extract, ingest

**kb_governance**:
Tool that checks freshness, conflicts, and `snapshot_id` scope before or after compilation.
_Avoid_: ACL admin, content moderation, CMS publish

**max_hops**:
Hard budget on agent-loop tool-call rounds (protocol default 5) before forcing a G2 envelope exit.
_Avoid_: retries, steps, turns (unless clearly UI chat turns)

## Relationships

- **Query → kb_retrieve → Chunk[]**: agent issues a retrieve hop; store returns ranked chunks
- **Chunk + claim → kb_verify_citation → three-state**: verify binds claim to `source_span`
- **Verified evidence → kb_compile → Fact**: compile emits content_hash–stable facts
- **Fact / KB view → kb_governance → snapshot_id status**: governance stamps freshness/conflict
- **Agent loop → max_hops → G2**: loop terminates into G2 envelope when done or budget exhausted

## Flagged ambiguities

- **gbrain vs iknow runtime**: `_upstream_gbrain/` is READ-ONLY design reference; product runtime is standalone `iknow` with **zero** import/link to gbrain
- **"verify" alone**: prefer `kb_verify_citation` / `kb_verify` tool name in code; "verify" in prose means citation support check, not human QA sign-off
- **snapshot vs Snapshot (template)**: project term is `snapshot_id` (governance), not generic project backup

---

## Bootstrap mode

If this file only had template examples and no real project terms, seed via:

```bash
bash scripts/bootstrap.sh --interactive
```

---

**Maintenance cadence**: monthly review per `.claude/rules/memory.md` memory maintenance section.
