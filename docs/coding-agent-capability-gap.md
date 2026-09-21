# Coding-Agent Capability Gap Assessment

> **Assessment date**: 2026-08-25 (revised after the concurrency/sandbox-discipline package merged)  
> **Method**: capability yardstick + iknow capability inventory + deep verification of the harness kernel  
> **Basis for conclusions**: code and active `specs/` are authoritative; STATUS §1/§3 was aligned on 2026-08-25 with the TUI-awareness package (PR #666), the concurrency/sandbox-discipline package (PR #671), and fault recovery (#672; code in PRs #683–#685).

---

## 1. Overall verdict

A production-grade coding agent can be summarized as:

> **Agent = Model + Harness**  
> **Harness = context management + tool interface + constraints + verification + correction**

iknow has moved past the "seven-minimal-tool ReAct demo"; its kernel sits at **early production-grade harness** level.  
The remaining work is not "stacking more tools" but **reliability-engineering depth, first-class engineered workflows, and the product/observability surface**.

One-line positioning:

> **iknow sits in the mid tier of the category-leading open-source coding-agent harnesses**: tools, verification scaffolding, TUI awareness (PR #666), foreground/background sandbox discipline + `isConcurrencySafe` parallel scheduling (PR #671), and FaultClass / transport retry / tool-loop `fused` (#672) have landed. Near-term gaps shift to the streaming host surface and the clarification/design-approval workflow.

---

## 2. Capability yardstick (compressed)

### 2.1 Operational definition

A complete coding agent must simultaneously:

- write, modify, and execute code autonomously;
- use the file system as the hub for memory / knowledge / artifacts;
- keep a minimal composable toolbox (seven tools or an equivalent Bash);
- have the harness enforce constraints—verification—correction: with a clear goal, acceptance is automated (tests / CI / lint), dangerous actions are bounded by sandbox and semantic-level guardrails, and faults have tiered recovery and circuit breaking;
- **judge completion by verification passing, not by the model claiming it is done**.

High maturity usually comes not from a stronger model but from engineering infrastructure — tests, type checking, version control — forming a strong harness.

### 2.2 Maturity ladder

| Tier               | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| Minimal viable     | LLM + ReAct + seven tools (or a single Bash) + result write-back             |
| Production-grade   | + permissions / sandbox / semantic constraints, layered compaction, fault-recovery circuit breaking, escalation to a human |
| General open tasks | + FS memory, Skills / MCP, subagent isolation, project instruction files     |
| Frontier           | post-training, delegation fidelity, Graph / Loop, self-bootstrapping, symbol-level IDE |

### 2.3 Architecture principles, TOP 5

1. **Harness beats model swapping** — competitiveness lies in constraints / verification / correction.
2. **Constraints over guidance; automate verification; fast, structured feedback; reliable rollback**.
3. **Completion is decided by verification, not by the model's self-report**.
4. **File system as hub + knowledge lives in the repo** (invisible to the Agent ≈ nonexistent).
5. **Observation / action space and ACI** — widening the interface is often more effective than swapping the model.

---

## 3. iknow status summary

### 3.1 Product positioning

A standalone-packaged tool-calling LLM agent harness (loop engine + Anthropic adapter + ACI toolset), delivered as a local coding assistant via CLI / TUI / Session HTTP + Web.

Evidence: `docs/architecture.md`, `docs/STATUS.md` §1.1.

### 3.2 Already present in the kernel

| Capability               | State                                        | Primary evidence                                                          |
| ------------------------ | -------------------------------------------- | ------------------------------------------------------------------------- |
| Loop + stop semantics    | landed                                       | `src/harness/loop-engine.ts`; 7 StopReason classes                        |
| ACI tool surface         | landed (~30 names conditionally assembled + `mcp__*`) | `src/harness/aci/tools/registry.ts`                                 |
| Context compaction       | landed                                       | `src/harness/compress/`; proactive + reactive                             |
| Permissions–sandbox–secrets | strong-leaning (hard walls ≠ semantic AST) | `permission/` + shared bwrap fence + `secret-roundtrip/`                  |
| Verify loop              | kernel strong / TUI human-readable added (PR #666) | `src/harness/verify/`; `src/tui/verify-banner.tsx`; hub projection includes `passed` |
| Subagent                 | process isolation mature; orchestration not productized | `src/harness/subagent/`; `graph/` not wired                             |
| Skill / MCP / Memory / LSP | landed (with scope boundaries)             | `skill/`, `mcp/`, `memory/`, `lsp/`                                       |
| Multi-surface            | landed                                       | CLI / TUI / serve+SPA / Trace (ADR-0020)                                  |

### 3.3 Tool-surface SSOT (excerpt)

`ACI_TOOLSET_NAMES` includes: `bash`, `read_file`, `grep`, `glob`, `edit_file`, `write_file`, `web_*`, `memory_*`, `tool_search`, `lsp_*` (×10), `skill` / `skill_search`, `spawn_subagent` / `subagent_result`, `todo_write`, `list_mcp_resources` / `read_mcp_resource`, `bash_output` / `bash_stop`, etc. (conditionally assembled).

### 3.4 Explicit non-goals (deliberately not done)

- a separate dedicated tool suite outside the harness ACI
- durable multi-tenancy / production authentication (architecture non-goals)
- model post-training / agent self-bootstrapping (outside the current product positioning)

---

## 4. Capability completion matrix

| Dimension                     | Target capability                              | iknow                                                            | Completion level                                                        |
| ----------------------------- | ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Core toolbox                  | seven tools                                    | covered and broader (incl. LSP×10 etc.)                          | **Exceeds**                                                              |
| Loop / stop semantics         | ReAct + explicit stops                         | loop-engine + StopReason                                         | **Aligned**                                                              |
| Context compaction            | layered compaction + circuit breaking          | proactive / reactive compact                                     | **Mostly aligned** (budget not yet strictly charged against system/tools) |
| Permissions / sandbox         | default authorization; bwrap; semantic-level shell constraints | per-call ask + one shared bwrap fence for foreground/background + hard walls | **Partial** (hard walls ≠ semantic AST; PR #671 aligned the discipline, this is **not** unsandboxed execution) |
| Verify loop                   | tests/CI decide completion                     | verify-loop + evidence-checker + judge                           | **Kernel strong / TUI human-readable added** (PR #666); Trace/Web product surface still weak |
| Environment present vs status bar | human-readable cwd/git/diff; model-side bar separately agreed | TUI environment present landed; ADR-0028 bar still only `last_tool`+todos | **Human-readable added** (deliberately not in the status bar)            |
| Persistent shell              | shared terminal session by default             | no product-grade persistent PTY seen                             | **To fill**                                                              |
| Parallel tools                | streaming launch + concurrency + fault boundaries | `isConcurrencySafe` wave scheduling; unsafe still serial         | **Kernel aligned** (#671); streaming-launch product surface still weak   |
| Clarification / design approval | first-class flow for complex tasks           | identity present; clarification turns not a first-class state machine | **Partial**                                                              |
| Skill / MCP                   | progressive disclosure + discovery             | wired                                                            | **Aligned** (remote OAuth etc. are non-goals)                            |
| Memory                        | FS-hub long-term memory                        | BM25 memory + identity                                           | **Mostly aligned**                                                       |
| Subagent / multi-agent        | spawn + isolation; split only on new information | process-level mature; `graph/` not on the product path           | **Partial**                                                              |
| Fault recovery                | four fault layers + fingerprint loop + circuit breaking | FaultClass + transport retry + tool-loop `fused` (#672)          | **Mostly aligned** (no dedicated compact/verify circuit breaker)         |
| Streaming product surface     | streaming interaction                          | kernel/TUI have it; HTTP SSE **501**                             | **To fill**                                                              |
| Evaluation / evolution        | boundary sets, trace-driven improvement        | `npm test` + JSONL; no cost/drift gates                          | **To fill**                                                              |
| Post-training / self-bootstrap | frontier capabilities                          | non-goal                                                         | **Not doing**                                                            |

---

## 5. Three structural debts

### A. Reliability debt

1. Shell safety relies on hard-wall patterns, not semantic parsing → a combinatorial-explosion bypass surface remains.
2. The fault taxonomy / fingerprint dead-loop / circuit-breaker threshold table is not systematized.

### B. Workflow debt

Ideal flow: document the project → clarify → design approval → implement → fix tests → self-review → sync docs.  
iknow has the tools and verify; the TUI environment-present view already shows cwd/git/diff to humans (not in the ADR-0028 status bar). Clarification / design approval is not yet a first-class state machine; there is no persistent shell by default. The harness does not yet push tasks into the "clear goal + auto-verifiable" quadrant.

### C. Productization debt

- Verify's **TUI human-readable view has landed** (PR #666); Trace / Web remain weak → the multi-surface perception story is incomplete.
- Web SSE 501, no authentication → the host surface is not closed.
- Graph / multi-agent orchestration code exists but is not wired → avoid premature "multi-agent platform" narrative.
- Observability stops at JSONL, lacking unified cost / drift gates; the OTel bridge stub throws.

---

## 6. Kernel-level to-do list (≤10, with paths)

1. **~~Parallel tool execution~~** — **landed** (PR #671: `concurrency-waves` + ACI `executeAll` batching + real batch in `runToolPhase`).
2. **~~Background/foreground sandbox discipline alignment~~** — **landed** (PR #671; shared fence construction seam).
3. **Wire graph onto the product path** — `src/harness/graph/` has no external imports.
4. **~~Lazy loading for built-in tools~~** — **voided** ([#635](https://github.com/winter6205/iknow/issues/635) rejected built-in lazy; progressive disclosure goes through discovered append + MCP overview, see issue #640).
5. **spawn_subagent `background:true`** — `spawn-subagent-tool.ts`.
6. **Unified context budget charging** — `docs/STATUS.md` §2.2.
7. **Observability B-scope** — `trace/observability-bridge.ts` throws.
8. **Fail-closed friction on non-interactive entry points** — mutating calls are easily denied in ask/worker mode without interaction.
9. **Upgrade shell constraints from hard walls to semantic level** — the boundary still depends on bwrap + dangerous patterns.
10. **SSE / streaming product surface** — `session-api` `/events` → 501.

---

## 7. Completion priorities

| Priority          | Action                                                                          | Reason                                    |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------------------------- |
| **P0 landed**     | parallel tool scheduling + foreground/background sandbox discipline             | PR #671                                   |
| **P0 landed**     | TUI environment-present view + human-readable verify final state                | PR #666; **does not** change the ADR-0028 status bar |
| **P0 landed**     | fault recovery: FaultClass + transport-retry decorator + tool-loop `fused` (#672; PRs #683–#685) | reliability ceiling; treat the PRs as authoritative before merge |
| **P1**            | clarification turn / design-approval minimal states (complex-task gate)         | advances tasks into the verifiable quadrant |
| **P2**            | SSE productization; unified context budget                                      | host completeness                         |
| **P2**            | semantic shell parsing (or a sidecar that re-checks dangerous commands)         | security ceiling                          |
| **P3**            | graph wiring / multi-agent negotiation                                          | do it after the single-agent loop is stable; don't split without new information |
| **Not doing**     | post-training, self-bootstrapping, full-stack computer use                      | consistent with the non-goals             |

---

## 8. Strongest / weakest

### Strongest 5

1. Loop + explicit stop semantics + append-only history
2. Breadth of the ACI tool surface (incl. LSP symbol capabilities)
3. The permissions–sandbox–secrets triangle
4. Multiple surfaces delivered from one engine
5. Compaction + identity / memory injection + status-bar skeleton

### Weakest 5

1. Real-time streaming over HTTP/Web and its productionization (SSE 501)
2. Ops observability and evaluation productization
3. Subagent orchestration productization (graph unwired; live routing still fragile)
4. Clarification turns / strict context budget / anaphora continuation not systematically evaluated
5. Semantic-level shell constraints (hard walls still in place)

---

## 9. Evidence and boundaries

### Verified

- Local: `docs/STATUS.md`, `docs/architecture.md`, `specs/README.md`, `src/harness/**`
- Cross-checked: `ACI_TOOLSET_NAMES`, the wave scheduler (`concurrency-waves.ts` / `runToolPhase`), `agent-status` carrying only last_tool + todos (ADR-0028); TUI environment-present view + VerifyBanner = PR #666

### Not verified

- No end-to-end live-task comparison against peer tools in this class was run
- macOS / Windows TUI unverified (STATUS already states this)

### Documentation risk

- `docs/STATUS.md` was synced on 2026-08-25 with the TUI-awareness and concurrency/sandbox packages; it may still lag registry details — on conflict, code + this document are authoritative.

---

## 10. Related documents

| Document                   | Relation                              |
| -------------------------- | ------------------------------------- |
| `docs/architecture.md`     | SSOT for runtime capability breakdown |
| `docs/STATUS.md`           | feature status (some fields lag)      |
| `docs/CONTEXT.md`          | domain terminology                    |
| `specs/README.md`          | active-spec index                     |

---

_This assessment is an input to capability completion and does not replace ADRs. The two recent packages added no new roadmap ADRs; STATUS §1/§3 was synced with PR #666 / #671 and this revision._
