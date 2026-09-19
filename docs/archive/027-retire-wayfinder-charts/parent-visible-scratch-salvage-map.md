> **ARCHIVED** — 只读留档；活契约见 `docs/archive/027-retire-wayfinder-charts/README.md`。

# wayfinder:map — 子代理父可见暂存与空交差补救

> Tracker: 本地 markdown（本 run 未点名 GitHub issue）
> Charted: 2026-09-09
> 图名（人读引用时用全名，不要用裸 id）：**子代理父可见暂存与空交差补救**

## Destination

给子代理（及主会话）一条父看得见、跟会话同寿命、不是 taskRoot 交付物的 `/tmp` 面。交差带 `task_id` 与 `/tmp` 根；空交差可补扫盘清单；父可按需 按 id 读。到达标志：中间物有地方放，父能按路径找到，交付仍认 taskRoot。

## Notes

**domain**：子代理交差与宿主侧 `/tmp` 寿命。本图只记讨论裁定，不记对照材料。

**每个 session 开工前必读的 skill**：

- `arthurpower:logicsync` —— grilling 票的默认工作方式
- 物理落点若改围栏可写集或 `/tmp` 寿命，过 `bounded-context-guardian` / `architecture-change-reviewer` 再进 spec

**tracker**：本地 markdown，本文件即地图 + 票。

**本图必须尊重的既有决策**（票内明确点名者除外）：

- 子代理与父共享写根，不另开产物目录、不另建 worktree（ADR-0040 / ADR-0068）
- 父可见信封是短摘要与路径，不是终稿全文
- 耐久交付仍以 taskRoot 为准；本图加的是暂存与补救，不把暂当仓库交付

**本图不讨论**：把交差或补救接到任何跨会话事实库 / 抽取通道。

**另开 issue（操作员 2026-09-09）**：主进程读能力对 coding agent 过严（更像 sandbox 档）。按理主进程应能读到自己根以外的其它项目，只是不主动引导。本图不改闭世界读白名单。已开：[主进程读能力过严：coding agent 应能读项目根外（不引导）](https://github.com/winter6205/iknow/issues/972)。

## Decisions so far

- Destination 选定（2026-09-09 操作员确认 Recommend）：父可见暂存面 + 空交差 / 截断时 host 按路径补救。
- [暂存面的物理落点与寿命](./parent-visible-scratch-salvage-map.md#g1--暂存面的物理落点与寿命) — 每个 worker 一个宿主目录，bind 成该 worker 围栏 `/tmp`；寿命 = 该 worker 全程 + 退出后的补救窗口。不是 taskRoot，不另开 worktree。
- [主进程要不要同一套暂存面](./parent-visible-scratch-salvage-map.md#g5--主进程要不要同一套暂存面) — 要。主会话单独一块宿主目录，bind 成主围栏 `/tmp`；不和任何 worker 共用。
- [子代理记录要不要收进同一 taskId 目录](./parent-visible-scratch-salvage-map.md#g6--子代理记录要不要收进同一-taskid-目录) — 新 worker 进 `subagents/<taskId>/`（记录 + `/tmp` 垫底）。旧平铺不迁。stderr 见 G10。
- [补救何时触发](./parent-visible-scratch-salvage-map.md#g2--补救何时触发) — **修订**：成败都带 `task_id` + `/tmp` 根。空/失败/截断时 host 可加扫盘清单。成功不强制扫目录。
- [补救读到的东西进谁的视野](./parent-visible-scratch-salvage-map.md#g3--补救读到的东西进谁的视野) — **修订**：不灌正文。根路径每次带。文件清单按需 按 id 读，空交差时可附带扫盘结果。
- [`/tmp` 留存时效](./parent-visible-scratch-salvage-map.md#g7--tmp-留存时效) — 跟会话文件夹同寿命；成功也留在盘上。不按成败立刻删。
- [成功后父能否主动看该 worker 的 `/tmp`](./parent-visible-scratch-salvage-map.md#g8--成功后父能否主动看该-worker-的-tmp) — **修订**：可以 按 id 读。信封每次有 `task_id` + `/tmp` 根，与成败无关。
- [扩 `subagent_result` 是否等于每次带路径](./parent-visible-scratch-salvage-map.md#g9--扩-subagent_result-是否等于每次带路径) — 钥匙和根路径在交差里；列文件/读文件仍是按需 按 id 读，不是每次倒全文。
- [有意不落仓库与 taskRoot 交付如何分界](./parent-visible-scratch-salvage-map.md#g4--有意不落仓库与-taskroot-交付如何分界) — 可写集 = taskRoot + `/tmp`。bash / 写工具都能写。交付写 taskRoot，不必进仓写 `/tmp`。不自动搬。`$TMPDIR` / `mktemp` 同一块垫底。
- [体积上限](./parent-visible-scratch-salvage-map.md#g11--体积上限) — 不定新闸。跟会话文件夹走。
- [stderr 归入 taskId 目录](./parent-visible-scratch-salvage-map.md#g10--stderr-归入-taskid-目录) — 新 worker 的 stderr 进 `subagents/<taskId>/`。旧文件不迁。
- [按 id 读 入参出参](./parent-visible-scratch-salvage-map.md#g12--按 id 读-入参出参) — 不传 `tmp_path` 列顶层；传入则读一份（截断同 `read_file`）。
- 主进程读根外：不在本图。另开 issue。

## Not yet specified

（空。剩余项已裁定或外置。）

## Out of scope

- 任何跨会话事实库 / 抽取 / 召回通道（操作员本图排除）
- 每个子代理独立 worktree
- 在不改寿命的前提下，让父去读已经灭掉的当次 bash 命令面

---

### G1 · 暂存面的物理落点与寿命

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: —

**## Question**

父看得见的那条暂存，物理上落在哪、活多久？

要同时钉死三件事：宿主上的目录（或等价物）在哪；围栏里的 `/tmp` 还是不是「一次 bash 一灭」；子代理进程退出之后，父还能不能按路径读到残留。

本票不决定何时触发补救、读到的东西进谁的视野——那是 G2 / G3。

**## Resolution**

每个 worker 一个宿主目录；该 worker 的每一次 bash 把这个目录 bind 成围栏 `/tmp`，不再「一次 bash 一块空 tmpfs」。寿命 = 该 worker 全程 + 退出后的补救窗口。不是 taskRoot，不另开 worktree。同一 worker 内两次 bash 共享这块 `/tmp`；worker 之间不共用。窗口多长、何时去翻，见 G2。

### G5 · 主进程要不要同一套暂存面

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G1

**## Question**

主会话自己的 bash 今天也是「一次命令一块空 `/tmp`」。G1 只给了 worker。主进程要不要同样：一个会话级宿主目录，bind 成主围栏 `/tmp`？若要，和各 worker 的目录是分开的，还是和某个 worker 共用？

本票不决定补救触发（G2）和读完进谁的视野（G3）。

**## Resolution**

要。主会话单独一块宿主目录，bind 成主围栏 `/tmp`。不和任何 worker 共用。机制与 G1 同类，目录分开。

### G6 · 子代理记录要不要收进同一 taskId 目录

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G1

**## Question**

今天 worker 的会话记录是平铺的 `subagents/agent-<taskId>.jsonl` + `.meta.json`（ADR-0071）。`/tmp` 垫底若按 taskId 分目录，这两份记录要不要搬进同一个 `subagents/<taskId>/`，和 `/tmp` 后端放在一起？旧的平铺文件迁不迁？

**## Resolution**

新 worker 收进 `subagents/<taskId>/`：该 worker 的会话记录与围栏 `/tmp` 垫底同目录。旧的平铺 `agent-*.jsonl` 不迁。stderr 归入见 G10。主会话 `/tmp` 仍在主会话文件夹，不进某个 worker 的 taskId。

### G2 · 补救何时触发

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G1

**## Question**

host 什么时候按暂存路径去翻：仅失败 / 空信封 / 截断，还是成功路径也暴露路径（例如上下文被收束之后还要能找回）？

**## Resolution**

每次终态都带 `task_id` 和这块 `/tmp` 的根。成功不强制扫目录列文件。空/失败/截断/crash 时 host 可以额外扫一份短清单。前景后景同一套。

### G3 · 补救读到的东西进谁的视野

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G1

**## Question**

host 读到残留之后，是只写进信封里的短摘要与路径、留给父模型自己 `read_file`，还是自动把正文灌进父 context？

**## Resolution**

不把文件正文灌进父 context。信封每次带 `/tmp` 根 + `task_id`。顶层文件清单不默认附带；父 按 id 读 或空交差补救扫盘时再给。`fileRefs` 仍来自写工具入参。

### G7 · `/tmp` 留存时效

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G1

**## Question**

围栏 `/tmp` 的垫底在盘上活多久？worker / 主会话成功结束之后文件还在不在？清理跟「交差成败」走，还是跟会话文件夹（或一段固定窗口）走？

**## Resolution**

时效跟会话文件夹走，不跟成败走。成功结束后文件仍在垫底上。删会话（或会话级 GC）一起清。不定独立体积闸（G11）。

### G8 · 成功后父能否主动看该 worker 的 `/tmp`

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G2

**## Question**

交差成功、信封只有分析、子代理把报告写在 `/tmp`（或只写在对话里）而忘了写到 taskRoot 时，父进程能不能主动去看？这和 G2「成功不自动扫」是否并存：自动补救仍只在交差不能用时，主动查看是否另开一条？

**## Resolution**

可以 按 id 读。交差里已有 `task_id` 和 `/tmp` 根，成败都能看。从未写成文件的对话正文不在本票。

### G9 · 扩 `subagent_result` 是否等于每次带路径

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G8

**## Question**

给 `subagent_result` 加上按 `task_id` 看 `/tmp` 之后，是否等于每次成功/失败都返回路径，从而推翻 G2 / G3？

**## Resolution**

`task_id` + `/tmp` 根在每次交差里。列目录 / 读某一份仍是 `subagent_result` 按需 按 id 读，不是把垫底全文塞进信封。

主进程读根外（其它项目）过严，另开 issue，不在本票改围栏读白名单。

### G4 · 有意不落仓库与 taskRoot 交付如何分界

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G1

**## Question**

模型怎么被引导把「不必进仓库」的中间物写到暂存面，而把交付物写到 taskRoot？工具描述、写根告知、回执分别说什么？

**## Resolution**

可写集与围栏一致：taskRoot + `/tmp`。`bash` / `write_file` / `edit_file` 都能写这两块；`write_file("/tmp/…")` 落到**当前这个进程**的垫底，不是系统 `/tmp`。告知两句：进项目写 taskRoot；不必进仓写 `/tmp`（跟当前进程同寿命，不是交付）。不按文件类型分流，不自动从 `/tmp` 拷进仓库。`$TMPDIR` 与 `mktemp` 指到同一块垫底，不另开第二条临时路径。写处境 / 写根段仍只说交付根。`fileRefs` 仍来自写工具入参（写到 `/tmp` 就会出现 `/tmp/…`）。信封另带 `/tmp` 根；文件清单只在空交差补救或 按 id 读。

### G10 · stderr 归入 taskId 目录

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G6

**## Question**

新 worker 的 `stderr/<taskId>.log` 要不要搬进 `subagents/<taskId>/`？

**## Resolution**

要。与记录、`/tmp` 垫底同目录。旧平铺 stderr 不迁。指针改指新位置。

### G11 · 体积上限

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G7

**## Question**

`/tmp` 垫底要不要单独的体积产品闸？

**## Resolution**

不要。跟会话文件夹走。实现若能沿用既有围栏 tmp size 则沿用，本图不定字节数。

### G12 · 按 id 读 入参出参

- type: `grilling` · state: **closed**（2026-09-09）· blocked-by: G8

**## Question**

`subagent_result` 看垫底时入参出参是什么形状？

**## Resolution**

`task_id` 必填。可选 `tmp_path`（相对该 worker 的 `/tmp`）。不传 = 只列顶层名字。传入 = 读这一份，截断同现有 `read_file`。
