# Spec: 运行时 EnvLoader 单源 + wire model + viewport API error

> 假设门:2026-09-14 操作员确认（本会话 LogicSync）。对照 ADR-0094。

## Glossary (exact copy from docs/CONTEXT.md)

- **session transcript**: 会话权威账本——单文件 append-only JSONL，每条事件有 id 与 parent；当前可见历史由 **rewind head** 投影，旧链保留。ADR-0027。
- **StopReason**: Loop Engine 的停止判别联合——016 五类（completed / maxTurns / nonSuccessStop / protocolError / emptyFinalResponse）末尾追加 017 的 `cancelled` 与 `timeout`，再追加 `fused`（本 run 工具环停滞，ADR-0029）；追加不重排，Transition 形状随之自动扩展。
- **LOOP_DETECTED envelope**: 环检测 trip 时追加的固定模板 user 消息，写入权威 messages 并落盘，下一问作为 priorMessages 进模型；对人至少经 `stop=fused` 可见。
- **viewport API error**: 供应商/API/连接失败给人看的对话流行：薄外壳 `API error (status):` + 服务商原文；不追加进 **session transcript**，下一轮不喂模型。ADR-0094。
- **wire model**: Anthropic SDK 请求体里的 `model` 字段 = 注册表 `models[].id` 原文（路由 `provider/model` 第一个 `/` 之后）。provider `id` 只查 baseUrl / key，不上 wire；需要前缀时把前缀写进模型名。ADR-0094。
- **runtime LLM env**: 进程内 LLM 装配的唯一运行时源——一份 EnvLoader（`get` / `reload` / watch）。TUI 与 serve 同挂；`createAdapterFromEnv(loader.get())` 是唯一 adapter 工厂；thinking 覆盖只改入参，不另造 client。ADR-0094。
- **`/model`(TUI)**: TUI 斜杠命令——打开 provider 注册表 picker（每项一行 `provider/model` + 当前项游标）；`↑/↓` 移焦点（clamp 首尾）、`Enter` 选定 + 持久化（写回 `~/.iknow/settings.json` 的 `llm.model` 路由 ID）+ env 重载、`Esc` 关闭且不持久化；provider 注册表为空 → typed notice。下一轮 adapter 用 **wire model**（`models[].id`），不是把路由整段送上网关。`/info` 仍显示路由 `Model: <provider>/<model>`。ADR-0093 / ADR-0094 / `specs/tui-model-command.md`。

## Objective

**What:** 三刀收口 LLM 运行时：(1) **wire model** 与路由 ID 分离；(2) 供应商失败以 **viewport API error** 画在 TUI 对话流、不进 **session transcript**；(3) **runtime LLM env** 单源（TUI + serve 同挂 EnvLoader，thinking 覆盖共用 `createAdapterFromEnv`）。

**Why:** 今日 `createAdapterFromEnv` / thinking 覆盖把 `settings.llm.model` 整段路由送上 SDK。注册表项 `9router` + `Opus4.8` 变成 wire `9router/Opus4.8`，9router 报 `No active credentials for provider: 9router`；裸名 `Opus4.8` 同口 200。失败再被压成 `StopReason` `protocolError` 空 notice。serve 未挂 loader，切配置要改多处快照。

**Who:** TUI / serve 操作员；实施面 = adapter 装配、hub env 源、TUI 失败呈现。

## Boundaries

### Does

- Provider 注册表命中时：SDK `model` = **wire model**（路由第一个 `/` 之后，等于 `models[].id`，可含更多 `/`）。`IknowEnv.llm.model` 仍是路由字面（ContextBar / `/info` 不变）。
- Provider 未命中 / `providers` 空：保持 `specs/tui-model-command.md` SC3 fallback，wire = `settings.llm.model` 整段。
- `createAdapterFromEnv` 与 thinking 覆盖走同一 wire 解析；thinking 不得另 new Anthropic client 工厂。
- TUI：`protocolError` / 传输耗尽等供应商失败 → 对话流 **viewport API error**（`API error (status):` + `cause`/网关原文）。无 status 则省略括号。不 `store.append` 该条为 user/assistant。
- `#120`：`protocolError` / `emptyFinalResponse` 仍不把失败 turn 的 pending 写入 **session transcript**。
- **LOOP_DETECTED envelope** 与其它 harness 控制流 envelope 不改。
- serve 启动构造 EnvLoader，`envProvider` + watch → `reloadFromEnv`，与 TUI 同语义白名单热更新。
- TUI 生产路径不再把构造期 `overrideEnv: { llm: currentEnv.llm }` 当作 thinking 轮的 env 源（`envProvider()` 优先，已有 hub 方法则收口调用点）。

### Confirms with human (已确认)

- 假设 1：不把 baseUrl 改成 `localhost`（WSL 上 20128 不在 loopback）。**确认。**
- 假设 2：模型名 `Opus4.8` 原样上 wire，装配层不拼 provider id。需要前缀时写进 `models[].id`。**确认。**
- 假设 3：对人失败条薄外壳 `API error (status):` + 原文；不进 transcript。**确认。**
- 假设 4：EnvLoader 单源含 serve；thinking 不第二套工厂。**确认。**
- 假设 5：实施顺序 wire → viewport 错误 → EnvLoader/serve。**确认。**

### Out of this spec

- Web / chat 对话流的 viewport API error 渲染（hub 可先出 DTO 字段；Web 画条下轮）。
- 给 9router / MiniMax 改用户 `settings.json` 或把 `172.31.128.1` 换成 localhost。
- mid-turn 换模型；OpenAI/Gemini 多 client。
- 把 API 失败写成喂模型的 user 消息（否决，#120）。
- 新 `wireModel` settings 字段。
- 为 EnvLoader 单源做整树 `TuiApp` 视觉重设计（允许去掉不必要的整树 remount，不改 chrome 语义）。

## Success Criteria

1. **SC1 (wire，注册表命中):** `settings.llm.model = "9router/Opus4.8"` 且 providers 含 `9router` + model id `Opus4.8` → `createAdapterFromEnv`（及 thinking 覆盖路径）发给 SDK 的 `model` === `"Opus4.8"`；`env.llm.model` 仍为 `"9router/Opus4.8"`。`bun test` 对应该用例退出 0。
2. **SC2 (wire，id 内含 `/`):** 路由 `9router/ocg/deepseek-v4-flash`（provider `9router`，model id `ocg/deepseek-v4-flash`）→ wire === `"ocg/deepseek-v4-flash"`。
3. **SC3 (wire，fallback):** `providers` 空 + 既有 SC3 路径 → SDK `model` 仍是 `settings.llm.model` 整段（与 `tui-model-command` SC3 不回归）。
4. **SC4 (viewport API error):** 捕获的供应商失败（含 `TransportRetryExhaustedError.cause` 为 HTTP 404 + 网关 JSON message）→ TUI 对话流出现一行以 `API error` 开头、含 status（若有）与原文子串；`loadSessionFile` 的 `messages` 比失败前不增加 user/assistant。既有 `⚠ turn 未成功结束（protocolError）` 文案不再用于该路径。
5. **SC5 (#120):** `protocolError` 回合后 session JSONL 头投影不含该失败 assistant/user 气泡对应的权威消息（与今日 pending 丢弃一致）。
6. **SC6 (runtime LLM env / serve):** serve 入口注入 `envProvider`；改用户层 `settings.json` 的 `llm.model`（白名单字段）后，下一条 POST `/messages` 的 wire 随 EnvLoader 更新（对齐既有 hub-hot-reload 语义，生产 serve 不再只靠启动时 `loadIknowEnv()` 一次性）。
7. **SC7 (thinking 单工厂):** thinking override 与无 override 路径对同一 env 解析出同一 **wire model** 与同一 `baseUrl`/`headers` 形状（单测对比，禁止第二套 client 装配抄一份字段表）。
8. **SC8 (回归):** `specs/tui-model-command.md` SC5–SC12 仍绿；`npm test` + `npm run typecheck` 退出 0。

## Open Questions

(none — 假设门已关。)

## Inherits / Changes

**Inherits:** ADR-0093（注册表 + `/model` 下一轮 + 路由落盘）；ADR-0094（本 spec 的三刀）；ADR-0084（llm 用户层键）；#120（protocolError 不 persist pending）；`specs/tui-model-command.md`（picker / persist / `/info` 显示路由）；EnvLoader + `reloadFromEnv` 白名单热更新（TUI `run.tsx` 已有）；`createAdapterFromEnv`。

**Changes:** 命中注册表时 SDK `model` 改为 **wire model**；TUI 供应商失败改为 **viewport API error**；serve 挂 **runtime LLM env**；thinking 覆盖并入 `createAdapterFromEnv`。

**Amends:** `specs/tui-model-command.md` SC2/SC10「下一轮走新 provider/model」——路由仍整段，**wire** 为尾段；Out of spec「chat / serve 不加 `/model`」保留（serve 仍无 slash），但 serve **要**挂 EnvLoader（文件热更新），不再「改 settings 必须重启」。

**待写入:** (empty — ADR-0094 与 CONTEXT 词条已落盘)

## architecture-change-reviewer

Affected (planned): `src/harness/build-engine.ts`（`createAdapterFromEnv`）、`src/session-api/thinking-override.ts`、`src/session-api/hub.ts`、`src/session-api/serve.ts`、`src/tui/app.tsx`、`src/tui/run.tsx`、对应 tests。

```
bounded-context-guardian: yes — 路由/wire 解析留 config+adapter 装配；viewport 失败留 TUI；hub/serve 只订 EnvLoader；不新建 technical-layer 目录
defensive-contract-validator: yes — 空尾段 / 无 slash fallback / 超长 id / persist 与 reload 交错 / 供应商 HTTP 与无 cause 五类要有测
error-handling-enforcer: yes — 供应商失败 typed 抽 cause，viewport 必有非空正文；无空 catch；fallback 无 providers 走既有 EXIT
complexity-anti-drift: yes — 单一 wire 解析 + 单一 createAdapterFromEnv；禁止 thinking 复制一份 client 字段表
minimal-change-verifier: yes — 只这三刀；不改 picker UI、不改 Web 画条、不改用户 settings 范例仓库
```
