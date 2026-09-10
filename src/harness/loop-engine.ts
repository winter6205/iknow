/**
 * Loop Engine (013 / 014 / 015 拥有;spec Code Style 区钉死接口形状)。
 *
 * 边界:
 *   - 无可变实例字段;state 线程化、immutable 追加(S10 / S11 守门);
 *   - 014 原子校验:Adapter 交付的 AssistantTurnResult 通过后,整回合
 *     追加到 messages;tool calls 交给 Executor 串行执行;
 *   - ToolExecutionResult 经 Model Adapter.encodeToolResults 编码为
 *     原生 tool_result 块,再原子追加为一条 user message;
 *   - 016 Q3 五类停止原因:completed / maxTurns / nonSuccessStop /
 *     protocolError / emptyFinalResponse;
 *   - 017 新增两类:cancelled (signal abort) / timeout (超时强制);
 *   - 017 新增第二返回面:独立 LoopTrace,run 一次性返回
 *     `{ result: RunResult; trace: LoopTrace }`(A1 冻结形状)。
 *   - plan T3 / ADR-0011:maxTurns 超限从 silent-stop 升级为
 *     `throw MaxTurnsExceeded`;任一异常停后跑一轮 best-effort 模型
 *     收尾摘要(T4 / ADR-0011),经 `{ type: "stop_summary", text }` 事件
 *     投递,不污染权威历史。
 *   - plan T3 / ADR-0013:SDK prompt-too-long (400) → `PromptTooLongError`
 *     → reactive compact(每 run 限 1 次)压缩后重试一次模型调用。
 *
 * Loop Engine 不读取、不判断、不构造供应商原生字段;Model Adapter 是
 * 唯一允许处理原生历史的模块。
 *
 * 016 H1 修复:`step(state, deps)` 真实实现为单步状态机推进;虽然 spec
 * 原文是 sync 签名,因 `adapter.step` 本身是异步,本 step 实际返回
 * `Promise<Transition>` 以保证协议契约诚实。`run` 直接复用本 step,避免
 * 双轨实现漂移。
 *
 * 017 T5:step 内部通过 stepWithTrace 同时产出 Transition 与 TurnTrace;
 * public step() 只返 Transition(冻结 016 契约);run() 累 trace + 一次
 * computeTotals 后返回 {result, trace}。
 */

import { randomUUID } from "node:crypto";
import {
  MaxTurnsExceeded,
  MessageCommitError,
  ProtocolError,
  PromptTooLongError,
  SkipAppendEmptyPriorError,
  SkipAppendWithTextError,
  TransportRetryExhaustedError,
} from "./errors.js";
import {
  isStalledToolLoop,
  LOOP_DETECTED_TEXT,
  toolLoopEventFromCall,
  type ToolLoopEvent,
} from "./tool-loop-detect.js";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  CountTokensInput,
  CountTokensResult,
  LoopState,
  RunResult,
  TokenUsage,
  Transition,
} from "./model-adapter/types.js";
import type {
  Executor,
  Registry,
  ToolDef,
  ToolExecutionResult,
} from "./tools/types.js";
import { partitionConcurrencyWaves } from "./tools/concurrency-waves.js";
import type { CancelKind, LoopTrace, TurnTrace } from "./loop-trace.js";
import { computeTotals } from "./loop-trace.js";
import type {
  TraceErrorType,
  TraceService,
  TraceStatus,
  TraceError,
} from "./trace/index.js";
import { safeTrace } from "./trace/index.js";
import type { HarnessStreamEvent } from "./stream.js";
import { safeEmitStream } from "./stream.js";
import type { RaceTimers } from "./race-timers.js";
import { lastNonEmptyAssistant } from "./last-nonempty-assistant.js";
import {
  observeModelIdle,
  resolveModelClocks,
  startRaceTimers,
} from "./race-timers.js";
import {
  buildCompactedMessages,
  buildCompactPrompt,
  compactMessages,
  estimateMessagesTokens,
  evaluateCompactTrigger,
  getAutoCompactThreshold,
  runFullCompact,
  splitForCompaction,
} from "./compress/index.js";
import type { FullCompactOutcome } from "./compress/index.js";
import { recognize } from "./secret-roundtrip/index.js";
import type { SecretRegistry } from "./secret-roundtrip/index.js";
import {
  AGENT_STATUS_IDLE_TOOL,
  computeAgentStatusSnapshot,
} from "./agent-status.js";
import { readEnvSnapshot } from "./env-snapshot.js";
import type { GraphAssembly } from "./graph/assembly.js";
import {
  type GraphModeChange,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  renderGraphModeChangeNotification,
} from "./graph/notification.js";

/**
 * 把任意 reason 字符串安全映射为 TraceErrorType (消除 as 强转)。
 * 已知值直接透传; 未知值 (含 nonSuccessStop / maxTurns / completed) 兜底 "unknown"。
 */
function toTraceErrorType(reason: string): TraceErrorType {
  switch (reason) {
    case "cancelled":
    case "timeout":
    case "protocolError":
    case "emptyFinalResponse":
    case "validation_failed":
    case "tool_not_found":
    case "execution_failed":
      return reason;
    default:
      return "unknown";
  }
}

/**
 * 把 StopReason 安全映射为 TurnRecord.decision (消除 as 强转)。
 * maxTurns 早停不记录 turn, 该分支不可达; 兜底 "nonSuccessStop" 保持 total。
 */
function toDecision(
  reason: string
): import("./trace/types.js").TurnRecord["decision"] {
  switch (reason) {
    case "completed":
    case "nonSuccessStop":
    case "protocolError":
    case "emptyFinalResponse":
    case "cancelled":
    case "timeout":
    case "fused":
      return reason === "fused" ? "nonSuccessStop" : reason;
    default:
      return "nonSuccessStop";
  }
}

/**
 * Loop Engine 需要的完整 Adapter 接口:除 step 外还要能编码用户文本
 * 与工具结果(交给历史追加)。Anthropic Adapter / Stub Model 都按
 * 此接口实现。
 */
export interface LoopAdapter {
  readonly step: (
    state: LoopState,
    request: {
      tools?: unknown;
      /** #196 IKNOW T1:每 turn 由 deps.system?.() 解析,undefined 时不发送 system 字段。 */
      system?: string;
      onStream?: (event: HarnessStreamEvent) => void;
    },
    signal?: AbortSignal // 017 T1 决策:LoopAdapter 是 Loop Engine 直接消费接口,必须能接收 signal
  ) => Promise<AssistantTurnResult>;
  /**
   * B6 / ADR-0043 §3:可选 countTokens 钩子(溢出治理专用)。
   *
   * 真实 Anthropic adapter(`createRealAnthropicAdapter`)实现本方法 ——
   * 透传 SDK `client.messages.countTokens` 实测 token 数;Stub / 离线
   * adapter **不实现**(字段缺席 → 装配层跳过本会话,`console.warn` 一行
   * 记录,首轮不抛错、不重试,见 `aci/tool-overflow.ts` skip 语义)。
   *
   * **不入 loop-engine 消费面**:countTokens 仅装配期调用一次,会话内
   * 恒定,后续每轮 `step` 不调用本方法(避免与目标端点被动缓存兼容的
   * 抖动风险)。loop-engine 不读取本字段,接口就位仅为类型安全。
   */
  readonly countTokens?: (
    input: CountTokensInput
  ) => Promise<CountTokensResult>;
  /**
   * #178 T5 (#147 D6):实际调用模式申报 —— true = 该 adapter 走流式臂
   * (SDK `.stream()`),false/undefined = 非流式臂 / 离线替身。loop-engine
   * 只在 trace `recordLlmCall` 处读取(不读、不判断、不构造其它供应商字段);
   * 缺省语义让 stub-model / 离线 adapter 零改动保持 `stream: false`。
   */
  readonly streamMode?: boolean;
  readonly encodeUserText: (userText: string) => AnthropicNativeMessage;
  readonly encodeToolResults: (
    results: ReadonlyArray<ToolExecutionResult>
  ) => AnthropicContentBlock[];
}

export interface LoopEngineDeps {
  readonly adapter: LoopAdapter;
  readonly executor: Executor;
  readonly registry: Registry;
  /**
   * plan T5-engine / ADR-0012:单次会话最大循环轮数上限(可选)。
   * `undefined`(默认)= 无限(loop 永不因 turn 计数而停);
   * 显式配置时达上限 → throw MaxTurnsExceeded(ADR-0011,见 stepWithTrace)。
   */
  readonly maxTurns: number | undefined;
  /**
   * #196 IKNOW T1:每 turn 系统提示装配器。返回 string → 透传
   * adapter.step request.system;返回 undefined / 字段缺席 → 跳过注入
   * (行为零变化,守 #121 装配契约)。
   */
  readonly system?: () => Promise<string | undefined>;
  /** 017: 主超时,运行时兜底 DEFAULT_TIMEOUT_MS(不在类型层写死) */
  readonly timeoutMs?: number;
  /** 017: 模型侧覆盖;生效 = modelTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS */
  readonly modelTimeoutMs?: number;
  /**
   * #742 T1 / CONTEXT「model-call idle」:单次模型调用的静默上限(ms)。
   * **仅流式臂**(`adapter.streamMode === true`)生效 —— 非流式臂没有增量
   * 可以重置它,配了也按缺席处理(改前单钟逐字节不变)。缺席 / <= 0 → 关闭。
   */
  readonly modelIdleTimeoutMs?: number;
  /**
   * #742 T1 / CONTEXT「模型调用硬顶」:流式臂上从本次 step 起算的有限上限
   * (ms),到点即使仍有增量也落 `timeout`。**仅流式臂**生效;缺席 → 回落
   * `modelTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS`。
   *
   * 流式臂上它取代 `timeoutMs` 当墙钟:`timeoutMs` 是"从开打起算"的单钟,
   * 正是 T1 要修的误杀源;想在流式臂上收紧墙钟请调本字段而非 `timeoutMs`。
   */
  readonly modelHardCapMs?: number;
  /** 017: 工具侧覆盖;生效 = toolTimeoutMs ?? timeoutMs ?? DEFAULT_TIMEOUT_MS */
  readonly toolTimeoutMs?: number;
  /**
   * plan T4 / ADR-0011:收尾摘要独立短超时(ms)。缺省 15000。
   * 摘要失败 / 超时 → 跳过,绝不阻塞原始停因;测试可用小值提速。
   */
  readonly summaryTimeoutMs?: number;
  /** 064 T4: optional TraceService injection; byte-identical when absent (criterion 5/17) */
  readonly trace?: TraceService;
  /**
   * T3 / v2 (spec Open Q4):可选 agent 版本(由 caller/CLI 侧注入 getVersion() 值)。
   * 仅当 `trace` 与 `agentVersion` 同时存在时,run 末尾才落一条 session L1 根记录
   * (Loop Engine 不 import cli/usage.ts,避免写侧←cli 反向依赖)。
   * 字段缺席 → 不埋 session 记录,行为 byte-identical(既有测试零改动)。
   */
  readonly agentVersion?: string;
  /**
   * #224 注入缝 — 装配层注入"当前 turn 应进 prompt 的工具集"。
   * 每轮模型调用前由 loop-engine 通过 deps.promptTools?.() 取值；
   * 返回 ReadonlyArray<ToolDef>(Foundation 工具描述符形态)。
   * 缺省回退 deps.registry.list()(行为中性,守 S2 byte-identical)。
   */
  readonly promptTools?: () => ReadonlyArray<ToolDef>;
  /**
   * #119 T7:压缩配置缝。字段缺席 = 压缩关闭(行为零变化,守 byte-identical 纪律)。
   * contextWindow 默认 200000,thresholdTokens 缺省推导 `window - 33000`
   * (见 harness/compress/threshold.ts)。
   */
  readonly compress?: {
    readonly contextWindow: number;
    readonly thresholdTokens: number | undefined;
  };
  /**
   * #406 T2:per-engine secret registry。当存在时 run() 把用户文本中的
   * 密钥值替换为 `<<<SECRET_N>>>` 占位符后再编码为第一条 user message。
   * 缺席 → 行为与 legacy byte-identical(明文进 messages)。
   */
  readonly secretRegistry?: SecretRegistry;
  /**
   * #406 T4:secret 处理模式。"block" 关闭识别(legacy deny-only
   * preToolUse guard 处理密钥);缺省(undefined)= "roundtrip" →
   * secretRegistry 存在时识别生效。
   */
  readonly secretsMode?: "roundtrip" | "block";
  /**
   * #458 T7 (SC11): compact 边界渲染缝。可选闭包 — 当 compact 触发时,
   * 若返回非空字符串,`applyCompactAttachment` 会在 boundary placeholder
   * user 消息之后追加一条 user 消息承载渲染文本(如近期用户任务摘录)。
   * 字段缺席 → helper 早退,行为与现 master byte-identical(不改停止语义,
   * ADR-0011)。harness 不 import session-api;渲染文本由 caller(如 hub 的
   * `renderRecentUserTasksBoundary` 私有 closure)经闭包注入,零反向依赖。
   *
   * 历史: #458 早期版本由 taskFocus 字段驱动 (`renderTaskFocusBoundary`);
   * #605 T2 退休 taskFocus 字段后, 渲染源改为 `session.messages` 内的
   * `extractRecentUserTasks` 摘录。
   */
  readonly boundaryAttachment?: () => string | undefined;
  /**
   * #502 T5 / ADR-0021 D1.4:当前 session 的 conversationId（纯记账 + 入参
   * filter）。由 surface 层（chat-session / hub）注入 per-session 值；loop-engine
   * 经 executor.executeAll 第 4 参透传给 tool ctx（bash-output / bash-stop 读
   * ctx.conversationId 与 task 的 conversation_id 比对）。字段缺省 = 不过滤
   * （ask / worker / oneshot 等无会话装配零行为变化）。
   */
  readonly conversationId?: string;
  /**
   * #620 T3 (spec session-jsonl-resume D4):turn 内 commit 钩子(可选)。
   * host(hub / chat-session)注入纯 async 闭包,把已进权威历史的消息立即
   * 上盘;loop-engine 自身零 IO —— 不感知 store / 文件 / 会话格式,钩子
   * 只收 AnthropicNativeMessage(Gate B:无 session-api 类型入内核)。
   *
   * 调用点(同一 run 内严格按序):
   *   (a) assistant 消息 append 进权威历史后立刻 —— 纯文本收尾与工具
   *       回合都 commit;
   *   (b) 每个工具结果一拿到手立刻 —— 单条 user message 承载该结果的
   *       encoded tool_result block(与批量进权威历史的块逐块一致,
   *       encodeToolResults 是逐元素 map)。
   *
   * 字段缺席 → 零 commit,行为与此前完全一致(byte-identical)。
   * 失败语义:钩子抛错 → 包 MessageCommitError 重抛,run 中止;不重试、
   * 不吞咽、不改 stop 语义(见 errors.ts MessageCommitError)。
   *
   * D2 (tui-display-consistency):第二参 `thinkingMs?: number` 是 assistant
   * 回合的落盘思考时长(ms)。仅 assistant commit 调用点传入
   * `turnResult.thinkingMs`(adapter 流式臂首条 thinking_delta → 首个非思考
   * 增量的时长);tool_result commit 调用点传入 undefined。`thinkingMs <= 0`
   * 或非有限数 → 字段缺席,store 落盘不挂 key(spec 钉死边界形态)。
   * number 非 session-api 类型,不破 Gate B。
   */
  readonly commitMessages?: (
    messages: ReadonlyArray<AnthropicNativeMessage>,
    thinkingMs?: number
  ) => Promise<void>;
  /**
   * #645 T1 / ADR-0028:状态栏注入缝。字段在场 = stepWithTrace 每次即将
   * 调用模型前(首次调用 + reactive-compact 压缩后的重试)把代码现算的
   * 现势(last_tool + 未勾 todo 段)以 user 消息 immutable 追加到当时
   * `messages` 尾;旧栏保留、不 splice、不写 deps.system。字段缺席 =
   * 零注入(ask / worker 路径与既有测试 byte-identical)。todoDir 与
   * todo_write 工具同一 session 目录;栏只读文件,快照计算见
   * agent-status.ts(读失败当无 todo 段,不抛进模型回合)。
   */
  readonly agentStatus?: { readonly todoDir: string };
  /**
   * #653 G1 T5 / DESIGN-ENVIRONMENT-PRESENT:环境现势事件缝(可选)。字段
   * 在场 = stepWithTrace 每次即将调用模型前,在 appendAgentStatusBar 之后的
   * 同一回合边界计算点,调用 `readCwd()` 现读活 taskRoot 并把
   * readEnvSnapshot 的产物经 safeEmitStream 发 `env_snapshot` 流事件
   * (与 agent_status 平行的独立流;只给宿主 UI,绝不进 messages / verify /
   * ADR-0028 栏)。字段缺席 → 零 IO、零事件 (ask / worker / 既有 stub 装配
   * byte-identical)。readEnvSnapshot 永不 throw(T4 契约),观察者异常由
   * safeEmitStream 吞咽,模型回合不受影响。
   *
   * T9 (ADR-0037 §4):env_snapshot 必须读到活 taskRoot 才能让 rebind 后的人
   * 读面 (TUI cwd / git 摘要) 跟随新的 worktree。`readCwd` 是装配层注入的
   * 活 reader (LiveTaskRoot.read),每次 env_snapshot 计算时现读 —— 而不是
   * 在装配期把 cwd 钉死,否则 KV cache 之外的展示面会停在 rebind 前的根。
   *
   * 命名说明:字段叫 `readCwd` 而非 `readTaskRoot` 是为沿用 env_snapshot 数
   * 据流约定的 cwd 语义(readEnvSnapshot 收 cwd),但其值在 T9 起实际上来自
   * 活 LiveTaskRoot —— 阅读 readEnvSnapshot 内部读法时不要误以为是装配期
   * 钉死的 cwd。
   */
  readonly envSnapshot?: EnvSnapshotSeam;
  /**
   * ADR-0041 / plans/model-prefix-layering.md B3:graph 模式切换注入缝。
   * 字段在场 = stepWithTrace 每次即将调用模型前在 appendAgentStatusBar
   * 之前调用,比较本次 graphAssembly.enabled() 与 `lastSeenEnabled`
   * 持有的「上一次的值」:翻转时以 user 消息 immutable 追加一条单行
   * 静态文本(开图含编排指引、关图关闭提示),同值零追加。字段缺席 =
   * 零追加(ask / worker / 未接 overlay 的入口零行为变化,byte-identical)。
   * `lastSeenEnabled` 是 deps 寿命内的可变引用;宿主在 rebuild 引擎时
   * 自然新建一份,跨会话零泄漏。
   */
  readonly graphModeChange?: {
    readonly assembly: GraphAssembly;
    /** 上一次本 deps 看到的 graph 状态(宿主/loop-engine 写入,自身仅读 + 写入)。 */
    readonly lastSeenEnabled: { value: boolean | undefined };
  };
  /**
   * ADR-0080 / specs/graph-mode-presence.md — graph mode 每跳短现势注入缝。
   * 字段在场 = stepWithTrace 每次即将调用模型前(首调 + reactive-compact
   * 重试),在 appendGraphModeChange 之后、appendMcpReconnect 之前按
   * `assembly.enabled()` 决定是否追加一句短 `<graph_mode>`
   * (IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,SSOT in graph/notification.ts):
   *   - seam 缺席 → 零追加(ask / worker / 未接 overlay 入口零行为变化);
   *   - `enabled() === false` → 零追加(holder off / 从未开过);
   *   - 当拍 appendGraphModeChange 刚贴过长 ON(翻入 on 那一拍)→
   *     零追加(SC5:同一拍长 ON 与短现势不并存);
   *   - 其余 → 短现势以 user 消息 immutable 追加,record 进 pendingInjected
   *     (#888 契约,与 appendGraphModeChange 同形)。
   * 判定读 `assembly.enabled()`(round 快照),不读 holder、不写
   * lastSeenEnabled —— 翻转检测由 graphModeChange seam 独立承担,语义不混。
   * 不进 system / 不进 run_graph 回执 / 不进 <agent_status> 栏。
   */
  readonly graphModePresence?: {
    readonly assembly: GraphAssembly;
  };
  /**
   * B4 / ADR-0043 §4:MCP 手动重连追加缝。字段在场 = stepWithTrace 每次
   * 即将调用模型前消费 `takePending()` 拿到「回调已记录但尚未进 transcript」
   * 的重连事件,每个事件以 user 消息 immutable 追加一条单行静态文本
   * (模板钉死 MCP_RECONNECT_NOTIFICATION_TEMPLATE);无 pending → 零追加。
   * 字段缺席 = 零追加(ask / worker / 未接 manager 的入口零行为变化,
   * byte-identical)。
   *
   * 数据流:build-engine 装配期 `manager.onManualReconnect(cb)` 把事件
   * push 进 `pending`(回调在 TUI / CLI 重连动作的成功路径上触发);
   * loop-engine 在下一 step 边界 take 走并追加,追加后事件不再重复出现
   * (take = 取走 + 清空,一次性消费)。schema 变更本身由 manager 经
   * registerExternal 进 tools(下一轮 promptTools 自然含),本缝只负责
   * 告知模型「新 server 工具已可用」。
   */
  readonly mcpReconnect?: {
    /** 取走全部 pending 事件(一次性消费;返回后内部清空)。 */
    readonly takePending: () => ReadonlyArray<{
      readonly server: string;
      readonly tools: ReadonlyArray<string>;
    }>;
  };
  /**
   * #672 T3:工具环检测。缺省 / true = 开；false = 关。
   */
  readonly detectToolLoop?: boolean;
}

/**
 * 把消息及其 content blocks 冻结(S10 守门).blocks 是平铺对象({type,
 * text}/{type,id,name,input}/...);`Object.freeze({ ...b })` 浅冻结块自身
 * 的可枚举属性已足够(input 由模型给出的不可变快照,不允许回路修改)。
 */
function freezeMessage(msg: AnthropicNativeMessage): AnthropicNativeMessage {
  return Object.freeze({
    role: msg.role,
    content: Object.freeze(msg.content.map((b) => Object.freeze({ ...b }))),
  });
}

/**
 * #620 T3:调 host 注入的 commit 钩子;钩子缺席 = 零 IO 早退(行为不变)。
 * 钩子失败统一包 MessageCommitError 上抛(命名失败,不静默吞咽)。
 *
 * D2 (tui-display-consistency):第二参 `thinkingMs` 透传到 host 钩子;
 * 缺席 (undefined) → host 钩子不挂 key,与既有 byte-identical 行为一致。
 * tool_result commit 点传 undefined;assistant commit 点传
 * `turnResult.thinkingMs`(可能是 undefined:non-stream / 无思考 / 边界非法)。
 */
async function commitMessagesOrThrow(
  deps: LoopEngineDeps,
  messages: ReadonlyArray<AnthropicNativeMessage>,
  thinkingMs?: number
): Promise<void> {
  if (deps.commitMessages === undefined) return;
  try {
    await deps.commitMessages(messages, thinkingMs);
  } catch (err) {
    throw new MessageCommitError(err);
  }
}

/**
 * #888 save-fork 修复:run 作用域的注入消息 pending 缓冲。
 *
 * appendGraphModeChange / appendMcpReconnect / appendAgentStatusBar 把 user
 * 注入消息 immutable 追加进内存权威历史,但从不经过 commitMessagesOrThrow
 * 落 JSONL 链。run 结束后宿主收尾 save(hub / chat)把含注入消息的内存
 * 投影与纯 commit 链做 LCP
 * 对齐,在第一条注入消息处 jsonDeepEqual 失配 → planSessionSave 判 fork,
 * parent 回落、真实前缀孤儿化,下一个 run 从 query 重放整轮(#888 现象)。
 *
 * 本缓冲让注入消息在下一次 assistant / tool_result commit 时随批 flush
 * (loop-detected envelope 的既有先例同形态),恢复不变式:
 *   「内存权威历史 − seed query」==「盘上 commit 链 − 宿主懒提交的 query 前缀」。
 * 停止路径处置:
 *   - cancelled:run() 收尾在 appendSystemInterrupt 后把 pending + system
 *     interrupt 一起 flush(收尾 save 的投影与链对齐,不 fork);
 *   - protocolError / emptyFinalResponse:pending 丢弃(#120 裁决:turn 不进
 *     历史,save 判 prefix/extension,零新增 fork 面);
 *   - timeout / fused / nonSuccessStop:pending 已随最后一个 tool_result /
 *     assistant commit flush,无残留。
 *   - compact(reactive / proactive)重建历史后 pending 清空:压缩产物与
 *     旧链本就不可 LCP 对齐(既有 fork-copy 语义),flush 旧 pending 只会
 *     把可能已不在内存的消息写上盘。
 * 钩子缺席(commitMessages undefined)时缓冲仍照常累积/清空——flush 是
 * no-op,零 IO 语义不变。
 */
function createPendingInjected() {
  let pending: AnthropicNativeMessage[] = [];
  return {
    /** 注入点调用:入缓冲,返回该消息供 appendMessage 追加进权威历史。 */
    record(msg: AnthropicNativeMessage): AnthropicNativeMessage {
      pending.push(msg);
      return msg;
    },
    /** commit 点调用:返回全部 pending 并清空(flush 即清,顺序保持)。 */
    take(): AnthropicNativeMessage[] {
      if (pending.length === 0) return [];
      const flushed = pending;
      pending = [];
      return flushed;
    },
  };
}

type PendingInjected = ReturnType<typeof createPendingInjected>;

function appendMessage(opts: {
  readonly state: LoopState;
  readonly msg: AnthropicNativeMessage;
}): LoopState {
  return {
    messages: Object.freeze([...opts.state.messages, freezeMessage(opts.msg)]),
    turnCount: opts.state.turnCount,
  };
}

/**
 * #645 T1 / ADR-0028:把现势栏以 user 消息 immutable 追加到 `messages` 尾
 * (经 adapter.encodeUserText 编码,与首条用户文本同一缝)。
 * `deps.agentStatus` 缺席 → 原样返回 state(零注入);在场 → 现算快照
 * (todos.md 读失败当无 todo 段,见 agent-status.ts),追加后返回新 state。
 * 永不 throw:读失败已收敛为"无 todo 段",模型回合不受影响。
 *
 * #647 T3 / ADR-0028:同一计算点(同一份 snapshot 对象)经 safeEmitStream 发
 * `agent_status` 流事件 —— TUI 只读最新现势的读口;事件字段即栏的数据字段,
 * 两处不可能分叉(单一真源)。观察者异常被 safeEmitStream 吞咽,不反流进
 * 模型回合。deps.agentStatus 缺席 → 无栏也无事件(ask / worker 路径)。
 *
 * #888:注入消息同时 record 进 pending 缓冲 —— 下一次 assistant / tool_result
 * commit 时随批 flush 上盘,消除 save-fork。
 */
async function appendAgentStatusBar(
  state: LoopState,
  deps: LoopEngineDeps,
  lastTool: string,
  pendingInjected: PendingInjected,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<LoopState> {
  if (deps.agentStatus === undefined) return state;
  const snapshot = await computeAgentStatusSnapshot({
    lastTool,
    todoDir: deps.agentStatus.todoDir,
    // Per-conversation projection: read THIS session's ledger (same SSOT the
    // todo_write writer resolves through). deps.conversationId is injected
    // per-session by the surface layer (#502 T5); absent (ask / worker) →
    // legacy shared-root read.
    conversationId: deps.conversationId,
  });
  safeEmitStream(onStream, {
    type: "agent_status",
    lastTool: snapshot.lastTool,
    openTodoLines: snapshot.openTodoLines,
  });
  const msg = deps.adapter.encodeUserText(snapshot.text);
  pendingInjected.record(msg);
  return appendMessage({ state, msg });
}

/**
 * #653 G1 T5 / DESIGN-ENVIRONMENT-PRESENT:在 appendAgentStatusBar 之后的
 * 同一回合边界计算点,把环境现势快照经 safeEmitStream 发 `env_snapshot`
 * 流事件 —— 与 `agent_status` 平行的**独立**事件流(人读 chrome 数据源,
 * 给 TUI EnvironmentPane;给人不给模型)。**不**复用 agent_status 事件 /
 * 快照结构,**不**追加任何消息(state 原样返回),**不**进 messages /
 * verify / ADR-0028 栏。
 *
 * deps.envSnapshot 缺席 → 零 IO 早退(ask / worker / 既有装配零行为变化)。
 * readEnvSnapshot 永不 throw(T4:git 失败 → git 字段全 null、cwd 保留,
 * EXIT degraded);观察者异常由 safeEmitStream 吞咽,模型回合不受影响。
 */
async function appendEnvSnapshot(
  state: LoopState,
  deps: LoopEngineDeps,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<LoopState> {
  if (deps.envSnapshot === undefined) return state;
  // T9:每次即将调模型前现读活 taskRoot,而不是用装配期快照 —— 这样 rebind
  // 后下一波 tool calls 的人读面 (TUI cwd / git 摘要) 跟随活根,而 system
  // prompt 仍钉在稳定根,KV 缓存前缀字节不变。
  const snapshot = await readEnvSnapshot({ cwd: deps.envSnapshot.readCwd() });
  safeEmitStream(onStream, { type: "env_snapshot", snapshot });
  return state;
}

/**
 * ADR-0041 / plans/model-prefix-layering.md B3:graph 模式切换追加缝。
 * 比较本次 graphAssembly.enabled() 与 `lastSeenEnabled.value` 持有的
 * 「上一次值」:翻转 → encodeUserText + appendMessage + safeEmitStream
 * 发 `graph_mode_changed` 流事件;同值 → 零追加,state 原样返回。
 *
 * 形态镜像 appendAgentStatusBar(seam 缺席 → 零注入,行为 byte-identical):
 *   - deps.graphModeChange 缺席 → return state(ask / worker / 未接
 *     overlay 的入口零行为变化);
 *   - seam 在场 → 每步调用,同 round 内连续多步翻转检测无误;
 *   - 写入更新由本函数完成,`lastSeenEnabled` 与 deps 同步生命周期
 *     (rebuild 引擎时宿主自然新建一份,跨会话零泄漏);
 *   - 切换文本 = SSOT(renderGraphModeChangeNotification),开图含
 *     编排指引,关图含关闭提示 —— 内容并入 IKNOW_GRAPH_ORCHESTRATION_TEXT。
 *
 * 判定次序:appendAgentStatusBar 之前调用,确保 status bar 在
 * graph 切换提示之后(后注入的 message 排在末尾,模型面看到的次序
 * 与写入次序一致)。
 *
 * 返回值 `{ state, appendedLongOn }`:`appendedLongOn === true` 当且仅当
 * 本拍因翻入 on 实际贴了长 ON 通知(IKNOW_GRAPH_MODE_ON_NOTIFICATION),
 * 给同段后续的 appendGraphModePresence 用作 SC5 去重信号 —— 同一拍长
 * ON 与短现势不并存。其他路径(off 翻转 / 同值 / seam 缺席 / 初值观察)
 * 均为 false。
 *
 * #888:切换提示同样 record 进 pending 缓冲,随下一批 commit flush。
 */
async function appendGraphModeChange(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected,
  onStream?: (event: HarnessStreamEvent) => void
): Promise<{ state: LoopState; appendedLongOn: boolean }> {
  const seam = deps.graphModeChange;
  if (seam === undefined) return { state, appendedLongOn: false };
  const next = seam.assembly.enabled();
  const last = seam.lastSeenEnabled.value;
  // 初次观察(last = undefined):只记初值,不追加 —— 新会话/新 deps
  // 的第一轮没有「翻转」可言,关图开局更不能灌一条 off 提示。
  if (last === undefined) {
    seam.lastSeenEnabled.value = next;
    return { state, appendedLongOn: false };
  }
  if (last === next) return { state, appendedLongOn: false };
  const change: GraphModeChange = next ? "on" : "off";
  const text = renderGraphModeChangeNotification(change);
  seam.lastSeenEnabled.value = next;
  safeEmitStream(onStream, {
    type: "graph_mode_changed",
    enabled: next,
  });
  const msg = deps.adapter.encodeUserText(text);
  pendingInjected.record(msg);
  return {
    state: appendMessage({ state, msg }),
    appendedLongOn: change === "on",
  };
}

/**
 * ADR-0080 / specs/graph-mode-presence.md — graph mode 每跳短现势追加缝。
 *
 * 判定次序:在 appendGraphModeChange 之后、appendMcpReconnect 之前调用
 * (与既有同段「环境级事件 → 当前态栏」次序一致;graph 切换提示之后,
 * 短现势之后,再走 MCP 重连 + status bar + env snapshot)。形态镜像
 * appendGraphModeChange 的 seam-缺席 → 零注入分支。
 *
 * 判定四段:
 *   1. deps.graphModePresence 缺席 → 零追加(ask / worker / 未接 overlay
 *      入口零行为变化,byte-identical);
 *   2. `assembly.enabled() === false` → 零追加(holder off / 从未开过,
 *      SC2);
 *   3. `appendedLongOn === true` → 零追加(SC5:本拍因翻入 on 已贴长 ON,
 *      不叠短现势;长 OFF 不冲突,因为关图意味着 enabled=false,前面
 *      分支 2 已早退);
 *   4. 其余 → encodeUserText + appendMessage + record 进 pendingInjected。
 *
 * 不写 lastSeenEnabled —— 翻转检测由 appendGraphModeChange seam 独立
 * 承担,这里只读 enabled() 的 round 快照(SC4:同 round 中途翻键不出现
 * 新短现势,beginRound 后才按新值)。
 *
 * 不进 system / run_graph 回执 / <agent_status> 栏(SC6);text = SSOT
 * (IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION),会话内字节恒定 → KV cache
 * 尾部追加兼容(每拍都追加同一字符串)。
 */
async function appendGraphModePresence(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected,
  appendedLongOn: boolean
): Promise<LoopState> {
  const seam = deps.graphModePresence;
  if (seam === undefined) return state;
  if (appendedLongOn) return state;
  if (!seam.assembly.enabled()) return state;
  const msg = deps.adapter.encodeUserText(
    IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION
  );
  pendingInjected.record(msg);
  return appendMessage({ state, msg });
}

/**
 * B4 / ADR-0043 §4:MCP 手动重连通知模板(SSOT)。
 *
 * 单行静态文本:`<server>` + 工具名清单由 appendMcpReconnect 现拼;
 * 本常量钉住文案骨架,测试引用常量不走字面。与 graph_mode_change 同形:
 * user 消息 immutable 追加,transcript 一等公民,KV 缓存只受 messages
 * 尾部追加影响(前缀 tools/system 不动)。
 */
export const MCP_RECONNECT_NOTIFICATION_TEMPLATE =
  "MCP server '<server>' reconnected manually — its tools are now available: <tools>. Schemas were not loaded; call tool_search before invoking any of them.";

/**
 * B4 / ADR-0043 §4:MCP 手动重连追加缝。消费 `deps.mcpReconnect.takePending()`
 * 的 pending 事件,每个事件以 user 消息 immutable 追加一条单行文本
 * (MCP_RECONNECT_NOTIFICATION_TEMPLATE,`<server>` / `<tools>` 现拼)。
 *
 * 形态镜像 appendGraphModeChange(seam 缺席 → 零注入,行为 byte-identical):
 *   - deps.mcpReconnect 缺席 → return state(ask / worker / 未接 manager);
 *   - takePending() 返回空 → 零追加,state 原样返回;
 *   - 多个 pending 事件按记录顺序逐条追加(一次重连一个事件);
 *   - 消息次序:在 graph 切换提示之后、status bar 之前 —— 与 graphModeChange
 *     同一判定段(环境级事件先于回合现势栏)。
 *
 * 判定次序:与 appendGraphModeChange 并列,appendAgentStatusBar 之前调用,
 * 保证 status bar 在重连提示之后(模型读到时序 = 重连告知 → 现势栏)。
 *
 * #888:重连提示同样 record 进 pending 缓冲,随下一批 commit flush。
 */
function appendMcpReconnect(
  state: LoopState,
  deps: LoopEngineDeps,
  pendingInjected: PendingInjected
): LoopState {
  const seam = deps.mcpReconnect;
  if (seam === undefined) return state;
  const pending = seam.takePending();
  if (pending.length === 0) return state;
  let next = state;
  for (const event of pending) {
    const text = MCP_RECONNECT_NOTIFICATION_TEMPLATE.replace(
      "<server>",
      event.server
    ).replace("<tools>", event.tools.join(", "));
    const msg = deps.adapter.encodeUserText(text);
    pendingInjected.record(msg);
    next = appendMessage({ state: next, msg });
  }
  return next;
}

/** Ctrl+C / signal abort 触发的中断 system 消息固定文案（#392 T4 / G3 #388）。
 *  Transcript 一等公民：append 到 LoopState.messages 末尾，随持久化/渲染/
 * rewind 一起出现；provider 边界（buildMessageParams filter，T2）剥离它，
 * 绝不进 SDK wire body。system 不构成 turn：splitTurns 按
 * `role === "user"` 且非 tool_result 切片，system 项自然落在相邻 turn 间隙。 */
const SYSTEM_INTERRUPT_TEXT = "Interrupted by user.";

/** 把 system 中断消息 append 到权威历史末尾（immutable）；与 appendMessage
 *  同样的冻结纪律，append-only 不变式不破。 */
function appendSystemInterrupt(state: LoopState): LoopState {
  return {
    messages: Object.freeze([
      ...state.messages,
      freezeMessage({
        role: "system",
        content: [{ type: "text", text: SYSTEM_INTERRUPT_TEXT }],
      }),
    ]),
    turnCount: state.turnCount,
  };
}

/**
 * #458 T7 (SC11):统一两处 compact 调用点(reactive / proactive)的压缩 +
 * 边界渲染缝。原 placeholder 路径保持不变,现叠加 #467 step 2 的 LLM
 * 结构化摘要优先路径:
 *
 *   1. `splitForCompaction(state.messages, DEFAULT_KEEP_RECENT)` 复用
 *      window.ts tool-pair 守门拆 dropped / kept;无可丢前缀 →
 *      return state(行为与旧 `compacted === state.messages` 早退一致);
 *   2. best-effort `runFullCompact` 对 dropped 跑一轮 LLM 摘要
 *      (no tools → 纯文本;adapter 拒绝 / 超时 / 空响应 → 各种 outcome);
 *   3. `summarized` → `buildCompactedMessages`:
 *      [summary user 消息, (可选 boundaryAttr), ...kept];
 *   4. `signal_aborted`(wait 逻辑参考 Claude Code:压缩中取消 = 保持会话原样,
 *      不做 fallback 截断,与 timeout / adapter_failed 不同)→ 返回 state 不变;
 *   5. 其余 outcome → 回退现有 `compactMessages` + boundary placeholder
 *      路径(#467 决议:摘要失败绝不阻塞主 loop)。
 *
 * 停止语义守门不变:boundaryAttachment 字段缺席 → 摘要路径不插入 attachment,
 * 回退路径与现 master byte-identical;普通 turn(非 compact)→ helper 不被调用。
 *
 * `opts.signal` / `opts.onStream`:run 级取消信号与流式事件观察者透传到
 * `runFullCompact`——reactive 调用点传 `opts.signal`(PromptTooLongError 重试
 * 前压缩期间用户取消 → 保持原样 → protocolError 收场);proactive 调用点传
 * `opts?.onStream`(宿主收到 compaction_started / completed / failed +
 * compaction_text_delta,后由 full-compact innerOnStream 重映射而来,#550
 * 渲染污染守门)。缺席 → 行为零变化(旧 `signal: undefined` 语义)。
 */
async function applyCompactAttachment(
  state: LoopState,
  deps: LoopEngineDeps,
  opts?: {
    readonly signal?: AbortSignal;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }
): Promise<LoopState> {
  const split = splitForCompaction(state.messages);
  if (split === undefined) return state;

  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  const inputMessages: ReadonlyArray<AnthropicNativeMessage> = Object.freeze([
    ...split.dropped,
    deps.adapter.encodeUserText(buildCompactPrompt()),
  ]);
  const outcome = await runFullCompact({
    adapter: deps.adapter,
    dropped: split.dropped,
    signal: opts?.signal,
    onStream: opts?.onStream,
  });
  const endedAt = new Date().toISOString();
  const durationMs = performance.now() - startMono;

  // wait 逻辑参考 Claude Code:压缩中取消(Esc/Ctrl+C)→ 会话保持原样,
  // 不做 fallback 截断(截断会让摘要失败路径的 messages 丢失,与"取消即无变化"
  // 的取消语义冲突)。调用方据此决定后续收场(reactive → protocolError;
  // proactive → 下一轮 stepWithTrace 看到 callerAbort 取消)。
  if (outcome.kind === "signal_aborted") {
    return state;
  }

  if (outcome.kind === "summarized") {
    const boundary = deps.boundaryAttachment?.();
    const composed = buildCompactedMessages({
      summaryText: outcome.text,
      kept: split.kept,
      boundaryText: boundary,
    });
    await recordCompactLlmCall({
      deps,
      startedAt,
      endedAt,
      durationMs,
      status: "ok",
      outcome,
      inputMessages,
    });
    return {
      ...state,
      messages: Object.freeze(composed.map((m) => freezeMessage(m))),
    };
  }

  // 摘要失败 / 超时 / 空响应 / adapter 拒绝 → 回退旧纯截断 placeholder 路径。
  const compacted = compactMessages(state.messages);
  if (compacted === state.messages) return state;
  await recordCompactLlmCall({
    deps,
    startedAt,
    endedAt,
    durationMs,
    status: "error",
    outcome,
    inputMessages,
  });
  const boundary = deps.boundaryAttachment?.();
  const composed: ReadonlyArray<AnthropicNativeMessage> =
    boundary !== undefined && boundary.length > 0
      ? [
          compacted[0]!,
          { role: "user", content: [{ type: "text", text: boundary }] },
          ...compacted.slice(1),
        ]
      : compacted;
  return {
    ...state,
    messages: Object.freeze(composed.map((m) => freezeMessage(m))),
  };
}

/**
 * plan compress-trigger-gate T3:proactive auto-compact 在 token 已超但
 * `splitForCompaction` 无窗口(`messages.length <= DEFAULT_KEEP_RECENT`)时的
 * full summary 降级路径。整段 messages 都视为 dropped(无 kept tail)调
 * `runFullCompact` 跑一次 LLM 摘要;成功后用 `buildCompactedMessages`
 * 重建,命中与窗口压缩同一 `boundaryAttachment` 注入点。
 *
 * 与 `applyCompactAttachment` 的语义差:
 *   - 入参:整段 `state.messages` 都视为 dropped(没有 `keepRecent` 切割);
 *     `applyCompactAttachment` 走 `splitForCompaction` 留 6 条 kept tail。
 *   - 失败回退:本路径**不回退**到 `compactMessages` 纯截断 placeholder——
 *     整段消息视为 dropped 再走 `compactMessages` 等于清空,过于激进
 *     (#467 决议:摘要失败绝不阻塞主 loop,但 full summary 路径宁可保留
 *     原状让 reactive 兜底处理 PromptTooLongError,每 run 限 1 次契约保留)。
 *     失败 / 超时 / 空响应 / adapter 拒绝 → 返回 state 不变;
 *     `lastCompactTurn` 因外层 `compactedState.messages !== state.messages`
 *     检查不更新,下一轮 step 重新进 gate 再尝试(无死循环)。
 *   - signal_aborted → state 不变(Claude Code 取消语义)。
 *
 * `opts.signal` / `opts.onStream`:语义与 `applyCompactAttachment` 完全一致,
 * reactive 调用点传 `opts.signal`(PromptTooLongError 重试前压缩期间用户取消 →
 * 保持原样 → protocolError 收场);proactive 调用点传 `opts?.onStream`
 * (宿主收到 compaction_started / completed / failed + compaction_text_delta)。
 */
async function applyFullCompactSummary(
  state: LoopState,
  deps: LoopEngineDeps,
  opts?: {
    readonly signal?: AbortSignal;
    readonly onStream?: (event: HarnessStreamEvent) => void;
  }
): Promise<LoopState> {
  if (state.messages.length === 0) return state;

  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  const inputMessages: ReadonlyArray<AnthropicNativeMessage> = Object.freeze([
    ...state.messages,
    deps.adapter.encodeUserText(buildCompactPrompt()),
  ]);
  const outcome = await runFullCompact({
    adapter: deps.adapter,
    dropped: state.messages,
    signal: opts?.signal,
    onStream: opts?.onStream,
  });
  const endedAt = new Date().toISOString();
  const durationMs = performance.now() - startMono;

  // Claude Code 取消语义:中途 signal abort → state 不变
  // (与 applyCompactAttachment 同一守门,详见该 helper 注释)。
  if (outcome.kind === "signal_aborted") return state;

  if (outcome.kind === "summarized") {
    const boundary = deps.boundaryAttachment?.();
    const composed = buildCompactedMessages({
      summaryText: outcome.text,
      kept: [],
      boundaryText: boundary,
    });
    await recordCompactLlmCall({
      deps,
      startedAt,
      endedAt,
      durationMs,
      status: "ok",
      outcome,
      inputMessages,
    });
    return {
      ...state,
      messages: Object.freeze(composed.map((m) => freezeMessage(m))),
    };
  }

  // 摘要失败 / 超时 / 空响应 / adapter 拒绝 → state 不变;让 reactive 兜底处理
  // PromptTooLongError(每 run 限 1 次契约保留)。lastCompactTurn 在外层因
  // `compactedState.messages === state.messages` 不更新 → 下一轮 re-enter gate,
  // 死循环防御由 evaluateCompactTrigger 自己(noop 早退)兜住。
  await recordCompactLlmCall({
    deps,
    startedAt,
    endedAt,
    durationMs,
    status: "error",
    outcome,
    inputMessages,
  });
  return state;
}

/**
 * #467 step 2:compact 摘要轮的 trace 落盘(best-effort,失败不阻塞)。
 * 模式对齐 epilogueSummary(loop-engine.ts:517)的 recordLlmCall:成功路径
 * usage 展开填四 token 字段,失败路径 status "error" + error.message 携带
 * outcome.kind(kind 不在 TraceErrorType 联合内,走 "unknown" 兜底,具体
 * kind 保留在 message 供观测方区分)。POSTEL(ADR-0008 D3):usage 缺席时
 * *_tokens 键缺席(not zero)。
 */
async function recordCompactLlmCall(opts: {
  readonly deps: LoopEngineDeps;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly status: "ok" | "error";
  readonly outcome: FullCompactOutcome;
  readonly inputMessages: ReadonlyArray<AnthropicNativeMessage>;
}): Promise<void> {
  if (opts.deps.trace === undefined) return;
  const streamMode = opts.deps.adapter.streamMode === true;
  const usage =
    opts.outcome.kind === "summarized" ? opts.outcome.usage : undefined;
  const error: TraceError | undefined =
    opts.status === "error"
      ? {
          type: "unknown",
          message: `compact_${opts.outcome.kind}${
            opts.outcome.kind === "adapter_failed"
              ? `: ${opts.outcome.message}`
              : ""
          }`,
        }
      : undefined;
  await safeTrace(() =>
    opts.deps.trace!.recordLlmCall({
      startedAt: opts.startedAt,
      endedAt: opts.endedAt,
      durationMs: opts.durationMs,
      ...(opts.status === "ok" ? { supplierStop: "success" } : {}),
      stream: streamMode,
      messagesCaptured: true,
      messages: opts.inputMessages,
      status: opts.status,
      ...(error !== undefined ? { error } : {}),
      ...(usage !== undefined ? usage : {}),
    })
  );
}

/**
 * 从权威历史派生 `result.finalText`(仅 `reason === "completed"` 时调用)。
 *
 * 算法:倒序扫 messages,找到**第一条带非空 text 的 assistant** 回合,
 * 返回其 text 块拼接;越过空 text 的 assistant(如纯 tool_use 回合)继续
 * 回扫;无则返回 null。
 *
 * 与 `src/cli/format.ts` 的 `renderAssistantAnswer({showThinking:false})`
 * 在边界上存在细微差异:后者停在最后一条 assistant(不回扫空 text)。
 * 生产路径 `formatRunHuman` 走 `result.finalText`(本函数),分歧仅在
 * `renderAssistantAnswer(false)` 的直接测试调用暴露;由
 * `tests/cli/format.test.ts` 的不变量回归测试钉住一致性。
 *
 * 导出供测试引用同一真源(`result.finalText` 契约),非通用工具。
 */
export function deriveFinalText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string | null {
  return lastNonEmptyAssistant(messages)?.text ?? null;
}

/** 017 A3:超时运行时兜底。仅当 side-specific 与主超时字段都缺省时生效;按阶段解析,不存储。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * plan T4 / ADR-0011:收尾摘要 (epilogue) 常量。
 *
 * 摘要轮是**纯文本**单轮模型调用(不携带工具),best-effort:
 *   - 独立短超时,避免摘要拖垮原始停因的返回;
 *   - 输入 = transcript 尾部 ~8K token 估算窗口 + 停因 reason;
 *   - 失败 / 超时 / signal 已 abort → 静默跳过,原始停因不受阻塞。
 * 摘要结果不 append 进 `_messages`(append-only 权威历史不变)。
 */
const SUMMARY_TIMEOUT_MS = 15_000;
const SUMMARY_TAIL_TOKEN_BUDGET = 8_000;
/** 摘要尾部窗口的条数兜底(估算超窗时按此截取尾部;S5 命名常量)。 */
const SUMMARY_TAIL_FALLBACK_MESSAGES = 20;
const SUMMARY_PROMPT = (reason: string): string =>
  `Briefly summarize in a few sentences what was done in this conversation and why it ended (stop reason: ${reason}). Keep it concise.`;

/**
 * plan T4 / ADR-0011:best-effort 收尾摘要模型调用的纯文本产物。
 *
 * 收尾摘要的成功路径只关心两件事:`text`(投递给 host 的 stop_summary
 * 事件载荷)和 `usage`(摘要轮的 token 计量,走 trace `recordLlmCall`
 * `LlmCallRecord`,status ok,Postel 字段出席 — ADR-0008 Decision 3
 * 不在这里脱钩)。failure / 超时 / signal-abort → 返回 null,调用方
 * 静默跳过,绝不阻塞原始停因。
 */
interface SummaryOutcome {
  readonly text: string;
  readonly usage: TokenUsage | undefined;
  /** 摘要轮模型实际看到的输入消息(truncateTailForSummary 截尾 + 收尾 user prompt) */
  readonly inputMessages: ReadonlyArray<AnthropicNativeMessage>;
}

/**
 * plan T4 / ADR-0011:截取摘要输入的历史尾部窗口。
 *
 * 估算尾部 ~8K token 窗口作摘要输入(天然在窗内,避免超窗 reactive-compact
 * 兜底)。估算超窗 → 先按尾部条数截取;极端长历史一次截取仍超窗 → 再用
 * compactMessages 收口(它保 tool 配对)。
 */
function truncateTailForSummary(
  messages: ReadonlyArray<AnthropicNativeMessage>
): ReadonlyArray<AnthropicNativeMessage> {
  let tail = messages;
  if (estimateMessagesTokens(tail) > SUMMARY_TAIL_TOKEN_BUDGET) {
    const from = Math.max(0, tail.length - SUMMARY_TAIL_FALLBACK_MESSAGES);
    tail = tail.slice(from);
    if (estimateMessagesTokens(tail) > SUMMARY_TAIL_TOKEN_BUDGET) {
      tail = compactMessages(tail);
    }
  }
  return tail;
}

/**
 * plan T4 / ADR-0011:带独立超时的摘要模型调用。
 *
 * 构造独立 `{ messages, turnCount: 0 }` 状态(与主 loop turnCount 解耦 ——
 * 摘要轮不计 maxTurns,不消费工具预算);调 `adapter.step` 一次(不传 tools
 * → 纯文本,无工具触发);`Promise.race` 包独立 ~15s 超时 + catch-all。
 *
 * 内部 AbortController:超时触发时中止真实 HTTP 请求(对齐 raceModel 的
 * timer → childAbort 纪律);与 run 级 signal 合并为 composite 传给
 * adapter.step —— concurrent 场景 run signal abort 会同步取消摘要调用。
 * adapterP 永不 reject:catch-all 把失败收敛为 null,避免 race 后到 rejection
 * 触发 unhandledRejection(测试替身 / 真 SDK 都可能)。失败 / 超时 → null。
 */
async function runSummaryWithTimeout(opts: {
  readonly deps: LoopEngineDeps;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly reason: string;
  readonly signal: AbortSignal | undefined;
}): Promise<SummaryOutcome | null> {
  const messages: ReadonlyArray<AnthropicNativeMessage> = Object.freeze([
    ...opts.messages.map(freezeMessage),
    freezeMessage(
      opts.deps.adapter.encodeUserText(SUMMARY_PROMPT(opts.reason))
    ),
  ]);
  const summaryState: LoopState = Object.freeze({ messages, turnCount: 0 });
  const request = Object.freeze({});
  const summaryController = new AbortController();
  const compositeSignal = AbortSignal.any(
    opts.signal
      ? [opts.signal, summaryController.signal]
      : [summaryController.signal]
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let adapterResolved = false;
  const adapterP = opts.deps.adapter
    .step(summaryState, request, compositeSignal)
    .then(
      (r): SummaryOutcome | null => {
        adapterResolved = true;
        if (timer !== undefined) clearTimeout(timer);
        const text = (r.projection.texts ?? []).join("\n").trim();
        return text.length > 0
          ? { text, usage: r.usage, inputMessages: messages }
          : null;
      },
      (): SummaryOutcome | null => {
        adapterResolved = true;
        return null;
      }
    );
  const timeoutP = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      summaryController.abort();
      resolve(null);
    }, opts.deps.summaryTimeoutMs ?? SUMMARY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([adapterP, timeoutP]);
  } catch {
    // catch-all:摘要失败绝不阻塞原始停因(ADR-0011 Decision 4)。
    return null;
  } finally {
    if (!adapterResolved && timer !== undefined) clearTimeout(timer);
  }
}

/**
 * plan T4 / ADR-0011:best-effort 收尾摘要模型调用(编排)。
 *
 * signal 已 abort(concurrent 场景)→ 直接取消,不发起模型调用。
 * 返回 `SummaryOutcome` 或 `null`(失败/超时/signal-abort)。
 */
async function tryRunSummary(opts: {
  readonly deps: LoopEngineDeps;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly reason: string;
  readonly signal: AbortSignal | undefined;
}): Promise<SummaryOutcome | null> {
  if (opts.signal?.aborted) return null;
  const tail = truncateTailForSummary(opts.messages);
  return runSummaryWithTimeout({
    deps: opts.deps,
    messages: tail,
    reason: opts.reason,
    signal: opts.signal,
  });
}

/**
 * plan T4 / ADR-0011:run() 收尾 —— 异常停后跑一轮收尾摘要并落 trace。
 *
 * 只处理 `reason !== "completed"` 的异常停(maxTurns / protocolError /
 * cancelled / timeout 等)。摘要轮:
 *   - 不 append 进权威历史(append-only 不变式);
 *   - 不计 maxTurns / 工具预算;
 *   - usage 照落 trace `LlmCallRecord`(status ok);
 *   - 结果经 `{ type: "stop_summary", text }` 事件投递给 host。
 *
 * **trace 兼容纪律**:run 的既有 recordLlmCall 契约是"每次成功的模型
 * 调用落一条 llm_call,每次模型阶段落一条 turn"。摘要轮在此之外额外
 * 落一条独立的 `recordLlmCall`(status ok),**不**额外落 turn ——
 * 避免破坏既有 turn 序列的 `lines.length` 精确断言(挂 maxTurns 的
 * 断言由本分支 throw 前内部先行记录 turn)。
 *
 * **#358 T3 导出**:worker.ts 在 run() 返回 cancelled + subagent-timeout
 * abort 后以**未中止**的新 signal 自跑本收尾摘要轮 (spec Code Style
 * "catch 侧跑 epilogueSummary 一轮" 的进程内落实; signal 已 abort 时
 * run() 内部不会跑, 故由 worker 补上)。导出为 additive, 逻辑零改动。
 */
export async function epilogueSummary(opts: {
  readonly deps: LoopEngineDeps;
  readonly messages: ReadonlyArray<AnthropicNativeMessage>;
  readonly reason: string;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  readonly signal: AbortSignal | undefined;
}): Promise<void> {
  if (opts.signal?.aborted) return;
  const startedAt = new Date().toISOString();
  const startMono = performance.now();
  const outcome = await tryRunSummary(opts);
  if (outcome === null || opts.signal?.aborted) return;
  const endedAt = new Date().toISOString();
  const durationMs = performance.now() - startMono;
  if (opts.deps.trace) {
    const streamMode = opts.deps.adapter.streamMode === true;
    await safeTrace(() =>
      opts.deps.trace!.recordLlmCall({
        startedAt,
        endedAt,
        durationMs,
        supplierStop: "success",
        stream: streamMode,
        // ADR-0014 决策 6 / #361 T12:摘要轮捕获模型实际看到的 messages。
        // review-fix S5:改用 outcome.inputMessages = tryRunSummary 经
        // truncateTailForSummary 截尾后的输入 + 收尾 user prompt(即模型
        // 本轮真实看到的 messages),不再用 opts.messages(完整 pre-summary
        // 历史,与模型所见不符)。
        // 取舍:全量消息进 trace 会膨胀 jsonl;LlmCallRecord.messages 字段
        // 语义即"模型实际看到的 messages"(ADR-0003 既有字段),摘要轮同样
        // 满足该语义,保持一致填充。token 计数照旧经 *_tokens 字段表达。
        messagesCaptured: true,
        messages: outcome.inputMessages,
        // SC-W 5:摘要轮同样无可填 model 字段(adapter 不暴露,见 ok 分支注释)。
        status: "ok",
        ...(outcome.usage !== undefined ? outcome.usage : {}),
      })
    );
  }
  try {
    opts.onStream?.({ type: "stop_summary", text: outcome.text });
  } catch {
    // 观察者异常不得反向破坏原始停因返回(D3 纪律)。
  }
}

/** 023: raceModel 的结构化胜出来源，避免 SDK abort 错误覆盖原始意图。 */
export type RaceOutcomeSource =
  "adapter" | "timerTimeout" | "hostCancel" | "callerAbort";

export interface RaceModelOutcome {
  readonly result: AssistantTurnResult | undefined;
  readonly source: RaceOutcomeSource;
}

export interface RaceModelHandle {
  readonly outcome: Promise<RaceModelOutcome>;
  readonly childSignal: AbortSignal;
  readonly childAbort: () => void;
}

export interface RaceModelOpts {
  readonly adapter: LoopAdapter;
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /** #196 IKNOW T1:runModelPhase 每 turn 解析 deps.system?.() 后透传;undefined 时不发送 system。 */
  readonly systemText?: string;
  /**
   * #742 T1:模型输出增量的静默上限(ms)。缺席 / <= 0 → 只有 `timeoutMs`
   * 一根钟(改前行为)。到点与 `timeoutMs` 同样落 `timerTimeout`。
   * 流式臂门禁由 `resolveModelClocks` 在 stepWithTrace 处判定,本层只收数值。
   */
  readonly idleTimeoutMs?: number;
}

/** 023: settle 共址于 helper，统一 single-wins 与 cleanup。 */
function createRaceOutcome(opts: {
  readonly raceOpts: RaceModelOpts;
  readonly child: AbortController;
  readonly compositeSignal: AbortSignal;
  readonly setChildAbort: (abort: () => void) => void;
}): Promise<RaceModelOutcome> {
  return new Promise<RaceModelOutcome>((resolve, reject) => {
    let settled = false;
    let timers: RaceTimers | undefined;
    let abortListener: (() => void) | undefined;
    const settle = (
      source: RaceOutcomeSource,
      result?: AssistantTurnResult,
      err?: unknown
    ): void => {
      if (settled) return; // post-settle SDK error / abort 均丢弃。
      settled = true;
      timers?.cancel();
      if (opts.raceOpts.signal && abortListener)
        opts.raceOpts.signal.removeEventListener("abort", abortListener);
      opts.child.abort();
      if (err !== undefined) reject(err);
      else resolve(Object.freeze({ result, source }));
    };
    opts.setChildAbort(() => settle("hostCancel"));
    // #742 T1:idle 与硬顶两根钟由 race-timers 起,胜出仲裁仍只在 settle 一处;
    // 两根钟到点都落同一个 timerTimeout(不新增 StopReason)。
    timers = startRaceTimers({
      hardCapMs: opts.raceOpts.timeoutMs,
      idleTimeoutMs: opts.raceOpts.idleTimeoutMs,
      onExpire: () => {
        opts.child.abort(); // L1': 必须先取消 HTTP，再记录 timer 胜出。
        settle("timerTimeout");
      },
    });
    // #742 T1:idle 在场时观察者被包一层(先记增量再原样转发);不在场则原样
    // 透传宿主回调。转发 / 吞咽纪律见 observeModelIdle。
    const onStream = observeModelIdle(timers, opts.raceOpts.onStream);
    abortListener = (): void => settle("callerAbort");
    if (opts.raceOpts.signal?.aborted) abortListener();
    else
      opts.raceOpts.signal?.addEventListener("abort", abortListener, {
        once: true,
      });
    opts.raceOpts.adapter
      .step(
        opts.raceOpts.state,
        {
          tools:
            opts.raceOpts.deps.promptTools?.() ??
            opts.raceOpts.deps.registry.list(),
          // #196 IKNOW T1:system 字段条件附加 — undefined 时不发
          // (byte-identical 既有 behavior,守 014 附加原则)。
          ...(opts.raceOpts.systemText !== undefined
            ? { system: opts.raceOpts.systemText }
            : {}),
          onStream,
        },
        opts.compositeSignal
      )
      .then(
        (result) => settle("adapter", result),
        (err) => settle("adapter", undefined, err)
      );
  });
}

/** 023: child 与 caller signal 合并，timer/host 都可取消真实 HTTP。 */
export function raceModel(opts: RaceModelOpts): RaceModelHandle {
  const child = new AbortController();
  const childSignal = AbortSignal.any(
    opts.signal ? [opts.signal, child.signal] : [child.signal]
  );
  let childAbort = (): void => undefined;
  const outcome = createRaceOutcome({
    raceOpts: opts,
    child,
    compositeSignal: childSignal,
    setChildAbort: (abort) => (childAbort = abort),
  });
  return Object.freeze({
    outcome,
    childSignal,
    childAbort: () => childAbort(),
  });
}

/**
 * 017 T5:构造一条 TurnTrace(A7 字段集,严格不含 payload)。
 *
 * freezeMessage 等同 messages 守门:S10 守门延伸到 trace,运行时不可
 * 原地修改任何字段。toolCalls 数组与条目各自 freeze。
 */
function mkTurn(input: {
  readonly turnIndex: number;
  readonly supplierStop: TurnTrace["supplierStop"];
  readonly toolCalls: TurnTrace["toolCalls"];
  readonly durationMs: number;
  readonly cancelKind: CancelKind;
}): TurnTrace {
  return Object.freeze({
    turnIndex: input.turnIndex,
    supplierStop: input.supplierStop,
    toolCalls: Object.freeze(
      input.toolCalls.map((c) => Object.freeze({ ...c }))
    ),
    durationMs: input.durationMs,
    cancelKind: input.cancelKind,
  });
}

/**
 * 025 #98:reason 驱动 transition(冻结 StopReason 不变),cancelKind 独立
 * 驱动 trace 元数据;两者解耦,hostCancel 得以保留 stopReason "timeout"
 * 的控制流,同时在 trace 记录真实来源。
 */
function modelStop(opts: {
  readonly state: LoopState;
  readonly started: number;
  readonly reason: "cancelled" | "timeout" | "protocolError";
  readonly cancelKind: CancelKind;
}): { kind: "stop"; transition: Transition; turn: TurnTrace } {
  return {
    kind: "stop",
    transition: { kind: "stop", reason: opts.reason, finalState: opts.state },
    turn: mkTurn({
      turnIndex: opts.state.turnCount,
      supplierStop: "other",
      toolCalls: [],
      durationMs: performance.now() - opts.started,
      cancelKind: opts.cancelKind,
    }),
  };
}

/** 023: await 结构化 race outcome，并保持 SDK-first 错误 catch 契约。 */
async function runModelPhase(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
  /** #742 T1:本次 step 的硬顶(ms)。非流式臂 = 今日单钟解析结果。 */
  readonly modelHardCapMs: number;
  /** #742 T1:本次 step 的 idle 上限(ms);undefined = 只有硬顶一根钟。 */
  readonly modelIdleTimeoutMs: number | undefined;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /** plan T3 / ADR-0013:run 级闭包的 reactive-compact 已尝试标记。
   *   true = 本次 run 已压缩重试过一次,不再第二次。 */
  readonly reactiveAttemptedRef: { attempted: boolean };
}): Promise<
  | { kind: "ok"; result: AssistantTurnResult }
  | { kind: "stop"; transition: Transition; turn: TurnTrace }
  | { kind: "reactive_compact_pending"; state: LoopState }
> {
  try {
    // #196 IKNOW T1:每 turn 解析 deps.system?.();undefined → 字段缺席,
    // adapter 端条件 spread 不发 system 字段 → KV cache prefix 字节级零变化。
    const systemText = await opts.deps.system?.();
    const handle = raceModel({
      adapter: opts.deps.adapter,
      state: opts.state,
      deps: opts.deps,
      signal: opts.signal,
      timeoutMs: opts.modelHardCapMs,
      ...(opts.modelIdleTimeoutMs !== undefined
        ? { idleTimeoutMs: opts.modelIdleTimeoutMs }
        : {}),
      onStream: opts.onStream,
      systemText,
    });
    const outcome = await handle.outcome;
    if (outcome.source === "adapter") {
      return { kind: "ok", result: outcome.result! };
    }
    if (outcome.source === "callerAbort") {
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "cancelled",
        cancelKind: "callerAbort",
      });
    }
    if (outcome.source === "hostCancel") {
      // hostCancel 保留 stopReason "timeout" 以维持控制流;trace 由 cancelKind
      // 独立记录真实来源。
      // 覆盖说明:hostCancel 无公共触发点 — RaceModelHandle 封装于
      // runModelPhase 内部,run/step/createLoopEngine 均不暴露 childAbort。
      // 覆盖天花板为 raceModel 层 T2-new-5(直接调 handle.childAbort());
      // 本映射由 (a) TypeScript 对 4 值 source union 的穷尽性检查 与
      // (b) callerAbort/timerTimeout 集成测试 S12/S14(走同一 modelStop
      // 路径)共同钉死。
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "timeout",
        cancelKind: "hostCancel",
      });
    }
    return modelStop({
      state: opts.state,
      started: opts.started,
      reason: "timeout",
      cancelKind: "timerTimeout",
    });
  } catch (err) {
    // plan T3 / ADR-0013:reactive compact 兜底 — 每 run 限 1 次。
    // PromptTooLongError extends ProtocolError,必须先于 ProtocolError 分支判定;
    // 压缩成功 → 返回 reactive_compact_pending 让 stepWithTrace 用压缩后状态重跑一次。
    if (err instanceof PromptTooLongError) {
      if (
        opts.deps.compress !== undefined &&
        !opts.reactiveAttemptedRef.attempted
      ) {
        opts.reactiveAttemptedRef.attempted = true;
        const compactedState = await applyCompactAttachment(
          opts.state,
          opts.deps,
          { signal: opts.signal, onStream: opts.onStream }
        );
        // wait 逻辑参考 Claude Code:reactive compact 期间被用户取消 →
        // 不论压缩结果如何都按取消收场(避免落 protocolError 让用户困惑)。
        if (opts.signal?.aborted) {
          return modelStop({
            state: opts.state,
            started: opts.started,
            reason: "cancelled",
            cancelKind: "callerAbort",
          });
        }
        if (compactedState.messages !== opts.state.messages) {
          return {
            kind: "reactive_compact_pending",
            state: compactedState,
          };
        }
      }
      // 压缩关闭 / 已尝试过 / 压缩后窗口仍超 → 交回 ProtocolError 语义
      // (ADR-0013:"压缩后仍超 → throw,交回 ADR-0012 超限语义收场")。
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "protocolError",
        cancelKind: "none",
      });
    }
    if (
      err instanceof ProtocolError ||
      err instanceof TransportRetryExhaustedError
    )
      return modelStop({
        state: opts.state,
        started: opts.started,
        reason: "protocolError",
        cancelKind: "none",
      });
    throw err;
  }
}

/**
 * 017 T5 / #645 T1:toolCallViews 的 id→name 视图名表(单次构造,多处消费:
 * runToolPhase 的 trace 落盘、stepWithTrace 的 trace 落盘与状态栏 last_tool
 * 更新 —— 三处共用同一构造,消除重复)。
 */
function toolNameById(
  views: ReadonlyArray<{ readonly id: string; readonly name: string }>
): ReadonlyMap<string, string> {
  return new Map(views.map((c) => [c.id, c.name]));
}

/**
 * 017 T5:纯函数 — 把 Executor 的 ToolExecutionResult 序列映射为 trace
 * 用的 toolCalls 数组。nameById 是按 toolUseId 索引的视图名表(由上层
 * 一次构造);tool_not_found 允许自报 toolName,其他 kind 兜底空串:
 * 该空串分支对良构结果不可达,但保留 total 以满足类型严格性。
 */
function toTraceToolCalls(opts: {
  readonly results: ReadonlyArray<ToolExecutionResult>;
  readonly nameById: ReadonlyMap<string, string>;
}): TurnTrace["toolCalls"] {
  return opts.results.map((r) => {
    const toolName =
      opts.nameById.get(r.toolUseId) ??
      (r.kind === "tool_not_found" ? r.toolName : "");
    const message =
      r.kind === "validation_failed" || r.kind === "execution_failed"
        ? r.message
        : undefined;
    return {
      toolUseId: r.toolUseId,
      toolName,
      kind: r.kind,
      ...(message !== undefined ? { message } : {}),
    };
  });
}

/**
 * 017 T5:扫描 Executor 结果 + signal,判定本次 tool 阶段是否触发
 * cancelled / timeout。cancelled 优先级高于 timeout(与 stepWithTrace
 * 主路径上的判定顺序一致),signal 已 abort 即视为整体取消,即便
 * results 中同时存在 timeout 标签。
 *
 * 124/T5:导出供 interrupt-routing 验收套件断言严格 strict-equal
 * 契约(无前缀/后缀宽容,严禁任何 substring / prefix 优化)。
 */
export function computeToolStopFlags(opts: {
  readonly results: ReadonlyArray<ToolExecutionResult>;
  readonly signal: AbortSignal | undefined;
}): { timedOut: boolean; cancelled: boolean } {
  const timedOut = opts.results.some(
    (r) => r.kind === "execution_failed" && r.message === "timeout"
  );
  const cancelled =
    opts.signal?.aborted === true ||
    opts.results.some(
      (r) => r.kind === "execution_failed" && r.message === "cancelled"
    );
  return { timedOut, cancelled };
}

type ToolCallView = { id: string; name: string; input: unknown };

/**
 * #620:commit in tool_use order as soon as the prefix has settled.
 * Later results may finish first but stay buffered until earlier slots fill.
 * executeAll still receives the whole wave (AC51/52); onSettled is the
 * commit seam so the loop does not wait for the slowest call before the
 * first result can hit disk.
 */
async function executeWaveAndCommit(opts: {
  readonly wave: ReadonlyArray<ToolCallView>;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly toolTimeout: number;
  readonly results: ToolExecutionResult[];
  readonly blocks: AnthropicContentBlock[];
  /** F-4:本回合 trace turn id,透传到 ctx.turnId(spawn_subagent 的归属回合)。 */
  readonly turnId: string;
  /** #888:注入消息随第一个 tool_result commit 随批 flush。 */
  readonly pendingInjected: PendingInjected;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<void> {
  const slots: Array<ToolExecutionResult | undefined> = Array.from(
    { length: opts.wave.length },
    () => undefined
  );
  let next = 0;
  const flushPrefix = async (): Promise<void> => {
    while (next < slots.length && slots[next] !== undefined) {
      const result = slots[next]!;
      next += 1;
      opts.results.push(result);
      const encoded = opts.deps.adapter.encodeToolResults([result]);
      opts.blocks.push(...encoded);
      await commitMessagesOrThrow(opts.deps, [
        ...opts.pendingInjected.take(),
        { role: "user", content: encoded },
      ]);
    }
  };
  const waveResults = await opts.deps.executor.executeAll(
    opts.wave,
    opts.signal,
    opts.toolTimeout,
    opts.deps.conversationId,
    async (result, index) => {
      slots[index] = result;
      await flushPrefix();
    },
    opts.turnId,
    opts.onStream
  );
  for (let i = 0; i < waveResults.length; i++) {
    if (slots[i] === undefined) slots[i] = waveResults[i];
  }
  await flushPrefix();
}

/** 017 T5:工具阶段独立收敛,保持整回合追加与停止优先级不变。 */
async function runToolPhase(opts: {
  readonly afterAssistantState: LoopState;
  readonly entryTurnCount: number;
  readonly turnResult: AssistantTurnResult;
  readonly deps: LoopEngineDeps;
  readonly signal: AbortSignal | undefined;
  readonly started: number;
  /** F-4:本回合 trace turn id(见 executeWaveAndCommit)。 */
  readonly turnId: string;
  /** #888:注入消息随第一个 tool_result commit 随批 flush。 */
  readonly pendingInjected: PendingInjected;
  readonly onStream?: (event: HarnessStreamEvent) => void;
}): Promise<{
  transition: Transition;
  turn: TurnTrace;
  toolResults: ReadonlyArray<ToolExecutionResult>;
  toolCallViews: ReadonlyArray<{ id: string; name: string; input: unknown }>;
}> {
  const toolCallViews = opts.turnResult.projection.toolCalls.map((c) => ({
    id: c.id,
    name: c.name,
    input: c.input,
  }));
  const toolTimeout =
    opts.deps.toolTimeoutMs ?? opts.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waves = partitionConcurrencyWaves(toolCallViews, (call) => {
    const def = opts.deps.registry.get(call.name);
    return (
      (def as { aci?: { isConcurrencySafe?: boolean } } | undefined)?.aci
        ?.isConcurrencySafe === true
    );
  });
  const results: ToolExecutionResult[] = [];
  const blocks: AnthropicContentBlock[] = [];
  for (const wave of waves) {
    await executeWaveAndCommit({
      wave,
      deps: opts.deps,
      signal: opts.signal,
      toolTimeout,
      results,
      blocks,
      turnId: opts.turnId,
      pendingInjected: opts.pendingInjected,
      onStream: opts.onStream,
    });
  }
  const toolResultMsg: AnthropicNativeMessage = {
    role: "user",
    content: blocks,
  };
  const finalState = appendMessage({
    state: opts.afterAssistantState,
    msg: toolResultMsg,
  });
  const durationMs = performance.now() - opts.started;
  const nameById = toolNameById(toolCallViews);
  const toolCalls = toTraceToolCalls({ results, nameById });
  const { timedOut, cancelled } = computeToolStopFlags({
    results,
    signal: opts.signal,
  });
  const turn = mkTurn({
    turnIndex: opts.entryTurnCount,
    supplierStop: opts.turnResult.supplierStop,
    toolCalls,
    durationMs,
    // 025 #98:cancelled 优先级高于 timeout(与 computeToolStopFlags 注释一致)。
    cancelKind: cancelled ? "callerAbort" : timedOut ? "timerTimeout" : "none",
  });
  if (cancelled) {
    return {
      transition: { kind: "stop", reason: "cancelled", finalState },
      turn,
      toolResults: results,
      toolCallViews,
    };
  }
  if (timedOut) {
    return {
      transition: { kind: "stop", reason: "timeout", finalState },
      turn,
      toolResults: results,
      toolCallViews,
    };
  }
  return {
    transition: { kind: "continue", nextState: finalState },
    turn,
    toolResults: results,
    toolCallViews,
  };
}

/**
 * 017 T5:stepWithTrace 在原 step 逻辑上叠加:
 *   - step 入口记 started = performance.now(),出口算 durationMs;
 *   - 调用 runModelPhase 包 adapter.step + 超时 + abort + 协议错误;
 *   - 整回合取消/超时/协议错误时仍跑出 stop(reason),但 turn 也用占位
 *     TurnTrace 记入 trace(S12/S14 路径不进入历史,trace 仍记一次失败
 *     尝试,S13/S15 路径 tool_call 失败已填入 toolCalls 数组);
 *   - turn 仅在 maxTurns 早停分支返回 null(no adapter call → no trace entry)。
 *
 * 内部 Transition 形状与 016 冻结契约一致(judgement union,reason 字段
 * 类型随 StopReason 自动扩展)。
 *
 * plan T3 / ADR-0011:maxTurns 超限从 silent-stop 升级为
 * `throw MaxTurnsExceeded`(surface 必须感知;turnsRan = 已跑轮数)。
 * `maxTurns` 现在类型 `number | undefined`(plan T5-engine / ADR-0012):
 * undefined = 永不触发(exploration 不被 turn 计数误杀)。
 */
async function stepWithTrace(opts: {
  readonly state: LoopState;
  readonly deps: LoopEngineDeps;
  readonly signal?: AbortSignal;
  readonly onStream?: (event: HarnessStreamEvent) => void;
  /** plan T3 / ADR-0013:run 级闭包的 reactive-compact 已尝试标记(跨 step 传递)。 */
  readonly reactiveAttemptedRef: { attempted: boolean };
  /**
   * #645 T1 / ADR-0028:状态栏 last_tool 的 run 作用域可变引用。run() 创建
   * 并跨 step 共享(一个 run = 一个用户回合);public step() 每次新建(单步
   * 语义)。初值 AGENT_STATUS_IDLE_TOOL;每个工具批后更新为批内最后一个
   * 成功工具名(无成功 → 保持原值)。仅 deps.agentStatus 在场时被消费
   * (appendAgentStatusBar 读 lastTool);refs 无既有观察者 → 字段缺席时
   * 更新零可观察行为。
   */
  readonly lastToolRef: { lastTool: string };
  /** #672 T3:本 run 工具环事件（跨 step 累积；public step 每次新建）。 */
  readonly toolLoopRef: { events: ToolLoopEvent[]; nextPhase: number };
  /** #888:run 作用域注入消息 pending 缓冲(public step 每次新建)。 */
  readonly pendingInjected: PendingInjected;
}): Promise<{
  transition: Transition;
  turn: TurnTrace | null;
  /**
   * #160 / ADR-0008 Decision 5: 本步成功模型调用的 usage(undefined = 无成功模型调用
   * 或成功调用 usage 缺席)。run 累 lastUsage 仅在 !== undefined 时更新。
   */
  modelUsage: TokenUsage | undefined;
}> {
  // plan T3 / ADR-0011 + plan T5-engine / ADR-0012:maxTurns 超限 → throw。
  // undefined = 无限,永不触发(长程探索不被 turn 计数误杀)。
  if (
    opts.deps.maxTurns !== undefined &&
    opts.state.turnCount >= opts.deps.maxTurns
  ) {
    throw new MaxTurnsExceeded(opts.state.turnCount, "maxTurns");
  }

  const started = performance.now();
  const turnStartedAt = new Date().toISOString();
  // F-4:本回合 trace turn id 在回合入口生成而非 recordTurn 内部生成 —— 工具
  // 阶段要拿它当 ctx.turnId(spawn_subagent 据此填 parentTurnId),而 recordTurn
  // 在回合末尾才发。四条 recordTurn 出口全部复用这一个 id,一回合一行不变。
  const turnId = randomUUID();
  const modelTimeout =
    opts.deps.modelTimeoutMs ?? opts.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // #742 T1:流式臂拿 idle + 硬顶两根钟,非流式臂原样只用上面那一根。
  // 流式臂门禁读 adapter 自报的 `streamMode`(#178 T5 已有的模式申报 SSOT),
  // 不另造第二个开关。
  const modelClocks = resolveModelClocks({
    modelTimeoutMs: modelTimeout,
    streamingArm: opts.deps.adapter.streamMode === true,
    idleTimeoutMs: opts.deps.modelIdleTimeoutMs,
    hardCapMs: opts.deps.modelHardCapMs,
  });

  const llmStartedAt = new Date().toISOString();
  const llmStartMono = performance.now();

  // plan T3 / ADR-0013:runModelPhase 失败侧会返回 reactive_compact_pending,这里
  // 用压缩后的 state 重试一次模型调用(每 run 限 1 次,reactiveAttemptedRef 守门)。
  // reactiveAttemptedRef 在第一次返回 reactive_compact_pending 前已被翻转 attempted=true,
  // 第二次 runModelPhase 调用因 attempted=true 不再产出 reactive_compact_pending
  // (落 modelStop(protocolError)),所以下方 narrow 只需穷举 ok/stop。
  // `effectiveState` 记录本步模型实际看到的 messages:reactive 压缩后用它替代
  // opts.state,以便 appendMessage / finalState 反映压缩后的权威历史(append-only
  // 不变式 + 不把模型已不见的消息重新带回历史)。
  //
  // #645 T1 / ADR-0028:每次即将调用模型前把现势栏以 user 消息追加在当时的
  // `messages` 尾 —— 首次调用与 reactive-compact 重试两处各追加一条(栏在
  // compact 之后落位);proactive compact 在 run() 迭代顶部、stepWithTrace
  // 之前发生,栏天然落在其后。旧栏永不删除 / 改写。
  type OkOrStop =
    | { kind: "ok"; result: AssistantTurnResult }
    | { kind: "stop"; transition: Transition; turn: TurnTrace };
  // ADR-0041 / plans/model-prefix-layering.md B3:graph 模式切换追加缝
  // —— 比 appendAgentStatusBar 先调,保证 messages 序列里「graph 切换
  // 提示」永远早于 status bar(状态栏是更接近调模型的当前态,模型读
  // 到时序是「graph 翻转 → status bar」)。seam 缺席 → 零追加(ask /
  // worker / 未接 overlay 的入口零行为变化)。
  // ADR-0080:返回 { state, appendedLongOn } —— appendedLongOn 给同段
  // appendGraphModePresence 当 SC5 去重信号。
  const graphModeState = await appendGraphModeChange(
    opts.state,
    opts.deps,
    opts.pendingInjected,
    opts.onStream
  );
  // ADR-0080 / specs/graph-mode-presence.md:每跳短现势 —— 仅当 holder
  // on 且本拍未贴长 ON 时追加;seam 缺席 / 关着 / 当拍长 ON → 零追加。
  const presenceState = await appendGraphModePresence(
    graphModeState.state,
    opts.deps,
    opts.pendingInjected,
    graphModeState.appendedLongOn
  );
  // B4 / ADR-0043 §4:MCP 手动重连追加缝 —— 与 graphModeChange 同段
  // (环境级事件),在 status bar 之前消费 pending。seam 缺席 → 零追加。
  const mcpReconnectState = appendMcpReconnect(
    presenceState,
    opts.deps,
    opts.pendingInjected
  );
  const barState = await appendAgentStatusBar(
    mcpReconnectState,
    opts.deps,
    opts.lastToolRef.lastTool,
    opts.pendingInjected,
    opts.onStream
  );
  // #653 G1 T5:环境现势快照 —— 与 agent_status 同一回合边界(栏先、
  // 环境后)的平行独立流;只给宿主 UI,不影响 messages。
  const barStateWithEnv = await appendEnvSnapshot(
    barState,
    opts.deps,
    opts.onStream
  );
  const firstPhase = await runModelPhase({
    state: barStateWithEnv,
    deps: opts.deps,
    signal: opts.signal,
    started,
    modelHardCapMs: modelClocks.hardCapMs,
    modelIdleTimeoutMs: modelClocks.idleTimeoutMs,
    onStream: opts.onStream,
    reactiveAttemptedRef: opts.reactiveAttemptedRef,
  });
  let effectiveState: LoopState = barState;
  const modelPhase: OkOrStop =
    firstPhase.kind === "reactive_compact_pending"
      ? await (async (): Promise<OkOrStop> => {
          // ADR-0041:reactive compact 重试前同样检测 graph 翻转(同 round
          // 两次模型调用之间 host 可能翻键);与首次调用路径同形态 —— 翻
          // 转则追加,否则 state 原样传入下一 helper。ADR-0080 同段叠加
          // appendGraphModePresence(若重试拍 holder 仍 on 则再贴短句,
          // SC7:compact 之后下一跳仍 on → 再贴;无 compact 专用追加)。
          const compactedWithGraph = await appendGraphModeChange(
            firstPhase.state,
            opts.deps,
            opts.pendingInjected,
            opts.onStream
          );
          const compactedWithPresence = await appendGraphModePresence(
            compactedWithGraph.state,
            opts.deps,
            opts.pendingInjected,
            compactedWithGraph.appendedLongOn
          );
          // B4 / ADR-0043 §4:reactive compact 重试前同样消费重连 pending
          // (同 round 两次模型调用之间手动重连可能完成)。
          const compactedWithReconnect = appendMcpReconnect(
            compactedWithPresence,
            opts.deps,
            opts.pendingInjected
          );
          // 栏追加在 compact 之后(压缩产物尾部),重试请求的末尾即最新一条栏。
          const compactedWithBar = await appendAgentStatusBar(
            compactedWithReconnect,
            opts.deps,
            opts.lastToolRef.lastTool,
            opts.pendingInjected,
            opts.onStream
          );
          // #653 G1 T5:reactive compact 重试的同一回合边界同样发环境现势。
          const compactedWithEnv = await appendEnvSnapshot(
            compactedWithBar,
            opts.deps,
            opts.onStream
          );
          effectiveState = compactedWithEnv;
          const compressedAttempt = await runModelPhase({
            state: compactedWithEnv,
            deps: opts.deps,
            signal: opts.signal,
            started,
            modelHardCapMs: modelClocks.hardCapMs,
            modelIdleTimeoutMs: modelClocks.idleTimeoutMs,
            onStream: opts.onStream,
            reactiveAttemptedRef: opts.reactiveAttemptedRef,
          });
          if (compressedAttempt.kind === "reactive_compact_pending") {
            // 不变式违反 — reactive_compact 已被关闭或已尝试过,
            // runModelPhase 不应再返回 reactive_compact_pending。
            return {
              kind: "stop",
              transition: {
                kind: "stop",
                reason: "protocolError",
                finalState: compressedAttempt.state,
              },
              turn: mkTurn({
                turnIndex: opts.state.turnCount,
                supplierStop: "other",
                toolCalls: [],
                durationMs: performance.now() - started,
                cancelKind: "none",
              }),
            };
          }
          return compressedAttempt;
        })()
      : firstPhase;

  const llmEndedAt = new Date().toISOString();
  const llmDurationMs = performance.now() - llmStartMono;
  // #178 T5 (D6):trace `stream` 布尔按实际模式翻转。模式由 adapter 经只读
  // `streamMode` 申报(见 LoopAdapter 注释);两处 recordLlmCall site(ok /
  // error)共用同一真值,在埋点前取一次。
  const streamMode = opts.deps.adapter.streamMode === true;
  let llmCallId: string | undefined;
  if (opts.deps.trace) {
    if (modelPhase.kind === "stop") {
      const t = modelPhase.transition;
      const reason = t.kind === "stop" ? t.reason : "unknown";
      llmCallId = await safeTrace(() =>
        opts.deps.trace!.recordLlmCall({
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: llmDurationMs,
          stream: streamMode,
          messagesCaptured: true,
          // ADR-0014 决策 6 / #361 T12:错误分支同样捕获模型实际看到的
          // messages(取 effectiveState.messages,与 ok 分支同源 —— 包含
          // reactive 压缩后形态)。error/status 字段语义不变(Postel);
          // messages 字段是独立的"模型实际看到了什么"通道,error 不影响
          // 该字段填充,与 ok 分支语义对齐。
          messages: effectiveState.messages,
          // SC-W 5:错误分支 model 三字段整体缺席(Postel,ADR-0008 D3 同构)——
          // 且 adapter 本就不暴露 model,无论成功失败都无可填。
          status: "error",
          error: { type: toTraceErrorType(reason), message: reason },
        })
      );
    } else {
      // usage 缺席(error/stub 路径)整条不落盘——Postel(ADR-0008 Decision 3)
      const usage = modelPhase.result.usage;
      // SC-W 5 (v2 spec):modelRequested/modelActual/provider 缺席(Postel)。
      // LoopAdapter/AssistantTurnResult 不暴露 model 字段(见 model-adapter/types.ts
      // AssistantTurnResult:仅 nativeMessage/projection/supplierStop/usage)——
      // model 是 adapter 内部 opts.model 的私有细节,bounded context 边界禁止
      // loop-engine import adapter 的构造选项。能力不存在就不声明字段(ADR-0003 D9)。
      llmCallId = await safeTrace(() =>
        opts.deps.trace!.recordLlmCall({
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: llmDurationMs,
          supplierStop: modelPhase.result.supplierStop,
          stream: streamMode,
          messagesCaptured: true,
          // ADR-0014 决策 6 / #361 T12:成功分支捕获模型实际看到的
          // messages(取 effectiveState.messages,reactive 压缩后的权威
          // 历史 —— loop-engine.ts:879 注释明确 effectiveState 记录
          // 模型本步实际看到的 messages)。该字段是 ADR-0003 既有字段,
          // 仅从此处起首次填充;取舍:全量 messages 进 trace 会膨胀
          // jsonl,但 LlmCallRecord.messages 字段语义即"模型实际看到的
          // messages",符合 ADR 决策 6 验收纪律(messages_captured:true +
          // messages 数组含 coordinator 段 proactive 关键词)。
          messages: effectiveState.messages,
          status: "ok",
          ...(usage !== undefined ? usage : {}),
        })
      );
    }
  }

  if (modelPhase.kind === "stop") {
    if (opts.deps.trace) {
      const t2 = modelPhase.transition;
      const reason = t2.kind === "stop" ? t2.reason : "unknown";
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          id: turnId,
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs: performance.now() - started,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: toDecision(reason),
          status: "error",
          error: { type: toTraceErrorType(reason), message: reason },
        })
      );
    }
    return {
      transition: modelPhase.transition,
      turn: modelPhase.turn,
      modelUsage: undefined,
    };
  }
  const turnResult = modelPhase.result;

  if (
    turnResult.projection.toolCalls.length === 0 &&
    turnResult.isEmptyFinalResponse
  ) {
    const durationMs = performance.now() - started;
    if (opts.deps.trace) {
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          id: turnId,
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: "emptyFinalResponse",
          status: "error",
          error: {
            type: "emptyFinalResponse",
            message: "emptyFinalResponse",
          },
        })
      );
    }
    return {
      transition: {
        kind: "stop",
        reason: "emptyFinalResponse",
        finalState: effectiveState,
      },
      turn: mkTurn({
        turnIndex: opts.state.turnCount,
        supplierStop: turnResult.supplierStop,
        toolCalls: [],
        durationMs,
        cancelKind: "none",
      }),
      modelUsage: turnResult.usage,
    };
  }

  const nextState = appendMessage({
    state: effectiveState,
    msg: turnResult.nativeMessage,
  });
  const afterAssistantState = {
    messages: nextState.messages,
    turnCount: effectiveState.turnCount + 1,
  };
  // #620 T3 (spec D4):assistant 一进权威历史立刻经 host 钩子上盘(边跑边写);
  // 纯文本收尾与工具回合共用此 commit 点。
  // D2 (tui-display-consistency):assistant commit 顺带传 turnResult.thinkingMs
  // (流式臂 stepStreamArm 测得;非流式 / 边界形态 → undefined)。
  // #888:批头拼上 pending 注入消息(bar / graph / mcp),flush 即清空 ——
  // 盘上 commit 链与内存权威历史恢复逐条 LCP 对齐,save 不再 fork。
  await commitMessagesOrThrow(
    opts.deps,
    [...opts.pendingInjected.take(), turnResult.nativeMessage],
    turnResult.thinkingMs
  );

  if (turnResult.projection.toolCalls.length === 0) {
    const durationMs = performance.now() - started;
    const reason =
      turnResult.supplierStop === "success" ? "completed" : "nonSuccessStop";
    if (opts.deps.trace) {
      await safeTrace(() =>
        opts.deps.trace!.recordTurn({
          id: turnId,
          turnIndex: opts.state.turnCount,
          startedAt: turnStartedAt,
          endedAt: new Date().toISOString(),
          durationMs,
          llmCallIds: llmCallId ? [llmCallId] : [],
          toolCallIds: [],
          decision: reason,
          status: reason === "completed" ? "ok" : "error",
          error:
            reason === "completed"
              ? undefined
              : { type: toTraceErrorType("nonSuccessStop"), message: reason },
        })
      );
    }
    return {
      transition: { kind: "stop", reason, finalState: afterAssistantState },
      turn: mkTurn({
        turnIndex: opts.state.turnCount,
        supplierStop: turnResult.supplierStop,
        toolCalls: [],
        durationMs,
        cancelKind: "none",
      }),
      modelUsage: turnResult.usage,
    };
  }

  const toolStartedAt = new Date().toISOString();
  const toolStartMono = performance.now();

  const toolPhase = await runToolPhase({
    afterAssistantState,
    entryTurnCount: opts.state.turnCount,
    turnResult,
    deps: opts.deps,
    signal: opts.signal,
    started,
    turnId,
    pendingInjected: opts.pendingInjected,
    onStream: opts.onStream,
  });

  // #645 T1 / ADR-0028:last_tool = 批内最后一个成功工具名(kind === "ok")。
  // 按执行序扫(串行批即调用序),成功者覆盖、失败者永不更新;批内无成功
  // → 保持原值。工具名经 toolCallViews 的 id→name 视图解析(与 trace 落盘
  // 同源)。下一次 appendAgentStatusBar 消费该值。
  const nameById = toolNameById(toolPhase.toolCallViews);
  for (const result of toolPhase.toolResults) {
    if (result.kind !== "ok") continue;
    const name = nameById.get(result.toolUseId);
    if (name !== undefined) opts.lastToolRef.lastTool = name;
  }

  const toolEndedAt = new Date().toISOString();
  const toolDurationMs = performance.now() - toolStartMono;
  const toolCallIds: string[] = [];
  if (opts.deps.trace) {
    // tool_call 落盘需要 arguments(trace 观测痛点: 39MB trace 中查"哪个 tool_call
    // 写了某文件"只能 grep 原始 jsonl 的 llm_call messages)。与 #645 loop-detector
    // 同源 toolCallViews 解析 input, 保证 trace 落盘的 input 与运行时使用的 input
    // 是同一份;result 不落盘避免 trace 体积翻倍(已在 llm_call tool_result 全量
    // 落盘)。mask 管线由 jsonl.ts 的 writeLine 对整行 JSON 统一处理(同 messages),
    // 写入侧无需裁剪或开关,符合 types.ts:55-62 「不在写入侧裁剪」决策。
    const inputById = new Map(
      toolPhase.toolCallViews.map((v) => [v.id, v.input] as const)
    );
    for (const result of toolPhase.toolResults) {
      const toolName =
        nameById.get(result.toolUseId) ??
        (result.kind === "tool_not_found" ? result.toolName : "");
      const toolCallId = await safeTrace(() =>
        opts.deps.trace!.recordToolCall({
          parentLlmCallId: llmCallId,
          toolName,
          toolKind: result.kind,
          startedAt: toolStartedAt,
          endedAt: toolEndedAt,
          durationMs: toolDurationMs,
          argumentsCaptured: true,
          arguments: inputById.get(result.toolUseId),
          resultCaptured: false,
          status: result.kind === "ok" ? "ok" : "error",
          error:
            result.kind === "ok"
              ? undefined
              : {
                  type: result.kind,
                  message:
                    result.kind === "execution_failed" ||
                    result.kind === "validation_failed"
                      ? result.message
                      : result.kind,
                },
        })
      );
      if (toolCallId) toolCallIds.push(toolCallId);
    }
  }

  if (opts.deps.trace) {
    const toolTransition = toolPhase.transition;
    const isStop = toolTransition.kind === "stop";
    const decision = toDecision(isStop ? toolTransition.reason : "completed");
    await safeTrace(() =>
      opts.deps.trace!.recordTurn({
        id: turnId,
        turnIndex: opts.state.turnCount,
        startedAt: turnStartedAt,
        endedAt: new Date().toISOString(),
        durationMs: performance.now() - started,
        llmCallIds: llmCallId ? [llmCallId] : [],
        toolCallIds,
        decision,
        status: isStop ? "error" : "ok",
        error: isStop
          ? {
              type: toTraceErrorType(
                toolTransition.kind === "stop"
                  ? toolTransition.reason
                  : "unknown"
              ),
              message:
                toolTransition.kind === "stop" ? toolTransition.reason : "",
            }
          : undefined,
      })
    );
  }

  if (
    toolPhase.transition.kind === "continue" &&
    opts.deps.detectToolLoop !== false
  ) {
    const phaseId = opts.toolLoopRef.nextPhase;
    opts.toolLoopRef.nextPhase += 1;
    const byId = new Map(
      toolPhase.toolCallViews.map((v) => [v.id, v] as const)
    );
    for (const result of toolPhase.toolResults) {
      const view = byId.get(result.toolUseId);
      if (view === undefined) continue;
      opts.toolLoopRef.events.push(
        toolLoopEventFromCall(view.name, view.input, result, phaseId)
      );
    }
    if (isStalledToolLoop(opts.toolLoopRef.events)) {
      const envelope = freezeMessage(
        opts.deps.adapter.encodeUserText(LOOP_DETECTED_TEXT)
      );
      // #888:envelope 自身入盘的批同样先 flush pending 注入(bar 等),
      // 顺序与内存权威历史一致。
      await commitMessagesOrThrow(opts.deps, [
        ...opts.pendingInjected.take(),
        envelope,
      ]);
      const fusedState = appendMessage({
        state: toolPhase.transition.nextState,
        msg: envelope,
      });
      return {
        transition: { kind: "stop", reason: "fused", finalState: fusedState },
        turn: toolPhase.turn,
        modelUsage: turnResult.usage,
      };
    }
  }

  return {
    transition: toolPhase.transition,
    turn: toolPhase.turn,
    modelUsage: turnResult.usage,
  };
}

/**
 * 单步状态机推进。基于当前 state + deps 调用一次 Adapter:
 *   1. turnCount 已达 maxTurns -> throw MaxTurnsExceeded(plan T3 / ADR-0011,
 *      替代旧 silent-stop),不调 Adapter;
 *   2. 调 Adapter;若抛 PromptTooLongError -> reactive compact 重试一次
 *      (plan T3 / ADR-0013),仍超 / 已试过 -> stop protocolError;
 *      若抛 ProtocolError -> stop protocolError(整回合不进历史);
 *   3. emptyFinalResponse -> stop emptyFinalResponse(整回合不进历史);
 *   4. 纯文本完成 -> stop completed(进历史)或 nonSuccessStop;
 *   5. 有 tool call -> 执行工具,把 tool_result 编码后追加为一条 user
 *      message,产出 continue nextState(turnCount + 1)。
 *
 * 017:signal 透传给 adapter.step;Adapter 抛 DOMException AbortError
 * 与 Promise.race 超时都被收敛为 cancelled / timeout。stepWithTrace 是
 * 唯一持有 trace 的内部入口,public step() 只返 Transition(016 契约冻结)。
 *
 * 因 adapter.step 本身异步,本 step 返回 `Promise<Transition>`;spec 原文
 * 的 sync 签名在本版本诚实化为 async,以避免"双轨实现"漂移。
 */
export async function step(
  state: LoopState,
  deps: LoopEngineDeps,
  signal?: AbortSignal
): Promise<Transition> {
  // #645 T1:单步语义 —— 每次调用新建 lastToolRef(初值 idle,单步内工具批
  // 后更新,与 run 的回合作用域状态互不共享)。#888:pendingInjected 同理
  // 每次新建(单步的注入随本步 commit flush,跨 step 不残留)。
  const { transition } = await stepWithTrace({
    state,
    deps,
    signal,
    reactiveAttemptedRef: { attempted: false },
    lastToolRef: { lastTool: AGENT_STATUS_IDLE_TOOL },
    toolLoopRef: { events: [], nextPhase: 0 },
    pendingInjected: createPendingInjected(),
  });
  return transition;
}

/**
 * 整轮运行:init -> 反复 step -> stop 收尾。S6 / S9 / 全部错误路径
 * 由 step 一并负责,避免双轨实现漂移。
 *
 * 017 A1 返回形状变更:`Promise<{ result: RunResult; trace: LoopTrace }>`。
 * RunResult 形状零变更;trace 仅在 run 内部 immutable 累积([...prev, t]),
 * run 收尾一次性 computeTotals(A7)。
 *
 * plan T3 / ADR-0011 + plan T4:maxTurns 超限时 run 直接 throw
 * MaxTurnsExceeded(在 stepWithTrace 入口触发,先于 turnStartedAt / recordTurn;
 * surface 不依赖 trace.turns,靠 throws.turnsRan 推断 turnCount),surface
 * (T6 范畴)必须 catch;异常停(protocolError / cancelled / timeout /
 * nonSuccessStop)仍走 return stop + 收尾摘要事件。
 */
export async function run(
  userText: string,
  deps: LoopEngineDeps,
  signal?: AbortSignal,
  opts?: {
    priorMessages?: ReadonlyArray<AnthropicNativeMessage>;
    onStream?: (event: HarnessStreamEvent) => void;
    appendUserText?: boolean;
  }
): Promise<{ result: RunResult; trace: LoopTrace }> {
  // 020 Q2 priorMessages 续传接缝:历史前缀逐条冻结,单次运行 turnCount 仍从 0 起。
  // #406 T2:识别层入口 —— secretsMode 非 "block" 且 secretRegistry 在场时,
  // 先对用户文本做占位符替换再编码。占位符形态不进 registry(recognize 只扫
  // 密钥形态),跨 turn 续传时 previous 占位符原样保留。
  // #687 T1: appendUserText 缺省 true = 今日行为; false = skip-append,
  // 不 encodeUserText、不 recognize(userText)。
  let state: LoopState;
  if (opts?.appendUserText !== false) {
    let effectiveUserText = userText;
    if (deps.secretsMode !== "block" && deps.secretRegistry !== undefined) {
      const { replaced } = recognize(userText, deps.secretRegistry);
      effectiveUserText = replaced;
    }
    state = {
      messages: Object.freeze([
        ...(opts?.priorMessages ?? []).map(freezeMessage),
        freezeMessage(deps.adapter.encodeUserText(effectiveUserText)),
      ]),
      turnCount: 0,
    };
  } else {
    if (userText !== "") {
      throw new SkipAppendWithTextError();
    }
    const prior = opts.priorMessages;
    if (prior === undefined || prior.length === 0) {
      throw new SkipAppendEmptyPriorError();
    }
    state = {
      messages: Object.freeze(prior.map(freezeMessage)),
      turnCount: 0,
    };
  }
  // #160 / ADR-0008 Decision 5: 最后一次成功模型调用的 usage 可变引用。
  // 初值 null = run 无成功模型调用;仅当 step 成功且 usage 存在时更新。
  let lastUsage: TokenUsage | null = null;
  let turns: ReadonlyArray<TurnTrace> = [];
  // plan T3 / v2:run 级 L1 根记录的起止锚点(诚实值:不前置估算)。
  // endedAt / durationMs / status 只有在 run 收尾后才能确定,故 session 记录
  // 必须写在整个 run 末尾(Never-do:"用估算值顶替 trace 真值"红线)。
  const sessionStartedAt = new Date().toISOString();
  const sessionStartMono = performance.now();
  // #119 T7:proactive auto-compact check(Q3 决议)。闭包变量 lastCompactTurn
  // 不入 LoopState(Q4 决议),仅作 turnCount 锚点防止重复扫描。
  let lastCompactTurn: number = 0;
  // plan T3 / ADR-0013:reactive-compact 已尝试标记(每 run 限 1 次,闭包变量)。
  const reactiveAttemptedRef = { attempted: false };
  // #645 T1 / ADR-0028:状态栏 last_tool 回合作用域状态 —— 一个 run = 一个
  // 用户回合,初值 idle(本回合尚未跑过工具),每个工具批后更新为批内最后
  // 一个成功工具名;跨 step 共享,run 结束即弃。
  const lastToolRef = { lastTool: AGENT_STATUS_IDLE_TOOL };
  const toolLoopRef = { events: [] as ToolLoopEvent[], nextPhase: 0 };
  // #888:run 作用域注入消息 pending 缓冲(见 createPendingInjected)。
  const pendingInjected = createPendingInjected();
  while (true) {
    // #119 T7:compress 缝缺省(字段缺席)→ 跳过检查,行为零变化(byte-identical)。
    // 仅 turnCount 自增(>lastCompactTurn)后扫一次,避免每轮重复 estimate。
    //
    // plan compress-trigger-gate T3:proactive gate 改为统一判据
    // `evaluateCompactTrigger`(token 阈值 + 窗口守门 + full summary 降级三段)。
    // 旧 `shouldAutoCompact` 仅判 token 阈值,导致 token 已超但 messages ≤
    // DEFAULT_KEEP_RECENT 时 `splitForCompaction` 返 undefined → applyCompactAttachment
    // 返回 state 不变 → lastCompactTurn 不更新 → 死循环(每次都重新触发又无效)。
    // 新判据:
    //   - compact_via_window → applyCompactAttachment 既有窗口路径(行为不变);
    //   - compact_via_full_summary → applyFullCompactSummary 整段视为 dropped 走
    //     LLM 摘要,无 kept tail;成功时 messages 引用变化 → lastCompactTurn 更新;
    //   - noop → token 未达阈值,跳过(行为零变化)。
    if (deps.compress !== undefined && state.turnCount > lastCompactTurn) {
      const threshold = getAutoCompactThreshold(
        deps.compress.contextWindow,
        deps.compress.thresholdTokens
      );
      const decision = evaluateCompactTrigger(state.messages, {
        contextWindow: deps.compress.contextWindow,
        threshold,
      });
      if (decision.action !== "noop") {
        let compactedState: LoopState;
        if (decision.action === "compact_via_window") {
          // 既有窗口路径:splitForCompaction → runFullCompact → buildCompactedMessages。
          // 行为不变(#458 T7 SC11)。
          compactedState = await applyCompactAttachment(state, deps, {
            signal,
            onStream: opts?.onStream,
          });
        } else {
          // compact_via_full_summary:token 已超但 messages ≤ keepRecent,
          // 整段视为 dropped 走 LLM 摘要,无 kept tail。
          compactedState = await applyFullCompactSummary(state, deps, {
            signal,
            onStream: opts?.onStream,
          });
        }
        if (compactedState.messages !== state.messages) {
          // immutable 重建(SC7/Q5);不 mutate,原 messages 引用不变。
          // S10 freeze gate:压缩结果须与 appendMessage 一样冻结每一条,
          // 否则可变普通对象进入权威历史,违反 append-only immutable 不变式。
          state = compactedState;
          lastCompactTurn = state.turnCount;
          // #888:压缩产物与旧链本就不可 LCP 对齐(既有 fork-copy 语义),
          // 旧 pending 注入只可能指向已不存在的消息位置 —— 丢弃缓冲,
          // 让压缩后的新注入随新 commit flush。
          pendingInjected.take();
        }
      }
    }
    let stepResult: {
      transition: Transition;
      turn: TurnTrace | null;
      modelUsage: TokenUsage | undefined;
    };
    try {
      stepResult = await stepWithTrace({
        state,
        deps,
        signal,
        onStream: opts?.onStream,
        reactiveAttemptedRef,
        lastToolRef,
        toolLoopRef,
        pendingInjected,
      });
    } catch (err) {
      if (err instanceof MaxTurnsExceeded) {
        // plan T4 / ADR-0011:maxTurns 超限走 throw 路径(不进 stop 分支),
        // 这里在重抛前先跑一轮 best-effort 收尾摘要,再原样重抛 ——
        // "原始停因仍抛出",摘要失败/超时绝不阻塞 throw。
        await epilogueSummary({
          deps,
          messages: state.messages,
          reason: err.reason,
          onStream: opts?.onStream,
          signal,
        });
      }
      throw err;
    }
    const { transition, turn, modelUsage } = stepResult;
    if (turn !== null) {
      // immutable append;禁止 push / 原地修改。
      turns = [...turns, turn];
    }
    // 仅成功模型调用(usage 存在)更新 lastUsage;失败/取消/超时路径不覆盖。
    if (modelUsage !== undefined) {
      lastUsage = modelUsage;
    }
    if (transition.kind === "stop") {
      const { reason, finalState } = transition;
      // #392 T4 / G3 #388:signal abort 取消时把 system 中断消息 append
      // 到权威历史末尾(transcript 一等公民)。在 epilogueSummary 之前完成,
      // 让收尾摘要事件看到完整历史(若它消费 messages 派生 stop_summary 文案)。
      // Assistant 回合在 cancelled 时不进历史(raceModel / cancelled 归因),
      // 所以 system 直接 append 到 finalState 末尾即可,不会与半截 assistant
      // 重复或错位。timeout 不在此分支处理:timeout 是模型层超时而非用户中断,
      // 固定文案 "Interrupted by user." 不适用;后续若需要可在 toInterruptReason
      // 引入新 label 时再扩。
      const finalMessages =
        reason === "cancelled"
          ? appendSystemInterrupt(finalState).messages
          : finalState.messages;
      // #888:cancelled 收尾把 system interrupt(以及任何残留 pending 注入)
      // 一起 flush —— system interrupt 与状态栏同属「进内存不进 commit 流」
      // 的注入类消息,不 flush 则宿主收尾 save 在此处 LCP 失配 fork。
      // 无 commitMessages 钩子时 no-op(零 IO 语义不变)。其余停因
      // (protocolError / emptyFinalResponse = #120 裁决 turn 不进历史;
      // completed / timeout / fused / nonSuccessStop 的 pending 已随最后
      // commit flush)均无残留或按裁决丢弃。
      if (reason === "cancelled") {
        await commitMessagesOrThrow(deps, [
          ...pendingInjected.take(),
          {
            role: "system",
            content: [{ type: "text", text: SYSTEM_INTERRUPT_TEXT }],
          },
        ]);
      }
      const finalText =
        reason === "completed" ? deriveFinalText(finalMessages) : null;
      const result: RunResult = {
        finalText,
        messages: finalMessages,
        turnCount: finalState.turnCount,
        stopReason: reason,
        lastUsage,
      };
      // plan T4 / ADR-0011:异常停(completed 除外)后跑一轮 best-effort
      // 收尾摘要。不计 maxTurns / 工具预算;失败即跳过,不阻塞原始停因。
      if (reason !== "completed") {
        await epilogueSummary({
          deps,
          messages: finalMessages,
          reason,
          onStream: opts?.onStream,
          signal,
        });
      }
      // plan T3 / v2:run 末尾落一条 session L1 根记录(仅当 caller 注入
      // agentVersion 且启用了 trace)。status 由 result.stopReason 派生:
      // completed → ok,其余(nonSuccessStop/protocolError/cancelled/...)
      // → error。埋点走 safeTrace,失败绝不中断业务(@throws never)。
      if (deps.trace && deps.agentVersion !== undefined) {
        const sessionEndedAt = new Date().toISOString();
        const sessionDurationMs = performance.now() - sessionStartMono;
        const sessionStatus: TraceStatus =
          reason === "completed" ? "ok" : "error";
        const sessionError: TraceError | undefined =
          reason === "completed"
            ? undefined
            : { type: toTraceErrorType(reason), message: reason };
        await safeTrace(() =>
          deps.trace!.recordSession({
            startedAt: sessionStartedAt,
            endedAt: sessionEndedAt,
            durationMs: sessionDurationMs,
            agentVersion: deps.agentVersion!,
            status: sessionStatus,
            ...(sessionError !== undefined ? { error: sessionError } : {}),
          })
        );
      }
      return {
        result,
        trace: { turns, totals: computeTotals(turns) },
      };
    }
    state = transition.nextState;
  }
}

// Re-export spec types for downstream consumers.
export type { Executor, Registry } from "./tools/types.js";
export type { LoopTrace, TurnTrace, Totals, CancelKind } from "./loop-trace.js";

/** T9 / #653:envSnapshot 缝形态别名 —— 让测试 / 外部装配代码可以引用同一类型,
 *  而不是穿透 `unknown` 强转 `LoopEngineDeps.envSnapshot`。 */
export type EnvSnapshotSeam = { readonly readCwd: () => string };

/**
 * 工厂:把 dep 闭包成 runner / stepper 对象(016 T12 spec 出口)。
 * 返回的 `step` 是闭包版(只需传 state),`run` 接收 userText。
 *
 * 017:闭包层 run / step 透传可选的 signal 第三参;返回形状随 run /
 * step 扩展,闭包类型签名同步更新。
 */
export function createLoopEngine(deps: LoopEngineDeps): {
  readonly run: (
    userText: string,
    signal?: AbortSignal
  ) => Promise<{ result: RunResult; trace: LoopTrace }>;
  readonly step: (
    state: LoopState,
    signal?: AbortSignal
  ) => Promise<Transition>;
} {
  return Object.freeze({
    run: (userText: string, signal?: AbortSignal) =>
      run(userText, deps, signal),
    step: (state: LoopState, signal?: AbortSignal) => step(state, deps, signal),
  });
}
