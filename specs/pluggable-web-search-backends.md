# Spec: pluggable-web-search-backends — `web_search` 可插拔 HTTP 后端（首版仅 Exa 真 HTTP）

> 输入：issue #826「feat: pluggable web_search HTTP backends (after retrieval-context-budget)」。前置 plan `plans/retrieval-context-budget.md` T1–T3 已合入。
> 上轮 logicsync 已落 R1'–R6 决议（详见本文 Inherits / Changes）。本 spec 把这些决议固化到可施工合同。

## Assumptions

1. v1 范围 = seam schema 三家全建 + Exa 单家真 HTTP；Tavily / Brave 同步 stub 占位（被选中时抛 typed `SearchBackendError` kind `not_shipped`，与 Exa 缺 key 的 fail-closed 区分）。
2. 默认后端 = `bing`（HTML 解析，`cn.bing.com/search`），不变；零 key 路径走现有 `parseResults` hostname 分派 Bing/DDG，不改 `web-search.ts` 既有路径。
3. `WebEnv` 加四个字段：`searchBackend`、`exaApiKey`、`tavilyApiKey`、`braveApiKey`。env loader 直读，无 `${VAR}` 占位符路径（非 LLM 字段走 `process.env > .env.local > .env` 优先级链；ADR-0015 §5 保留机制）。
4. 密钥 env var 名走 vendor 命名：`EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY`；后端选择走项目命名 `IKNOW_WEB_SEARCH_BACKEND`。两类解耦（密钥存放位置 ≠ 后端选择名）。
5. 后端选择值闭集：`"bing" | "tavily" | "exa" | "brave"`，默认 `"bing"`；非法值 schema reject。
6. 三态 fail-closed：
   - `backend = "bing"` 或未设 + 无任何 keyed key → Bing HTML（默认路径，与既有完全一致）
   - `backend = keyed` + 对应 key 缺失 / 占位符解析失败 → typed `ToolExecutionError`（含 backend id + 提示 env / settings 字段）
   - `backend` 未设 + 任意 vendor key 已设 → 走默认 Bing（key 未生效；operator 漏选 backend 不报错，由 loader 的 `IKNOW_WEB_SEARCH_BACKEND` 默认值 `"bing"` 自然兜底）
   - 上游非 2xx（含 401 / 429 / 5xx）→ typed `ToolExecutionError`，message 含 upstream status + endpoint 域名，**不**带 key 字面值 / Authorization header
7. Adapter interface 形态（同文件 `BACKENDS` 表，按 `id` 分派；不开子目录）：
   ```ts
   export type SearchBackendId = "bing" | "tavily" | "exa" | "brave";
   export interface SearchBackend {
     readonly id: SearchBackendId;
     fetchResults(args: {
       query: string;
       maxResults: number;
       signal: AbortSignal;
     }): Promise<unknown>;
     project(raw: unknown, maxResults: number): SearchResult[]; // Bing-shape
     describe(
       raw: unknown,
       startedAt: number
     ): { adapter: SearchBackendId; latencyMs: number; requestId?: string };
   }
   ```
8. 投影规则：所有 adapter 收敛到 Bing-shape `{title, snippet, url}`；T2 字段 cap 一刀切，adapter 不写自家 cap。
   - Tavily: `result.title` / `result.content` / `result.url`；**忽略 `result.answer`**
   - Exa: `result.title` / `result.highlights[0] ?? result.text` / `result.url`（真 Exa API 的 `highlights` 是 `string[]`，非 spec 初稿假设的 `Array<{text:string}>` —— 已通过 T8 probe 验证；spec 初稿 8.Assumption 与真 API 偏差已在本 spec 修订时更正）
   - Brave: v1 不实现 `project()`，stub `fetchResults` 抛 typed `not_shipped` error
9. `search_url` 覆写参数在 `backend != "bing"` 时 **schema reject**（typed `ToolExecutionError`：search_url only valid with backend="bing"）；不走 SSRF 验证路径。`backend = "bing"` 时既有 SSRF 路径不动。
10. 测试矩阵：stub-only 默认（每 backend 一文件，7 类边界）+ integration fail-closed（4 状态）+ opt-in real HTTP smoke（`scripts/probe-search-backends.ts`）；Brave v1 真 HTTP 不测试。
11. No new ADR：issue #826 硬规则「默认后端不变 + product default 不需 key」→ 不触发；2 条 CONTEXT.md 词条走 `domain-modeling` 待写入。
12. R4 envelope meta 形状（adapter / latencyMs / requestId 走 `observability side-channel`）**不在本 spec 范围**；executor `isEnvelope` 当前仅放过 `oldContent`/`newContent`，扩白名单涉及 executor 改动，是另一段 decision path。v1 缺 TUI 后端身份显示是可接受的推迟。

## Objective

`web_search` ACI 工具名与既有字段契约不变；新增可插拔 HTTP 后端 seam，按配置键切换搜索引擎实现。零 key 默认仍 Bing HTML；首版（v1）仅 Exa 真 HTTP，Tavily / Brave 占位 schema（不实现真 fetch）。让 operator 在不写代码的前提下切到 keyed backend。

## Boundaries

- **Does:**
  - `WebEnv` 扩四个字段（`searchBackend` + 三 key）+ `envOptionalEnum` helper
  - `web-search.ts` 同文件加 `BACKENDS: Record<SearchBackendId, SearchBackend>` 表 + `selectBackend(id)` 分派
  - Tavily / Exa adapter 真实实现（含 fixture 与 stub HTTP）
  - Brave adapter stub（schema 完整，`fetchResults` 抛 typed `not_shipped`）
  - typed `SearchBackendError`（kind ∈ `"missing_key" | "backend_unset_with_key" | "http_non_2xx" | "parse" | "timeout" | "not_shipped"`）→ `ToolExecutionError` 出口
  - 既有 Bing 路径与 `search_url` 覆写（`backend = "bing"` 时）零变化
  - stub 单元测试（每 backend 一文件，覆盖 basic / empty / field-cap / vendor-specific / non-2xx / timeout / meta-not-leak 七类）
  - integration fail-closed 测试（4 状态）
  - opt-in real HTTP smoke `scripts/probe-search-backends.ts`
- **Confirms with human:** （无，operator 已在 logicsync 全程确认 R1'–R6）
- **Out of this spec:**
  - R4 envelope meta 形状（executor `isEnvelope` 白名单扩展；`observability side-channel` 传 `adapter` / `latencyMs` / `requestId`）— 另起
  - Brave 真 HTTP 实现 — v2 推进
  - Tavily 真 HTTP 实现（v1 stub 与 Brave 同形态）— v2 推进
  - `web_fetch` / `html-text` / `network-guard` 任何改动
  - MCP 为搜索面（issue 文本硬 out）
  - 无 key 多厂商免费额度轮询（issue 文本硬 out）
  - 默认后端切换 / product default 强制要 key（任一触发即开 ADR；本 spec 不触发）
  - `settings.search.*` 双层承载（env 直读足够；非 LLM 字段不上 settings 单承载，ADR-0015 §5）

## Success Criteria

1. `npm run typecheck` exit 0。
2. `npx vitest run tests/harness/aci/tools/web-search tests/integration/search-backend-fail-closed` exit 0。
3. stub 单元测试覆盖至少九类：basic / empty / field-cap / **concurrent（同 query 并发去重，parametrize over backend id）** / **parse（vendor 畸形响应 → `SearchBackendError` kind=`parse`，非 silent empty）** / Tavily `result.answer` 忽略 / Exa `highlights[0]` 优先 / non-2xx / timeout；**meta-not-leak** 类按 Out-of-scope 标记 v1 跳过（无 envelope meta 通道）。
4. integration fail-closed 测试覆盖：① `backend=exa + EXA_API_KEY 缺失` → typed `ToolExecutionError`；② `EXA_API_KEY` 占位符解析失败 → typed error；③ ~~`EXA_API_KEY` 已设但 `IKNOW_WEB_SEARCH_BACKEND` 未设 → typed error（已撤销）~~：loader 的 `IKNOW_WEB_SEARCH_BACKEND` 默认值 `"bing"` 让此路径在真 loader 不可达；归入默认 Bing 路径（SC #5）。集成测试 `tests/integration/search-backend-fail-closed.test.ts` 中 state ③ 用「loadIknowEnv 后手动 override `searchBackend=undefined`」覆盖 handler entry 的 `assertBackendConfig` 防御路径（防回归：未来若有人改 loader 让 `searchBackend` 可能 `undefined` 时仍 fail-closed），但**不是**真实用户路径。④ `backend=tavily + search_url 传入` → schema reject。
5. 既有 Bing HTML 路径（`backend="bing"` 或未设 + 无 key）在无 `EXA_API_KEY` 等的纯净环境下与 v0 行为字节级一致（同 fixture 跑同 query 出同输出）。
6. 既有 `search_url` SSRF 验证（`backend="bing"` 时）路径不动；既有 web-search 单测全绿。
7. `npm run probe:search-backends` 在 `EXA_API_KEY` 已设时跑通（≥1 结果、字段非空）；缺 key 时 fail-fast（exit ≠ 0 + stderr 提示，不 silent skip）。
8. Brave / Tavily stub：被 `IKNOW_WEB_SEARCH_BACKEND=brave|tavily` 选中时抛 typed `not_shipped` error，message 含 backend id。
9. T2 字段 cap（snippet ≤ 500 / title ≤ 200 / 总条 ≤ max_results）跨 `[bing, exa, tavily, brave]` 一致施加（`MAX_SNIPPET_CHARS=500` 是 pre-existing 常量，本 PR 不动；spec 初稿口误「280」是文档笔误，已更正）；既有 `web-search.test.ts:455 describe("createWebSearchTool — concurrency")` 的「同 query 并发去重」用例扩到四个 backend（既有 `resultCache` 不动，行为天然共享；新增 parametrize 即可，不复制代码）。
10. 既有 `network-guard.ts` / `html-text.ts` / `web-fetch.ts` 文件零改动。

## Open Questions

- R4 envelope meta 形状：何时扩 `executor.ts:isEnvelope` 白名单让 adapter `describe()` 输出走 observability side-channel？（本 spec 不锁；TUI「via Exa」/ latency 显示推迟到 envelope spec。）

## Inherits / Changes

**Inherits**（既有 surface，本 spec 直接复用，零改动）：

- `src/harness/aci/tools/web-search.ts` 既有 Bing HTML 解析（`cn.bing.com/search` 默认）+ `search_url` 覆写 + `parseResults` 按 hostname 分派 Bing/DDG（`web-search.ts:228-237`）
- `src/harness/aci/tools/network-guard.ts` SSRF 校验（`backend="bing"` 路径零变化）
- `src/harness/aci/tools/registry.ts` `web_search` ACI 注册（tool 名不变）
- T2 既有 per-field cap（snippet ≤ 500 / title ≤ 200 / 总条 ≤ max_results）+ 同 query dedup（`web-search.ts:88 resultCache`）
- ADR-0004 契约 X / Y1（plain-string tool output，model 视野纯字符串）
- ADR-0006（executor 20000 字符总闸 / 工具不自称 truncated/total）
- ADR-0008 D6（chars/N 估算只供 compact 判据；本 spec 不改 compact）
- ADR-0015 §5（非 LLM 字段 `process.env > .env.local > .env` 优先级链保留；本 spec 的 search.* 字段走这条链）
- CONTEXT `executor truncation authority` / `plain-string tool output (Y1)` / `project stack defaults (SSOT boundary — settings 单承载收敛 ADR-0015)` / `ACI tool set`
- plan `plans/retrieval-context-budget.md` T2 既有测试面（per-field cap / 同 query dedup），parametrize over backend id

**Changes**（本 spec 新增 / 改动）：

- `src/config/env.ts`：`WebEnv` 加四字段（`searchBackend`、`exaApiKey`、`tavilyApiKey`、`braveApiKey`）；加 `envOptionalEnum({ file, key, values, default })` helper；装配点加四行
- `src/harness/aci/tools/web-search.ts`：同文件内 `BACKENDS: Record<SearchBackendId, SearchBackend>` 表 + `selectBackend(id)` + `BingBackend`（既有逻辑包成同形）/ `TavilyBackend`（v1 stub + 注释「TBD v2 真 fetch」）/ `ExaBackend`（v1 真 fetch）/ `BraveBackend`（v1 stub）
- `src/harness/aci/tools/web-search-errors.ts`（新文件）：typed `SearchBackendError`，kind 闭集
- `tests/harness/aci/tools/web-search/backends/{bing,tavily,exa,brave}.test.ts`（新文件，每 backend 一组 7 类 stub 测试；Brave 只测 not_shipped + schema 形态）
- `tests/integration/search-backend-fail-closed.test.ts`（新文件，4 状态）
- `scripts/probe-search-backends.ts`（新文件，opt-in real HTTP smoke；不入 vitest 默认收集）
- `specs/README.md` 活跃表加一行
- CONTEXT.md 词条（`domain-modeling` 待写）：`web_search backend selection` / `search backend adapter seam`

## ACR

> 首轮 pre-impl 门禁；5-line verdict 等 `architecture-change-reviewer` agent 跑出后填入。

```
bounded-context-guardian: yes — 新代码仅落在 src/harness/aci/tools/web-search.ts（同文件 BACKENDS 表 + selectBackend 分派，不开子目录）+ 新文件 src/harness/aci/tools/web-search-errors.ts（typed error 单职责）；registry.ts / network-guard.ts / env 装配之外零改。
defensive-contract-validator: yes — 九类 stub 测试齐（basic / empty / field-cap / concurrent / parse / Tavily answer 忽略 / Exa highlights[0] / non-2xx / timeout）；concurrent 显式 parametrize over [bing, exa, tavily, brave]（既有 web-search.test.ts concurrency describe 扩四个 backend）；parse kind 用 vendor 畸形 fixture 钉死「非 silent empty 落 kind=parse」。
error-handling-enforcer: yes — SearchBackendError 六 kind 闭集（missing_key / backend_unset_with_key / http_non_2xx / parse / timeout / not_shipped）→ ToolExecutionError 出口；message 含 upstream status + endpoint 域名、不带 key / Authorization；// EXIT: 纪律继承 retrieval-context-budget.md T2。
complexity-anti-drift: yes — 4 backend 类 + 同文件 BACKENDS 表 + selectBackend 分派 = 1 抽象 1 层；web-search.ts 既有 404 行 + 新增 ≤200 行（封顶 600）；web-search-errors.ts 单职责；测试 4 backend 文件 + 1 integration，无 god-file。
minimal-change-verifier: yes — T1 → T2 → T3 → T4/T5/T6（可并但各 1 commit 不并合入）→ T7 → T8 → T9 依赖链显式锁，禁止单 commit 混装；network-guard.ts / html-text.ts / web-fetch.ts 零改动（SC #10）。
OVERALL: PASS — hand to writing-plans
```

## Per-task outline（hint 给 writing-plans；非 spec 本体）

- T1：env.ts WebEnv 扩字段 + envOptionalEnum helper（含占位符解析失败路径的负测）
- T2：web-search.ts 同文件内 BACKENDS 表 + BingBackend 包成同形 + 既有单测全绿
- T3：typed SearchBackendError + handler 出口 try/catch → ToolExecutionError（含六种 kind 转译）
- T4：ExaBackend v1 真 fetch（fixture + stub HTTP）+ 5 类 stub 测试
- T5：TavilyBackend stub（Brave 同形态）+ 5 类 stub 测试（含 `result.answer` 忽略）
- T6：BraveBackend stub + `not_shipped` 测试
- T7：integration fail-closed 4 状态测试
- T8：`scripts/probe-search-backends.ts` + README probe 段
- T9：specs/README.md 活跃表加一行；plan + spec commit

依赖链：T1 → T2 → T3 → T4/T5/T6（可并，但 T4/T5/T6 各 1 commit 不并合入）→ T7 → T8 → T9。
