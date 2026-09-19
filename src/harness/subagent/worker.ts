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
 *     显式 process.exit(WORKER_EXIT_OK) 保证 stdout flush);
 *   - exit-code 语义按 ADR-0111 不变式 (b) 成文化 (常量 WORKER_EXIT_*):
 *     exit 2 仅信封协议错误 (parse ProtocolError 上抛, cli.ts 捕获);
 *     run 阶段逃逸 → best-effort failed envelope + exit 1;
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
import { join, resolve } from "node:path";
import { workerFenceTmpBesideRecord } from "../sandbox/fence-tmp.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  loadIknowEnv,
  wireModelFromRoute,
  type IknowEnv,
} from "../../config/env.js";
import { loadIknowSettings } from "../../config/settings.js";
import {
  FS_MODE_ENV_KEY,
  WORKSPACE_ROOT_ENV_KEY,
  WORKTREE_GATE_ON_ENV_KEY,
  resolveWorkspaceRoot,
} from "../../config/workspace-root.js";
import {
  createFsModeContext,
  parseFsModeFlag,
  type FsModeContext,
} from "../sandbox/fs-mode.js";
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
import { createLspNotifier } from "../lsp/notifier.js";
import { withLazyLspWarmup } from "../lsp/warmup.js";
import { DEFAULT_LSP_IDLE_TIMEOUT_MS } from "../lsp/client.js";
import { deriveFileRefs, writeToolNamesFrom } from "./file-refs.js";
import { createPermissionPolicy } from "../permission/policy.js";
import { resolveProjectPermissionSource } from "../permission/project-settings.js";
import { createNoAskUser } from "../permission/ask-user.js";
import {
  composePostHooks,
  composePreHooks,
  createPluginHooksFromCatalog,
  createSettingsHookContribution,
} from "../hooks/index.js";
import { type WorktreeGateReader } from "../isolation/worktree-gate.js";
import { createIknowSystemResolver } from "../identity/index.js";
import { createGitSnapshotProvider } from "../identity/git-snapshot.js";
import { createSkillScanner, type PluginSkillDir } from "../skill/scanner.js";
import { createSkillCatalog } from "../skill/catalog.js";
import { resolvePluginCatalog, resolvePluginRoots } from "../plugin/roots.js";
import { createJsonlTraceService, type TraceService } from "../trace/index.js";
import { run, epilogueSummary } from "../loop-engine.js";
import type { HarnessStreamEvent } from "../stream.js";
import {
  errorMessage,
  MaxTurnsExceeded,
  ModelStreamIncompleteError,
  ProtocolError,
} from "../errors.js";
import type { AnthropicNativeMessage } from "../model-adapter/types.js";
import {
  AgentCatalogLookupError,
  type AgentCatalogResolver,
} from "./catalog.js";
import { createMergedCatalogResolver } from "./user-catalog.js";
import { resolveSubagentCapabilities, type BashMode } from "./capability.js";
import {
  isTaskWorktreePath,
  mainCheckoutOf,
} from "../isolation/worktree-gate.js";
import {
  parseWorkerEnvelope,
  truncateEnvelopeResult,
  type SkillIndexSnapshotEntry,
  type SubAgentEnvelope,
  type WorkerEnvelope,
} from "./envelope.js";
import { toolConstraintsSegment } from "../identity/assemble.js";
import type { SkillSummary } from "../identity/assemble.js";
import type { SkillCatalogFaces } from "../skill/catalog.js";
import { writeRootSegment } from "../skill/body.js";

/** stderr 日志前缀 (spec Code Style: warn 一行不泄露 env 值)。 */
const LOG_PREFIX = "[subagent-worker]";

function log(message: string): void {
  process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}

/** default worker trace dir; the per-root anchor wins over the process cwd. */
const DEFAULT_WORKER_TRACE_DIR = "trace";

/**
 * #556 T2: 查 catalog 取 persona 段文本 (catalog body)。
 * role 缺省 → general-purpose（与 spawn_subagent 缺省角色对齐）。
 * 未知 id 走 catch 路径 (defense-in-depth): spawn 侧 ajv 已挡一轮, 此处为
 * wire-mismatch 兜底, 单测 envelope-role.test.ts 显式锁定 fallback 内容
 * (不静默吞掉 — 装配层发一行 log, 输出仍无 persona)。
 *
 * catalog 由调用方传入（worker 装配期按 userHome 构建 merged resolver,
 * 含 ~/.iknow/agents/ 用户角色）。
 */
function resolvePersonaBody(
  role: string | undefined,
  catalog: AgentCatalogResolver
): string | undefined {
  const id = role ?? "general-purpose";
  try {
    return catalog.get(id).body;
  } catch (err) {
    if (err instanceof AgentCatalogLookupError) {
      log(`role '${id}' not in catalog; falling back to V1 baseline`);
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
function resolveConstraintsText(
  role: string | undefined,
  catalog: AgentCatalogResolver
): string | undefined {
  if (role === undefined) return undefined;
  try {
    const entry = catalog.get(role);
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
 * 加性段追加在 base system 之后, 不重排 IKNOW_ASSEMBLY_ORDER 的 6 段
 * LOCKED 顺序 (identity / soul / usage / user_profile / bootstrap / memory_layer)。
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
  /** ADR-0019 (T4): per-root state anchor. Threaded to `createDefaultAciRegistry`
   *  → read_file's `extraReadRoots` so `<workspaceRoot>/.iknow` is reachable
   *  at parity with the home profile. ADR-0092 global mode: not a bind root;
   *  bash no longer threads it. Absent → registry falls back to sandboxRoot
   *  (legacy shape). */
  readonly workspaceRoot?: string;
  /**
   * T3 (ADR-0037 §4) + T5b (ADR-0037 §9.2 #6): 项目身份根,双消费面。
   *   - T3 身份发现（不变）：rules / 项目 `AGENTS.md` / 项目 skills 读它，
   *     而不是 worker 自己的 cwd —— 改绑后 cwd 是一棵没有 `.iknow` 的裸树；
   *     缺席回落 cwd（未改绑时两者同值，字节不变）。
   *   - T5b bash 围栏读白名单：createWorkerRuntime 在围栏 taskRoot
   *     （sandboxRoot）是 task-worktree 形状时把它（缺席回落
   *     `mainCheckoutOf(sandboxRoot)`）透传给 registry → bash 工厂 →
   *     per-call createFsPolicy 合同读根（提供即恒进，fail-loud 由
   *     policy 层承担）。生产路径 build-engine spawn 处已无条件注入
   *     `sessionRoots.projectIdentityRoot`（IKNOW_PRODUCT_ROOT，T3 wire），
   *     值与主链 registry（build-engine isolationEnabled 档）同一份。
   */
  readonly projectIdentityRoot?: string;
  /**
   * ADR-0092 Round 2 / SC11/SC12:fs 隔离档 holder(per-call snapshot),
   * 透传给 worker 的 bash 工厂。holder 缺席 → 全局档(V1 baseline)。
   * homeRoot 不是独立缝:装配层从本层已 resolve 的 `userHome`
   * (opts.userHome ?? homedir())派生,与 settings / persona / state 同源。
   *
   * 生产入口的 holder 由 `fsModeOptionFromEnv(process.env)` 从父进程写的
   * `IKNOW_FS_MODE` 造(见 runSubagentWorker)—— worker 是独立进程,拿不到
   * 父进程的 holder 对象,档位只能以值过界后在本进程重建 holder。
   */
  readonly fsMode?: import("../sandbox/fs-mode.js").FsModeContext;
  /**
   * issue 1059:worktree-on-mutate 开关的进程内重建 holder —— 生产入口由
   * `worktreeGateOptionFromEnv(process.env)` 从父进程写的
   * `IKNOW_WORKTREE_GATE_ON`("1"/"0")造。worker 无门禁 executor,此 holder
   * 只喂 bash 工厂的 UNBOUND_FENCE 判定;键缺席 / 非法 → 键缺席 = bash 工厂
   * 无 holder → 永不发段(legacy 父进程字节不变)。
   */
  readonly worktreeOnMutate?: WorktreeGateReader;
  /**
   * #556 T2: 来自 envelope.role 的 seam 副本 (runSubagentWorker 透传)。
   * worker 装配期查 catalog 取 body 注入 persona 段; 缺省 / 未知 → 走 V1
   * baseline (不入 persona 段, 不注入额外 deny, 详见 plan T2 防御契约)。
   */
  readonly role?: string;
  /**
   * #556 T2: 来自 envelope.systemPrompt 的 seam 副本 — 修复 schema 有 / 透传
   * 有 / 此前未消费的幽灵通道。该字段在 worker 装配期作为 addendum 追加
   * persona 段之后 (顺序: base < persona < addendum), 与 LOCKED 6 段解耦。
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
  /**
   * T5 (ADR-0071 / SC8 + L2): 由 envelope.traceFilePath
   * 透传的 worker content trace 锚点(父会话已经替这个 taskId 建好
   * `<父会话文件夹>/subagents/agent-<taskId>.jsonl`)。在场时 worker file-mode
   * 落该路径 + conversationId=taskId,替代 L2 假 scope `randomUUID()`(已退役)。
   * 缺席 → 走 IKNOW_TRACE_OUT / defaultTraceDir 退路(byte-stable)。
   */
  readonly traceFilePath?: string;
  /**
   * T5: 配套 traceFilePath —— 该 worker 的 taskId(parent spawn 时已锁)。
   * 生产装配层 (runSubagentWorker 经 manager envelope 透传) 永远会同时传
   * `traceFilePath + taskId` 配对;两键同时在场是 file-mode 装配的前提,
   * traceFilePath 缺席时本字段被忽略(legacy IKNOW_TRACE_OUT 退路)。
   *
   * ADR-0084 / D1 (second consumer): 同一 taskId 也喂
   * `LoopEngineDeps.conversationId` —— 让 worker 的 last-read 账本按
   * worker 身份分桶（子代理自己的空桶）。trace 无关的 caller（测试缝 /
   * 只关心账本的装配）也可以只传本字段；缺席 → 无 id，非空覆写 fail-closed。
   */
  readonly taskId?: string;
  /**
   * T3: explicit worker fence `/tmp` pad. Absent + `traceFilePath` present →
   * `<dirname(traceFilePath)>/fence-tmp` (nested `subagents/<taskId>/`).
   */
  readonly tmpDir?: string;
  /**
   * ADR-0085 / SC9:父会话账本锚点(由 envelope.todoLedger 透传)。
   * `projectDir` = 父会话项目目录(`TodoWriteToolDeps.todoDir` 同一值),
   * `conversationId` = 父会话 id。在场 → worker registry 装配 todo_write:
   * 与父共用同一本账(可 read / update),`add` 由工具自身 typed 拒绝
   * (添加仅父会话;worker 权限层是 no-ask,不能靠它兜)。
   * 缺席(旧 wire / 跨版本 resume)→ 不装配 todo_write,工具面 byte-stable。
   */
  readonly todoLedger?: {
    readonly projectDir: string;
    readonly conversationId: string;
  };
  /**
   * T7 (`specs/skill-index-increment.md` / SC10 + assumption 7):父会话 spawn
   * **当时**的完整模型索引快照(由 envelope.skillIndexSnapshot 透传)。
   *
   * 在场(含空数组) → worker 的 `<available_skills>` 冻表以它为**唯一来源**
   * —— 父已追加进场的名不在 worker 的扫描里,靠 rescan 拿不到;且父与 worker
   * 的技能根可以不同(插件根随 reload / 工作目录差异),按名回查会丢条目,
   * 故按名 + description 直出(渲染仍走 `skillsSegment`,SSOT 不变)。
   * 缺席(旧 wire / 跨版本 resume / 直连装配) → 退回 worker 自己的独立 rescan
   * (`createSkillScanner`,与今日逐字节一致)。
   */
  readonly skillIndexSnapshot?: readonly SkillIndexSnapshotEntry[];
}

/**
 * T7:worker 索引面的**唯一裁决点** —— 父快照在场就用父快照,否则用 worker
 * 自己的 catalog(退回既有行为,逐字节不变)。
 *
 * 两条路径都产 `SkillSummary[]`,渲染仍归 `skillsSegment`(identity 层
 * SSOT)—— worker 不留第二套渲染,也不预渲染段文本(段的位置 / 排序 /
 * 空清单句全由那一个函数决定)。
 *
 * 冻表纪律:快照路径在**装配期**投影一次并冻结(快照是值,worker 进程内不
 * 再变;与 git 快照缝同款 —— 相邻两次求值 byte-stable 是 KV 缓存契约的
 * 前提)。catalog 路径保持既有形态(每次现读 —— 集合本身装配期已定)。
 *
 * 快照条目带的是**父的** name + description:父与 worker 的技能根可以不同
 * (插件根随 reload / 工作目录差异),按名在 worker catalog 里回查会丢条目
 * —— spec 的判据是「完整」,故直出(该名在 worker 里可能无正文可加载,
 * 见 CreateWorkerDepsOptions.skillIndexSnapshot 注释)。
 */
function systemSkillsGetter(opts: {
  readonly snapshot: readonly SkillIndexSnapshotEntry[] | undefined;
  readonly catalog: SkillCatalogFaces;
}): () => ReadonlyArray<SkillSummary> {
  if (opts.snapshot === undefined) {
    return () =>
      opts.catalog.available().map((entry) => ({
        name: entry.name,
        description: entry.description ?? "",
        ...(entry.disabled ? { disabled: true } : {}),
      }));
  }
  // 投影只搬 name / description —— 不带 `disabled`:模型索引面本就不含
  // disabled 条目,快照里不存在「disabled 为真」的合法输入(envelope schema
  // 也不收该键)。
  const frozen: ReadonlyArray<SkillSummary> = Object.freeze(
    opts.snapshot.map((entry) =>
      Object.freeze({
        name: entry.name,
        ...(entry.description !== undefined
          ? { description: entry.description }
          : {}),
      })
    )
  );
  return () => frozen;
}

/**
 * ADR-0092 Amendment 2026-09-13 / SC11:worker 侧 fs 档读点 —— 父进程经
 * `IKNOW_FS_MODE` 写来的档位字面 → `createWorkerDeps` 的 `fsMode` holder。
 *
 * worker 是独立进程:没有父进程的 holder 对象可共享,档位只能以**值**过
 * 进程边界,worker 侧新建一个 holder 并把该值当初始值。与「worker 进程内该
 * 档恒定」的语义一致 —— worker 不提供 `/config` 命令面,没有就地翻档的
 * 第二入口;holder 形态保留是给 bash 工厂的既有 opt 契约(handler per-call
 * `get()`),不是给运行期翻转的。
 *
 * 归一走 `parseFsModeFlag`(值域 SSOT,与 settings 段 / `/config` 同一份)
 * 而不是在 worker 里再写一遍字面比较:大小写与首尾空白按同一条规则折叠。
 * 缺省 / 非法值 → **键缺席**(不显式写 `global`)—— 与 `workspaceRoot` /
 * `productRoot` 的 spread-guard 同款,让「缺席」在下游只有一种解释,且
 * legacy 路径(旧父进程不写该键)字节不变。
 */
export function fsModeOptionFromEnv(
  env: Readonly<Record<string, string | undefined>>
): { readonly fsMode?: FsModeContext } {
  const mode = parseFsModeFlag(env[FS_MODE_ENV_KEY]);
  return mode !== undefined ? { fsMode: createFsModeContext(mode) } : {};
}

/**
 * issue 1059:与 `fsModeOptionFromEnv` 同纪律的开关过界重建 —— 值域是
 * "1"/"0" 两枚,非法值 → 键缺席(下游 spread-guard 丢弃,等同通道未接),
 * 不在 worker 里猜父进程意图。
 */
export function worktreeGateOptionFromEnv(
  env: Readonly<Record<string, string | undefined>>
): {
  readonly worktreeOnMutate?: WorktreeGateReader;
} {
  const token = env[WORKTREE_GATE_ON_ENV_KEY];
  if (token !== "1" && token !== "0") return {};
  const on = token === "1";
  return { worktreeOnMutate: Object.freeze({ get: () => on }) };
}

function resolveWorkerFenceTmp(
  opts: Pick<CreateWorkerDepsOptions, "tmpDir" | "traceFilePath">
): string | undefined {
  if (opts.tmpDir !== undefined && opts.tmpDir.trim().length > 0) {
    return opts.tmpDir;
  }
  if (
    opts.traceFilePath !== undefined &&
    opts.traceFilePath.trim().length > 0
  ) {
    return workerFenceTmpBesideRecord(opts.traceFilePath);
  }
  return undefined;
}

/**
 * ADR-0085 / SC9:worker 侧账本注册缝 —— 父会话账本锚点(经 envelope
 * `todoLedger` 透传)在场 → `todo_write` 入 worker 工具面,挂到与父**同一本**
 * todos.md;`canAdd:false` 让工具自身 typed 拒绝 `add`(读 / 更新可用)。
 * 缺席 → 不装配(旧 wire byte-stable,worker 工具面不含 todo_write)。
 *
 * 与主 loop registry 同源:`todoDir` 就是父 registry 拿到的那个值,worker 不
 * 另派生(路径分段清洗归 `resolveConversationTodoPath`)。
 */
function todoLedgerRegistryOpts(
  ledger:
    | {
        readonly projectDir: string;
        readonly conversationId: string;
      }
    | undefined
): {
  todoDir?: string;
  todoActor?: { conversationId: string; canAdd: false };
} {
  if (ledger === undefined) return {};
  return {
    todoDir: ledger.projectDir,
    todoActor: { conversationId: ledger.conversationId, canAdd: false },
  };
}

/**
 * SC9:worker 子进程的 Anthropic client。headers 透传与 build-engine
 * `createAdapterFromEnv` 同形 —— `env.llm.headers` 有值时作 SDK
 * `defaultHeaders`;缺席时**不传该键**(条件 spread),client options 与今日
 * 逐字节一致(不会多出显式 `undefined` / `{}`)。
 *
 * 独立成挂载点而非内联:装配函数已超 S5 复杂度阈值,新增分支必须落在
 * 新函数里(ratchet 只允许持平 / 下降),且这里本来就是「env → client」的
 * 单一职责边界。
 */
function createWorkerAnthropicClient(env: IknowEnv): Anthropic {
  return new Anthropic({
    apiKey: env.llm.apiKey,
    baseURL: env.llm.baseUrl,
    ...(env.llm.headers !== undefined
      ? { defaultHeaders: env.llm.headers }
      : {}),
  });
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
 * worker 子进程是任务型 (有界 scope), 不装配 MCP manager / memory layer ——
 * 与 build-engine 的差异注释见各装配点。LSP notifier / warmup 二期 B6 起与
 * build-engine 同构装配（SSOT: LspCtx.directory ≡ sandboxRoot）。
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
  // user agents 目录按 worker 自身 userHome 扫描（测试缝 userHome 同时
  // 隔离 ~/.iknow/agents）。记忆化在 user-catalog 内, 每进程最多扫一次。
  const agentCatalog = createMergedCatalogResolver({ home: userHome });
  const cwd = opts.cwd ?? process.cwd();
  // T3: 身份发现根。父会话没传（未改绑 / 旧 wire）→ 回落 cwd，与今日同值。
  const projectIdentityRoot = opts.projectIdentityRoot ?? cwd;
  // T5b (ADR-0037 §9.2 #6): worker bash 围栏的 identity 合同读根。worker
  // 进程没有 isolationEnabled 信号(settings / isolationHost 都不在场),但其
  // 围栏 taskRoot = sandboxRoot(spawn 期冻结,registry 无 liveTaskRoot),主链
  // 「rebind 后 identity 根才装载」的谓词在 worker 侧的等价形式 = sandboxRoot
  // 是 task-worktree 形状 —— 与 build-engine spawn 处给 sessionRoot 的判定
  // (taskWorktreeOwnerOf,build-engine.ts 同一函数)同源:
  //   - OFF / 未改绑(sandboxRoot = 主仓):不传 —— .git 就在 cwd 内,本不缺
  //     读通道(ADR §9.2 #6 括号理由),字节同今日,不比主链更宽;
  //   - ON + 已改绑(sandboxRoot = task worktree):传父会话 verbatim 的
  //     sessionRoots.projectIdentityRoot(T3 IKNOW_PRODUCT_ROOT wire 已送达,
  //     与主链 ON 档 registry 同一份值),修 worktree repo 发现断链(git
  //     status exit 128,T1 盘点实测)。
  // 值回落 mainCheckoutOf(sandboxRoot):与 build-engine sessionRoots 派生
  // (mainCheckoutOf(opts.projectIdentityRoot ?? cwd))同一 SSOT 纯路径推导,
  // 不新造状态源;回落值盘上缺席时由 policy 合同根 fail-loud(§9.4)。
  const identityFenceRoot = isTaskWorktreePath(sandboxRoot)
    ? (opts.projectIdentityRoot ?? mainCheckoutOf(sandboxRoot))
    : undefined;
  const defaultTraceDir = resolve(
    opts.workspaceRoot ?? cwd,
    DEFAULT_WORKER_TRACE_DIR
  );

  // 任务型子代理: 用 fail-closed askUser (无交互, 权限不足即拒绝, #162 平权
  // 装配)。subagent 聚焦执行, 不重复向 operator 弹 y/N 提示。
  const askUser = createNoAskUser();

  const adapter =
    opts.model ??
    withTransportRetry(
      createRealAnthropicAdapter({
        // ADR-0093 / SC9：env.llm.headers → client defaultHeaders，构造见
        // `createWorkerAnthropicClient`（条件 spread，缺席不传键）。
        client: createWorkerAnthropicClient(env),
        model: wireModelFromRoute(env.llm.model),
        maxTokens: env.llm.maxOutputTokens,
        temperature: env.llm.temperature,
        thinking: buildThinkingParams(env.llm),
        stream: env.llm.stream === "on",
      }),
      { translate: translateAnthropicTransportFault }
    );

  // skill 索引: worker 自身独立扫描 (spec OQ3 默认 —— 简化通信, 复用父装配
  // 形态); scanner 内部 try/catch + warn, 目录缺失降级, 装配不阻塞。
  // #global-plugins T1: 插件 skill 同样由 worker 自解析（与父装配同源 = 同一
  // 插件根解析 + 同一 disabled 过滤）。merged catalog 的 plugin agents 走
  // createMergedCatalogResolver() 自解析（ACR #5）—— 不需要 worker 注入。
  const workerSettings = loadIknowSettings({
    cwd: projectIdentityRoot,
    home: userHome,
  });
  // 「解析根 → 扫描 → disabled 过滤（→ plugin catalog）」一条链走
  // roots.ts 的共用装配 helper（与 build-engine 同源），worker 不再各写
  // 一遍 —— disabled 过滤条件化的 branch 数留在 helper 内。
  const { catalog: pluginCatalog, enabled: enabledInstallations } =
    await resolvePluginCatalog({
      roots: resolvePluginRoots({
        userHome,
        settings: workerSettings,
      }),
      plugins: workerSettings.plugins,
    });
  // #global-plugins T2: hooksEntries 是插件 hooks 文件源（见 build-engine
  // 同款装配注释）；worker 与父引擎从同一份插件解析（同源、同 disabled）。
  const pluginSkillDirs: PluginSkillDir[] = enabledInstallations.map((p) => ({
    dir: join(p.root, "skills"),
    plugin: p.name,
  }));
  const skillCatalog =
    opts.skillCatalog ??
    createSkillCatalog(
      await createSkillScanner({
        userHome,
        projectIdentityRoot,
        env: process.env,
        // 空数组 = 无插件 skill（scanner 缺省即空数组），无须条件展开。
        pluginSkillDirs,
      }).scan()
    );

  // 独立 registry: 不依赖父注册表 (spec 假设 4)。worker 子进程不含
  // spawn_subagent (SC9) —— registry.ts 不传 subagentManager, 该工具不在
  // factories 里 (T2 才把两件工具 append 进 ACI_TOOLSET_NAMES)。
  // #562 T6: bashMode 与 catalog deny 均由同一能力解析源派生；显式
  // opts.bashMode 只保留既有测试/未来注入 seam，不改变 catalog 的 deny。
  const isJudge = opts.role === "judge";
  const capabilities = isJudge
    ? { bashMode: "any" as const, disallowedTools: opts.disallowedTools }
    : resolveSubagentCapabilities({
        role: opts.role,
        parentDisallowedTools: opts.disallowedTools,
        // 与 persona/constraints 同源: builtin + user agents merged catalog。
        catalog: agentCatalog,
      });
  if (capabilities.catalogError !== undefined) {
    log(`role '${opts.role}' not in catalog; bashMode fallback to 'any'`);
  }
  const bashMode: BashMode = opts.bashMode ?? capabilities.bashMode;
  // lsp-optimization 二期 B6/B7 closeout: worker 同构装配 LSP notifier +
  // warmup（与 build-engine 同缝）。SSOT: LspCtx.directory ≡ sandboxRoot。
  // lsp idleTimeoutMs 走常量缺省（10min），不读 settings.lsp（worker 仅
  // 在下方 user-hook 装配处读 settings.hooks 段）；超时/等待仍走工具层常量。
  // Locked sentence 5:warmup 不在装配期起,改由 deps.registry 视图惰性 arm
  // （第一次 language server 工具名解析），见下方 withLazyLspWarmup 调用。
  const lspCtx = {
    directory: sandboxRoot,
    idleTimeoutMs: DEFAULT_LSP_IDLE_TIMEOUT_MS,
  };
  const lspNotifier = createLspNotifier(lspCtx);
  const workerFenceTmp = resolveWorkerFenceTmp(opts);
  const reg = createDefaultAciRegistry({
    env,
    sandboxRoot,
    skillCatalog,
    onEdit: (file) => lspNotifier.invalidate(file),
    lspCtx,
    ...(capabilities.disallowedTools !== undefined
      ? { disallowedTools: capabilities.disallowedTools }
      : {}),
    // ADR-0019 (T4): per-root state anchor spread-guard — absent →
    // registry falls back to sandboxRoot (legacy shape byte-identical).
    // Threaded to read_file's extraReadRoots; bash no longer consumes it
    // (ADR-0092 global mode has no per-root mount and no policy predicate).
    ...(opts.workspaceRoot !== undefined
      ? { workspaceRoot: opts.workspaceRoot }
      : {}),
    // T5b (ADR-0037 §9.2 #6): identity 合同读根条件化透传(谓词见
    // identityFenceRoot)—— registry spread-guard 把它送进 bash 工厂 →
    // per-call createFsPolicy 读白名单;read_file / grep / glob 同得只读
    // 直通,与主链 isolationEnabled ON 档的 registry 面一致。缺席不传,
    // 与主链 OFF 档字节一致。
    ...(identityFenceRoot !== undefined
      ? { projectIdentityRoot: identityFenceRoot }
      : {}),
    // ADR-0092 Round 2 / SC11/SC12:fs 隔离档 holder + homeRoot 透传
    // 给 worker bash 工厂 —— 与 build-engine 主链同形态。holder 缺席 →
    // V1 global baseline。homeRoot 取本层已 resolve 的 `userHome`
    // (opts.userHome 测试缝 ?? homedir(),见上文),不留给 bash 工厂再
    // `homedir()` 一次 —— 与主链同款:测试缝必须能改到围栏源端。
    fsMode: opts.fsMode,
    homeRoot: userHome,
    // issue 1059:开关 holder 透传给 worker bash 工厂(缺席 = 不发段)。
    ...(opts.worktreeOnMutate !== undefined
      ? { worktreeOnMutate: opts.worktreeOnMutate }
      : {}),
    ...(bashMode !== undefined ? { bashMode } : {}),
    ...(workerFenceTmp !== undefined ? { tmpDir: workerFenceTmp } : {}),
    ...todoLedgerRegistryOpts(opts.todoLedger),
  });

  const baseExecutor = createExecutor(reg.inner);
  // ADR-0084 / SC5 worker 平权:worker 是同一会话的子代理面,项目权限规则
  // 必须与主链同源 —— 否则被主链 deny 的命令可从 worker 绕行。读根 =
  // `projectIdentityRoot`(与上方 user-hook settings 读根同一份,worker 无
  // sessionRoots,身份根经 IKNOW_PRODUCT_ROOT wire 送达 / 缺席回落 cwd);
  // fail-loud 原路上抛(typed ProjectSettingsError),worker 进程顶层
  // (cli.ts)转 stderr + exit 2,不静默降级成「无项目规则」。无项目规则 =
  // undefined,由 `createPermissionPolicy` 的 spread-guard 丢弃(与 key 缺席
  // 同形),此处不再叠一层条件分支。
  // ADR-0090: 声明式规则编译锚 = sandboxRoot(与 build-engine 同款);
  // knownToolNames 取 worker 内建 registry(无动态 MCP 件)——未知工具名
  // 的 deny/ask 加载期告警,规则仍保留编译。
  const policy = createPermissionPolicy({
    project: resolveProjectPermissionSource({
      projectIdentityRoot,
      workRoot: sandboxRoot,
      knownToolNames: new Set(reg.inner.list().map((def) => def.name)),
    }),
  });
  const settingsHooks = createSettingsHookContribution({
    hooks: loadIknowSettings({
      cwd: projectIdentityRoot,
      home: userHome,
    }).hooks,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    onError: (e) => process.stderr.write(`[worker ${e.phase}] ${e.message}\n`),
  });
  // 插件 hooks 文件源 —— 与父引擎同一份 catalog。链序 settings → plugin。
  const pluginHooksOpts: Parameters<typeof createPluginHooksFromCatalog>[0] = {
    entries: pluginCatalog.hooksEntries,
    installations: enabledInstallations,
    userHome,
    projectDir: projectIdentityRoot,
    cwd: sandboxRoot,
    env: process.env,
    onError: (e) => process.stderr.write(`[worker ${e.phase}] ${e.message}\n`),
  };
  const pluginHooks = createPluginHooksFromCatalog(pluginHooksOpts);
  // 组合器跳过 undefined 槽（未配的源）；worker 无 TUI post，插件 Post 若在
  // 场则单独成链。全缺席 → undefined → postToolUse 字段整体缺席（executor
  // 侧 `?? no-op` 同形，条件展开可省）。
  const postToolUse = composePostHooks([settingsHooks.post, pluginHooks.post]);
  const executor = createAciExecutor({
    inner: baseExecutor,
    catalog: reg.catalog,
    policy,
    askUser,
    hooks: {
      preToolUse: composePreHooks([settingsHooks.pre, pluginHooks.pre]),
      postToolUse,
    },
  });

  // surface "ask" → shouldIncludeBootstrap false (无 BOOTSTRAP 段); worker
  // 只注入静态 AGENTS.md / rules,不启用 memory library。skills 段照常注入
  // (SC12: skill 工具在场就该让模型知道 available skills)。
  // Judge workers must not inherit the full iknow soul / assistant voice
  // (verify-goal-gate T2). Catalog lookup is skipped so "unknown role"
  // fallback does not re-attach the iknow base.
  // plans/model-prefix-layering.md B5 / spec §9:worker 给父代理同款 git 快照。
  // worker 装配期同步取一次 createGitSnapshotProvider(以稳定
  // projectIdentityRoot 为 cwd),结果冻结在闭包 → worker 进程内字节级恒定,
  // 注入 resolver 的 `git` 缝 → 与父代理 share the same git block text。
  // 退化态(非 git 仓库 / git 不可用 / cwd 不可解析)→ undefined → 段缺席,
  // 装配不报错。
  const baseSystem = isJudge
    ? async () => undefined
    : (opts.system ??
      createIknowSystemResolver({
        cwd,
        projectIdentityRoot,
        userHome,
        surface: "ask",
        memoryEnabled: false,
        staticInstructions: opts.role !== "explore",
        // T7 (spec SC10):索引面 = 父会话当时快照(在场时)或 worker 自己的
        // catalog rescan(缺席时,既有行为逐字节不变)。裁决点见 systemSkillsGetter。
        skills: systemSkillsGetter({
          snapshot: opts.skillIndexSnapshot,
          catalog: skillCatalog,
        }),
        git: createGitSnapshotProvider({ cwd: projectIdentityRoot }),
      }));

  // #556 T2 + #562 T7: persona + constraints + addendum 注入 (加性段,
  // 不触碰 IKNOW_ASSEMBLY_ORDER)。顺序 base < persona < constraints <
  // addendum;三者全缺省 → base 透传, V1 baseline 严格 byte-stable。
  //
  // role 缺省 → general-purpose persona; 未知 id → 不注入 persona
  // (defense-in-depth): worker 装配期 catch AgentCatalogLookupError 显式走
  // fallback, 单测 envelope-role 与 tool-constraints 锁定该路径。
  const personaText = isJudge
    ? undefined
    : resolvePersonaBody(opts.role, agentCatalog);
  const constraintsText = isJudge
    ? undefined
    : resolveConstraintsText(opts.role, agentCatalog);
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
    // Locked sentence 5:worker 面同缝 —— 装配期不 warmup,第一次 language
    // server 工具名解析才 arm(与 build-engine 共用 lsp/warmup.ts 的视图)。
    registry: withLazyLspWarmup(reg.inner, lspCtx),
    // #353 settings 回退已在 loadIknowEnv 内合并; envelope.maxTurns 由
    // runWorkerOnce 优先覆写。
    maxTurns: env.llm.maxTurns,
    detectToolLoop: env.loop?.detectToolLoop !== false,
    timeoutMs: env.llm.timeoutMs,
    ...(env.llm.idleTimeoutMs !== undefined
      ? { modelIdleTimeoutMs: env.llm.idleTimeoutMs }
      : {}),
    ...(env.llm.hardCapMs !== undefined
      ? { modelHardCapMs: env.llm.hardCapMs }
      : {}),
    system,
    promptTools: reg.visibleSchemas,
    // ADR-0084 / D1:子代理是**独立** conversation —— 这个值让它拿到**自己的**
    // 一件空桶（账本按 conversationId 分桶），不是父会话的 id，也不与父会话
    // 共享任何条目。spec「子代理新 conversation 空表」要的是**空桶**而不是
    // **桶缺席**：`ledgerFor(undefined) === undefined` 会让 worker 内刚成功的
    // `read_file` 无处入账，同回合 read-modify-write 的 `write_file` 因此
    // **永久**被拒（不可恢复）—— 那是装配漏接线，不是契约。
    //
    // 语义关系：下方 trace 分支的 conversationId 也是 `opts.taskId`（manager
    // 在 spawn 期锁定的 task 身份），两个消费面指向同一身份，不会漂移。
    //
    // 缺席（legacy envelope / 跨版本 resume / 测试未传）→ undefined，**不兜底
    // 造 id**：造 per-process 假 id 等于给未读覆写开后门（比拒更危险）。
    // read / 白名单 bash 无 id 仍可执行。
    //
    // 最小性：其它 conversationId 消费者（backgroundManager / todoDir /
    // graphAssembly / subagentManager）都不在 worker registry 里，且
    // `resolveSessionFenceTmp` 的 `projectDir` 缺席 —— worker 的 `/tmp` pad
    // 仍只由 `tmpDir`(workerFenceTmp) 或 mkdtemp 回落决定。
    ...(opts.taskId !== undefined ? { conversationId: opts.taskId } : {}),
    // T3 (ADR-0071) 已退役 `./trace/` cwd-relative
    // 退路(SC6)—— 主会话 trace 锚走会话文件夹 (resolveServeDataDir() 同源)。
    // worker 继承父进程 env (ADR-0001),这里再读一次 IKNOW_TRACE_OUT 保持解析
    // 顺序一致 (cli.ts resolveTraceRoot 形态)。traceFilePath 在场时优先 (T5
    // SC8 + L2,见下方 trace 装配分支)。
    //
    // T5 (ADR-0071 / SC8 + L2): opts.traceFilePath
    // 在场时(由 envelope.traceFilePath 透传,父 manager 已经替这个 taskId
    // 建好 `<父会话文件夹>/subagents/agent-<taskId>.jsonl`),worker 直接 file-mode
    // 落该路径 + conversationId=taskId。
    //
    // review-fix (H1): `filePath` 是 JsonlTraceOptions 的目录模式键(目录 +
    // conversationId 派生出 <dir>/<convId>.jsonl),把文件路径当目录会让工
    // 厂把目标文件当目录 → 子目录 <filePath>/<taskId>.jsonl 不存在 → 静默
    // 零行落盘。修法:走 `traceFilePath` (file-mode 键) + `conversationId` 必
    // 须 == opts.taskId。taskId 缺席 → 装配期 fail-loud,不再用 `randomUUID()`
    // 假 scope(SC8 退役 L2,pack 配对契约写死)。
    //
    // 缺席 → 走 IKNOW_TRACE_OUT / defaultTraceDir 退路(legacy envelope / 跨
    // 版本 resume / 测试未传, byte-stable)。
    trace:
      opts.trace ??
      (opts.traceFilePath !== undefined
        ? (() => {
            if (opts.taskId === undefined) {
              throw new Error(
                "createWorkerDeps: traceFilePath 必须在场时 taskId 也在场(file-mode 配对)"
              );
            }
            return createJsonlTraceService({
              traceFilePath: opts.traceFilePath,
              conversationId: opts.taskId,
            });
          })()
        : createJsonlTraceService({
            filePath: process.env.IKNOW_TRACE_OUT ?? defaultTraceDir,
            conversationId: randomUUID(),
          })),
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

/** 失败路径 envelope (SC6 reason enum 五值: crashed/maxTurnsExceeded/timeout/
 *  protocolError/modelTransient —— 第五值由 ADR-0111 Decision 2 显式修订 SC9
 *  冻结追加, 承载「带 cause 的瞬时模型流/传输失败」)。
 *  导出: 测试 seam — 直接验证 reason 五值各自的 envelope 形态。
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
 *
 * T3 (plans/891-taskroot-remaining-consumers.md Task 3 / ADR-0037 §4
 * amendment 2026-09-05 (e)): worker 看见当前写根。
 *
 *   - envelope.sandboxRoot 即活 `taskRoot` 的 spawn-time 快照
 *     （manager.buildWorkerPayload 经 sandboxRootCell getter 读出），
 *     改绑后父代理的 `taskRoot` 翻到新根时，新 spawn 的 worker envelope 也带
 *     新根。worker 装配期直接读 envelope 字段即可，不另接 LiveTaskRoot cell
 *     —— 这是计划里"envelope 值 = 活根快照"的最小改动路径（ADR-0040：
 *     子代理 = 父会话执行臂，写根继承父生效根）。
 *   - 写根段永远追加在 finalText / evidenceContext 之后，顺序契约：
 *     [host dialogue?, evidence?, write root]。三段全缺省 → 返回 undefined
 *     （与旧语义一致，loop-engine 短路到无 prior 形态）。
 *   - sandboxRoot 是 envelope 必填字段（WORKER_SCHEMA.required），字符串长
 *     度大于 0 才注入；空白 / 不在场 → 退化到原 V1 形态（不崩，不漏）。
 *   - 不动 system `## Project path`（projectPathSegment 字节不变），也不静
 *     默改写 spawn `task` 正文（与原函数同形态）。
 *   - 导出：T3 测试 seam（tests/subagent/worker-write-root-prior.test.ts），
 *     直接验证 prior 段形态。
 */
export function priorMessagesFromEnvelope(
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
  // T6 (plans/write-situation-disclosure.md) — 当前写根段由 envelope
  // 处境枚举驱动（ADR-0069 D2; spec SC4 / OQ1）。
  //   - 旧 envelope（无 writeSituation 字段）→ typed skip，不注入写根段
  //     不回落旧文案（OQ1 采纳 (b) — 宁可不告知,不可说错）;
  //   - writeSituation = "no_writable_root" → ③ 态披露（不嵌入 sandboxRoot,
  //     不点名建树工具; spec SC3）;
  //   - writeSituation = "writable_main" / "writable_tree" → ①/② 文案
  //     与改造前逐字节相等（SC2 硬约束,前缀缓存与 skill-load-write-root
  //     SC2 守门）。
  // 顺序契约：[host dialogue?, evidence?, write root] —— 写根段永远是末段;
  // typed skip 时该 slot 在 extras 数组过滤掉,顺序保持不变。
  // 渲染 SSOT = writeRootSegment(skill/body.ts),与 skill 正文 trailer
  // (createSkillBody) 共用同一函数 —— worker 源内不留第二份长句
  // (skill-load-write-root 合同 1)。
  if (env.writeSituation !== undefined) {
    const segment = writeRootSegment(env.writeSituation, env.sandboxRoot);
    if (segment !== null) {
      prior.push(encodeUserText(segment));
    }
  }
  return prior.length > 0 ? prior : undefined;
}

/**
 * ADR-0102 T3 — 工人 transcript IO 缝（harness 侧契约面）。
 *
 * Gate B（tests/harness/public-exports.test.ts）禁止 src/harness 可执行面
 * import session-api —— 工人账的 codec 住在 session-api/store/worker-transcript，
 * 生产实现在 cli 入口（`runSubagentWorker` 唯一调用方）注入；worker 内核
 * 只见这个窄接口。not_found 折叠成 `absent`（合法态：新工人没有账 ≠ 错误），
 * 真实故障（io / parse / schema）原样上抛 —— 调用方不得把损坏的账读成无账。
 */
export interface WorkerTranscriptIO {
  readonly loadMessages: () => Promise<
    | {
        readonly status: "present";
        readonly messages: ReadonlyArray<AnthropicNativeMessage>;
      }
    | { readonly status: "absent" }
  >;
  readonly appendMessages: (
    events: ReadonlyArray<AnthropicNativeMessage>,
    thinkingMs?: number
  ) => Promise<void>;
}

/**
 * 按 envelope 落点构造一本账的 IO（cli 注入形态；测试直接传闭包）。
 * `cwd` = 建批 header 的工作根（envelope.sandboxRoot 快照），实现方只在
 * 首批建账时消费。
 */
export type WorkerTranscriptIOFactory = (loc: {
  readonly transcriptPath: string;
  readonly taskId: string;
  readonly cwd: string;
}) => WorkerTranscriptIO;

/**
 * ADR-0102 T3 — transcript 接线判定点（一次 await 完成「读账 → 定 prefix →
 * 落 seed 批」）。返回 undefined = 不接线（旧 envelope 无 transcriptPath /
 * 生产入口未注入 IO），调用方走改造前的逐字节旧形态。
 *
 * 两态 prefix：
 *   - absent（新工人）→ envelope prior 段作前缀，seed 批 = [prior 段?, task]
 *     一次落账（loop-engine 的 commit 点只覆盖 run 期新消息，初始 user/
 *     prior 不经 commit，seed 在此补上）；
 *   - present（续跑，ADR-0102 的 continue 臂）→ 盘上 head 链投影作前缀，
 *     seed 批 = 本轮新 user 一句（continue 不重放 prior 段，写处境披露等
 *     已在账上）。
 * IO 抛出的真实故障（io / parse / schema）**原样上抛** —— 损坏的账不能
 * 被读成无账；commit 失败按 loop-engine 契约包 MessageCommitError 中止 run。
 */
async function wireWorkerTranscript(opts: {
  readonly env: WorkerEnvelope;
  readonly deps: LoopEngineDeps;
  readonly ioFactory: WorkerTranscriptIOFactory | undefined;
  readonly segments: ReadonlyArray<AnthropicNativeMessage>;
}): Promise<
  | {
      readonly deps: LoopEngineDeps;
      readonly priorMessages: ReadonlyArray<AnthropicNativeMessage> | undefined;
    }
  | undefined
> {
  const transcriptPath = opts.env.transcriptPath;
  if (transcriptPath === undefined || transcriptPath.length === 0) {
    return undefined;
  }
  if (opts.ioFactory === undefined) {
    // 装配漏接线（测试直调 / 旧 cli）：账不写，任务照跑 —— 与旧形态一致，
    // 但留一行 stderr 观测，不静默丢「该写没写」。
    log(
      "envelope carries transcriptPath but no transcript IO injected; worker transcript disabled"
    );
    return undefined;
  }
  const io = opts.ioFactory({
    transcriptPath,
    taskId: opts.env.taskId ?? "",
    cwd: opts.env.sandboxRoot,
  });
  const encode = opts.deps.adapter.encodeUserText;
  const taskEvent = encode(opts.env.task);
  const baseCommit = opts.deps.commitMessages;
  const deps: LoopEngineDeps = {
    ...opts.deps,
    commitMessages: async (events, thinkingMs) => {
      await io.appendMessages(events, thinkingMs);
      if (baseCommit !== undefined) await baseCommit(events, thinkingMs);
    },
  };
  const loaded = await io.loadMessages();
  if (loaded.status === "present") {
    await io.appendMessages([taskEvent]);
    return { deps, priorMessages: loaded.messages };
  }
  const seed =
    opts.segments.length > 0 ? [...opts.segments, taskEvent] : [taskEvent];
  await io.appendMessages(seed);
  return {
    deps,
    priorMessages: opts.segments.length > 0 ? opts.segments : undefined,
  };
}

/**
 * ADR-0111 不变式 (b) — worker 逃逸 throw 类型 → failed envelope reason 映射
 * SSOT (runWorkerOnce 逃逸 catch 与 runSubagentWorker/cli 最后防线共用, 不分叉)。
 * 子类支 (ModelStreamIncompleteError) 排在 ProtocolError 通用支之前
 * (loop :1912 分支顺序惯例)。
 * undefined = 非结构化失败类 (调用面决定上抛或归 crashed)。
 */
function escapeFailureReason(
  err: unknown
): SubAgentEnvelope["reason"] | undefined {
  if (err instanceof MaxTurnsExceeded) return "maxTurnsExceeded";
  if (err instanceof ModelStreamIncompleteError) return "modelTransient";
  if (err instanceof ProtocolError) return "protocolError";
  return undefined;
}

/**
 * protocolError/emptyFinalResponse 收口派生支 (ADR-0111 Decision 2(a)):
 * RunResult.apiError 在场 ⇔ 带 cause 的瞬时模型流/传输失败 (loop 收口唯一
 * 挂载点是 transportApiErrorOf) → modelTransient; 缺席 = 真协议损坏 →
 * 维持 protocolError。
 */
function stopFailureEnvelope(
  result: import("../model-adapter/types.js").RunResult,
  observability: EnvelopeObservabilityOpts
): SubAgentEnvelope {
  return toFailedEnvelope(
    result.apiError !== undefined ? "modelTransient" : "protocolError",
    "",
    observabilityFields(result, observability)
  );
}

/**
 * 测试 seam (导出仅供测试): envelope → run → truncateEnvelopeResult。
 *
 * 把 readStdin → parseWorkerEnvelope → run → 派生 envelope → 截断这一段
 * 拆出来, 让单测直接调 runWorkerOnce({ workerEnvelope, deps }) 注入 stub
 * deps, 不 spawn 真 worker 子进程 (避免依赖真 LLM key)。
 *
 * 失败路径 (spec SC6 / assumption 16, exit-code 语义成文化于 ADR-0111 不变式 (b)):
 *   - parseWorkerEnvelope 抛 ProtocolError → 不在这里处理 (调用方
 *     runSubagentWorker 让该错误原样上抛 —— exit 2 专码仅属这条信封协议崩溃路径);
 *   - run() 抛 MaxTurnsExceeded → status:failed, reason:maxTurnsExceeded
 *     (plan T3 / ADR-0011: maxTurns 超限 = throw, worker emit failed envelope);
 *   - run() 抛 ModelStreamIncompleteError → status:failed, reason:modelTransient
 *     (ADR-0111 Decision 2(b): 子类支排在 ProtocolError 通用支之前; loop
 *     收口面之外的逃逸防御支);
 *   - run() 抛 ProtocolError → status:failed, reason:protocolError
 *     (harness 模型协议错误, 不是 envelope 协议 —— 区别于 exit 2 路径);
 *   - run() 正常返回 stopReason=protocolError 且 RunResult.apiError 在场
 *     → reason:modelTransient, 缺席 → protocolError (ADR-0111 Decision 2(a),
 *     不变式: apiError 在场 ⇔ 带 cause 的瞬时模型流/传输失败);
 *   - 其他 run() 错误 → 抛出 (runSubagentWorker run 阶段收口 →
 *     best-effort failed envelope + exit 1, 不再冒用 exit 2)。
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
  /**
   * ADR-0102 T3: 工人 transcript IO 注入（生产由 runSubagentWorker 透传
   * cli 传入的真实缝；测试直接注入闭包）。envelope.transcriptPath 缺席时
   * 本参数不被消费 —— 行为与改造前逐字节一致。
   */
  readonly transcriptIo?: WorkerTranscriptIOFactory;
}): Promise<SubAgentEnvelope> {
  const { workerEnvelope: env, deps } = opts;
  const observability: EnvelopeObservabilityOpts =
    opts.writeToolNames !== undefined
      ? { writeToolNames: opts.writeToolNames }
      : {};
  // #358 T2 / D8: 只应用 maxTurns 覆盖, timeoutMs 不进 deps (per-call 语义)。
  const baseRunDeps = applyEnvelopeOverrides(env, deps);
  // #358 T3: SIGTERM → abort("subagent-timeout")。worker 由父 manager per-task
  // 超时计时驱动, 收到 SIGTERM = 任务寿命到点, 走优雅收尾而非立即退出。
  const controller = new AbortController();
  const onSigterm = (): void => controller.abort("subagent-timeout");
  process.once("SIGTERM", onSigterm);
  try {
    // 运行期透传 signal。onStream 不传: (a) text_delta 等热路径事件 worker
    // 无展示消费方; (b) signal 已 abort 时 run() 内部不跑收尾摘要, 不会 emit
    // stop_summary —— 摘要捕获只在下方自跑收尾轮 (runTimeoutEpilogue) 完成。
    const envelopePrior = priorMessagesFromEnvelope(
      env,
      baseRunDeps.adapter.encodeUserText
    );
    // ADR-0102 T3 — 工人账接线（缺席 = 零变化）。
    const wired = await wireWorkerTranscript({
      env,
      deps: baseRunDeps,
      ioFactory: opts.transcriptIo,
      segments: envelopePrior ?? [],
    });
    const runDeps = wired?.deps ?? baseRunDeps;
    const priorMessages = wired ? wired.priorMessages : envelopePrior;
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
      return truncateEnvelopeResult(stopFailureEnvelope(result, observability));
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
    if (result.stopReason === "nonSuccessStop") {
      // EXIT: supplier non-success stop must not report ok
      log(`run() stopReason=nonSuccessStop`);
      return truncateEnvelopeResult(
        toFailedEnvelope(
          "protocolError",
          "nonSuccessStop (e.g. truncation)",
          observabilityFields(result, observability)
        )
      );
    }
    if (result.stopReason === "timeout") {
      // EXIT: per-call race timeout must not report ok
      log(`run() stopReason=timeout`);
      return truncateEnvelopeResult(
        toFailedEnvelope(
          "timeout",
          "per-call model timeout",
          observabilityFields(result, observability)
        )
      );
    }
    return truncateEnvelopeResult(toOkEnvelope(result, observability));
  } catch (err) {
    // 逃逸 throw 类型 → reason 映射走 SSOT (escapeFailureReason)。经 Decision 5
    // 核实: 经 step 的正常路径被 loop 收口、不达此支; 本 catch 服务 loop 收口面
    // 之外的逃逸 (如 epilogue / worker 收尾调用面抛出的本类错误)。
    // unknown 逃逸上抛, 由 runSubagentWorker run 阶段收口
    // (best-effort failed envelope + exit 1, ADR-0111 不变式 (b))。
    const reason = escapeFailureReason(err);
    if (reason === undefined) throw err;
    log(`run() escape ${reason}: ${errorMessage(err)}`);
    return truncateEnvelopeResult(toFailedEnvelope(reason));
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
 * ADR-0111 不变式 (b) — run 阶段逃逸 → failed envelope 派生 SSOT
 * (runSubagentWorker 收口与 cli.ts 最后防线共用同一判据, 不分叉)。
 * 结构化逃逸走 escapeFailureReason; 其余归 crashed (进程以错误结束 =
 * ADR-0111 收窄后的「进程级异常死亡」词汇; 父侧 SC16 对 exit≠0 本就标
 * crashed, 信封派生不与之矛盾)。
 */
export function runEscapeEnvelope(err: unknown): SubAgentEnvelope {
  const reason = escapeFailureReason(err);
  if (reason !== undefined) return toFailedEnvelope(reason);
  return toFailedEnvelope(
    "crashed",
    `subagent worker run-phase error: ${errorMessage(err)}`
  );
}

/**
 * 逃逸错误渲染 (stderr 诊断面): Error 保 stack; plain-object typed error
 * 走 errorMessage SSOT, 不塌缩成 `[object Object]` (code-quality
 * typed-error catch 契约)。
 */
export function renderWorkerError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return errorMessage(err);
}

/**
 * ADR-0111 不变式 (b) — worker exit-code 语义常量 (命名单点, cli.ts 消费;
 * 语义正文见 runSubagentWorker doc, 不在此复述):
 *   - OK(0): 信封已写 stdout (status ok/failed 均是, 结构化失败按 reason 归因);
 *   - RUN_PHASE(1): run 阶段逃逸 → best-effort failed envelope + exit 1;
 *   - ENVELOPE_PROTOCOL(2): 仅信封协议错误 (parseWorkerEnvelope ProtocolError,
 *     无信封可写; assumption 16 / SC13 协议层崩溃专码)。
 */
export const WORKER_EXIT_OK = 0;
export const WORKER_EXIT_RUN_PHASE = 1;
export const WORKER_EXIT_ENVELOPE_PROTOCOL = 2;

/**
 * worker 进程主入口 (cli.ts dispatch):
 *   stdin 一次性读全部 → parseWorkerEnvelope → createWorkerDeps →
 *   runWorkerOnce → stdout newline-JSON → exit 0。
 *
 * exit-code 语义 (ADR-0111 不变式 (b), 成文化 assumption 16 / SC13):
 *   - **exit 2 = 仅信封协议错误** —— parseWorkerEnvelope 抛 ProtocolError
 *     (stdin JSON parse 失败 / WorkerEnvelope 字段缺失) 原样上抛, 无信封
 *     可写, 由调用方 cli.ts 捕获 → `[subagent-worker] fatal` + exit 2;
 *     本函数内 parse 之后不再有任何 ProtocolError 逃逸通道 (run 阶段收口)。
 *   - run 阶段逃逸 (装配 / 收尾 / loop 收口面之外的 typed 逃逸) →
 *     best-effort failed envelope 写 stdout + exit 1, 不再冒用 2。
 *   - exit 0 + failed envelope = run() 派生的结构化失败
 *     (reason ∈ 五值枚举, ADR-0111 Decision 2), 父侧按信封归因。
 */
export async function runSubagentWorker(
  transcriptIo?: WorkerTranscriptIOFactory
): Promise<void> {
  const input = await readStdin();
  const workerEnvelope = parseWorkerEnvelope(input);
  const phase = await runWorkerPhase(workerEnvelope, transcriptIo);
  // stdout 单 wire: 成功与 run 阶段逃逸共用同一落笔点, exit code 由阶段收口决定。
  process.stdout.write(JSON.stringify(phase.envelope) + "\n");
  process.exit(phase.exitCode);
}

/** parse 之后的完整 run 阶段: 错误一律收口为 (envelope, exitCode), 不上抛。 */
async function runWorkerPhase(
  workerEnvelope: WorkerEnvelope,
  transcriptIo?: WorkerTranscriptIOFactory
): Promise<{
  readonly envelope: SubAgentEnvelope;
  readonly exitCode: number;
}> {
  try {
    return {
      envelope: await assembleAndRunWorker(workerEnvelope, transcriptIo),
      exitCode: WORKER_EXIT_OK,
    };
  } catch (err) {
    // run 阶段逃逸: 诊断走 stderr (stdout 是信封协议单 wire), 信封照写, exit 1。
    process.stderr.write(
      `[subagent-worker] run-phase error: ${renderWorkerError(err)}\n`
    );
    return {
      envelope: truncateEnvelopeResult(runEscapeEnvelope(err)),
      exitCode: WORKER_EXIT_RUN_PHASE,
    };
  }
}

/** 装配 → runWorkerOnce (信封 = 返回值的进程级形态)。 */
async function assembleAndRunWorker(
  workerEnvelope: WorkerEnvelope,
  transcriptIo?: WorkerTranscriptIOFactory
): Promise<SubAgentEnvelope> {
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
    // T3 (ADR-0037 §4): 父会话经 IKNOW_PRODUCT_ROOT 传下来的项目身份根。
    // `env.productRoot` 是 env var 那侧的名字（wire 不改），进程内的选项面
    // 叫 `projectIdentityRoot`。缺席（未改绑 / 旧 wire）→ 不传 →
    // createWorkerRuntime 回落 cwd。
    ...(env.productRoot !== undefined
      ? { projectIdentityRoot: env.productRoot }
      : {}),
    // ADR-0092 Amendment 2026-09-13 / SC11:父进程经 IKNOW_FS_MODE 写来的
    // fs 隔离档 → worker 的 bash 工厂 holder。缺席 / 非法 → 键缺席 =
    // 全局档(bash handler 入口缺省回落),legacy 父进程(不写该键)字节不变。
    ...fsModeOptionFromEnv(process.env),
    // issue 1059:父进程 IKNOW_WORKTREE_GATE_ON → 本进程 holder(缺席 = 不发段)。
    ...worktreeGateOptionFromEnv(process.env),
    // T5 (ADR-0071 / SC8 + L2): 父 manager
    // 已经在 spawn 期替这个 taskId 建好 `<父会话文件夹>/subagents/agent-<taskId>.jsonl`,
    // 把 traceFilePath + taskId 经 envelope 透传过来 ——
    // worker 直接 file-mode 落该路径,替代 L2 假 scope `randomUUID()`(已退役)。
    // 缺席(legacy envelope / 跨版本 resume)→ 走 IKNOW_TRACE_OUT 退路(byte-stable)。
    ...(workerEnvelope.traceFilePath !== undefined &&
    workerEnvelope.taskId !== undefined
      ? {
          traceFilePath: workerEnvelope.traceFilePath,
          taskId: workerEnvelope.taskId,
        }
      : {}),
    // ADR-0085 / SC9:父会话账本锚点 —— 父 manager spawn 期已把它算进
    // envelope(projectDir 与主 loop registry 的 todoDir 同源,conversationId
    // = 父会话 id)。worker 据此把 todo_write 挂到父账本上(读 / 更新;
    // 添加由工具 typed 拒绝)。缺席(旧 wire / 跨版本 resume)→ 不传,
    // worker 工具面维持旧形态。
    ...(workerEnvelope.todoLedger !== undefined
      ? { todoLedger: workerEnvelope.todoLedger }
      : {}),
    // T7 (spec SC10):父会话当时完整模型索引快照 —— 在场(含空数组) → worker
    // 的 `<available_skills>` 冻表以它为唯一来源;缺席(旧 wire / 跨版本
    // resume)→ 退回 worker 自己的独立 rescan(byte-stable)。空数组刻意不做
    // 缺席折叠:它是「父确实没有模型索引」的确定事实,见 envelope 字段注释。
    ...(workerEnvelope.skillIndexSnapshot !== undefined
      ? { skillIndexSnapshot: workerEnvelope.skillIndexSnapshot }
      : {}),
  });
  // D-α 观测地板: fileRefs 的派生源 = 本 worker 实际装配出的 ACI catalog
  // 里 category:"write" 的工具名 (def-list 期裁剪后的真实工具面)。
  return runWorkerOnce({
    workerEnvelope,
    deps,
    writeToolNames: writeToolNamesFrom(catalog),
    transcriptIo,
  });
}
