# wayfinder:map — 轻量只读问句的上下文卫生

> Tracker: 本地 markdown（用户裁定不开 GitHub issue；skill 默认 tracker 的 fallback 形态）
> Charted: 2026-09-04
> 图名（人读引用时用全名，不要用裸 id）：**轻量只读问句的上下文卫生**
> 触发会话：`87d39037-ff8f-4cf3-8551-165cdcb67e45`（用户原话「看一下今新闻」）

## Destination

让像「看一下今新闻」这类**轻量只读问句**走完自己的路：模型去取新闻，不被记忆通道扩成归档/建树任务，也不被 worktree isolation 的门禁说明书劫持。

到达标志：只读、无仓库意图的问句，记忆可以提示来源，但不把问句升级成仓库任务；只读命令不把门禁错误写成「去建 task worktree」。

## Notes

**domain**：记忆读通道（`memory_catalog` / `EXISTENCE_POINTER` / `memory_recall`）与 worktree isolation 门禁（`classifyCall` / `unboundMutateNotice`）对模型上下文的注入。

**每个 session 开工前必读的 skill**：

- `arthurpower:logicsync` —— grilling 票的默认工作方式
- `arthurpower:domain-modeling` —— G2/G3/G4 若改既有 ADR 通道契约，走它。G1 已否决把「轻量只读问句」收成产品类，不进 CONTEXT。
- 触 ADR-0034 / ADR-0009 / ADR-0037 的票过 `bounded-context-guardian` / `minimal-change-verifier`

**tracker**：本地 markdown，本文件即地图 + 票。禁止开 GitHub issue。

**并行 session**：另有图「模型面前缀分层与缓存兑现」声明不改 worktree **工具形态**。本图可能改的是门禁**分类**与**错误文本**（`classifyCall` / `unboundMutateNotice`），不是 `create-task-worktree` 的 ACI 形状。改门禁前先对一下那张图的 Notes，避免两头同时改同一文件。

**本图必须尊重的既有决策**（票内明确点名者除外）：

- **ADR-0034** —— catalog 进 system、body 不进 system；prefetch 进用户消息；recall 是模型主动搜。本图问的是「何时允许促使 recall」，不是把 body 灌回 system。
- **ADR-0037** —— isolation ON 时 mutate 门禁从不自动建树；错误文本目前**故意**指向 `create-task-worktree`。本图可以挑战这条说明书在假阳性 / 只读意图下该不该出现，不挑战「门禁不 auto-provision」。
- **`validateReadonlyCommand`**（#562）—— 为 bash **readonly 模式**写的 deny-by-default 表，不是「会不会写工作区」的分类器。`classifyCall` 今天复用它。

**charting 期核实过的既有事实**（冲突时以代码与该次 trace 为准）：

1. 用户消息只有「看一下今新闻」。首轮 `input_tokens` 11541；模型 thinking 写「从 Notes 里记得 Daily AI News Source / AI News Archive Structure / Archive Directory Is Manually Maintained」，随即 `memory_recall(query="daily AI news source archive")`。
2. `EXISTENCE_POINTER` 字面是：`A memory library is available. Use memory_recall(query) to retrieve past experience.` —— 这是指令，不是目录。库非空就进 system；不跟 `autoExtract` 关。
3. `memory_catalog` 在 `autoExtract === true` 且库非空时进 system，带纪律句「Machine-collected notes may be stale or wrong. They are not rules…」。模型仍把目录标题当必须 recall 的清单。
4. recall 回了四条（约 2205 字），含互相打架的 archive 惯例：一条说 `archive/` 是手工维护约定，一条说该目录可能不存在。模型下一波去 `ls` 验证目录，并 `web_fetch https://ai-bot.cn/daily-ai-news/`。
5. 被拦的 bash 是：`date '+%Y-%m-%d' && ls -la /home/winner/projects/iknow/archive/ 2>&1 | head -30`。`date` / `ls` / `head` 都在 `READONLY_ALLOWED` 里。`classifyCall` 对 bash 调 `validateReadonlyCommand`；该校验**凡 segment 含 `&` 一律拒**，注释写明 `2>&1` 也拒。因此这条只读命令被标成 mutate。
6. 门禁回执是 `unboundMutateNotice()`：`[worktree_isolation] workspace mutation blocked: … Call the create-task-worktree ACI tool to create this conversation's task worktree and rebind the session root, then re-issue this write in the new root.` 这条说明书进了 append-only messages。
7. 本回合没有 `memory_prefetch` 叠加块（用户消息 31 字符，无 overlay）。prefetch 不在本次污染链上，但是否会在别的短中文问句上劫持，还看不清。

**工作名「轻量只读问句」**：只是本图 destination 用语。G1 已否决产品类 / host 意图识别，不写入 `docs/CONTEXT.md`。

**决议纪律（2026-09-04）**：Decisions so far / 票 Resolution / CONTEXT / ADR 只记本图讨论收口。业界对照不写入这些落点；调研草稿不作为决议依据，已从 `docs/wayfinder/research/` 清掉。

**handoff（2026-09-04）**：frontier 已空。下游 spec / plan 已落本 worktree：`specs/casual-ask-context-hygiene.md`、`plans/casual-ask-context-hygiene.md`。

## Decisions so far

- **G1 · 轻量只读问句是产品类，还是只修两条通道** — 不做 host 意图识别。所有回合同一套：不下令必召，召了只给有用的。「轻量只读问句」仍是 destination 工作名，不是产品类。
- **G2 · 记忆通道何时可以促使 memory_recall** — 停下令，留目录，留 prefetch，收工具说明，召回变瘦。写侧 autoExtract 不动。不上 ES、不做意图闸。
- **G3 · worktree 分类器该不该继续复用 bash-readonly 的 `&` 拒绝** — 「读放行、写才拦」不变。门禁自己判断会不会写工作区，不再复用 `validateReadonlyCommand`。bash readonly 模式那张表不动。
- **G4 · 门禁错误文本何时可以指示 create-task-worktree** — 真 mutate 仍点名建树工具。说明书改成事实阻断，不把模型下一拍收成「去建树」。不按问句分型，不关 isolation。
- **R1 · 业界每回合是否注入检索到的记忆，检索要不要上 Elasticsearch** — 调研已完成。本图决议不引用其内容；草稿已清。

## Tickets

> 本地 fallback：一票一节。`state` 取 open / blocked / claimed / closed；`blocked-by` 为空即在 frontier 上。

### G1 · 轻量只读问句是产品类，还是只修两条通道

- type: `grilling` · state: **closed**（2026-09-04）· blocked-by: —

**## Question**

destination 里的「轻量只读问句」要不要成为产品类（模式 / 分类器 / 按用户文本判意图），还是根本不引入新类——只让记忆通道与 worktree 门禁自己不再劫持任意无 mutate 意图的回合？

若选产品类：判据是什么（用户文本、本波工具是否只读、operator 开关）？误判成「轻量」而放行真写入、或误判成「任务」而再次劫持新闻问句，哪个更不可接受？

**## Resolution**

不做 host 意图识别，不引入产品类。所有回合同一套：不下令必召，召了只给有用的。工作名只留在 destination。下一刀是读通道允许说什么（G2），不是分类器。

### R1 · 业界每回合是否注入检索到的记忆，检索要不要上 Elasticsearch

- type: `research` · state: **closed**（2026-09-04）· blocked-by: —

**## Question**

编码助手与记忆产品，会不会在模型每一次执行时，把查询到的「可能会有用」的记忆都注入上下文？业界在三条通道上怎么拆：

- 常驻目录 / 指针（system 里提示库在）
- 每回合按用户原文预取正文（prefetch）
- 模型主动工具召回（on-demand recall）

个人/项目级记忆库（本地 markdown、百到千条，不是企业搜索）上，检索跑 Elasticsearch（或同类倒排服务）的多不多？常见替代是本地 BM25、嵌入、还是启发式打分？「只召有用的、不要一定召回」在这些系统里是排序阈值、是工具描述不下令、还是根本不预取？

本票只收事实与出处，不收 G1/G2 决议。

**## Assets**

- （草稿已清，不进本图决议）

**## Resolution**

调研已完成。结论只用于对话答疑，不写入本图决议；草稿已清。

### G2 · 记忆通道何时可以促使 memory_recall

- type: `grilling` · state: **closed**（2026-09-04）· blocked-by: —

**## Question**

`EXISTENCE_POINTER` 今天直接指令模型 `Use memory_recall(query)`；catalog 列出标题后，本次会话模型把「今新闻」扩成对 archive 惯例的必召回。G1 已定为所有回合同一套，本题是全回合通道契约：

- 指针 / 目录 / 纪律句分别允许说什么？
- 什么情况下模型**不该**为对得上标题的记忆调用 `memory_recall`？
- 召回结果进 transcript 的体量与「advisory、不是指令」包装，够不够挡住「去建归档、去 ls 仓库」这种升级？

**## Resolution**

停下令，留「按用户原文自动贴有用正文」那台机器：

- **指针**：只说库在。删除 `Use memory_recall(query) to retrieve past experience.`
- **目录**：保留。纪律句改为：这是索引不是待办；标题与用户话撞词，不构成必须召回。
- **prefetch**：保留。按用户提示词打分贴正文，零词命中不贴。关掉的是下令去调工具，不是这台自动召回。
- **写侧 autoExtract**：不动。
- **工具说明**：删除 “at the start of a task”。需要某条已存事实时再查。
- **召回结果**：默认条数改小（例如 3）。advisory 保留，不当主防线。
- 不上 ES。不做意图闸。标题碰巧对上不构成必须召。

### G3 · worktree 分类器该不该继续复用 bash-readonly 的 `&` 拒绝

- type: `grilling` · state: **closed**（2026-09-04）· blocked-by: —

**## Question**

`classifyCall` 把 `validateReadonlyCommand` 当「会不会写工作区」的 SSOT。该校验为 bash readonly **模式**而写：segment 含 `&` 即拒，含 `2>&1`。本次 `date && ls … 2>&1 | head` 因此被标 mutate，尽管三个命令都在只读白名单、也没有写工作区。

分类器语义（会不会写工作区）和 readonly 模式语义（deny-by-default、引导改用 `read_file`）是不是同一件事？若不是：worktree 门禁是否另要一套「工作区写入」判定，还是放宽 `validateReadonlyCommand` 让 `2>&1` 通过——后者会同时改变 bash readonly 模式。

**## Resolution**

设计仍是「只有模型要写才拦，拦完引导去建树」。坏的是「什么叫要写」。

`classifyCall` 不再复用 `validateReadonlyCommand`。门禁自己判断会不会写工作区：`2>&1`、管道、只读命令串算读；`write_file` / `edit_file` / 会改文件的 bash 算写；未知 fail-closed 当写。`validateReadonlyCommand` 仍只服务 bash readonly 模式，不放宽。不改 `create-task-worktree` 工具形态。

### G4 · 门禁错误文本何时可以指示 create-task-worktree

- type: `grilling` · state: **closed**（2026-09-04）· blocked-by: —

**## Question**

`unboundMutateNotice` 对每一次未绑定 mutate 都给出同一段建树说明书，这是 ADR-0037 的 model-provision 契约。本次它被注入到一条本意只读的新闻问句里。

在 destination 下：这段说明书是否仍应对**所有**门禁失败出现？若分类器假阳性（G3），文本应说「这不是写入、命令被误判」还是仍说「去建树」？真 mutate 的说明书是否保持现状？错误文本进 append-only messages 之后无法撤回——这是否要求文本按意图分型，而不是一条通配？

G3 的分类收口会改变「假阳性还出不出现」，但不代替本题：真 mutate 的说明书仍可能劫持只读问句（模型被记忆拐去 `write_file` 时）。

**## Resolution**

G3 收口后，只读命令不应再走到这段话。真 mutate 仍点名 `create-task-worktree`（不自动建树）。文本改成事实阻断：隔离开着且未绑定，这次调用会写主仓，已拦下；若要写，先调该工具，再重试这一次调用。不把模型下一拍收成「去建树」这份新工作。不按用户问句分两套文案。不关 isolation。用户原话不被改写；改的是说明书别在 transcript 里改写模型以为自己该干什么。

## Not yet specified

（空：该收的已收进 G2–G4；测什么交给下游 spec。）

## Out of scope

- **开 GitHub issue** —— 用户裁定；本图只活在本文件。
- **关掉 worktree isolation** —— 用户要的是错误/工作流不注入，不是关隔离。
- **记忆内容质量 / GC / dream 清互相矛盾的 archive 条** —— 内容问题不是通道问题；G2 未把「矛盾条不得召回」收进通道契约。
- **新闻归档产品该不该存在、archive 目录建不建** —— 用户这句只是要新闻，不是要设计归档。
- **`create-task-worktree` ACI 工具的参数/命名/生命周期** —— 归 worktree 工具形态；本图只改门禁分类与错误文本。
- **goal / verify / subagent 等其它 ACI 说明书** —— 本次只见到 isolation；不在本图 destination。出现再开。
- **上 Elasticsearch / 把「轻量只读问句」做成意图分类器** —— G1/G2 已否决。
