# 0043. Tool-surface disclosure tiering: built-ins resident + MCP cataloged + overflow governance and startup wait

Date: 2026-09-04
Status: accepted

> **Amendment 2026-09-06** (ADR-0046): in §2 "full definitions via tool_search" and "call without loading → error telling the model to tool_search first", in §5 "want it → go through tool_search", and in §7 "the information is carried by the name catalog + tool_search result messages" — every reading that makes **tool_search mandatory** is **superseded**. The name catalog defaults to name + short description; if a description is present, invoke `discover` directly; `tool_search` applies only when the prefix carries no description. No upfront schema, startup wait, prefix freeze, §3's schema eviction order, and the 10% gate all remain in force.

## Context

Joint ruling on ticket G1 (prefix stability boundary) of the wayfinder map "model-facing prefix layering and cache realization", merged with the MCP disclosure question. Prefix order is `tools → system → messages`, and the target endpoint rides on passive prefix caching: any byte change in the prefix invalidates everything after it. Three current violations: `<mcp_tools_overview>` re-reads connection state every turn (changes as soon as a server connects); MCP tools dump their full schemas into `tools` on connect (1–2 wobbles early in each session); connection events are never announced model-side. The existing lazy / `tool_search` machinery (progressive disclosure, appended at the tail of registration order) was built but never used (zero hits for `lazy: true`).

## Decision

**Split disclosure shape by tool category; the prefix region admits only content that is "constructionally constant within a session"; enforce with two assertions.**

1. **Built-in tools**: core pieces keep full schemas resident (`bash` / `read_file` / `edit_file` / `write_file` / `grep` / `glob` / `spawn_subagent` are never deferred); large low-frequency pieces are subject to overflow governance (see 3).
2. **MCP tools**: schemas **never enter the prefix region upfront** — a name catalog goes into system (finalized on the first turn, constant for the session); full definitions load on demand via `tool_search`; discovery = appended result message + schema appended at the tail of `tools` (client double-write; one transient wobble per tool, then permanent). Calling a tool without loading it → error telling the model to `tool_search` first. The lazy tail-append discipline (never re-insert into registration order) is promoted to an all-tools general rule.
3. **Overflow governance**: when the total schema size of deferrable tools (the MCP roster plus flagged built-in low-frequency pieces) — **measured via countTokens; chars/4 estimation is forbidden from the decision** — exceeds **10% of the endpoint model's context window** (window value read from adapter config, never hardcoded), the excess retreats to the name catalog. **Judged exactly once at first-turn assembly**, never recomputed within a session. Eviction order (by size × low frequency, largest first): the three trace read-side tools (`query_trace` / `list_sessions` / `get_record`) → `web_search` / `web_fetch` → remaining low-frequency query tools sorted by measured size. Core pieces are never evicted.
4. **Startup wait**: before the first request, wait for MCP connections to settle (30 s timeout; timed-out servers stop auto-retrying and are absent for this session); servers that connect inside the window join the first assembly with zero disruption — the prefix is final before the first request is sent.
5. **Manual reconnect**: when the user manually reconnects a timed-out server successfully, **append exactly one notification to the tail of messages** (that server's tool names) and never rewrite history; when the model wants one, it goes through `tool_search`.
6. **Disconnect**: if a server drops mid-session, its tool calls error out; `tools` and history are untouched.
7. **System cleanup**: `<mcp_tools_overview>` is removed from system (its information is carried by the name catalog + `tool_search` result messages).
8. **Enforcement assertions**: (a) every section declared in `IKNOW_ASSEMBLY_ORDER` must appear in the assembly output, or be explicitly declared conditional with its absence condition stated (closing the "declaration separated from implementation" gap that T0 exposed); (b) in harness tests, adjacent turns' assembled tools + system must deep-equal (D7 established the tools side; this adds the system side and the full assembly).

## Why not

- **Inject full MCP schemas on connect**: guarantees 1–2 wobbles early in every session whether or not the tools are used, and exposes the size problem to every request.
- **Default lazy for everything (no threshold)**: in the client form, every tool actually used triggers one unpredictable-timing wobble — worthwhile only when the size is over budget, which is why overflow governance arms only after the first-turn budget check.
- **Auto-reconnect mid-session injecting into tools**: breaks the "zero prefix change within a session" promise for a low-probability recovery event; keeping the discipline gapless — manual reconnect handled by message append alone — already covers recovery.
- **Snapshot `<mcp_tools_overview>` and keep it in system**: its content goes stale with connection state; a model calling an unconnected server's tool off a stale overview gets `tool_not_found` — worse than absence (compare D1: the git block's disclaimer can rescue stale prose, but cannot rescue a hard call failure).

## Consequences

- **Positive / Applied:** the prefix region (resident `tools` + system) has zero change in a normal session; connect/disconnect/reconnect events all land on the message side or the handler layer. The R4 wobble table's two rows — "tools tail-append (MCP connects)" and "any system section changes (MCP overview)" — are eliminated; full-messages cache invalidations per session drop from 3–5 to 0 (normal path). Overflow governance acts as a size fuse that adapts to the endpoint.
- **Negative / Trade-offs:** each actually-used MCP tool costs one extra `tool_search` hop (one-time, ~200 tok scale); the name catalog must stay informative enough for the model to decide correctly what to look up; overflow governance depends on countTokens measurement (estimation in the decision is forbidden).

## Evidence pointers

- R2/R3 measurement (asset: `scripts/wayfinder-measure-prefix.ts`): 42 tools ≈ 10.4K tok (chars/4 estimate; real value pending countTokens).
- R5: the MCP connection wobble path and the lazy machinery's status (`lazy: true` zero hits); tail-append discipline comment (`src/harness/aci/aci-registry.ts:143`).
- R4 wobble table: the event composition behind 3–5 full-messages invalidations per session.
- D7: session-variable gates may land only at the messages tail or the handler layer.
- D8 (ADR-0042): the memory_layer catalog session-level snapshot precedent.
