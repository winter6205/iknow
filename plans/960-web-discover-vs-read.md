# Plan: web_search 发现 vs web_fetch 阅读

**Goal:** 操作员要「搜索」时模型先发现，有 URL 要读时才阅读；搜空不改猜地址抓取。
**Approach:** 先钉黄金集（两职 + 搜空不是抓），再改两件工具 description。退场序默认不动；真模型仍先抓再开 ADR-0043。不接 Exa、不加长 system。本票不是 TUI 活环，不跑 aiterm。
**Spec link:** `specs/960-web-discover-vs-read.md`
**ACR:** all-yes / N/A-with-reason（见下）。本切片会动 3+ 文件（两件工具 description、ACI 工具测试、或有 ADR-0043），故留下 verdict，不跳过 ACR。
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → verification-before-completion → one commit on the ticket branch
**Tracker:** 本地 markdown。操作员明确不按 tracer 拆 GitHub issue；依赖只以本文件 `[blocks:]` 为准。父跟踪 [#960](https://github.com/winter6205/iknow/issues/960)。
**待写入:** （空）— 不新增 CONTEXT 词；不预先重开 ADR-0043。

## ACR

- bounded-context-guardian: **yes** — 只动 ACI web 工具描述与其测试；不新建 context，不改 `aci-web-backend` 形状。
- defensive-contract-validator: **N/A** — 无新 handler API；五类输入边界已在既有 search/fetch 单测。本票锁的是首工具轨迹（黄金集），不是 empty/negative/overflow 入参。
- error-handling-enforcer: **N/A** — 不改失败语义（SC6）；零结果仍走既有 `ToolExecutionError`。
- complexity-anti-drift: **yes** — 声明结构是改 description 字符串 + 夹具用例；无新一层抽象、无计划深嵌套。
- minimal-change-verifier: **yes** — 一件激励纠偏；厂商/沙箱/硬拦 fetch 明确出局。退场若改，单独 T3，不与 T2 混 commit。

## Tasks (ordered by dependency)

1. **黄金集锁两职** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC3、SC5 前半（无夹具不准改文案）；`prompt-development.md`「先写夹具」；夹具跟 ACI web 工具测试放。
   - **Surface:** harness ACI tools 测试
   - **Acceptance:** 三条可判定输入已在集里且能单独跑：无 URL 的搜索/新闻句 → 期望首工具 `web_search`；用户已给 URL → 允许 `web_fetch`；搜空后续 → 不是猜 URL 的 `web_fetch`。实现尚未改 description 时，集已存在（红或待接线均可，但不能缺条）。
   - Status: [x] done

2. **description 对齐两职** — tag: `[implementation]`
   - **Inherits:** spec SC4、SC6；D9 正向触发；search 不是 fetch 前置；不写 do not / 不要；不改 soul / usage。
   - **Surface:** harness ACI `web_search` / `web_fetch`
   - **Acceptance:** 两件 description 表达「发现 / 阅读」而非「搜完必抓」；`d9-description-guard` 绿；T1 集在文案落地后按硬闸判定（真模型有 key 则 `npm run test:real-llm` 跑同一集，缺 key 记 Not run）。
   - Status: [x] done
   - [blocks: T1]

3. **溢出退场只凭真模型证据** — tag: `[decision]`
   - **Inherits:** spec SC5 后半、Boundaries「Confirms with human」、ADR-0043 现行序（search 先于 fetch 退）；未失败则保持。
   - **Surface:** `docs/adr/`（仅当要改序时产出修订）+ 既有 overflow 判定
   - **Acceptance:** T2 真模型已跑或显式 Not run。若发现句仍首抓：书面三选一（保持 / 两件同退 / fetch 先退）并只在改序时改 ADR-0043 + 退场数组。若已先搜或 Not run：记录保持现行序，不改 overflow 代码。
   - Status: [x] done
   - [blocks: T2]
   - **T3 决策（2026-09-09）：记录保持现行序。** T2 真模型黄金集 GREEN，SC1 首工具为 `web_search` 而非 `web_fetch`。不改 `DEFERRABLE_BUILTIN_RETIRE_ORDER`（`query_trace`, `list_sessions`, `get_record`, `web_search`, `web_fetch`），不修订 ADR-0043。

## Code review phase

全部 bullet 落地后做一轮 end-of-round 双轴 review，再对照 spec SC1–SC7。
