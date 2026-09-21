# 0016. ACI deny-list 裁剪必须在 def-list 期（createAciRegistry 之前），不给 AciRegistry 加 .tools 字段

Date: 2026-08-16
Status: accepted

Context: 子代理判官面裁剪要求 worker 消费 `SubAgentDefinition.disallowedTools`，把判官（及任何声明 deny-list 的子代理）的实际工具面裁成声明面。`AciRegistry` 只暴露 `inner` / `catalog` / `visibleSchemas`（aci-registry.ts:18-35），`inner` 是构造期冻结快照，构造后裁剪不可行。

Decision: 裁剪发生在 `createDefaultAciRegistry` 工厂内的 def-list 期——`createAciRegistry(tools)` 调用**之前**用既有 `buildWorkerToolSurface`（宽容模式）过滤 def-list，Gate 3 的 `toolsetNames` 同步镜像剔除禁项再对照 factories 键集；`inner`（执行面）与 `visibleSchemas`（可见面）由构造期快照天然同步，声明面 = 实际面由构造保证。不给 `AciRegistry` 加 `.tools` 字段。

Why not .tools: 加字段会诱导「产物上事后裁剪」反模式，破坏冻结快照不变量，且诱使实现者重建 executor/Gate 3 逻辑（god-function）。正确解法是挪裁剪时机到构造之前，现有结构够用——这是本需求 spec ACR Round 1 BLOCKED 的整改结论（Round 2 PASS 5/5）。
