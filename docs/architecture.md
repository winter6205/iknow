# Architecture — iknow (standalone)

iknow is an independently packaged **agent harness** for a tool-calling LLM CLI (loop engine + Anthropic adapter + ACI tool set). Runtime code lives at the repository root under `src/`. It does **not** load the external gbrain package or the read-only `_upstream_gbrain/` checkout at runtime; its architecture and capability design are adapted from gbrain and maintained as iknow-owned code.

## Capability modules

| Module               | Path                         | Responsibility                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness (Foundation) | `src/harness/`               | Loop Engine + Anthropic adapter + Executor + Registry + ACI decor layer (`src/harness/aci/`); CLI product path runs through `buildHarnessEngine` (module specs under `specs/`)                                                                                                                                                                                                |
| Config               | `src/config/`                | `.env`+`process.env` loading (base `http://localhost:20128/v1` 仍为代码默认 via `IKNOW_LLM_BASE_URL`); LLM 配置收敛到 `settings.json` 单承载（`settings.llm.model` 字面值 / `settings.llm.apiKey` 字面或 `${VAR}` 占位符经 `expandPlaceholders` 解析；ADR-0015 settings-model-extension）。`IKNOW_LLM_API_KEY_ENV` / `IKNOW_LLM_MODEL` 已退役。                               |
| Shared               | `src/shared/`                | Schema (`SessionContext`), errors                                                                                                                                                                                                                                                                                                                                             |
| CLI / entry          | `src/cli.ts`, `src/index.ts` | Dev/ask + `chat` REPL + `serve` + `trace` + `tui` entrypoints                                                                                                                                                                                                                                                                                                                 |
| Session HTTP         | `src/session-api/`           | Multi-conversation hub + node:http API; static root prefers `web/dist`                                                                                                                                                                                                                                                                                                        |
| Trace inspection     | `src/traceserver/`           | Standalone `iknow trace` process (#183): read-only JSONL trace query — `GET /api/v1/traces` (filter + paginate) + `/api/v1/traces/fields` + `/api/v1/health`; also hosts the trace inspection panel SPA (trace.html, fallback) via shared `src/web/serve-static.ts`; field declaration table is the SSOT driving the panel columns (write side lives in `src/harness/trace/`) |
| Web UI               | `web/`                       | Vite + React + TypeScript SPA (product console); build → `web/dist`                                                                                                                                                                                                                                                                                                           |
| TUI                  | `src/tui/`                   | ink@^7 multi-session terminal UI (spec: `specs/146-tui.md`); α direct-connects `SessionHub` (shares pool with `serve`), slash nav + 3-state session machine                                                                                                                                                                                                                   |

```text
user query
    │
    ▼
 harness (src/harness/)  ──maxTurns──►  Anthropic adapter
    │
    ├── bash (ACI, execute; allowlist-first shell, #123 沙箱落地前过渡)
    ├── read_file / grep / glob (ACI, read-only; 无状态 + 真 glob + 路径:行号:内容)
    └── edit_file / write_file (ACI, write; poka-yoke linter)
```

## Design truth vs reference

| Asset                   | Role                                                      |
| ----------------------- | --------------------------------------------------------- |
| `specs/` (module specs) | **Design truth** — Foundation per-module specs            |
| `_upstream_gbrain/`     | **Reference only** — gitignored mirror of upstream gbrain |

## The upstream checkout is reference-only, not a runtime dependency

- `_upstream_gbrain/` (and obsolete `gbrain/`) are **gitignored** and **READ-ONLY**.
- Application code must **not** import, symlink, dynamically load, execute, or package-depend on those trees.
- Reviewed source, architecture, and capability ideas may be adapted into `src/*`; once adapted, that implementation is maintained as iknow-owned runtime code.
- See `docs/UPSTREAM_BASELINE.md` for baseline pin and policy.

## Interaction design (product surface)

Multi-turn chat / REPL is a **host-layer** concern. See:

- **`src/session-api/`** — HTTP host over the harness conversation
- **`src/cli/`** — TTY REPL + one-shot `ask` (session state in `RuntimeBundle`), slash commands
- **`npx tsx src/cli.ts chat`** — REPL; one-shot `ask` / bare query stay JSON for scripts
- **`npx tsx src/cli.ts serve`** / **`npm run serve`** — Session API + SPA static (`web/dist`)
- **`npm run dev --prefix web`** / **`npm run build --prefix web`** — Vite SPA dev / prod build

Cross-turn state lives in the harness turn loop (LLM history within `run()`)
plus a per-session `SessionContext` marker.

## Non-goals (this scaffold)

- Durable multi-tenant store
- Production auth / multi-tenant isolation (high-risk; separate track)
- Bundling or re-exporting gbrain binaries
- Re-introducing a dedicated tool suite alongside the harness ACI tool set
