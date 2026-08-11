# Spec: checkpoint-rewind — 检查点回退（T1 数据层 → T6 TUI 接线）

> 来源：rewind baseline 实机调研（`~/.claude/jobs/a2ba85ca/tmp/rewind-baseline.md`，2026-08-11 证据链）+ T1 检查点数据层（`src/session-api/store/checkpoint.ts`，已实现 + 已测）。
> 范围 = 回退粒度档位表 + turnCount 降级决策 + fallback 策略 + T6 TUI 接线草图。**本 spec 不含实施代码**；T6 只接线，不新增 T1 数据原语，不修改生产文件。
> 对标 = Claude Code rewind 行为（rewind-baseline §0-§8）；凡是 iknow 选择分歧处，在档位表「有意分歧」列显式声明。
> 下游 = `writing-plans` → `plans/checkpoint-rewind.md`；上游 = rewind baseline（T5 ACR 输入）。

## Objective

给 iknow 的会话文件（SessionFileV1 v3，`src/session-api/store/schema.ts:43`）提供 **checkpoint 回退**能力：把会话截断到更早的 turn 边界，并让 TUI 用户经 `/rewind`（及双 Esc）触发。核心价值 = 恢复被错误 / 半途 / 污染 turn 的会话，且回退后的文件仍满足 #120 Q6 唯一验收标准（任何入口读取一致）——因为回退是**磁盘真截断**（`rewindFile` 纯函数 + store.save），不是 Claude Code 的内存 fork-and-replace。

成功 = T6 接线落地后，TUI 中 `/rewind` 打开锚点选择器、选中即截断落盘、UI 状态反射回退后的 messages / turnCount / checkpoints，且 `rewindFile` 既有 7 条单测（`tests/session-api/store/checkpoint.test.ts:396`）零改动。

## Background

- **回退基线**：Claude Code 的 rewind 行为真值见 `rewind-baseline.md §0-§8`。关键事实：
  - 锚点 = 用户消息（turn）边界，最小回退步 = 一个用户消息边界，tool 调用与结果随所属 assistant 回合一起回退（§4，issue #61965）。
  - 双 Esc 与 `/rewind` 打开**同一个 picker**，无独立"快速档"（§1）；idle 前置条件，双击窗口 `foE = 1000ms`（§1，实机证据）。
  - 无 checkpoint 时硬空态 `"Nothing to rewind to yet."`；**没有消息级删除**（§2/§6）。
  - 回退是内存 fork-and-replace、JSONL 保留全历史 → `/tui` 切换重水合可丢回退态（§5，issue #74169）；破坏性默认 UX 在被投诉（§2，issue #64615）。
- **T1 数据原语**（`src/session-api/store/checkpoint.ts`，本 spec 只消费不修改）：
  - `splitTurns(messages)`（:60）—— 每个非 tool_result 用户消息开一个 turn 切片（镜像 hub.ts:187 `projectMessagesToTurns`）。
  - `turnSliceEnd(messages, turnIndex)`（:40）—— turn N 的排他结束索引，越界钳制。
  - `rewindFile(session, keepTurns)`（:167）—— 纯截断：截到 turn 起点（tool 配对不拆）、**重算 turnCount = keepTurns**（:188）、重算 summary（:189）、剪枝 checkpoints（`turnIndex >= keepTurns`，:182-184）。keepTurns 钳制 [0, available]（:173），越界 no-op（:174-179）。
  - 持久化侧（chat T2/T3 已用）：`shouldPersistCheckpoint`（:93）/ `appendCheckpoint`（:140，delta=0 守门）/ `toInterruptReason`（:115）。`InterruptReason` 五值见 `schema.ts:26`（cancelled / maxTurns / protocolError / process / timeout），本 spec 不扩宽。

## Granularity 档位表

| 档位                                    | 触发                                                   | 粒度                                                                                                                                                                                                                                                                                    | 机制（rewindFile 调用链）                                                                                | 持久化副作用                                                                                | 对标 Claude Code                                                                                                                                                                               | 有意分歧                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L3 锚点选择器**（T6 交付）            | `/rewind` 或 idle 下双 Esc（同一路径）                 | 任选历史用户消息锚点（turn 级）；合法 keepTurns ∈ [1, turnCount−1]，首条目 keepTurns=0「首条用户消息之前」对任何有 turn 会话列出（rewindFile 真实截空 msgs=[]/turnCount=0；仅 available=0 无 user 消息走 L0 空态）。锚点行主 label = 锚点用户消息真实文本（对标 Claude Code picker §2） | `bridge.rewindSession(id, keepTurns)` = load → `rewindFile(file, keepTurns)` → store.save → 返回更新文件 | truncate 落盘；turnCount=keepTurns；summary 重算；checkpoints 剪枝（turnIndex ≥ keepTurns） | 锚点 = 用户消息 turn 级（§4）；双 Esc 与 /rewind 同 picker（§1）；空态文案对标（§2 `"Nothing to rewind to yet."`）；深度上限 = 盘上已有 turn 数（Claude Code 受 compaction 约束，§6 / #24471） | **A. 磁盘真截断 vs 内存 fork-and-replace**（§5 #74169 的对立面，见 OQ4）。**B. 确认 gate**：Claude Code 无二次确认且破坏性默认（§2 / #64615），iknow 增加 Enter 后显式确认（见 OQ1）。**C. 回退后输入框**：见 Divergence 记录 |
| **L2 快速单步**（保留档位，T6 不做）    | 待定（候选：独立快捷键）                               | 恰好 1 turn（keepTurns = turnCount − 1）                                                                                                                                                                                                                                                | 同 L3 的 rewindFile 调用链，参数固定为 turnCount−1                                                       | 同 L3                                                                                       | Claude Code 无此档：双 Esc 是 picker 快捷键（§1）                                                                                                                                              | **有意分歧**（Claude Code 不做快速档）。T6 双 Esc 绑 L3（对标 §1 同一路径），L2 不占用双 Esc；是否引入留待用户诉求（OQ2）                                                                                                     |
| **L1 消息级回退**（不采用，文档性档位） | 无产品触发（L3/L2 兜底失败候选）                       | 当前 turn 的最后一条用户消息（单消息删除）                                                                                                                                                                                                                                              | 无（checkpoint.ts 无消息删除原语；rewindFile 只能按 turn 截）                                            | 若实现需新增 T1 纯函数（spec 不定义，T6 不做）                                              | Claude Code 无消息级删除，最小粒度 = 用户消息边界（§6）                                                                                                                                        | **有意分歧候选（invention）**：baseline §8 明示"no checkpoint → delete last message"是发明而非 parity。本 spec 不采用，fallback 走 L0（见 Fallback 章节）                                                                     |
| **L0 空态**（fallback 落点）            | 空会话 / 无完成 turn / keepTurns 越界 / 目标=当前 turn | 无（不触盘）                                                                                                                                                                                                                                                                            | 无 rewindFile 调用；UI 空态 notice                                                                       | 无                                                                                          | "Nothing to rewind to yet."（§2/§6）                                                                                                                                                           | 无                                                                                                                                                                                                                            |

档位间关系：L3 是 T6 唯一交付档；L0 是 L3 所有失败路径的统一落点；L2 / L1 是显式声明的**未采用 / 待定档**，写入档位表是为了让后续读者知道"为什么双 Esc 不是快速单步、为什么没有消息级删除"——对照 baseline §8 的排他清单。

## turnCount 降级决策

**采用 Option A：`rewindFile` 重算 turnCount = keepTurns，后续 checkpoint 从新的低基准续号。**

理由（1 段）：`rewindFile` 已把 turnCount 与 messages / summary / checkpoints **一并**重算为保留 turn 数（checkpoint.ts:188）——这是 T1 截断语义的组成部分，不是额外改动；截断后盘上真实 turn 数就是 keepTurns，turnCount 变小是 rewind 的**语义结果**而非数据丢失。后续 checkpoint 的编号读的是**盘上最新文件**的 turnCount：chat 的 `persistChatSessionCheckpoint`（chat-session.ts:472 `session.turnCount + result.turnCount`）与 hub.ts:761 同款累计，回退 save 后下一轮自动从新低基准起号，单调正确、无全局计数器膨胀。Option B（全局单调不减）在单文件 truncate 模型下反而有害：checkpoint 剪枝已按 turnIndex 对齐新历史（checkpoint.ts:182-184），保留旧计数会让 checkpoints 的 turnIndex 引用已不存在的 turn 区间（与 messages 脱节），且长 rewind 历史上计数器无界增长；B 的唯一收益（跨回退周期全局唯一索引）依赖"回退后保留分支历史"的模型——那是 Claude Code 的 JSONL 全保留模型（§5），iknow 已在 L3 分歧 A 选 truncate，故 B 的前提不成立。

## Fallback 策略

**采用 Policy (a)：Claude Code parity —— 空态落点，不做消息级删除。**

具体规则：

1. **无 checkpoint / 空会话（available=0，无任何 user 消息）**（draft、首 turn 未完成）→ L0 空态：notice `"Nothing to rewind to yet."`（对标 Claude Code §2）。原因：available=0 时没有可回退的历史，keepTurns=0 与当前状态重合（`rewindFile` 走 no-op 分支，checkpoint.ts:174）——picker 数据模型空数组，零 store IO。**available ≥ 1 时 keepTurns=0 是真实回退**（`rewindFile` 截空 msgs=[]/turnCount=0，checkpoint.ts:180），作为首条目列出，不因 available 小而被吞。
2. **keepTurns 越界**（keepTurns ≥ available 或 < 0）→ `rewindFile` 自身钳制保证不越界（checkpoint.ts:171-173）：`keepTurns ≥ available` → 等价 no-op（:174-179），UI 显示「已是当前状态」；`< 0` → 钳为 0（= 回到首条用户消息之前）。T6 picker 数据模型只产出合法 keepTurns，越界在入口层即不可达；防御性路径走 no-op 提示，不抛错。
3. **目标 = 当前 turn**（keepTurns === turnCount，即"回退到此刻所在位置"）→ `rewindFile` no-op 返回等价会话（:174-179）。T6 picker **不列出当前 turn 锚点**（当前 turn 没有其之下的历史可回退），自然不可达；若因 stale state 触发，UI 提示「已是当前状态，无需回退」。
4. **回退到起点**（keepTurns === 0，即「首条用户消息之前」）→ 合法（checkpoint.ts:180 截空 + 剪枝全部 checkpoints）。Claude Code 的"回退到首个用户消息之前"是 degraded harness（§5 / #85455：SessionStart hook 重放 stale、skills 列表丢失）；iknow 是干净截空，但破坏面最大 → picker 中作为独立首条目（label = 首条用户消息真实文本 + 锚点时间戳），需显式确认 gate（对标 L3 分歧 B）。对任何有 turn 的会话列出（available ≥ 1，见规则 1）。

选 (a) 的理由：`rewindFile` 的契约是"turn 起点截断、tool 配对不拆"（checkpoint.ts:167 头注），消息级删除没有对应 T1 原语——实现 = 新发明 + 新原语，违反 minimal-change 与"spec 只消费 T1"的范围约束；删除单个用户消息会让其 assistant 回合与 tool 配对悬空，违反 append-only 与 turn 边界纪律（#120 Boundaries「sanitize 永不修复 messages」的同类精神）；对标 §6 明示 Claude Code 不做消息级删除，且本轮没有用户证据支撑这一发明（baseline §8 未收到此类诉求）。空态 fallback 零 IO、零新原语、零破坏面，与 L0 档位天然重合。

## T6 接线草图

> 全部为**待实施接线点**（本 spec 不动这些文件）。契约锚点以 `file:line` 标注。

### `src/tui/slash.ts` — 词表四触点

- `TuiSlashCommand` 并集加 `"rewind"`（slash.ts:20）。
- `VOCABULARY` 加 `"rewind"`（slash.ts:36）。
- `helpLines()` 加一行（slash.ts:61）：`/rewind   回退到更早的回合（选择锚点后确认）`。
- `HINT_DESCRIPTIONS` 加 `rewind: "回退到更早的回合"`（slash.ts:78）；`SLASH_HINT_DESCRIPTIONS`（slash.ts:154）由同一对象自动覆盖，输入候选行无需额外接线。

### `src/tui/session-state.ts` — 新增 reducer

```ts
/** 回退落盘后的会话刷新：镜像 sessionCompacted（session-state.ts:165）。
 *  仅 idle 可回退（running 时命令侧护栏拒绝，同 /compact）；整体冻结替换
 *  messages/turnCount/updatedAt/jsonMode；保留 lastStopReason/lastUsage
 *  （回退不是 turn，不清上下文用量读数）；runState 归 idle。 */
export function sessionRewound(
  session: TuiSessionState,
  input: {
    readonly messages: ReadonlyArray<AnthropicNativeMessage>;
    readonly turnCount: number;
    readonly updatedAt: string;
    readonly jsonMode: boolean;
  }
): TuiSessionState;
```

### `src/tui/hub-bridge.ts` — 桥接 helper

- `TuiBridge` 接口（hub-bridge.ts:71）加：

```ts
/** 回退到更早 turn：load → rewindFile → store.save → 返回更新文件。
 *  错误复用 SessionStore 既有 typed kinds，不新造。 */
rewindSession(conversationId: string, keepTurns: number): Promise<SessionFileV1>;
```

- 实现（紧邻 `compactSession`，hub-bridge.ts:148）：`store.load` → `rewindFile(file, keepTurns)` → `store.save({ id, file })` → 返回更新文件。与 `compactSession`（hub.ts:641）同纪律：load 与 save 走同一 serialize 队列（防 `concurrent_write`；TUI 分时切换下冲突面小，#146 决策 4 不变）。`rewindFile` 从 `../session-api/store/index.js` 导入（已导出，见 checkpoint.test.ts:31-37）。

### `src/tui/app.tsx` — slash case + 双 Esc

- `handleSubmit` 的 slash switch（app.tsx:720-809）加 `case "rewind"`，镜像 `compact` case（app.tsx:745-782）：idle 护栏 → `active.conversationId` 存在性检查（draft → notice「当前是空会话」）→ 打开 picker（或直接锚点选择后 `await props.bridge.rewindSession(targetId, keepTurns)`）→ `loadSessionFile` → `setSessions` 走 `sessionRewound` → notice。所有失败经 `describeError`（app.tsx:1070，只透 typed kind）。
- **双 Esc 键处理器**（`useKeyboard`，app.tsx:813）：`e.name === "escape"` 且 `view === "chat"` 时：
  - `canInterrupt(active)`（running-fg）→ 第一下 Esc 打断 in-flight turn（对标 §1：先打断，第二下 idle 才开 picker），等效现有 Ctrl+C 分支（app.tsx:834-846）；
  - idle → useRef 记 `lastEscAt`；`now - lastEscAt <= 1000` 视为双击 → 打开 L3 picker（对标 §1 `foE = 1000` debounce 窗口）；首次 Esc 只记时间戳不动作。
  - `view === "list"` 时 Esc 保持现有「返回聊天」（list-view.tsx:132），不进 debounce；ask modal 活跃时 Esc 先走现有 dismiss（app.tsx:867 `case "dismiss"`），不触发 rewind。
- **Picker UI（L3，数据模型）**：复用 ModalHost 模式（modal.tsx）。锚点数据源 = `splitTurns(file.messages)` 投影 + 与 `file.checkpoints` 按 turnIndex 合取 `interruptedAt`：

```ts
interface RewindTarget {
  readonly keepTurns: number; // 传给 rewindFile 的落点
  readonly userMessageText: string; // 锚点用户消息首个 text block（strip[:80]，同 extractSummary 语义，展示用）
  readonly fullText: string; // 锚点用户消息首个 text block 的完整文本（不截断；回退后填回输入框用）
  readonly anchorTurnIndex: number; // 0-based turn 索引（展示用）
  readonly anchoredAt: string; // ISO：checkpoint 命中 → interruptedAt；否则 ""（无快照的锚点仅 conversation 回退）
}
```

合法 keepTurns = 锚点 0-based turn 索引 ∈ [1, turnCount−1]，+ 独立首条目 keepTurns=0「首条用户消息之前」（对任何有 turn 会话列出，rewindFile 真实截空）；available=0（无 user 消息）→ L0 空态。交互：↑/↓ 选择（每行主 label = 锚点用户消息真实文本 + 时间戳，对标 Claude Code picker §2）、Enter 进入确认行（确认 gate，对标 §2 "Confirm you want to restore…"，iknow 显式确认，文案 = "恢复到 ［锚点消息］ 之前…"）、Esc 取消。

### 测试（T6 实施时，镜像 checkpoint.test.ts 七条用例）

- `tests/tui/`：slash 解析（`/rewind` 命中 command；未知 `/rewindx` 仍 unknown）；`sessionRewound` reducer（idle 守卫 / 字段整体替换 / lastUsage 保留 / 非 idle 保持原状态）；`bridge.rewindSession` 集成（tmpdir 池：load → rewind → save → 重 load 断言 messages 截断到 turn 起点、tool 配对完整、turnCount === keepTurns、summary 重算、checkpoints 剪枝）；双 Esc debounce（纯函数化 timer，1000ms 边界：999ms 命中 / 1001ms 不命中）。

## Open Questions

1. **确认 gate 形态**：Claude Code 无二次确认、picker 即确认面、破坏性默认（§2 / #64615 被投诉）。iknow L3 分歧 B 加 Enter 后显式确认——gate 具体是一档 Enter 执行 + Esc 取消，还是两档"选中 → 确认文案 → 执行"？留 T6 实施裁决。
2. **L2 快速单步是否引入 / 何时引入**：Claude Code 双 Esc 与 /rewind 同一 picker（§1），iknow T6 双 Esc 绑 L3 保持 parity。L2（免 picker 退一步）是显式分歧候选，独立快捷键从哪来、是否占用双 Esc，留待用户诉求。
3. **代码恢复轴（code-restore axis）**：Claude Code 的 code 轴基于 per-message file-history 快照（§5），可选"Restore code and conversation / Restore conversation / Restore code"。iknow T6 只有 conversation 轴（truncate 不碰文件系统）；iknow 有 sandbox（bwrap）但无 file-history 快照原语。是否新增 code 轴（对标 `--rewind-files <user-message-id>`，§3）需另立票——本 spec 明确 T6 **不做**。
4. **`/tui` 重水合安全性**：Claude Code 的 rewind 是内存 fork-and-replace、JSONL 全保留，/tui 切换重水合会丢回退态（§5 / #74169）。iknow 磁盘真截断**天然免疫**——重水合读到的是截断后的文件。但需在 T6 验收中显式覆盖"rewind 后 reload / 切走再切回"路径防回归（冲突记录：这是 iknow 与 Claude Code 的**持久化模型分歧**，选择 truncate 即选择免疫，不静默改写 Claude Code 的 fork-and-replace）。
5. **回退历史保留 / 撤销回退**：Claude Code 回退后保留 isSidechain 分支（§5 / #24471），且锚点 survive `/clear`（§2 / 2.1.191）；iknow 的 truncate + checkpoint 剪枝是**硬删除**，keepTurns 之后的记录不可恢复。误回退时是否需要"撤销回退"（rewind-undo）？`/compact` 与 rewind 的互操作（compact 裁剪早期消息后，回退到更早锚点语义如何）？留评估。

## Acceptance Criteria（T6 必须满足才算 PASS）

1. `/rewind` 进入 TUI 词表（slash.ts 四触点同步：union / VOCABULARY / helpLines / HINT_DESCRIPTIONS）；`/help` 与输入候选行可见。
2. idle 会话中 `/rewind` 打开 L3 锚点选择器；有 turn 的会话（available ≥ 1）列出 keepTurns=0「首条用户消息之前」首条目；空会话（available=0，无 user 消息）显示 L0 空态 notice，零 store IO。
3. 选择锚点 + 确认后：盘上文件 messages 截断到 turn 起点（tool 配对完整）、`turnCount === keepTurns`、summary 重算、checkpoints 剪枝（`turnIndex >= keepTurns` 全清）——逐项与 `tests/session-api/store/checkpoint.test.ts` 断言一致。
4. `bridge.rewindSession` 复用 SessionStore 既有 typed kinds（errors.ts 六种），**不新造 kind**；load 与 save 同一 serialize 队列。
5. 双 Esc（idle、间隔 ≤ 1000ms）打开同一 L3 picker；第一下 Esc 打断 running-fg；list 视图 Esc「返回聊天」行为不变。
6. 回退后 UI state 与盘上文件一致（`sessionRewound` 整体替换 messages / turnCount / updatedAt / jsonMode）；下一轮 turn 的 checkpoint 从新 keepTurns 基准续号（累计 turnCount 契约，hub.ts:761 / chat-session.ts:472）。
7. `npm test` 全绿（含 checkpoint.test.ts 既有 7 条 rewindFile 用例零改动）；`npm run typecheck` 零错误。
8. 回退不触发任何 harness run（无模型调用）；本期 conversation-only，无 code 轴（对标差异显式：Claude Code 有 code 轴，§5——差异记录在 OQ3，不静默实现）。

## ACR 5-verdict（Step 4 · architecture-change-reviewer · 2026-08-11 · OVERALL PASS）

- bounded-context-guardian: **yes** — 改动边界清晰：T6 触点限于 `src/tui/` 四个文件（slash.ts / session-state.ts / hub-bridge.ts / app.tsx），`src/session-api/` 只读消费（checkpoint.ts / schema.ts / errors.ts 零修改）；hub-bridge 是 TUI 到 SessionStore 的唯一桥（与 compact 同层），无 harness 反向依赖、无循环导入；data 层（T1）与 UI 层（T6）职责分离，不新建模块。
- defensive-contract-validator: **yes** — 档位表 + fallback 规则覆盖五类边界：无 checkpoint（L0 空态）/ keepTurns 越界（rewindFile 钳制 + picker 数据模型限定合法区间）/ 目标=当前 turn（no-op）/ 空会话 / 回退到起点（keepTurns=0 独立条目 + 确认 gate）；AC 3 要求 T6 镜像 checkpoint.test.ts 既有 7 条 rewindFile 用例；并发类显式走既有 serialize 队列（#146 决策 4 不变，不引入文件锁）。
- error-handling-enforcer: **yes** — 复用 SessionStore 既有 6 种 typed kinds（errors.ts），明示不新造 kind；`rewindFile` 钳制保证越界不抛、失败路径走空态 notice 零静默；`describeError` 只透 typed kind；harness run 不触发（conversation-only）。
- complexity-anti-drift: **yes** — `sessionRewound` 是 `sessionCompacted` 的镜像 reducer（同形状同守卫）；`rewindSession` helper 为 load → rewindFile → save 三步直链；无超阈值（≤30 行 / ≤4 参数 / ≤4 层嵌套）迹象；无新原语、无第二份保存路径。
- minimal-change-verifier: **yes** — 单一逻辑任务（T6 TUI 回退接线）；out-of-scope（L1 消息级删除 / code 轴 / 撤销回退 / 快速单步 L2）显式排除在档位表「有意分歧」与 OQ1-OQ5；生产文件零修改，唯一交付物为本 spec；下游以 writing-plans → plans/checkpoint-rewind.md 排序。

ACR notes（非阻塞，已折进本 spec 相应章节）：① 消息级删除（L1）因缺 T1 原语而排除，不是被遗忘——见档位表 L1 行 + Fallback 理由；② 双 Esc debounce 窗口对齐 baseline §1 `foE = 1000`，已入 AC 5；③ T6 测试面（slash / reducer / bridge 集成 / debounce 纯函数化）已入 T6 接线草图 Testing 段。

## Divergence 记录（有意分歧，防静默漂移）

- **回退后输入框**：iknow 回退确认后把锚点用户消息**全文**填回输入框（`RewindTarget.fullText`，不截断），用户可直接修改并重发；Claude Code baseline §2 是回退后清空输入框。属有意分歧——用户实测要求"回退后能就地修改重发"，本 spec 明示，不静默对齐 baseline。
  - 配套字段：`fullText` = 锚点用户消息首个 text block 的完整文本（trim，不截 80），与展示用 `userMessageText`（截 80）分离；notice 用 `userMessageText`（截 80 展示用），输入框用 `fullText`（原文）。

## Handoff

- 上游：`~/.claude/jobs/a2ba85ca/tmp/rewind-baseline.md`（T5 ACR 输入，真值）
- 下游：`writing-plans` → `plans/checkpoint-rewind.md`
- 并行 / 后继：T1 已落地（checkpoint.ts + checkpoint.test.ts）；code 轴（OQ3）与撤销回退（OQ5）另立票。
