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
  createRealAnthropicAdapter,
  buildThinkingParams,
  createExecutor,
  type LoopEngineDeps,
} from "../index.js";
import { createDefaultAciRegistry } from "../aci/tools/registry.js";
import { createAciExecutor } from "../aci/index.js";
import { createPermissionPolicy } from "../permission/policy.js";
import { createNoAskUser } from "../permission/ask-user.js";
import { createIknowSystemResolver } from "../identity/index.js";
import { createSkillScanner } from "../skill/scanner.js";
import { createSkillCatalog } from "../skill/catalog.js";
import { createJsonlTraceService, type TraceService } from "../trace/index.js";
import { run } from "../loop-engine.js";
import { MaxTurnsExceeded, ProtocolError } from "../errors.js";
import {
  parseWorkerEnvelope,
  truncateEnvelopeResult,
  type SubAgentEnvelope,
  type WorkerEnvelope,
} from "./envelope.js";

/** stderr 日志前缀 (spec Code Style: warn 一行不泄露 env 值)。 */
const LOG_PREFIX = "[subagent-worker]";

function log(message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

/** default worker trace dir (cli.ts DEFAULT_TRACE_DIR 同形态, IKNOW_TRACE_OUT 优先)。 */
const DEFAULT_WORKER_TRACE_DIR = "./trace/";

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
  const { env, sandboxRoot } = opts;
  const userHome = opts.userHome ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  // 任务型子代理: 用 fail-closed askUser (无交互, 权限不足即拒绝, #162 平权
  // 装配)。subagent 聚焦执行, 不重复向 operator 弹 y/N 提示。
  const askUser = createNoAskUser();

  const adapter =
    opts.model ??
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
    });

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
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    skillCatalog,
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
  const system =
    opts.system ??
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
    });

  const deps: LoopEngineDeps = {
    adapter,
    executor,
    registry: reg.inner,
    // #353 settings 回退已在 loadIknowEnv 内合并; envelope.maxTurns 由
    // runWorkerOnce 优先覆写。
    maxTurns: env.llm.maxTurns,
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
  return opts.maxTurns !== undefined
    ? { ...deps, maxTurns: opts.maxTurns }
    : deps;
}

/**
 * 由 run() 结果派生 SubAgentEnvelope (status ok)。
 *
 * result 字段 = finalText ?? "" (浓缩结果); summary 同源 (V1 无独立
 * 摘要段, 与 finalText 同一真值, 保证父代理 drain 不会拿到空 summary)。
 * usage 透传 RunResult.lastUsage (字段缺席 = 无成功模型调用)。
 *
 * 导出: 测试 seam — 直接验证 envelope 派生逻辑, 不依赖 loop-engine
 * 完整装配 (后者单测用 createStubModel + 全 deps)。
 */
export function toOkEnvelope(
  result: import("../model-adapter/types.js").RunResult
): SubAgentEnvelope {
  const text = result.finalText ?? "";
  return {
    status: "ok",
    summary: text,
    result: text,
    ...(result.lastUsage !== null ? { usage: result.lastUsage } : {}),
  };
}

/** 失败路径 envelope (SC6 reason enum: crashed/maxTurnsExceeded/timeout/protocolError)。
 *  导出: 测试 seam — 直接验证 reason 四值各自的 envelope 形态。 */
export function toFailedEnvelope(
  reason: SubAgentEnvelope["reason"]
): SubAgentEnvelope {
  return {
    status: "failed",
    reason,
    summary: "",
    result: "",
  };
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
 */
export async function runWorkerOnce(opts: {
  readonly workerEnvelope: WorkerEnvelope;
  readonly deps: LoopEngineDeps;
}): Promise<SubAgentEnvelope> {
  const { workerEnvelope: env, deps } = opts;
  const runDeps: LoopEngineDeps =
    env.maxTurns !== undefined ? { ...deps, maxTurns: env.maxTurns } : deps;
  try {
    const { result } = await run(env.task, runDeps);
    // run() 正常返回 ≠ 成功: harness 协议层错误 / 空最终回应以 stopReason
    // 形态返回 (不 throw), 但 worker 必须标 failed —— 父代理 drain 收到 ok
    // 却带 protocolError stopReason 会误判子代理成功 (SC6 / SC13)。
    if (
      result.stopReason === "protocolError" ||
      result.stopReason === "emptyFinalResponse"
    ) {
      log(`run() stopReason=${result.stopReason}`);
      return truncateEnvelopeResult(toFailedEnvelope("protocolError"));
    }
    return truncateEnvelopeResult(toOkEnvelope(result));
  } catch (err) {
    if (err instanceof MaxTurnsExceeded) {
      return truncateEnvelopeResult(toFailedEnvelope("maxTurnsExceeded"));
    }
    if (err instanceof ProtocolError) {
      log(`run() protocolError: ${err.message}`);
      return truncateEnvelopeResult(toFailedEnvelope("protocolError"));
    }
    throw err;
  }
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
  const deps = await createWorkerDeps({
    env: loadIknowEnv(),
    sandboxRoot: workerEnvelope.sandboxRoot,
  });
  const result = await runWorkerOnce({ workerEnvelope, deps });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(0);
}
