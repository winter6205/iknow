# Plan: pluggable-web-search-backends（`web_search` 可插拔 HTTP 后端）

**Goal:** `web_search` ACI 工具名与既有字段契约不变；新增可插拔 HTTP 后端 seam，按配置键切换搜索引擎实现；零 key 默认仍 Bing HTML；首版（v1）仅 Exa 真 HTTP，Tavily / Brave schema 占位。
**Approach:** 严格串行八 commit。T1 扩 env 配置臂；T2 建 BACKENDS seam 并把 Bing 包成同形；T3 落 typed error + handler 出口转译；T4/T5/T6 三家 adapter 并行写但**各 1 commit 不并合入**；T7 跨层 integration fail-closed；T8 opt-in real HTTP smoke；T9 specs/README.md 活跃表对齐收口。**禁止 T4∥T5∥T6 共享 commit、T4/T5/T6 与 T2/T3 顺序颠倒**。envelope meta 通道（executor `isEnvelope` 白名单扩）不在本计划；Brave / Tavily 真 HTTP 推到 v2；`web_fetch` / `html-text` / `network-guard` 零改动。
**Spec link:** `specs/pluggable-web-search-backends.md`
**Tracker:** 本文件为跟踪 SSOT。不按 tracer bullet 建 GitHub issue（与 `plans/retrieval-context-budget.md:6` 同形，操作员指示）。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch（整轮结束后再跑一轮 end-of-round code-review，不按 commit 重复）。

## 待写入（persist 段）

- 空。2 条 CONTEXT 词条（`web_search backend selection` / `search backend adapter seam`）已在 spec-driven-development 阶段由 `domain-modeling` flush 进 `docs/CONTEXT.md`（issue #826 硬规则不触发新 ADR）。
- 实施期若发现 envelope meta 必须前置以满足某条 Acceptance，需新起 `specs/envelope-meta-search-backends.md` 并走完整 spec 闭环；本计划不开此缝。

## Out of scope

- 默认改接 Exa 为零 key 默认 / 强制要 vendor key（任一触发即开 ADR；本计划不触发）。
- R4 envelope meta 形状（`executor.ts:isEnvelope` 白名单扩展 + `observability side-channel` 传 `adapter` / `latencyMs` / `requestId`）— 另起 spec。
- Brave 真 HTTP 实现 — v2 推进。
- Tavily 真 HTTP 实现（v1 stub 与 Brave 同形态）— v2 推进。
- `web_fetch` / `html-text` / `network-guard` 任何改动。
- 把 `web_search` 换成 MCP 搜索面（issue #826 硬 out）。
- 无 key 多厂商免费额度轮询（issue #826 硬 out）。
- `settings.search.*` 双层承载（env 直读足够；非 LLM 字段不上 settings 单承载，ADR-0015 §5）。
- 从权威 messages 删除或改写已追加的旧 web `tool_result`。

## ACR

继承 spec `## ACR` 5-line PASS verdict（本计划不再走一轮 `architecture-change-reviewer`，因 spec 阶段已 BLOCKED→PASS；本阶段变更范围严格 ≤ spec `## Changes`）。

## Tasks (ordered by dependency)

1. **T1 env.ts：WebEnv 扩字段 + envOptionalEnum helper** — tag: `[implementation]`
   - **Inherits:** spec Assumption 3-5（WebEnv 加 `searchBackend` / `exaApiKey` / `tavilyApiKey` / `braveApiKey` 四字段；env var 走 vendor 命名 `EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY`；后端选择走项目命名 `IKNOW_WEB_SEARCH_BACKEND`，默认 `"bing"`，闭集 `"bing" | "tavily" | "exa" | "brave"`）；CONTEXT `project stack defaults (SSOT boundary — settings 单承载收敛 ADR-0015)` §5（非 LLM 字段 `process.env > .env.local > .env` 优先级链保留）。
   - **Surface:** `src/config/env.ts`（既有 `WebEnv` interface L146-149 + 装配点 L648-653）。
   - **Acceptance:**
     - `WebEnv` 多 4 字段且每个字段都有 JSDoc 标注对应 env var 名（实现可走字面或 `${VAR}` 占位符，与现有 `IKNOW_LLM_API_KEY` 退役路径一致）。
     - `loadIknowEnv` 对 `IKNOW_WEB_SEARCH_BACKEND` 做 enum 校验（不在闭集 → typed error，**不**回退默认）；对三个 keyed key 做空串 / 占位符解析失败 → undefined 而非 silent empty。
     - 新增 `envOptionalEnum({ file, key, values, default })` helper（同形 `envInt` / `envOptional`），含 4 行实现 + 1 行 JSDoc。
     - 占位符解析失败的负测：fixture 设 `.env.local` 字面 `${UNSET_VAR}`，断言对应字段 = undefined 且不抛。
     - `npm run typecheck` exit 0；既有 env loader 测试全绿。
   - Status: [ ] pending

2. **T2 web-search.ts：同文件 BACKENDS 表 + BingBackend 包成同形** — tag: `[implementation]`
   - **Inherits:** spec Assumption 7（`SearchBackend` interface 三方法同形：`fetchResults` / `project` / `describe`）；SC #5（零 key 路径与 v0 行为字节级一致）；SC #6（既有 `search_url` SSRF 路径不动）；SC #10（`network-guard.ts` / `html-text.ts` / `web-fetch.ts` 零改）。
   - **Surface:** `src/harness/aci/tools/web-search.ts`（既有 404 行）。
   - **Acceptance:**
     - `BACKENDS: Record<SearchBackendId, SearchBackend>` 表存在；`selectBackend(id)` 分派函数存在；`BingBackend` 类（或同形函数）把既有 `cn.bing.com/search` HTML 解析路径包成 `fetchResults` / `project` / `describe` 三方法同形签名。
     - 既有 `parseResults` 按 hostname 分派 Bing/DDG 行为不变；既有 `resultCache`（`web-search.ts:88`）不动。
     - `backend="bing"` 或未设时调用路径与 v0 字节级一致（同 fixture 跑同 query 出同输出；既有 `web-search.test.ts` 全绿）。
     - `backend="bing"` 时 `search_url` 覆写仍走既有 SSRF 验证路径。
     - `npm run typecheck` exit 0；`npx vitest run tests/harness/aci/tools/web-search` exit 0。
   - Status: [ ] pending
   - [blocks: T1]

3. **T3 typed SearchBackendError + handler 出口 try/catch → ToolExecutionError** — tag: `[implementation]`
   - **Inherits:** spec Assumption 6（三态 fail-closed + 六 kind：`missing_key` / `backend_unset_with_key` / `http_non_2xx` / `parse` / `timeout` / `not_shipped`）；CONTEXT `executor truncation authority` + `plain-string tool output (Y1)`；plan `retrieval-context-budget.md` T2 既有 `// EXIT:` 纪律。
   - **Surface:** 新文件 `src/harness/aci/tools/web-search-errors.ts`（spec 已冻结）+ `web-search.ts` handler 出口改动。
   - **Acceptance:**
     - `SearchBackendError` 类型（class with kind / message / endpoint / cause）落地，六 kind 闭集；message **不**带 key 字面值 / Authorization header / vendor request body。
     - handler 出口 `try { ... } catch (err) { /* EXIT: 转译 */ }` 把六 kind 一对一映射到 `ToolExecutionError`（与既有 fail-closed 同一族，message 可区分）。
     - 「backend 未设 + keyed key 已设」路径单独 assert（不依赖 fetch 阶段）。
     - 既有「schema reject `search_url` when backend != bing」路径落 spec Assumption 9。
     - 既有 `ToolExecutionError` 既有测试面零回归。
     - `npm run typecheck` exit 0；既有 web-search 测试 + integration fail-closed 测试（既有的）全绿。
   - Status: [ ] pending
   - [blocks: T2]

4. **T4 ExaBackend v1 真 fetch** — tag: `[implementation]`
   - **Inherits:** spec Assumption 8（Exa `result.title` / `result.highlights[0].text ?? result.text` / `result.url`，project 到 Bing-shape）；SC #3（basic / empty / field-cap / concurrent / parse / non-2xx / timeout 七类）；SC #9（既有 concurrency describe 扩四 backend）；SC #7（probe 跑通）。
   - **Surface:** `src/harness/aci/tools/web-search.ts`（同 BACKENDS 表）+ `tests/harness/aci/tools/web-search/backends/exa.test.ts`（新文件）。
   - **Acceptance:**
     - Exa 真 HTTP：`fetchResults` 走 `Authorization: Bearer ${apiKey}` 头，endpoint = `https://api.exa.ai/search`；非 2xx → typed `http_non_2xx`；超时 → typed `timeout`（`signal.aborted` 路径）。
     - `project` 把 Exa JSON 投影到 `SearchResult[]`，上限 `maxResults`；`highlights[0].text` 优先于 `result.text`；空 `results` → 空数组（与既有 Bing 零结果同失败族，不 silent 改 empty 数组）。
     - 5 类 stub 测试齐：basic / empty / field-cap / parse（畸形 JSON）/ non-2xx（401+429+5xx 三 fixture）。
     - 既有 `tests/harness/aci/tools/web-search.test.ts:455 describe("createWebSearchTool — concurrency")` 扩四 backend（parametrize over `[bing, exa]` 起步，T5/T6 落地后再扩 `[bing, exa, tavily, brave]`）；`resultCache` 行为天然共享，不复制代码。
     - `npm run typecheck` exit 0；`npx vitest run tests/harness/aci/tools/web-search tests/harness/aci/tools/web-search/backends/exa` exit 0。
   - Status: [ ] pending
   - [blocks: T3]

5. **T5 TavilyBackend v1 stub** — tag: `[implementation]`
   - **Inherits:** spec Assumption 8（Tavily `result.title` / `result.content` / `result.url`，**忽略 `result.answer`**）；SC #8（被选中时抛 typed `not_shipped`）。
   - **Surface:** `src/harness/aci/tools/web-search.ts`（同 BACKENDS 表）+ `tests/harness/aci/tools/web-search/backends/tavily.test.ts`（新文件）。
   - **Acceptance:**
     - `fetchResults` 抛 typed `SearchBackendError` kind=`not_shipped`（message 含 backend id "tavily" + 提示「v2 真 fetch 推进」）。
     - `project` 仍按 spec 形态实现（Tavily JSON → Bing-shape；fixture 测，含 `result.answer` 字段**不**进 output 断言）。
     - 5 类 stub 测试齐：basic / empty / field-cap / result.answer 忽略（fixture 含 answer 字段 → 断言 output 全文不含 answer 字面值）/ not_shipped 选中路径。
     - v1 不发真 HTTP；probe 脚本不测 Tavily。
     - `npm run typecheck` exit 0；`npx vitest run tests/harness/aci/tools/web-search/backends/tavily` exit 0。
   - Status: [ ] pending
   - [parallel with T4, T6]（各 1 commit 不并合入；同一 PR 内顺序提交）

6. **T6 BraveBackend v1 stub + schema 形态** — tag: `[implementation]`
   - **Inherits:** spec Assumption 8（Brave v1 不实现 `project`，stub `fetchResults` 抛 typed `not_shipped`）；SC #8。
   - **Surface:** `src/harness/aci/tools/web-search.ts`（同 BACKENDS 表）+ `tests/harness/aci/tools/web-search/backends/brave.test.ts`（新文件）。
   - **Acceptance:**
     - `fetchResults` 抛 typed `SearchBackendError` kind=`not_shipped`（message 含 backend id "brave"）。
     - 5 类 stub 测试齐：basic / empty / not_shipped 选中路径 / schema 形态断言（BACKENDS["brave"].id === "brave"，三方法签名同形）。
     - v1 不发真 HTTP；probe 脚本不测 Brave。
     - `npm run typecheck` exit 0；`npx vitest run tests/harness/aci/tools/web-search/backends/brave` exit 0。
   - Status: [ ] pending
   - [parallel with T4, T5]

7. **T7 integration search-backend-fail-closed** — tag: `[implementation]`
   - **Inherits:** spec SC #4（4 状态：backend=exa+key 缺 / 占位符解析失败 / backend 未设有 key / backend=tavily+search_url）+ SC #9。
   - **Surface:** `tests/integration/search-backend-fail-closed.test.ts`（新文件）。
   - **Acceptance:**
     - 4 状态各自 1 用例：① fixture 设 `IKNOW_WEB_SEARCH_BACKEND=exa` + 无 `EXA_API_KEY` → typed `ToolExecutionError` 含 `"exa"` 字面值；② fixture 设 `EXA_API_KEY=${UNSET_VAR}` → typed error；③ fixture 设 `EXA_API_KEY=...` + 无 backend → typed error 含「backend unset」；④ fixture `backend=tavily` + `search_url="..."` → schema reject 含「search_url only valid with backend=bing」。
     - 既有 `tests/harness/aci/tools/web-search` 单测全绿（regression gate）。
     - `npm run typecheck` exit 0；`npx vitest run tests/integration/search-backend-fail-closed` exit 0。
   - Status: [ ] pending
   - [blocks: T4, T5, T6]

8. **T8 scripts/probe-search-backends.ts + README probe 段** — tag: `[implementation]`
   - **Inherits:** spec SC #7（env key 缺失 fail-fast，exit ≠ 0 + stderr 提示，不 silent skip）；CONTEXT `test.md`「缺 key → 显式 skip」（本脚本头注释钉「search HTTP 非 LLM e2e，fail-closed 是有意偏离」）。
   - **Surface:** `scripts/probe-search-backends.ts`（新文件；同 `scripts/probe-*.ts` 既有形态）+ `README.md`（既有 probe 段加一行）。
   - **Acceptance:**
     - 脚本读 `EXA_API_KEY`（**不**读 Tavily / Brave — v1 不发真 HTTP）；缺 key → stderr 输出含「EXA_API_KEY missing」+ exit ≠ 0，**不** silent skip。
     - 跑通：`fetchResults("capital of France", 5)` 返 ≥1 结果；title / snippet / url 都非空；output **不**含上游原 response；log 含 `latencyMs`。
     - 不入 vitest 默认收集（脚本头注释钉「不在 vitest 跑」）。
     - `npm run probe:search-backends` 在 `EXA_API_KEY` 已设下 exit 0；缺 key exit ≠ 0 + stderr 可读。
   - Status: [ ] pending
   - [blocks: T4]

9. **T9 specs/README.md 活跃表加一行 + commits 收口** — tag: `[implementation]`
   - **Inherits:** spec Inherits/Changes「specs/README.md 活跃表加一行」；CONTEXT `web_search backend selection` / `search backend adapter seam`（已 flush）。
   - **Surface:** `specs/README.md`（活跃 spec 表）+ `git log` 收口。
   - **Acceptance:**
     - `specs/README.md` 活跃表「工具与扩展源」段加一行：`pluggable-web-search-backends.md — web_search 可插拔 HTTP 后端（首版仅 Exa 真 HTTP）；plan: plans/pluggable-web-search-backends.md`。
     - T1–T8 各自 1 commit 在同一 PR 内顺序合入（`git log --oneline | head -8` 验证）。
     - end-of-round code-review：跑 `arthurpower:code-review`（standards + spec 二维），全绿后合入。
   - Status: [ ] pending
   - [blocks: T1, T2, T3, T4, T5, T6, T7, T8]

## Code review phase

T1–T9 全部落地后，整轮 diff 过一次 end-of-round code-review（`arthurpower:code-review`，standards + spec 二维），再宣称本计划完成；不按 commit 重复跑 review。
