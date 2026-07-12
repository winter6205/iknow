# Architecture — iknow (standalone)

iknow is a **standalone** enterprise knowledge-base agent. Runtime code lives at the repository root under `src/`. It is **not** a nested gbrain workspace and has **no** runtime dependency on gbrain.

## Capability modules

| Module | Path | Responsibility |
|--------|------|----------------|
| Retrieve | `src/kb-retrieve/` | Dual-arm ranking, RRF merge, A-filter → ranked chunks |
| Verify | `src/kb-verify/` | Pure three-state citation support check (`source_span`) |
| Compile | `src/kb-compile/` | Fact compile + content_hash dedup |
| Governance | `src/kb-governance/` | Freshness, conflict, `snapshot_id` |
| Agent loop | `src/agent-loop/` | Tool orchestration, `max_hops`, G2 envelope |
| Knowledge store | `src/knowledge-store/` | In-memory KB abstraction (replaceable later) |
| Shared | `src/shared/` | Schema, errors, hashing helpers |
| CLI / entry | `src/cli.ts`, `src/index.ts` | Dev/ask + `chat` REPL + `serve` entrypoints |
| Interaction host | `src/interaction/` | Conversation bag, human/json format, slash parse (no tool schema change) |
| Session HTTP | `src/session-api/` | Multi-conversation hub + node:http API + static web root |
| Web UI | `web/` | Same-origin chat page (G2 side panel); no new FE framework |

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

## gbrain is reference-only, not a dependency

- `_upstream_gbrain/` (and obsolete `gbrain/`) are **gitignored** and **READ-ONLY**.
- Application code must **not** import, symlink, or package-depend on those trees.
- Capability ideas may be **ported** into `src/*`; runtime behavior is entirely under the `iknow` package.
- See `docs/UPSTREAM_BASELINE.md` for baseline pin and policy.

## Interaction design (product surface)

Multi-turn chat / REPL is a **host-layer** concern (not a 5th tool). See:

- **`docs/design/interaction-surface-v0.md`** — design v0; **I1–I3 + HTTP/web host**
- **`docs/design/session-http-api-v0.md`** — Session REST contract
- **`src/interaction/`** — `ConversationState`, priors/history, format, slash commands
- **`src/session-api/`** — HTTP host over the same conversation bag
- **`npx tsx src/cli.ts chat`** — REPL; one-shot `ask` / bare query stay JSON for scripts
- **`npx tsx src/cli.ts serve`** — Web UI + `/api/v1/*`

Cross-turn bridge = protocol `prior_chunks` (+ LLM-only short `history`). No fifth tool.

## Non-goals (this scaffold)

- Durable multi-tenant store (in-memory only for now)
- Production auth / multi-tenant isolation (high-risk; separate track)
- Bundling or re-exporting gbrain binaries
- Claiming full interactive product parity until I4 live smoke (+ optional I5 multi-turn eval)
