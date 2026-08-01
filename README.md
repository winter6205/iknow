# iknow

Standalone **enterprise knowledge-base Q&A agent** (not a pure RAG pipeline).

- **Agent execution surface**: harness foundation (`src/harness/`) with ACI decor layer prototype (`src/harness/aci/`, PR #95). The legacy 4-tool suite (`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`) is **archived 023** at `docs/archive/023-retire-kb-tools/`.
- **Invariants**: dual-index ranking only (archived); verify always on original text (archived); G2 `snapshot_id` required; `max_hops=5`
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
| `/status`                   | json / messages                                     |
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

npm run dev -- "年假天数是怎么规定的？"
npm run eval # retired; 32-sample fixture archived at docs/archive/021-retire-legacy-loop-and-eval/docs/iknow-spec/docs/eval/eval-set.draft.json (see #48)
```

One-shot always prints G2 JSON on stdout so scripts do not break.

### LLM configuration

The agent runs on a tool-calling LLM (harness anthropic-adapter). Required env (names only — put real keys in the shell / OS secret store):

| Variable                | Role                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `IKNOW_LLM_API_KEY_ENV` | Name of env var that holds the API key (default `NINE_ROUTER_KEY`)           |
| _(that key env)_        | Actual secret value (e.g. export `NINE_ROUTER_KEY=...`)                      |
| `IKNOW_LLM_BASE_URL`    | OpenAI-compatible base (default `http://localhost:20128/v1` — 9router local) |
| `IKNOW_LLM_MODEL`       | 9router route id (default `m3-combo`)                                        |

If the key env is empty, the runtime exits with `llm_mode_missing_api_key`.

## Layout

| Path                                  | Role                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `src/harness/`                        | Agent runtime foundation (loop-engine, anthropic-adapter, executor, registry) + ACI decor layer (`src/harness/aci/`)           |
| `src/knowledge-store/`                | In-memory KB (standalone)                                                                                                      |
| `src/fixtures/`                       | Eval-aligned seed corpus                                                                                                       |
| `docs/iknow-spec/`                    | Protocol + eval assets                                                                                                         |
| `docs/archive/023-retire-kb-tools/`   | Archived 4-tool suite (`kb_retrieve` / `kb_verify_citation` / `kb_compile` / `kb_governance`) + `src/tools/registry.ts` facade |
| `docs/archive/022-retire-agent-loop/` | Archived legacy agent loop                                                                                                     |
| `_upstream_gbrain/`                   | **Read-only reference clone** (gitignored; never import)                                                                       |

## Upstream reference

`_upstream_gbrain/` may exist as a read-only source and algorithm baseline.  
It is **gitignored** and **must not** be imported or executed at runtime. iknow is an independently packaged and maintained adaptation of gbrain's knowledge-agent architecture; reviewed adaptations live in iknow-owned `src/` code rather than being loaded from this checkout.

Open implementation assumptions (pending ratification):  
`docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md`

## License

MIT (product code). Upstream gbrain reference remains under its own MIT license when present on disk.
