# Architecture — iknow (standalone)

iknow is an independently packaged enterprise knowledge-base agent. Runtime code lives at the repository root under `src/`. It does **not** load the external gbrain package or the read-only `_upstream_gbrain/` checkout at runtime; its architecture and capability design are adapted from gbrain and maintained as iknow-owned code.

## Capability modules

| Module | Path | Responsibility |
|--------|------|----------------|
| ~~Retrieve~~ | `src/kb-retrieve/` (archived 023) | ~~Dual-arm ranking, RRF merge, A-filter → ranked chunks~~ |
| ~~Verify~~ | `src/kb-verify/` (archived 023) | ~~Pure three-state citation support check (`source_span`)~~ |
| ~~Compile~~ | `src/kb-compile/` (archived 023) | ~~Fact compile + content_hash dedup~~ |
| ~~Governance~~ | `src/kb-governance/` (archived 023) | ~~Freshness, conflict, `snapshot_id`~~ |
| Archived suites | `docs/archive/023-retire-kb-tools/`, `docs/archive/022-retire-agent-loop/` | Retired 4-tool suite + agent-loop facade |
| Harness (Foundation) | `src/harness/` | Loop Engine + Anthropic adapter + Executor + Registry + ACI decor layer (`src/harness/aci/`); CLI product path runs through `buildHarnessEngine` (spec: `specs/minimum-sequential-agent-loop.md`) |
| Runtime / config | `src/runtime/`, `src/config/` | Runtime bootstrap (`createIknowRuntime` returns `store + env`); `.env`+`process.env` loading |
| Knowledge store | `src/knowledge-store/` | In-memory KB abstraction (replaceable later) |
| Shared | `src/shared/` | Schema (`CallerRole` / `SessionContext`), errors, hashing helpers |
| CLI / entry | `src/cli.ts`, `src/index.ts` | Dev/ask + `chat` REPL + `serve` entrypoints |
| Session HTTP | `src/session-api/` | Multi-conversation hub + node:http API; static root prefers `web/dist` |
| Web UI | `web/` | Vite + React + TypeScript SPA (product console); build → `web/dist`; see `docs/design/frontend-stack-upgrade-v1.md` |

```text
user query
    │
    ▼
 harness (src/harness/)  ──maxTurns──►  Anthropic adapter
    │
    ├── fs_search / fs_view / fs_edit (ACI, read-only / write)
    ├── shell_exec (ACI, allowlist-first shell)
    └── context_manager (ACI, lazy observability compression)
```

> 023 退役说明：`kb_*` 套件与其 vanilla facade `src/tools/registry.ts` 归档于
> `docs/archive/023-retire-kb-tools/`。CLI 产品路径在 020 切到 harness 后已不再
> 消费 `kb_*`，agent 执行层改由 harness ACI 装饰层（PR #95，`src/harness/aci/`）
> 承接。`src/shared/schema.ts` 中的 `Kb*Input/Output` / `Chunk` / `PriorChunk` 等
> 协议类型同步删除；`CallerRole` / `SessionContext` 保留（CLI slash + banner 仍用）。

## Design truth vs reference

| Asset | Role |
|-------|------|
| `docs/iknow-spec/` | **Design truth** — ADR, tool-schema, eval, handoff |
| `docs/iknow-spec/docs/protocol/ADR-v0.1-assumptions-p3.md` | Open P3 assumptions (pending ratification) |
| `_upstream_gbrain/` | **Reference only** — gitignored snapshot of upstream gbrain |

## The upstream checkout is reference-only, not a runtime dependency

- `_upstream_gbrain/` (and obsolete `gbrain/`) are **gitignored** and **READ-ONLY**.
- Application code must **not** import, symlink, dynamically load, execute, or package-depend on those trees.
- Reviewed source, architecture, and capability ideas may be adapted into `src/*`; once adapted, that implementation is maintained as iknow-owned runtime code.
- See `docs/UPSTREAM_BASELINE.md` for baseline pin and policy.

## Interaction design (product surface)

Multi-turn chat / REPL is a **host-layer** concern (not a 5th tool). See:

- **`docs/design/interaction-surface-v0.md`** — design v0; **I1–I3 + HTTP/web host** (I3.5 SPA)
- **`docs/design/session-http-api-v0.md`** — Session REST contract
- **`docs/design/frontend-stack-upgrade-v1.md`** — Vite React TS stack decision + component tree
- **`src/interaction/`** — `ConversationState`, priors/history, format, slash commands
- **`src/session-api/`** — HTTP host over the same conversation bag
- **`npx tsx src/cli.ts chat`** — REPL; one-shot `ask` / bare query stay JSON for scripts
- **`npx tsx src/cli.ts serve`** / **`npm run serve`** — Session API + SPA static (`web/dist`)
- **`npm run dev --prefix web`** / **`npm run build --prefix web`** — Vite SPA dev / prod build

Cross-turn bridge = protocol `prior_chunks` (+ LLM-only short `history`). No fifth tool.

## Non-goals (this scaffold)

- Durable multi-tenant store (in-memory only for now)
- Production auth / multi-tenant isolation (high-risk; separate track)
- Bundling or re-exporting gbrain binaries
- Claiming full interactive product parity until I4 live smoke (+ optional I5 multi-turn eval)
