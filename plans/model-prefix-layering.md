# Plan: model-prefix-layering

> Spec: `specs/model-prefix-layering.md`（ACR 第二轮 PASS 5/5 yes）· 依据 ADR-0041 / 0042 / 0043 · wayfinder 图「模型面前缀分层与缓存兑现」全部剩余工作
> Tracker: 本地 markdown（用户裁定不开 GitHub issue；fallback 形态，无 tracker edges）
> Per-bullet loop：`test-driven-development` → typecheck/tests → `verification-before-completion` → 1 commit / bullet；全部落完后 round 收尾过 `arthurpower:code-review`

## Decided vs Open

**Inherits（不重开）**：前缀资格线（D9）；两条执法断言形态（声明↔产物一致性、相邻轮 deep-equal）；MCP 目录化 + tool_search 双写（ADR-0043 §2）；开局等待 30s + 超时不进目录（§4）；手动重连只消息追加 role=user（§4）；溢出治理（10% 阈值、countTokens 实测、仅首轮判定、退场次序、失败跳过，§3）；ToolExecutionError 模板（spec §3）；git-snapshot.ts 单一 git 出口（spec §9）；两条 manager seam 签名（spec §4）；通知消息 role=user 一行静态（spec §4/§8）；git 块四要素 + 免责句 + D1（spec §9）；六段 LOCKED 不重排（G2 关）；G3 无剩余工作；G5 承认 compact 跳缓存必废、只约束重装配过断言。
**Open（实施者定）**：断言实现文件与测试布局；deferrable 内建具体名单（数据问题，依 spec Confirms with human——超出 ADR-0043 §3 预置次序时回报确认）；溢出治理与 tool_search 的接线细节；git 块截断上限具体数值（`truncateByCodepoints` 参数）。

## Tracer Bullets

### B1 [implementation] — T0：usage 段修复 + 断言①（声明↔产物一致性）

`resolveSegment` 补 `import { IKNOW_USAGE_DEFAULT }` + `case "usage"`；同一 commit 落断言①：`IKNOW_ASSEMBLY_ORDER` 每个声明段必现于装配产物，或属于显式条件段清单（初版：`bootstrap` / `memory_layer`（空库时）/ git 块 / MCP 名字目录）。ask 表面同注入。重跑 `scripts/wayfinder-measure-prefix.ts` 更新 D3 数字。

- Inherits: spec Boundaries #1/#2；D9 断言①
- Surface: `src/harness/identity/assemble.ts`；测试 `tests/harness/identity/`
- Acceptance: 断言①测试红→绿；装配产物含 usage 段文本；`npm test` 全绿
- Completion: 第二实施者可选断言放置（assemble 测试文件 or 独立 invariant 测试）仍过同一验收；SC1 + SC10 满足

### B2 [implementation] — memory catalog 会话级快照（ADR-0042）

`memory/refresh.ts` 语义从「mtime 门控缓存」改「会话级快照」：首次装配取值后冻结，不再比对 mtime；下会话重取。bodies/prefetch 通道不动。

- Inherits: ADR-0042 全部；D8
- Surface: `src/harness/memory/refresh.ts`；测试 `tests/harness/memory/refresh*`
- Acceptance: 会话内记忆文件落盘后，catalog 段与首次装配 deep-equal（SC6）；新会话可见新记忆；既有 memory 测试套相应更新（契约变更，测试改写需 commit 正文说明）
- Completion: 快照语义可由第二实施者用不同冻结点实现（首装配缓存 or resolver 包装）仍过同一验收

### B3 [implementation] — graph 模式表达（ADR-0041）[parallel with B2]

`run_graph` 常驻注册 + handler 层 gate（graph 关时 ToolExecutionError 拒绝）+ description 静态文字；`orchestration` 段撤出 system；模式切换 = messages 尾部追加 role=user 一行提示（开图含编排指引、关图关闭提示）。

- Inherits: ADR-0041 全部；ADR-0030 产品语义不动；D7
- Surface: `src/harness/graph/run-graph-tool.ts`、`src/harness/build-engine.ts`（装配 wire + registry 过滤移除）；通知消息经 spec §8 缝
- Acceptance: graph 关→开→关 tools+system 逐字节不变；关图调 run_graph 被拒（SC5）；messages 尾部出现切换提示
- Completion: gate 实现点（tool def handler or executor 层）由实施者定；SC5 满足

### B4 [implementation] — MCP 目录化 + 两条 seam + 开局等待（ADR-0043 主干）

MCP schema 不再 upfront：名字目录进 system（新加性段）；`tool_search` 按需加载 = result 消息追加 + schema 尾部追加 tools 双写；未加载即调用 ToolExecutionError（模板钉死）；`manager.start({firstTurnReadyTimeoutMs})` + `onManualReconnect(cb)` 两条 seam，build-engine wire：首轮 await 30s（超时不进目录、装配照常）+ 手动重连只消息追加。`<mcp_tools_overview>` 段撤除。

- Inherits: ADR-0043 §2/§4；spec §3/§4；D10
- Surface: `src/harness/mcp/manager.ts`、`src/harness/aci/aci-registry.ts`、`src/harness/build-engine.ts`、`src/harness/identity/assemble.ts`（名字目录段）
- Acceptance: SC3 + SC4 全过；MCP 连上前后相邻轮 tools+system deep-equal（SC2 场景一）
- Completion: 目录段渲染与 wire 细节由实施者定；断言②（deep-equal）在本 bullet 场景一先立
- [blocks: B6]

### B5 [implementation] — git 块（T1~T3）[parallel with B4]

新模块 `src/harness/identity/git-snapshot.ts`（git 读取唯一出口；EnvDegradeReason 三态退化）；assemble.ts 加性段消费（与 `## Project path` 同形态）；内容四要素 + 免责句 + status 截断（`truncateByCodepoints`）；worker/subagent 经 `withRoleExtras` 段序对齐给父代理快照。

- Inherits: spec §9；D1；ADR-0037 §4（稳定根）
- Surface: `src/harness/identity/git-snapshot.ts`（新）、`assemble.ts`、worker 注入缝
- Acceptance: SC8（四要素 + 免责句在场；非 git 仓库段缺席且装配不报错）；git 块在相邻轮 deep-equal（SC2 场景）
- Completion: 截断上限数值、快照缓存点由实施者定；与 B4 无文件交叠可并行

### B6 [implementation] — 溢出治理（ADR-0043 §3）

deferrable 标记（AciToolDef 加字段）；首轮装配判定：countTokens 实测（禁止估算参与判定）可延迟池 vs 端点窗口 10%（配置读）；超限按退场次序退名字目录，仅此一次；countTokens 失败 = 跳过本会话 + warn。deferrable 名单按调用频次数据定（超出 ADR-0043 §3 预置次序时回报确认）。

- Inherits: ADR-0043 §3；spec §5；D10
- Surface: `src/harness/aci/aci-registry.ts`、`aci/tools/registry.ts`（标记）、装配判定点
- Acceptance: SC7（超限退场 / 未超限不退 / 会话中不重算 / countTokens 失败跳过）
- Completion: 判定点位置（registry or assemble）由实施者定
- [blocks-by: B4]

### B7 [implementation] — 断言②收尾（deep-equal 总装）

harness 测试：相邻两轮装配 tools+system deep-equal 全场景矩阵（MCP 连上 / graph 翻图 / 记忆落盘 / compact 重装配 / git 块静态）——B4/B3/B2/B5 各立过单场景，此处收全矩阵 + compact 场景补齐。

- Inherits: D9 断言②；spec §2
- Surface: `tests/harness/`（总装测试）
- Acceptance: SC2 四+场景全绿；`npm test` 全绿
- Completion: 测试文件布局由实施者定

### B8 [implementation] — 真实模型 e2e + 测量收尾

`npm run test:real-llm` 补 e2e：真实端点多 turn 会话 + MCP 真连接 + tool_search 加载回路（缺 key 显式 Not run）；重跑测量脚本终验；G2/G3/G5 关闭注记落图（wayfinder map）。

- Inherits: spec SC9/SC10；测试规范 LLM-touching 条款
- Surface: `archive/tests-real-llm/`
- Acceptance: real-llm e2e 过或显式 Not run；SC9/SC10 终态
- Completion: e2e 用例选择由实施者定

## End-of-round

全部 bullet 落完后：`arthurpower:code-review`（整轮改动）→ `arthurpower:verification-before-completion` → commit 收编。依赖链：B1 → {B2, B3, B4, B5} → B6 → B7 → B8；[parallel] 对无文件交叠。

## 待写入

（空——领域词已随 spec persist 完毕：前缀资格线 / 名字目录 / 开局等待 / 溢出治理 / 会话级快照段 / git 块 + 渐进式披露修订，已在 worktree CONTEXT.md 落盘）
