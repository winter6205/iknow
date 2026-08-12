# iknow LLM 配置快速上手 — settings.json 单承载（ADR-0015）

> 本文件是 `.env.local` 模板 + `settings.json` 模板的落地文档。合并后从 PR 文件列表可见。
> SSOT = ADR-0015（`docs/adr/0015-llm-config-settings-single-source.md`）。

---

## 一、一句话总结

**所有模型 / 密钥配置都写在 `settings.json` 一个地方**（`~/.iknow/settings.json` 全局 + `<cwd>/.iknow/settings.json` 项目覆盖）。`.env.local` 退化为**纯 env var 装载器**——只负责提供占位符 `${VAR}` 的真值，不再直接当配置口。

---

## 二、`.env.local` 模板（复制到 `<cwd>/.env.local`，替换 `<ANGLE_BRACKET>`）

```env
# =============================================================================
# iknow .env.local — 纯 env var 装载器（ADR-0015 settings 单承载）
# 作用：只给 settings.json 里的 ${VAR} 占位符提供真值；不再配置 model / apiKey
# 已退役（不要写，写了也不读）：IKNOW_LLM_MODEL / IKNOW_LLM_API_KEY_ENV
# =============================================================================

# --- LLM 栈（provider / baseUrl 是项目级代码默认，一般无需覆盖）------------
# 默认 http://localhost:20128/v1；WSL 下用网关 IP（~/.bashrc 动态探测已配）
# IKNOW_LLM_BASE_URL=http://172.31.128.1:20128/v1

# --- 占位符真值（settings.json 里写 ${ANTHROPIC_AUTH_TOKEN} 时会读这里）-----
ANTHROPIC_AUTH_TOKEN=<your_real_api_key_here>

# --- 其它保留 env（可选，非必填）---------------------------------------------
IKNOW_LLM_MAX_OUTPUT_TOKENS=2048
IKNOW_LLM_TIMEOUT_MS=60000
IKNOW_LLM_TEMPERATURE=0
IKNOW_LLM_STREAM=on            # 流式臂开关 on|off，默认 on

# Web 工具出站代理（可选，trust_env=false 语义：显式配置才生效）
# 设 IKNOW_WEB_PROXY 后 web_fetch / web_search 走代理（HTTP 代理地址）
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
  }
}
```

- **`model`**：字面模型路由 ID（必填）。缺失 → fail-fast 抛「no LLM model configured in settings.llm.model」。
- **`apiKey`**：两种写法二选一——
  - 占位符（推荐）：`"${ANTHROPIC_AUTH_TOKEN}"`，解析时从 `process.env[VAR]` > `.env.local` > `.env` 找真值；
  - 字面值：`"sk-..."` 直接落 key（不依赖 env，但 key 会进 settings 文件）。
  - 不写 → `undefined`，消费点守卫抛「LLM mode needs API key. Set settings.llm.apiKey (literal or ${VAR} placeholder)...」。
- **`fallback`**（可选）：模型 fallback 路由 ID 数组，用户自配，代码不预置。

---

## 四、三种典型配法

| 场景                     | 做法                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **推荐**（key 不进文件） | settings `"apiKey": "${ANTHROPIC_AUTH_TOKEN}"` + `.env.local` 写 `ANTHROPIC_AUTH_TOKEN=<key>`                      |
| 临时切模型（不落盘）     | `export IKNOW_LLM_MODEL` 已退役。改：settings `"model"` 换成目标值，或临时 `export` 后 settings 用 `${VAR}` 占位符 |
| 字面 key（不依赖 env）   | settings `"apiKey": "sk-..."` 直接写                                                                               |

---

## 五、验证

```bash
# 配置后确认 iknow 能加载（settings 生效 + 真模型可达）
npm run probe:settings-model     # i135 A/B/C/D 四组，12/12 通过 = 配置正确
```

---

## 关联

- ADR-0015 `docs/adr/0015-llm-config-settings-single-source.md`
- `docs/integration-materials.env.example`（完整变量名文档）
- `plans/settings-model-extension.md`
