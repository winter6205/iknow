# R1 同波消息快照能否看见刚读的文件

- Map: [ACI 文件/搜索工具面（整体升级决策）](../aci-file-tool-surface-map.md)
- Type: `wayfinder:research` (AFK)
- Status: resolved
- Blocked by: —

## Question

若把「本会话是否读过该 path」建在 `ctx.messages` 字符串扫描上：同回合 `read_file` 成功后再 `edit_file`，edit 的 handler 能否看见那次 read 的 tool_result？跨回合呢？`read_file` 成功回执里有没有 path 可反查？

只陈述本仓代码事实（file:line）。不写产品代码，不具名外部产品。

## Resolution

### 结论（按 Question 三问）

**1. 同回合 `read_file` 成功后再 `edit_file`：`edit` handler 能否在 `ctx.messages` 里看见那次 read 的 tool_result？**

**不能。** 本回合 tool 阶段入口传给 handler 的 `ctx.messages` 固定为 `afterAssistantState.messages`（`src/harness/loop-engine.ts:1734`），此时只含本回合 assistant 的 `tool_use`，**不含本回合任何 `tool_result`**（`src/harness/loop-engine.ts:1721-1722`、`1642-1645`）。整回合所有 wave 跑完后才一次性 `appendMessage` 写入 tool_result 用户消息（`src/harness/loop-engine.ts:1737-1744`）。wave 之间也不刷新快照：同一 `messages` 引用贯穿 `for (const wave of waves)`（`src/harness/loop-engine.ts:1723-1735`）；前一波 read 的 tool_result 虽经 `commitMessagesOrThrow` 落盘（`src/harness/loop-engine.ts:1661-1664`），但不回写内存里的 `afterAssistantState.messages`，故后一波 `edit_file` 的 `ctx.messages` 仍看不见前一波 read 的 tool_result。

`ctx.messages` 经 `executor.runOne` 原样透传（`src/harness/tools/executor.ts:330`、`358-370`）。`ToolExecutionContext.messages` 注释亦写明是 append-only 历史的只读快照（`src/harness/tools/types.ts:57-61`）。

**2. 跨回合呢？**

**上一回合及更早的 read tool_result 可以出现在下一回合的 `ctx.messages` 里**——前提是它们仍在 `afterAssistantState.messages` 中且未被压缩抹掉。下一回合 tool 阶段开始时，`afterAssistantState` 已含上一轮 `runToolPhase` 末尾 append 的 tool_result 消息（`src/harness/loop-engine.ts:2113-2120` → `2172-2182` → `1737-1744`）。

跨回合会被抹掉的路径：

- **窗口压缩**：`DEFAULT_KEEP_RECENT = 6`（`src/harness/compress/constant.ts:6`）；`preserveToolPairs` / `compactMessages` 丢弃前缀，以 `COMPACTION_BOUNDARY_PLACEHOLDER` 单条 user 消息替代（`src/harness/compress/window.ts:72-84`、`src/harness/compress/constant.ts:7-8`）。落在 dropped 前缀内的 read `tool_use`/`tool_result` 对从 `messages` 消失。
- **LLM 摘要压缩**：`applyCompactAttachment` 对 dropped 前缀跑 `runFullCompact`，成功时用 summary + kept tail 重建（`src/harness/loop-engine.ts:789-865`）；失败回退仍走 `compactMessages` placeholder 路径（`src/harness/loop-engine.ts:867-891`）。proactive / reactive 入口见 `src/harness/loop-engine.ts:1513-1517`、`2449-2479`。
- **`splitForCompaction` 无窗口**（`messages.length <= DEFAULT_KEEP_RECENT`）时不走窗口丢弃（`src/harness/compress/full-compact.ts:125-135`），但 token 超阈值时可走 `applyFullCompactSummary` 整段摘要（`src/harness/loop-engine.ts:918-944`、`2468-2472`）。

因此：**跨回合用 `ctx.messages` 判「读过某 path」仅在 read 记录仍留在 kept tail（及配对补全范围）内时成立；压缩后不可依赖。**

**3. `read_file` 成功回执里有没有 path 可反查？**

**成功 model-facing payload 不含 path。** handler 成功返回 `sliceLines(...)` 纯文本：行号 + tab + 行内容（`src/harness/aci/tools/read-file.ts:201`、`313-315`）；空文件为 `"[read_file] ok (empty file)"`（`src/harness/aci/tools/read-file.ts:301-302`），同样无 path。经 `safeContent` 编码为 `{ type: "text", text: ... }` tool_result block（`src/harness/tools/executor.ts:36-57`、`259-272`；`src/harness/model-adapter/anthropic-adapter.ts:343-348`）。

path 只出现在对应 assistant `tool_use` 的 `input.path`（`src/harness/aci/tools/read-file.ts:138-148`；wire 形状 `src/harness/model-adapter/types.ts:18-22`）。若要做「读过某 path」判定，须走 **`tool_use(name,input.path)` ↔ `tool_result(tool_use_id)` 配对**（现有消费例 `hasVisibleFullSkillBody`，`src/harness/aci/tools/skill.ts:101-119`），**不能**在 tool_result 正文里扫 path 字符串。

### read vs edit 是否必然分波

**同一 assistant 消息里若同时含 read 与 edit，至少两波。**

- `read_file`：`aci.isConcurrencySafe: true`（`src/harness/aci/tools/read-file.ts:151-154`）
- `edit_file`：`aci.isConcurrencySafe: false`（`src/harness/aci/tools/edit-file.ts:214-217`）
- `partitionConcurrencyWaves`：连续 safe 共波；unsafe 单独成波并打断 safe 批次（`src/harness/tools/concurrency-waves.ts:5-23`；测试 `tests/harness/tools/concurrency-waves.test.ts:21-29`）

典型顺序 `[read_file, edit_file]` → 波 1 全 read、波 2 _singleton edit（`src/harness/loop-engine.ts:1712-1735`）。顺序 `[edit_file, read_file]` → 波 1 edit、波 2 read。无论哪种，**edit 执行时 `ctx.messages` 都不含同回合已完成的 read tool_result**（见上 §1）。

### 总判

用 `ctx.messages` **字符串扫描**判「本会话是否读过该 path」：

| 场景                         | 是否成立                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| 同回合 read 后立即 edit      | **不成立** — edit handler 看不到同回合 read 的 tool_result                               |
| 跨回合 edit（read 在上回合） | **有条件成立** — 需 tool_use/tool_result 配对 + path 在 `tool_use.input`；压缩后可能失效 |
| 在 tool_result 正文反查 path | **不成立** — 成功回执无 path                                                             |

### 只读调查命令

```bash
# 读票与指定源码
sed -n '1,220p' docs/wayfinder/tickets/r1-edit-freshness-message-scan.md
sed -n '1620,1750p' src/harness/loop-engine.ts
sed -n '2095,2185p' src/harness/loop-engine.ts
sed -n '784,892p' src/harness/loop-engine.ts
sed -n '1505,1535p' src/harness/loop-engine.ts
sed -n '2435,2485p' src/harness/loop-engine.ts
cat src/harness/tools/types.ts
cat src/harness/tools/concurrency-waves.ts
sed -n '30,380p' src/harness/tools/executor.ts
cat src/harness/aci/tools/read-file.ts
sed -n '135,220p' src/harness/aci/tools/edit-file.ts
cat src/harness/compress/constant.ts
cat src/harness/compress/window.ts
sed -n '115,145p' src/harness/compress/full-compact.ts
sed -n '95,145p' src/harness/aci/tools/skill.ts
sed -n '15,35p' src/harness/model-adapter/types.ts
sed -n '331,350p' src/harness/model-adapter/anthropic-adapter.ts
sed -n '140,220p' src/harness/aci/aci-executor.ts
cat tests/harness/tools/concurrency-waves.test.ts
sed -n '3385,3402p' tests/harness/loop-engine.test.ts

# 符号检索
rg -n 'executeWaveAndCommit|partitionConcurrencyWaves|ctx\.messages|applyCompactAttachment|DEFAULT_KEEP_RECENT' src/harness docs/wayfinder
rg -n 'hasVisibleFullSkillBody|isConcurrencySafe' src/harness tests
```
