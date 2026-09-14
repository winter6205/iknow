# Plan: #1010 TUI `/model` 切模型(全局 provider 注册表)

**Goal:** 用户在 `~/.iknow/settings.json` 自维护 `llm.providers` 注册表(provider/baseUrl/apiKeyEnv/models);TUI 加 `/model` 挑选持久化;reloadFromEnv 热切换。

**Approach:** settings schema 加段;env loader 按 `provider/model` 解析找 baseUrl+apiKeyEnv;tui slash 加 `model` 命令;沿用 thinking-picker 同款 picker 模式(picker 组件复用 design-25 视觉);persist 加 `mergeModelPatch`;跑现有 hub.reloadFromEnv 链路。

**Spec link:** `specs/tui-model-command.md`

**ACR:**

```
bounded-context-guardian: yes — provider registry 落 config;client 工厂沿 anthropic adapter;picker 落 tui;不污染 harness core。
defensive-contract-enforcer: yes — 非法 providers 字段(id/baseUrl/apiKeyEnv/models 各自门禁)丢弃不静默;未知 provider 的 model 走 fallback baseURL/apiKey(back-compat);picker 空集 → typed notice,不抛。
error-handling-enforcer: yes — env var 未设 → typed 提示(不静默 fall back 到 settings.apiKey 字面);persist 失败 notice(与 thinking/memory 同款 fire-and-forget);reloadFromEnv 失败 notice,不留 half-applied state。
complexity-anti-drift: yes — 一档 factory:anthropic 格式单一 client;provider 只是 baseUrl + apiKeyEnv + headers 三元组,不抽 Plugin/Adapter 框架;picker 复用 thinking-picker 视觉语言,不重做圆角流光边框。
minimal-change-verifier: yes — 不动 model-adapter types;不动 thinking/effort 面板;不动 hard-wall;不改 loop-engine;不改 session transcript schema。
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

**Out of scope:**

- 多格式(OpenAI-compatible / Gemini native)— V1 只 anthropic。
- 模型级个性化参数(temperature / max_tokens per model)— 沿用全局 `IKNOW_LLM_*` env。
- per-call headers rotation — headers 仅在 adapter init 时一次性装。
- mid-turn 切 provider — 下一轮生效(与 thinking 切换同款 round-trip 边界)。
- 自动从 usage 计费 / token bucket — 不动。
- chat / serve / hub-bridge 的 `/model` 入口 — 本期只 TUI;chat 与 serve 走 settings.json 直改 + 重启。
- 仓库内置 provider 连接信息 — 用户自填,仅给例模板。

## Tasks (ordered by dependency)

1. **合同:provider 注册表 + /model 词条** — tag: `[decision]`
   - **Inherits:** spec Does;Anthropic 格式单 client;`provider/model` 形状;用户层键。
   - **Surface:** `docs/adr/`,`docs/CONTEXT.md`,`docs/architecture.md`(可选)
   - **Acceptance:** ADR-0093 accepted;CONTEXT 增 **LLM provider** + `/model` 词条。
   - Status: [ ] pending
   - [blocks: T2]

2. **settings schema: llm.providers + 校验** — tag: `[implementation]`
   - **Inherits:** spec provider / model 形状;非空串 id / baseUrl / apiKeyEnv;models 非空数组;headers 字符串→字符串;失败 drop-not-throw。
   - **Surface:** `src/config/settings.ts` + `tests/config/settings.test.ts`
   - **Acceptance:** 合法 payload 装载;非法字段(数组、坏类型、空串)→ 字段缺失(不抹 user);既有用例不退化。
   - Status: [ ] pending
   - [blocks: T3, T4]

3. **env loader: provider 解析 + back-compat** — tag: `[implementation]`
   - **Inherits:** `settings.llm.model = "provider/model"` 拆头查 provider;命中 → baseUrl/apiKey 走 provider;未命中 → 走 IKNOW_LLM_BASE_URL + settings.llm.apiKey(今日路径);provider.apiKeyEnv 名 env var 未设 → typed notice(由 build-engine / tui-deps 抛「no API key」),不静默回退。
   - **Surface:** `src/config/env.ts` + `tests/config/env.test.ts`
   - **Acceptance:** 双 provider 场景的 env 解析单测;无 providers 字段时行为与今日逐字节一致;apiKeyEnv 缺席 env → 抛错。
   - Status: [ ] pending
   - [blocks: T4, T5]

4. **persist-settings: mergeModelPatch + persistModelChanges** — tag: `[implementation]`
   - **Inherits:** 镜像 `mergeThinkingPatch`;只改 `llm.model`;`provider/model` 形状门禁(provider 与 model 段非空串,providers 注册表中存在 provider);其它字段原样保留。
   - **Surface:** `src/config/persist-settings.ts` + `tests/config/persist-settings.test.ts`
   - **Acceptance:** 单测覆盖有效 / 非法 / 跨 provider 切回原 provider / 与现有 thinking patch 共存;原子写 + self-write hash 不变。
   - Status: [ ] pending
   - [blocks: T5]

5. **TUI: /model slash 命令 + picker + 持久化接线** — tag: `[implementation]`
   - **Inherits:** spec Interaction;picker 复用 design-25 视觉(可与 thinking-picker 共享 helper);commit → persistModelChanges + reloadFromEnv;空 providers 列表 → notice。
   - **Surface:** `src/tui/slash.ts`、`src/tui/app.tsx`、新组件 `src/tui/model-picker.tsx`、`tests/tui/slash.test.ts`、新 `tests/tui/model-picker.test.ts`、`tests/tui/_fixtures.tsx`、`src/tui/run.tsx`
   - **Acceptance:** /model 打开 picker,↑↓ 移焦点,Enter 选 + 持久化 + reloadFromEnv,Esc 关闭;空集 → notice;slash 词表 / help / hint 行均含 model;既有用例不退化。
   - Status: [ ] pending
   - [blocks: T6]

6. **example 模板:docs/examples/settings-with-providers.md** — tag: `[docs]`
   - **Inherits:** spec 形态。
   - **Surface:** `docs/examples/settings-with-providers.md`
   - **Acceptance:** 用户可一键复制填自家 key;仓库不写真实密钥。
   - Status: [ ] pending
   - [blocks: T5]

7. **adapter 端确认走 baseUrl + headers** — tag: `[implementation]`
   - **Inherits:** T3 解析结果透传 `createRealAnthropicAdapter({ client, model, ... })`;`Anthropic` SDK 支持 `defaultHeaders` 字段(provider.headers 透传)。
   - **Surface:** `src/harness/model-adapter/anthropic-adapter.ts`、`src/harness/build-engine.ts` 的 `createAdapterFromEnv`、worker.ts / thinking-override.ts 的 client 构造点。
   - **Acceptance:** 真实 adapter 收到 provider headers 时一并写入请求;无 headers 行为与今日逐字节一致。
   - Status: [ ] pending
   - [blocks: T3]

8. **info 命令显示当前 provider/model** — tag: `[implementation]`
   - **Inherits:** infoLines 当前已含部分元信息;把当前 provider/model 单独一行(便于用户可见当前选择)。
   - **Surface:** `src/tui/info.ts`(或 app.tsx 内嵌);`tests/tui/info.test.ts`。
   - **Acceptance:** `/info` 显示当前 provider 与 model id;无 providers 段 → 只显 model。
   - Status: [ ] pending
   - [parallel] 可与 T5 同窗

## Harvest

**Settled (from conversation)**

- 用户在 `~/.iknow/settings.json` 自管 `llm.providers`;V1 仅 anthropic 格式。
- 模型 ID 沿用 `provider/model` 形状(今日 `minimax-cn/MiniMax-M3` 已走此形)。
- `/model` slash 命令: 打开 picker,选 → 持久化 + reloadFromEnv → 下一轮生效。
- 默认 model = `minimax-cn/MiniMax-M3`(今日默认)。
- 提供方:`volcengine-ark`(火山方舟)、`minimax-cn`(minimax),均为 anthropic 格式;仓库不内置连接信息,用户填自家 baseUrl + apiKeyEnv。

**Open for implementer**

- 非法 `llm.providers` 整段坏 JSON 解析失败 vs 字段级 drop:沿 settings.ts 既定 drop-not-throw 纪律。
- picker 行数预算(`modelPickerRows`):每个 provider+model 一行 + 边框 + marginBottom;provider 数 5+ 时滚屏 — V1 不滚屏,内容行 hard cap 12 + 「…N more」,与 thinking-picker 不挤行账同款。
- `model` 命名冲突 vs `TuiSlashCommand` 其它短名:已扫,无冲突。
- `model` 与 `/memory` 冲突:无。
- `infoLines` 当前已含 model 字段没?:待 T8 落定前确认。
- `/model` 错别字容错(`/model`、`/Model`、`/ mod`):slash.ts `parseTuiInput` 已小写化 head,与现状对齐。
