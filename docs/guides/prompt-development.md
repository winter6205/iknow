# 提示词开发指南

何时读：改模型会读到的文本或装配（工具 description、soul / usage、抽取 / 梦境 / 研究轨说明书、system 前缀、工具 schema、溢出退场）。不写提示词正文；写怎么改、怎么验收。词以 `docs/CONTEXT.md` 为准。只约束上列工件。

黄金夹具（golden fixture）：一条固定输入 + 可判定轨迹。黄金集（golden set）：同一行为的一组夹具，跟被锁行为放在一起。

## 原则

1. **说明书不是闸。** 模型该做/不该做的，能用代码、schema、工具轨迹判定的，不要只写在 prompt 里。纪律句压不住的行为，加硬闸，不把 system 写长。
2. **短指令，深上下文按需。** System 是地图（身份、边界、有哪些工具），不是百科。本轮才需要的材料（retrieve 正文、**memory prefetch** 短行）放用户侧或 tool_result，不塞进常驻前缀。
3. **前缀要稳。** Identity / soul / **memory existence pointer** / 工具 schema 在一轮会话里字节级稳定。每轮变化的记忆、时间、命中列表不要写进这段前缀，否则缓存失效，模型也更容易盯着变来变去的书单。
4. **提示词是带版本的工件。** 改文案 = 新版本，带着同一套黄金集跑过才能当完成。禁止只在对话里改两句、看几眼输出就合。

## 三层装配（fin）

| 层          | 放什么                                                                                  | 变不变           |
| ----------- | --------------------------------------------------------------------------------------- | ---------------- |
| System 前缀 | agent identity、agent soul、usage、user profile、存在指针；语料清单 / 全库目录 不进这段 | 本会话内尽量不变 |
| 用户侧本轮  | **memory prefetch**（0–3 行索引）、本轮用户原文                                         | 每轮可变         |
| 工具结果    | retrieve / `read_file` / `memory_recall` 正文                                           | 按调用出现       |

记忆旁白不得当 citation。数字与档案主张只认 retrieve / `read_file` 轨迹 + citation verifier。

## 改提示词的流程

1. **先写夹具，再动文案。** 每个行为点一条黄金输入：期望的结构（JSON 字段）、期望的工具有/无、期望的预取行数。事故再出现，把那次输入收进集，禁止回归。
2. **硬闸先于软分。** 硬：JSON schema、预取 0/≤3、system 无全库目录、研究轨出现 retrieve、verifier 不吃记忆正文。软：LLM 裁判只打分，不能单独放行。
3. **抽取/梦境与对话模型分开评。** 抽取模型不能给自己的候选打「这次抽得好」。规则半截用假模型/夹具测；真模型只测「精华/否决」是否落到夹具标签上。
4. **一次改一个变量。** 同一 PR 不要同时换模型、换抽取 prompt、换预取帽。回归了才知道是哪一层。
5. **文案和闸同仓。** `buildExtractPrompt` 一类函数导出或固定字符串，测试断言关键纪律句仍在；否决类能 tokenize 重叠的走代码，不把唯一否决写在 prompt。

## 名册：哪些面有集、哪些是已登记缺口

**规则：黄金集跟被锁行为同放，不另开总柜文件夹；无集的面补集或登记缺口，不得只记 Not run。**

理由：集和它锁的文案同目录，改文案的人在同一处看见集；集中放会制造第二处要同步的地址。夹具路径写进下表即够，缺的是**登记**而不是**目录**。

**锁的三档**（避免把单测当集）：

- `STATIC` — 断言常量/子串仍在。
- `SEAM` — 断言注入/不注入、进不进 system、字节恒定。
- `轨迹集` — 固定输入 + 可判定首工具/轨迹。**只有这一档是黄金集。**

| 面               | SSOT 源                                                      | 锁                        | 集路径（轨迹集才有）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tool description | 各 `src/harness/aci/tools/*.ts`（graph / subagent 两件在外） | STATIC（D9 闸 + 各工具）  | 仅 web 两件与 run_graph 有轨迹集。`grep` / `read_file` / `edit_file` / `write_file` **登记不建**（D7：contract-statement 确定性，非工具选型分歧；由 D9 STATIC 锁 + schema 断言覆盖）。`grep` 另有 `feat/grep-wave-survive` 缺口：schema enum 加 `files_with_matches` 别名 + 失败文案改列合法值，纯值集扩展与更清楚的失败，无新分支 / 无工具选择分歧，轨迹集成本不抵收益。`todo_write` 已登记缺口（`feat/todo-write-mode-copy`）：description 分述四 mode + schema 字段 description 绑定（删除走 update、replace 只收 items），纯说明书改写，无新分支 / 无工具选择分歧，轨迹集成本不抵收益。 |
| web 发现 vs 阅读 | `web-search.ts` / `web-fetch.ts`                             | STATIC + 轨迹集           | `tests/harness/aci/tools/web-discover-vs-read.fixtures.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| graph 通知文     | `graph/notification.ts`                                      | STATIC + SEAM + 轨迹集    | `tests/harness/graph/graph-mode-notification.fixtures.ts`（SEAM 锁 = `graph-mode-presence.test.ts`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| graph 工具选型   | `graph/run-graph-tool.ts`                                    | STATIC + 轨迹集（同上集） | 同上集（G1 锁 run_graph 侧——两行共用一套夹具）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| soul / usage     | `identity/soul.ts` / `identity/usage.ts`                     | STATIC + SEAM             | **缺口**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 抽取 prompt      | `memory/ingest.ts`（`buildExtractPrompt`）                   | STATIC                    | **缺口**（纪律句有锁，行为无集）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 梦境 prompt      | `memory/dream.ts`                                            | 仅 cap                    | **缺口**（正文无锁）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| system 前缀装配  | `identity/assemble.ts`                                       | SEAM（序 + 字节恒定）     | n/a（装配由 SEAM 锁，无需轨迹集）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| tool schema      | `aci-registry.ts` / `build-engine.ts`                        | SEAM                      | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 溢出退场         | `aci/tool-overflow.ts`                                       | STATIC + SEAM             | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<agent_status>` | `agent-status.ts`                                            | STATIC + SEAM             | **缺口**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| MCP 重连通知     | `loop-engine.ts`                                             | STATIC + SEAM             | **缺口**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 记忆预取         | `memory/prefetch.ts`                                         | STATIC + SEAM             | **缺口**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 子代理 persona   | `subagent/worker.ts`                                         | SEAM                      | **缺口**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| skill 正文加载   | `aci/tools/skill.ts`                                         | STATIC + SEAM             | **缺口**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**缺口怎么处置（这是本表存在的理由）：** 碰到「缺口」行的面被改动时，两条路二选一，不得只记一条 Not run 就收工：

1. **补集** — 按本页流程先写夹具（离线 + 真模型半边），跑绿再改文案；集路径回填本表。
2. **登记不建** — 在改动 commit 正文写明「登记缺口：<面> 无轨迹集，理由是 <成本/无行为分歧>」，并在本行留痕。缺口就从「每次重新发现」变成「一次性结论」。

**Trajectory 集必须真跑模型。** 只跑离线半边 = 只证明夹具形状对（#960 的离线文件就是这么写的），首工具判定必须过 `npm run test:real-llm`。缺 key → 如实记 Not run，不得把离线绿当集绿。

## 记忆相关（与 ADR 0048 一致）

- 代码默认关自动抽取；本仓库项目 env 开，方便本地测评。过度注意黄金集是验收（招呼零预取；装配无全库书单/promote；抽取输出合法且否决类不入库；研究轨有数字必须 retrieve；库里有公司名仍搜档案；显式记住可跨线程），不是上电闸。
- 默认 pytest / citation contract 关记忆，即使 operator `.env` 开了也关，除非该用例就是测记忆。
- 显式 save / recall / 改 user profile 可先接线，不等这集。
- 改抽取或存在指针文案，必须重跑该集。
- Prefetch 是 DB 行投影，不是索引文件。

## 不要

- 靠加长 system 修过度注意。
- 用「多次 recall 进 system」当奖励。
- 把档案能答的内容写进记忆 prompt 当允许项。
- 无夹具改 prompt 后宣称完成。
