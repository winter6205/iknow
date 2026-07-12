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

### One-shot (JSON — scripts / CI)

```bash
npm run dev -- "公司的退款政策是什么？"
# or:
npx tsx src/cli.ts "公司的退款政策是什么？"
npx tsx src/cli.ts ask "公司的退款政策是什么？"

npm run dev -- --role employee "年假天数是怎么规定的？"
npm run dev -- --governance-timeout "检索时治理服务超时了，你还能正常回答退款政策吗？"
npm run eval   # 32-sample trajectory suite (hard gates + trajectory_score)
```

### Interactive chat (REPL)

```bash
npx tsx src/cli.ts chat
npx tsx src/cli.ts chat --mode deterministic --role employee
npx tsx src/cli.ts chat --json          # start with machine JSON output
```

Prompt is `iknow> `. Session reuses one runtime + agent + conversation bag.

| Input | Behavior |
|-------|----------|
| plain text | one `answer` turn (priors + short history injected) |
| `/json on\|off` | toggle full G2 JSON vs human view |
| `/role <r>` | set `caller_role` (employee\|manager\|admin) |
| `/mode deterministic\|llm` | rebuild agent when mode changes |
| `/reset` | clear turns / priors / history (store kept) |
| `/help` | list commands |
| `/quit` or `/exit` / Ctrl+D | leave |

Human view shows answer + source_spans + governance/snapshot/hops. One-shot stays JSON so scripts do not break.

### Agent mode (M2 LLM path)

Default is **deterministic** (no network). To use the tool-calling LLM agent:

```bash
# CLI flag (takes precedence for this process)
npx tsx src/cli.ts --mode llm "公司的退款政策是什么？"

# or set env (see docs/integration-materials.env.example)
# IKNOW_AGENT_MODE=llm
```

Required env (names only — put real keys in the shell / OS secret store):

| Variable | Role |
|----------|------|
| `IKNOW_LLM_API_KEY_ENV` | Name of env var that holds the API key (default `NINE_ROUTER_API_KEY`) |
| *(that key env)* | Actual secret value (e.g. export `NINE_ROUTER_API_KEY=...`) |
| `IKNOW_LLM_BASE_URL` | OpenAI-compatible base (default `http://localhost:20128/v1`) |
| `IKNOW_LLM_MODEL` | Tool-capable model id |
| `IKNOW_AGENT_MODE` | `deterministic` (default) or `llm` |

If `--mode llm` is set but the key env is empty, CLI exits with `llm_mode_missing_api_key`.

### Optional: embedding vector arm (M1)

Default retrieve is keyword + overlap (offline). To enable the real embedding arm over an OpenAI-compatible HTTP API:

1. Copy `docs/integration-materials.env.example` settings into `.env.local` (never commit secrets).
2. Set `IKNOW_EMBEDDING_MODE=api` **or** pass `--embeddings` on the CLI.
3. Point `IKNOW_EMBEDDING_API_KEY_ENV` at the env var that holds the key (default `NINE_ROUTER_API_KEY`).
4. Configure `IKNOW_EMBEDDING_BASE_URL` / `IKNOW_EMBEDDING_MODEL` / dims as needed.

```bash
# env-based
export IKNOW_EMBEDDING_MODE=api
npm run dev -- "公司的退款政策是什么？"

# flag-based (only useful when the key env is set)
npx tsx src/cli.ts --embeddings "公司的退款政策是什么？"
```

If the embedding API fails, the CLI continues with keyword-only retrieve. `npm test` / `npm run eval` stay offline and do **not** call the network.

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
