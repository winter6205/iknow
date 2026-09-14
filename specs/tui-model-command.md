# Spec: TUI `/model` 切模型(全局 provider 注册表)

> 假设门:2026-09-15 操作员确认(本会话)。对照材料不落盘。

## Glossary (exact copy from docs/CONTEXT.md)

- **LLM provider**: settings `llm.providers` 注册表里的一条记录 —— 含 id / baseUrl / apiKeyEnv / headers? / models[]。V1 仅 anthropic 格式;baseUrl 必填,apiKeyEnv 必填(运行时从 `process.env[apiKeyEnv]` 取密钥)。`provider.id` 与 `model.id` 用 `/` 拼成模型路由 ID(如 `minimax-cn/MiniMax-M3`)。ADR-0093。
- **provider registry**: settings.llm.providers 数组,**用户层键**(项目文件不采纳);合法 provider id = 小写短串,非空;非法字段 drop-not-throw。ADR-0093。
- **`/model`(TUI)**: TUI 斜杠命令 —— 打开 provider 列表 picker(每项一行 `${provider}/${model}` + 状态);↑↓ 移焦点、Enter 选 + 持久化 + reloadFromEnv、Esc 关闭(无 cancel/放弃路径,与 /thinking /effort 同款)。provider 注册表为空 → typed notice(不抛错,不打开 picker)。下一轮生效(与 thinking 切换同款 round-trip 边界)。ADR-0093。
- **fallback provider 路径**: 未知 provider(注册表未命中)走回今日路径 —— `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey`;back-compat,既有 `settings.llm.model = "minimax-cn/MiniMax-M3"` + 0 段 `llm.providers` 行为与今日逐字节一致。ADR-0093。
- **provider.apiKeyEnv 缺席 env**: 抛 `no API key for provider <id>` typed 错(由 build-engine / tui-deps 现有 apiKey 守卫);**不**静默回退到 `settings.llm.apiKey` 字面(provider 显式登记 apiKeyEnv 即声明走 env)。ADR-0093。

## Objective

**What:** 把「模型路由 ID」拆成两层 —— provider(baseUrl + apiKeyEnv)+ model(id + name + contextWindow + maxTokens);provider 在 `~/.iknow/settings.json` 注册表里声明;TUI `/model` 在注册表里挑。**不改 Anthropic SDK / client 形状 / loop-engine / thinking-picker / memory-picker / hard-wall / session transcript**。

**Why:** 今日模型路由 ID 是单一字面串,baseUrl 与 apiKey 来源走全局 env;操作员想给每个供应商单独配 endpoint + key(火山方舟走方舟域名 + 方舟 key,minimax 走 minimax 域名 + minimax key),且要 TUI 内一行切换。当前路径需要改 settings.json + 重启进程,体验差。

**Who:** TUI 操作员;实施面 = settings schema + env loader + persist-settings + TUI slash/picker + Anthropic SDK headers 透传。

## Boundaries

### Does

- `settings.llm.providers` schema(provider / model 两层结构) + 用户层键纪律(项目文件不采纳,沿 ADR-0084)。
- `loadIknowEnv` 解析 `provider/model`:
  - 命中 → `baseUrl = provider.baseUrl`,`apiKey = process.env[provider.apiKeyEnv]`;env 缺席 → typed 抛(由消费点守卫)。
  - 未命中 → fallback `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey`(back-compat)。
- TUI `/model` slash 命令 + picker:
  - 词汇:`/model`,VOCABULARY 加 `model`;`parseTuiInput` 无参也能命中。
  - picker UI:design-25 视觉语言(边框 2 + 内容 N + marginBottom 1),复用 `src/tui/designs/_color.ts` 的颜色数学与 `src/tui/designs/_geometry.ts` 的尺寸 helpers。
  - 键位:`↑/↓` clamp [0, providers.length-1] 移焦点、`Enter` 选定 + 持久化 + reloadFromEnv、`Esc` 关闭(无 cancel/放弃路径)、`Space/Tab` 忽略。
  - 空集:`/model` 直接 notice「未配置 providers —— 见 spec 例模板」,不打开 picker。
- persist-settings:`mergeModelPatch` + `persistModelChanges` 镜像 thinking/memory 同款(只改 `llm.model`,原 JSON 其它字段保留;原子写 + self-write hash 不变)。
- `infoLines`:`/info` 加一行「Model: `provider/model`」(无 providers 段时只显 model 串)。
- 状态栏(ContextBar)模型段:当前 model 命中注册表条目且该条配了 `models[].name` → 显示 `name`(如 `MiniMax M3`);未命中 / 无 name / 注册表缺席 → 原样回退路由串。
- Anthropic SDK headers 透传:`provider.headers?` 在 client 构造时一次性写入 `defaultHeaders`;无 headers → SDK 默认。

### Confirms with human (已确认)

- anthropic 格式单 client;不抽 Plugin/Adapter 框架。
- 提供方:`volcengine-ark`(火山方舟)+ `minimax-cn`(minimax);仓库**不**内置连接信息,用户在自家 settings.json 填。
- 默认 model = `minimax-cn/MiniMax-M3`(今日默认)。
- 切换生效边界 = 下一轮(与 thinking 同款)。
- 只 TUI 一入口;chat / serve 不加 `/model`(走 settings.json 直改 + 重启)。

### Out of spec

- 多格式(OpenAI-compatible / Gemini native);非 anthropic 协议的 client factory。
- 模型级个性化参数(temperature / max_tokens per model);per-call headers rotation。
- mid-turn 切 provider;自动从 usage 计费 / token bucket。
- 把 provider 注册表同步给 chat / serve / hub-bbridge。
- 仓库内置 provider 例配置(只入 docs/examples/)。
- 仓库内置 fallback `provider/model → IKNOW_LLM_BASE_URL` 链路的命名约定(只走 `provider` 注册表命中 / 未命中两档)。

## Success Criteria

1. **SC1(provider schema 装载):** `settings.llm.providers` 数组里每条合法 provider 经 `loadIknowSettings` 后仍在(逐字段透传);非法字段(id 空串 / baseUrl 非字符串 / apiKeyEnv 非字符串 / models 非数组)整条 drop。
2. **SC2(env 解析命中):** 注册表含 `minimax-cn` 且 `apiKeyEnv=MINIMAX_CN_API_KEY`,`process.env.MINIMAX_CN_API_KEY=sk-xxx`;`settings.llm.model = "minimax-cn/MiniMax-M3"` → `loadIknowEnv` 出 `{ baseUrl: <minimax baseUrl>, apiKey: "sk-xxx", model: "minimax-cn/MiniMax-M3" }`。
3. **SC3(env 解析 back-compat):** 0 段 `llm.providers` + `settings.llm.model = "minimax-cn/MiniMax-M3"` + `IKNOW_LLM_BASE_URL` env 设置 → `loadIknowEnv` 行为与今日逐字节一致(baseUrl = IKNOW_LLM_BASE_URL 的 trim;apiKey = settings.llm.apiKey 经 expandPlaceholders)。
4. **SC4(apiKeyEnv 缺席):** 注册表含 provider,但对应 env var 未设 → typed 抛「no API key for provider <id>」,build-engine / tui-deps 现有守卫接住(API key 缺失则 startup 拒绝)。
5. **SC5(persist model):** `/model` 选 `volcengine-ark/xxx-flash` → `~/.iknow/settings.json` 写回 `llm.model = "volcengine-ark/xxx-flash"`;其它字段(`thinking` / `apiKey` / `isolation` / `permissions`)原样保留;原子写;self-write hash 字符串返回。
6. **SC6(merge 非法 model):** `mergeModelPatch({ llm: { ... } }, { model: "" })` 或 `{ model: "no-slash" }` 或 `{ model: "unknown/foo" }`(unknown 不在注册表) → 抛 `TypeError`;调用方边界 catch 后走 notice。
7. **SC7(/model 词表):** `parseTuiInput("/model")` → `{ kind: "command", command: "model" }`;`/MODEL` 同(已小写化);`/mod` 未命中 → `{ kind: "unknown" }`;`/help` 含 `/model` 描述。
8. **SC8(picker 行为):** TUI `/model` 打开 picker(providers 数组非空时);↑↓ 移焦点;Enter → 写 settings + reloadFromEnv;Esc → 关闭无变更;providers 空 → notice「未配置 providers」。
9. **SC9(headers 透传):** provider.headers = `{ "X-Foo": "bar" }` → Anthropic SDK client.defaultHeaders 含 `X-Foo: bar`;无 headers → SDK 默认(行为与今日一致)。
10. **SC10(切换下一轮生效):** `/model` 选定后,当前 turn 仍在用旧 adapter 跑完(如有运行中);新 turn / 下一轮起走新 provider/model(`reloadFromEnv` 替换 adapter 与 baseUrl/apiKey)。
11. **SC11(info 显示):** `/info` 输出含 `Model: <provider>/<model>` 一行;无 providers 段时输出 `Model: <model string>`(原串)。
12. **SC12(不污染既有用例):** 既有 `settings.test.ts` / `env.test.ts` / `persist-settings.test.ts` / `tui/slash.test.ts` / `tui/app.test.tsx` 用例全部仍绿;`npm test` + `npm run typecheck` 退出 0。
13. **SC13(状态栏显示名):** 当前 model 命中注册表且有 `name` → 状态栏(ContextBar)显示 `name`;无 `name` / 未命中 / 无注册表 → 回退路由串;`/info` 仍输出原串(SC11 不变)。

## Open Questions

(none — 假设门已关。)

## Inherits / Changes

**Inherits:** settings 单承载(ADR-0084);用户层键不写项目文件(ADR-0084);env loader 单 SSOT(`src/config/env.ts`);persist atomic write + self-write hash(ADR-0084 T2);TUI slash 词表 + picker 模式(thinking-picker / memory-picker);thinking 切换的 round-trip 边界(下一轮生效)。

**Changes:** `settings.llm.providers` schema(新段);`loadIknowEnv` provider 解析分支;TUI slash 词汇加 `model`;`persist-settings` 加 `mergeModelPatch` / `persistModelChanges`;`/info` 加 provider/model 行;Anthropic SDK `defaultHeaders` 透传(provider.headers)。

**Amends:** `docs/CONTEXT.md`(增 **LLM provider** + `/model` 词条);`specs/security-guardrails.md`(零信任沙箱白名单默认描述不动,仅作 SSoT 注脚)。

## architecture-change-reviewer

```
bounded-context-guardian: yes — provider registry 落 config;client 工厂沿 anthropic adapter;picker 落 tui;不污染 harness core。
defensive-contract-validator: yes — provider / model 字段门禁 + env 解析命中/未命中两档 + apiKeyEnv 缺席 typed + persist 非法抛 TypeError + 空集 notice;不允许静默降级。
error-handling-enforcer: yes — typed 抛错(build-engine / tui-deps 守卫接住);persist fire-and-forget;reloadFromEnv 失败 notice;无静默 fallback 到字面 apiKey。
complexity-anti-drift: yes — 一档 factory(anthropic 格式);provider 仅 baseUrl + apiKeyEnv + headers 三元组;picker 复用 design-25 视觉 helpers。
minimal-change-verifier: yes — 不动 model-adapter types / loop-engine / thinking-picker / hard-wall / session transcript / 模型层 types。
```

affects: `src/config/settings.ts` `src/config/env.ts` `src/config/persist-settings.ts` `src/harness/model-adapter/anthropic-adapter.ts` `src/harness/build-engine.ts` `src/harness/subagent/worker.ts` `src/session-api/thinking-override.ts` `src/tui/slash.ts` `src/tui/app.tsx` `src/tui/run.tsx` `src/tui/model-picker.tsx`(新) `tests/config/settings.test.ts` `tests/config/env.test.ts` `tests/config/persist-settings.test.ts` `tests/tui/slash.test.ts` `tests/tui/app.test.tsx` `tests/tui/model-picker.test.ts`(新) `docs/CONTEXT.md` `docs/adr/0093-llm-provider-registry.md`(新) `docs/examples/settings-with-providers.md`(新)

## Example

最小用户 settings.json(填实际值即可):

```jsonc
{
  "llm": {
    "model": "minimax-cn/MiniMax-M3",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}", // 仅 fallback 路径使用;provider 命中时不读
    "providers": [
      {
        "id": "volcengine-ark",
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "apiKeyEnv": "VOLCENGINE_ARK_API_KEY",
        "models": [
          {
            "id": "deepseek-v3-250324",
            "name": "DeepSeek V3",
            "contextWindow": 128000,
            "maxTokens": 16384,
          },
          {
            "id": "doubao-pro-256k",
            "name": "Doubao Pro",
            "contextWindow": 256000,
            "maxTokens": 16384,
          },
        ],
      },
      {
        "id": "minimax-cn",
        "baseUrl": "https://api.minimax.chat/v1",
        "apiKeyEnv": "MINIMAX_CN_API_KEY",
        "headers": { "X-Session": "iknow-dev" }, // 可选
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax-M3",
            "contextWindow": 1000000,
            "maxTokens": 128000,
          },
        ],
      },
    ],
  },
}
```

切到火山方舟:`TUI /model → 选 volcengine-ark/deepseek-v3-250324 → Enter`。
