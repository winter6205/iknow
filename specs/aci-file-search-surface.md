# Spec: ACI 文件/搜索工具面升级

> 下游 plan：`plans/aci-file-search-surface.md`。
> 决策源：wayfinder **ACI 文件/搜索工具面（整体升级决策）**（`docs/wayfinder/aci-file-tool-surface-map.md`）。
> **Amends** ADR-0004：`grep` 默认输出与 `limit` 默认；`read_file` 不写 `limit` 则从 `offset` 读到 EOF（废 L14「默认 200 行」）。`edit_file` 唯一精确 + 显式 `replace_all` 沿用 ADR-0004，**不**加长度门槛。**Amends** ADR-0006：`grep` 默认条数 200→50；`read_file` 不再用默认 200/2000 行窗当整读策略（文件 1MB 拒与 executor 20000 字符兜底仍在）。
> 操作员 2026-09-12 选 spec-driven-development；同日改口回写（G1/G3）：`edit_file` 不硬前置 last-read。假设门 = 地图 Decisions so far（已 HITL）。

## Objective

让整文件覆写不能在本会话没看过现态时盖掉非空文件；让局部改靠磁盘上的连续原文自证，而不是「必须先读」硬前置。搜内容时先便宜地发现文件，再按需看行。使用者是主代理（会不会凭记忆整文件盖写、会不会在没钉死一处时改错）和操作员（工具契约可测，不靠加长 soul）。

## Boundaries

- **Does:**
  - **D1 last-read 只闸非空 `write_file`**：本 conversation 会话表按规范 path，**进程内分桶、不落盘**（`conversationId → path 集合`，与本次 registry/引擎同寿命；resume 空表）。入账两条：（1）成功 `read_file`（空文件成功读也入表，写侧空文件仍免检）；（2）成功 `bash` 且命令为白名单读、**恰好一个文件参数**、无管道、无重定向。白名单：`cat` / `nl` / `bat` / `batcat` / `head` / `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`。抽得出规范 path 才入表。`ls` / `stat` / 多文件 / 管道 / 其它命令 / 脚本读文件 **不**入表。不复用 `validateReadonlyCommand` / `classifyBashWorkspaceWrite`（那两件不返回 path）。`write_file`：目标已存在且 `size>0`、账上没有则 typed 失败、不写盘，回执点名 `read_file`（或等价先读）。**不按模型分档放行未入账覆写**。新建、**空文件（size==0）免检**。**`edit_file` 不查表**。不扫 `ctx.messages`。子代理新 conversation 空表。`ctx.conversationId` 缺席：已存在且 size>0 的 `write_file` **fail-closed 拒绝**；禁止隐式进程级全局表。无 id 时 `read_file` / 白名单 bash 仍可执行，但不入表（随后非空覆写仍拒）。不另做覆盖时磁盘备份。
  - **D1b `edit_file` 自证**：闸是 `old_str` 非空、与磁盘**连续原文**精确匹配、默认命中恰好 1；0 或 >1 拒绝，不模糊、不按「第 N 处」编号、不允许跳行拼锚、不默默改第一处。多处只能加长连续原文邻居，或显式 `replace_all=true`（**不**按行数/字符数禁全换）。多处失败回执可建议加长或设 `replace_all`。沿用 ADR-0004；本切片对 `edit_file` handler **无新行为**。
  - **D1c `read_file` 窗**：**不写 `limit` 则从 `offset`（默认 0）尽量读到文件尾**。工具整读页硬停 **16000** code point，正文提示未读完与下次 `offset`。`>1MB` 仍拒。executor **20000** 字符总闸不改（ADR-0006）。显式 `limit` 仍切行窗，硬顶 **2000**。否决默认/顶皆 2000 行；否决整读只靠 executor 默默砍尾。
  - **D2 `grep` 出法**：默认 `output=paths`（只回相对路径）。显式 `content`（`路径:行号:内容`）或 `count`（`路径:条数` + 全库 `total:`，合计为截断前全部命中）。不说则 paths。
  - **D3 附近几行 + 分页 + parser**：`content` 可带对称 `context`（整数，上下各 N 行）。`offset`（默认 0）+ **`head_limit`**（默认 **50**、硬顶 **2000**）切**已排序结果名单**，三种出法共用。不叫 `limit`（避免和 `read_file` 行窗撞名），不叫 `grep_limit`。偏移超过最后一条且本次查询**有**命中 → 回执精确为 `No entries at this offset`（不是空串、不是「无匹配」）。无匹配仍空串。parser 分列 `:` / `-` / `--`；稳定排序（path 再行号）发生在切片之前。与 D2–D6 **同票**，不可拆成「先加参数后改解析」。
  - **D4 收窄**：保留 `path`（目录）。加文件名 `glob`。加语言 `type`（与 glob 并列）。`type` 未知或引擎拒收不得报成非法正则。
  - **D5 行窗（过滤）**：可选 `also` + `within_lines`（`also` 在场时默认 5）。主词命中后只在该行窗找第二段，窗内没有则当没中。不是 D3 那种展示附近原文。不做裸跨行正则开关。落地后须实测模型会不会调、过滤是否减噪；有问题写入计划汇报，不在本切片先砍。
  - **D6 自带引擎**：安装/发版按平台下载钉死版本 + 校验和，放到安装根；运行只 exec 这一路径。PATH 上的 `rg` 不当主路径。「自带起不来」= 安装根二进制不存在，或 spawn 该路径得到 ENOENT / 无法执行。**有 rg 时匹配只出 rg**（不再经 JS 再滤）；**起不来时 Node 只做遍历 + JS `RegExp` 编得过的 pattern，调用仍成功**，命中集不必与 rg 相同；Node **不**模仿 rg 默认引擎的拒绝集。禁止为凑合去 exec PATH `rg`。禁止用 `--engine=auto` / `--no-unicode` 一类 rg 引擎开关去凑两引擎对齐（两者都是「把 rg 的语义掰向 JS」的杠杆：`--engine=auto` 换引擎、`--no-unicode` 把 `\w` / `\d` / `\b` 切到 ASCII 口径）。发布门是生产 handler `createGrepTool`，不是方言对齐 fuzz。匹配类口径 = 有 rg 时 rg 默认 Unicode（`\w` / `\d` / `\b` 认 CJK / 阿拉伯-印度数字），无 rg 时 JS 的 ASCII —— 两侧命中集可能不同 = 特性，不是漏测（ADR-0089）。
  - **D7 说明书**：改 `grep` / `read_file` / `edit_file` / `write_file` description 与失败文案须先夹具或登记缺口（`docs/guides/prompt-development.md`）。不加长 soul / usage。
  - **D8 打包**：本文件是**一张契约**。落地拆 **两个 logical task**（可两 PR）：Task A = D1+D1c+D7（账本、`write_file` 闸、`read_file` 窗、写/读说明书）；Task B = D2–D7 搜面。两 task 可并行，**禁止**单 diff 混进两批。各 task 内部不拆（尤其 Task B 的 parser/排序/出法/引擎）。CI 取消 `grep` 排除、黄金集补建、字段别名细抠、存量外部产品具名清理 — **后切**（见 Out）。D1b 不单独开 task。
- **Confirms with human:** (none — 地图已裁)
- **Out of this spec:**
  - `glob` 工具契约、TUI 折叠/措辞、permission、语义 shell AST。
  - 裸 `multiline` 正则（本切片不做；计划收尾提一句，实测跨行对不上再开票）。
  - 把条数参数叫 `limit` 或 `grep_limit`（已改为 `head_limit`）。
  - 扫对话当读过；失败文案软提示仍写入。
  - CI workflow 装引擎 / 取消 exclude 的具体 PR（可跟 D6 同迭代，不阻塞本契约）。
  - 仓库存量外部产品具名清理。
  - 业务任务（模型适配器等）。

## Success Criteria

- **SC1（同回合读后覆写）**：同一 turn **串行**先成功 `read_file`，或先成功白名单单文件 `bash`，再 `write_file` 同一已存在且 size>0 的 path → 写入成功（表由对应 handler 写，不依赖 `ctx.messages`）。未入表的 `edit_file` 只要 `old_str` 自证通过即可成功。
- **SC1b（并发写闸）**：同一 conversation、同一已存在且 size>0 的 path、账上无读：并行两次 `write_file` 均失败且字节不变。账上已有读：并行两次成功覆写以「先落盘者赢」为准，不得把表清空。禁止无 conversationId 的并行非空覆写走隐式全局表。`edit_file` 不参与此账本闸。
- **SC2（edit 自证）**：`old_str` 0 次或 >1 次且未开 `replace_all` → `edit_file` 失败、字节不变。任意长度 `old_str` + `replace_all` 且命中 ≥1 → 替换每一处。无 `conversationId` **不**因此拒绝 `edit_file`。不因锚点短而额外失败。
- **SC3（write 分叉）**：path 已存在、size>0、未读（或无 conversationId）→ `write_file` 失败、字节不变；path 不存在或 size==0 → 写入成功且不要求先读。
- **SC4（默认路径）**：只传 `pattern` → 模型可见行皆为相对路径、无 `:行号:` 形匹配行；条数 ≤50。
- **SC5（content / count）**：`output=content` 为 `path:line:text`；`output=count` 含每文件计数且 `total:` 等于未切片前命中总数。
- **SC6（context 不脏行）**：`output=content` 且 `context≥1` 时，上下文行与 `--` 不被切成假 `path:line:text`。
- **SC7（分页）**：有命中、`offset` 越过最后一条 → 回执为 `No entries at this offset`；`offset=0, head_limit=50` 与 `offset=50` 的路径集合不重叠。
- **SC8（行窗）**：`also` + `within_lines` 只在窗内第二段命中时回报；窗外第二段不报。
- **SC9（引擎）**：生产 handler 默认 exec 安装根钉死二进制，不先 `which rg`。测试注入缺失二进制 → Node 遍历 + JS `RegExp`（编得过的 pattern），**调用仍成功**（不得 typed 拒绝该调用，不得调用 PATH `rg`）；命中集不必与 rg 一致。有 rg 时匹配只出 rg，不 JS 再滤。有 rg 档 `\w` / `\d` / `\b` 按 rg 默认 Unicode 口径（认 CJK / 阿拉伯-印度数字），无 rg 档按 JS 的 ASCII 口径 —— 两侧命中集可能不同 = 特性，不是漏测（ADR-0089）。
- **SC10（非法 / 类型）**：坏正则与未知 `type` 为两种 typed 错误，文案不可混为「illegal regex」一种。
- **SC11（回归）**：本地必跑现行 `tests/harness/aci/tools/grep.test.ts` 与 `edit-file` / `write-file` / `read-file` 相关套件。`npm test` 全绿。改 description 则补轨迹集或 commit 登记缺口。
- **SC12（复杂度）**：`grep` 扩张按职责拆函数（flag / argv / 行解析 / 计数 / 文件命中），遵守 `complexity-anti-drift` 门，不把整份 handler 写成一坨。
- **SC13（read 窗）**：不传 `limit` 且文件未超 1MB → 从 offset 起最多 16000 code point；未到 EOF 则正文含续读提示。显式 `limit>2000` 被夹到 2000。不传 `limit` **不得**被实现成默认 200 或默认 2000 行。账本仅内存分桶，resume 后未再读则非空 `write_file` 仍拒。

## Open Questions

(none)

## Inherits / Changes

**Quotes（CONTEXT.md）：**

- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；当前 8 件：`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`…
- **executor truncation authority**（契约 X）: executor 是工具结果截断元数据的唯一权威……
- **observability side-channel**: handler 返 envelope `{ output, meta? }`……`edit_file`/`write_file` 的 `oldContent`/`newContent`……永不进模型视野。
- **说明书不是闸**（`docs/guides/prompt-development.md` 原则 1）：能 schema / 轨迹判定的不要只写 prompt。

**Inherits：** ADR-0004 六件底盘与精确替换 / `replace_all` / poka-yoke；ADR-0006 硬顶与契约 X；ADR-0068 不做语义 shell；`read_file` 成功回执仍无 path（D1 不靠回执扫 path）。**例外：** `grep` 结果名单条数不叫 `limit`，叫 `head_limit`。

**Changes：** `grep` 默认输出与默认条数；条数参数名 **`head_limit`**（默认 50、顶 2000）；`grep` 增 `output` / `offset` / `context` / `glob` / `type` / `also` / `within_lines`；自带搜引擎；会话 last-read 表只罩已存在且 size>0 的 `write_file`；`edit_file` 不加长度门槛；`read_file` 默认整文件（不写行 `limit` = 尽量到 EOF，整读页 16000）。

**待写入：** (已刷) CONTEXT `last-read ledger` + ADR-0084 + ADR-0004/0006 Amendment。产品代码未实施。

## architecture-change-reviewer

```
bounded-context-guardian: yes — 落在 harness ACI read/edit/write/grep + 安装根；TUI/CI 装引擎在 Out。
defensive-contract-validator: yes — 空/负/溢/并发（SC1b 只罩 write）/异常（SC10、D6）五类有 SC。
error-handling-enforcer: yes — 无 conversationId 时非空 write fail-closed；edit 不因无 id 拒；偏移过头/坏正则/未知 type typed；D6 起不来唯一 EXIT = Node 遍历 + JS `RegExp`，调用不被 typed 拒绝；rg 在场时匹配只出 rg；SC9 与 D6 对齐（ADR-0089）。
complexity-anti-drift: yes — Task B 按 flag/argv/解析/计数/命中拆；禁止单 handler 吞形态。
minimal-change-verifier: yes — D8 两 logical task、禁混 PR；一张契约两落地任务。
**注（D6/SC9 ADR-0089 修订）：** 验收对象是生产 handler `createGrepTool`，**不是**「两引擎命中集严格同判」的 fuzz / dialect-parity 测；本 PR 改写后该 fuzz 不再是 D6/SC9 的发布门。
```
