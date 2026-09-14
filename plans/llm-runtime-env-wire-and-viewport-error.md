# Plan: 运行时 EnvLoader 单源 + wire model + viewport API error

**Goal:** 注册表命中时 SDK 只发 `models[].id`；供应商失败在 TUI 画 `API error (status):` + 原文且不进 transcript；TUI 与 serve 共用一份 EnvLoader。
**Approach:** 先修 wire（根因），再修人对失败可见，最后收 env 单源（含 serve）。每刀可独立验收。
**Spec link:** `specs/llm-runtime-env-wire-and-viewport-error.md`
**ACR:** all-yes

```
bounded-context-guardian: yes — 路由/wire 解析留 config+adapter 装配；viewport 失败留 TUI；hub/serve 只订 EnvLoader；不新建 technical-layer 目录
defensive-contract-validator: yes — 空尾段 / 无 slash fallback / 超长 id / persist 与 reload 交错 / 供应商 HTTP 与无 cause 五类要有测
error-handling-enforcer: yes — 供应商失败 typed 抽 cause，viewport 必有非空正文；无空 catch；fallback 无 providers 走既有 EXIT
complexity-anti-drift: yes — 单一 wire 解析 + 单一 createAdapterFromEnv；禁止 thinking 复制一份 client 字段表
minimal-change-verifier: yes — 只这三刀；不改 picker UI、不改 Web 画条、不改用户 settings 范例仓库
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion (landing grain: operator global commit section)

**待写入:** (empty)

## Tasks (ordered by dependency)

1. **Wire model = models[].id** — tag: `[implementation]`
   - **Inherits:** ADR-0094 / spec SC1–SC3、SC7、SC8；`IknowEnv.llm.model` 仍是路由；命中注册表时 SDK `model` = 首个 `/` 之后；`providers` 空则整段上 wire
   - **Surface:** harness adapter 装配（`createAdapterFromEnv`）+ thinking 覆盖与其共用
   - **Acceptance:** 路由 `9router/Opus4.8` → 捕获的 SDK params.model 为 `Opus4.8`；`9router/ocg/deepseek-v4-flash` → `ocg/deepseek-v4-flash`；无 providers 时整段不变；thinking 开/关同一 wire
   - Status: [ ] pending

2. **Viewport API error** — tag: `[implementation]`
   - **Inherits:** spec SC4–SC5；#120 pending 仍丢；文案 `API error (status):` + 原文；不再用 `⚠ turn 未成功结束（protocolError）` 盖供应商失败
   - **Surface:** TUI 对话流 + hub/loop 把 `cause` 送到显示面（不 append 权威 messages）
   - **Acceptance:** 404 + 网关 message 出现在对话流且含原文子串；`loadSessionFile().messages` 长度不因该失败增加；`LOOP_DETECTED` 路径不变
   - [blocks: T1]
   - Status: [ ] pending

3. **runtime LLM env 含 serve** — tag: `[implementation]`
   - **Inherits:** spec SC6；EnvLoader `get`/`reload`/watch；hub `envProvider` + `reloadFromEnv`；生产路径 thinking 不读构造期 override 快照
   - **Surface:** session-api serve 入口 + 既有 TUI `run.tsx` 收口
   - **Acceptance:** serve 进程改用户层 `llm.model` 后下一条 POST `/messages` 的 wire 随新 env；TUI 与 serve 无第二套 adapter 工厂
   - [blocks: T1]
   - Status: [ ] pending
