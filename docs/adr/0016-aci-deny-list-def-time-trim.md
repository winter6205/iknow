# 0016. ACI deny-list trimming must happen at def-list time (before createAciRegistry), no `.tools` field on AciRegistry

Date: 2026-08-16
Status: accepted

Context: Trimming the sub-agent judge surface requires the worker to consume `SubAgentDefinition.disallowedTools`, cutting the judge's (and any sub-agent declaring a deny-list) actual tool surface down to its declared surface. `AciRegistry` only exposes `inner` / `catalog` / `visibleSchemas` (aci-registry.ts:18-35); `inner` is a snapshot frozen at construction time, so trimming after construction is infeasible.

Decision: Trimming happens at def-list time inside the `createDefaultAciRegistry` factory — before the `createAciRegistry(tools)` call, filter the def-list with the existing `buildWorkerToolSurface` (permissive mode); Gate 3's `toolsetNames` mirrors the removals in sync before comparing against the factories key set; `inner` (execution surface) and `visibleSchemas` (visibility surface) are naturally kept in sync by the construction-time snapshot, so declared surface = actual surface is guaranteed by construction. No `.tools` field is added to `AciRegistry`.

Why not .tools: adding the field would invite the "trim the artifact after the fact" anti-pattern, break the frozen-snapshot invariant, and tempt implementers to re-derive executor/Gate 3 logic (god-function). The right fix is to move the trimming point to before construction — the existing structure suffices. This is the remediation conclusion from the requirement spec's ACR Round 1 BLOCKED (Round 2 PASS 5/5).
