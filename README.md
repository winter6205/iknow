# iknow

Standalone **agent harness** for a tool-calling LLM CLI — loop engine +
Anthropic adapter + an 8-tool ACI tool set (`bash` / `read_file` / `grep` /
`glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`), wired into a
TTY `chat` REPL, a script-friendly one-shot `ask`, and an HTTP `serve` host
that serves a Vite React SPA.

- **Agent execution surface**: harness foundation (`src/harness/`) with ACI decor layer (`src/harness/aci/`, PR #95).
- **Invariants**: harness-driven tool use with permission middleware (ADR-0004 / ADR-0006); streaming arm on by default (`IKNOW_LLM_STREAM=on`, `src/config/env.ts`); key var default `ANTHROPIC_AUTH_TOKEN`; project stack defaults baked into `env.ts` (ADR-0001, with 2026-08-05 update).
- **Runtime boundary**: iknow does not load the external gbrain package or the read-only `_upstream_gbrain/` checkout at runtime — no package link, path import, symlink, dynamic loading, or execution

Design truth: `src/harness/` + module specs under `specs/`
(`security-guardrails.md` / `trace-service.md` / `146-tui.md` / `120-session-persistence.md`).

## Requirements

- Node.js >= 20
- npm

## Setup

```bash
npm install
npm run typecheck
npm test
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
| plain text                  | one harness `run()` turn (session history injected) |
| blank line                  | skipped (pipe and TTY)                              |
| `/json on\|off`             | toggle full JSON vs human view                      |
| `/status`                   | json / messages                                     |
| `/reset`                    | clear session turns / history                       |
| `/help`                     | list commands                                       |
| `/quit` or `/exit` / Ctrl+D | leave                                               |

Human view shows the streamed answer text (markdown rendered by the SPA).

### One-shot (JSON — scripts / CI)

```bash
npm run dev -- "公司的退款政策是什么？"
# or:
npx tsx src/cli.ts "公司的退款政策是什么？"
npx tsx src/cli.ts ask "公司的退款政策是什么？"
```

One-shot always prints JSON on stdout so scripts do not break.

### LLM configuration

The agent runs on a tool-calling LLM (harness anthropic-adapter). Required env (names only — put real keys in the shell / OS secret store):

| Variable                | Role                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `IKNOW_LLM_API_KEY_ENV` | Name of env var that holds the API key (default `ANTHROPIC_AUTH_TOKEN`)         |
| _(that key env)_        | Actual secret value (e.g. export `ANTHROPIC_AUTH_TOKEN=...`)                    |
| `IKNOW_LLM_BASE_URL`    | Anthropic-compatible base (default `http://localhost:20128/v1` — 9router local) |
| `IKNOW_LLM_MODEL`       | 9router route id (default `m3-combo`)                                           |

If the key env is empty, the runtime exits with `llm_mode_missing_api_key`.

## Layout

| Path                | Role                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/harness/`      | Agent runtime foundation (loop-engine, anthropic-adapter, executor, registry) + ACI decor layer (`src/harness/aci/`) |
| `_upstream_gbrain/` | **Read-only reference clone** (gitignored; never import)                                                             |

## Upstream reference

`_upstream_gbrain/` may exist as a read-only source and algorithm baseline.  
It is **gitignored** and **must not** be imported or executed at runtime. iknow is an independently packaged and maintained adaptation of gbrain's agent-harness architecture; reviewed adaptations live in iknow-owned `src/` code rather than being loaded from this checkout.

## License

MIT (product code). Upstream gbrain reference remains under its own MIT license when present on disk.
