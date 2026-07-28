# Architecture — iknow (standalone)

iknow is an independently packaged enterprise knowledge-base agent. Runtime code lives at the repository root under `src/`. It does **not** load the external gbrain package or the read-only `_upstream_gbrain/` checkout at runtime; its architecture and capability design are adapted from gbrain and maintained as iknow-owned code.

## Capability modules

| Module | Path | Responsibility |
|--------|------|----------------|
| Retrieve | `src/kb-retrieve/` | Dual-arm ranking, RRF merge, A-filter → ranked chunks |
| Verify | `src/kb-verify/` | Pure three-state citation support check (`source_span`) |
| Compile | `src/kb-compile/` | Fact compile + content_hash dedup |
| Governance | `src/kb-governance/` | Freshness, conflict, `snapshot_id` |
| Agent loop | `src/agent-loop/` | Tool orchestration, `max_hops`, G2 envelope（**待退役**：016->018 路线由 `src/harness/` Foundation 取代） |
| Harness (Foundation) | `src/harness/` | Loop Engine + Anthropic adapter + stubs + Executor + Registry；**暂不接产品流量**，4 tool 协议不动（spec: `specs/minimum-sequential-agent-loop.md`） |
| Runtime / tools / config | `src/runtime/`, `src/tools/`, `src/config/` | 运行时装配 / 工具注册 / `.env`+`process.env` 加载 |
| Knowledge store | `src/knowledge-store/` | In-memory KB abstraction (replaceable later) |
| Shared | `src/shared/` | Schema, errors, hashing helpers |
| Eval | `src/eval/` | Trajectory scorer + suite runner（`npm run eval`） |
| CLI / entry | `src/cli.ts`, `src/index.ts` | Dev/ask + `chat` REPL + `serve` entrypoints |
| Interaction host | `src/interaction/` | Conversation bag, human/json format, slash parse (no tool schema change) |
| Session HTTP | `src/session-api/` | Multi-conversation hub + node:http API; static root prefers `web/dist` |
| Web UI | `web/` | Vite + React + TypeScript SPA (product console); build → `web/dist`; G2 side panel projection; see `docs/design/frontend-stack-upgrade-v1.md` |

```text
user query
    │
    ▼
 agent-loop  ──max_hops──►  G2 envelope
    │
    ├── kb_retrieve ──► knowledge-store (chunks)
    ├── kb_verify_citation
    ├── kb_compile ──► facts
    └── kb_governance ──► snapshot / freshness / conflict
```

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
