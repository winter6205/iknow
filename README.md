# iknow

Standalone **enterprise knowledge-base Q&A agent** (not a pure RAG pipeline).

- **4 tools**: `kb_retrieve` · `kb_verify_citation` · `kb_compile` · `kb_governance`
- **Invariants**: dual-index ranking only; verify always on original text; G2 `snapshot_id` required; `max_hops=5`
- **Runtime boundary**: iknow does not load the external gbrain package or the read-only `_upstream_gbrain/` checkout at runtime — no package link, path import, symlink, dynamic loading, or execution
- **Heritage**: iknow is independently packaged and maintained, while its knowledge-agent architecture and capabilities are adapted from gbrain into iknow-owned `src/` code

Design truth: `docs/iknow-spec/` (HANDOFF → ADR → tool-schema → mapping → eval-set).

## Requirements

- Node.js >= 20
- npm

## Setup

```bash
npm install
npm run typecheck
npm test
# npm run eval 已退役 / 归档于 docs/archive/021-retire-legacy-loop-and-eval/ (see #48)
```

## Run

**Primary interactive entry is `chat`.** Use one-shot `ask` / bare query only for scripts and CI.

```bash
npx tsx src/cli.ts -h          # bilingual usage (中文 + English)
```

### Product defaults

| Invocation                    | Behavior                                  |
| ----------------------------- | ----------------------------------------- |
| `iknow` on a TTY              | open **chat** (primary interactive entry) |
| `iknow` when piped / non-TTY  | print usage                               |
| `iknow chat`                  | chat (TTY REPL or line-by-line pipe)      |
| `iknow ask "…"` / `iknow "…"` | **one-shot JSON** (scripts / CI)          |
| empty `ask` / empty query     | usage + exit 1 (no demo default query)    |

### Interactive chat (primary)

```bash
npx tsx src/cli.ts              # TTY → chat
npx tsx src/cli.ts chat
npx tsx src/cli.ts chat --mode deterministic --role employee
npx tsx src/cli.ts chat --json  # start with machine JSON output

# Piped multi-turn (no prompt garble; empty lines skipped; turns fully awaited)
printf '公司的退款政策是什么？\n\n/status\n/quit\n' | npx tsx src/cli.ts chat

# Quiet pipe: no turn markers on stderr
printf '公司的退款政策是什么？\n/quit\n' | IKNOW_CHAT_QUIET=1 npx tsx src/cli.ts chat
```

**TTY:** prompt `iknow> ` only after each turn finishes; banner / errors on stderr; answers on stdout; optional `思考中…` only when stderr is a TTY; separator line after each answer; single farewell on exit (no double「再见」).

**Pipe:** no prompts; empty lines skipped; `── turn N ──` on stderr unless `IKNOW_CHAT_QUIET=1`; no `思考中` spam; slash commands still work.

| Input                       | Behavior                                            |
| --------------------------- | --------------------------------------------------- |
| plain text                  | one `answer` turn (priors + short history injected) |
| blank line                  | skipped (pipe and TTY)                              |
| `/json on\|off`             | toggle full G2 JSON vs human view                   |
| `/role <r>`                 | set `caller_role` (employee\|manager\|admin)        |
| `/mode deterministic\|llm`  | rebuild agent when mode changes                     |
| `/status`                   | mode / role / json / turns / priors                 |
| `/reset`                    | clear turns / priors / history (store kept)         |
| `/help`                     | list commands                                       |
| `/quit` or `/exit` / Ctrl+D | leave                                               |

Human view shows answer + source_spans + governance/snapshot/hops.

### One-shot (JSON — scripts / CI)

```bash
npm run dev -- "公司的退款政策是什么？"
# or:
npx tsx src/cli.ts "公司的退款政策是什么？"
npx tsx src/cli.ts ask "公司的退款政策是什么？"

npm run dev -- --role employee "年假天数是怎么规定的？"
npm run dev -- --governance-timeout "检索时治理服务超时了，你还能正常回答退款政策吗？"
npm run eval # retired; 32-sample fixture archived at docs/archive/021-retire-legacy-loop-and-eval/docs/iknow-spec/docs/eval/eval-set.draft.json (see #48)
```

One-shot always prints G2 JSON on stdout so scripts do not break.

### Agent mode (M2 LLM path)

Default is **deterministic** (no network). To use the tool-calling LLM agent:

```bash
# CLI flag (takes precedence for this process)
npx tsx src/cli.ts --mode llm "公司的退款政策是什么？"

# or set env (see docs/integration-materials.env.example)
# IKNOW_AGENT_MODE=llm
```

Required env (names only — put real keys in the shell / OS secret store):

| Variable                | Role                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `IKNOW_LLM_API_KEY_ENV` | Name of env var that holds the API key (default `NINE_ROUTER_KEY`)           |
| _(that key env)_        | Actual secret value (e.g. export `NINE_ROUTER_KEY=...`)                      |
| `IKNOW_LLM_BASE_URL`    | OpenAI-compatible base (default `http://localhost:20128/v1` — 9router local) |
| `IKNOW_LLM_MODEL`       | 9router route id (default `m3-combo`)                                        |
| `IKNOW_AGENT_MODE`      | `deterministic` (default) or `llm`                                           |

If `--mode llm` is set but the key env is empty, CLI exits with `llm_mode_missing_api_key`.

### Optional: embedding vector arm (M1)

Default retrieve is keyword + overlap (offline). To enable the real embedding arm over an OpenAI-compatible HTTP API:

1. Copy `docs/integration-materials.env.example` settings into `.env.local` (never commit secrets).
2. Set `IKNOW_EMBEDDING_MODE=api` **or** pass `--embeddings` on the CLI.
3. `IKNOW_EMBEDDING_API_KEY_ENV` defaults to `NINE_ROUTER_KEY` (same as LLM) — override only if you split secrets.
4. Configure `IKNOW_EMBEDDING_BASE_URL` / `IKNOW_EMBEDDING_MODEL` / dims as needed.

```bash
# env-based
export IKNOW_EMBEDDING_MODE=api
npm run dev -- "公司的退款政策是什么？"

# flag-based (only useful when the key env is set)
npx tsx src/cli.ts --embeddings "公司的退款政策是什么？"
```

If the embedding API fails, the CLI continues with keyword-only retrieve. `npm test` stays offline and does **not** call the network. (`npm run eval` retired — see #48).

## Layout

| Path                   | Role                                                     |
| ---------------------- | -------------------------------------------------------- |
| `src/kb-retrieve/`     | Dual-arm score + RRF fusion                              |
| `src/kb-verify/`       | Pure three-state citation verify                         |
| `src/kb-compile/`      | Fact compile + content_hash dedup                        |
| `src/kb-governance/`   | Freshness / conflict / snapshot_id                       |
| `src/agent-loop/`      | Deterministic loop + G2 / hops guards                    |
| `src/knowledge-store/` | In-memory KB (standalone)                                |
| `src/fixtures/`        | Eval-aligned seed corpus                                 |
| `docs/iknow-spec/`     | Protocol + eval assets                                   |
| `_upstream_gbrain/`    | **Read-only reference clone** (gitignored; never import) |

## Upstream reference

`_upstream_gbrain/` may exist as a read-only source and algorithm baseline.  
It is **gitignored** and **must not** be imported or executed at runtime. iknow is an independently packaged and maintained adaptation of gbrain's knowledge-agent architecture; reviewed adaptations live in iknow-owned `src/` code rather than being loaded from this checkout.

Open implementation assumptions (pending ratification):  
`docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md`

## License

MIT (product code). Upstream gbrain reference remains under its own MIT license when present on disk.
