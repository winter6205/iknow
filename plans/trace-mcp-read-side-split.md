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
- 陈旧注释纠正：`src/harness/aci/tools/registry.ts:183` 写「= 37 件名」，而 `tests/harness/aci/tools/registry.test.ts:211` 断言 **40**。以断言为准，注释随手更正。
- 无 ADR reopen。`QUERY_TRACE_RESPONSE_CAP=4000` 退场是向 ADR-0006:22 收敛，不与任何已接受 ADR 冲突。

## 序列化与错误归属（全票共用，ACR 点名要求）

- **数据装配** 归 `src/traceserver/`；**wire 形状** 归各薄皮：
  - panel face：`src/traceserver/http.ts` 自行组 `{records,total,skipped_lines,truncated,offset}`（现状保持，ADR-0020 面板语义不变）。
  - tool face：`src/traceserver/` 内**唯一**一个 tool-page 序列化出口，ACI 与 MCP 两张皮都调它；输出 = records 数组 + 回显调用方给过的坐标 + 一行人类可读收窄提示（ADR-0004:46 的 marker 形态，不是 JSON 元字段）。
  - 工具 description 文案单一来源（现重复于 `src/harness/aci/tools/query-trace.ts:65` 与 `src/trace-mcp/server.ts:27`，后者还谎称有 4000 帽），受 `tests/harness/aci/tools/d9-description-guard.test.ts` 约束。
- **域内 typed error**（`src/traceserver/query-trace-errors.ts`，一律**不带**工具名前缀——前缀是薄皮的活；现状 `:9`/`:22` 硬编码 `query_trace: ` 且被 `query-trace.ts:104-107` 剥掉）：

| class | `kind` | 触发 | 归属票 |
|---|---|---|---|
| `TraceQueryValidationError` | `validation` | 参数非法（既有 kind，T3 使用；去前缀在 T5） | T3 / T5 |
| `TraceQueryRecordScanError` | `record_scan` | 扫描帽耗尽（既有，随下钻轴迁至 `get_record`） | T6 |
| `TraceRecordNotFoundError` | `record_not_found` | `record_id` 无命中（现为静默 `records:[]`） | T6 |
| `TraceWindowOverflowError` | `window_overflow` | caller 的 `count` 装不下该 part | T6 |
| `TraceSessionNotFoundError` | `session_not_found` | 必填 `conversation_id` 在 `traceDir` 无对应文件 | T7 |

- **前缀归属（ACR 五轮补）：** 核 error 消息**不带**工具名，前缀由每张薄皮自己加。现状 `query-trace-errors.ts:9`/`:22` 硬编码 `query_trace: `，而 ACI 包装类 `QueryTraceValidationError` 自己又加一次（故有 `stripQueryTracePrefix`，`query-trace.ts:104-107`）。**去前缀的动作落在 T5**（那张票是第一个往两张皮上加工具的票，Surface 已含两张皮），不落 T3——否则 T5/T6 期间 `list_sessions` 的报错会顶着 `query_trace:` 这个错名字。核去前缀后 `stripQueryTracePrefix` 即死代码，同票删除；MCP 薄皮（`server.ts:52-60` 现直接吐 `error.message`）必须自行前缀本工具名。
- `// EXIT:` 只标**真降级点**（blob 解引用失败、`query-trace-core.ts:333` 循环引用 fallback）。raise-site 不是 EXIT，别贴。
- **catch-arm 通则（ACR 四轮）：** 每引入一个新 kind 或一张新薄皮面，就必须有一条 ACI 映射测——`src/harness/aci/tools/query-trace.ts:47-60` 只认 2 个 kind，其余 `throw error` 原样上抛；MCP 薄皮的兜底 catch（`src/trace-mcp/server.ts:52`）会把这种泄漏显示成 `isError` 文本，**不算已处理**。`list_sessions` 面须映射 `TraceReadError`（`sessions.ts:113` 的 ENOENT→`[]` 除外，那是语义不是错误）。

## 边界类 × 三面 覆盖分配（per-SC map）

| 类 | `list_sessions`(T5) | `query_trace` 瘦(T7) | `get_record`(T6) | 另钉在 |
|---|---|---|---|---|
| empty | 空目录 / 无 `.jsonl` → `[]` 不抛（`sessions.ts:113` 既有语义） | 0 行会话、空文件 | 空 `messages`、`messages_captured:false` | T2 现状基线 |
| negative | `offset<0`、`limit=0` | 同（`parseInteger:200-219` 已守，扩到 `offset`） | `message_index=-1`、`from_char<0`、`count=0` | T3 |
| overflow | 会话数 > 一页 → 只丢尾 + 续取坐标 | 单行超帽不得删字段（`compactRecord:387` 退场） | 单 part > `count` → `window_overflow`，**断言零部分字节泄漏** | T3 / T6 |
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

写 T1 前逐条核了 plan 的 `file:LINE` 引用，绝大多数准确。三处偏差按实测修正，**不改判据方向、只改判据落点**：

1. **T5/T6 的下游字面量是 8 处，不是 5 处。** plan 原列 5 处准确（`registry.test.ts:211` `toHaveLength(40)`、`ensure-deps-aci-tools.test.ts:40`+`:130`、`build-engine.test.ts:59`、`server.test.ts:45`、`startup.test.ts:90,122`）。全仓检索另漏三处硬编码枚举，T5/T6 必须同批改：
   - `tests/harness/aci/tools/d9-description-guard.test.ts:245-246` — **两条** `toHaveLength(40)`（`ACI_TOOLSET_NAMES` 与 `reg.catalog.all()`）；该文件同时是 description 文案单源约束处（`:171` 派生对齐）。
   - `tests/tui/deps-tools.test.ts:96` — `EXPECTED_TOOLSET_30` 全量硬编码名单（`query_trace` 在 `:112`），`:142` 断 `toEqual([...EXPECTED_TOOLSET_30].sort())`。
   - `tests/subagent/worker-tool-surface.test.ts:111` — `WORKER_BASE_SURFACE` 是子代理 worker 的 **allow-list 基线**（含 `query_trace` 于 `:123`），`:249-250` 用 `assert.deepEqual(innerNames, [...WORKER_BASE_SURFACE])` 断**全等**。→ 这不是机械 +1，是**策略位**：往 registry 加件即扩子代理能力面。**裁定 = 纳入**（两件都是 read-only，与既在名单内的 `query_trace` 同门，排除它们会让 worker 能查 trace 却不能列会话／取全文，是更差的不对称）。该裁定写进 T5 测注释，不得当成一条意外回归「修掉」。注意 `:72` 的 `disallowedTools` 与 judge 侧 deny 都是派生的，不受影响。
   
   确认**安全**（从 `ACI_TOOLSET_NAMES` 派生、自动跟随）：`tests/harness/verify/judge-input.test.ts:106,245`、`tests/harness/verify/three-stage-flow.test.ts:1252`。`tests/harness/graph/run-graph-assembly.test.ts:113-116` 按下标锁定 idx 20/21/22/23 —— append-only 只动尾部，**只要不重排就不破**，T5/T6 保持 append。
2. **worktree 内 `trace/` 是空的（0 个 `.jsonl`）**，plan 的尺寸实测与复现记录 `2dff031d` 都住在主仓（`/home/winner/projects/iknow/trace/82967186-f249-4d64-ba7a-50286a5012cc.jsonl`）。→ T3 的 AC ⑤「复现记录走 `detail=tool_results` 在 4000 内成功返回」**不得**写成依赖开发者本地 trace 目录的测；改为在 `tests/traceserver/` 内构造同形状夹具（单条 llm_call、原始行 >4000 字节、多 messages + tool_result blob）。主仓那条记录可用于一次性人工核对量级，不进断言。这也顺带满足 CI 可复现。
3. **`OUTPUT_HARD_CAP`（`src/harness/tools/executor.ts:30`）是未导出的 `const`。** T6 的 MCP backstop「值 = 20000」**不能**靠 `import` 取——那会把 `harness/` 拖进 `src/trace-mcp/`，与假设 5「MCP 模块 transport only」和 SC12 相抵。落法：在 tool face 的序列化 owner 侧（`src/traceserver/`，非 harness）定义具名常量 `= 20_000`，注释指名「值取自 `src/harness/tools/executor.ts:30` 的 `OUTPUT_HARD_CAP`，同值是为不犯 ADR-0006:29 双层截断」，并配一条断言锁该数值 + 一条注释指向来源。两处同值靠断言锁，不靠 import 耦合。

## Tasks (ordered by dependency)

1. **Spec 修订：读侧三面 + 契约 X 清理** — tag: `[decision]`
   - **Inherits:** `specs/trace-mcp-server.md` 假设 1「不代理 traceserver HTTP」不变；假设 4「首版只暴露一个 tool」→ v1.1 起三件；假设 5「核禁 import `harness/`、MCP 模块 transport only」不变；假设 8 的「不改 ACI 工具语义」括注仅豁免「共享抽取导致的机械搬移」——本轮 `conversation_id` 必填 + 删参属语义变更，必须先经本票改写；SC6（`tools/list` 含且仅含 `query_trace`）/ SC7（≤4000）/ SC8（`detail` 语义）随文改口径。
   - **Surface:** `specs/`（修订），`docs/adr/`（**不改**，无 reopen）
   - **Acceptance:** 修订后的 spec 明写：工具面输出不含 `truncated`/`total`/`response_truncated`；字符帽不是任何工具的参数；MCP transport 自带与 executor 同值的 20000 backstop；`conversation_id` 在工具面必填。三件工具白名单替换 SC6。可逆：`git revert` 即回原 spec。
   - Status: [ ] pending

2. **现役核 characterization 测（先钉住，再动手）** — tag: `[implementation]`
   - **Inherits:** ACR 一轮 defensive `no` 的实测依据——`tests/traceserver/query-trace-core.test.ts` 全文只有 1 个 `it()`（`:21`）。假设 5：核无 `harness/` import。
   - **Surface:** `tests/traceserver/`
   - **Acceptance:** 对**未改动**的现役核加测并全绿，逐条钉住今天真实行为——**含 P0 的静默降级与假 `response_truncated`，按「现在确实如此」写成通过态断言**（不是 xfail/红灯，故 `EXIT 0` 与基线不矛盾）；T3 负责把这些断言的方向翻过来。`npx vitest run tests/traceserver/` EXIT 0；不改 `src/`。
   - Status: [ ] pending
   - [blocks: T1]

3. **P0：下钻不再静默丢字段（只治「静默」，不治「帽」）** — tag: `[implementation]`
   - **Inherits:** ADR-0004:23 契约 X（工具面不自己填截断元字段）；ACR 三轮裁定——本票**不得**抛 `window_overflow`/`record_not_found`（那两个 kind 归 T6，两票后才落），且本票**不**碰 transport 侧的帽。复现：llm_call `2dff031d`（原始行 35,656 字节 / 31 messages）要 `detail:"messages"` → 返回 10 个标量字段、无 messages、`response_truncated:false`。
   - **Surface:** `src/traceserver`（单面，不含两张皮）
   - **Acceptance:** ① `compactRecord` 的「删字段」与「按记录数从尾砍到 0」两条路径退场（`:366-387`）；② `response_truncated` 从工具面输出删除——它随记录数走、不随字段走，是假负号来源；③ 列表页超容只按记录数收窄，诚实信号 = `records.length < limit`（隐式，不需元字段）；④ 单条记录下钻超容 → 抛**既有** `validation` kind，消息指名今日就存在的去处（改 `detail=tool_results`）；⑤ **该去处必须被证明真能收**：删 256 slice 后 `tool_results` 预览会长回 `project-tool-results.ts:4` 的 `TOOL_RESULT_PREVIEW_CAP=400`（+56%/条），故本票断言「复现记录 `2dff031d` 走 `detail=tool_results` 在 4000 内成功返回」；若不成立，截断只能收敛在 preview 那一层（唯一 owner = `project-tool-results.ts`），**不得**回到 `compactRecord`，否则 advice 自环直到 T6；⑥ `QUERY_TRACE_RESPONSE_CAP=4000` 原样保留并注释为「T6 窗口落地即退场」的红线。T2 钉住旧行为的基线断言在本票被**改写为期望行为**（T2 全绿 → T3 后仍全绿，只是断言方向翻转，不允许出现红灯 commit 落在 master 上）。
   - Status: [ ] pending
   - [blocks: T2]

4. **session-index 与序列化的单一权威收敛** — tag: `[implementation]`
   - **Inherits:** ACR 一轮 complexity `no`：`src/traceserver/sessions.ts:108` 已拥有会话索引，而 `http.ts:257-285` 与 `query-trace-core.ts:63-64/:221-228` **各自**复制了「最近会话默认 + 信封字面量」。ADR-0020 D1.1：面板 `/api/v1/traces` 语义不变（含 SC-R 12 缺省最近会话）。
   - **Surface:** `src/traceserver`（含 `http.ts`）
   - **Acceptance:** 「最近会话」推导只有一个 owner，panel 与 tool 两侧都经它；tool-page 序列化出口只有一个且两张皮共用。**本票不删工具面的隐式默认**（删了会在 T7 之前留下破的中间 commit），只把它改为经该 owner；`http.ts` 侧信封字面量消失。panel 现有测（`tests/traceserver/http.test.ts`）零改动仍绿 = 纯机械搬移的判据。
   - Status: [ ] pending
   - [blocks: T3]

5. **`list_sessions` 上两张皮** — tag: `[implementation]`
   - **Inherits:** 假设 5（MCP 模块本身注册不进 ACI registry；ACI 面走 registry 工厂）；`sessions.ts:1-22` 读侧语义（readdir+stat，不读正文；根记录缺失 → `agent_version` absent）。缺口实测：`trace/` 有 81 个 `.jsonl`，`record_type=session` 只返回 **2** 条——会话根记录在 run 末尾才落盘，crash / 进行中会话经 `query_trace` 不可发现。
   - **Surface:** `src/traceserver` + `src/harness/aci`（registry 40→41）+ `src/trace-mcp`
   - **Acceptance:** 两张皮 `tools/list` 都含 `list_sessions`；按 mtime 倒序、caller `limit`/`offset` 定页；只含 `conversation_id`/`mtime`/`size`/`agent_version`，无截断元字段。registry 增长的下游后果必须显式落到**五处**字面量：`tests/harness/aci/tools/registry.test.ts:211`（硬写 `toHaveLength(40)`）、`tests/session-api/ensure-deps-aci-tools.test.ts:40` 的 36 条 `EXPECTED_TOOLS`（`:130` 断 `toHaveLength(EXPECTED_TOOLS.length)`）、`tests/harness/build-engine.test.ts:59` 的同形列表，以及 MCP 侧两处工具名断言 `tests/trace-mcp/server.test.ts:45`（`toHaveLength(1)`）与 `tests/trace-mcp/startup.test.ts:90,122`（`toEqual(["query_trace"])`）——后三处在 T5/T6 各 +1、T7 改面。`src/harness/verify/run-classifier-adapter.ts:60` 派生的 judge `disallowedTools` 会新增禁这件——**是期望行为**，写进注释别当回归修。empty/negative/overflow/concurrent 四类按上表绿。**本票兼任前缀搬迁**：核去 `query_trace: ` 前缀、删 `stripQueryTracePrefix`、两张皮各自加本工具名前缀（判据：`list_sessions` 的校验错误在两张皮里都显示为 `list_sessions: …`，不出现 `query_trace:`）。
   - **与 T6 不可并行：** 两票都追加 `registry.ts:88` 且同改上述字面量；同分支串行，计数 40→41→42。
   - Status: [ ] pending
   - [blocks: T4]

6. **`get_record` 窗口轴上两张皮（并在此票终结字符帽）** — tag: `[implementation]`
   - **Inherits:** ADR-0004:34（无状态分页优于闭包游标，因 `isConcurrencySafe:true`）；ADR-0036 blob 解引用在投影前；`project-tool-results.ts` 的 `// EXIT:` 降级语义不变；ADR-0006 D6 `:22`「工具级管读多少（语义单位：行/条/字符），executor 管输出不超多少（字符兜底）」；ADR-0006:29（低于 executor 又静默裁的帽 = 双层截断，已正式推翻）。窗单位下移到 part + 字符切片的依据：单 message p99=16,815 > 任何中等帽。
   - **Surface:** `src/traceserver` + `src/harness/aci`（41→42）+ `src/trace-mcp`
   - **Acceptance:** `get_record(conversation_id, record_id, detail, message_index, part_index, from_char, count)`：窗坐标全由调用方给且原样回显；装不下抛 `TraceWindowOverflowError`（断言零部分字节泄漏）；无命中抛 `TraceRecordNotFoundError`（取代现状静默 `records:[]`）；`count` 默认量级取 message p50 附近且可续取 `from_char`；命中的 id 轴在结果里具名（现状 `RECORD_ID_KEYS:24-35` 是 10 字段 OR，`turn_id` 既是筛选又是 id）。
   - **同票交付：** T3 保留的 4000 红线在此删除（去处已在，不是抛进真空）；MCP 薄皮新增**具名** backstop，值 = `src/harness/tools/executor.ts:30` 的 `OUTPUT_HARD_CAP` 20000（同值 → 不犯 ADR-0006:29）；ACI 面不设工具级帽，由 executor 兜；`server.ts:27` 那句「capped at 4000 characters」随 SSOT 文案改为真值。
   - **必须补 ACI catch arm：** `src/harness/aci/tools/query-trace.ts:47-60` 今天只映射 2 个 kind、其余 `throw error` 原样抛；而 MCP 薄皮的兜底 catch（`src/trace-mcp/server.ts:52`）会把它伪装成已妥善处理。新增 `record_scan`/`record_not_found`/`window_overflow` 三 kind 各须一条 ACI 映射测（→ `ToolExecutionError` 或既有类型），否则 ACI 面泄漏裸 Error。
   - registry 后果同 T5 的字面量清单（现为**五处**）。
   - Status: [ ] pending
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
