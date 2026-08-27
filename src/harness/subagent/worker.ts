/**
 * #356 subagent worker 进程主线 (spec 356-subagent-v1 § worker.ts)。
 *
 * 形态 = 同 iknow binary headless 重入: `node <iknow-bin> --subagent-worker`。
 * 父代理 spawn 后:
 *   - stdin  一行 JSON = WorkerEnvelope (parseWorkerEnvelope, 信封 schema 冻结);
 *   - worker 进程跑独立 run() (独立 registry, 不依赖父注册表);
 *   - stdout 一行 JSON = SubAgentEnvelope (浓缩结果, emit 前 truncateEnvelopeResult);
 *   - stderr 仅日志 (不污染 wire)。
 *
 * 关键纪律 (spec SC11 / Boundaries Always):
 *   - stdout 严格单 wire: 所有非 envelope 输出走 process.stderr.write,
 *     禁止 console.log 到 stdout;
 *   - SIGTERM 友好收尾 (runSubagentWorker 由 cli.ts 调度, 当前实现
 *     显式 process.exit(0) 保证 stdout flush);
 *   - 未捕获错误 → exit 2 (协议层崩溃, 由 cli.ts 顶层 catch 兜底);
 *   - env 继承父进程 (ADR-0001, 不发明第二条 env 协议);
 *   - worker 子进程不含 spawn_subagent (SC9, v1 嵌套禁派发 ——
 *     createDefaultAciRegistry 不传 subagentManager, 该工具 T2 才落地)。
 *
 * 测试 seam: 生产 runSubagentWorker() 走真实装配; runWorkerOnce(opts) 把
 * envelope → run → truncateEnvelopeResult 拆出来, 导出仅供测试注入
 * stub deps (createStubModel), 不 spawn 真 worker 子进程。
 */
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { loadIknowEnv, type IknowEnv } from "../../config/env.js";
import {
  WORKSPACE_ROOT_ENV_KEY,
  resolveWorkspaceRoot,
} from "../../config/workspace-root.js";
import {
  createRealAnthropicAdapter,
  buildThinkingParams,
  createExecutor,
  withTransportRetry,
  translateAnthropicTransportFault,
  type LoopEngineDeps,
} from "../index.js";
import { createDefaultAciRegistry } from "../aci/tools/registry.js";
import { createAciExecutor } from "../aci/index.js";
import type { AciCatalog } from "../aci/types.js";
import { deriveFileRefs, writeToolNamesFrom } from "./file-refs.js";
import { createPermissionPolicy } from "../permission/policy.js";
import { createNoAskUser } from "../permission/ask-user.js";
import { createIknowSystemResolver } from "../identity/index.js";
import { createSkillScanner } from "../skill/scanner.js";
import { createSkillCatalog } from "../skill/catalog.js";
import { createJsonlTraceService, type TraceService } from "../trace/index.js";
import { run, epilogueSummary } from "../loop-engine.js";
import type { HarnessStreamEvent } from "../stream.js";
import { MaxTurnsExceeded, ProtocolError } from "../errors.js";
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import { getAgentEntry, AgentCatalogLookupError } from "./catalog.js";
import {
  parseWorkerEnvelope,
  truncateEnvelopeResult,
  type SubAgentEnvelope,
  type WorkerEnvelope,
} from "./envelope.js";
import { toolConstraintsSegment } from "../identity/assemble.js";

/** stderr 日志前缀 (spec Code Style: warn 一行不泄露 env 值)。 */
const LOG_PREFIX = "[subagent-worker]";

function log(message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

/** default worker trace dir (cli.ts DEFAULT_TRACE_DIR 同形态, IKNOW_TRACE_OUT 优先)。 */
const DEFAULT_WORKER_TRACE_DIR = "./trace/";

/**
 * #556 T2: 查 catalog 取 persona 段文本 (catalog body)。role 缺省 / 未知
 * → 返回 undefined (不注入 persona, 走 V1 baseline fallback)。未知 id
 * 走 catch 路径 (defense-in-depth): spawn 侧 ajv 已挡一轮, 此处为
 * wire-mismatch 兜底, 单测 envelope-role.test.ts 显式锁定 fallback 内容
 * (不静默吞掉 — 装配层发一行 log, 输出仍无 persona)。
 */
function resolvePersonaBody(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  try {
    return getAgentEntry(role).body;
  } catch (err) {
    if (err instanceof AgentCatalogLookupError) {
      log(`role '${role}' not in catalog; falling back to V1 baseline`);
      return undefined;
    }
    throw err;
  }
}

/**
 * #562 T7: 查 catalog 取 bashMode 派生 tool constraints 段文本。
 * bashMode="readonly" → 注入 "Tool constraints for this run" 段;
 * 其他 (role 缺省 / 未知 / bashMode 缺省 / bashMode="any") → 不注入,
 * 走 V1 baseline (byte-stable, 段缺席)。
 *
 * 防御契约与 resolvePersonaBody 同形态:role 缺省 / 未知 → 不抛, 装配
 * 期 catch 后走 fallback;catalog 是只读数据, 无副作用。
 */
function resolveConstraintsText(role: string | undefined): string | undefined {
  if (role === undefined) return undefined;
  try {
    const entry = getAgentEntry(role);
    if (entry.bashMode === "readonly") {
      return toolConstraintsSegment("readonly");
    }
    return undefined;
  } catch (err) {
    if (err instanceof AgentCatalogLookupError) {
      log(`role '${role}' not in catalog; falling back to V1 baseline`);
      return undefined;
    }
    throw err;
  }
}

/**
 * #562 T6: 查 catalog 取 bashMode 派生出 worker 装配期的 bash 模式。
 *
 * 继承 plan T6 fallback 链路:
 *   - role 缺省 → 返回 "any" (V1 baseline 等价; worker 不显式 grep,
 *     但 deps.bashMode 字段总会显式设置, 让 wiring 显式可见);
 *   - role 已知 (catalog 命中, e.g. "explore") → 返回 entry.bashMode,
 *     缺省视为 "any" (catalog 默认 / explore 外其他角色不强制 readonly);
 *   - role 未知 → 返回 "any" (defense-in-depth, 不静默吞掉 — 装配期
 *     catch AgentCatalogLookupError 后写一行 log, 装配仍走 "any" 显式
 *     透传, 与 resolvePersonaBody / resolveConstraintsText 同形态);
 *
 * 显式 "any":bash handler 不启用 readonly validator, fence 不收
 * cwdReadonly —— 字节与 V1 一致。返回类型收窄到 "any" | "readonly",
 * 编译期保证调用方分支覆盖完整。
 */
function resolveBashMode(role: string | undefined): "any" | "readonly" {
  if (role === undefined) return "any";
  try {
    const entry = getAgentEntry(role);
    return entry.bashMode ?? "any";
  } catch (err) {
    if (err instanceof AgentCatalogLookupError) {
      log(`role '${role}' not in catalog; bashMode fallback to 'any'`);
      return "any";
    }
    throw err;
  }
}

/**
 * #556 T2 + #562 T7: 加性段注入 wrapper
 * (base < persona < constraints < addendum)。
 *
 * 顺序契约 (plan T7 实现选):
 *   - persona (#556):catalog body, 角色定位。
 *   - constraints (#562 T7):readonly mode 时追加, mode 延伸语义。
 *   - addendum (#556):envelope.systemPrompt, 用户后置追加。
 *
 * 三者全缺省走外层短路 (返回 base), 字节级 byte-stable, 守 V1 baseline。
 * base 缺席 → 输出只是 extras 三者按序 join;任一缺席 → 该 slot 在
 * extras 数组过滤掉, 顺序保持不变。
 *
 * 加性段追加在 base system 之后, 不重排 IKNOW_ASSEMBLY_ORDER 的 5 段
 * LOCKED 顺序 (identity / soul / user_profile / bootstrap / memory_layer)。
 */
function withRoleExtras(
  base: () => Promise<string | undefined>,
  persona: string | undefined,
  constraints: string | undefined,
  addendum: string | undefined
): () => Promise<string | undefined> {
  return async () => {
    const baseText = await base();
    const extras = [persona, constraints, addendum].filter(
      (s): s is string => s !== undefined
    );
    if (extras.length === 0) return baseText;
    if (baseText === undefined) return extras.join("\n\n");
    return baseText + "\n\n" + extras.join("\n\n");
  };
}

/**
 * worker 装配入参 (createWorkerDeps seam)。
 *
 * 生产路径 runSubagentWorker() 只传 env + sandboxRoot; 测试可覆盖
 * model (stub) / trace (noop) / skillCatalog / system / userHome / cwd。
 */
export interface CreateWorkerDepsOptions {
  /** 从 loadIknowEnv() 读到的完整 IknowEnv (生产路径)。 */
  readonly env: IknowEnv;
  /** 软沙箱根 (worker 的 fs 工具越界边界, 来自 WorkerEnvelope.sandboxRoot)。 */
  readonly sandboxRoot: string;
  /** 测试缝: 注入 stub-model (createStubModel) 替代真实 Anthropic adapter。 */
  readonly model?: LoopEngineDeps["adapter"];
  /** 测试缝: 注入自定义 skill catalog (缺省 = worker 自身扫描, OQ3 独立扫描)。 */
  readonly skillCatalog?: ReturnType<typeof createSkillCatalog>;
  /** 测试缝: trace service (缺省 = createJsonlTraceService, 单测覆盖 noop)。 */
  readonly trace?: TraceService;
  /** 测试缝: 覆盖 userHome (默认 homedir(); 单测用 tmp fixture 隔离真实用户目录)。 */
  readonly userHome?: string;
  /** 测试缝: 覆盖 cwd (默认 process.cwd())。 */
  readonly cwd?: string;
  /** 测试缝: 覆盖 system resolver (缺省 createIknowSystemResolver)。 */
  readonly system?: LoopEngineDeps["system"];
  /** 测试缝: 覆盖 maxTurns (envelope.maxTurns > env.llm.maxTurns 优先)。 */
  readonly maxTurns?: number;
  /** #468 deny-list: 来自 WorkerEnvelope.disallowedTools, 透传给
   *  createDefaultAciRegistry 做 def-list 期裁剪 (声明面 = 实际面)。
   *  缺席 / undefined 不裁剪, 向后兼容旧 wire。 */
  readonly disallowedTools?: ReadonlyArray<string>;
  /** ADR-0019 (review-fix H3): per-root state anchor。透传给
   *  createDefaultAciRegistry 让 fs-policy 保护 `<workspaceRoot>/.iknow`。
   *  缺席 → registry 内部 fallback 到 sandboxRoot(legacy 形态)。 */
  readonly workspaceRoot?: string;
  /**
   * #556 T2: 来自 envelope.role 的 seam 副本 (runSubagentWorker 透传)。
   * worker 装配期查 catalog 取 body 注入 persona 段; 缺省 / 未知 → 走 V1
   * baseline (不入 persona 段, 不注入额外 deny, 详见 plan T2 防御契约)。
   */
  readonly role?: string;
  /**
   * #556 T2: 来自 envelope.systemPrompt 的 seam 副本 — 修复 schema 有 / 透传
   * 有 / 此前未消费的幽灵通道。该字段在 worker 装配期作为 addendum 追加
   * persona 段之后 (顺序: base < persona < addendum), 与 LOCKED 5 段解耦。
   */
  readonly addendum?: string;
  /**
   * #562 T6: bash 模式显式覆盖 (= 优先于 role 派生)。缺省 → worker
   * 装配期调 resolveBashMode(role) 派生:role "explore" → "readonly",
   * 其他全部 → "any"。该 seam 为测试与未来跨阶段注入留口 (e.g.
   * 直接派 readonly worker 不读 catalog)。Catalog 路由仍归 spawn
   * tool 负责;registry 只透传,不读 catalog。
   */
  readonly bashMode?: "any" | "readonly";
}

/**
 * 装配 worker 进程的 LoopEngineDeps。真实路径 (spec T1):
 *   - adapter = createRealAnthropicAdapter (build-engine 同款参数);
 *   - registry = createDefaultAciRegistry (不传 subagentManager → 无 spawn_subagent);
 *   - executor = createAciExecutor (permission middleware + fail-closed askUser);
 *   - system = createIknowSystemResolver (surface "ask" → 无 BOOTSTRAP);
 *   - trace = createJsonlTraceService (cli.ts 同形态; 测试覆盖 noop);
 *   - compress 透传 env.compress (与 build-engine 同形态)。
 *
 * worker 子进程是任务型 (有界 scope), 不装配 MCP manager / memory layer /
 * LSP notifier —— 与 build-engine 的差异注释见各装配点。
 */
export async function createWorkerDeps(
  opts: CreateWorkerDepsOptions
): Promise<LoopEngineDeps> {
  return (await createWorkerRuntime(opts)).deps;
}

/**
 * D-α 观测地板: `createWorkerDeps` 的全量装配产物。
 *
 * `createWorkerDeps` 只透出 `deps`(既有 seam, 全部现存 caller 不变);
 * 生产入口 `runSubagentWorker` 走本函数, 额外拿到 ACI catalog —— fileRefs
 * 需要按 `aci.category === "write"` 派生工具名, 而 `LoopEngineDeps` 只带
 * 无 ACI 元数据的 `registry`。不把 catalog 塞进 deps: `LoopEngineDeps` 是
 * loop-engine 的契约面, 加一个只有 worker 消费的字段会污染它。
 */
export async function createWorkerRuntime(
  opts: CreateWorkerDepsOptions
): Promise<{
  readonly deps: LoopEngineDeps;
  readonly catalog: AciCatalog;
}> {
  const { env, sandboxRoot } = opts;
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // 任务型子代理: 用 fail-closed askUser (无交互, 权限不足即拒绝, #162 平权
  // 装配)。subagent 聚焦执行, 不重复向 operator 弹 y/N 提示。
  const askUser = createNoAskUser();

  const adapter =
    opts.model ??
    withTransportRetry(
      createRealAnthropicAdapter({
        client: new Anthropic({
          apiKey: env.llm.apiKey,
          baseURL: env.llm.baseUrl,
        }),
        model: env.llm.model,
        maxTokens: env.llm.maxOutputTokens,
        temperature: env.llm.temperature,
        thinking: buildThinkingParams(env.llm),
        stream: env.llm.stream === "on",
      }),
      { translate: translateAnthropicTransportFault }
    );

  // skill 索引: worker 自身独立扫描 (spec OQ3 默认 —— 简化通信, 复用父装配
  // 形态); scanner 内部 try/catch + warn, 目录缺失降级, 装配不阻塞。
  const skillCatalog =
    opts.skillCatalog ??
    createSkillCatalog(
      await createSkillScanner({ userHome, cwd, env: process.env }).scan()
    );

  // 独立 registry: 不依赖父注册表 (spec 假设 4)。worker 子进程不含
  // spawn_subagent (SC9) —— registry.ts 不传 subagentManager, 该工具不在
  // factories 里 (T2 才把两件工具 append 进 ACI_TOOLSET_NAMES)。
  // #562 T6: bashMode 透传到 bash 工具工厂。优先 opts.bashMode 显式覆盖,
  // 否则 resolveBashMode(role) 派生 (role 缺省 / 未知 → "any" fallback)。
  const isJudge = opts.role === "judge";
  const bashMode: "any" | "readonly" =
    opts.bashMode ?? (isJudge ? "any" : resolveBashMode(opts.role));
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    skillCatalog,
    ...(opts.disallowedTools ? { disallowedTools: opts.disallowedTools } : {}),
    // ADR-0019 (review-fix H3): spread-guard 透传 —— 缺席时 registry
    // 内部 fallback sandboxRoot(legacy 字节不变)。
    ...(opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
    ...(bashMode !== undefined ? { bashMode } : {}),
  });

  const baseExecutor = createExecutor(reg.inner);
  const policy = createPermissionPolicy();
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
  });

  // surface "ask" → shouldIncludeBootstrap false (无 BOOTSTRAP 段); memory
  // 关闭 (worker 有界 scope, 不共享用户记忆层)。skills 段照常注入
  // (SC12: skill 工具在场就该让模型知道 available skills)。
  // Judge workers must not inherit the full iknow soul / assistant voice
  // (verify-goal-gate T2). Catalog lookup is skipped so "unknown role"
  // fallback does not re-attach the iknow base.
  const baseSystem = isJudge
    ? async () => undefined
    : (opts.system ??
      createIknowSystemResolver({
        cwd,
        userHome,
        surface: "ask",
        memoryEnabled: false,
        skills: () =>
          skillCatalog.available().map((entry) => ({
            name: entry.name,
            description: entry.description ?? "",
            ...(entry.disabled ? { disabled: true } : {}),
          })),
      }));

  // #556 T2 + #562 T7: persona + constraints + addendum 注入 (加性段,
  // 不触碰 IKNOW_ASSEMBLY_ORDER)。顺序 base < persona < constraints <
  // addendum;三者全缺省 → base 透传, V1 baseline 严格 byte-stable。
  //
  // role 缺省 / 未知 → 不查 catalog / 不注入 persona / 不注入 constraints
  // (T2 防御契约 + T7 readonly 派生, defense-in-depth): worker 装配期
  // catch AgentCatalogLookupError 显式走 fallback, 单测 envelope-role
  // 与 tool-constraints 锁定该路径。
  const personaText = isJudge ? undefined : resolvePersonaBody(opts.role);
  const constraintsText = isJudge
    ? undefined
    : resolveConstraintsText(opts.role);
  const addendumText = opts.addendum;
  const system =
    personaText !== undefined ||
    constraintsText !== undefined ||
    addendumText !== undefined
      ? withRoleExtras(baseSystem, personaText, constraintsText, addendumText)
      : baseSystem;

  const deps: LoopEngineDeps = {
    adapter,
    executor,
    registry: reg.inner,
    // #353 settings 回退已在 loadIknowEnv 内合并; envelope.maxTurns 由
    // runWorkerOnce 优先覆写。
    maxTurns: env.llm.maxTurns,
    detectToolLoop: env.loop?.detectToolLoop !== false,
    timeoutMs: env.llm.timeoutMs,
    system,
    promptTools: reg.visibleSchemas,
    // cli.ts 同形态: traceOut flag > IKNOW_TRACE_OUT env > ./trace/。worker
    // 继承父进程 env (ADR-0001), 这里再读一次 IKNOW_TRACE_OUT 保持解析顺序
    // 一致 (cli.ts resolveTracePath 形态)。
    trace:
      opts.trace ??
      createJsonlTraceService({
        filePath: process.env.IKNOW_TRACE_OUT ?? DEFAULT_WORKER_TRACE_DIR,
        conversationId: randomUUID(),
      }),
    compress: {
      contextWindow: env.compress.contextWindow,
      thresholdTokens: env.compress.thresholdTokens,
    },
  };
  // 测试缝: opts.maxTurns 覆盖 env 默认值。LoopEngineDeps.maxTurns 是
  // readonly, 必须新建对象 (不变量: 不修改 deps 而是返回新 deps, 与
  // runWorkerOnce 的 { ...deps, maxTurns } 形态一致)。
  return {
    deps:
      opts.maxTurns !== undefined ? { ...deps, maxTurns: opts.maxTurns } : deps,
    catalog: reg.catalog,
  };
}

/**
 * envelope 观测字段的派生源 (D-α 地板)。
 *
 * `writeToolNames` 缺席 → 不派生 fileRefs。刻意不在 worker 内兜底一份硬编码
 * 名单: 唯一真值是 ACI catalog 的 `category:"write"` (见 file-refs.ts),
 * 装配路径 (runSubagentWorker) 负责把它传进来。
 */
export interface EnvelopeObservabilityOpts {
  readonly writeToolNames?: ReadonlySet<string>;
}

/**
 * D-α 观测地板: 由 RunResult 派生 envelope 的两个观测字段。
 *
 * `stop_reason` 恒填 (run() 一定有 stopReason); `fileRefs` 仅在调用方给出
 * write 工具名集合 (从 ACI catalog 的 `category:"write"` 派生) 且确有写路径
 * 时落值 —— Postel: 无派生源 / 无写操作都不写 key, 与 V1 逐位兼容。
 */
function observabilityFields(
  result: import("../model-adapter/types.js").RunResult,
  opts?: EnvelopeObservabilityOpts
): Pick<SubAgentEnvelope, "stop_reason" | "fileRefs"> {
  const refs =
    opts?.writeToolNames !== undefined
      ? deriveFileRefs(result.messages, opts.writeToolNames)
      : [];
  return {
    stop_reason: result.stopReason,
    ...(refs.length > 0 ? { fileRefs: refs } : {}),
  };
}

/**
 * 由 run() 结果派生 SubAgentEnvelope (status ok)。
 *
 * result 字段 = finalText ?? "" (浓缩结果); summary 同源 (V1 无独立
 * 摘要段, 与 finalText 同一真值, 保证父代理 drain 不会拿到空 summary)。
 * usage 透传 RunResult.lastUsage (字段缺席 = 无成功模型调用)。
 * D-α: 追加 stop_reason (恒填) 与 fileRefs (有写操作时填)。
 *
 * 导出: 测试 seam — 直接验证 envelope 派生逻辑, 不依赖 loop-engine
 * 完整装配 (后者单测用 createStubModel + 全 deps)。
 */
export function toOkEnvelope(
  result: import("../model-adapter/types.js").RunResult,
  opts?: EnvelopeObservabilityOpts
): SubAgentEnvelope {
  const text = result.finalText ?? "";
  return {
    status: "ok",
    summary: text,
    result: text,
    ...(result.lastUsage !== null ? { usage: result.lastUsage } : {}),
    ...observabilityFields(result, opts),
  };
}

/** 失败路径 envelope (SC6 reason enum: crashed/maxTurnsExceeded/timeout/protocolError)。
 *  导出: 测试 seam — 直接验证 reason 四值各自的 envelope 形态。
 *  #358 T3 (additive): 第二参 summary 可选 — SIGTERM 优雅收尾时携带
 *  worker 自跑收尾摘要轮的 stop_summary 文本;不传时行为与旧签名逐位一致
 *  (空串), 不 breaking 既有 callers。
 *  D-α (additive): 第三参 extras 承载 stop_reason / fileRefs —— 只有从
 *  run() 返回值派生的失败路径 (protocolError / emptyFinalResponse / fused /
 *  SIGTERM 收尾) 有这两个真值; 抛错路径 (MaxTurnsExceeded / ProtocolError
 *  throw) 无 RunResult, 字段缺席。 */
export function toFailedEnvelope(
  reason: SubAgentEnvelope["reason"],
  summary = "",
  extras: Pick<SubAgentEnvelope, "stop_reason" | "fileRefs"> = {}
): SubAgentEnvelope {
  return {
    status: "failed",
    reason,
    summary,
    result: "",
    ...extras,
  };
}

/**
 * #358 T3:是否本 worker 的 SIGTERM 超时 abort。
 *
 * 判定线 = `signal.reason === "subagent-timeout"` (worker 注册的 SIGTERM
 * handler 用该 reason abort controller)。run() 的 stopReason 为 cancelled
 * 未必源自本 abort —— 工具侧 execution_failed:"cancelled" 也能产生
 * cancelled (computeToolStopFlags, 无 signal abort), 此时绝不能误走
 * 超时收尾信封。纯谓词, 导出供测试 seam 与 worker 判定共用。
 */
export function isSubagentTimeoutAbort(
  signal: AbortSignal | undefined
): boolean {
  return signal?.aborted === true && signal.reason === "subagent-timeout";
}

/**
 * #358 T2 / D8 (spec SC5): 仅 envelope.maxTurns 覆盖 deps; envelope.timeoutMs
 * 绝不过渡到 deps。两者语义分离 (C9):
 *   - deps.timeoutMs = per-call 竞速 (raceModel 模型调用超时);
 *   - envelope.timeoutMs = per-task 寿命 (父 manager SIGTERM 计时)。
 * 旧实现把二者混用 (D8 bug): 一次正常 LLM 调用会按任务寿命竞速, per-call
 * 保护失效 (spec 358 Code Style 理由段 "worker 内无 per-task 消费者")。
 *
 * 纯函数: envelope 无 maxTurns 时返回原 deps 引用 (spread 守卫零覆盖)。
 */
export function applyEnvelopeOverrides(
  envelope: Pick<WorkerEnvelope, "maxTurns">,
  deps: LoopEngineDeps
): LoopEngineDeps {
  return envelope.maxTurns !== undefined
    ? { ...deps, maxTurns: envelope.maxTurns }
    : deps;
}

/**
 * Judge (and other workers) keep envelope.task as the exam-question identity.
 * Truncated host dialogue and evidenceContext arrive as independent fields and
 * are injected as prior user messages — prompt, not concatenated into task.
 */
function priorMessagesFromEnvelope(
  env: WorkerEnvelope,
  encodeUserText: (text: string) => AnthropicNativeMessage
): ReadonlyArray<AnthropicNativeMessage> | undefined {
  const prior: AnthropicNativeMessage[] = [];
  if (env.finalText !== undefined && env.finalText.length > 0) {
    prior.push(encodeUserText(`Host truncated dialogue:\n${env.finalText}`));
  }
  if (env.evidenceContext !== undefined) {
    prior.push(
      encodeUserText(
        "Evidence context (prompt, not the exam question):\n" +
          JSON.stringify(env.evidenceContext)
      )
    );
  }
  return prior.length > 0 ? prior : undefined;
}

/**
 * 测试 seam (导出仅供测试): envelope → run → truncateEnvelopeResult。
 *
 * 把 readStdin → parseWorkerEnvelope → run → 派生 envelope → 截断这一段
 * 拆出来, 让单测直接调 runWorkerOnce({ workerEnvelope, deps }) 注入 stub
 * deps, 不 spawn 真 worker 子进程 (避免依赖真 LLM key)。
 *
 * 失败路径 (spec SC6 / assumption 16):
 *   - parseWorkerEnvelope 抛 ProtocolError → 不在这里处理 (调用方
 *     runSubagentWorker 捕获, exit 2 —— "协议层崩溃 → 父管理 reason:protocolError");
 *   - run() 抛 MaxTurnsExceeded → status:failed, reason:maxTurnsExceeded
 *     (plan T3 / ADR-0011: maxTurns 超限 = throw, worker emit failed envelope);
 *   - run() 抛 ProtocolError → status:failed, reason:protocolError
 *     (harness 模型协议错误, 不是 envelope 协议 —— 区别于 exit 2 路径);
 *   - 其他 run() 错误 → 抛出 (runSubagentWorker 兜底 → exit 2 → crashed)。
 *
 * #358 T3 SIGTERM 优雅收尾 (spec Code Style "catch 侧跑 epilogueSummary 一轮"):
 *   - 进程收 SIGTERM (父 manager 超时计时到) → 同步前奏注册的 handler 用
 *     reason "subagent-timeout" abort controller → raceModel callerAbort →
 *     run() 返回 stopReason="cancelled";
 *   - run() 内部的 epilogueSummary 会因 signal 已 abort 直接跳过 (L494
 *     "if (opts.signal?.aborted) return") —— 故 worker 在 run() 返回后
 *     用**未中止的新 signal** 自跑一轮收尾摘要 (reason:"timeout"), 捕获
 *     stop_summary 文本进 envelope.summary, 让父代理 drain 拿到真实进度
 *     (而非 generic "timeout after <n>ms");
 *   - 摘要轮 best-effort (D3 纪律): 失败 / 超时 / 抛错 → summary 回退空串,
 *     envelope 照常写, 绝不阻塞;
 *   - non-SIGTERM 路径 (普通 cancelled / protocolError / ok) 字节不变。
 */
export async function runWorkerOnce(opts: {
  readonly workerEnvelope: WorkerEnvelope;
  readonly deps: LoopEngineDeps;
  /**
   * D-α 观测地板: ACI catalog 派生的 write 类工具名 (fileRefs 的派生源)。
   * 生产路径由 runSubagentWorker 从 createWorkerRuntime 的 catalog 算出;
   * 缺席 → 不派生 fileRefs (stop_reason 不受影响, 恒填)。
   */
  readonly writeToolNames?: ReadonlySet<string>;
}): Promise<SubAgentEnvelope> {
  const { workerEnvelope: env, deps } = opts;
  const observability: EnvelopeObservabilityOpts =
    opts.writeToolNames !== undefined
      ? { writeToolNames: opts.writeToolNames }
      : {};
  // #358 T2 / D8: 只应用 maxTurns 覆盖, timeoutMs 不进 deps (per-call 语义)。
  const runDeps = applyEnvelopeOverrides(env, deps);
  // #358 T3: SIGTERM → abort("subagent-timeout")。worker 由父 manager per-task
  // 超时计时驱动, 收到 SIGTERM = 任务寿命到点, 走优雅收尾而非立即退出。
  const controller = new AbortController();
  const onSigterm = (): void => controller.abort("subagent-timeout");
  process.once("SIGTERM", onSigterm);
  try {
    // 运行期透传 signal。onStream 不传: (a) text_delta 等热路径事件 worker
    // 无展示消费方; (b) signal 已 abort 时 run() 内部不跑收尾摘要, 不会 emit
    // stop_summary —— 摘要捕获只在下方自跑收尾轮 (runTimeoutEpilogue) 完成。
    const priorMessages = priorMessagesFromEnvelope(
      env,
      runDeps.adapter.encodeUserText
    );
    const { result } = await run(
      env.task,
      runDeps,
      controller.signal,
      priorMessages !== undefined ? { priorMessages } : undefined
    );
    // run() 正常返回 ≠ 成功: harness 协议层错误 / 空最终回应以 stopReason
    // 形态返回 (不 throw), 但 worker 必须标 failed —— 父代理 drain 收到 ok
    // 却带 protocolError stopReason 会误判子代理成功 (SC6 / SC13)。
    if (result.stopReason === "fused") {
      log(`run() stopReason=fused`);
      return truncateEnvelopeResult(
        toFailedEnvelope(
          "protocolError",
          "fused",
          observabilityFields(result, observability)
        )
      );
    }
    if (
      result.stopReason === "protocolError" ||
      result.stopReason === "emptyFinalResponse"
    ) {
      log(`run() stopReason=${result.stopReason}`);
      return truncateEnvelopeResult(
        toFailedEnvelope(
          "protocolError",
          "",
          observabilityFields(result, observability)
        )
      );
    }
    // #358 T3 超时收尾: stopReason=cancelled 且确系本 worker 的 SIGTERM
    // abort (signal.reason === "subagent-timeout"; 工具侧 cancelled 不误标)。
    if (
      result.stopReason === "cancelled" &&
      isSubagentTimeoutAbort(controller.signal)
    ) {
      const summary = await runTimeoutEpilogue(runDeps, result.messages);
      log(
        `run() cancelled by SIGTERM (subagent-timeout); epilogue summary=${
          summary ? `${summary.length} chars` : "<empty>"
        }`
      );
      return truncateEnvelopeResult(
        toFailedEnvelope(
          "timeout",
          summary.length > 0 ? summary : "",
          observabilityFields(result, observability)
        )
      );
    }
    return truncateEnvelopeResult(toOkEnvelope(result, observability));
  } catch (err) {
    if (err instanceof MaxTurnsExceeded) {
      return truncateEnvelopeResult(toFailedEnvelope("maxTurnsExceeded"));
    }
    if (err instanceof ProtocolError) {
      log(`run() protocolError: ${err.message}`);
      return truncateEnvelopeResult(toFailedEnvelope("protocolError"));
    }
    throw err;
  } finally {
    // 任务结束（无论成败）即移除 SIGTERM 监听, 避免 worker 长驻阶段
    // 残留 listener（runSubagentWorker 随后 process.exit(0)）。
    process.removeListener("SIGTERM", onSigterm);
  }
}

/**
 * #358 T3:worker 自跑一轮 SIGTERM 收尾摘要 (best-effort, D3)。
 *
 * run() 返回 cancelled+(subagent-timeout abort) 时, run() 内部不会跑
 * 收尾摘要 (signal 已 abort, epilogueSummary 直接返回)。此处用全新
 * **未中止** controller 调 epilogueSummary 一轮 (reason:"timeout"):
 *   - 需要手传 result.messages (cancelled 时已含 appendSystemInterrupt 的
 *     权威历史, 见 run() stop 分支), 摘要轮只读它作为输入;
 *   - 捕获 stop_summary 事件文本 → 返回它; 摘要轮失败 / 超时 / signal
 *     再次中断 → 返回空串 (envelope 照常写, 绝不阻塞原始停因)。
 * 内部 15s 摘要超时归 loop-engine 的 runSummaryWithTimeout 管, 这里不再
 * 加第二层计时。
 */
async function runTimeoutEpilogue(
  deps: LoopEngineDeps,
  messages: ReadonlyArray<
    import("../model-adapter/types.js").AnthropicNativeMessage
  >
): Promise<string> {
  let summary = "";
  const epilogueController = new AbortController();
  try {
    await epilogueSummary({
      deps,
      messages,
      reason: "timeout",
      signal: epilogueController.signal,
      onStream: (event: HarnessStreamEvent) => {
        if (event.type === "stop_summary") {
          summary = event.text;
        }
      },
    });
  } catch {
    // D3: 摘要失败绝不阻塞 — 返回空串, writer 侧照常写 timeout 信封。
    return "";
  }
  return summary;
}

/** 一次性读 stdin 全部字节 (worker 协议: 单 envelope, 读到 EOF)。 */
function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () =>
      resolve(Buffer.concat(chunks).toString("utf8"))
    );
    process.stdin.on("error", (err) => reject(err));
  });
}

/**
 * worker 进程主入口 (cli.ts dispatch):
 *   stdin 一次性读全部 → parseWorkerEnvelope → createWorkerDeps →
 *   runWorkerOnce → stdout newline-JSON → exit 0。
 *
 * 顶层不 try/catch: 调用方 (cli.ts) 用 .catch → exit 2 兜底
 * (协议层崩溃 —— assumption 16: JSON parse / 信封字段缺失)。
 */
export async function runSubagentWorker(): Promise<void> {
  const input = await readStdin();
  const workerEnvelope = parseWorkerEnvelope(input);
  const env = loadIknowEnv();
  const { deps, catalog } = await createWorkerRuntime({
    env,
    sandboxRoot: workerEnvelope.sandboxRoot,
    disallowedTools: workerEnvelope.disallowedTools,
    // #556 T2: envelope.role / envelope.systemPrompt 透传到 createWorkerDeps
    // seam —— 缺失时不传 (V1 baseline, byte-stable)。
    ...(workerEnvelope.role !== undefined ? { role: workerEnvelope.role } : {}),
    ...(workerEnvelope.systemPrompt !== undefined
      ? { addendum: workerEnvelope.systemPrompt }
      : {}),
    // ADR-0019 (review-fix H3): worker 继承父 env SSOT —— 当 spawn 父进程
    // 设置了 IKNOW_WORKSPACE_ROOT,worker 的 fs-policy fence 也按同一根
    // 保护 `.iknow`(与 build-engine 同形态)。条件解析:无 flag 且无 env
    // 时不 resolve,保持 sandboxRoot fallback(legacy 字节不变)。
    ...(env.workspaceRoot !== undefined
      ? {
          workspaceRoot: resolveWorkspaceRoot({
            cwd: process.cwd(),
            env: { [WORKSPACE_ROOT_ENV_KEY]: env.workspaceRoot },
          }),
        }
      : {}),
  });
  // D-α 观测地板: fileRefs 的派生源 = 本 worker 实际装配出的 ACI catalog
  // 里 category:"write" 的工具名 (def-list 期裁剪后的真实工具面)。
  const result = await runWorkerOnce({
    workerEnvelope,
    deps,
    writeToolNames: writeToolNamesFrom(catalog),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}
