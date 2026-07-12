# iknow

Standalone **enterprise knowledge-base Q&A agent** (not a pure RAG pipeline).

- **4 tools**: `kb_retrieve` · `kb_verify_citation` · `kb_compile` · `kb_governance`
- **Invariants**: dual-index ranking only; verify always on original text; G2 `snapshot_id` required; `max_hops=5`
- **Runtime**: **zero dependency on gbrain** — no package link, no path import, no symlink to `_upstream_gbrain`

Design truth: `docs/iknow-spec/` (HANDOFF → ADR → tool-schema → mapping → eval-set).

## Requirements

- Node.js >= 20
- npm

## Setup

```bash
npm install
npm run typecheck
npm test
npm run eval
```

## Run

```bash
npm run dev -- "公司的退款政策是什么？"
npm run dev -- --role employee "年假天数是怎么规定的？"
npm run dev -- --governance-timeout "检索时治理服务超时了，你还能正常回答退款政策吗？"
npm run eval   # 32-sample trajectory suite (hard gates + trajectory_score)
```

## Layout

| Path | Role |
|------|------|
| `src/kb-retrieve/` | Dual-arm score + RRF fusion |
| `src/kb-verify/` | Pure three-state citation verify |
| `src/kb-compile/` | Fact compile + content_hash dedup |
| `src/kb-governance/` | Freshness / conflict / snapshot_id |
| `src/agent-loop/` | Deterministic loop + G2 / hops guards |
| `src/knowledge-store/` | In-memory KB (standalone) |
| `src/fixtures/` | Eval-aligned seed corpus |
| `docs/iknow-spec/` | Protocol + eval assets |
| `_upstream_gbrain/` | **Read-only reference clone** (gitignored; never import) |

## Upstream reference

`_upstream_gbrain/` may exist for human/algorithm study (Company Brain patterns).  
It is **gitignored** and **must not** be imported at runtime. iknow is a rewrite, not a linked fork workspace.

Open implementation assumptions (pending ratification):  
`docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md`

## License

MIT (product code). Upstream gbrain reference remains under its own MIT license when present on disk.
