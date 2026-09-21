# 0116. llm_call jsonl added system / tool_names; MCP reads by window

Date: 2026-09-21
Status: deprecated

This step once wrote the outgoing identity's full `system` text (as a blob reference) and the `tool_names` advertised to the model into `llm_call`, and added `detail=system` / `detail=tools` to the read side. The operator judged this off the product main path: day-to-day debugging does not rely on either item; what trace must show is **which tools LSP / MCP actually called** (call records, not a per-step tool advertisement table plus the full system prefix).

This decision is void. `llm_call` no longer stores `system` / `tool_names`. The call surface still keys off the existing `tool_call.tool_name`. The ADR-0014 D6 clause amended here has been restored by the revert (proactive keywords are no longer pinned to the captured system).
