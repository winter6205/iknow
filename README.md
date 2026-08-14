# iknow

Standalone **agent harness** for a tool-calling LLM CLI — loop engine +
Anthropic adapter + an ACI tool set (SSOT: `src/harness/aci/tools/registry.ts`;
core 8 + `memory_recall` / `memory_save` / `tool_search` + 10 LSP entries +
`skill` / `skill_search` + `spawn_subagent` / `subagent_result`, several of
which are conditional on user configuration), wired into a TTY `chat` REPL, a
script-friendly one-shot `ask`, and an HTTP `serve` host that serves a Vite
React SPA.

- **Agent execution surface**: harness foundation (`src/harness/`) with ACI decor layer (`src/harness/aci/`).
- **Invariants**: harness-driven tool use with permission middleware; streaming arm on by default (`IKNOW_LLM_STREAM=on`, `src/config/env.ts`); LLM key configured via `settings.llm.apiKey` literal or `${VAR}` placeholder (ADR-0015); project stack defaults baked into `env.ts` (ADR-0001, settings.json single source of truth 后).
- **Runtime boundary**: iknow ships only its own source under `src/`; no upstream reference directory is linked, imported, symlinked, dynamically loaded, or executed at runtime.

Design truth: `src/harness/` + module specs under `specs/`
(live index: [`specs/README.md`](specs/README.md) — 只列当前活跃 spec，新增/归档只改那里一处).

## Requirements

- Node.js >= 20
- npm

## Setup

```bash
npm install
npm run typecheck
npm test
```

### TUI (OpenTUI)

`@opentui/core` 与 `@opentui/react` 是常规 `dependencies`,`npm install` / `npm ci` 默认装上
当前平台的 native core (`@opentui/core-linux-x64` / `-musl`, `-darwin-*`,
`-win32-*`)。启动前可跑一遍 binding 自检(同时覆盖装一半 / 损坏场景):

```bash
npm run probe:tui-binding   # 6/6 passed → exit 0; any FAIL → exit 1
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

Human view writes the streamed answer text directly to stdout; markdown rendering belongs to the `serve` SPA.

### One-shot (JSON — scripts / CI)

```bash
npm run dev -- "公司的退款政策是什么？"
# or:
npx tsx src/cli.ts "公司的退款政策是什么？"
npx tsx src/cli.ts ask "公司的退款政策是什么？"
```

One-shot always prints JSON on stdout so scripts do not break.

### LLM configuration

The agent runs on a tool-calling LLM (harness anthropic-adapter). LLM configuration is **single-sourced** in `~/.iknow/settings.json` (user) merged with `<cwd>/.iknow/settings.json` (project over user) — see `docs/adr/0015-llm-config-settings-single-source.md` (settings-model-extension, ADR-0015):

| Settings field            | Role                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `llm.model`               | 9router route id (字面值，唯一来源；缺失 fail-fast 抛「no LLM model configured…」) |
| `llm.apiKey`              | 字面密钥 / `${VAR}` 占位符（loader 从 `process.env` / `.env.local` / `.env` 解析） |
| `llm.fallback?: string[]` | 用户自配的 fallback 路由 ID 列表（代码不预置）                                     |

Provider/baseUrl 仍由 env.ts 代码默认（`http://localhost:20128/v1`，9router），可用 `IKNOW_LLM_BASE_URL` 覆盖。

If `settings.llm.apiKey` is missing/unresolvable, the runtime exits with `llm_mode_missing_api_key`. The previous `IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` env mechanisms are retired (ADR-0015).

## Layout

| Path               | Role                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/harness/`     | Agent runtime foundation (loop-engine, anthropic-adapter, executor, registry) + ACI decor layer (`src/harness/aci/`) |
| `src/cli/`         | Product CLI entrypoints (`chat` / `ask` / `serve` / `tui`)                                                           |
| `src/tui/`         | OpenTUI TUI surface (slash routing, components, layouts)                                                             |
| `src/config/`      | `env.ts` settings loader (ADR-0015 single source)                                                                    |
| `src/session-api/` | Static SPA host (`prefer web/dist`, falls back to `web/`) + session pool                                             |
| `web/`             | Vite React SPA (built into `web/dist`, served by `src/session-api/`)                                                 |
| `specs/`           | Foundation per-module specs (live index: `specs/README.md`)                                                          |
| `docs/`            | Architecture, ADR catalog, status, handoff notes                                                                     |

## License

MIT (product code).
