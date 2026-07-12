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
| CLI / entry | `src/cli.ts`, `src/index.ts` | Dev/ask entrypoints |

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

## Non-goals (this scaffold)

- Durable multi-tenant store (in-memory only for now)
- Production auth / multi-tenant isolation (high-risk; separate track)
- Bundling or re-exporting gbrain binaries
