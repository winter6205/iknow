# Plan: trace-mcp-read-side-split — trace 读侧按轴拆开

**Goal:** 外部编码 agent 与进程内 agent 经三件 read-unit 化的工具（`list_sessions` / `query_trace` / `get_record`）逐级收窄地读本地 JSONL trace；一次调用只给「调用方指定位置的一页」，工具面不再有字符帽与静默降级。

**Approach:** 先落 spec 修订（T1 `[decision]`），再用 characterization 测把现役核钉住（T2），然后逐条垂直切片：治 P0 的静默降级（T3）→ 收 session-index / 序列化归属（T4）→ 逐面加 `list_sessions`（T5）、`get_record`（T6）→ 才瘦 `query_trace`（T7，破坏性，去处必须在前面）→ 修 mcp.json cwd 依赖（T8）。字符帽在 T6 随窗口机制整体退出工具面，改由 caller 指定的 read unit + MCP 侧 20000 backstop 承担。

不在本轮：`trace_fields`（`src/traceserver/fields.ts` 的 44 条列定义是面板渲染元数据）、任何 `fields:` 选字段参数、时间窗过滤（`TraceQuery` 至今无此轴）、代理 traceserver HTTP（`specs/trace-mcp-server.md` Assumption 1，理由今天仍成立）。

**票号约定：** markdown 列表号 = 票号（T1..T8）；`[blocks: X]` 读作「X 阻塞本票」。

**Spec link:** `specs/trace-mcp-server.md`（T1 修订它）；继承 ADR-0003 / ADR-0004 契约 X / ADR-0006 D6 / ADR-0020 / ADR-0036。

**ACR:** 五轮 PASS 5/5（详见「ACR 演进记录」）。

```
bounded-context-guardian:   yes — 数据装配归 src/traceserver/，wire 形状归各薄皮；无跨皮反向依赖
defensive-contract-validator: yes — 5 边界类 × 3 面覆盖分配成表，T2 先钉现状基线
error-handling-enforcer:    yes — 5 个 kind 各有归属票 + catch-arm 通则 + 前缀归属落 T5
complexity-anti-drift:      yes — 两处已存在的复制（session-index default / 信封字面量）由 T4 单点收编
minimal-change-verifier:    yes — 8 票各一 commit 一轴，破坏性收窄（T7）排在去处落地之后
OVERALL: PASS — hand to writing-plans
```

**Tracker:** GitHub issues main path（`origin` = `winter6205/iknow`，`gh` 已认证）。票单尚未建：建 issue 属对外可见动作，待操作员确认后按 T1→T8 顺序 `gh issue create --label 'ready-for-agent'` + GraphQL `addBlockedBy` 落边。在此之前本文件即 SSOT。

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch

## 待写入（全票合入后走 `domain-modeling`）

- 新词条 **read unit（读单元）**：工具级参数表达「读多少」的语义单位（行 / 条 / 字符窗），与 executor 的字符兜底正交。_Avoid_: 用输出字符帽当分页机制。
- 新词条 **window（窗口）**：`get_record` 中由调用方给的 `{message_index, part_index, from_char, count}` 坐标组；窗内数据是事实，不是截断声明。
- 新词条 **tool face / panel face**：同一 traceserver 数据的两种序列化归属——tool face（ACI + MCP）不带 `truncated`/`total`；panel face（`http.ts` → Web）保留 `total` 供分页显示。_Avoid_: 「MCP 版 / HTTP 版」这种按 transport 命名的说法。
- 澄清（非推翻）ADR-0004 契约 X 适用面：`docs/adr/0004-tool-layer-six-tool-set.md:23` 的措辞是「工具返回」，面板 JSON 不经 executor，故 `total` 在 panel face 合法。ACR 三轮裁定：`Resolution 3 is correct`。
- 陈旧注释纠正：`src/harness/aci/tools/registry.ts:183` 写「= 37 件名」，而 `tests/harness/aci/tools/registry.test.ts:211` 断言 **40**。以断言为准，注释随手更正。**（已随 T5b 落地：现 `registry.ts:186-187` 按 append-only 逐项算数，T6 后该测断言 42。）**
- 后续票（T6 实测根因，非本轮 Surface）：`tsconfig.json` 的 `exclude` 含 `tests`，`npm run typecheck` 因此**看不见测试**。后果不只是"测试无类型"——**src 删掉一个具名常量后，测试里那条 import 静默求值为 `undefined`，所有基于它的比较恒假**，测还是绿的。本票 6 红的真根因就是这个（`QUERY_TRACE_RESPONSE_CAP` 已删、`tests/traceserver/query-trace-core.test.ts` 仍 import 它），而不是断言值漂移。处置建议：加一条 `tsconfig.tests.json` + `npm run typecheck:tests`（只跑在 CI/pre-push，不进 pre-commit 以免拖慢），并先量一遍现存红量再决定收不收门。
- 类名纠正：`TraceQueryValidationError`（`src/traceserver/query-trace-errors.ts`）自 T5b 起是**读侧共用**的校验错误——`query_trace` 与 `list_sessions` 两条轴都抛它，ACI 薄皮的 catch arm 按 `instanceof` 认它、SC20 按 `kind` 计数。类名里的 `QueryTrace` 因此是误名，改名（含 `query-trace-errors.ts` 文件名）单独开票：T5b 只做加注释，不中途动判别名与其消息字符串面。
- 无 ADR reopen。`QUERY_TRACE_RESPONSE_CAP=4000` 退场是向 ADR-0006:22 收敛，不与任何已接受 ADR 冲突。

## 序列化与错误归属（全票共用，ACR 点名要求）

- **数据装配** 归 `src/traceserver/`；**wire 形状** 归各薄皮：
  - panel face：**形状的决定权**归面板（`{records,total,skipped_lines,truncated,offset}`，ADR-0020 面板语义不变）。T4 按本 plan 判据把 `http.ts` 里的两处字面量收进 `src/traceserver/envelope.ts` 的一处构造（`toResponseEnvelope` / `emptyResponseEnvelope`），此后两侧共享的只是「reader 结果 → 该形状」的映射，序列化各归各。→ **T7 约束**：tool face 摘掉 `total`/`truncated` 时形状开始分叉，必须**另立一个构造**，不得给 `toResponseEnvelope` 加「哪张皮」的开关（那等于把面别知识塞回数据装配层）。
  - tool face：`src/traceserver/` 内**唯一**一个 tool-page 序列化出口，ACI 与 MCP 两张皮都调它；输出 = records 数组 + 回显调用方给过的坐标。**原条款的「一行人类可读收窄提示」在本轮被实测否掉**（T5b 二轮 review）：契约 X 的 marker 归 executor（ADR-0004:23「自截断、自合成标记」），薄皮在 JSON 之后追加自由文本会让回显不再可解析、且与 executor 的标记并成两处权威 —— 收窄提示因此**不是** tool face 的输出项，spec §划界 已同步。
  - 工具 description 文案单一来源（现重复于 `src/harness/aci/tools/query-trace.ts:65` 与 `src/trace-mcp/server.ts:27`，后者还谎称有 4000 帽），受 `tests/harness/aci/tools/d9-description-guard.test.ts` 约束。
- **域内 typed error**（`src/traceserver/query-trace-errors.ts`，一律**不带**工具名前缀——前缀是薄皮的活；现状 `:9`/`:22` 硬编码 `query_trace: ` 且被 `query-trace.ts:104-107` 剥掉）：

| class | `kind` | 触发 | 归属票 |
|---|---|---|---|
| `TraceQueryValidationError` | `validation` | 参数非法（既有 kind，T3 使用；去前缀在 T5） | T3 / T5 |
| `TraceQueryRecordScanError` | `record_scan` | 扫描帽耗尽（既有，随下钻轴迁至 `get_record`） | T6 |
| `TraceRecordNotFoundError` | `record_not_found` | `record_id` 无命中（现为静默 `records:[]`） | T6 |
| `TraceWindowOverflowError` | `window_overflow` | 调用方给的窗越出该 part 末尾（`from_char + count > part_chars`；判据见第 14 条） | T6 |
| `TraceSessionNotFoundError` | `session_not_found` | 必填 `conversation_id` 在 `traceDir` 无对应文件 | T6（第 14 条：`get_record` 是第一个必填面）／T7 复用 |

- **前缀归属（ACR 五轮补）：** 核 error 消息**不带**工具名，前缀由每张薄皮自己加。现状 `query-trace-errors.ts:9`/`:22` 硬编码 `query_trace: `，而 ACI 包装类 `QueryTraceValidationError` 自己又加一次（故有 `stripQueryTracePrefix`，`query-trace.ts:104-107`）。**去前缀的动作落在 T5**（那张票是第一个往两张皮上加工具的票，Surface 已含两张皮），不落 T3——否则 T5/T6 期间 `list_sessions` 的报错会顶着 `query_trace:` 这个错名字。核去前缀后 `stripQueryTracePrefix` 即死代码，同票删除；MCP 薄皮（`server.ts:52-60` 现直接吐 `error.message`）必须自行前缀本工具名。
- `// EXIT:` 只标**真降级点**（blob 解引用失败、`query-trace-core.ts:333` 循环引用 fallback）。raise-site 不是 EXIT，别贴。
- **catch-arm 通则（ACR 四轮）：** 每引入一个新 kind 或一张新薄皮面，就必须有一条 ACI 映射测——`src/harness/aci/tools/query-trace.ts:47-60` 只认 2 个 kind，其余 `throw error` 原样上抛；MCP 薄皮的兜底 catch（`src/trace-mcp/server.ts:52`）会把这种泄漏显示成 `isError` 文本，**不算已处理**。`list_sessions` 面须映射 `TraceReadError`（`sessions.ts:113` 的 ENOENT→`[]` 除外，那是语义不是错误）。

## 边界类 × 三面 覆盖分配（per-SC map）

| 类 | `list_sessions`(T5) | `query_trace` 瘦(T7) | `get_record`(T6) | 另钉在 |
|---|---|---|---|---|
| empty | 空目录 / 无 `.jsonl` → `[]` 不抛（`sessions.ts:113` 既有语义） | 0 行会话、空文件 | 空 `messages`、`messages_captured:false` | T2 现状基线 |
| negative | `offset<0`、`limit=0` | 同（`parseInteger:200-219` 已守，扩到 `offset`） | `message_index=-1`、`from_char<0`、`count=0` | T3 |
| overflow | 会话数 > 一页 → 只丢尾 + 续取坐标 | 单行超帽不得删字段（`compactRecord:387` 退场） | 窗越出 part 末尾 → `window_overflow`，**断言零部分字节泄漏**（第 14 条） | T3 / T6 |
| concurrent | 写侧 append 期间取索引 | `isConcurrencySafe:true`（`query-trace.ts:97`）下并发查同一文件 | 同记录两窗并发 | T4 |
| exception | 非法目录 → 启动 exit≠0 | 非法参数 → `isError` 不崩；`session_not_found` 不崩 | blob `// EXIT:` 保留（假设 5） | T2 / T8 |

实测尺寸依据（12 个最大会话 / 982 条 llm_call / 165,991 条 message）：单 message p50=393 / p90=3,810 / p99=16,815 / max=70,558 字节；单 part p50=235 / p99=13,848 / max=43,174；整条 llm_call 行 p50=**188,910**。→ 任何固定字符帽都不可能对「一页摘要」和「一条全文」同时成立。

## ACR 演进记录

- 一轮 `BLOCKED 4/5`：defensive（核只有 1 个测）/ error-handling（错误类无 kind、前缀耦合）/ complexity（`sessions.ts:108` 与 `http.ts:257-285` 已被复制两份）/ minimal-change（20 文件跨 3 独立轴）。
- 二轮 `BLOCKED 4/5`，裁定两件事：① 契约 X 只管工具面，`total` 留 panel face 合法；② 「MCP 薄皮自带 backstop」当时**不成立**（`src/trace-mcp/server.ts` 无任何帽，4000 只活在待删的核里，删完外部 client 会裸吃 188,910 字节行）。四条 clearing artifact 全部指向「写出一份真计划文件」。
- 三轮 `BLOCKED 2/5`，均为**计划文件级**修法、非未决架构：T3 不得抛 T6 才存在的 kind（→ T3 收窄为只治「静默」、4000 留作文档化红线）；T3 的 Surface 不得含 transport 帽（→ backstop 移入 T6，那里 `src/trace-mcp` 已在 Surface 内）。另点名两处 graph hole：T5/T6 不可并行、`resume_offset` 与行 `offset` 的取代关系未命名。本文件已逐条并入。
- 四轮 `BLOCKED 1/5`（bounded-context / defensive / complexity / minimal-change 转 `yes`；error-handling 仍 `no`）：① T3 的 advice 去处 `detail=tool_results` 未被证明收得下——删 256 slice 会让预览长回 400，可能 advice 自环；② T6/T7 新增 3 个 kind 无 ACI catch arm 要求，MCP 兜底 catch 会掩盖泄漏。另点名计划漏列的下游字面量（`tests/trace-mcp/server.test.ts:45`、`startup.test.ts:90,122`）、一处陈旧行号（`findRecord` 实在 `:230`）、以及 T2「红灯基线」与自身 `EXIT 0` 的措辞矛盾。全部已并入本文件。四轮同时独立核到一条好消息：panel face（`http.ts:271-278`）直读 reader、从不进 `serializeResponse`，故 T3 改核不可能回归面板。
- 五轮 **PASS 5/5**（五维全 `yes`，`OVERALL: PASS — hand to writing-plans`），并独立确认 T4 Inherits 里我此前未自核的那条：`http.ts:257-285` 确实复制了最近会话默认（`:258-260` + 私有 helper `:203`，未从 `sessions.ts` 导出）与 5 键信封字面量两处（`:262-268`、`:279-285`）。它另留一条 plan-file 级 flag：核去前缀后没人义务薄皮补前缀，`stripQueryTracePrefix` 会成无主死代码 → 已并入（前缀搬迁落 T5，见「前缀归属」）。**闸门已过，T1 可开工。**

## 执行期前提修正（开工核实，2026-09-02）

写 T1 前逐条核了 plan 的 `file:LINE` 引用，绝大多数准确。四处偏差按实测修正，**不改判据方向、只改判据落点**：

1. **T5/T6 的下游字面量是 8 处，不是 5 处。** plan 原列 5 处准确（`registry.test.ts:211` `toHaveLength(40)`、`ensure-deps-aci-tools.test.ts:40`+`:130`、`build-engine.test.ts:59`、`server.test.ts:45`、`startup.test.ts:90,122`）。全仓检索另漏三处硬编码枚举，T5/T6 必须同批改：
   - `tests/harness/aci/tools/d9-description-guard.test.ts:245-246` — **两条** `toHaveLength(40)`（`ACI_TOOLSET_NAMES` 与 `reg.catalog.all()`）；该文件同时是 description 文案单源约束处（`:171` 派生对齐）。
   - `tests/tui/deps-tools.test.ts:96` — `EXPECTED_TOOLSET_30` 全量硬编码名单（`query_trace` 在 `:112`），`:142` 断 `toEqual([...EXPECTED_TOOLSET_30].sort())`。
   - `tests/subagent/worker-tool-surface.test.ts:111` — `WORKER_BASE_SURFACE` 是子代理 worker 的 **allow-list 基线**（含 `query_trace` 于 `:123`），`:249-250` 用 `assert.deepEqual(innerNames, [...WORKER_BASE_SURFACE])` 断**全等**。→ 这不是机械 +1，是**策略位**：往 registry 加件即扩子代理能力面。**裁定 = 纳入**（两件都是 read-only，与既在名单内的 `query_trace` 同门，排除它们会让 worker 能查 trace 却不能列会话／取全文，是更差的不对称）。该裁定写进 T5 测注释，不得当成一条意外回归「修掉」。注意 `:72` 的 `disallowedTools` 与 judge 侧 deny 都是派生的，不受影响。
   
   确认**安全**（从 `ACI_TOOLSET_NAMES` 派生、自动跟随）：`tests/harness/verify/judge-input.test.ts:106,245`、`tests/harness/verify/three-stage-flow.test.ts:1252`。`tests/harness/graph/run-graph-assembly.test.ts:113-116` 按下标锁定 idx 20/21/22/23 —— append-only 只动尾部，**只要不重排就不破**，T5/T6 保持 append。

   - **上列「8 处」不全：按「尾部追加即红」口径实测是 14 处（8 + 6），另有 2 处只失真不红。** 本清单逐条 `grep` 现核于 HEAD `19248392`，行号以本次为准：
     - 原 8 处不变（`registry.test.ts:211`、`d9-description-guard.test.ts:245`/`:246`、`ensure-deps-aci-tools.test.ts:40`+`:130`、`build-engine.test.ts:59`、`server.test.ts:45`、`startup.test.ts:90`/`:122`、`deps-tools.test.ts:96`/`:142`、`worker-tool-surface.test.ts:111`+`:249-250`）。
     - **plan 漏列、且确实会红的 6 处**（都是「取尾部/数尾部」断言，不是下标 pin）：`tests/harness/aci/tools/query-trace.test.ts:267`（`ACI_TOOLSET_NAMES.at(-1) === "safe_delete_symbol"`）、`:271`（`ACI_TOOLSET_NAMES.length - queryTraceIndex - 1 === 18` → 19）、`:277`（`registry.inner.list().at(-1)?.name === "safe_delete_symbol"`）、`tests/harness/graph/run-graph-assembly.test.ts:120-121`（**同一文件**取末元素，上面那句「只要不重排就不破」对它不成立）、`tests/harness/graph/run-graph-assembly.test.ts:165`（`names[names.length - 1]`）、`tests/harness/aci/bash-output-stop.test.ts:459`（`names.length === 40`）。
     - **只失真不红的 2 处**（改不改不影响绿，但不改就说谎）：`registry.test.ts:120` 与 `bash-output-stop.test.ts:456`/`:202` 的测名/注释里写死的「40 件」；另 `registry.test.ts:273` 的 `slice(35, 40)` 追加后仍只取到旧末 5 项 = 覆盖缺口（不红）。T5b 一并把措辞改真，不新开票。
     - 两处**无关的 40** 别误伤：`tests/harness/graph/progress.test.ts:89`（graph 节点数）、`tests/tui/rewind.test.ts:633`（label 字符长度）——与 registry 无关，不得顺手改。
2. **worktree 内 `trace/` 是空的（0 个 `.jsonl`）**，plan 的尺寸实测与复现记录 `2dff031d` 都住在主仓（`/home/winner/projects/iknow/trace/82967186-f249-4d64-ba7a-50286a5012cc.jsonl`）。→ T3 的 AC ⑤「复现记录走 `detail=tool_results` 在 4000 内成功返回」**不得**写成依赖开发者本地 trace 目录的测；改为在 `tests/traceserver/` 内构造同形状夹具（单条 llm_call、原始行 >4000 字节、多 messages + tool_result blob）。主仓那条记录可用于一次性人工核对量级，不进断言。这也顺带满足 CI 可复现。
3. **`OUTPUT_HARD_CAP`（`src/harness/tools/executor.ts:30`）是未导出的 `const`。** T6 的 MCP backstop「值 = 20000」**不能**靠 `import` 取——那会把 `harness/` 拖进 `src/trace-mcp/`，与假设 5「MCP 模块 transport only」和 SC12 相抵。落法：在 tool face 的序列化 owner 侧（`src/traceserver/`，非 harness）定义具名常量 `= 20_000`，注释指名「值取自 `src/harness/tools/executor.ts:30` 的 `OUTPUT_HARD_CAP`，同值是为不犯 ADR-0006:29 双层截断」，并配一条断言锁该数值 + 一条注释指向来源。两处同值靠断言锁，不靠 import 耦合。**该落法有仓库先例，不是新造**：`src/harness/aci/tools/web-fetch.ts:36`（`/** 与 executor OUTPUT_HARD_CAP / ADR-0006 对齐；本模块复制常量，不反向 import executor。 */ export const FETCH_OUTPUT_BUDGET = 20_000`）、`src/harness/memory/tools/recall.ts:32`（`const OUTPUT_HARD_CAP = 20_000` 作 self-floor）、`src/harness/aci/tools/tool-search.ts:70`（「镜像 `tools/executor.ts` 的 OUTPUT_HARD_CAP」）三处都是「工具侧自带同值常数 + 注释指名来源」，T6 沿用即可。
4. **T3 的 AC④/⑤ 前提被实测证伪，本票形状按下方裁定改。** 原 AC④ 是「单条记录下钻超容 → 抛既有 `validation` kind，消息指名去处 `detail=tool_results`」，AC⑤ 要求证明该去处真能收。两条都不成立：

   - **逃生口本身走的是同一条静默路径。** `detail:"tool_results"` 与列表页共用 `serializeResponse` → `compactRecord`，而 `compactRecord` 的丢法是「`typeof value` 既非 string/number/boolean/null 且 key 非 `error` → **整字段删除**」，`tool_results` 是数组，故它不是被裁短，是**整个消失**。且 `:308` 的早返让 `detail:"messages"` 直接返回**原始行**（连 `messages_count` 都没有）。按条**推导**（非实跑测量）：`TOOL_RESULT_PREVIEW_CAP=400` 字符 + JSON 键与转义开销 ≈ 483 B/条，固定信封 ≈ 218 B，于是 N=7 恰好装得下（≈3,599）、N=8 就破（≈4,082）；复现记录有 31 条 messages。交叉点的具体数值不影响本裁定——「每条常数 × 无上界的 N 必然发散」这一条就足够否证。故「改 `detail=tool_results` 就收得下」是一句假建议，正是 ACR 四轮担心的 advice 自环。
   - **plan 预授权的退路会自我否定。** 退路写的是「截断收敛在 preview 那一层（唯一 owner = `project-tool-results.ts`）」。但 `TOOL_RESULT_PREVIEW_CAP=400` 是**每条**常量，N 无上界（可到 `limit`），**没有任何固定值能让任意 N 都落进 4000**；要成立只能把它改成随 N 收缩的聚合预算——那等于在下一层重新引入静默截断，直接违反本票自己的 P0「下钻不再静默丢字段」。故退路不可用。

   **裁定（四选一里唯一同时诚实又有用的）**：在 4000 这条字符线之内，「任意大的单条记录」只有三种结局——静默截断（违反 P0）、抛错（把「读一条大记录」这个下钻存在的唯一理由堵死）、给假建议（自环）。三者皆劣，故 **T3 对单条下钻既不截也不抛：列表页仍按整条记录从尾收窄到 4000 内（诚实信号 = `records.length < limit`），而 `record_id` 下钻命中的那一条记录整条原样返回，`src/traceserver` 侧不新增任何帽**。overshoot 只在 MCP 面成立到 T6 之间，且 T3→T6 是同分支同 PR、中途不 push 不 merge，无交付物会带这个洞；ACI 面由 executor 的 20000 + marker 兜（契约 X 权威所在，正是 ADR-0006:29 要的收敛方向）。T3 的测必须把这条形状**钉死**（单条超大记录返回体字节数 > 4000 且字段完整），使 T6 改动是相对一条已钉期望被审，而非自由发挥。ADR 三轮「本票不碰 transport 侧的帽」的约束**照旧遵守**——本裁定恰恰是不在 core 加帽、也不动 transport。


5. **T3 落地后残留四处「4000」声称，其中三处原本无票认领，现全部划归 T6。** T3 按第 4 条裁定让单条下钻故意越帽之后，这几处继续宣称有 4000 帽就成了假话（假话正是本轮要消灭的东西）：
   - `src/harness/aci/tools/query-trace.ts:65` — description 里的「Results are capped at 4000 characters」。plan 原只在第 42 行把它当作「文案重复」的 SSOT 素材记着，`:138` 却只点名了 MCP 侧那一句，**ACI 侧这一句漏了归属** → 归 T6 随 SSOT 文案一并改真值。
   - `src/trace-mcp/server.ts:27` — 同一句假称，`:138` 已认领，不变。
   - `tests/harness/aci/tools/query-trace.test.ts:135` 与 `tests/trace-mcp/server.test.ts:64` — 两处对小夹具断 `length <= 4_000`，且测名叫「caps the response」一类。夹具小 → 今天照绿，但它们**认证的正是核心已不再提供的保证**；T6 必须把断言改成它真正想钉的东西（越帽单条整发返回 / backstop 生效），而不是留着一条恒真的帽断言。
   - **T3 → T6 之间这几条测是「绿色但不再有意义」**：读到绿不代表 4000 仍然成立，不得据此判 T3 回归。T3 的 commit 正文已声明这一点，T6 复核时以本条为准。
6. **`npm test` 的基线本身是破的（开工前即存在，与本轮三票无关），故每票验证门不能写成「`npm test` 全绿」。** 实测：主仓 master `b99492f2`（干净工作树）与本分支 HEAD `b71cb9c3`（T3 未落地）跑同 5 文件，**均**为 `Tests 32 failed | 34 passed`、`Test Files 5 failed`，逐条同签名。

   - 抛点 = `src/harness/memory/refresh.ts:64` 的 `findProjectAgents(ctx.projectIdentityRoot)`，报 `TypeError: The "path" argument must be of type string. Received undefined`；夹具 `tests/harness/memory/refresh.test.ts:21` 的 `makeContext()` 只返回 `{cwd, userHome, memoryDir}`，`projectIdentityRoot` 从未被供。即 #861/#862 那段改名（`66469c0b` → `a893bae5` → `b99492f2`）动了 src 侧没动 test 侧。
   - `npm run typecheck` 在主仓 master 上 exit 0，掩盖了它：`tsconfig.json` 的 `exclude` 含 `"tests"`，`tsc --listFiles` 对该夹具 0 命中——**typecheck 从不看测试文件**，所以「typecheck 绿」不构成测试侧契约的证据。
   - `grep -rn "traceserver" src/harness/memory/ src/harness/identity/` 无命中，这两个子系统不依赖本轮改的模块，因果上也不可能是 T1–T3 引入。
   - **门改为**：`npm test` 的失败集与上述基线**逐文件同构**（仍是这 5 文件这 32 例，不增不减），且 `tests/traceserver/`、`tests/harness/aci/tools/query-trace.test.ts`、`tests/trace-mcp/` 全绿。该破损超出本轮 Surface（read side），不并入任何 T 票，单独报给 operator。

7. **T4 的「最近会话推导只有一个 owner」判据范围是 `src/`，不含 `web/`。** `web/src/lib/trace-entry.ts:38` 另有一份浏览器端「取最近会话」，与 `src/traceserver/sessions.ts` 的 `newestConversationId` 行为等价（V8 排序稳定 ⇒ 并列 mtime 时胜出者相同），且面板前端不在本票 Surface（`src/traceserver` 含 `http.ts`）内。不改、不并票，记此以免日后把「一个 owner」说成全仓事实。

8. **T5 Inherits 里的「2 条」是单文件巧合数，不是全仓会话根记录数——判据要钉在机制上。** 原句「`trace/` 有 81 个 `.jsonl`，`record_type=session` 只返回 **2** 条」把两个量纲并列，读起来像「81 个文件里只有 2 条有根记录」，实测不是：`/home/winner/projects/iknow/trace/` 现有 **81** 个 `.jsonl`，共 **120** 条 `record_type=session` 行，分布在 **53** 个文件里，**28** 个文件一条都没有。那个「2」的真正来历是 `query-trace-core.ts:79-87` 只读**一个**文件（`conversation_id ?? newestConversationId`），而最新那个文件恰好有 2 条——即 `query_trace` 结构上看不到另外 80 个文件，与根记录稀不稀无关。
   - 机制断言（这才是 `list_sessions` 存在的依据，且已在源码核到）：`recordSession` 只在 `src/harness/trace/jsonl.ts:267-282` 写，唯一调用点是 `src/harness/loop-engine.ts:2149-2158` 的 run 终态分支，故会话根记录永远是文件**最后一行**；crash / abort 路径不写 ⇒ 那 28 个文件永远没有根记录。`listSessions`（`sessions.ts:108`，readdir+stat、不读正文）两类都能发现：既覆盖 80 个「看不见」的文件，也覆盖 28 个「没有根记录」的文件。
   - **T5b 的测因此断在机制上**：夹具里放一个**无根记录**的 `.jsonl`（模拟 crash / 进行中），断 `list_sessions` 仍列出它且 `agent_version` 缺席；不要断「2」这个数字，也不要拿真实 `trace/` 目录当夹具。
   - 另记 `agent_version` 的线上形状：`sessions.ts:48-61/:73-97` 用一次 64KiB 有界 pread 取根记录，取不到时该字段**整个缺席**（不是 `null`、不是 `undefined` 值），`SessionSummary`（`:29-34`）因此是可选键。面板侧线形状是 `{ sessions: SessionSummary[] }`（`http.ts:211-219`），`list_sessions` 的 tool face 输出不要求同形（两张皮各管自己的 wire 形状），但字段名沿用 snake_case 与 `SessionSummary` 的四个键。

9. **第 6 条的门有一个覆盖洞：`npm test` 的第二半从来没跑过，而 `tests/tui/**` 里确有一处工具枚举止。** `package.json:27` 的 `test` = `vitest run && $HOME/.bun/bin/bun test tests/tui/`，`vitest.config.ts:22` 显式 `exclude: ["tests/tui/**"]`（#251 D2 裁决：OpenTUI 原生 FFI 只在 bun 下可跑，故 TUI 由 `bun:test` 驱动）。**`&&` 是短路**：本轮基线 vitest 破着（第 6 条那 32 例），所以 bun 那一半自开工起一次都没执行过，「失败集与基线逐文件同构」这句话此前只覆盖了 vitest 侧。
   - 实测（本分支 HEAD `19248392`，一次完整跑）：`bun test tests/tui/` = `14 fail | 1132 pass`，70 文件。绝大多数是 TUI 渲染/时序类（`/thinking` picker、`TUI pending NL`、`TuiApp /info`、`bracketed paste`、`createTuiBridge` verify DTO 等），一次跑不能判其稳定与否，本轮**不**据此断言它们是 pre-existing。
   - 唯一核到的一处例外，且与工具枚举直接相关：`tests/tui/deps-tools.test.ts:142`（`EXPECTED_TOOLSET_30` 仍列 10 个已退役的 `lsp_*`、缺 10 个现役 symbol 工具）。**已在主仓干净 `master` 上单独复跑，同签名同 1 fail / 5 pass** ⇒ 与本轮无关，属 #861/#862 那批退役/复原的账。第 1 条把它列进 T5/T6 下游字面量清单是**准确的（会受影响）但当前已经红**，T5b 不得顺手修它（超出 Surface，且修它是改一份早就与装配脱节的名单，需要单独判据）。
   - **T5b 的门因此在 vitest 之外加一条**：`$HOME/.bun/bin/bun test tests/tui/deps-tools.test.ts`，判据 = 仍是这 1 fail / 5 pass，不新增。整目录的 `bun test tests/tui/` 不在每票门内（4 分钟且时序敏感），留到整轮收尾跑一次并如实报数。

10. **T5 拆成 T5a / T5b（本条即定义处——此前「T5b」只在本文件被引用、从未被定义，全仓 `grep -rn "T5a"` 零命中）。** 拆票理由：前缀搬迁与 `list_sessions` 上架是两个 logical task（1 commit = 1 logical task），且 T5 的 AC 末句「本票兼任前缀搬迁」若与加件同批，则任何一侧红都说不清是谁的账。
    - **T5a（本 commit）＝ 前缀搬迁**：核两条域内 error 去工具名（`query-trace-errors.ts`）、两张皮各自加本工具名前缀、删 `stripQueryTracePrefix`、T2 留的 flip-site 面包屑按新契约改写。ACI 面对 caller **零变化**是构造性推论（旧路径 = 核出 `query_trace: <msg>` → strip 掉 → wrapper 再加回；新路径 = 核出 `<msg>` → wrapper 加一次，两式同值），测钉的是**终态全文**（两处 `===` 精确断言），不是「前后相等」这个命题本身。MCP 面则相反：现状 catch 完全不加前缀、纯靠核，搬迁后该面**必然**多出前缀，故 T5a 对 MCP 面不是零变化，而是一条新契约（`tests/trace-mcp/server.test.ts` 新测即其判据）。
    - **T5b ＝ `list_sessions` 上两张皮**：T5 AC 的其余全部条款（tools/list 含这件、mtime 倒序、caller `limit`/`offset`、四个字段、无截断元字段、14 处下游字面量、`TraceReadError` 映射）+ **SC16 的后半句因此票才可能成立**。SC16（`specs/trace-mcp-server.md:108`）要求「`list_sessions` 的校验错误在两张皮里都显示为 `list_sessions: …`」——`list_sessions` 不存在时该断言写不出来，故 **SC16 在 T5a 后处于「机制就位、判据未闭合」态，不得据此判 SC16 已交付**。
    - **两张皮各有两条 caller 可见错误路径，形状不同，别写成一条断言。** MCP 面：(i) 过了 zod、由核拒 → 走薄皮 catch，形状 = `query_trace: <核消息>`（T5a 已钉，`tests/trace-mcp/server.test.ts` 新测用 `conversation_id: "a/b"` 专打这条，因为 `limit: 0` 根本进不来）；(ii) zod 在进入薄皮 catch **之前**拒 → SDK 自己出文案，实测（一次性探针，跑完即删）= `Input validation error: Invalid arguments for tool query_trace: limit: Too small: expected number to be >=1`，`isError: true`。
      - 结论：路径 (ii) **不违反** SC16——它已经点了正确的工具名，只是形状是 `... for tool <name>: ...` 而非 `<name>: ...`。但 **T5b 若照 SC16 字面写 `^list_sessions: ` 断言，在 (ii) 上必红**，因为那条不经本皮。T5b 的负例测要么显式只打 (i)（夹具避开 zod 已守的界），要么把两条路径分别按各自形状钉死。**不得**为了「一条断言通吃」去放宽 zod schema 或在 SDK 文案上叠前缀。
      - 由此引出一个 T5b 的真问题（本票不解，记为待决）：`limit`/`offset` 的界在 zod 与核里**各写一遍**，即 plan 第 62 行 negative 行的 `offset<0`/`limit=0` 落在哪条路径上取决于 zod 先拒还是核先拒。单一校验权威若要成立，去处是 zod 只做类型、界交给核——但那与「两张皮参数面逐项一致」（T7 AC）有张力，T5b 开工前须先定。

11. **T5b 开工前把第 10 行末的待决测掉了，结论是「界保留在两张皮各自声明、核只做复查」，且 SC16 的前缀断言因此不能走校验错误。** 两条实测（一次性探针，跑完即删）：
    - **界不需要在 zod 与核之间二选一。** ACI 面的 `inputSchema` **不是文档**：`src/harness/tools/registry.ts:64` 用 ajv 编译它，`src/harness/tools/executor.ts:218` 在 handler 之前按它拒（`list_sessions` 的测里直接调 `reg.inner.getValidator("list_sessions")` 证了 `limit:0` / `offset:-1` 为 `false`）。MCP 面的 zod 同样先于薄皮 catch 执行。所以「zod 只做类型、界交给核」这个去处是**假选项**：核永远不会先于任一薄皮看到越界。SC18 要的「逐项一致」是两份 schema 的**声明一致**（一条 diff 断言可比对），不是校验点位单一。T5b 因此照 `query_trace` 既有形态做：两张皮各自声明同样的界，核 `parseInteger` 作第二道权威（抽到 `src/traceserver/parse-integer.ts` 共用，消息逐字一致）。
    - **`list_sessions` 没有可达的核校验路径，SC16 只能钉在 IO 路上。** 实测 zod v4 的 `.int()` 走 **safe-integer** 语义（`9007199254740992` 被拒，`Number.isInteger` 却为 true），且 `offset` 只有下界、核的 `maximum` 默认 `Number.MAX_SAFE_INTEGER`——核能拒的 zod 全先拒了。`query_trace` 有 (i) 路可打是因为 `conversation_id` 有 zod 未声明的规则（路径分隔符）；目录轴两个参数都是纯整数界，**没有这条缝**。故 T5b 把 SC16 钉在 `TraceReadError` 上：traceDir 指向一个**普通文件** → 实测 `trace file read failed: ENOTDIR`（不需 root、不需 chmod，CI 安全），两张皮同一路径都出 `list_sessions: ` 前缀；缺失目录 → `[]`（语义不是错误，plan 第 55 行已排）。zod 拒绝路另钉一条，按 SDK 实测文案原样锁（`Input validation error: Invalid arguments for tool list_sessions: limit: Too small: expected number to be >=1` / `Too big: ... <=200`），**不得**为通吃放宽 schema 或给 SDK 文案叠前缀。
    - **附带一条会让测假绿的量具事实：本机 ext4 的 `readdirSync` 返回名字升序**——临时夹具与真实 `/home/winner/projects/iknow/trace/`（81 个 `.jsonl`）三次采样都是升序。于是「并列 mtime 时按 `conversation_id` 升序」这条 tie-break **在任何真实 fs 测上都不可伪**：期望序与 readdir 序重合，删掉比较式的分支测照样绿。`sessionsByRecency` 保留该分支（别的文件系统不保证有序），但 `list-sessions-core.test.ts` 那条稳定性测只钉「同一请求重复调用返回同页」，注释已写明它不兜 tie-break，别把后者当已验证判据。

12. **T5b 收尾两轴 review 改掉了五处，其中前两处是我自己此前写下的错判，记此以免日后被「复原成看起来更严的形状」。** 每条都有 mutation probe 证据（改动前该断言必红、改动后绿），这里只留结论与依据。

    - **tool face 必须回显坐标；「信封只含 `sessions`」是错判。** T5b 早版把期望写成单键 `{ sessions }`，注释理由是「契约 X 禁截断元字段 ⇒ 索性什么都不回显」。理由不成立：契约 X（ADR-0004:23 / spec SC7）禁的是 `truncated`/`total`/`response_truncated` 这三个**自填的截断元字段**，而第 42 行对 tool face 的定义里「回显调用方给过的坐标」是**正面要求**，第 64 行 overflow 格的「只丢尾 + 续取坐标」和 T7 的续取判据都吃它。信封因此为 `{ sessions, limit, offset }`（`ListSessionsPage`），分页测从回显算 `resume = offset + sessions.length` 再续页，不把 `limit` 写死在测里。
    - **`agent_version` absent 不指示会话是否结束——描述文案此前是假的（本轮唯一 High）。** 根记录读取走 `readBounded` 的**首 64 KiB pread**，而根记录在 run **末尾**落盘（`jsonl.ts:267-282`）⇒ 文件 > 64 KiB 的**已正常结束**会话同样取不到根记录；实测主仓 `trace/` 的 81 个会话里 **17 个**如此。已改：description 明写读窗口只有首 64 KiB、absent 有两种成因（未结束 / 根在窗口外）且 absent 不指示是否结束；`sessions.ts` 文件头与 `readBounded` doc 里「几乎必然在前缀内」一类声称同步改真；加一条 >64 KiB 带根记录的夹具测钉**机制**（断 `size > 65536` + 文件内确有 `"record_type":"session"` 行 + 字段仍 absent）。真正的修法（读尾部）本票**不做**：尾部读取会同时改变 inspect panel 的输出，而 panel face 被 SC15 冻结（`http.ts` 逐字节不动）→ 归后续票。
    - **MCP 面故意不带 `kind`——本条即 `src/trace-mcp/server.ts:57-59` 那句「记为后续票」的落点。** ACI 面有 `ToolExecutionError.kind` 结构化通道，MCP 面没有对应物；把 kind 拼进 text 会改掉 SC16 钉住的 `<tool>: <msg>` 形状。消掉这条偏差需要给 MCP 侧引入 `structuredContent` 或另定前缀格式，超出本轮 read-side split 的 Surface。
    - **三处 dedup 提前做（rule of three 在 T6 到达）：** `server.ts` 三个 `registerTool` 的 catch 同形 → 抽 `readOnlyToolHandler(toolName, core)`，T6 的 `get_record` 直接复用；`registry.ts` 的 `opts.traceDir ?? process.env.IKNOW_TRACE_OUT ?? join(workspaceRoot, "trace")` 出现两次 → 抽 `traceReadDir()`，env 读取点位不变（写成闭包只是为了**不**提前到模块加载期，见第 13 条）；`parseInteger` 已在 T5b 主体抽至 `src/traceserver/parse-integer.ts`。
    - **SC18 本票只交付 `list_sessions` 一件**：新增一条 cross-face 参数面 diff 测（属性集合 + `additionalProperties: false` + 逐属性 type/minimum/maximum；两处合法 delta 在注释点名——ACI 独有的 `default`、zod 未写 `maximum` 时的隐式 `Number.MAX_SAFE_INTEGER`）。三件工具的完整 diff 仍是 T7 判据，**不得**据此判 SC18 已闭合。
    - 另两处注释订正（不改行为）：`tests/traceserver/sessions.test.ts` 的 tie-break 注释按第 11 条的实测改写（该用例真正可伪的范围在第 13 条被进一步收窄，以第 13 条为准）；`tests/harness/aci/tools/d9-description-guard.test.ts` 里「full 31-tool toolset」的声称随 registry 增长失效，改为不计数量的表述。

13. **T5b 的第二轮两轴 review（整改后复检）＝ Standards 0 High/5 Medium/4 Low、Spec 0 High/3 Medium/5 Low，门 = PASS；本轮新增三条测量级事实，其中一条反证了 reviewer 的一条 finding。** 逐条与去处：

    - **ACI 面的 schema 门前拒文案根本不含工具名**（实测 `src/harness/tools/executor.ts:316-321` 的 `formatAjvError` + `src/harness/tools/tool-result.ts:42` 的 `[validation_failed] ${message}` ⇒ caller 看到 `[validation_failed] invalid input at /limit: must be >= 1`）。这纠正了「第 10/11 条路径 (ii) 已经点了正确的工具名」的可推广读法——那句只对 **MCP/zod** 成立。该形状对全部现役工具同形，改它超出本轮 read-side Surface 且 blast radius = 41 件工具，因此**不收进本轮**；处置 = 把 SC16 的前缀主张**收窄到「经薄皮 catch arm 出出的错误」**（已改 `specs/trace-mcp-server.md` SC16），ACI 那条 `(SC16)` 测的注释同时写明它钉的是哪条路。是否给 executor 的 validation 文案加工具名，报 operator 另判。
    - **§序列化里「一行人类可读收窄提示」这项正面要求被撤**（同一处 spec §划界 同步）：契约 X 的 marker 按 ADR-0004:23 是 **executor** 自合成的，薄皮在 JSON 之后追加自由文本会让回显不再可解析、并与 executor 标记并成两处权威。tool face 因此只发「数组 + 回显坐标」，到底信号仍是隐式的 `length < limit`。spec:28 与 plan:42 此前互斥（一个要求、一个不提供），现两处一致。
    - **满页与帽的实测**：摘要条目 ≈141 B（UUID id + `agent_version` 都在的夹具，一次性探针，跑完即删）⇒ 默认 100 条 ≈14.1 KB、上限 200 条 ≈28.3 KB > 20000。缺省页在帽内，故默认路径不受影响；帽与本轴的界一次对齐归 **T6**（同票落 MCP 面具名 backstop），数字已写进 `list-sessions-core.ts` 常量 doc。**订正（T6）：这个 ≈141 B/条在同一份真实目录上复现不出来（实测最宽 124 字符），单位也记错了——帽按 `text.length` 计，是字符不是字节。以第 14 条的复测值为准。**
    - **残留不实注释按同一标准一并改真**（都不改行为）：`listSessions` 「不读正文」/ 测头 "never reads file bodies"（它对每个文件做首 64 KiB pread）、`statSync` bullet 的「列表不读内容」、`parseInput` 的「界值都取自本文件的常量」（下界是三处字面量）、`registry.ts` 的「env 读取时机留在 factory 调用时，**不是** registry 构造时」（factory 就在构造期被调用，闭包只排除模块加载期）、`newestConversationId` doc 把并列规则指向 `http.test.ts`（真正 pin 在 `sessions.test.ts:418`）。`docs/trace-mcp-server.md:3` 的单工具声称（本轮变两件）本票顺手改真——它此前无票认领，T8 的 AC 也不覆盖这句。
    - **测力三处**：description 守卫加两条**短语级**正面锁（`/absent in two cases/`、`/says nothing about whether the session finished/`）与一条只禁 `absent … means … crash|running` 这一种句式的反向断言（改写文案须连测一起改，是有意的摩擦；它兜不住所有暗示法，注释已写明）；tie-break 用例的注释按实况收窄（本机 readdir 升序 ⇒ 缺 tie-break 与 mtime 反向都不可伪，唯一可伪的是名字降序比较式），并补一条**不依赖 readdir** 的码点 vs ICU 断言（并列 mtime 的 `B`/`a` 必须给 `["B","a"]`，`localeCompare` 会翻）；「不改动 `listSessions` 原序」用例原先 `raw.map(...).sort()` 把顺序信息抹掉、对所称意图不可伪，改为在排序调用**之后**断 `raw` 仍是 readdir 原序。两条新测都过了 mutation 探针：把比较式换成 `localeCompare` → 只有 tie 用例红；让 `listSessions` 自己排序 → 只有改写后的那条红。
    - **一条被反证的 finding（记此以免重复报）**：reviewer 称 SC18 只在 ACI 声明 `maximum` 时比对、下界漂移无人钉。实测 `minimum` 是**无条件**比对的（`tests/trace-mcp/server.test.ts:346`），且把 zod 的 `offset.min(0)` 改成 `min(1)` 后该测确实红 —— 一次性 mutation 探针，跑完 md5 复原。`if ("maximum" in aciField)` 那个守卫只管上界，是 zod 给 `.int()` 附送隐式 `Number.MAX_SAFE_INTEGER` 的合法 delta。
    - **本轮不做的两项，各有具名去处**：跨面 wire 断言（契约 X 禁用子串 + 键集合）目前只重复两处，按 rule of three 等 **T6/T7** 出现第三处再抽 helper；spec 里 tool face 「records 数组」应按轴实名、以及「回显调用方**给过**的坐标」实为**生效值**（缺省也物化），连同 SC15「只有一个 owner」在并列规则上已是两份比较式（合并即改面板缺省）这三处措辞，一并留给轮末 spec 同步。

14. **T6 开工前把 `get_record` 的窗口契约钉成文本——原计划有三处按字面不可实现或单位不实，实现期本条自己写的一处尺寸声称又被实测反证，两类订正都在此，实现以本条为准。**

    - **`window_overflow` 的触发（订正边界类表 overflow 格「单 part > `count`」那句）。** 照字面实现会让分页死掉：`count` 小于 part 即报错 ⇒ 任何大于默认窗的 part 永远读不到，`from_char` 续取形同虚设，part 超过 `GET_RECORD_MAX_COUNT` 时更是无解。生效契约 = **窗必须整个落在 part 内**：`from_char + count <= part_chars` 才成功，且**成功调用必恰好返回 `count` 个字符**（`count` 因此是真正的 read unit：要读多少**正文**可事前预算，响应大小不可，见下面 `count` 那条）。越界 ⇒ `TraceWindowOverflowError`，消息带 `part_chars` 与剩余量、**不回传任何 part 字节**——「零部分字节泄漏」针对的正是「顺手 `slice` 一页给你」这个自然错法。代价是末页须按 `part_chars - from_char` 收窄 `count`、多一次往返；换来的是**核这一层**永不产 JSON 之外的半截文本（要么恰好 `count` 字符，要么 `window_overflow`）。至于「这样本轴就永不越过后述 backstop」——该推论不成立，见下面 `count` 那条的尺寸订正。
    - **单位是字符不是字节（订正「字节窗」这一轴名措辞）。** 读侧所有字符数都按 UTF-16 code unit 计（`.length` / `.slice`：`preview`、`TOOL_RESULT_PREVIEW_CAP`、executor 的 `OUTPUT_HARD_CAP` 全是），本轴沿用同一单位、不另立第二套权威。后果须写进 doc 并有一条夹具测钉住：窗边界可落在代理对中间，`JSON.stringify` 会转义出孤立代理码元。
    - **`session_not_found` 的归属从 T7 前移到 T6（订正 typed-error 表该行）。** `get_record` 是第一个 `conversation_id` 必填的工具（假设 4 不许新面再引入「缺省 = 最近会话」），而「会话文件不存在」若复用 `record_not_found`，就把「会话查无」误标成「记录查无」——那条记录可能存在，只是根本没去看。故 T6 落 `TraceSessionNotFoundError`，T7 在 `query_trace` 复用。SC20 的五条 ACI 映射测里 T6 交 4 条（`validation` 已有，补 `record_scan` / `record_not_found` / `window_overflow` / `session_not_found`）。
    - **一次调用只给一种东西：清单臂或窗臂，由 `part_index` 的有无区分。** 清单臂 = record 标量 + 每个可寻址 part 的 `{part_index, chars}`（`detail=tool_results` 另带 `tool_use_id`/`name`/`is_error`），无正文；窗臂 = record 标量 + **具名命中的 id 轴** + 回显生效坐标 `{detail, message_index, part_index, from_char, count}` + `part_chars` + `text`。不给信封加「哪种臂」的开关参数（与 §序列化 对 `toResponseEnvelope` 的 T7 裁定同形）。`detail=messages` 的窗臂必须同时给 `message_index`（缺 ⇒ `validation`，不静默当 0）；`detail=tool_results` 的 `part_index` 数的是投影后的结果序，`message_index` 传入即 `validation` 拒——**参与寻址的坐标必须被回答，不被使用的坐标必须被拒**，不允许静默忽略。
    - **`count` 的界取自本 plan 的尺寸基准；「本轴永不触 backstop」被实测反证，撤。** `GET_RECORD_DEFAULT_COUNT = 400`（message p50=393）；`GET_RECORD_MAX_COUNT = 16_000` 的理由只剩 part 分布那一条（part p99=13,848 一窗装得下，part max=43,174 需 3 窗）。原先并置的第二句「16,000 + 回显与标量开销 < 20,000」在主仓 `trace/` 上量了两个独立的尺寸来源，两条都把它推翻：

        - `record` 标量投影（`projectRecordBase`，已丢 `messages` / `raw`）序列化后 **p50=414 / p99=739 / p99.9=1143 / max=6025**（5,546 条记录；唯一越 4,000 的是 1 条 `subagent_stop`，其余 record_type 的 max 都 ≤813）。16,000 + 6,025 已 > 20,000。
        - `text` 经 `JSON.stringify` 的转义膨胀比（27,148 条 ≥1,000 字符的真实正文）：**p50=1.052 / p99=1.206 / max=1.295** ⇒ 16,000 字符的窗光正文就能序列化到 20,720，与标量无关地越帽。

      于是生效表述改成：**`count` 约束 read unit（正文字符数），不约束响应大小**，且**没有任何 `count` 上界能证明响应不越帽**（比率可任意接近 2：全引号正文）。越帽时截断仍只发生一层，在 face 上（MCP `applyTraceOutputBackstop` / ACI executor 帽，同值 20,000），核自己永不裁。`GET_RECORD_DESCRIPTION` 里「A window returns exactly count characters」是**核**的主张，SC7 不许文案出现字符帽表述，故不在文案里给这句加免责——越帽时的可见信号是 face 的 `...[truncated]` marker。
    - **越帽时的可恢复性依赖响应键序，本票须有测（新增判据）。** `windowOf` 的返回对象把 `text` 放在**最后一个键**，face 的尾部切片因此只切正文，`record` / `matched_on` / `part_chars` / `from_char` / `count` 留在原位——调用方看到 marker 就能直接把 `count` 改小重发，不必重新寻址。这是顺序依赖，重排键序即失效 ⇒ 钉一条测（越帽夹具断 `Object.keys` 末位是 `text`，且经 backstop 后的字符串里坐标字段仍完整可见）。真实数据侧的量测（主仓最大 6 个会话全扫）：最大可寻址 part = 20,000 字符（会话 `8840c126…` / record `c745229a…` / `part_index=10`，标量投影 429 字符），取 `count=16000` 的窗序列化后 **17,372** 字符（该窗转义比率 1.05 ⇒ 未越帽），`Object.keys(...).at(-1) === "text"` 同批确认。所以越帽不是「满窗必然发生」而是**取决于窗内正文的转义密度**（1.05 不越、1.30 越），这既解释了为什么默认路径不受影响，也解释了为什么键序仍必须有测钉住。
    - **backstop 与本轴一次对齐（第 13 条派给 T6 的活）。** 新文件 `src/traceserver/output-backstop.ts` 定义具名常量 `TRACE_OUTPUT_BACKSTOP = 20_000`，注释指名来源 `src/harness/tools/executor.ts:30`，**不** import `harness/`（假设 5）；配一条锁值断言（测里可比对 executor 侧字面值）。MCP 三件工具共用一个 backstop：`text.length > 20000` ⇒ 切片后加 marker，marker 计入预算、总长严格 ≤ 20000；**不**照搬 executor 的 8 轮收敛循环（clone-rate 成本，本面只需不变式）。`LIST_SESSIONS_MAX_LIMIT` 200 → 128（主仓 81 个真实会话复测：单条摘要 JSON 本体 71–124 字符，页面内连写每条再 +1 个条目间逗号 ⇒ 72–125，四字段可打印上限 ≈126；按页内口径 128 × 125 = 16 000 < 20000，200 × 125 = 25 000 越帽；第 13 条记的「≈141 B/条」在同一份目录上复现不出来，单位也应是字符不是字节，已按本处订正），description 与 SC18 diff 测同步改。
    - **「删除 4000 红线」的落法（订正 T6「同票交付」那句）。** 退场的是 4000 这个数与由它引出的假称：两张皮 description 的「Results are capped at 4000 characters」、`tests/harness/aci/tools/query-trace.test.ts:135` 与 `tests/trace-mcp/server.test.ts:64` 两条小夹具上的恒真 `<= 4_000`（后者须改钉它真正想认证的东西）。但**行轴的整条记录收窄机制本票保留**，只把预算从 4000 改锚 `TRACE_OUTPUT_BACKSTOP`：单条投影行是 KB 级以下、上限 200 行的页却可能远超 20000，本票直接拆机制会把行轴变成无界，默认路径就会在两张皮上被 20000 从 JSON 中间切断。等 T7 重做行投影时再拆。
    - **`findRecord` 的扫描归属**：`get_record` 与（T7 之前的）`query_trace` 都要按 `record_id` 找行 ⇒ 抽 `src/traceserver/record-lookup.ts` 一处实现，`record_scan` 也从这里抛，T7 删 `query_trace` 的调用面。命中的 id 轴在结果里具名（`matched_on`），10 字段 OR 与「`turn_id` 既是筛选又是 id」这层含糊就不再要调用方猜。

15. **T6 收尾两轴 review = Standards 0 High / 5 Medium / 5 Low、Spec 1 High / 1 Medium / 5 Low；High + 两条 Medium 在本 commit 前处置完，其余记账。** 逐条：
    - **High（已改）**：`tests/session-api/ensure-deps-aci-tools.test.ts` 的 `EXPECTED_TOOLS` 没跟上 append —— 第 1 条列的 8 处下游字面量真的一处都不能省。全量因此从 5 文件 / 32 例涨到 7 / 34；补 `get_record` 后回到 5 / 32 且逐文件同构。
    - **另 1 例红不记在本票账上**：`tests/cli/register-shutdown.test.ts` 真实 SIGTERM 二次强杀在全量并行下红，单跑 7/7 绿（`EXIT 0`）⇒ 判为负载时序 flaky；本票未触 `src/cli`。
    - **Medium（已改，docs 假称）**：`docs/trace-mcp-server.md:5` 新写那句把 `query_trace` 说成 "paged by row"，而工具面今日没有行 `offset`（那是 T7 AC）。改成本票真交付的形状「filtered, one page per `limit`」。
    - **Low（已改，单位口径）**：主仓 81 会话复测 = entry JSON 本体 **71–124 字符**、页内连写每条再 +1 逗号 ⇒ **72–125**。src 文档与测试注释此前各写一个数又不写口径，看着像互相反证（reviewer 据此报了一条）。三处现都写明口径，预算算术改按页内口径（128 × 125 = 16 000 < 20 000，200 × 125 = 25 000 越帽）。
    - **Low（已改，死数字）**：`tests/traceserver/query-trace-core.test.ts` 注释写「measured ≈ 24,411 characters」，实测 24,362。该行下方本就有动态断言比对 `TRACE_OUTPUT_BACKSTOP`，注释里的二手数字只会在漂移时变假话 ⇒ 删数留断言。
    - **未处置的 Standards Medium（去处 = T7 或单独 refactor 票，本票不顺手做）**：① `applyTraceOutputBackstop` 与 `truncatePreview` 同形重复、`"...[truncated]"` 三份；② `get-record-core` 重复 `query-trace-core` 的输入守卫（去处 `src/traceserver/input-guards.ts`，T7 一并折 `http.ts`）；③ 核直接挖 `row["messages"]`，而「哪些键是 payload」已归 `record-lookup.ts`；④ `(match, parsed, addressable)` 三参数团；⑤ `manifestOf` 不给 part 总数 ⇒ 清单臂若被尾切，调用方无从知道掉了条目，与 `GET_RECORD_DESCRIPTION` 的「learn a part's length first」相抵（窗臂不受影响，本票按 Medium 记账）。
    - **未处置的 Low**：`src/traceserver/index.ts` 两个暂无消费者的 barrel 导出、`src/harness/aci/tools/get-record.ts:13-15` 注释把只剩一条的 `io_error` 写成「两种」、`tests/trace-mcp/server.test.ts:256-261` 两条在该夹具上永不生效的断言、`tests/traceserver/get-record-core.test.ts` 一处注释声称上下界都测而实只测下界。删/改断言按 `.qoder/rules/test.md` 要单独判据，不进收尾 commit。
    - **SC18 提前交付**：`server.test.ts` 的 `PARAMETER_PLANE` 三件表本属 T7 判据（第 12 条），T6 已落地 ⇒ 保留，T7 不得重复领功。

## Tasks (ordered by dependency)

1. **Spec 修订：读侧三面 + 契约 X 清理** — tag: `[decision]`
   - **Inherits:** `specs/trace-mcp-server.md` 假设 1「不代理 traceserver HTTP」不变；假设 4「首版只暴露一个 tool」→ v1.1 起三件；假设 5「核禁 import `harness/`、MCP 模块 transport only」不变；假设 8 的「不改 ACI 工具语义」括注仅豁免「共享抽取导致的机械搬移」——本轮 `conversation_id` 必填 + 删参属语义变更，必须先经本票改写；SC6（`tools/list` 含且仅含 `query_trace`）/ SC7（≤4000）/ SC8（`detail` 语义）随文改口径。
   - **Surface:** `specs/`（修订），`docs/adr/`（**不改**，无 reopen）
   - **Acceptance:** 修订后的 spec 明写：工具面输出不含 `truncated`/`total`/`response_truncated`；字符帽不是任何工具的参数；MCP transport 自带与 executor 同值的 20000 backstop；`conversation_id` 在工具面必填。三件工具白名单替换 SC6。可逆：`git revert` 即回原 spec。
   - Status: [x] done — `bc560655`（spec v1.1：三面白名单 + read unit 词表 + SC6–SC8 改写 + SC16 前缀归属）

2. **现役核 characterization 测（先钉住，再动手）** — tag: `[implementation]`
   - **Inherits:** ACR 一轮 defensive `no` 的实测依据——`tests/traceserver/query-trace-core.test.ts` 全文只有 1 个 `it()`（`:21`）。假设 5：核无 `harness/` import。
   - **Surface:** `tests/traceserver/`
   - **Acceptance:** 对**未改动**的现役核加测并全绿，逐条钉住今天真实行为——**含 P0 的静默降级与假 `response_truncated`，按「现在确实如此」写成通过态断言**（不是 xfail/红灯，故 `EXIT 0` 与基线不矛盾）；T3 负责把这些断言的方向翻过来。`npx vitest run tests/traceserver/` EXIT 0；不改 `src/`。
   - Status: [x] done — `b71cb9c3`（characterization 测，commit 正文自述 30 例，含 T3/T5/T7 的 flip-site 注释）
   - [blocks: T1]

3. **P0：下钻不再静默丢字段（只治「静默」，不治「帽」）** — tag: `[implementation]`
   - **Inherits:** ADR-0004:23 契约 X（工具面不自己填截断元字段）；ACR 三轮裁定——本票**不得**抛 `window_overflow`/`record_not_found`（那两个 kind 归 T6，两票后才落），且本票**不**碰 transport 侧的帽。复现：llm_call `2dff031d`（原始行 35,656 字节 / 31 messages）要 `detail:"messages"` → 返回 10 个标量字段、无 messages、`response_truncated:false`。
   - **Surface:** `src/traceserver`（单面，不含两张皮）
   - **Acceptance:** ① `compactRecord` 的「删字段」与「按记录数从尾砍到 0」两条路径退场（`:366-387`）；② `response_truncated` 从工具面输出删除——它随记录数走、不随字段走，是假负号来源；③ 列表页超容只按记录数收窄，诚实信号 = `records.length < limit`（隐式，不需元字段）；④ **单条记录下钻超容 → 该条整条原样返回，既不截也不抛**（原条款「抛既有 `validation` kind 并指名 `detail=tool_results`」经实测作废，判据与裁定见「执行期前提修正」第 4 条：那个去处走的是同一条 `compactRecord` 整字段删除路径，是假建议；抛错则把「读一条大记录」这个下钻存在的唯一理由堵死）；`src/traceserver` 侧**不新增任何帽**，也不动 transport；⑤ **测须钉死这条新形状**（代替原「证明 `detail=tool_results` 在 4000 内收得下」，该前提已被证伪：`TOOL_RESULT_PREVIEW_CAP=400` 是每条常量、N 无上界，任何固定值都兜不住任意 N，改成随 N 收缩的聚合预算又等于在下一层重新引入静默截断、违反本票 P0）：在 `tests/traceserver/` 内构造合成夹具（单条 llm_call、原始行 >4000 字节、多 messages + tool_result blob），断言下钻返回体**字节数 > 4000 且字段完整**（`tool_results` 数组在、条数不减、无字段消失），使 T6 的改动是相对一条已钉期望被审。⑥ `QUERY_TRACE_RESPONSE_CAP=4000` 原样保留并注释为「T6 窗口落地即退场」的红线——**只管列表页**，单条下钻路径不经它。T2 钉住旧行为的基线断言在本票被**改写为期望行为**（T2 全绿 → T3 后仍全绿，只是断言方向翻转，不允许出现红灯 commit 落在 master 上）。
   - Status: [x] done — `b5f75e63`（`serializeListPage` 只按整条记录收窄、`serializeDrillDown` 整条原样返回；`compactRecord` 与 `response_truncated` 退场；4000 红线保留为 T6 退场注释）
   - [blocks: T2]

4. **session-index 与序列化的单一权威收敛** — tag: `[implementation]`
   - **Inherits:** ACR 一轮 complexity `no`：`src/traceserver/sessions.ts:108` 已拥有会话索引，而 `http.ts:257-285` 与 `query-trace-core.ts:63-64/:221-228` **各自**复制了「最近会话默认 + 信封字面量」。ADR-0020 D1.1：面板 `/api/v1/traces` 语义不变（含 SC-R 12 缺省最近会话）。
   - **Surface:** `src/traceserver`（含 `http.ts`）
   - **Acceptance:** 「最近会话」推导只有一个 owner，panel 与 tool 两侧都经它；tool-page 序列化出口只有一个且两张皮共用。**本票不删工具面的隐式默认**（删了会在 T7 之前留下破的中间 commit），只把它改为经该 owner；`http.ts` 侧信封字面量消失。panel 现有测（`tests/traceserver/http.test.ts`）零改动仍绿 = 纯机械搬移的判据。
   - Status: [x] done — `19248392`（新增 `src/traceserver/envelope.ts` 一处构造；`sessions.ts` 导出 `newestConversationId` 为唯一 owner，`http.ts` 私有副本与两处信封字面量删除；`tests/traceserver/http.test.ts` 零改动仍绿 = 纯机械搬移判据达成）
   - [blocks: T3]

5. **`list_sessions` 上两张皮** — tag: `[implementation]`
   - **Inherits:** 假设 5（MCP 模块本身注册不进 ACI registry；ACI 面走 registry 工厂）；`sessions.ts:1-22` 读侧语义（readdir+stat，不读正文；根记录缺失 → `agent_version` absent）。缺口实测：`trace/` 有 81 个 `.jsonl`，`record_type=session` 只返回 **2** 条——会话根记录在 run 末尾才落盘，crash / 进行中会话经 `query_trace` 不可发现。
   - **Surface:** `src/traceserver` + `src/harness/aci`（registry 40→41）+ `src/trace-mcp`
   - **Acceptance:** 两张皮 `tools/list` 都含 `list_sessions`；按 mtime 倒序、caller `limit`/`offset` 定页；只含 `conversation_id`/`mtime`/`size`/`agent_version`，无截断元字段。registry 增长的下游后果必须显式落到**五处**字面量：`tests/harness/aci/tools/registry.test.ts:211`（硬写 `toHaveLength(40)`）、`tests/session-api/ensure-deps-aci-tools.test.ts:40` 的 36 条 `EXPECTED_TOOLS`（`:130` 断 `toHaveLength(EXPECTED_TOOLS.length)`）、`tests/harness/build-engine.test.ts:59` 的同形列表，以及 MCP 侧两处工具名断言 `tests/trace-mcp/server.test.ts:45`（`toHaveLength(1)`）与 `tests/trace-mcp/startup.test.ts:90,122`（`toEqual(["query_trace"])`）——后三处在 T5/T6 各 +1、T7 改面。`src/harness/verify/run-classifier-adapter.ts:60` 派生的 judge `disallowedTools` 会新增禁这件——**是期望行为**，写进注释别当回归修。empty/negative/overflow/concurrent 四类按上表绿。**本票兼任前缀搬迁**：核去 `query_trace: ` 前缀、删 `stripQueryTracePrefix`、两张皮各自加本工具名前缀（判据：`list_sessions` 的校验错误在两张皮里都显示为 `list_sessions: …`，不出现 `query_trace:`）。
   - **与 T6 不可并行：** 两票都追加 `registry.ts:88` 且同改上述字面量；同分支串行，计数 40→41→42。
   - Status: [x] done — 分两 commit：`2f2b2940`（T5a 前缀搬迁：核两条域内 error 去工具名、两张皮各自加本工具名、删 `stripQueryTracePrefix`）+ 本 commit（T5b `list_sessions` 上两张皮：新核 `src/traceserver/list-sessions-core.ts`、排序推导 `sessionsByRecency` 落 `sessions.ts`、`parseInteger` 抽到 `parse-integer.ts` 共用、registry 40→41 尾部追加）。两处按 AC 字面写会误判，记此：① 「五处字面量」按第 1 条实测是 **14 处**（另 2 处只失真不红，已一并改真）；② SC16 的「校验错误显示为 `list_sessions: …`」**没有可达的校验路径**（第 11 条实测 zod/ajv 遮蔽全部界），前缀断言因此钉在 `TraceReadError`（文件冒充目录 → ENOTDIR）这条两张皮共有的路上；③ 收尾两轴 review 又订正了两处我自己的错判（tool face 坐标回显、`agent_version` absent 的 64 KiB 窗口成因），连同三处 dedup 与 SC18 的交付范围一并记在第 12 条。

   - **本票验证门（实测于本 commit 前）：** `npx tsc --noEmit` EXIT 0；`npx vitest run` = `Tests 32 failed | 5576 passed (5608)`、`Test Files 5 failed | 384 passed (389)`，失败集与第 6 条基线**逐文件同构**（`identity/assemble`、`identity/coordinator-segment`、`identity/mcp-overview-segment`、`memory/assembly`、`memory/refresh`，仍是那 32 例，不增不减；本轮两次全量跑都未出现 `build-engine.test.ts` 的 `ENOTEMPTY` teardown 竞态，故不据此报数）；读侧窄门 `npx vitest run tests/traceserver/ tests/trace-mcp/ tests/harness/aci/tools/` = 42 文件 780 例全绿；SC15 判据 `git diff HEAD -- src/traceserver/http.ts` 输出 0 字节；第 9 条的 `bun test tests/tui/deps-tools.test.ts` 仍 1 fail / 5 pass。
   - **「14 处」里有 1 处故意为 13 改 + 1 不改**：`tests/tui/deps-tools.test.ts:96/:142` 按第 9 条裁定不动（它已因 #861/#862 那批退役/复原而红，修它需要单独判据）。该文件落在 `vitest.config.ts:22` 的 `exclude: ["tests/tui/**"]` 里，**vitest 门永远看不见它**，只能由上面那条 bun 子门覆盖——别把「vitest 全绿同构」当成 14 处都已跟上的证据。
   - [blocks: T4]

6. **`get_record` 窗口轴上两张皮（并在此票终结字符帽）** — tag: `[implementation]`
   - **Inherits:** ADR-0004:34（无状态分页优于闭包游标，因 `isConcurrencySafe:true`）；ADR-0036 blob 解引用在投影前；`project-tool-results.ts` 的 `// EXIT:` 降级语义不变；ADR-0006 D6 `:22`「工具级管读多少（语义单位：行/条/字符），executor 管输出不超多少（字符兜底）」；ADR-0006:29（低于 executor 又静默裁的帽 = 双层截断，已正式推翻）。窗单位下移到 part + 字符切片的依据：单 message p99=16,815 > 任何中等帽。
   - **Surface:** `src/traceserver` + `src/harness/aci`（41→42）+ `src/trace-mcp`
   - **Acceptance:** `get_record(conversation_id, record_id, detail, message_index, part_index, from_char, count)`：窗坐标全由调用方给且原样回显；装不下抛 `TraceWindowOverflowError`（断言零部分字节泄漏）；无命中抛 `TraceRecordNotFoundError`（取代现状静默 `records:[]`）；`count` 默认量级取 message p50 附近且可续取 `from_char`；命中的 id 轴在结果里具名（现状 `RECORD_ID_KEYS:24-35` 是 10 字段 OR，`turn_id` 既是筛选又是 id）。**窗口触发、单位、两臂形状、`count` 的界以第 14 条为准。**
   - **同票交付：** T3 保留的 4000 红线在此删除（去处已在，不是抛进真空；**删除的落法见第 14 条**——退场的是数字与假称，行轴的整条记录收窄机制改锚 backstop 后留到 T7）；MCP 薄皮新增**具名** backstop，值 = `src/harness/tools/executor.ts:30` 的 `OUTPUT_HARD_CAP` 20000（同值 → 不犯 ADR-0006:29）；ACI 面不设工具级帽，由 executor 兜；`server.ts:27` 那句「capped at 4000 characters」随 SSOT 文案改为真值。
   - **必须补 ACI catch arm：** `src/harness/aci/tools/query-trace.ts:47-60` 今天只映射 2 个 kind、其余 `throw error` 原样抛；而 MCP 薄皮的兜底 catch（`src/trace-mcp/server.ts:52`）会把它伪装成已妥善处理。新增 `record_scan`/`record_not_found`/`window_overflow` 三 kind 各须一条 ACI 映射测（→ `ToolExecutionError` 或既有类型），否则 ACI 面泄漏裸 Error。
   - registry 后果同 T5 的字面量清单（现为**五处**）。
   - Status: [x] done — 本 commit。`get_record` 上两张皮：新核 `src/traceserver/get-record-core.ts`（清单臂 / 窗臂由 `part_index` 有无区分，`text` 排最后一个键）、`record-lookup.ts`（`findRecord` 归属，`record_scan` 由此抛，`matched_on` 具名命中轴）、`output-backstop.ts`（`TRACE_OUTPUT_BACKSTOP = 20_000`，不 import `harness/`）；ACI 皮 `src/harness/aci/tools/get-record.ts`（五种 `ToolExecutionError` 各带 `get_record: ` 前缀 + `io_error`）与 registry 41→42 尾部追加；MCP 皮第三件 `registerTool`，两臂都过 backstop。字符帽在本票退场：`QUERY_TRACE_RESPONSE_CAP` 删除、行轴收窄改锚 `TRACE_OUTPUT_BACKSTOP`、两张皮 description 单源且不含字符帽表述。`LIST_SESSIONS_MAX_LIMIT` 200→128 一并校准。收尾两轴 review 的处置与遗留见第 15 条。
   - [blocks: T5]

7. **`query_trace` 瘦身为行筛选 + 行分页** — tag: `[implementation]`
   - **Inherits:** 假设 4 经 T1 改写；`TraceQuery` 早已有行分页 `offset`（`src/traceserver/types.ts:56-57`）且 reader 支持，但 `parseInput`（`query-trace-core.ts:137-149`）从未暴露——实测 `limit=2` / `total=10` 取不回第 3~10 条；`findRecord`（`:230`，limit 覆盖在 `:239`/`:251`）强制覆盖 `limit` 的静默失效随 `record_id` 迁出而消失。
   - **Surface:** `src/traceserver` + `src/harness/aci` + `src/trace-mcp`
   - **Acceptance:** `query_trace` 参数面 = `{conversation_id(必填), record_type, status, task_id, turn_id, parent_turn_id, limit, offset}`；`record_id`/`detail`/`resume_offset` 移除且去处（T5/T6）可用；**行 `offset` 就是工具面取代字节游标的那一个**，写进 description 别让外部 agent 猜；不存在的 `conversation_id` → `TraceSessionNotFoundError` 而非静默空（T4 保留的工具面隐式默认在此删除）；工具面输出不含 `total`/`truncated`，panel face 不动；两张皮参数面逐项一致（一条 diff 断言，防漂移）。`specs/query-trace-tool-results.md` 与本 spec 的 SC 同步。
   - **面板轮询不受影响（已核）：** `http.ts:158` 的 `resumeOffset` 由 `parseResumeOffset` 直入 `TraceQuery`，**从不经过** `parseInput`，故 SC-R 14 字节续读在 panel face 原样保留；T4 的收敛不得把两条 parser 合并——合并即破面板轮询语义。
   - Status: [ ] pending
   - [blocks: T4, T6]

8. **`.iknow/mcp.json` cwd 依赖修复** — tag: `[implementation]`
   - **Inherits:** 假设 6「`--trace-out` > `IKNOW_TRACE_OUT` > `./trace/`，空/非法 → 启动期 fail-fast」不变。缺陷：`.iknow/mcp.json` 现写 `npx tsx src/trace-mcp/main.ts --trace-out trace`，两个相对路径都随宿主 cwd 漂（全局 `~/.qoder-cn/mcp.json` 用绝对路径，无此问题）。
   - **Surface:** `.iknow/`（配置）+ `docs/trace-mcp-server.md`（示例）
   - **Acceptance:** 从非 repo-root 目录启动 MCP host 仍能列出三件工具（可脚本化断言，形式同 `tests/trace-mcp/startup.test.ts` 现有 spawn 冒烟）；文档示例可直接复制。
   - Status: [ ] pending
   - [blocks: T5, T6]

## End of round

顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8，**全串行**（T5/T6 因共改 `registry.ts:88` 与枚举字面量不可并行；T7 必须晚于 T5+T6，先给去处再拆旧门）。全部合入后一轮 code-review + verification-before-completion，再走 `domain-modeling` 落「待写入」。

回归门禁：`npx vitest run tests/traceserver/ tests/trace-mcp/ tests/harness/aci/tools/` + registry 枚举面 `tests/harness/aci/tools/registry.test.ts` `tests/session-api/ensure-deps-aci-tools.test.ts` `tests/harness/build-engine.test.ts` `tests/harness/verify/judge-input.test.ts` `tests/harness/verify/three-stage-flow.test.ts` `tests/subagent/worker-tool-surface.test.ts` `tests/tui/deps-tools.test.ts` `tests/harness/mcp/zero-linkage-guard.test.ts` `tests/harness/graph/run-graph-assembly.test.ts`；不进 `test:real-llm`。
