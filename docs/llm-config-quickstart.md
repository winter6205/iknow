# iknow LLM 配置快速上手 — settings.json 单承载（ADR-0015）

> 本文件是 `.env.local` 模板 + `settings.json` 模板的落地文档。合并后从 PR 文件列表可见。
> SSOT = ADR-0015（`docs/adr/0015-llm-config-settings-single-source.md`）。

---

## 一、一句话总结

**所有模型 / 密钥配置都写在 `settings.json` 一个地方**（`~/.iknow/settings.json` 全局 + `<cwd>/.iknow/settings.json` 项目覆盖）。`.env.local` 退化为**纯 env var 装载器**——只负责提供占位符 `${VAR}` 的真值，不再直接当配置口。

---

## 二、`.env.local` 模板（复制到 `<cwd>/.env.local`，替换 `<ANGLE_BRACKET>`）

```env
# iknow .env.local — 纯 env var 装载器（ADR-0015 settings 单承载）
# 作用：只给 settings.json 里的 ${VAR} 占位符提供真值；不再配置 model / apiKey
# 已退役（不要写，写了也不读）：IKNOW_LLM_MODEL / IKNOW_LLM_API_KEY_ENV

# --- LLM 栈（provider / baseUrl 是项目级代码默认，一般无需覆盖）------------
# 默认 http://localhost:20128/v1；WSL 下用网关 IP（~/.bashrc 动态探测已配）
# IKNOW_LLM_BASE_URL=http://172.31.128.1:20128/v1

# --- 占位符真值（settings.json 里写 ${ANTHROPIC_AUTH_TOKEN} 时会读这里）-----
ANTHROPIC_AUTH_TOKEN=<your_real_api_key_here>

# --- 其它保留 env（可选，非必填）---------------------------------------------
IKNOW_LLM_MAX_OUTPUT_TOKENS=32000
IKNOW_LLM_TIMEOUT_MS=300000
IKNOW_LLM_TEMPERATURE=0
IKNOW_LLM_STREAM=on            # 流式臂开关 on|off，默认 on

# Web 工具出站代理（可选，trust_env=false 语义：显式配置才生效）
# 设 IKNOW_WEB_PROXY 后 web_fetch / web_search 走代理（HTTP 代理地址）

# web_search 后端选择（可选；settings.web.searchBackend 已承载，env 仅作覆盖）
# IKNOW_WEB_SEARCH_BACKEND=exa
```

> ⚠️ **红线**：`.env.local` 不要 commit 进 git（应在 `.gitignore`）。真实 key 只写这里（或 OS secret store / shell export），**绝不写进 `settings.json` 字面值**（除非你确实想字面落盘，但那样 SC20 遮蔽依赖内存值集，见 ADR-0015 Concrete Quiddity）。

---

## 三、`settings.json` 模板（`~/.iknow/settings.json` 或 `<cwd>/.iknow/settings.json`）

```json
{
  "llm": {
    "model": "ocg/deepseek-v4-flash",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "fallback": ["deepseek-flash-combo"]
  },
  "web": {
    "searchBackend": "exa"
  }
}
```

- **`model`**：字面模型路由 ID（必填）。缺失 → fail-fast 抛「no LLM model configured in settings.llm.model」。
- **`apiKey`**：两种写法二选一——
  - 占位符（推荐）：`"${ANTHROPIC_AUTH_TOKEN}"`，解析时从 `process.env[VAR]` > `.env.local` > `.env` 找真值；
  - 字面值：`"sk-..."` 直接落 key（不依赖 env，但 key 会进 settings 文件）。
  - 不写 → `undefined`，消费点守卫抛「LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder)...」。
- **`fallback`**（可选）：模型 fallback 路由 ID 数组，用户自配，代码不预置。

### 3.1 `settings.json` schema 全字段参考

`settings.json` 实际只承载 **`llm` 层与 `web` 层**，且只接受下表中的字段（`parseLlm` / `parseWeb` 逐字段校验，非法值丢弃不抛错）。字段来自 `src/config/settings.ts` 的 `IknowSettingsLlm` / `IknowSettingsWeb`（SSOT，勿以本表为准而以代码为准）。

| 字段路径                       | 类型                                              | 默认（未配）        | 说明                                                                                   |
| ------------------------------ | ------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| `llm.model`                    | string（trim 非空）                               | **fail-fast 抛错**  | 模型路由 ID 字面值，唯一来源，**必填**。                                               |
| `llm.apiKey`                   | string（字面或 `${VAR}` / `$VAR`）                | `undefined`         | key 来源；消费点守卫抛「LLM mode needs API key.」。                                    |
| `llm.fallback`                 | string[]（非空）                                  | `[]`                | fallback 路由 ID 列表，用户自配。                                                      |
| `llm.thinking`                 | `"off" \| "adaptive"`                             | `"off"`             | 缺省思考开关；`IKNOW_LLM_THINKING` env 显式设置时覆盖它（env > settings > 默认）。     |
| `llm.thinkingEffort`           | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | `""`（不发）        | 缺省 effort；`IKNOW_LLM_THINKING_EFFORT` env 显式设置时覆盖它。                        |
| `llm.maxTurns`                 | number（≥1 整数）                                 | `undefined`（无限） | 单次会话最大循环轮数；`IKNOW_LLM_MAX_TURNS` env 覆盖。                                 |
| `llm.compress.contextWindow`   | number（>0 有限）                                 | `200000`            | 模型上下文窗口；`IKNOW_MODEL_CONTEXT_WINDOW` env 覆盖。                                |
| `llm.compress.thresholdTokens` | number（>0 有限）                                 | `undefined`（推导） | proactive auto-compact 阈值；`IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS` env 覆盖。          |
| `web.searchBackend`            | `"bing" \| "exa" \| "tavily" \| "brave"`          | `"bing"`            | web_search 后端选择；`IKNOW_WEB_SEARCH_BACKEND` env 覆盖。keyed 后端另需对应 API key。 |

**带默认值的字段都是可选**：不写 `thinking` / `thinkingEffort` 时，thinking 默认 `off`、effort 默认不发 —— 这不是「没读到」，而是「你用了默认」。

**注意**：以下字段 **不在 settings.json 承载范围**，仍走 env（`process.env > .env.local > .env > 代码默认`），写进 settings.json 会被 `parseLlm` / `parseWeb` 忽略：

- `baseUrl`（`IKNOW_LLM_BASE_URL`）、`maxOutputTokens`（`IKNOW_LLM_MAX_OUTPUT_TOKENS`）、`timeoutMs`（`IKNOW_LLM_TIMEOUT_MS`）、`temperature`（`IKNOW_LLM_TEMPERATURE`）、`stream`（`IKNOW_LLM_STREAM`）
- `chat.showThinking`（`IKNOW_CHAT_SHOW_THINKING`）、`web.searchUrl` / `web.proxy`（`IKNOW_WEB_SEARCH_URL` / `IKNOW_WEB_PROXY`）、`mcp.connectTimeoutMs`（`IKNOW_MCP_CONNECT_TIMEOUT_MS`）

**例外**：`web.searchBackend`（web_search 后端选择）**已在 settings.json 承载**——`"bing" | "tavily" | "exa" | "brave"` 闭集，回退链 `IKNOW_WEB_SEARCH_BACKEND` env > `web.searchBackend` settings > 默认 `"bing"`。env 侧非法值抛 typed error；settings 侧非法值由 `src/config/settings.ts` 的 `parseWeb` 丢弃该字段（drop-not-throw，回落默认）。keyed 后端（exa / tavily / brave）还需对应 API key（`EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY`，env / .env.local 承载）。装配期字段：改完需重启进程生效（不在热更新白名单，见下文「热更新」）。

#### 完整示例（含思考默认档）

```json
{
  "llm": {
    "model": "ocg/deepseek-v4-flash",
    "apiKey": "${ANTHROPIC_AUTH_TOKEN}",
    "fallback": ["deepseek-flash-combo"],
    "thinking": "adaptive",
    "thinkingEffort": "medium"
  }
}
```

> **关于「热更新」**：settings.json 是**热更新生效**的 —— `src/config/settings-watch.ts`（`fs.watch` + `fs.watchFile`，100ms debounce）监听 `~/.iknow/settings.json` 与 `<cwd>/.iknow/settings.json`，改动后下一轮 postMessage 即以新 env 调 LLM。**热更新生效字段仅限白名单 9 项**——`model` / `apiKey` / `thinking` / `thinkingEffort` / `fallback` / `baseUrl` / `maxOutputTokens` / `temperature` / `stream`（即 `createAdapterFromEnv` 的全部入参面，详 `src/harness/build-engine.ts:124-142`）；不在白名单的字段，如 `llm.compress.contextWindow` / `llm.compress.thresholdTokens`（loop-engine `compress` 配置，hub 热重建不重跑）、`llm.maxTurns`（loop-engine `maxTurns`，同款原因）、`chat.showThinking` / `web.searchUrl` / `web.proxy` / `mcp.connectTimeoutMs`（装配期/`IknowEnv` 其它臂，非 adapter 入参）等，**改完需重启进程**才生效。reload 失败（坏 JSON / model 缺失 / apiKey 解析失败）→ **保留旧 env**（不崩进程，默认写 stderr `[settings-hot-reload] reload failed: ...`）。TUI chat 路径已接入：ContextBar 的 model 名与 thinking 基线实时刷新。`.env.local` / `.env` 同链路热重读（`loadIknowEnv` 每次 reload 重读）。
>
> **关于「反向通道 / 面板写回」**：运行时 `/thinking` / `/effort` 面板 **Esc 保存退出**会写回 `settings.json`（project 级文件存在写 project，否则写 user 级；合并 llm 子树，apiKey/model/secrets 等其它字段原样保留），写回不触发自身 reload（sha256 self-write 哨兵内容哈希命中即跳过，防回环；PR #413 文件 → 运行时单向通道不变）；写回失败（EACCES / 磁盘满 / 序列化失败）→ TUI notice 提示，in-memory override 保留、不 crash。面板内 Enter 固定 / Space-Tab 预览不落盘；重启后回到 settings.json（或默认）值。

---

## 四、三种典型配法

| 场景                     | 做法                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **推荐**（key 不进文件） | settings `"apiKey": "${ANTHROPIC_AUTH_TOKEN}"` + `.env.local` 写 `ANTHROPIC_AUTH_TOKEN=<key>`                      |
| 临时切模型（不落盘）     | `export IKNOW_LLM_MODEL` 已退役。改：settings `"model"` 换成目标值，或临时 `export` 后 settings 用 `${VAR}` 占位符 |
| 字面 key（不依赖 env）   | settings `"apiKey": "sk-..."` 直接写                                                                               |

---

## 五、云端开发 / 远程 LLM 端点

本机 WSL 网关（`http://localhost:20128/v1` / `9router`）在云端开发场景不可达。iknow 走任意 Anthropic 兼容 endpoint —— `IKNOW_LLM_BASE_URL` 切远程、模型路由 ID 写进 settings 即可，无需改代码。

**完整模板在项目根 `.env.example`（git 跟踪），复制到 `.env.local` 后填真值：**

```bash
cp .env.example .env.local     # .env.local 已 gitignore
```

**`.env.local` 关键三行（MiniMax 中国站示例）：**

```env
IKNOW_LLM_BASE_URL=https://api.minimaxi.com/anthropic
MINIMAX_API_KEY=<你的订阅 Key，从 https://platform.minimaxi.com/user-center/payment/token-plan 拿>
# 可选（默认 32000 / 300000 / 0 / on，按需覆盖）
IKNOW_LLM_MAX_OUTPUT_TOKENS=32000
IKNOW_LLM_TIMEOUT_MS=300000
IKNOW_LLM_TEMPERATURE=0
IKNOW_LLM_STREAM=on
```

**`<cwd>/.iknow/settings.json`（项目级，已 gitignore）补 model + apiKey 占位符：**

```json
{
  "llm": {
    "model": "MiniMax-M3",
    "apiKey": "${MINIMAX_API_KEY}"
  }
}
```

- `llm.model` 走字面值（env 已退役，ADR-0015）；MiniMax-M3 = 1M context 最新模型，支持 tool use / streaming / thinking。备选 `MiniMax-M2.7` / `MiniMax-M2.5` / `MiniMax-M2.1` / `MiniMax-M2` / `-highspeed` 变体。
- `llm.apiKey` 用 `${MINIMAX_API_KEY}` 占位符 → `expandPlaceholders` 从 `process.env > .env.local > .env` 链解析真值（`src/config/env.ts:495-498`）。
- 变量名不强制 `MINIMAX_API_KEY`：写什么变量名都行，settings.json 和 `.env.local` 里对齐即可（如 `"${ANTHROPIC_AUTH_TOKEN}"` + `ANTHROPIC_AUTH_TOKEN=<key>` 也可）。

**其它 Anthropic 兼容 endpoint（同一链路）：**

| 场景                            | `IKNOW_LLM_BASE_URL`                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| 本地 WSL 网关 / 9router（默认） | 留空 → `http://localhost:20128/v1`                                        |
| MiniMax 中国（Anthropic 兼容）  | `https://api.minimaxi.com/anthropic`                                      |
| MiniMax 国际（Anthropic 兼容）  | `https://api.minimax.io/anthropic`                                        |
| Anthropic 官方                  | `https://api.anthropic.com`                                               |
| 自建 proxy / 其它 OpenAI 兼容   | `https://<host>/v1`（需 OpenAI 兼容 client；iknow 默认走 Anthropic 协议） |

---

## 六、验证

```bash
# 配置后确认 iknow 能加载（settings 生效 + 真模型可达）
npm run probe:settings-model     # i135 A/B/C/D 四组，12/12 通过 = 配置正确
# 真远程 e2e（指向 IKNOW_LLM_BASE_URL + settings.llm.model 真实调用）
npm run test:real-llm
```

---

## 七、零摩擦：本机 → 云端三步走（跨机一键通）

适用：本地 WSL 网关在云端 VM 不可达，但本机仍能写文件 → 直接把配置文件 scp 到云端，**用户只填一行 API key**。

### 步骤 1：本地一次性配置（脚手架已就位）

`<cwd>/.env.example`（git tracked，commit `b17875f`）+ `<cwd>/.iknow/settings.json`（gitignore，本机已含 model + apiKey 占位符）已就位。用户只需：

```bash
cd /path/to/iknow
cp .env.example .env.local          # gitignore
chmod 600 .env.local                 # 收紧权限

vim .env.local
# 只需改这一行（其它不动）：
#   MINIMAX_API_KEY=<在这里填 MiniMax 订阅 Key>
# 改完后形如：
#   MINIMAX_API_KEY=eyJhbGciOi...
```

> `.iknow/settings.json` 已含 `model: "MiniMax-M3"` + `apiKey: "${MINIMAX_API_KEY}"`，无需再动；变量名变更时改这一处对齐即可。

### 步骤 2：scp 两个文件到云端

```bash
scp .env.local .iknow/settings.json user@cloud-vm:/path/to/iknow/
# .env.example 已 git tracked，云端 git pull 后自动有；.env.local + settings.json 是 gitignored 的，逐机传
```

### 步骤 3：云端 VM 验证

```bash
ssh user@cloud-vm
cd /path/to/iknow
git pull                            # 拉 .env.example（git tracked）
ls -la .env.local .iknow/settings.json   # 应都存在
npm run probe:settings-model        # 远程 A1/A2 应 PASS（settings 加载 + 占位符解析）
```

### 旋转 key

key 换时只改云端一行即可，无需重传 settings.json：

```bash
ssh user@cloud-vm
vim .env.local                       # 改 MINIMAX_API_KEY= 一行
```

settings.json 不变，env 链 (`process.env > .env.local > .env`) 自动热重读（`src/config/settings-watch.ts` 100ms debounce）。

### 新机器全新 clone

git clone 后本机没有 `.iknow/settings.json` —— 此时 iknow fail-fast 抛「no LLM model configured in settings.llm.model」。补建：

```bash
mkdir -p .iknow
cat > .iknow/settings.json <<'EOF'
{
  "llm": {
    "thinking": "adaptive",
    "model": "MiniMax-M3",
    "apiKey": "${MINIMAX_API_KEY}"
  }
}
EOF
chmod 600 .iknow/settings.json
cp .env.example .env.local && chmod 600 .env.local && vim .env.local
```

---

## 关联

- ADR-0015 `docs/adr/0015-llm-config-settings-single-source.md`
- `docs/integration-materials.env.example`（完整变量名文档）
- `plans/settings-model-extension.md`
- `.env.example`（项目根；git 跟踪；远程端点 + 占位符真值模板）
- commit `b17875f`（`.env.example` 首版）
