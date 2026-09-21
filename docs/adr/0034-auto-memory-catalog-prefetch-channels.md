# 0034. Auto-memory read path — catalog in system, prefetch on the user turn, low-trust labels

Date: 2026-08-28
Status: accepted

> **Amendment 2026-09-04**：existence pointer 只声明库在，**不得**下令 `Use memory_recall`。catalog 纪律句须写明目录是索引不是待办、标题与用户句撞词不构成必须召回。prefetch 通道不变。`memory_recall` 默认命中条数改为 3；工具说明不得写 “at the start of a task”。D1–D3 通道形状（目录进 system、正文不进 system、预取进用户消息、召回返回原文）当时不变。
> **Amendment 2026-09-05**（ADR-0044）：D4 废止。合格 promote 正文不再进入 `system`。D1 catalog 通道本票不动。

## Context

ADR-0009 D3 put un-promoted auto memory on `memory_recall` / `tool_result` only, with a one-line existence pointer in `system`. After extract (ADR-0031) the store can fill while the model still never sees a directory, so it rarely calls recall. Putting changing per-turn bodies in `system` would break the KV-cache prefix (ADR-0009 D6). Treating extracted notes as instructions would let stale text steer the agent.

## Decision

1. **Catalog in `system`, bodies not.** When `autoExtract === true` and at least one live entry exists, `memory_layer` may append a capped catalog of live titles/hooks plus a fixed English disclaimer. Un-promoted entry **bodies** still must not enter `system`. This amends ADR-0009 D3's "existence pointer, nothing more" only for that catalog + disclaimer.

2. **Prefetch rides the user turn.** Each turn may attach at most five scored live bodies to the **user** payload (not `deps.system`). Scoring is `scoreMemoryEntries`; zero lexical hits are ineligible. The block is labeled advisory and time-sensitive.

3. **Recall still returns full hits.** Default **three** hits (was ten; amended 2026-09-04) remain title + frontmatter + body, not catalog lines. Same advisory label. Auto-memory must not auto-promote and must not outrank the user turn, the repository, or project instructions. The existence pointer must not command the model to call `memory_recall`.

4. **Promote assembly shares the catalog gate.** ~~Eligible promoted bodies may enter `system` only when `autoExtract === true` (same as catalog).~~ **Superseded by ADR-0044:** promoted bodies never enter `system`. `AGENTS.md` / existence pointer / `memory_recall` / `memory_save` do not follow the catalog gate. `MEMORY.md` is never injected. Amendment 2026-08-29.

## Consequences

- (+) The model can see that a library exists without reloading bodies every turn; prefetch can change without busting the system prefix.
- (−) A stale catalog line can still hint the model to recall a bad note. Accepted: channel and English disclaimer keep it non-authoritative. Body-in-system via promote is withdrawn (ADR-0044).

## Why not

- **Prefetch or un-promoted bodies in `system`:** breaks prefix cache and raises trust.
- **Catalog-only recall (ten index lines, no bodies):** forces a second fetch for every useful hit.
- **Default ON / auto-promote:** would let unverified extract dominate the agent.

## Evidence pointers

- ADR-0009 D3 / D6; ADR-0031 D3 / D5
