# 0046. Load by exact name when a description exists; search only when one is missing; index demotion never removes names

Date: 2026-09-06
Status: accepted

## Context

MCP short descriptions were once in system, trimmed to bare names by ADR-0043 B4; `skill_search` plus "unloaded must go through tool_search" welded retrieval to loading. This ADR revises the "tool_search is mandatory" reading of ADR-0043 §2/§5/§7 without overturning schema-not-upfront, start-of-session waiting, or the prefix freeze.

## Decision

1. **Load vs search:** description already in the prefix → load the full payload by exact name (`skill({name})`; for tools/MCP not yet discovered, call `discover` directly, and execute once parameters are complete). No description in the prefix → only then use `tool_search` to fetch description+schema. Delete `skill_search`.
2. **Over-limit ladder:** built-in schemas over 10% of the window → evicted items keep indexing as name+description; descriptions are not stripped. MCP/skill index over 10% → strip descriptions only from those two entry kinds; names stay. Evicted built-ins never participate in description stripping. Names are never removed from the catalog.
3. **Out-of-catalog skill:** not reached via any retrieval artifact; once the conversation points at a path, `read_file` it.

## Why not

- **Strip over-limit tools to names only:** would force description-bearing evicted items into search, conflicting with "search only fills missing descriptions".
- **Keep `skill_search`:** substring search over lists that are already resident or only missing their body is weaker than model attention and costs an extra hop.
- **Uniformly error-route unloaded to `tool_search`:** conflicts with direct-by-exact-name whenever a description exists.

## Consequences

- **Positive / Applied:** short descriptions and ADR-0043's prefix freeze can coexist; `tool_search`'s post narrows to the no-description case.
- **Negative / Trade-offs:** name-only MCP entries can still miss on keywords; this ADR does not upgrade the retrieval algorithm.
