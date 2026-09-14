# settings.json 多 provider 模板（`llm.providers` 注册表 + TUI `/model`）

> 规格：`specs/tui-model-command.md`；决策：`docs/adr/0093-llm-provider-registry.md`。
> 本文件只给可复制的**形态模板** —— **仓库不内置任何供应商的连接信息**，baseUrl 与 key 由你自己填。
> 目标文件恒为用户层 `~/.iknow/settings.json`（`llm` 是用户层键，ADR-0084；写进项目文件会被丢弃）。

---

## 一、最小可用模板

把下面整段复制到 `~/.iknow/settings.json`，替换 `<...>` 即可：

```json
{
  "llm": {
    "model": "minimax-cn/MiniMax-M3",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "providers": [
      {
        "id": "minimax-cn",
        "baseUrl": "<你的 minimax anthropic 兼容 endpoint>",
        "apiKeyEnv": "MINIMAX_CN_API_KEY",
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax-M3",
            "contextWindow": 1000000,
            "maxTokens": 128000
          }
        ]
      }
    ]
  }
}
```

key 必须进**进程环境**。启动 iknow 前在同一个 shell 里 export：

```bash
export MINIMAX_CN_API_KEY=<你的订阅 key>
```

> **`apiKeyEnv` 只读进程环境**：`resolveProviderApiKey` 只查 `process.env[apiKeyEnv]`，
> 且 Node 入口**不会**装载 `<cwd>/.env.local` / `.env`（那两个文件只被 `loadIknowEnv`
> 读成 `fileMap`，服务的是 `llm.apiKey` 的占位符链路）—— **写进 `.env.local` 不生效**。
> 注入方式三选一：`export`（shell rc）/ 进程管理器的 environment / `node --env-file=<file>`
> （Node ≥ 20.6）。**变量必须在进程启动前就位**；启动后再 export / 再改文件都不会被读到，
> 需重启进程（settings-watch 只监听两个 `settings.json`，`.env.local` 不在监听面，也没有热重读）。
> 变量未设 → 启动期 typed 报错 `provider_api_key_missing: <providerId> (env <VAR> unset)`，
> **不会**静默回退到 `settings.llm.apiKey` —— provider 显式登记了 `apiKeyEnv`，就按 env 走。
>
> **对照 `llm.apiKey` 的 `${VAR}` 占位符**：那条链路**确实**会读 `.env.local`（`expandPlaceholders`
> 有 fileMap 兜底，见 `docs/llm-config-quickstart.md`）。两者刻意分离：provider 的 `apiKeyEnv`
> 是部署环境契约，占位符才是工作区配置 —— 别把这里的 key 写进 `.env.local` 后疑惑为什么没生效。

---

## 二、两个 provider（火山方舟 + minimax）示例

```json
{
  "llm": {
    "model": "minimax-cn/MiniMax-M3",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "providers": [
      {
        "id": "volcengine-ark",
        "baseUrl": "<火山方舟 anthropic 兼容 endpoint>",
        "apiKeyEnv": "VOLCENGINE_ARK_API_KEY",
        "models": [
          {
            "id": "deepseek-v3-250324",
            "name": "DeepSeek V3",
            "contextWindow": 128000,
            "maxTokens": 16384
          },
          {
            "id": "doubao-pro-256k",
            "name": "Doubao Pro 256K",
            "contextWindow": 256000,
            "maxTokens": 16384
          }
        ]
      },
      {
        "id": "minimax-cn",
        "baseUrl": "<你的 minimax anthropic 兼容 endpoint>",
        "apiKeyEnv": "MINIMAX_CN_API_KEY",
        "headers": { "X-Session": "iknow-dev" },
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax-M3",
            "contextWindow": 1000000,
            "maxTokens": 128000
          }
        ]
      }
    ]
  }
}
```

```bash
# 进程环境（同一 shell 里 export 后再启动；不写 .env.local，见上文）
export VOLCENGINE_ARK_API_KEY=<方舟 key>
export MINIMAX_CN_API_KEY=<minimax key>
```

切到方舟：TUI 里打 `/model` → `↑↓` 选 `volcengine-ark/deepseek-v3-250324` → `Enter`。

---

## 三、字段语义（SSOT 是 `src/config/settings.ts`，本表只作导航）

| 字段                                   | 必填 | 类型               | 说明                                                                                                                               |
| -------------------------------------- | ---- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `providers[].id`                       | ✅   | 非空串             | provider 路由 ID；模型路由串 `provider/model` 的**第一段**。                                                                       |
| `providers[].baseUrl`                  | ✅   | 非空串             | Anthropic 兼容 endpoint；命中该 provider 时覆盖 `IKNOW_LLM_BASE_URL`。                                                             |
| `providers[].apiKeyEnv`                | ✅   | 非空串             | 从 `process.env[apiKeyEnv]` 取 key 的**变量名**（不是 key 本身）。                                                                 |
| `providers[].headers`                  | ❌   | `{string: string}` | 可选，装进 SDK client 的 `defaultHeaders`（一次性，非 per-call）。                                                                 |
| `providers[].models`                   | ✅   | 非空数组           | 该 provider 下的模型清单；少于 1 条 → 整条 provider 丢弃。                                                                         |
| `models[].id`                          | ✅   | 非空串             | 模型路由串的**第二段**。                                                                                                           |
| `models[].name`                        | ❌   | 非空串             | 显示名（picker / 列表用）。                                                                                                        |
| `models[].contextWindow` / `maxTokens` | ❌   | 正数               | 仅供展示与后续扩展；V1 不改写全局 `IKNOW_LLM_*` env。                                                                              |
| `llm.model`                            | ✅   | 非空串             | 当前模型路由 ID。命中 providers → 走该 provider；**未命中 → 走旧的 `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey`**（back-compat）。 |

**校验纪律（drop-not-throw）**：`id` / `baseUrl` / `apiKeyEnv` 任一缺失或非非空串 → **整条 provider 丢弃**；`headers` 里非字符串的值 → 丢该键；`models` 项缺 `id` → 丢该模型；过滤后 `models` 为空 → 整条 provider 丢弃。丢弃静默发生（不抛错），被丢弃的字段不会覆盖你文件里的其它内容。

**`apiKey` 与 provider 的关系**：`llm.apiKey` 只在**未命中**注册表时使用。命中 provider 时 key 一律来自 `process.env[apiKeyEnv]`，`llm.apiKey` 被忽略（不参与回退）。

---

## 四、TUI `/model`

| 操作                        | 行为                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/model`                    | 打开 picker（每项一行 `provider/model`，当前项带游标）。providers 为空 → notice 提示未配置，不打开。 |
| `↑` / `↓`                   | 移焦点，clamp 在**可见窗口**内（前 12 项；V1 不滚屏，超出的条目只在「…N more」里计数）。             |
| `Enter`                     | 选定 → 写回 `~/.iknow/settings.json` 的 `llm.model` → 触发 env 重载 → **下一轮生效**。               |
| `Esc`                       | 关闭面板，不改变任何内容。                                                                           |
| `Space` / `Tab` / `←` / `→` | 忽略（无绑定语义）。                                                                                 |

> **生效边界**：与 `/thinking` 同款 —— 当前轮若已在跑，仍用旧 adapter 跑完；下一轮起走新 provider/model。
> **写回**：只改 `llm.model` 一个字段，文件里其它内容（apiKey / thinking / memory / permissions / 你手写的注释外字段）原样保留；原子写 + self-write 哨兵，不触发回环重载。

`/info` 会显示当前 `Model: <provider>/<model>`。

---

## 五、常见问题

- **provider 配了但 `/model` 看不到**：检查是否是 `id` / `baseUrl` / `apiKeyEnv` 有空缺、或 `models` 为空数组 —— 这几种会被静默丢弃。用 `/info` 确认当前 model 串，用启动期的 `[settings]` 警告确认文件层是否被采纳（`llm` 必须写**用户层**）。
- **启动报 `provider_api_key_missing`**：`apiKeyEnv` 指的变量在**进程环境**里没有值。在启动 iknow 的那个 shell 里 `export <VAR>=<key>`（或经进程管理器 / `node --env-file=<file>` 注入）后**重启进程**；写进 `<cwd>/.env.local` 不生效，启动后 export / 改文件也不会热重读（详见第一节的注入说明）。
- **想切回旧路径**：把 `llm.model` 改成不含 `/` 的串，或改成一个不在 `providers` 里的前缀 —— 即回退到 `IKNOW_LLM_BASE_URL` + `llm.apiKey`。
- **想加非 anthropic 协议的供应商**：V1 不支持（只走 `@anthropic-ai/sdk`）。见 ADR-0093「Why not 多格式」。

---

## 关联

- `specs/tui-model-command.md`（SC1–SC12）
- `docs/adr/0093-llm-provider-registry.md`
- `docs/llm-config-quickstart.md`（`settings.json` 单承载与 `llm` 用户层键纪律）
- `docs/adr/0084-project-settings-allowlist-and-permissions.md`
