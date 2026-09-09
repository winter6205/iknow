# Spec: ACI network surface 冻结 + ACI web backend

> LogicSync 2026-09-09 已决合同。本文件是实施契约，不重开通话件、不重开 ADR-0072。
>
> 假设门：下列条目由同日访谈确认；未列出的实现文件名留给 plan / implementer。

## Assumptions（session-confirmed）

1. 不新增第 9 件 ACI 网络工具；通话保持 `bash` + `network: true`。
2. 同意后的 curl 是 **host-net amplify**（该次宿主直连、零过滤），不是按域名的小开。
3. 发现与阅读共用**一个**后端名；缺搜或缺抓只回落缺的那一头，不把缺的能力报成已接通。
4. 旋钮沿用现有 `IKNOW_WEB_SEARCH_BACKEND` / `IknowEnv.web` 后端字段（闭集不变），不另设 `search_backend` 与 `fetch_backend`。
5. 非法后端 id 仍 fail-loud（`WebEnvConfigError` / `invalid_search_backend`），不静默改成默认。
6. 缺 key、stub、厂商无该能力，一律算「缺」，走默认检索或本机阅读；不改走 bash curl。
7. `web_fetch` 在选引擎之前仍做与今日相同的 URL 语法 / 私网 / link-local / 元数据拒绝；过检的公开 URL 才可交给厂商代抓。
8. 厂商代抓打写死官方端点，不过 `network-guard` 出站（与今日 keyed `web_search` 相同理由）；不把 method / headers / POST 暴露给模型。
9. 默认后端名仍是 `bing`：搜走现行默认检索，抓走本机 `web_fetch` + `network-guard`。
10. ADR-0072 不在本 spec 重开；沙箱模式 / 合作式出口代理另见 tracker issue。
11. **本轮厂商适配只做 Exa**（search 已接通；本 spec 只加 contents 代抓）。不实现 Tavily / Brave 真出网或 extract。
12. **Exa 路径必须真出网实测**才算完成（`EXA_API_KEY` 打 `api.exa.ai`）。缺 key → 显式 Not run，不得用 mock 声称 SC10 已过。

## Glossary（exact copy from docs/CONTEXT.md）

- **ACI tool set**: Harness 装配层（`src/harness/aci/`）注册的工具集；当前 8 件：`bash` / `read_file` / `grep` / `glob` / `edit_file` / `write_file` / `web_fetch` / `web_search`，SSOT 工厂 = `src/harness/aci/tools/registry.ts:createDefaultAciRegistry`，所有入口（`build-engine` / `tui/deps`）从这里取，工具数永不同步漂移（#141 / #191 / a277f68）。每次工具调用经 permission middleware（ADR-0004）与 timeout tier 装饰。
- **ACI network surface**: 装配层网络三职——发现是 `web_search`，阅读是 `web_fetch`，通话不升第 9 件工具、只走 `bash` 的 `network: true`（ADR-0022）。形状冻结；发现与阅读的后端选择见 **ACI web backend**。
- **ACI web backend**: 发现与阅读共用一个后端名；该后端缺搜索或缺抓取时，缺的那一头回落到内建默认（搜索走现行默认检索，阅读走本机 `web_fetch` + `network-guard`）。
- **host-net amplify**: `bash` 带 `network: true` 且 ask 被同意后，该次调用宿主网零过滤；不是按域名的小开，也不另注册 curl 工具（ADR-0022；出口过滤见 ADR-0072）。

（完整句以 `docs/CONTEXT.md` 为准，本 spec 不重定义。）

## Architectural Constraints

- **ADR-0004**：工具集与 permission middleware；本 spec 不改 8 基线件名单。
- **ADR-0022**：`network: true` = 整调用放行宿主网络；本 spec 不改 fence 形状。
- **ADR-0072**：TUN / 强制出口过滤不做；本 spec 不改这条。
- **#826 / `SEARCH_BACKEND_VALUES`**：闭集 `bing | tavily | exa | brave`；非法值 fail-loud。
- **`network-guard`**：本机阅读与 Bing HTML 检索仍走既有防线；#957 DNS TOCTOU 不在本 spec 修。

## Objective

**What:** 把已冻结的 **ACI network surface** 写成实施边界，并把 **ACI web backend** 落到 `web_search` / `web_fetch`：一个后端名，按能力回落。

**Why:** 操作员要「像换引擎一样换后端」，但不能拆成两套旋钮，也不能在缺搜/缺抓时假装接通或逼模型去 curl。

**Who:** 配置 `IKNOW_WEB_SEARCH_BACKEND`（及对应 key）的操作员；调用发现 / 阅读的模型。

## Boundaries

- **Does:**
  - 能力表：每个闭集 id 声明「有搜 / 有抓」。无实现、无 key、厂商无该 API = 无。
  - `web_search`：选中后端无搜 → 现行默认检索（`bing` HTML 路径），不抛 `not_shipped` 充成功。
  - `web_fetch`：选中后端无抓 → 本机 `fetchPublicResponse` + `network-guard`。本轮**唯一**「有抓」= `exa` + key → Exa contents；模型 schema 仍是今日的 `url` / 窗 / `as`。
  - 文档：`docs/llm-config-quickstart.md`（及同等操作员面）写清「一个名字、缺则回落、通话仍是 amplify」。
  - 回归：未设后端时搜、抓与今日默认路径一致。
- **Confirms with human:**（已决）不改默认引擎名；厂商适配本轮只做 Exa；Tavily/Brave 继续当「缺」回落，不在本轮做真适配。
- **Out of this spec:**
  - Tavily `/extract`、Brave 真 search、其它厂商代抓。
  - 第 9 件 HTTP / curl 工具；扩 `web_fetch` 的 method / headers。
  - 重开 ADR-0072；围栏内合作式代理 / 分类器策略组（[#959](https://github.com/winter6205/iknow/issues/959)）。
  - #957 `web_fetch` DNS rebinding TOCTOU。
  - 新厂商、闭集扩员、浏览器工具。
  - 改 `network: true` 批准文案（#958 已落地）。
  - search 文案激励导致优先 fetch（[#960](https://github.com/winter6205/iknow/issues/960)；改法须对照 `docs/guides/prompt-development.md`）。

## Success Criteria

1. **无第 9 件网络工具**：`createDefaultAciRegistry` 不注册 curl / `http_request`；`npm test` 既有 registry 计数断言仍绿（基线 8 件名不变）。
2. **默认零回归**：不设 / 空 / `bing` 时，`web_search` 与 `web_fetch` 出站路径与今日默认一致（Bing HTML + 本机 guard fetch）。有锁定断言。
3. **非法 id fail-loud**：`IKNOW_WEB_SEARCH_BACKEND` 非法值装配期 typed 错，不回落。
4. **缺搜回落**：后端声明无搜（含今日 Tavily/Brave stub、或无 key）时，一次 `web_search` 走默认检索且工具成功语义不是 `not_shipped`。
5. **缺抓回落**：后端声明无抓时，一次对公开 URL 的 `web_fetch` 走本机 guard，不调用厂商抓取 API。
6. **有抓只接 Exa**：仅 `exa` + key 且 URL 已过私网拒绝时，阅读走 Exa contents，不走本机对目标 URL 的 `fetchPublicResponse`（厂商端点本身除外）。Tavily/Brave 在本轮不得出现抓取实现。
7. **私网先拒**：`http://127.0.0.1/`、链路本地、云元数据 URL 在任何后端下均被今日 guard 语义拒绝，不发往厂商。
8. **不升通话**：本 spec 的 diff 不改 `bash` 的 `network` 参数语义、不改 ADR-0022 fence 分支。
9. **离线绿线**：`npm test` 与 `npm run typecheck` exit 0（默认 vitest 仍不打 Exa）。
10. **Exa 实测门**：有 `EXA_API_KEY` 时必须真打 `api.exa.ai` 跑通两条——`web_search`（已有 search）与 `web_fetch`（本轮 contents）。缺 key → 记录 Not run，**不得**把 mock 当成 SC10 已过。命令由 plan 命名（probe / 门控 vitest），实施不得省略。

### 输入五类（S2）

| 类         | 输入                                      | 期望                                                                                                 |
| ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| empty      | 后端未设 / 空串；厂商 body 空 results     | 未设 → 默认 `bing`；空 results → 与今日空结果合同一致，不回落成「当缺能力」                          |
| negative   | 私网 URL + 任意后端；无 key 的 keyed 后端 | 私网拒绝；无 key 视为该侧缺能力并回落                                                                |
| overflow   | 超长 URL / 超大正文窗                     | 沿用今日 `web_fetch` 窗与截断上限，不另开通道                                                        |
| concurrent | 并行 `web_search` + `web_fetch`           | 两工具独立选能力；不共享可变后端状态                                                                 |
| exception  | 厂商 HTTP 5xx / 超时                      | typed 可见失败；**不得**把失败解释成「缺能力」再静默回落（回落只在装配期能力判定，不在单次传输失败） |

## Open Questions

(none — 假设门已在访谈确认。)

## Inherits / Changes

**Inherits:** ADR-0004 工具集；ADR-0022 `network: true`；ADR-0072 不做强制出口；`SEARCH_BACKEND_VALUES` 与 `WebEnvConfigError`；`web_fetch` 既有 schema 与 `network-guard`；`web_search` keyed 端点写死、不过 guard；#958 批准轴诚实 + `network_equals`。

**Changes:** CONTEXT 已增 **ACI network surface** / **ACI web backend** / **host-net amplify**（本 branch 带入，不在本 spec 再定义）。行为：`web_fetch` 在 `exa`+key 时走 contents；其它闭集 id 阅读回落本机。Tavily/Brave 真适配不做；缺搜仍回落默认检索（可去掉用户可见的 `not_shipped`，但不接它们的 API）。

**待写入:** （空 — 术语已进 `docs/CONTEXT.md`。）

## architecture-change-reviewer

见 `plans/aci-web-backend.md` 文首 5 行。实施前不得开工。
