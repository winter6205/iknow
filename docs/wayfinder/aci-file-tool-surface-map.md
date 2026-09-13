# wayfinder:map — ACI 文件/搜索工具面（整体升级决策）

> Tracker: 本地 markdown（沿用本仓既有 wayfinder 惯例，不开 GitHub issue）
> Charted: 2026-09-11
> 图名（人读引用时用全名）：**ACI 文件/搜索工具面（整体升级决策）**
> 触发：handoff `docs/handoff/2026-09-11-aci-file-tool-surface-decisions.md`（worktree `worktree-aci-file-tool-surface`，commit `edff8bbd`）。该文是上一会话的修订清单，只作输入，不预选方向。

## Destination

走完一次「文件/搜索工具面」的**整体升级决策过程**：`read_file` / `edit_file` / `write_file` / `grep` 当同一张面一起过，按「事实 → 取舍 → 同票边界 → 落地顺序」推进。开图时不钉死任何一档机制（登记表、失败文案、grep 扩到哪、默认输出形态都保持 live）。到达标志是过程走完、每张 grilling 有 Resolution（含明确的不动），能交给 spec 或 stop。不把「实施某份修订清单」或「先选定一个方向再往下」当到达。

> 操作员 2026-09-11 改口确认：过程，不是定死一个方向。未走完过程前不改产品代码。

**Handoff（2026-09-12）**：地图到达。契约 [`ACI 文件/搜索工具面升级`](../../specs/aci-file-search-surface.md)；plan [`ACI 文件/搜索工具面升级`](../../plans/aci-file-search-surface.md)。ADR-0084。操作员选 spec → plan。未实施产品代码。

## Notes

**domain**：模型可见文件工具面（`read_file` / `edit_file` / `write_file` / `grep`）作为**一张面**。票是过程里的问，不是预选的实现方向。`glob`、TUI 措辞、permission、语义 shell 不在本图。原则对齐 `docs/guides/prompt-development.md`：说明书不是闸；改 description / 失败文案要先有夹具或登记缺口。

**每个 session 开工前必读**：

- `arthurpower:logicsync` —— grilling 默认
- `docs/guides/prompt-development.md` —— 动 description / 错误文案必对照
- `docs/adr/0004-tool-layer-six-tool-set.md` —— grep / edit_file 契约
- `docs/adr/0006-*.md` —— grep 默认 200 / cap 2000
- `arthurpower:domain-modeling` —— 若改 ADR-0004 契约行才走

**落盘纪律**：调研对象与外部产品名**不出现**在本图、票体、注释、测试名、模型可见字符串。票内只写机制（登记表 / 消息扫描 / 失败文案 / 输出模式），不写来源。

**本图必须尊重的既有决策**（票内点名挑战者除外）：

- **ADR-0004** —— 六件底盘仍在；G2 将 reopen `grep` 默认输出行（落地时走 domain-modeling）。`limit` 名字仍统一。
- **契约 X** —— 截断权威在 executor，工具不自报 `truncated`/`total`。
- **ACI 统一 `limit`** —— `read_file` / `glob` / `grep` / `query-trace` / `tool-search` / `list-sessions` 同名；单件改名制造分裂。
- **ADR-0068** —— 不做语义 shell AST。
- **上一会话已证伪、本图当作事实起点**（详 R1）：用 `ctx.messages` 扫「本会话是否读过该文件」在同回合读后即改路径上**不可能**按字面成立。

## Decisions so far

- [R1 同波消息快照能否看见刚读的文件](tickets/r1-edit-freshness-message-scan.md) — 同回合 edit 看不见刚读的 tool_result；成功回执无 path；跨回合可配对但压缩后不可依赖。
- [R2 grep 现行 parser / 排序 / CI 盲区](tickets/r2-grep-parser-sort-ci.md) — 第一个冒号切分；无 `--sort`，limit 切在不稳定序上；`-C`/`--` 会脏行；CI 排除 grep 与 description guard；rc=2 一律当非法正则。
- [R3 写前新鲜度与搜索面的机制选项](tickets/r3-freshness-and-search-mechanisms.md) — 同回合覆盖靠自动再读，或登记表在 read 落表后串行 edit；历史扫描与失败文案盖不住。`limit` 保持契约名。
- [G0 整面决策顺序与同票边界](tickets/g0-upgrade-decision-order.md) — 不投过程档；一次只问一件能懂的事，整面都要过。
- [G1 写前新鲜度闸放哪](tickets/g1-edit-freshness-gate.md) — 2026-09-12 改口：`edit_file` 取消硬前置，自证唯一精确；短锚禁 `replace_all` 再否决；`read_file` 默认整文件。
- [G2 grep 本切片扩到哪一层](tickets/g2-grep-slice-boundary.md) — 默认只给路径；匹配行/计数可选；附近几行+分页+parser 同票；`head_limit` 50/2000；文件名+语言类型；行窗过滤；不裸跨行（收尾再提）；安装自带引擎。
- [G3 write_file 是否共用新鲜度闸](tickets/g3-write-file-freshness.md) — 2026-09-12 改口：已存在且 size>0 未读硬拒；入账 = `read_file` + 白名单单文件 bash；新建与空文件免检；无磁盘备份。
- 打包（对话裁，无单独票）— Task A：账本 + 非空 `write_file` 闸 + `read_file` 默认整文件；Task B：搜面（出法/附近几行/分页/parser/自带引擎）。可并行、禁混一个 PR，各自内不拆。后切：CI 排除、黄金集、字段名细抠、存量具名清理。

## Not yet specified

- description / 黄金集补还是登记缺口：spec / plan 里按 `prompt-development` 二选一。
- CI 随自带引擎取消 `grep` 测试排除的具体步。
- 行窗 / 出法字段的 schema 用词细抠。
- 仓库存量外部产品具名是否另立清理任务。

## Out of scope

- 不实施「模型适配器」或其它业务任务。
- 不重做 permission 层、不做语义 shell AST。
- `glob` 契约与 TUI 折叠/措辞不动。
- 不加长 soul / usage 当唯一修复。
- 不把外部产品名写进仓库增量。

## Tickets

票体在 `docs/wayfinder/tickets/`。阻塞用正文 `Blocked by:`。

| 票                                                                               | 类型     | 在过程中的位置           | 阻塞       |
| -------------------------------------------------------------------------------- | -------- | ------------------------ | ---------- |
| [R1 同波消息快照能否看见刚读的文件](tickets/r1-edit-freshness-message-scan.md)   | research | 事实                     | —          |
| [R2 grep 现行 parser / 排序 / CI 盲区](tickets/r2-grep-parser-sort-ci.md)        | research | 事实                     | —          |
| [R3 写前新鲜度与搜索面的机制选项](tickets/r3-freshness-and-search-mechanisms.md) | research | 事实（机制菜单，不预选） | —          |
| [G0 整面决策顺序与同票边界](tickets/g0-upgrade-decision-order.md)                | grilling | 过程怎么走               | R1, R2, R3 |
| [G1 写前新鲜度闸放哪](tickets/g1-edit-freshness-gate.md)                         | grilling | 取舍（一问）             | G0         |
| [G2 grep 本切片扩到哪一层](tickets/g2-grep-slice-boundary.md)                    | grilling | 取舍（一问）             | G0         |
| [G3 write_file 是否共用新鲜度闸](tickets/g3-write-file-freshness.md)             | grilling | 取舍（一问）             | G0, G1     |

Frontier：空。grilling 已结。地图到达：决策过程走完，待交接下一技能（不自动开写代码）。
