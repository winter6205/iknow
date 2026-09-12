/**
 * #353: iknow settings 文件机制（loop 配置的单一事实源）。
 *
 * 两层文件：user 级 `~/.iknow/settings.json` 与 project 级
 * `<cwd>/.iknow/settings.json`。ADR-0084 项目允许名单：项目文件**只采纳**
 * `hooks` / `verify` / `secrets` / `permissions` 四段 —— 这四段仍是 project
 * 覆盖 user（段内逐字段：project 只覆盖其实际出现的合法字段，未覆盖的 user
 * 字段保留）。其余顶层段（`llm` / `isolation` / `subagent` / `web` / `lsp` /
 * `memory` / `loop` / `graph`）为用户层键：出现在项目文件即丢弃并告警
 * （`filterProjectSettingsKeys`），只有 user 层能提供。
 *
 * `secrets` 段（#126 hook-system）：
 *  - `secrets.enabled`：是否启用 hook 敏感信息脱敏，boolean 才合法；缺失 → 消费方按
 *    true（默认开启）处理。
 *  - `secrets.patterns`：敏感信息匹配模式（正则源串）列表，非空串字符串数组才合法；
 *    缺失 / 空数组 → 消费方回退内置默认集（settings 层不预填内置集，只承载用户配置）。
 *  - `secrets.mode`（#406 T4）：secret 处理模式，仅 `"roundtrip"` | `"block"` 合法；
 *    缺失 → 消费方按 "roundtrip"（识别 + 占位符替换 + 还原）处理；"block" = 旧
 *    deny-only preToolUse guard（#126 兼容路径）。非法值 → 丢弃该字段。
 *
 * settings-model-extension（#164 第二阶段）：
 *  - `settings.llm.model` 是模型路由 ID 的字面值来源（trim 后非空串），env.ts
 *    不再读 IKNOW_LLM_MODEL；缺失由 env loader fail-fast。
 *  - `settings.llm.apiKey` 接受字面值或 `${VAR}` 占位符，env.ts 经
 *    `expandPlaceholders` 从 process.env > .env.local > .env 解析；未配 →
 *    undefined（消费点守卫抛错）。
 *
 * #128 自动修正闭环（T5）：
 *  - `settings.verify` 段承载闭环配置；未配置 → verify undefined（装配层
 *    resolveVerifyConfig 以 command="" 兜底, 由分类器判官接管, 见 verify-config.ts）。
 *  - 默认值（timeoutSec=600 / onExhausted=report / maxRounds=12）不在 settings
 *    层填，由消费点（verify-loop）兜底——settings 层只透传用户显式配置。
 *
 * 对齐 env.ts 的"非法值回退不抛错"纪律：
 *  - 文件不存在 → 空对象；
 *  - 坏 JSON（SyntaxError）→ 空对象，其它意外异常继续抛；
 *  - 非法值（maxTurns 非有限正整数 / contextWindow / thresholdTokens 非有限正数 /
 *    thinking 非 "off"|"adaptive" / thinkingEffort 非五档 /
 *    model 非空串字符串 / fallback 非空串字符串数组 /
 *    apiKey 非字面非占位符 / verify 段各字段越界或非字面量 /
 *    isolation.worktreeOnMutate 非 boolean）→ 丢弃该字段，
 *    且被丢弃的字段不参与覆盖（不抹掉 user 对应值）；
 *  - 顶层 / 中间层必须是普通对象（数组 / 字符串等 → 丢弃该层 / 该字段）。
 *
 * llm.thinking / llm.thinkingEffort 与 env.ts IKNOW_LLM_THINKING(_EFFORT) 同值域，
 * 但按 env > settings 优先级回退（#353 maxTurns 同款）——settings 只做缺省来源。
 *
 * 返回的 IknowSettings 深 frozen（Object.freeze 递归，对齐项目 immutable 纪律）。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IknowSettingsLlmCompress {
  contextWindow?: number;
  thresholdTokens?: number;
}

/** llm.thinking 值域：与 env.ts IKNOW_LLM_THINKING 一致（大小写敏感小写）。 */
export type IknowSettingsThinking = "off" | "adaptive";

/** llm.thinkingEffort 值域：env 五档（不含 "" 占位——空串在 settings 中无意义）。 */
export type IknowSettingsThinkingEffort =
  "low" | "medium" | "high" | "xhigh" | "max";

/** settings 侧 thinkingEffort 合法档位（不含 ""）。SSOT 见 session-api THINKING_EFFORT_VALUES（wire 层含 ""）。 */
export const THINKING_EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly IknowSettingsThinkingEffort[];

export interface IknowSettingsLlm {
  maxTurns?: number;
  /**
   * #358 T1: 单次 LLM 调用竞速上限（per-call，毫秒）。
   * 镜像 maxTurns 校验纪律：有限正整数才合法；非整数 / 非正数 / 非数字 / 错类型 → 丢弃该字段。
   * env 链：`envOptionalInt("IKNOW_LLM_TIMEOUT_MS") ?? settings.llm.timeoutMs ?? 300_000`。
   */
  timeoutMs?: number;
  /**
   * #742 T1: 流式臂上「模型输出增量静默」的上限（毫秒）。镜像 timeoutMs 校验
   * 纪律：有限正整数才合法，其余丢弃。
   * env 链：`envOptionalInt("IKNOW_LLM_IDLE_TIMEOUT_MS") ?? settings.llm.idleTimeoutMs ?? 120_000`。
   */
  idleTimeoutMs?: number;
  /**
   * #742 T1: 流式臂上单次模型调用的有限硬顶（毫秒），到点即使仍有增量也超时。
   * 镜像 timeoutMs 校验纪律。
   * env 链：`envOptionalInt("IKNOW_LLM_HARD_CAP_MS") ?? settings.llm.hardCapMs ?? 900_000`。
   */
  hardCapMs?: number;
  compress?: IknowSettingsLlmCompress;
  /** 缺省 thinking 开关；env IKNOW_LLM_THINKING 显式设置时覆盖它。 */
  thinking?: IknowSettingsThinking;
  /** 缺省 effort；env IKNOW_LLM_THINKING_EFFORT 显式设置时覆盖它。 */
  thinkingEffort?: IknowSettingsThinkingEffort;
  /** 模型路由 ID（9router）；非空串字符串才合法。 */
  model?: string;
  /**
   * 模型 fallback 路由 ID 列表（用户自配，代码不预置任何默认）。
   * 非空串字符串数组才合法（至少 1 项）；非法 → 丢弃该字段。
   */
  fallback?: string[];
  /**
   * LLM API key 来源（settings-model-extension 单一承载）：
   *  - 字面值：直接作为密钥使用（不经占位符解析）；
   *  - `${VAR}` / `$VAR` 占位符：由 env.ts `expandPlaceholders` 从
   *    process.env[VAR] 优先、.env.local / .env 兜底解析；解析不到 → undefined。
   * 未配 → undefined（不默认、不硬编码；消费点守卫抛「no API key configured」）。
   */
  apiKey?: string;
}

export interface IknowSettingsVerify {
  /**
   * 验证命令。非空串才合法；未配置 → verify 段不产 command 字段，装配层
   * resolveVerifyConfig 以 command="" 兜底（分类器判官接管，见 verify-config.ts）。
   */
  command?: string;
  /** 失败用例单跑模板，`{files}` 占位；非空串才合法。 */
  rerunTemplate?: string;
  /** 失败数提取正则覆盖（可选）；非空串才合法。 */
  countRegex?: string;
  /**
   * 验证命令超时（秒）。默认 600 由消费点兜底（settings 层不透传默认值）；
   * 有限正整数才合法。
   */
  timeoutSec?: number;
  /**
   * 修正耗尽处置。仅 `"report"` | `"escalate"` 字面量合法；默认 report 由
   * 消费点兜底。
   */
  onExhausted?: "report" | "escalate";
  /** 兜底总轮数上限。默认 12 由消费点兜底；有限正整数才合法。 */
  maxRounds?: number;
  /**
   * 分类器（command 缺失时的子代理 LLM 判官）模型路由 ID（A7）。
   * 显式指定时用其值；缺省解析到 settings.llm.model。ADR-0015 扩展，
   * 非空串才合法（与 command 同纪律），代码层不硬编码模型 ID。
   */
  classifierModel?: string;
}

export interface IknowSettingsSecrets {
  /** 是否启用 hook 敏感信息脱敏。缺失时消费方按 true 处理（默认开启）。 */
  enabled?: boolean;
  /**
   * 敏感信息匹配模式（正则源串）列表。用户自配，代码不预置任何默认；
   * 缺失 / 空数组 → 消费方回退内置默认集（settings 层不填内置集）。
   * 非空串字符串数组才合法（至少 1 项，每项 trim 后非空）；非法 → 丢弃该字段。
   */
  patterns?: string[];
  /**
   * #406 T4: secret 处理模式。缺省 = "roundtrip"（识别+占位符替换+还原）；
   * "block" = 旧 deny-only preToolUse guard（#126 兼容路径）。非法值 → 丢弃。
   */
  mode?: "roundtrip" | "block";
}

/**
 * #358 T1: 子代理配置段（per-task wallclock，独立于 per-call llm.timeoutMs）。
 *
 * `taskTimeoutMs` = 子代理整任务寿命上限（毫秒），父 manager SIGTERM 计时消费。
 * 与 `llm.timeoutMs`（per-call LLM 调用竞速）语义、命名、消费点全程分离（C9）。
 *
 * 校验纪律（镜像 maxTurns）：
 *  - 有限正整数（>= 1 且为整数）才合法；
 *  - 非正 / 非整数 / 非数字 / 错类型 → 丢弃该字段；
 *  - 全部字段非法 → 不产出 subagent 段。
 *
 * env 链（镜像 maxTurns 模式）：
 * `envOptionalInt("IKNOW_SUBAGENT_TASK_TIMEOUT_MS") ?? mergedSettings.subagent?.taskTimeoutMs`，
 * env 层不预填 7200s 默认值（缺省值在 T2 的 manager 消费点声明，避免两处声明）。
 */
export interface IknowSettingsSubagent {
  taskTimeoutMs?: number;
  /** 子代理同时处于 starting/running 的并发上限；正整数才生效。 */
  maxConcurrentWorkers?: number;
}

/**
 * 子代理并发上限缺省（CONTEXT「子代理并发上限」）。
 * env / settings 未设或非正时回退此值；manager 与 env loader 共用，禁止
 * config 反向 import harness。
 */
export const DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS = 15;

/**
 * D-α V1 graph mode: graph 编排 overlay 的持久默认（ADR-0030）。
 *
 * graph 是**可选 overlay**：默认任务仍走一次性 `spawn_subagent` 不进图，所以
 * 本段缺席时消费方按「关」处理（缺省不在 settings 层预填）。运行时链：
 * `settings.graph.enabled > false`；会话内 Shift+Tab / `/graph` 再就地翻
 * （`harness/graph/mode.ts` 的 `resolveGraphMode` 是唯一装配点）。
 *
 * 校验纪律镜像 `IknowSettingsSubagent`：boolean 才合法；错类型 → 丢弃该字段；
 * 全部字段非法 / 缺席 → 不产出 graph 段。
 */
export interface IknowSettingsGraph {
  enabled?: boolean;
}

/**
 * auto-memory T4 / ADR-0031 D5: 自动记忆段。
 *
 * `autoExtract` / `dream` 只认 boolean；缺失 / 非法 → 字段不产出，消费方按
 * **false** 处理（默认 OFF 是决策，不是巧合）。两者独立。
 */
export interface IknowSettingsMemory {
  autoExtract?: boolean;
  dream?: boolean;
}

/**
 * ADR-0037: 会话级 git worktree 隔离段（plans/worktree-isolation-on-mutate.md）。
 *
 * `worktreeOnMutate` 只认 boolean；缺失 / 非 `true` / 非法值一律按 **OFF**
 * 处理（fail-closed，与 `memory.autoExtract` 同款值域纪律）—— OFF 时 mutate
 * 路径行为与今日完全一致。唯一 fail-closed 读取点是 `resolveWorktreeOnMutate`。
 *
 * 值域合同（硬要求 9 / ADR-0037 §5）：config 层只承载 boolean 值域语义——
 * 不读 git、不持会话状态；开关只在启动加载点读取一次。
 *
 * ADR-0070 / plans/worktree-exclusive-lock.md T2：`worktreeExclusive` 与
 * `worktreeOnMutate` **正交**、同款 boolean-only / 默认 OFF / fail-closed
 * 纪律；缺失 / 非 `true` 一律按 OFF（`resolveWorktreeExclusive` 单读点）。
 * 装配期由 `src/harness/build-engine.ts` 读取并透传给需要的缝（T3 在
 * session-api `enter` 检查时消费），不在 settings 层做 git / 会话查询。
 *
 * **L1 弱档披露（spec L1「三处强制披露」之设置项文档处，T4 落点）**：
 * 占用枚举走 `SessionStore.list()`，**仅本进程可见**——`SessionStore`
 * 在每个进程只构造一份，绑定到一个 cwd / workspaceRoot（`serve.ts:107` /
 * `cli.ts:318` / `tui/hub-bridge.ts:248`），无跨 root / 跨 dataDir 聚合
 * 入口。跨进程（独立 CLI 会话、不同 PID 的 `iknow serve`）的占用看不见
 * ——同棵树可能被两个进程同时 enter 而本开关只挡得住本进程。强档要
 * "跨进程占用可见"必须扫遍 `<dataDir>/sessions/*` 全部项目命名空间
 * （M×N 文件 parse），本 spec 不做。打开此开关的 operator 已知此限制。
 */
export interface IknowSettingsIsolation {
  /** mutate 时建 task worktree 并改绑会话的开关（默认 OFF）。 */
  worktreeOnMutate?: boolean;
  /**
   * ADR-0070: enter-worktree 多一道前置占用检查 —— 目标树若被别的现存
   * 会话记录占用则 typed 拒绝（`worktree_claimed`）。默认 OFF（与今日逐字节
   * 一致）；OFF 时 enter 行为与今日一致，不引入任何新拒绝路径。
   */
  worktreeExclusive?: boolean;
}

/**
 * user-hook-router（specs/user-hook-router.md）: 用户钩子（user hooks） 规则条目。
 *
 * 仅承载声明式 deny-only 规则（deny-only、无 allow[]）；内置钩子（builtin hooks） 不经
 * settings 装配（代码挂上），本段不承载 memory / secrets 等产品开关。
 *
 * 校验纪律（镜像 secrets.patterns）：单条结构性非法 → 丢弃该条（不抛）；
 * `pattern` 的正则可编译性不在 settings 层判定 —— 由 hook router 构造期
 * 编译，非法 pattern 剔除 + onHookError（SC6），settings 只做字符串透传。
 */
export interface IknowSettingsHookRule {
  /** 规则 id（trace / reason 归因用）；非空串才合法。 */
  id: string;
  /** 触发事件；仅三值闭集（V1），非法值 → 丢弃该条。 */
  event: "PreToolUse" | "PreWrite" | "PreCommit";
  /** deny 回灌给模型的理由；非空串才合法。 */
  reason: string;
  /** 可选 matcher：精确工具名（如 "bash"）。 */
  tool?: string;
  /** 可选 matcher：工具名前缀（如 "mcp__github"）。字段名即事件名 `PreToolUse` 的小写形态。 */
  pretooluse?: string;
  /** 可选 matcher：对工具调用扫描串（stringify 截断后）的正则源串。 */
  pattern?: string;
}

/**
 * user-hook-router: `settings.hooks` 段（用户钩子（user hooks） only）。
 *
 * `enabled` 缺席 / 非 boolean → 消费方按 false 处理（默认关，fail-closed）；
 * `rules` 非数组 → 丢弃该字段。段缺席 = 用户钩子（user hooks） 关，不影响 内置钩子（builtin hooks）
 * （自动记忆、secrets 等产品开关与 hooks 总闸正交，ADR-0055）。
 */
export interface IknowSettingsHooks {
  enabled?: boolean;
  rules?: IknowSettingsHookRule[];
}

/** 用户钩子（user hooks） 事件闭集（V1）。 */
export const HOOK_EVENT_VALUES: readonly IknowSettingsHookRule["event"][] = [
  "PreToolUse",
  "PreWrite",
  "PreCommit",
];

/**
 * Web 工具配置段。回退链 env > settings > 默认（对齐 #353 maxTurns 先例），
 * 装配期字段（不在 settings 热更新白名单，改后需重启进程）。
 */
export interface IknowSettingsWeb {
  /**
   * web_search 后端选择。值域与 env.ts `SEARCH_BACKEND_VALUES` 闭集一致；
   * 非法值 → 丢弃该字段（drop-not-throw，loader 侧非法 env 值仍抛 typed error）。
   */
  searchBackend?: "bing" | "exa" | "tavily" | "brave";
}

/**
 * web.searchBackend 闭集（settings 层本地常量）：与 env.ts `SEARCH_BACKEND_VALUES`
 * 同值域（顺序对齐 env SSOT bing → tavily → exa → brave）。settings.ts 不能反向
 * import env.ts（env.ts → settings.ts 已有依赖，反向即环），故从字段联合派生；
 * 类型面只保证元素 ⊆ 联合，值域 parity 由 tests/config/web-settings.test.ts 的
 * sort-deepEqual 守卫兜住（测试期显红，非静默漂移）。
 */
export const WEB_SEARCH_BACKEND_VALUES: readonly IknowSettingsWeb["searchBackend"][] =
  ["bing", "tavily", "exa", "brave"];

/**
 * ADR-0037: `isolation.worktreeOnMutate` 的唯一 fail-closed 读取点。
 * 缺失 / 非 boolean / 非 `true` → false（回落至今日行为）；config 层不做
 * 任何 git / 会话状态查询（硬要求 9）。
 */
export function resolveWorktreeOnMutate(
  settings: IknowSettings | undefined | null
): boolean {
  return settings?.isolation?.worktreeOnMutate === true;
}

/**
 * ADR-0070 / plans/worktree-exclusive-lock.md T2:
 * `isolation.worktreeExclusive` 的唯一 fail-closed 读取点（同
 * `resolveWorktreeOnMutate` 形状）。
 *
 *  - 缺失 / 非 boolean / 非 `true` → false（回落至今日 enter 行为，逐字节
 *    一致；SC2 / OFF 档零回归钉死）；
 *  - config 层只承载 boolean 值域语义（ADR-0037 §5 硬要求 9）—— **不读
 *    git、不持会话状态、不枚举现存会话记录**；占用判定（T3）由 session-api
 *    `enter-worktree` 缝消费装配期一次性读取的结果执行；
 *  - 开关只在启动加载点读取一次，会话根改绑（rebind）不触发 settings 重载
 *    —— `WorktreeIsolationHostOpts.worktreeExclusive` 是该一次性读取结果
 *    在装配期的透传载体。
 */
export function resolveWorktreeExclusive(
  settings: IknowSettings | undefined | null
): boolean {
  return settings?.isolation?.worktreeExclusive === true;
}

/**
 * lsp-optimization 二期 B7: LSP 配置段。全部字段可选；requestTimeoutMs /
 * diagnosticsWaitMs 为正整数；idleTimeoutMs 为 ≥0 整数（0 = 关闭 sweep）。
 * 消费点：build-engine 装配 LspCtx 注入（tools 层超时/等待 + client idle
 * sweep + disabledServers 过滤）。worker 不读 settings 文件，注入 idle
 * 缺省值（DEFAULT_LSP_IDLE_TIMEOUT_MS）。
 */
export interface IknowLspSettings {
  /** per-request LSP 超时上限（毫秒，缺省 20_000）。 */
  requestTimeoutMs?: number;
  /** lsp_diagnostics 读前等待 deadline（毫秒，缺省 2_000）。 */
  diagnosticsWaitMs?: number;
  /** 空闲 LSP 客户端回收阈值（毫秒，缺省 600_000；0 视为不回收）。 */
  idleTimeoutMs?: number;
  /** 禁用的 server id 列表（命中 → 视为未配置）。 */
  disabledServers?: string[];
}

/**
 * ADR-0084: 项目层 `permissions` 段（原 `.iknow/permissions.toml` 的 rule DSL
 * 原样迁入项目 settings）。本层只做「普通对象 + 两个顶层键形态」的门禁：
 * `schema_version` 仅 number 透传、`rule` 仅数组透传；**值域 / 谓词语义 /
 * ajv schema 校验的 SSOT 是 `src/harness/permission/project-settings.ts`**
 * （config 层不反向 import harness）。
 */
export interface IknowSettingsPermissions {
  /** 规则 schema 版本（只认整数 1 的校验归 permission 层 ajv）。 */
  schema_version?: number;
  /** 规则数组（形状 / 谓词校验归 permission 层 ajv）。 */
  rule?: ReadonlyArray<unknown>;
}

export interface IknowSettings {
  llm?: IknowSettingsLlm;
  verify?: IknowSettingsVerify;
  secrets?: IknowSettingsSecrets;
  /**
   * ADR-0084: 项目层权限规则段（`schema_version` + `rule[]`，原
   * `.iknow/permissions.toml` 的 rule DSL 原样迁入）。**仅项目层解析**——
   * 用户层 `permissions` 不接（ADR-0084，见 `loadIknowSettings`）。
   * 本接口只承载原始 JSON 形状；谓词语义 / ajv 校验归
   * `src/harness/permission/project-settings.ts`（同一 SSOT）。
   *
   * **运行时不消费本字段**：权限源由装配层经
   * `resolveProjectPermissionSource({ projectIdentityRoot })` 单点读取
   * （build-engine / worker 共用），本层是形状门禁而非第二读者。本层丢弃
   * 非法字段（drop-not-throw），拿它当策略源会把 schema 违规静默降级成
   * 「无项目规则」，正是 ADR-0084 fail-loud 要排除的形态。
   */
  permissions?: IknowSettingsPermissions;
  /** #358 T1: 子代理配置段（per-task wallclock）。 */
  subagent?: IknowSettingsSubagent;
  /** D-α: graph 编排 overlay 的新会话默认（缺省关）。 */
  graph?: IknowSettingsGraph;
  /** #672 T3: 工具环检测。boolean 才合法；缺省由消费方按 true。 */
  loop?: IknowSettingsLoop;
  /** auto-memory T4: 自动记忆抽取开关（默认 OFF）。 */
  memory?: IknowSettingsMemory;
  /** ADR-0037: 会话级 git worktree 隔离开关（默认 OFF）。 */
  isolation?: IknowSettingsIsolation;
  /** lsp-optimization 二期 B7: LSP 配置段（全部可选，缺省走消费方默认值）。 */
  lsp?: IknowLspSettings;
  /** user-hook-router: 用户钩子（user hooks） 段（声明式 deny-only，默认关）。 */
  hooks?: IknowSettingsHooks;
  /** Web 工具配置段（web_search 后端选择等）。 */
  web?: IknowSettingsWeb;
}

export interface IknowSettingsLoop {
  detectToolLoop?: boolean;
}

/**
 * ADR-0084: 共享项目 settings 文件的顶层键允许名单 —— 项目文件只采纳
 * 「团队契约」四段；其余顶层键（isolation / llm / memory / subagent / web /
 * lsp / loop / graph ...）出现在项目文件即丢弃、不覆盖用户层值，并经
 * `LoadSettingsOpts.onWarn` 告警。用户层键不得写进项目文件（写回落对层见
 * `persist-settings.ts`）。
 */
export const PROJECT_SETTINGS_ALLOWED_KEYS = [
  "hooks",
  "verify",
  "secrets",
  "permissions",
] as const;

const PROJECT_SETTINGS_ALLOWED_KEY_SET: ReadonlySet<string> = Object.freeze(
  new Set<string>(PROJECT_SETTINGS_ALLOWED_KEYS)
);

export interface LoadSettingsOpts {
  /** 项目根，默认 process.cwd()。 */
  cwd?: string;
  /** 用户 home，默认 os.homedir()。 */
  home?: string;
  /**
   * ADR-0084 告警通道：项目文件出现非允许名单顶层键 / 用户文件出现
   * `permissions` 时逐条调用（每条一个键）。缺省 → `console.warn`；
   * 测试注入以捕获消息（不注入时走默认，不重复上报）。
   */
  onWarn?: (message: string) => void;
}

/** 普通对象（JSON.parse 产出的顶层/中间层只可能是这种；排除 null / 数组）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 有限正数（> 0）：contextWindow / thresholdTokens 的值域。 */
function isPositiveFinite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** 有限正整数（>= 1 且为整数）：maxTurns 的值域。 */
function isValidMaxTurns(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/**
 * #358 T1: llm.timeoutMs 校验（per-call LLM 调用竞速上限，毫秒）。
 * 镜像 maxTurns 纪律：有限正整数才合法；非正 / 非整数 / 非数字 / 错类型 → 丢弃。
 */
function isValidTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/** LSP idle sweep：0 = 关闭回收；负数 / 非整数仍丢弃。 */
function isValidIdleTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0
  );
}

/**
 * #358 T1: subagent.taskTimeoutMs 校验（per-task 整任务寿命上限，毫秒）。
 * 镜像 maxTurns 纪律：有限正整数才合法；非正 / 非整数 / 非数字 / 错类型 → 丢弃。
 */
function isValidTaskTimeoutMs(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/** 子代理并发上限的值域：有限正整数才合法。 */
function isValidMaxConcurrentWorkers(v: unknown): v is number {
  return (
    typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 1
  );
}

/** thinking 值域校验：仅小写 "off" | "adaptive"（大小写敏感，对齐 env 语义）。 */
function isValidThinking(v: unknown): v is IknowSettingsThinking {
  return v === "off" || v === "adaptive";
}

/** thinkingEffort 值域校验：仅小写五档（"" 在 settings 中无意义 → 非合法）。 */
function isValidThinkingEffort(v: unknown): v is IknowSettingsThinkingEffort {
  return (THINKING_EFFORT_LEVELS as readonly string[]).includes(
    typeof v === "string" ? v : ""
  );
}

/** 非空串字符串（trim 后仍有内容）：model 的值域。 */
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** 非空串字符串数组（至少 1 项，每项 trim 后仍有内容）：fallback 的值域。 */
function isNonEmptyStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.length > 0 && v.every(isNonEmptyString);
}

/** secret mode 值域：仅 "roundtrip" | "block"（缺省由消费方按 roundtrip 处理）。 */
function isValidSecretMode(v: unknown): v is IknowSettingsSecrets["mode"] {
  return v === "roundtrip" || v === "block";
}

/**
 * 占位符形态：`${VAR}` 或 `$VAR`。与 env.ts `expandPlaceholders` 共用同一
 * VAR 名字符集（`[A-Za-z_][A-Za-z0-9_]*`）。settings.ts 独立持有一份扫描
 * 实现（避免 settings.ts 依赖 env.ts），用同一正则源防 drift（M7 对齐）。
 */
export const PLACEHOLDER_PATTERN =
  /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * 整串占位符语法分析（M7：settings.ts validator 与 env.ts resolver 对齐）：
 *  - placeholders：全串出现的 `${VAR}` / `$VAR` 变量名（去重保序）；
 *  - hasInvalidResidue：剥离合法占位符后仍剩非法残余（含 `${` 但不匹配
 *    `${VAR}`，如 `${}` / `${1VAR}` / `${VAR` 未闭合；或字面里嵌了 `$` 但不
 *    成合法 `$VAR` 形态，如 `foo$bar`）。有残余 → 既非合法占位符串，也非
 *    纯字面密钥（M2 语义：`${constructor}` 属 `$VAR` 形态但 var 名非合法
 *    环境标识符，validator 接受后 resolver 命中 Object.prototype —— 见 M2
 *    isPlainEnvName 守卫）。
 *
 * 语义（与 env.ts `expandPlaceholders` 完全一致）：
 *  - 纯字面（无 `$`）→ placeholders=[] 且无残余；
 *  - 合法占位符串（全串由 `${VAR}` / `$VAR` 拼成）→ 无残余；
 *  - 字面 + 合法占位符混合（`${A}literal`）→ 无残余（env.ts 同样解析）；
 *  - 含非法形态 → hasInvalidResidue=true。
 */
export function analyzePlaceholderSyntax(value: string): {
  placeholders: string[];
  hasInvalidResidue: boolean;
} {
  PLACEHOLDER_PATTERN.lastIndex = 0;
  const placeholders = new Set<string>();
  const residue = value.replace(
    PLACEHOLDER_PATTERN,
    (_match, braced: string | undefined, bare: string | undefined) => {
      placeholders.add(braced ?? (bare as string));
      return "";
    }
  );
  PLACEHOLDER_PATTERN.lastIndex = 0;
  // 非法残余 = 剥离合法占位符后仍剩 `${`（`${}` / `${1VAR}` / `${VAR` 未闭合 /
  // `${A}${1B}` 混合非法）。纯字面残余（无 `${`，如 `plain` / `foo$bar` 的
  // "foo" / `${A}literal` 的 "literal"）是合法字面，不算非法。
  return {
    placeholders: [...placeholders],
    hasInvalidResidue: residue.includes("${"),
  };
}

/**
 * settings.llm.apiKey 形态守卫：trim 非空串。
 *  - 字面（不含 `$`）→ trim 非空即接受；
 *  - 含合法占位符且无非法残余（`${VAR}` / `$VAR` 混排、字面 + 占位符混合）→
 *    接受（占位符由 env.ts 解析）；
 *  - 含 `${` 但含非法形态 / 含 `$` 但不成合法 `$VAR` → 拒绝（非法占位符，
 *    丢弃）。与 env.ts `expandPlaceholders` 的解析语义对齐（M7）。
 */
export function isApiKeyOrPlaceholder(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  if (trimmed.length === 0) return false;
  return !analyzePlaceholderSyntax(trimmed).hasInvalidResidue;
}

/**
 * 读取单个 settings 文件并解析为普通对象。
 * 文件不存在 → {}；坏 JSON（SyntaxError）→ {}（不抛错）；顶层非普通对象 → {}。
 * 仅吞 JSON.parse 的 SyntaxError，其它意外异常重新抛（不静默吞掉）。
 */
function readSettingsFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
  return isPlainObject(parsed) ? parsed : {};
}

/**
 * 校验单个 `llm` 层：非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * compress 为普通对象但字段全部非法 → 不产出 compress（丢弃该字段）。
 */
function parseLlm(raw: unknown): IknowSettingsLlm | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsLlm = {};
  if (isValidMaxTurns(raw.maxTurns)) out.maxTurns = raw.maxTurns;
  // #358 T1: per-call LLM 调用竞速上限（毫秒）。
  if (isValidTimeoutMs(raw.timeoutMs)) out.timeoutMs = raw.timeoutMs;
  // #742 T1: 流式臂双钟（idle 静默上限 + 有限硬顶），同 timeoutMs 值域纪律。
  if (isValidTimeoutMs(raw.idleTimeoutMs))
    out.idleTimeoutMs = raw.idleTimeoutMs;
  if (isValidTimeoutMs(raw.hardCapMs)) out.hardCapMs = raw.hardCapMs;
  if (isValidThinking(raw.thinking)) out.thinking = raw.thinking;
  if (isValidThinkingEffort(raw.thinkingEffort)) {
    out.thinkingEffort = raw.thinkingEffort;
  }
  if (isNonEmptyString(raw.model)) out.model = raw.model.trim();
  if (isNonEmptyStringArray(raw.fallback)) {
    out.fallback = raw.fallback.map((s) => s.trim());
  }
  if (isApiKeyOrPlaceholder(raw.apiKey)) out.apiKey = raw.apiKey.trim();
  if (isPlainObject(raw.compress)) {
    const compress: IknowSettingsLlmCompress = {};
    if (isPositiveFinite(raw.compress.contextWindow)) {
      compress.contextWindow = raw.compress.contextWindow;
    }
    if (isPositiveFinite(raw.compress.thresholdTokens)) {
      compress.thresholdTokens = raw.compress.thresholdTokens;
    }
    if (
      compress.contextWindow !== undefined ||
      compress.thresholdTokens !== undefined
    ) {
      out.compress = compress;
    }
  }
  if (
    out.maxTurns === undefined &&
    out.timeoutMs === undefined &&
    out.idleTimeoutMs === undefined &&
    out.hardCapMs === undefined &&
    out.compress === undefined &&
    out.thinking === undefined &&
    out.thinkingEffort === undefined &&
    out.model === undefined &&
    out.fallback === undefined &&
    out.apiKey === undefined
  )
    return undefined;
  return out;
}

/**
 * 校验单个 `verify` 层：非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * verify 为普通对象但字段全部非法 → undefined（丢弃该字段，闭环不启用）。
 * 默认值（timeoutSec=600 / onExhausted=report / maxRounds=12）不在此填充，
 * 由消费点（verify-loop）兜底。
 */
function parseVerify(raw: unknown): IknowSettingsVerify | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsVerify = {};
  if (isNonEmptyString(raw.command)) out.command = raw.command.trim();
  if (isNonEmptyString(raw.rerunTemplate)) {
    out.rerunTemplate = raw.rerunTemplate.trim();
  }
  if (isNonEmptyString(raw.countRegex)) out.countRegex = raw.countRegex.trim();
  if (isValidMaxTurns(raw.timeoutSec)) out.timeoutSec = raw.timeoutSec;
  if (raw.onExhausted === "report" || raw.onExhausted === "escalate") {
    out.onExhausted = raw.onExhausted;
  }
  if (isValidMaxTurns(raw.maxRounds)) out.maxRounds = raw.maxRounds;
  if (isNonEmptyString(raw.classifierModel)) {
    out.classifierModel = raw.classifierModel.trim();
  }
  if (
    out.command === undefined &&
    out.rerunTemplate === undefined &&
    out.countRegex === undefined &&
    out.timeoutSec === undefined &&
    out.onExhausted === undefined &&
    out.maxRounds === undefined &&
    out.classifierModel === undefined
  )
    return undefined;
  return out;
}

/**
 * #358 T1: 校验单个 `subagent` 层 —— 非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * taskTimeoutMs 非有限正整数 → 丢弃该字段。
 * 全部字段非法 → undefined（丢弃该段）。
 */
function parseSubagent(raw: unknown): IknowSettingsSubagent | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsSubagent = {};
  if (isValidTaskTimeoutMs(raw.taskTimeoutMs)) {
    out.taskTimeoutMs = raw.taskTimeoutMs;
  }
  if (isValidMaxConcurrentWorkers(raw.maxConcurrentWorkers)) {
    out.maxConcurrentWorkers = raw.maxConcurrentWorkers;
  }
  if (out.taskTimeoutMs === undefined && out.maxConcurrentWorkers === undefined)
    return undefined;
  return out;
}

/** 逐层合并 verify：project 字段优先，未覆盖的 user 字段保留。 */
function mergeVerify(
  user: IknowSettingsVerify | undefined,
  project: IknowSettingsVerify | undefined
): IknowSettingsVerify | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsVerify = {};
  if (project?.command !== undefined) out.command = project.command;
  else if (user?.command !== undefined) out.command = user.command;
  if (project?.rerunTemplate !== undefined) {
    out.rerunTemplate = project.rerunTemplate;
  } else if (user?.rerunTemplate !== undefined) {
    out.rerunTemplate = user.rerunTemplate;
  }
  if (project?.countRegex !== undefined) out.countRegex = project.countRegex;
  else if (user?.countRegex !== undefined) out.countRegex = user.countRegex;
  if (project?.timeoutSec !== undefined) out.timeoutSec = project.timeoutSec;
  else if (user?.timeoutSec !== undefined) out.timeoutSec = user.timeoutSec;
  if (project?.onExhausted !== undefined) out.onExhausted = project.onExhausted;
  else if (user?.onExhausted !== undefined) out.onExhausted = user.onExhausted;
  if (project?.maxRounds !== undefined) out.maxRounds = project.maxRounds;
  else if (user?.maxRounds !== undefined) out.maxRounds = user.maxRounds;
  if (project?.classifierModel !== undefined) {
    out.classifierModel = project.classifierModel;
  } else if (user?.classifierModel !== undefined) {
    out.classifierModel = user.classifierModel;
  }
  if (
    out.command === undefined &&
    out.rerunTemplate === undefined &&
    out.countRegex === undefined &&
    out.timeoutSec === undefined &&
    out.onExhausted === undefined &&
    out.maxRounds === undefined &&
    out.classifierModel === undefined
  )
    return undefined;
  return out;
}

/**
 * #358 T1: 逐层合并 subagent：project 字段优先，未覆盖的 user 字段保留。
 * parse 层已保证字段为 > 0 整数，merge 仅做 project > user 选择。
 */
function mergeSubagent(
  user: IknowSettingsSubagent | undefined,
  project: IknowSettingsSubagent | undefined
): IknowSettingsSubagent | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsSubagent = {};
  if (project?.taskTimeoutMs !== undefined) {
    out.taskTimeoutMs = project.taskTimeoutMs;
  } else if (user?.taskTimeoutMs !== undefined) {
    out.taskTimeoutMs = user.taskTimeoutMs;
  }
  if (project?.maxConcurrentWorkers !== undefined) {
    out.maxConcurrentWorkers = project.maxConcurrentWorkers;
  } else if (user?.maxConcurrentWorkers !== undefined) {
    out.maxConcurrentWorkers = user.maxConcurrentWorkers;
  }
  if (out.taskTimeoutMs === undefined && out.maxConcurrentWorkers === undefined)
    return undefined;
  return out;
}

/**
 * D-α: 校验 `graph` 层 —— 非法字段丢弃（镜像 parseLoop）。
 * 非普通对象 → undefined（丢弃该层）；非 boolean → 丢弃该字段；
 * 字段全非法 → undefined（消费方回退默认关）。
 */
function parseGraph(raw: unknown): IknowSettingsGraph | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsGraph = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (out.enabled === undefined) return undefined;
  return out;
}

/** D-α: 逐层合并 graph：project 字段优先，未覆盖的 user 字段保留。 */
function mergeGraph(
  user: IknowSettingsGraph | undefined,
  project: IknowSettingsGraph | undefined
): IknowSettingsGraph | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsGraph = {};
  if (project?.enabled !== undefined) out.enabled = project.enabled;
  else if (user?.enabled !== undefined) out.enabled = user.enabled;
  if (out.enabled === undefined) return undefined;
  return out;
}

function parseLoop(raw: unknown): IknowSettingsLoop | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsLoop = {};
  if (typeof raw.detectToolLoop === "boolean") {
    out.detectToolLoop = raw.detectToolLoop;
  }
  if (out.detectToolLoop === undefined) return undefined;
  return out;
}

function mergeLoop(
  user: IknowSettingsLoop | undefined,
  project: IknowSettingsLoop | undefined
): IknowSettingsLoop | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsLoop = {};
  if (project?.detectToolLoop !== undefined) {
    out.detectToolLoop = project.detectToolLoop;
  } else if (user?.detectToolLoop !== undefined) {
    out.detectToolLoop = user.detectToolLoop;
  }
  if (out.detectToolLoop === undefined) return undefined;
  return out;
}

function parseMemory(raw: unknown): IknowSettingsMemory | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsMemory = {};
  if (typeof raw.autoExtract === "boolean") out.autoExtract = raw.autoExtract;
  if (typeof raw.dream === "boolean") out.dream = raw.dream;
  if (out.autoExtract === undefined && out.dream === undefined)
    return undefined;
  return out;
}

function mergeMemory(
  user: IknowSettingsMemory | undefined,
  project: IknowSettingsMemory | undefined
): IknowSettingsMemory | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsMemory = {};
  if (project?.autoExtract !== undefined) out.autoExtract = project.autoExtract;
  else if (user?.autoExtract !== undefined) out.autoExtract = user.autoExtract;
  if (project?.dream !== undefined) out.dream = project.dream;
  else if (user?.dream !== undefined) out.dream = user.dream;
  if (out.autoExtract === undefined && out.dream === undefined)
    return undefined;
  return out;
}

/**
 * ADR-0037 / ADR-0070: 校验 `isolation` 层 —— 非法字段丢弃（镜像 parseGraph）。
 * 非普通对象 → undefined（丢弃该层）；worktreeOnMutate / worktreeExclusive
 * 非 boolean → 丢弃该字段（不转型）；字段全非法 / 缺席 → undefined（消费方
 * 按 OFF 处理）。两字段独立校验、互不影响——任一合法即保留段。
 */
function parseIsolation(raw: unknown): IknowSettingsIsolation | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsIsolation = {};
  if (typeof raw.worktreeOnMutate === "boolean") {
    out.worktreeOnMutate = raw.worktreeOnMutate;
  }
  if (typeof raw.worktreeExclusive === "boolean") {
    out.worktreeExclusive = raw.worktreeExclusive;
  }
  if (out.worktreeOnMutate === undefined && out.worktreeExclusive === undefined)
    return undefined;
  return out;
}

/**
 * ADR-0037 / ADR-0070: 逐层合并 isolation —— project 字段优先，未覆盖的
 * user 字段保留。两字段独立 per-field project > user 合并（镜像 llm.timeoutMs
 * 形态）；任一字段合并后合法即保留段。
 * ADR-0084: `isolation` 是用户层键 —— 生产路径上 `project` 恒为空对象（见
 * `mergeSettings`），项目文件不得卸门禁。
 */
function mergeIsolation(
  user: IknowSettingsIsolation | undefined,
  project: IknowSettingsIsolation | undefined
): IknowSettingsIsolation | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsIsolation = {};
  if (project?.worktreeOnMutate !== undefined) {
    out.worktreeOnMutate = project.worktreeOnMutate;
  } else if (user?.worktreeOnMutate !== undefined) {
    out.worktreeOnMutate = user.worktreeOnMutate;
  }
  if (project?.worktreeExclusive !== undefined) {
    out.worktreeExclusive = project.worktreeExclusive;
  } else if (user?.worktreeExclusive !== undefined) {
    out.worktreeExclusive = user.worktreeExclusive;
  }
  if (out.worktreeOnMutate === undefined && out.worktreeExclusive === undefined)
    return undefined;
  return out;
}

/**
 * lsp-optimization 二期 B7: 校验 `lsp` 层 —— 非法字段丢弃（镜像 parseIsolation）。
 * 非普通对象 → undefined；requestTimeoutMs / diagnosticsWaitMs 非正整数 → 丢弃；
 * idleTimeoutMs 非 ≥0 整数 → 丢弃（0 合法 = 关闭 sweep）；disabledServers 非
 * 非空字符串数组 → 丢弃该字段；字段全非法 / 缺席 → undefined（消费方走缺省值）。
 */
function parseLsp(raw: unknown): IknowLspSettings | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowLspSettings = {};
  if (isValidTimeoutMs(raw.requestTimeoutMs)) {
    out.requestTimeoutMs = raw.requestTimeoutMs;
  }
  if (isValidTimeoutMs(raw.diagnosticsWaitMs)) {
    out.diagnosticsWaitMs = raw.diagnosticsWaitMs;
  }
  if (isValidIdleTimeoutMs(raw.idleTimeoutMs)) {
    out.idleTimeoutMs = raw.idleTimeoutMs;
  }
  if (isNonEmptyStringArray(raw.disabledServers)) {
    out.disabledServers = raw.disabledServers.map((s) => s.trim());
  }
  if (
    out.requestTimeoutMs === undefined &&
    out.diagnosticsWaitMs === undefined &&
    out.idleTimeoutMs === undefined &&
    out.disabledServers === undefined
  )
    return undefined;
  return out;
}

/** lsp-optimization 二期 B7: 逐层合并 lsp：project 字段优先，未覆盖的 user 字段保留。 */
function mergeLsp(
  user: IknowLspSettings | undefined,
  project: IknowLspSettings | undefined
): IknowLspSettings | undefined {
  if (!user && !project) return undefined;
  const out: IknowLspSettings = {};
  if (project?.requestTimeoutMs !== undefined) {
    out.requestTimeoutMs = project.requestTimeoutMs;
  } else if (user?.requestTimeoutMs !== undefined) {
    out.requestTimeoutMs = user.requestTimeoutMs;
  }
  if (project?.diagnosticsWaitMs !== undefined) {
    out.diagnosticsWaitMs = project.diagnosticsWaitMs;
  } else if (user?.diagnosticsWaitMs !== undefined) {
    out.diagnosticsWaitMs = user.diagnosticsWaitMs;
  }
  if (project?.idleTimeoutMs !== undefined) {
    out.idleTimeoutMs = project.idleTimeoutMs;
  } else if (user?.idleTimeoutMs !== undefined) {
    out.idleTimeoutMs = user.idleTimeoutMs;
  }
  if (project?.disabledServers !== undefined) {
    out.disabledServers = project.disabledServers;
  } else if (user?.disabledServers !== undefined) {
    out.disabledServers = user.disabledServers;
  }
  if (
    out.requestTimeoutMs === undefined &&
    out.diagnosticsWaitMs === undefined &&
    out.idleTimeoutMs === undefined &&
    out.disabledServers === undefined
  )
    return undefined;
  return out;
}

/**
 * Web 工具配置段：校验 `web` 层 —— 非法字段丢弃（镜像 parseIsolation）。
 * 非普通对象 → undefined；searchBackend 不在闭集 → 丢弃该字段（drop-not-throw，
 * 与 settings 层其它字段纪律一致；env 侧非法值仍走 typed error 更显眼）；
 * 字段全非法 / 缺席 → undefined（env / 默认 bing 兜底）。
 */
function parseWeb(raw: unknown): IknowSettingsWeb | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsWeb = {};
  if (
    typeof raw.searchBackend === "string" &&
    (WEB_SEARCH_BACKEND_VALUES as readonly string[]).includes(raw.searchBackend)
  ) {
    out.searchBackend = raw.searchBackend as IknowSettingsWeb["searchBackend"];
  }
  if (out.searchBackend === undefined) return undefined;
  return out;
}

/** Web 工具配置段：逐层合并 web —— project 字段优先，未覆盖的 user 字段保留。 */
function mergeWeb(
  user: IknowSettingsWeb | undefined,
  project: IknowSettingsWeb | undefined
): IknowSettingsWeb | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsWeb = {};
  if (project?.searchBackend !== undefined) {
    out.searchBackend = project.searchBackend;
  } else if (user?.searchBackend !== undefined) {
    out.searchBackend = user.searchBackend;
  }
  if (out.searchBackend === undefined) return undefined;
  return out;
}

/**
 * user-hook-router: 校验单个 `hooks` 层 —— 非法字段 / 条目丢弃（不抛）。
 * 非普通对象 → undefined；enabled 非 boolean → 丢弃该字段；rules 非数组 →
 * 丢弃该字段；单条规则 id/event/reason 结构非法 → 丢弃该条（其余保留）；
 * 全部条目非法 → rules 不产出（enabled 合法仍保留）。
 */
function parseHooks(raw: unknown): IknowSettingsHooks | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsHooks = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (Array.isArray(raw.rules)) {
    const rules: IknowSettingsHookRule[] = [];
    for (const entry of raw.rules) {
      if (!isPlainObject(entry)) continue;
      if (
        !isNonEmptyString(entry.id) ||
        !(HOOK_EVENT_VALUES as readonly string[]).includes(
          typeof entry.event === "string" ? entry.event : ""
        ) ||
        !isNonEmptyString(entry.reason)
      ) {
        continue;
      }
      const rule: IknowSettingsHookRule = {
        id: entry.id.trim(),
        event: entry.event as IknowSettingsHookRule["event"],
        reason: entry.reason.trim(),
      };
      if (isNonEmptyString(entry.tool)) rule.tool = entry.tool.trim();
      if (isNonEmptyString(entry.pretooluse)) {
        rule.pretooluse = entry.pretooluse.trim();
      }
      if (typeof entry.pattern === "string" && entry.pattern.length > 0) {
        rule.pattern = entry.pattern;
      }
      rules.push(rule);
    }
    if (rules.length > 0) out.rules = rules;
  }
  if (out.enabled === undefined && out.rules === undefined) return undefined;
  return out;
}

/** user-hook-router: 逐层合并 hooks —— project 字段优先，未覆盖的 user 字段保留。 */
function mergeHooks(
  user: IknowSettingsHooks | undefined,
  project: IknowSettingsHooks | undefined
): IknowSettingsHooks | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsHooks = {};
  if (project?.enabled !== undefined) out.enabled = project.enabled;
  else if (user?.enabled !== undefined) out.enabled = user.enabled;
  if (project?.rules !== undefined) out.rules = project.rules;
  else if (user?.rules !== undefined) out.rules = user.rules;
  if (out.enabled === undefined && out.rules === undefined) return undefined;
  return out;
}

/**
 * 逐层合并 llm：project 字段优先，未覆盖的 user 字段保留。
 * ADR-0084: `llm` 是用户层键 —— 生产路径上 `project` 恒为空对象（见
 * `mergeSettings`），实际只有 user 值生效。
 */
function mergeLlm(
  user: IknowSettingsLlm | undefined,
  project: IknowSettingsLlm | undefined
): IknowSettingsLlm | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsLlm = {};
  if (project?.maxTurns !== undefined) out.maxTurns = project.maxTurns;
  else if (user?.maxTurns !== undefined) out.maxTurns = user.maxTurns;
  // #358 T1: per-call LLM 调用竞速上限（per-field project > user）。
  if (project?.timeoutMs !== undefined) out.timeoutMs = project.timeoutMs;
  else if (user?.timeoutMs !== undefined) out.timeoutMs = user.timeoutMs;
  // #742 T1: 流式臂双钟同款 per-field project > user。
  if (project?.idleTimeoutMs !== undefined) {
    out.idleTimeoutMs = project.idleTimeoutMs;
  } else if (user?.idleTimeoutMs !== undefined) {
    out.idleTimeoutMs = user.idleTimeoutMs;
  }
  if (project?.hardCapMs !== undefined) out.hardCapMs = project.hardCapMs;
  else if (user?.hardCapMs !== undefined) out.hardCapMs = user.hardCapMs;
  if (project?.thinking !== undefined) out.thinking = project.thinking;
  else if (user?.thinking !== undefined) out.thinking = user.thinking;
  if (project?.thinkingEffort !== undefined) {
    out.thinkingEffort = project.thinkingEffort;
  } else if (user?.thinkingEffort !== undefined) {
    out.thinkingEffort = user.thinkingEffort;
  }
  if (project?.model !== undefined) out.model = project.model;
  else if (user?.model !== undefined) out.model = user.model;
  if (project?.fallback !== undefined) out.fallback = project.fallback;
  else if (user?.fallback !== undefined) out.fallback = user.fallback;
  if (project?.apiKey !== undefined) out.apiKey = project.apiKey;
  else if (user?.apiKey !== undefined) out.apiKey = user.apiKey;
  if (project?.compress !== undefined || user?.compress !== undefined) {
    const compress: IknowSettingsLlmCompress = {};
    if (project?.compress?.contextWindow !== undefined) {
      compress.contextWindow = project.compress.contextWindow;
    } else if (user?.compress?.contextWindow !== undefined) {
      compress.contextWindow = user.compress.contextWindow;
    }
    if (project?.compress?.thresholdTokens !== undefined) {
      compress.thresholdTokens = project.compress.thresholdTokens;
    } else if (user?.compress?.thresholdTokens !== undefined) {
      compress.thresholdTokens = user.compress.thresholdTokens;
    }
    if (
      compress.contextWindow !== undefined ||
      compress.thresholdTokens !== undefined
    ) {
      out.compress = compress;
    }
  }
  if (
    out.maxTurns === undefined &&
    out.timeoutMs === undefined &&
    out.idleTimeoutMs === undefined &&
    out.hardCapMs === undefined &&
    out.compress === undefined &&
    out.thinking === undefined &&
    out.thinkingEffort === undefined &&
    out.model === undefined &&
    out.fallback === undefined &&
    out.apiKey === undefined
  )
    return undefined;
  return out;
}

/**
 * 校验单个 `secrets` 层：非法字段丢弃。
 * 非普通对象（数组 / 字符串 / 数字等）→ undefined（丢弃该层）。
 * enabled 非 boolean → 丢弃该字段；patterns 非非空串字符串数组 → 丢弃该字段；
 * 全部字段非法 → undefined（丢弃该层）。
 */
function parseSecrets(raw: unknown): IknowSettingsSecrets | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: IknowSettingsSecrets = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (isNonEmptyStringArray(raw.patterns)) {
    out.patterns = raw.patterns.map((s) => s.trim());
  }
  if (isValidSecretMode(raw.mode)) out.mode = raw.mode;
  if (
    out.enabled === undefined &&
    out.patterns === undefined &&
    out.mode === undefined
  )
    return undefined;
  return out;
}

/** 逐层合并 secrets：project 字段优先，未覆盖的 user 字段保留。 */
function mergeSecrets(
  user: IknowSettingsSecrets | undefined,
  project: IknowSettingsSecrets | undefined
): IknowSettingsSecrets | undefined {
  if (!user && !project) return undefined;
  const out: IknowSettingsSecrets = {};
  if (project?.enabled !== undefined) out.enabled = project.enabled;
  else if (user?.enabled !== undefined) out.enabled = user.enabled;
  if (project?.patterns !== undefined) out.patterns = project.patterns;
  else if (user?.patterns !== undefined) out.patterns = user.patterns;
  if (project?.mode !== undefined) out.mode = project.mode;
  else if (user?.mode !== undefined) out.mode = user.mode;
  if (
    out.enabled === undefined &&
    out.patterns === undefined &&
    out.mode === undefined
  )
    return undefined;
  return out;
}

/**
 * 先对每层做值校验，再合并；被丢弃的字段不参与覆盖。
 *
 * ADR-0084: 生产路径上 `projectRaw` 已过项目允许名单
 * （`loadIknowSettings` → `filterProjectSettingsKeys`），非允许名单段
 * （llm / isolation / subagent / web / lsp / memory / loop / graph）恒为空对象
 * —— 各 `mergeXxx` 的 `project > user` 分支对这些段当前不可达（保留以维持
 * 合并函数自身语义完整，不删分支）。
 * 允许名单四段（hooks / verify / secrets / permissions）不受影响，project 仍按
 * 字段覆盖 user。
 */
function mergeSettings(
  userRaw: Record<string, unknown>,
  projectRaw: Record<string, unknown>
): IknowSettings {
  const userLlm = parseLlm(userRaw.llm);
  const projectLlm = parseLlm(projectRaw.llm);
  const llm = mergeLlm(userLlm, projectLlm);
  const userVerify = parseVerify(userRaw.verify);
  const projectVerify = parseVerify(projectRaw.verify);
  const verify = mergeVerify(userVerify, projectVerify);
  const userSecrets = parseSecrets(userRaw.secrets);
  const projectSecrets = parseSecrets(projectRaw.secrets);
  const secrets = mergeSecrets(userSecrets, projectSecrets);
  // #358 T1: 子代理配置段（per-task wallclock），与 llm.timeoutMs（per-call）独立。
  const userSubagent = parseSubagent(userRaw.subagent);
  const projectSubagent = parseSubagent(projectRaw.subagent);
  const subagent = mergeSubagent(userSubagent, projectSubagent);
  const userLoop = parseLoop(userRaw.loop);
  const projectLoop = parseLoop(projectRaw.loop);
  const loop = mergeLoop(userLoop, projectLoop);
  // D-α: graph 编排 overlay 的新会话默认（缺省关）。
  const userGraph = parseGraph(userRaw.graph);
  const projectGraph = parseGraph(projectRaw.graph);
  const graph = mergeGraph(userGraph, projectGraph);
  // auto-memory T4: 自动记忆开关（默认 OFF —— 段缺席即关）。
  const memory = mergeMemory(
    parseMemory(userRaw.memory),
    parseMemory(projectRaw.memory)
  );
  // ADR-0037: 会话级 git worktree 隔离开关（默认 OFF —— 段缺席即关）。
  const isolation = mergeIsolation(
    parseIsolation(userRaw.isolation),
    parseIsolation(projectRaw.isolation)
  );
  // lsp-optimization 二期 B7: LSP 配置段（全部可选，缺省走消费方默认值）。
  const lsp = mergeLsp(parseLsp(userRaw.lsp), parseLsp(projectRaw.lsp));
  // Web 工具配置段（web_search 后端选择；env > settings 回退链在 env.ts）。
  const web = mergeWeb(parseWeb(userRaw.web), parseWeb(projectRaw.web));
  // user-hook-router: 用户钩子（user hooks） 段（默认关 —— 段缺席即关）。
  const hooks = mergeHooks(
    parseHooks(userRaw.hooks),
    parseHooks(projectRaw.hooks)
  );
  // ADR-0084: 权限规则段 —— 只从项目层解析（用户层同名键在
  // `loadIknowSettings` 已被丢弃）。`projectRaw` 进来前已过允许名单。
  const permissions = parsePermissions(projectRaw.permissions);
  return assembleSettings({
    llm,
    verify,
    secrets,
    subagent,
    loop,
    graph,
    memory,
    isolation,
    lsp,
    web,
    hooks,
    permissions,
  });
}

/** 只把已解析出的段放进结果对象（absent 段不产出键）。 */
function assembleSettings(segments: IknowSettings): IknowSettings {
  const out: IknowSettings = {};
  for (const [key, value] of Object.entries(segments)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/**
 * ADR-0084: 项目层 `permissions` 段只做形状门禁（普通对象 / `schema_version`
 * number / `rule` 数组），值域与谓词合法性由
 * `src/harness/permission/project-settings.ts` 的 ajv schema 校验（typed
 * error）。形状不合法的字段丢弃，不抛错。
 */
function parsePermissions(raw: unknown): IknowSettingsPermissions | undefined {
  if (!isPlainObject(raw)) return undefined;
  const out: { schema_version?: number; rule?: ReadonlyArray<unknown> } = {};
  if (typeof raw.schema_version === "number")
    out.schema_version = raw.schema_version;
  if (Array.isArray(raw.rule)) out.rule = raw.rule;
  // 空段（两个键都非法 / 缺席）→ 不产出 permissions（对齐 parseSecrets 纪律）。
  if (out.schema_version === undefined && out.rule === undefined)
    return undefined;
  return out;
}

/** 递归冻结对象（含嵌套对象）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * ADR-0084: 项目文件顶层键过滤 —— 只放行允许名单内的键；名单外的键丢弃并
 * 逐键告警（一个键一条消息，消息含键名）。丢弃是刻意的：项目文件不得覆盖
 * 用户层（drop-not-throw，非法来源不生效）。
 */
function filterProjectSettingsKeys(
  projectRaw: Record<string, unknown>,
  onWarn: (message: string) => void
): Record<string, unknown> {
  const accepted: Record<string, unknown> = {};
  for (const key of Object.keys(projectRaw)) {
    if (PROJECT_SETTINGS_ALLOWED_KEY_SET.has(key))
      accepted[key] = projectRaw[key];
    else
      onWarn(
        `[settings] project settings key "${key}" ignored (not in project allowlist)`
      );
  }
  return accepted;
}

export function loadIknowSettings(opts?: LoadSettingsOpts): IknowSettings {
  const cwd = opts?.cwd ?? process.cwd();
  const home = opts?.home ?? homedir();
  const onWarn = opts?.onWarn ?? ((message: string) => console.warn(message));

  const userRaw = readSettingsFile(join(home, ".iknow", "settings.json"));
  const projectRaw = readSettingsFile(join(cwd, ".iknow", "settings.json"));
  if (Object.prototype.hasOwnProperty.call(userRaw, "permissions"))
    onWarn(
      '[settings] user settings key "permissions" ignored (project-layer only)'
    );

  return deepFreeze(
    mergeSettings(userRaw, filterProjectSettingsKeys(projectRaw, onWarn))
  );
}
