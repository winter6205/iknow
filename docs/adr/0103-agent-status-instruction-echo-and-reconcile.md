# 0103. 状态栏复诵升级：instruction 回显字段与 pivot reconcile 标记

Date: 2026-09-19
Status: accepted

## Context

实测会话（2026-09-18，conversation `ee13c787`，yolo-mode worktree）：用户 pivot 指令（「把做好的开pr，没做完的pr交接」）进场后，状态栏仍每跳全量重发冻结的旧 todo 清单（同形栏 30+ 条），指令本身只出现 1 次并被栏列推出末段注意力窗口——模型继续做旧任务约 8 分钟，直到用户手工打断。复诵（把现势钉在 messages 末尾，利用注意力 recency 效应，免除模型自扫历史中段的算力）是状态栏的核心价值（ADR-0028）；该事故暴露的病灶不是注入频率，而是**复诵内容失真**：栏忠实投影了账本，但账本没跟上指令更新，高频复诵于是持续放大过时目标。

## Decision

1. 每跳注入**保留**；append-only、不替换旧栏（ADR-0028 注入纪律不动）。
2. 栏新增 `instruction:` 字段——最新用户指令首行的**逐字回显**，截断约 100 字符，纯代码计算；不摘要、不改写。
3. **pivot reconcile 标记**：新用户消息进场后的下一条栏附一次性标记，提示模型先用 `todo_write` 对齐 todo 账本再继续；标记只在该跳出现，后续跳不重复。
4. 栏仍只承载代码算出的现势，不含政策散文。

## Why not

- **边界注入 + 同快照 dedup**（注入点收敛为 run 开始 / compaction 后 / 用户进场 / 账本变化）：dedup 会拆掉复诵的每跳 recency 刷新，边界注入丢长任务中段的高频曝光注意力价值；省下的 token（每条栏约 50）不抵注意力损失。此方案日后可能以「降噪」名义再被提出，拒绝理由记录在此。
- **LLM 摘要指令进栏**：引入二次失真源，违反「栏只承载代码算出的现势」。

## Consequences

- 修订 ADR-0028 Consequences 两处半句：「现势字段仅 last_tool + todo 段」（字段集现含 instruction 段与一次性 reconcile 标记）、「不把任务摘录抄进栏」（被禁的仍是语义抽取；instruction 回显是用户原话首行的逐字回显，由代码计算，不是任务摘录）。taskFocus / 任务卡禁令不变；「任务摘录」（compact 时现抽现贴，至多 3 句）与 instruction 回显（每跳、首行、截断）的界线保持。
- reconcile 标记文本固定、跨回合字节稳定（在栏不在 system，不破 system 前缀稳定性）。
- 实现面：`buildAgentStatusText` 字段集扩展 + loop-engine 注入点取「最新用户指令」+ 一次性标记结算；缝的形状不变。

## Evidence pointers

- 会话 transcript `~/.iknow/projects/iknow-ddcb805367a0/ee13c787-5958-4524-95d3-0e89d520f12a/`（2026-09-18）：指令 e8 进场后同形栏 30+ 条 vs 指令 1 条；15:33 用户打断「什么情况交个pr这么久」。
- 长上下文注意力 U 形分布（中段检索精度显著低于首尾）是已确立的文献结论；每轮复诵任务清单是长程 agent 的主流对策（recitation 模式）。
