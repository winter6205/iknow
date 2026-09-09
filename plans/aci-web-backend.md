# Plan: ACI web backend

**Goal:** 一个后端名驱动发现与阅读回落；本轮厂商适配只做 Exa，且必须真出网实测。
**Approach:** 先钉能力表（仅 Exa 标「有抓」），再给 `web_fetch` 接 Exa contents，缺搜/缺抓回落默认；Tavily/Brave 不接 API。收尾离线绿线 + Exa 真打 `api.exa.ai`。不碰 bash fence。
**Spec link:** `specs/aci-web-backend.md`
**Tracker:** 本地 markdown（操作员指定）。沙箱模式 = [#959](https://github.com/winter6205/iknow/issues/959)，不进本 plan 的 tracer。
**ACR:** all-yes（见下）。实施按 tracer 多 commit，不在本文件开工。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch。整轮收尾再 code-review。

**affects:** `src/config/env.ts` `src/harness/aci/tools/web-search.ts` `src/harness/aci/tools/web-fetch.ts` `src/harness/aci/tools/registry.ts` `docs/llm-config-quickstart.md` `tests/harness/aci/tools/`（及现有 web 工具测试文件）

## architecture-change-reviewer

bounded-context-guardian: yes — 只动 ACI web 工具与 `IknowEnv.web` 装配，不把厂商 HTTP 细节漏进 permission / sandbox fence，不新建技术分层目录。
defensive-contract-validator: yes — spec 已列 empty / negative / overflow / concurrent / exception；实施须在现有 web 工具测试面补齐五类。
error-handling-enforcer: yes — 非法 id 保持 typed fail-loud；传输失败 typed 可见、不伪装成缺能力；回落只在装配期能力判定，EXIT 写在回落分支。
complexity-anti-drift: yes — 能力表 + 选引擎与 handler 分抽象层，禁止在 `web_fetch` handler 内展开厂商协议。
minimal-change-verifier: yes — 一个逻辑任务（web backend 回落），按下方 tracer 各 1 commit；不混 #957、不混 0072。

## 待写入

（空）

## Tasks (ordered by dependency)

1. **能力表与回落判定** — tag: `[implementation]`
   - **Inherits:** **ACI web backend**；非法 id fail-loud；缺 = 无实现 / 无 key / 厂商无该 API；传输失败 ≠ 缺。
   - **Surface:** `src/config` + ACI web 工具模块（与 `SEARCH_BACKEND_VALUES` 同层）
   - **Acceptance:** 纯函数可回答「搜走谁 / 抓走谁」；仅 `exa`+key 为「有搜且有抓」；`bing` / `tavily` / `brave` / 无 key 的 `exa` 抓侧均为本机阅读。不出现 Tavily extract / Brave fetch 分支。
   - Status: [x] done

2. **发现：缺搜不再 `not_shipped`** — tag: `[implementation]`
   - **Inherits:** SC4；Tavily/Brave stub 算无搜。
   - **Surface:** `web_search`
   - **Acceptance:** 选 `brave` / `tavily`（或无 key）时 `web_search` 走默认检索；不新写 Tavily/Brave HTTP 客户端。`exa`+key 仍走已有 Exa search。
   - Status: [x] done
   - [blocks: T1]

3. **阅读：只接 Exa contents，其余本机** — tag: `[implementation]`
   - **Inherits:** SC5–SC7；私网先拒；仅 `exa`+key+公开 URL 走 contents；模型 schema 不增 method/headers。
   - **Surface:** `web_fetch`
   - **Acceptance:** 非 Exa 或无 key 的公开 URL 仍 `network-guard`；`exa`+key 不对本机目标 URL 发 `fetchPublicResponse`；`127.0.0.1` 任意后端均拒。diff 不含 Tavily/Brave 抓取客户端。
   - Status: [x] done
   - [blocks: T1]

4. **默认零回归 + 操作员文档** — tag: `[implementation]`
   - **Inherits:** SC2、SC8、SC9；不改 `network: true`。
   - **Surface:** 既有 web 工具测试 + `docs/llm-config-quickstart.md`
   - **Acceptance:** 未设后端时搜/抓与今日默认路径锁定；文档写明本轮只适配 Exa、缺则回落、通话仍 amplify；`npm test` 与 `npm run typecheck` exit 0。
   - Status: [x] done
   - [blocks: T2, T3]

5. **Exa 真出网实测** — tag: `[implementation]`
   - **Inherits:** SC10；缺 `EXA_API_KEY` 显式 Not run，不得用 mock 过门。
   - **Surface:** 既有 probe / 门控实测入口（与 #826 T8 同档：真打 `api.exa.ai`，不进默认 `npm test` 收集）
   - **Acceptance:** 有 key 时同一次实测覆盖 Exa search 与 Exa contents（`web_fetch`）；非 2xx / 超时 typed 失败可见。无 key 时日志写 Not run + 命令名，SC10 标未过。
   - Status: [x] done
   - [blocks: T3]
