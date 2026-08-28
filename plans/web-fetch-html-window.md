# Plan: web_fetch HTML window（原始 HTML + 续抓窗口）

**Goal:** 让编程智能体真正能看网页：`web_fetch` 可按窗口返回原始 HTML（或既有纯文本），截断信息放在模型可见头部以便 `start_chars` 续抓；传输层对响应体设字节上限，避免主进程被超大页面拖垮。不把 bash `network:true` curl 当看网页主路径。
**Approach:** 三个有序 tracer bullet（T1 字节上限 → T2 窗口协议 → T3 `as:html`），各 1 commit。bash / env-isolation / ADR-0022 本轮零改动。
**Spec / ADR:** ADR-0006（executor 20000 硬顶、不落盘、不信任工具自称截断字段）；web_fetch 既有 SSRF + `UNTRUSTED_BANNER`。不新开 ADR（无 one-way door：默认仍 `as:text`，raw 模式 opt-in）。
**Tracker:** 本文件 fallback（环境 `gh` 只读）。
**Out of scope:** 硬化 bash curl DNS/证书/代理 env；把 `HTTP(S)_PROXY` 加进 `BASE_ENV_WHITELIST`；HTML 落盘；`as:html` 作默认；复活 `STATIC_NETWORK_WHITELIST`；web_fetch output mask（另票）；JS 渲染 / 分页站点（续抓只覆盖「同 URL 字符窗口」）；`src/tui/tool-summary.ts`（继续只显示 url）；`src/harness/tools/executor.ts` 与 `tests/harness/tools/executor.test.ts`（T2 的 executor 端到端断言写在 `web-fetch.test.ts`，import `createExecutor`）。

**Affects (declared file list):**
- T1: `src/harness/aci/tools/network-guard.ts`, `tests/harness/aci/tools/network-guard.test.ts`
- T2: `src/harness/aci/tools/web-fetch.ts`, `tests/harness/aci/tools/web-fetch.test.ts`
- T3: `src/harness/aci/tools/web-fetch.ts`, `tests/harness/aci/tools/web-fetch.test.ts`, `CHANGELOG.md`
- Never this round: `src/harness/aci/tools/bash.ts`, `src/harness/sandbox/env-isolation.ts`, `src/harness/sandbox/bwrap.ts`, `src/harness/tools/executor.ts`, `tests/harness/tools/executor.test.ts`, `src/tui/tool-summary.ts`

## ACR verdict

Filled after the architecture-change-reviewer agent runs against this committed file.

```
bounded-context-guardian: yes — 字节上限落在 network-guard（已拥有 SSRF/重定向/传输的出口层）；GuardHttpResponse.body / fetchPublicResponse 签名不变，兄弟消费者 web-search.ts 无需改动，无反向依赖、无新增循环 import；executor / tool-summary / bash / env-isolation 已列 Never this round。
defensive-contract-validator: yes — T1/T2/T3 各自把 empty / negative / overflow / concurrent / exception 五类落成具体断言（L49-54 / L68-74 / L87），非标签占位。
error-handling-enforcer: yes — 所有失败路径抛 ToolExecutionError 且带 `${tool} failed:` / `web_fetch:` 前缀（L34/L45/L61/L80/L82）；禁止 null / 空串 / 半页冒充成功（L34/L54）；每处封顶与兜底预置 `// EXIT:`（L45/L48/L64/L83）。
complexity-anti-drift: yes — handler 只编排 compile → fetch → render → slice → format（L67），四个单一职责抽取（L35）；预算所有权唯一归 sliceFetchWindow（最坏 10 位数字算 headerReserve），formatFetchOutput 纯拼接永不缩短正文（L32/L64-65）；god-handler 明确禁止，预算逻辑无重复。
minimal-change-verifier: yes — 3 个有序 tracer bullet 各 1 commit（L4）；每 bullet 文件清单为全集，CHANGELOG.md 钉在 T3 同一 commit（L12/L92）；T1 声明 web_fetch 行为不变（L55），bullet 间无范围外溢；Out of scope（L7）+ Never this round（L13）双重围栏。
OVERALL: PASS — hand to writing-plans
```

## Decision constraints (from audit)

- 主路径永远是 `web_fetch` + `network-guard`，不是沙箱 curl。本机探针已证明 `network:true` 时 curl 可出网；默认隔离仍 `curl: (6)`。不改 fence env 白名单。
- 窗口元数据必须写在 `output` 文本头部（`URL/Status/Content-Type` 同块、横幅之前）。禁止只放 envelope `meta`（executor 不把 meta 给模型）。禁止依赖正文尾部 `...[truncated]`（超 20k 时会被 executor 从尾部吃掉）。
- 头部用纯文本 `Window:` 行（`start` / `returned` / `original_length`），不是 executor 会「信任后跳过封顶」的 JSON `truncated` 字段。executor 仍按序列化长度硬顶。
- 工具层保证整段 `output.length <= 20000`。`max_chars` schema 上限从 50000 收到 16000。正文预算由 `sliceFetchWindow` 独占：先用最坏位数（各 10 位数字，对齐 `executor.ts:99-101`）算出固定 `headerReserve`，`bodyBudget = min(maxChars, FETCH_OUTPUT_BUDGET - headerReserve)`（含可选 `\n...[truncated]` 长度）。`formatFetchOutput` 纯拼接，永不缩短正文。`Window: returned=` 必须等于横幅后正文（不含截断标记）的字符数。
- 生产 `fetch` 流式读 + 超限 abort；注入 stub 的超长 `body` 在 `fetchPublicResponse` 二次拒绝（defense in depth）。
- `as:html` 仅当 Content-Type 含 `html`；非法 `as`、负 `start_chars`、二进制类型 → `ToolExecutionError`，消息 `${tool} failed:` / `web_fetch:` 前缀，不返回空串冒充成功。
- 从 handler 抽出 `compileFetchInput` / `renderFetchBody` / `sliceFetchWindow` / `formatFetchOutput`，禁止把模式+窗口+格式塞进同一个 god-handler。
- D9：description 正面措辞，过 `d9-description-guard`。
- 不落盘完整 HTML（ADR-0006）。agent 若要把窗口 `write_file` 是它自己的选择，工具不代写。

## Tasks (ordered)

1. **T1 transport body byte cap** — tag: `[implementation]`
   - **Surface:** `src/harness/aci/tools/network-guard.ts` + `tests/harness/aci/tools/network-guard.test.ts`
   - **Behavior:**
     - 导出 `MAX_DECODED_BODY_BYTES = 1_048_576`（1 MiB）。
     - 抽出 `readUtf8WithByteLimit(stream, maxBytes)`：累计 UTF-8 字节，超限抛 `ToolExecutionError`（无工具前缀，由 `runFetch`/`failWithPrefix` 包一层）。`// EXIT:` 注释写明超限即 abort、不返回部分正文。
     - `createDefaultGuardDeps` 的生产 `fetch` 用 `response.body` 流式读，不再无条件 `response.text()`。无 body 流时退回 `text()` 后再 `assertDecodedBodyLimit`。
     - `followGuardedRedirects` 在每次成功 `runFetch` 后对 `response.body` 做 `Buffer.byteLength(..., "utf8")` 上限检查（stub 路径也能炸）。
     - Content-Length 若可解析且大于上限：在读流前拒绝（`// EXIT: Content-Length exceeds cap`）。Compressed CL 可能偏小——流式累计仍是权威。
   - **Tests (5 classes):**
     - empty：空 body / 无 Content-Length → 成功，返回 `""`。
     - negative：Content-Length 非法（非数字）忽略，走流式累计（不把非法 CL 当拒绝依据）。
     - overflow：stub body 超 1 MiB → `ToolExecutionError` 含 `body exceeds`；流式读在越过上限的第一块 abort。
     - concurrent：两路 fetch stub 一超一未超，互不串扰。
     - exception：caller abort 仍 `request aborted`；超限错误不吞、不返回截断半页当成功。
   - **Files:** 仅 network-guard + 其测试。web_fetch 行为本 commit 不变。
   - Status: [x] done

2. **T2 fetch window protocol** — tag: `[implementation]`
   - **Surface:** `src/harness/aci/tools/web-fetch.ts` + `tests/harness/aci/tools/web-fetch.test.ts`（executor 端到端也写在本文件，import `createExecutor`）。
   - **Behavior:**
     - 新增 `start_chars`（整数，默认 0，schema `minimum: 0`）。运行时：缺省 0；非有限数 / 非整数 → `ToolExecutionError`（`web_fetch: start_chars must be a non-negative integer`）；负数同样拒绝（不 clamp 到 0，避免静默错窗）。
     - `start_chars > original_length`：成功返回空正文窗口，`Window:` 行 `returned=0`，`original_length` 仍报真值（empty 类，不是失败）。
     - `MAX_MAX_CHARS` 50000 → **16000**；默认 12000、下限 500 不变。超上限 clamp 到 16000（既有 clamp 语义，改天花板）。
     - 预算所有权在 `sliceFetchWindow(text, start, maxChars, headerReserve)`：返回最终 `{ start, returned, body, marker }`。`headerReserve` 用 10 位数字占位算最坏头部+横幅长度（对齐 `executor.ts:99-101`），再减 `FETCH_OUTPUT_BUDGET=20000`。`// EXIT: bodyBudget is computed before slice; formatFetchOutput never shortens`。
     - `formatFetchOutput` 纯拼接：URL/Status/Content-Type/`Window:` / 横幅 / body / 可选 `\n...[truncated]`。数字不补零输出（reserve 按最坏位数预留，实际头部更短 → 总长严格 < 20000）。
     - 模型续抓以头部为准：下一窗 `start_chars = start + returned`。`returned` 等于横幅后、截断标记前的正文字符数。
     - handler 只编排：compile → fetch → render → slice → format。
   - **Tests:**
     - empty：空 HTML、`start_chars === length` → 空窗口 + Window 行 + banner。
     - negative：`start_chars: -1` / `"x"` → ToolExecutionError。
     - overflow：`max_chars: 100000` clamp 16000；超长 URL 时 `returned` 等于横幅后正文长度（不含截断标记）；经 `createExecutor` 后 payload **不含** executor `输出超长已截断` 标记且仍含 `Window:`。
     - concurrent：两 handler 不同 `start_chars` 并行，窗口不串。
     - exception：既有 SSRF / 非 2xx 不变。
     - 更新既有「clamp 到 50000」断言为 16000。
   - Status: [x] done

3. **T3 `as: text | html` + content-type gate** — tag: `[implementation]`
   - **Surface:** `src/harness/aci/tools/web-fetch.ts` + `tests/harness/aci/tools/web-fetch.test.ts` + `CHANGELOG.md`。description 更新过 D9。
   - **Behavior:**
     - `as` 缺省 `"text"`。仅允许 `"text"` | `"html"`；其它值 → `ToolExecutionError`。
     - `as:text`：现有 `htmlToText`（html CT）/ 原样（其它 text 家族：`text/*`、`application/json`、`application/xml`、`+json`/`+xml`）。
     - `as:html`：跳过 `htmlToText`，返回解码后的 markup 字符串；**仅当** content-type 含 `html`。否则 `web_fetch failed: content type is not html`（不回灌 PDF/乱码）。
     - 明确拒绝的 CT（两种 as 都拒）：`image/`、`audio/`、`video/`、`application/octet-stream`、`application/pdf`。`// EXIT: binary content-type rejected`。
     - `Representation: text|html` 写入头部（横幅前）。
     - 注入语料：script 正文 / 属性指令 / HTML 注释指令 — `as:html` 原样出现在 banner **之后**，banner 仍在。
     - SSRF / 超时 / 非 2xx / T1 字节上限 / T2 窗口全部沿用。
   - **Tests:** empty html + as html；as 非法（negative）；超大 html 走窗口（overflow）；并发 text vs html 两实例；二进制 CT exception。
   - Status: [x] done

## Persist

空。不写 ADR / CONTEXT.md。`CHANGELOG.md` 必须落在 T3 同一 commit（本计划恰好 3 commit）。

## Code review phase

三 bullet 全部落地后整轮 dual-axis review。未开始。
