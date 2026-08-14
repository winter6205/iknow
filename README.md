# iknow

Standalone **agent harness** for a tool-calling LLM CLI — loop engine +
Anthropic adapter + an 11-tool ACI tool set (`bash` / `read_file` / `grep` /
`glob` / `edit_file` / `write_file` / `web_fetch` / `web_search` /
`memory_recall` / `memory_save` / `tool_search`; SSOT: `src/harness/aci/tools/registry.ts`), wired into a
TTY `chat` REPL, a script-friendly one-shot `ask`, and an HTTP `serve` host
that serves a Vite React SPA.

- **Agent execution surface**: harness foundation (`src/harness/`) with ACI decor layer (`src/harness/aci/`, PR #95).
- **Invariants**: harness-driven tool use with permission middleware (ADR-0004 / ADR-0006); streaming arm on by default (`IKNOW_LLM_STREAM=on`, `src/config/env.ts`); key configured via `settings.llm.apiKey` literal/placeholder (ADR-0015); project stack defaults baked into `env.ts` (ADR-0001, settings.json 单承载后).
- **Runtime boundary**: iknow does not load the external gbrain package or the read-only `_upstream_gbrain/` checkout at runtime — no package link, path import, symlink, dynamic loading, or execution

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

### TUI on WSL / Linux

The TUI (OpenTUI) ships its native rendering core as npm **optionalDependencies**
(`@opentui/core-linux-x64` / `-musl`, `-darwin-*`, `-win32-*`, …). A plain
`npm install` skips them, so on a fresh checkout the TUI fails to start with
`OpenTUI native FFI is not available`. Install optional deps explicitly:

```bash
npm install --include=optional
```

Before launching the TUI, run the binding self-check (also covers a broken /
partial optional-deps install):

```bash
npm run probe:tui-binding   # 6/6 passed → exit 0; any FAIL → exit 1
```

`npm ci` (clean install) 自动安装 `optionalDependencies`,无需 `--include=optional` flag;
缺失时 TUI 启动即崩 — 探针可前置兜底。`npm install` 第一次拉依赖则**必须**带
`--include=optional`(npm 默认行为是跳过 optionalDependencies)。

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

The agent runs on a tool-calling LLM (harness anthropic-adapter). LLM configuration is **single-sourced** in `~/.iknow/settings.json` (user) merged with `<cwd>/.iknow/settings.json` (project over user) — see `docs/adr/0015-llm-config-settings-single-source.md` (settings-model-extension, ADR-0015):

| Settings field            | Role                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `llm.model`               | 9router route id (字面值，唯一来源；缺失 fail-fast 抛「no LLM model configured…」)    |
| `llm.apiKey`              | 字面密钥 / `${VAR}` 占位符（指向环境变量名，loader 从 process.env / .env.local 解析） |
| `llm.fallback?: string[]` | 用户自配的 fallback 路由 ID 列表（代码不预置）                                        |

Provider/baseUrl 仍由 env.ts 代码默认（`http://localhost:20128/v1`，9router），可用 `IKNOW_LLM_BASE_URL` 覆盖。

If `settings.llm.apiKey` is missing/unresolvable, the runtime exits with `llm_mode_missing_api_key`. The previous `IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` env mechanisms are retired (ADR-0015).

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
