/**
 * Load iknow runtime config from process.env + optional `.env` / `.env.local` (cwd)
 * + `.iknow/settings.json` (#353, loop 配置的单一事实源)。
 *
 * settings-model-extension (#164 第二阶段) — LLM 配置收敛到 settings.json 单承载:
 *   - `settings.llm.model` 是模型路由 ID 的**字面值**唯一来源（无占位符、无 env 回退）。
 *     缺失 → fail-fast 抛「no LLM model configured in settings.llm.model」（见
 *     `LLM_MODEL_MISSING_MESSAGE`）。
 *     `IKNOW_LLM_MODEL` env 支已退役（不再读取）。
 *   - `settings.llm.apiKey` 接受字面值或 `${VAR}` 占位符，经 `expandPlaceholders`
 *     从 `process.env[VAR]` 优先、`.env.local` / `.env` 兜底解析；解析不到 →
 *     undefined（消费点守卫抛「LLM mode needs API key.」）。
 *     `IKNOW_LLM_API_KEY_ENV` env 支已退役（不再读取），apiKey 不再依赖 env 变量名。
 *   - `settings.llm.fallback` / `maxTurns` / `compress` 保留（用户自配）。
 * 其它字段保持既有 `process.env > .env.local > .env > hardcoded defaults`。
 *
 * Never logs secret values.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  loadIknowSettings,
  type IknowSettings,
  type IknowSettingsLlmProvider,
  DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS,
} from "./settings.js";
import { LLM_MODEL_MISSING_MESSAGE } from "./messages.js";
import {
  PRODUCT_ROOT_ENV_KEY,
  WORKSPACE_ROOT_ENV_KEY,
} from "./workspace-root.js";

export interface LlmEnv {
  baseUrl: string;
  /**
   * 模型路由 ID（settings.llm.model 字面值，trim 后必填）。
   * env loader fail-fast 保证有值（settings 唯一来源，无任何代码默认）。
   */
  model: string;
  /**
   * ADR-0093 provider 命中时的额外请求头（settings.llm.providers[i].headers）。
   * 只有 `provider/model` 命中注册表且该 provider 配了非空 headers 才有值；
   * 其余路径（provider 未命中 / 无 providers 段）**键缺席**，不写空对象 ——
   * 消费方据此判断是否透传 `defaultHeaders`。
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * 模型 fallback 路由 ID 列表（来自 settings.llm.fallback，用户自配）。
   * 未配置 → []（无兜底；fallback 的消费方自行决定是否/如何使用）。
   */
  fallback: string[];
  /**
   * LLM API key（settings.llm.apiKey 经 `expandPlaceholders` 解析）。
   * 字面值或 `${VAR}` 占位符解析成功 → 真实密钥；解析失败 → undefined。
   * 消费点守卫：!env.llm.apiKey 时 build-engine / tui-deps / thinking-override
   * 抛「LLM mode needs API key.」（不允许硬编码兜底）。
   */
  apiKey: string | undefined;
  maxOutputTokens: number;
  temperature: number;
  /**
   * #151 T4 请求侧 thinking 控制臂:
   *   - "off"      → 不发送 thinking / output_config(默认)
   *   - "adaptive" → 发送 thinking:{type:'adaptive'};effort 非空时再追加 output_config:{effort:N}
   * 非法值 → 回退 "off"。
   */
  thinking: "off" | "adaptive";
  /**
   * #151 T4 effort 档位:空 → 不发送 output_config。
   * 非法值 → 视同空。
   */
  thinkingEffort: "" | "low" | "medium" | "high" | "xhigh" | "max";
  /**
   * #179 T6 (#147 D0) 流式臂开关:
   *   - "on"  → adapter 走 `client.messages.stream(...)`(默认)
   *   - "off" → 非流式回退臂(`messages.create`,017 A1 既有行为)
   * 非法值 → 回退 "on" 且不崩溃(对齐 thinking flag 的回退纪律,方向相反)。
   */
  stream: "on" | "off";
  /**
   * plan T5: 单次会话最大循环轮数上限(可选正整数)。
   * `undefined`(默认)= 无限(loop-engine 无轮数上限);
   * 显式配置时 loop-engine 达上限即停(超限 throw + reactive compact 分支归 loop-engine)。
   * 值域校验:非整数 / < 1 由 CLI `--max-turns` 解析层拒绝(parse-args.ts),
   * env 侧走 envOptionalInt(未设 / 空 / 非数字 → undefined,不抛错)。
   */
  maxTurns?: number;
  /**
   * #358 T1: 单次 LLM 调用竞速上限(per-call,毫秒)。
   * env 链:`envOptionalPositiveInt("IKNOW_LLM_TIMEOUT_MS") ?? mergedSettings.llm?.timeoutMs ?? 300_000`。
   * 第三层 300_000（5 min）对齐 coding-agent 单次调用（thinking + 长 tool_use），
   * 不是 MCP 连接超时。env / settings 显式值仍覆盖。
   */
  timeoutMs: number;
  /**
   * #742 T1 / CONTEXT「model-call idle」:流式臂上「模型一个增量都不出」的
   * 静默上限(毫秒)。到点落既有 `StopReason: timeout`,不新增停因;
   * `stream=off` 无增量可重置它,harness 侧按缺席处理。
   *
   * env 链:`envOptionalPositiveInt("IKNOW_LLM_IDLE_TIMEOUT_MS") ?? settings.llm.idleTimeoutMs ?? 300_000`。
   * 第三层 5 分钟(T2 #transport-continue-persist 从 2 分钟上调):正常出字时
   * 供应商 delta 是亚秒级间隔,连续数分钟一个增量都没有 = 这条连接大概率已废;
   * 但长 thinking / 32k 生成前的排队与上游限流经常超过 2 分钟,旧值会把
   * 「还在想」误判成断流。idle 钟从 step 起就在跑,取值必须给首 delta 前的
   * 排队留足余量;UI 侧 ~20s 静默只改 notice 文案(不等待、不打断)。
   *
   * 可选而非必填:`IknowEnv` 字面量在测试 / 脚本里有几十处手写点,新增必填
   * 字段会把 T1 的改动摊到这些无关文件上(minimal-change)。生产装配一律走
   * `loadIknowEnv`,它总会填上本字段。
   */
  idleTimeoutMs?: number;
  /**
   * #742 T1 / CONTEXT「模型调用硬顶」:流式臂上从本次 `adapter.step` 起算的
   * **有限**上限(毫秒),到点即使仍有增量也落 `timeout`(CONTEXT _Avoid_:
   * 硬顶调成无限当验收)。
   *
   * env 链:`envOptionalPositiveInt("IKNOW_LLM_HARD_CAP_MS") ?? settings.llm.hardCapMs ?? 900_000`。
   * 第三层 15 分钟:必须严格大于今日单钟默认 300_000,否则"持续出字的调用不被
   * 从开打起算的墙钟误杀"这条验收在默认配置下不成立;取单钟默认的 3 倍,覆盖
   * extended thinking + 32k 输出的最长合理单步,同时保持有限。
   *
   * 流式臂上它取代 `timeoutMs` 当墙钟(`timeoutMs` 仍是 `stream=off` 的单钟)。
   * 可选原因同 `idleTimeoutMs`。
   */
  hardCapMs?: number;
}

/**
 * #152 T5:thinking 可见面控制臂(env flag → env SSOT)。
 *
 * `IKNOW_CHAT_SHOW_THINKING` 值域 `"off" | "on"`(大小写不敏感)。
 * 非法值 → 回退 `false`。默认 off(thinking 不进答案正文)。
 */
export interface ChatEnv {
  /**
   * #152 T5:是否在回答中显示模型 thinking 文本。
   * `false`(默认)= 不显示,保持既有 chat 投影行为不变;
   * `true` = 在答案文本前以区隔样式显示 thinking。
   */
  showThinking: boolean;
}

/**
 * ACI Web 类工具的 env 配置臂（web_search 端点覆写 + 出站代理 + 可插拔后端）。
 *
 * `IKNOW_WEB_SEARCH_URL`：可选 HTML 搜索端点覆写（私网后端 / 测试用）。
 * 空 → undefined（web_search 落默认 DuckDuckGo html 端点）。
 *
 * `IKNOW_WEB_PROXY`：可选出站 HTTP(S) 代理 URL（trust_env=False 语义 ——
 * 显式配置才生效，
 * 不读系统 HTTP(S)_PROXY）。装配方在 network-guard 构造 ProxyAgent
 * dispatcher；非空时 web_fetch / web_search 出口走代理（远端解析 +
 * 出网，绕开本地 DNS 污染 / egress 阻断）。代理 URL 仍走与目标同套
 * 语法校验（协议 / host / 凭据）。
 *
 * `IKNOW_WEB_SEARCH_BACKEND` (#826 T1)：web_search 后端选择（闭集
 * `"bing" | "tavily" | "exa" | "brave"`）。未设 / 空串 → 默认 `"bing"`
 * （HTML 解析路径不变，与 v0 字节级一致；spec Assumption 2）。非法值 →
 * 抛 typed `WebEnvConfigError( "invalid_search_backend" )`，**不**静默回退
 * default（区别于 envThinkingModeOptional 等"非法 → undefined"旧模式 —
 * 默认后端对配错敏感，配错比 fallback 更显眼）。
 *
 * `EXA_API_KEY` / `TAVILY_API_KEY` / `BRAVE_API_KEY` (#826 T1, vendor 命名)：
 * keyed 后端 API key，字面或 `${VAR}` 占位符；空串 / "yes" / 占位符解析失败
 * → undefined（与 settings.llm.apiKey 同 expandPlaceholders 链路）。
 *
 * 读取经本模块统一走 process.env > .env.local > .env 优先级（env.ts
 * SSOT，与 LLM key 同一加载链路）；工具自身不直读 process.env。
 */

/** #826 T1: 项目命名 — web_search 后端选择 env var 名。 */
export const SEARCH_BACKEND_ENV_KEY = "IKNOW_WEB_SEARCH_BACKEND";

/** #826 T1: vendor 命名 — 三个 keyed 后端的 API key env var 名。 */
export const EXA_API_KEY_ENV_KEY = "EXA_API_KEY";
export const TAVILY_API_KEY_ENV_KEY = "TAVILY_API_KEY";
export const BRAVE_API_KEY_ENV_KEY = "BRAVE_API_KEY";

/**
 * #826 T1 / spec Assumption 5：web_search 后端 id 闭集。
 * 顺序与 spec 保持一致（bing → tavily → exa → brave）；`envOptionalEnum` 判定
 * 对顺序不敏感（`Array.includes` 线性扫描），但保持字面形态便于错误消息 / 测试断言。
 * loader 装配反序列化走 `(typeof VALUES)[number]`。
 */
export const SEARCH_BACKEND_VALUES = [
  "bing",
  "tavily",
  "exa",
  "brave",
] as const;

/** #826 T1: 后端 id 字面联合（与 envOptionalEnum helper 默认值的强类型对齐）。 */
export type SearchBackendId = (typeof SEARCH_BACKEND_VALUES)[number];

/**
 * #826 T1: WebEnv typed-error 判别联合。
 * 当前仅 `invalid_search_backend` 一 kind —— `IKNOW_WEB_SEARCH_BACKEND` 不在
 * `SEARCH_BACKEND_VALUES` 闭集。镜像 `WorkspaceRootError` 的 plain-object
 * `satisfies` 形态（callers 走 `isWebEnvConfigError` 守卫，绝不 `instanceof Error`：
 * 后者会把 plain object 打成 `[object Object]`，kind/varName 全不可见）。
 * 保留 `expected`（而非消解为字符串）让 render 端按需重排闭集展示。
 */
export type WebEnvConfigError = {
  kind: "invalid_search_backend";
  varName: string;
  value: string;
  expected: readonly string[];
};

/**
 * #826 T1: WebEnv typed-error 判别守卫。
 * `kind` 必须命中已知闭集 + `varName`/`value` 都是 string + `expected` 是数组。
 * 与 `WorkspaceRootError` 的「kind + payload field 同款判定」语义对齐，避免与
 * `SessionStoreError` 的同名 kind 串台。
 */
export function isWebEnvConfigError(err: unknown): err is WebEnvConfigError {
  if (err === null || typeof err !== "object") return false;
  const maybe = err as Record<string, unknown>;
  return (
    maybe.kind === "invalid_search_backend" &&
    typeof maybe.varName === "string" &&
    typeof maybe.value === "string" &&
    Array.isArray(maybe.expected)
  );
}

/**
 * ADR-0093 / spec SC4：provider 命中但 `provider.apiKeyEnv` 对应的 env var
 * 未设（process.env 侧缺席 / 空串）时的 typed-error 判别联合。当前仅
 * `provider_api_key_missing` 一 kind。
 *
 * plain-object `satisfies` 形态（同 `WebEnvConfigError` / `WorkspaceRootError`）：
 * callers 走 `isLlmProviderConfigError` 守卫，**绝不** `err instanceof Error`
 * —— 后者会把 plain object 打成 `[object Object]`，kind / providerId /
 * apiKeyEnv 全不可见（`code-quality.md` typed-error catch 契约）。
 *
 * 安全契约：payload 只带 env var **名**（`apiKeyEnv`），不带任何密钥值；本
 * 模块不打印 / 不落盘任何密钥。**绝不**回退 `settings.llm.apiKey` 字面 ——
 * provider 显式登记 apiKeyEnv 即声明走 env，静默降级会把「配错 env 名」伪装
 * 成「用另一把 key 正常工作」。
 */
export type LlmProviderConfigError =
  | {
      kind: "provider_api_key_missing";
      providerId: string;
      apiKeyEnv: string;
    }
  | {
      kind: "provider_model_not_registered";
      model: string;
    };

/** ADR-0093：provider typed-error 判别守卫。 */
export function isLlmProviderConfigError(
  err: unknown
): err is LlmProviderConfigError {
  if (err === null || typeof err !== "object") return false;
  const maybe = err as Record<string, unknown>;
  if (maybe.kind === "provider_api_key_missing") {
    return (
      typeof maybe.providerId === "string" &&
      typeof maybe.apiKeyEnv === "string"
    );
  }
  if (maybe.kind === "provider_model_not_registered") {
    return typeof maybe.model === "string";
  }
  return false;
}

/**
 * ADR-0094 T1 / spec SC1-SC3, SC7：wire-model SSOT 解析。
 *
 * 物理世界 = Anthropic SDK 请求 body 的 `model` 字段 = providers.models[].id
 * （不含 provider 前缀）。`settings.llm.model` 是路由 ID（`provider/model` 字面），
 * provider id 仅用来查注册表拿 baseUrl/apiKey/headers，**绝不**上 wire —— 上 wire
 * 只走 models[].id。
 *
 * 行为：
 *  - 首个 `/` 拆分：左 = provider id（trim）、右 = model id（trim 后含其余 `/`）；
 *  - 无 `/`、左 / 右 trim 后空 → 原串 identity 返回（bare name 直传；`a/` /
 *    `/x` 等 miss 形态今日 loadIknowEnv 在装配前 typed 抛，本函数保持
 *    total，**不**再抛，便于单元测试与未来未配 providers 的回归路径）。
 *
 * 三装配点（build-engine / thinking-override / subagent worker）共用本函数，
 * 严禁各自内联重复。
 */
export function wireModelFromRoute(route: string): string {
  const slash = route.indexOf("/");
  if (slash === -1) return route;
  const tail = route.slice(slash + 1).trim();
  if (tail === "") return route; // `a/` 形态：miss 路径原样返回
  return tail;
}

/** ADR-0093：`LlmProviderConfigError` 文本渲染；只出 provider / env 名，绝不出密钥值。 */
export function formatLlmProviderConfigError(
  err: LlmProviderConfigError
): string {
  if (err.kind === "provider_model_not_registered") {
    return `provider_model_not_registered: ${err.model} (not in llm.providers)`;
  }
  return `provider_api_key_missing: ${err.providerId} (env ${err.apiKeyEnv} unset)`;
}

/**
 * ADR-0093：`settings.llm.model` 拆 provider 路由 ID 的解析结果。
 *  - `providerId`：按**第一个** `/` 拆分出的首段（trim 后非空，且尾段也非空，
 *    才算 provider 形态）；
 *  - `provider`：命中的 provider 记录；未命中 / 非 provider 形态 → undefined
 *    （`resolveLlmTransport` 会抛 `provider_model_not_registered`）。
 *
 * 尾段（modelId）只在形态判定里用一次：本函数把它 trim 后丢弃，不放进结果 ——
 * 消费方 `resolveLlmTransport` 只需要 providerId 查表；model 串本身（含尾段）
 * 由 `loadIknowEnv` 原样透传进 `IknowEnv.llm.model`。
 */
interface ResolvedLlmProvider {
  readonly providerId: string;
  readonly provider: IknowSettingsLlmProvider | undefined;
}

/**
 * ADR-0093：provider 命中时的密钥读取 —— **只读 `process.env[apiKeyEnv]`**，
 * 沿 spec 明文；**不**回落 `.env` / `.env.local` fileMap（与 apiKey 占位符
 * 链路刻意分离：provider 声明的 env var 是部署环境契约，不是工作区配置）。
 * 值 trim 后非空才算有效；未设 / 空串 / 全空白 → undefined。
 *
 * `typeof raw === "string"` 是 M2 同族守卫：`apiKeyEnv` 若恰是
 * Object.prototype 自有键（`constructor` / `__proto__` / `toString` 等），
 * `process.env[key]` 会命中原型拿到函数 / 对象，直接 `.trim()` 抛 TypeError
 * 而非 typed 错。非字符串一律按「未设」处理 → 落 typed `provider_api_key_missing`
 * （fail-safe：绝不拿非 env 值当密钥用）。
 */
function resolveProviderApiKey(apiKeyEnv: string): string | undefined {
  const raw = process.env[apiKeyEnv];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.trim();
}

/**
 * ADR-0093 / spec SC2：`settings.llm.model` 的 `provider/model` 拆分与注册表
 * 查找。**未命中 / providers 缺席 → typed 抛**（`provider_model_not_registered`），
 * 不再回落 `IKNOW_LLM_BASE_URL` + `settings.llm.apiKey` 旧路径。
 *
 *  - 首个 `/` 拆分，两段 trim 后都非空才算 provider 形态（`/x` / `x/` /
 *    `a//b` 形态 → 尾段为空 → 按未命中处理，不抛错、不拆第二刀）；
 *  - 尾段保留其余 `/`（`a/b/c` → 首段 `a`，尾段 `b/c` 参与形态判定后丢弃）；
 *  - `providers` 缺席 / 空数组 → 直接未命中（0 成本短路）；
 *  - 查找用 `p.id === providerId`（settings 装载层已 trim provider id）；
 *    注册表不去重，**首条命中生效**（后定义同 id 不覆盖，见 settings.ts）。
 */
function resolveLlmProvider(
  providers: ReadonlyArray<IknowSettingsLlmProvider> | undefined,
  model: string
): ResolvedLlmProvider {
  const slash = model.indexOf("/");
  const providerId = slash === -1 ? "" : model.slice(0, slash).trim();
  const tail = slash === -1 ? "" : model.slice(slash + 1).trim();
  if (slash === -1 || providerId === "" || tail === "") {
    return { providerId, provider: undefined };
  }
  const provider = providers?.find((p) => p.id === providerId);
  return { providerId, provider };
}

/**
 * ADR-0093：`llm.baseUrl` / `llm.apiKey` / `llm.headers` 的三元装配。
 *
 * 命中（SC2）→ baseUrl = provider.baseUrl 去尾斜杠、apiKey =
 * `process.env[provider.apiKeyEnv]`、headers = provider.headers（缺席则不产出）；
 * apiKeyEnv 缺席 / 空 → 抛 typed `LlmProviderConfigError`（SC4），**绝不**回退
 * `settings.llm.apiKey` 字面。providers 缺席 / 空数组 / 未命中 →
 * `provider_model_not_registered`。
 */
interface ResolvedLlmTransport {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;
}

function resolveLlmTransport(
  mergedSettings: IknowSettings,
  model: string
): ResolvedLlmTransport {
  const providers = mergedSettings.llm?.providers;
  if (providers === undefined || providers.length === 0) {
    throw {
      kind: "provider_model_not_registered",
      model,
    } satisfies LlmProviderConfigError;
  }
  const { providerId, provider } = resolveLlmProvider(providers, model);
  if (provider === undefined) {
    throw {
      kind: "provider_model_not_registered",
      model,
    } satisfies LlmProviderConfigError;
  }
  const apiKey = resolveProviderApiKey(provider.apiKeyEnv);
  if (apiKey === undefined) {
    throw {
      kind: "provider_api_key_missing",
      providerId,
      apiKeyEnv: provider.apiKeyEnv,
    } satisfies LlmProviderConfigError;
  }
  return {
    baseUrl: provider.baseUrl.replace(/\/$/, ""),
    apiKey,
    // headers 缺席（含空对象——settings 装载层已把空映射折叠成字段缺席）→
    // 保持 undefined，不写 `{}`（spec 行为契约 5）。
    headers: provider.headers,
  };
}

export interface WebEnv {
  searchUrl: string | undefined;
  proxy: string | undefined;
  /**
   * #826 T1: 选定的 web_search 后端 id（`"bing" | "tavily" | "exa" | "brave"` 闭集）。
   * 回退链 env > settings.web.searchBackend > 默认 `"bing"`（settings-web-backend）。
   * 非法值 env loader 抛 typed `WebEnvConfigError`，**不**静默回退。
   */
  searchBackend?: "bing" | "tavily" | "exa" | "brave";
  /**
   * #826 T1: Exa API key（env `EXA_API_KEY`，vendor 命名）。
   * 字面密钥或 `${VAR}` 占位符经 expandPlaceholders 解析；
   * 未设 / 空串 / "yes" / 占位符解析失败 → undefined。
   */
  exaApiKey?: string;
  /**
   * #826 T1: Tavily API key（env `TAVILY_API_KEY`，vendor 命名）。
   * 同 exaApiKey 同款空态语义。
   */
  tavilyApiKey?: string;
  /**
   * #826 T1: Brave API key（env `BRAVE_API_KEY`，vendor 命名）。
   * 同 exaApiKey 同款空态语义。
   */
  braveApiKey?: string;
}

/**
 * #119 T1: 自动压缩配置臂(env SSOT, 透传至 harness/compress/)。
 *
 * `IKNOW_MODEL_CONTEXT_WINDOW`:模型上下文窗口大小(整数)。默认 200000,
 * 非数字 → 回退 200000(对齐 envInt 既有纪律, 不抛错)。
 *
 * `IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS`:proactive auto-compact 阈值(可选整数)。
 * 未设 / 空串 / 非数字 → undefined(由 threshold.ts 在 derive 时缺省推导
 * `window - 33000`, 硬校验 `threshold < window`)。提前校验归 T4 不归 env loader。
 */
export interface IknowCompressEnv {
  // 字段访问形如 `env.compress.contextWindow` / `env.compress.thresholdTokens`。
  contextWindow: number;
  thresholdTokens: number | undefined;
}

/**
 * #378 根因 B: MCP 连接超时配置臂(env SSOT, 透传至 createMcpManager.timeoutMsOverride)。
 *
 * `IKNOW_MCP_CONNECT_TIMEOUT_MS`:MCP server 连接超时毫秒(正整数)。
 * 默认 60_000(根因 B: 30s 被 npx -y cold start 击穿, 提到 60s 缓解)。
 * 非法值(非数字 / 负数 / 0)→ 回退 60_000(统一双轨, 零/负超时无意义)。
 */
export interface McpEnv {
  connectTimeoutMs: number;
}

/**
 * #358 T1: 子代理配置臂(透传至 harness/subagent/manager.ts 的 SIGTERM 计时器消费点)。
 *
 * `taskTimeoutMs` = 子代理整任务寿命上限(per-task wallclock, 毫秒)。
 * 与 `LlmEnv.timeoutMs`(per-call LLM 调用竞速)语义、命名、消费点全程分离(C9)。
 *
 * env 链:`envOptionalPositiveInt("IKNOW_SUBAGENT_TASK_TIMEOUT_MS") ?? mergedSettings.subagent?.taskTimeoutMs`。
 * env 层无第三层默认值(7200s 常量由 T2 的 manager 消费点声明,
 * 避免缺省值在两处声明, settings 单一承载通过 mirror 校验)。
 *
 * `maxConcurrentWorkers` = 同时处于 starting/running 的 worker 并发上限。
 * 未设 / 空 / 非数字 / 非正 → 默认 `DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS`(15)。
 *
 * ADR-0096 T2：值域扩到 `number | "unlimited"`；`"unlimited"` 仅 settings 来源
 * 产出（env 不接 unlimited 字面），由面板 / persist 反向通道落盘。
 */
export interface IknowSubagentEnv {
  /** 子代理整任务寿命上限(毫秒);env 不设 + settings 未配 → undefined。 */
  taskTimeoutMs: number | undefined;
  /** 子代理并发上限；loadIknowEnv 总会填入正整数默认值或 `"unlimited"`。 */
  maxConcurrentWorkers?: number | "unlimited";
}

export interface IknowEnv {
  llm: LlmEnv;
  /** #152 T5:thinking 可见面控制臂。 */
  chat: ChatEnv;
  /** ACI Web 类工具配置臂（web_search 端点覆写）。 */
  web: WebEnv;
  /** #119 T1: 自动压缩配置臂(透传至 harness/compress/)。 */
  compress: IknowCompressEnv;
  /** #378 根因 B: MCP 连接超时配置臂(透传至 createMcpManager.timeoutMsOverride)。 */
  mcp: McpEnv;
  /** #358 T1: 子代理配置臂(per-task wallclock; manager SIGTERM 计时器消费)。 */
  subagent: IknowSubagentEnv;
  /**
   * #672 T3: 工具环检测（默认开）。env `IKNOW_TOOL_LOOP_DETECTION` 与 settings.loop.detectToolLoop。
   */
  loop?: { detectToolLoop: boolean };
  /**
   * ADR-0019 (T1): workspace-root per-root state anchor, read from
   * `IKNOW_WORKSPACE_ROOT` via envOptional (canonical reader; empty/unset
   * → undefined). Consumers pass this into `resolveWorkspaceRoot({env})`
   * (priority chain `[explicit, env, cwd]`); the resolver validates the
   * path is absolute and exists, throwing a typed `WorkspaceRootError`
   * for relative / missing paths.
   */
  workspaceRoot: string | undefined;
  /**
   * T3 (plans/worktree-session-roots.md / ADR-0037 §4): 项目身份根，读
   * `IKNOW_PRODUCT_ROOT`。父会话 spawn 子代理时注入本变量，让 worker 的
   * rules / 项目 `AGENTS.md` / 项目 skills 发现落在**主仓**而不是它自己的
   * cwd（改绑后那是一棵 gitignored 的裸树）。unset → undefined，worker 回落
   * 到 cwd（未改绑时两者同值，字节不变）。
   */
  productRoot: string | undefined;
}

/** Placeholder values treated as "no real secret set" (case-insensitive). */
const API_KEY_PLACEHOLDERS = new Set(["yes"]);

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (v.startsWith("<") && v.endsWith(">")) continue; // unfilled placeholder
    out[k] = v;
  }
  return out;
}

interface EnvGetOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback?: string;
}

function envGet(opts: EnvGetOpts): string {
  const { file, key } = opts;
  const fallback = opts.fallback ?? "";
  const fromProc = process.env[key];
  if (fromProc !== undefined && fromProc !== "") return fromProc;
  if (file[key] !== undefined && file[key] !== "") return file[key]!;
  return fallback;
}

/** Optional string env: 未设 / 空串 → undefined（区别于 envGet 的 "" 兜底）。 */
function envOptional(opts: EnvGetOpts): string | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  return raw.length > 0 ? raw : undefined;
}

function envOptionalBool(opts: EnvGetOpts): boolean | undefined {
  const raw = envOptional(opts);
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  return undefined;
}

interface EnvIntOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback: number;
}

/** Integer env values (tokens, timeouts). Non-finite → fallback. */
function envInt(opts: EnvIntOpts): number {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : opts.fallback;
}

/**
 * #378 根因 B: 正整数 env values(MCP 连接超时等)。
 * envInt 只查 finite, 但 0 / 负超时无意义, 此处收紧为 > 0 才透传,
 * 否则回退 fallback(未设 / 非数字 / 负数 / 0 → fallback, 不抛错)。
 */
function envPositiveInt(opts: EnvIntOpts): number {
  const n = envInt(opts);
  return n > 0 ? n : opts.fallback;
}

interface EnvOptionalIntOpts {
  readonly file: Record<string, string>;
  readonly key: string;
}

/**
 * #119 T1: 可选整数 env values(如 auto-compact 阈值)。
 * 未设 / 空串 → undefined;否则 Number + isFinite + trunc 后返回,
 * 非数字 → undefined(回退纪律对齐 envInt, 不抛错)。
 */
function envOptionalInt(opts: EnvOptionalIntOpts): number | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/** Optional positive integer env values (timeouts). Non-positive → undefined. */
function envOptionalPositiveInt(opts: EnvOptionalIntOpts): number | undefined {
  const n = envOptionalInt(opts);
  return n !== undefined && n > 0 ? n : undefined;
}

interface EnvNumberOpts {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly fallback: number;
}

/** Float env values (e.g. temperature 0.0–2.0). Non-finite → fallback. */
function envNumber(opts: EnvNumberOpts): number {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : opts.fallback;
}

interface EnvFileKeyOpts {
  readonly file: Record<string, string>;
  readonly key: string;
}

/**
 * #151 T4 / S4: 解析 IKNOW_LLM_THINKING 值域 "off" | "adaptive"(大小写不敏感)。
 * 未设 / 空串 / 非法值 → undefined(区别于 envThinkingMode 的"非法回退 off"):
 * S4 需要三态(off / adaptive / 未设),未设时才能回退 settings.llm.thinking。
 */
function envThinkingModeOptional(
  opts: EnvFileKeyOpts
): "off" | "adaptive" | undefined {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  if (raw === "off" || raw === "adaptive") return raw;
  return undefined;
}

/**
 * #151 T4 / S4: 解析 IKNOW_LLM_THINKING_EFFORT 值域 "low" | "medium" |
 * "high" | "xhigh" | "max"。未设 / 空串 / 非法值 → undefined
 * (区别于 envThinkingEffort 的"非法视同空"):S4 需要区分"未设"以回退 settings。
 */
function envThinkingEffortOptional(
  opts: EnvFileKeyOpts
): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  switch (raw) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return raw;
    default:
      return undefined;
  }
}

/**
 * #152 T5: 解析 IKNOW_CHAT_SHOW_THINKING。合法值 "on" / "off"（大小写不敏感），
 * 非法值 → 回退 false（默认不显示 thinking）。
 */
function envShowThinking(opts: EnvFileKeyOpts): boolean {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  return raw === "on";
}

/**
 * #179 T6 (#147 D0): 解析 IKNOW_LLM_STREAM 值域 "on" | "off"(大小写不敏感)。
 * 默认 on(D0:流式为默认臂);非法值 → 回退 "on",不抛错。
 * 与 envThinkingMode 先例同构,仅回退方向相反(thinking 默认 off,stream 默认 on)。
 */
function envStreamMode(opts: EnvFileKeyOpts): "on" | "off" {
  const raw = envGet({ file: opts.file, key: opts.key }).toLowerCase();
  if (raw === "off") return "off";
  return "on";
}

interface EnvOptionalEnumOpts<T extends string> {
  readonly file: Record<string, string>;
  readonly key: string;
  readonly values: readonly T[];
  /** 缺省时未设返回 undefined（调用方走 settings / 默认值回退链）。 */
  readonly default?: T;
}

/**
 * #826 T1: 闭集 enum 解析器（IKNOW_WEB_SEARCH_BACKEND 等）。
 *  - 未设 / 空串 → `default`（给了 default 时）否则 undefined（settings-web-backend:
 *    未设与显式值需区分，调用方接 env > settings > 默认回退链）；
 *  - 命中 `values` 闭集 → 原样返回值（**区分大小写**，与 spec 字面形态对齐）；
 *  - 非空但不在闭集 → 抛 typed `WebEnvConfigError( "invalid_search_backend", ... )`，
 *    **不**静默回退 `default`。
 *
 * 与 `envThinkingModeOptional` 等"非法 → undefined"旧模式相反 —— 默认后端对配错敏感，
 * schema reject 比 silent fallback 更显眼。
 */
function envOptionalEnum<T extends string>(
  opts: EnvOptionalEnumOpts<T>
): T | undefined {
  const raw = envGet({ file: opts.file, key: opts.key });
  if (!raw) return opts.default;
  if ((opts.values as readonly string[]).includes(raw)) return raw as T;
  throw {
    kind: "invalid_search_backend",
    varName: opts.key,
    value: raw,
    expected: opts.values,
  } satisfies WebEnvConfigError;
}

/**
 * 占位符形态：`${VAR}` 或 `$VAR`。`expandPlaceholders` 与 settings.ts
 * `isApiKeyOrPlaceholder` 共用同一 VAR 名字符集（`[A-Za-z_][A-Za-z0-9_]*`）。
 */
const PLACEHOLDER_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 提取 value 中所有 `${VAR}` / `$VAR` 占位符的变量名（去重保序）。
 * 与 settings.ts `analyzePlaceholderSyntax` 共用同一正则源（防 drift）。
 * env-isolation 的 SC20 遮蔽名单也复用此函数（M1：多段 `${A}${B}` 与
 * 字面 + 占位符混合的合法形态都能提取出变量名）。
 */
export function extractPlaceholders(value: string): string[] {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const names = new Set<string>();
  value.replace(
    PLACEHOLDER_PATTERN,
    (_match, braced: string | undefined, bare: string | undefined) => {
      names.add(braced ?? (bare as string));
      return "";
    }
  );
  PLACEHOLDER_PATTERN.lastIndex = 0;
  return [...names];
}

/**
 * M2（prototype 注入）守卫 — `isPrototypeOwnKey`：
 * Object.prototype 自有键（`constructor` / `__proto__` / `toString` /
 * `hasOwnProperty` / `valueOf` 等）不是合法 env var 名 —— `process.env[name]`
 * 与 `fileMap[name]` 都会命中 Object.prototype 返回函数 / 对象，
 * `raw.trim is not a function` TypeError。任何路径读到这些键 → 拒绝。
 */
function isPrototypeOwnKey(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(Object.prototype, name);
}

/**
 * M2（prototype 注入）守卫 — `isPlainEnvName`：
 *  - 合法标识符形态（`[A-Za-z_][A-Za-z0-9_]*`）；
 *  - 非 Object.prototype 自有键（防 prototype 注入）；
 *  - `Object.hasOwn(process.env, varName)`（process.env 是真值源才走）。
 */
function isPlainEnvName(varName: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return false;
  if (isPrototypeOwnKey(varName)) return false;
  return Object.prototype.hasOwnProperty.call(process.env, varName);
}

/** 按优先级解析单个占位符变量：process.env[varName]（isPlainEnvName 守卫）→ fileMap[varName]。 */
function resolveValueFromFilename(
  varName: string,
  fileMap: Record<string, string>
): string | undefined {
  // M2 硬拒：任何 Object.prototype 自有键（包括 fileMap 显式同名 `constructor`）都不解析。
  if (isPrototypeOwnKey(varName)) return undefined;
  if (isPlainEnvName(varName)) {
    const fromProc = process.env[varName];
    if (fromProc !== undefined && fromProc !== "") return fromProc;
  }
  // fileMap 兜底：仅当 varName 是合法标识符、且 fileMap 自身拥有该键时读取
  // （防 fileMap 命中 Object.prototype；与 process.env 同款 hasOwn 守卫）。
  if (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(varName) &&
    Object.prototype.hasOwnProperty.call(fileMap, varName)
  ) {
    const fromFile = fileMap[varName];
    if (fromFile !== undefined && fromFile !== "") return fromFile;
  }
  return undefined;
}

/**
 * settings-model-extension：解析 settings.llm.apiKey 的字面值 / `${VAR}` 占位符。
 *
 *  - undefined → undefined（未配，消费点守卫抛「no API key configured」）；
 *  - 字面值（不含 `$VAR` / `${VAR}` 形态）→ 原样 trim 返回（设置文件里的字面
 *    密钥即真实密钥；含 `$IDENT` 形态被当作占位符解析，无 `$$` 转义）；
 *  - `${VAR}` / `$VAR` → 从 `process.env[VAR]` 优先、`fileMap[VAR]`（.env.local /
 *    .env 合并）兜底解析；任一变量解析不到（未设 / 空 / "yes" 占位符 /
 *    非普通环境名）→ 返 undefined（触发消费点守卫）；
 *  - `"yes"`（dotenv 风格占位符，大小写不敏感）→ 视同未设 → undefined。
 *
 * 多段占位符（如 `${A}${B}`）逐段解析后拼接；任一缺失整串返 undefined。
 * 非法占位符形态（如 `${}` / `${1VAR}` / `${VAR` 未闭合）→ undefined
 * （与 settings.ts `isApiKeyOrPlaceholder` 的丢弃语义对齐 —— 含 `${` 但不匹配
 * `${VAR}` 形态的串不是合法占位符也不是字面密钥）。
 * 本函数不打印 / 不落盘任何密钥值。
 */
export function expandPlaceholders(
  value: string | undefined,
  fileMap: Record<string, string>
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (API_KEY_PLACEHOLDERS.has(trimmed.toLowerCase())) return undefined;
  // 含 `${` 时先做 braced 残骸检测：所有 `${...}` 子串必须都是合法 `${VAR}`，
  // 残余 `${` 视为非法（`${}` / `${1VAR}` / `${VAR` 未闭合）→ undefined。
  // 必须在「字面短路」前判，否则 `${}` 等会被当作纯字面返回。
  if (trimmed.includes("${")) {
    const bracedOnly = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/g;
    const stripped = trimmed.replace(bracedOnly, "");
    if (stripped.includes("${")) return undefined;
  }
  const names = extractPlaceholders(trimmed);
  if (names.length === 0) return trimmed; // 字面密钥原样返回。
  let resolved = true;
  const out = trimmed.replace(
    PLACEHOLDER_PATTERN,
    (match: string, braced: string | undefined, bare: string | undefined) => {
      const varName = braced ?? (bare as string);
      const raw = resolveValueFromFilename(varName, fileMap);
      if (raw === undefined) {
        resolved = false;
        return match;
      }
      const val = raw.trim();
      if (!val || API_KEY_PLACEHOLDERS.has(val.toLowerCase())) {
        resolved = false;
        return match;
      }
      return val;
    }
  );
  return resolved ? out : undefined;
}

export function loadIknowEnv(
  cwd: string = process.cwd(),
  settings?: IknowSettings,
  home?: string
): IknowEnv {
  // process.env still wins via envGet; among files, .env.local overrides .env.
  // settings 参数是测试注入缝；不传时自动读取真实 settings 文件。ADR-0084 项目允许名单下
  // 项目文件只贡献 hooks / verify / secrets / permissions；本函数消费的 `llm` 是用户层键
  // （唯一来源 = `~/.iknow/settings.json`）。
  // home 参数透传给 loadIknowSettings：测试隔离 user 级 settings 用。显式注入固定该层，
  // 不依赖 ambient process.env.HOME；POSIX 上 os.homedir() 确实跟随 $HOME，靠它虽能工作，
  // 但隐式、易被破坏。
  const mergedSettings = settings ?? loadIknowSettings({ cwd, home });

  const file = {
    ...parseEnvFile(join(cwd, ".env")),
    ...parseEnvFile(join(cwd, ".env.local")),
  };

  // settings-model-extension：模型唯一来源 = settings.llm.model 字面值（无占位符、
  // 无 env 回退）。缺失 → fail-fast 抛错（不硬编码兜底）。IKNOW_LLM_MODEL 已退役。
  const modelRaw = mergedSettings.llm?.model?.trim();
  if (!modelRaw) {
    throw new Error(LLM_MODEL_MISSING_MESSAGE);
  }

  // ADR-0093：model 串必须命中 providers 注册表 → baseUrl/apiKey/headers 走
  // provider 三元组；未命中 / providers 缺席 → typed 抛。apiKeyEnv 缺席 → SC4。
  const transport = resolveLlmTransport(mergedSettings, modelRaw);

  return {
    llm: {
      baseUrl: transport.baseUrl,
      model: modelRaw,
      // headers 只在 provider 命中且配了非空 headers 时产出（不写空对象）。
      ...(transport.headers === undefined
        ? {}
        : { headers: transport.headers }),
      fallback: mergedSettings.llm?.fallback ?? [],
      // settings-model-extension：apiKey 来源 = settings.llm.apiKey（字面或 ${VAR}
      // 占位符）经 expandPlaceholders 解析；未配 / 解析不到 → undefined（消费点守卫）。
      // ADR-0093 provider 命中时由 transport.apiKey 接管（provider 显式登记
      // apiKeyEnv 即声明走 env，绝不回退这里的字面）。
      apiKey: transport.apiKey,
      maxOutputTokens: envPositiveInt({
        file,
        key: "IKNOW_LLM_MAX_OUTPUT_TOKENS",
        // Claude Code 主会话默认 CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000（可配到 64k）。
        // 按实际生成计费，帽本身不加价。不要再按单次任务（贪吃蛇 / 腕表 HTML）
        // 逐步加码。
        fallback: 32_000,
      }),
      // #358 T1: per-call LLM 调用竞速上限(env > settings > 300_000 fallback)。
      // 镜像 maxTurns 模式(envOptionalPositiveInt ?? settings),第三层 5 min：thinking +
      // 32k 生成常见超过 60s。MCP connectTimeoutMs 仍是 60s。
      timeoutMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_LLM_TIMEOUT_MS",
        }) ??
        mergedSettings.llm?.timeoutMs ??
        300_000,
      // #742 T1: 流式臂双钟(env > settings > 默认)。默认值理由见 LlmEnv 字段注释;
      // 不变式 idle < 硬顶、硬顶有限由 tests/harness/model-idle-hardcap-config.test.ts 钉。
      // T2 (#transport-continue-persist):默认 idle 从 120s 升到 minute-scale
      // 300s(~5 min)——长 thinking / 32k 生成常见超过 60s,旧值易误杀。env /
      // settings 覆盖优先级不变;hardCapMs 默认仍 900s,idle < hardCap 不变式
      // 仍由测试钉(300_000 < 900_000)。
      idleTimeoutMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_LLM_IDLE_TIMEOUT_MS",
        }) ??
        mergedSettings.llm?.idleTimeoutMs ??
        300_000,
      hardCapMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_LLM_HARD_CAP_MS",
        }) ??
        mergedSettings.llm?.hardCapMs ??
        900_000,
      temperature: envNumber({
        file,
        key: "IKNOW_LLM_TEMPERATURE",
        fallback: 0,
      }),
      // S4: settings.llm.thinking / thinkingEffort 回退（env > settings > 默认）。
      // Optional 解析保证三态：env 显式 off/adaptive 或合法 effort 直接赢；
      // 未设 / 空 / 非法 → undefined → 落 settings；两者皆缺 → off / ""。
      thinking:
        envThinkingModeOptional({
          file,
          key: "IKNOW_LLM_THINKING",
        }) ??
        mergedSettings.llm?.thinking ??
        "off",
      thinkingEffort:
        envThinkingEffortOptional({
          file,
          key: "IKNOW_LLM_THINKING_EFFORT",
        }) ??
        mergedSettings.llm?.thinkingEffort ??
        "",
      // #179 T6 (D0):流式默认开;非法值回退 on。
      stream: envStreamMode({
        file,
        key: "IKNOW_LLM_STREAM",
      }),
      // plan T5: 可选正整数;未设 / 空 / 非数字 → undefined(= 无限)。
      // #353: settings.llm.maxTurns 回退（env > settings）。
      maxTurns:
        envOptionalInt({
          file,
          key: "IKNOW_LLM_MAX_TURNS",
        }) ?? mergedSettings.llm?.maxTurns,
    },
    chat: {
      // #152 T5:默认 off（不显示 thinking，保持现状）。
      showThinking: envShowThinking({
        file,
        key: "IKNOW_CHAT_SHOW_THINKING",
      }),
    },
    web: {
      // 可选端点覆写：空 → undefined（web_search 落默认 DuckDuckGo html 端点）。
      searchUrl: envOptional({ file, key: "IKNOW_WEB_SEARCH_URL" }),
      // 可选出站代理：空 → undefined（network-guard 直连）。显式配置才生效。
      proxy: envOptional({ file, key: "IKNOW_WEB_PROXY" }),
      // #826 T1 + settings-web-backend: web_search 后端选择，回退链
      // env > settings.web.searchBackend > 默认 bing（对齐 #353 maxTurns 先例）。
      // env 未设返回 undefined（不与显式 "bing" 折叠），settings 侧非法值已在
      // parseWeb 丢弃；env 侧非法值仍抛 typed error（更显眼的配错面）。
      // 显式标注 T=SearchBackendId：helper 的 T extends string 默认会被
      // TS 推到 string 宽类型，丢失字面联合。
      // 注意：`?? "bing"` 使 IknowEnv.searchBackend 永不 undefined —— 三态
      // 「未设 ≠ 显式 bing」只在 helper 返回层保留，到 WebSearchToolDeps.backend
      // 时已折叠（backend_unset_with_key fail-closed 防线因此仅测试路径可达；
      // 放开需 IknowEnv 层承载 undefined，另行任务）。
      searchBackend:
        envOptionalEnum<SearchBackendId>({
          file,
          key: SEARCH_BACKEND_ENV_KEY,
          values: SEARCH_BACKEND_VALUES,
        }) ??
        mergedSettings.web?.searchBackend ??
        "bing",
      // #826 T1: vendor-keyed 后端 API key —— 字面或 `${VAR}` 占位符经
      // expandPlaceholders 解析（与 settings.llm.apiKey 同链路）；
      // 空 / "yes" / 占位符解析失败 → undefined（不 silent 空串）。
      exaApiKey: expandPlaceholders(
        envOptional({ file, key: EXA_API_KEY_ENV_KEY }),
        file
      ),
      tavilyApiKey: expandPlaceholders(
        envOptional({ file, key: TAVILY_API_KEY_ENV_KEY }),
        file
      ),
      braveApiKey: expandPlaceholders(
        envOptional({ file, key: BRAVE_API_KEY_ENV_KEY }),
        file
      ),
    },
    // #119 T1: 自动压缩配置臂(透传至 harness/compress/ via LoopEngineDeps.compress)。
    // thresholdTokens 阈值合理性校验(threshold >= window 拒绝)归 T4 threshold.ts,
    // 本 loader 仅承载 raw env 解析, 不抛错。
    compress: {
      // #353: settings.llm.compress.contextWindow 回退（env > settings > 200000 默认）。
      contextWindow: envInt({
        file,
        key: "IKNOW_MODEL_CONTEXT_WINDOW",
        fallback: mergedSettings.llm?.compress?.contextWindow ?? 200000,
      }),
      // #353: settings.llm.compress.thresholdTokens 回退（env > settings）。
      thresholdTokens:
        envOptionalInt({
          file,
          key: "IKNOW_AUTO_COMPACT_THRESHOLD_TOKENS",
        }) ?? mergedSettings.llm?.compress?.thresholdTokens,
    },
    // #378 根因 B: MCP 连接超时(默认 60_000, 缓解 npx -y cold start 击穿 30s)。
    mcp: {
      connectTimeoutMs: envPositiveInt({
        file,
        key: "IKNOW_MCP_CONNECT_TIMEOUT_MS",
        fallback: 60_000,
      }),
    },
    // #358 T1: 子代理 per-task wallclock(env > settings,无第三层默认;7200s 常量归 T2 manager)。
    subagent: {
      taskTimeoutMs:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_SUBAGENT_TASK_TIMEOUT_MS",
        }) ?? mergedSettings.subagent?.taskTimeoutMs,
      // T4: 并发上限(env > settings > manager default 15)。settings 可能
      // 来自测试注入而未经过 parse，故此处再次 fail-safe 校验。T2：值域扩到
      // `number | "unlimited"` —— env 仍只认正整数（不接受 unlimited 字面）；
      // settings 接受正整数或字面 `"unlimited"`；两条链会合后类型 = `number |
      // "unlimited"`，manager 透传为同型（见 harness/subagent/manager.ts）。
      maxConcurrentWorkers:
        envOptionalPositiveInt({
          file,
          key: "IKNOW_SUBAGENT_MAX_CONCURRENT_WORKERS",
        }) ??
        mergedSettings.subagent?.maxConcurrentWorkers ??
        DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS,
    },
    // ADR-0019 (T1): workspace-root per-root state anchor (D1.5 register at
    // env SSOT; `envOptional` canonical reader — empty/unset → undefined,
    // 消费方 resolver 对相对路径 / 目录不存在做 typed 校验)。
    workspaceRoot: envOptional({
      file,
      key: WORKSPACE_ROOT_ENV_KEY,
    }),
    // T3 (ADR-0037 §4): 项目身份根。同 workspaceRoot 的 envOptional 纪律
    // （empty/unset → undefined）；消费者是 subagent worker 的身份发现。
    productRoot: envOptional({
      file,
      key: PRODUCT_ROOT_ENV_KEY,
    }),
    loop: {
      detectToolLoop:
        envOptionalBool({
          file,
          key: "IKNOW_TOOL_LOOP_DETECTION",
        }) ??
        mergedSettings.loop?.detectToolLoop ??
        true,
    },
  };
}
