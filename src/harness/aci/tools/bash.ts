import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { isDangerousCommand } from "../permission.js";
import { commandContainsSensitivePath } from "../../permission/hard-walls.js";
import { validateReadonlyCommand } from "./bash-readonly.js";
import {
  BASE_ENV_WHITELIST,
  applyCwdReadonlyFenceEnv,
  createBwrapFence,
  createEgressApprovalGate,
  createEgressSession,
  createEnvIsolation,
  createFsPolicy,
  createOutputMask,
  currentSecretValues,
  renderEgressFailureMessage,
  EgressRelayUnavailableError,
  type AskApproval,
  type BwrapFenceOptions,
  type EgressApprovalGate,
  type EgressPolicyInput,
  type EgressSession,
  type EgressViolation,
} from "../../sandbox/index.js";
import {
  FS_ISOLATION_MODE_DEFAULT,
  type FsIsolationMode,
  type FsModeContext,
} from "../../sandbox/fs-mode.js";
import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  requireBwrap,
  runInSandbox,
} from "../../sandbox/runner.js";
import { restore, type SecretRegistry } from "../../secret-roundtrip/index.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import type { LiveTaskRoot } from "../../session-roots.js";
import { resolveSessionFenceTmp } from "../../sandbox/fence-tmp.js";
import { FENCE_WRITE_GUIDANCE, resolveWithinRoot } from "./helpers.js";
import { extractSingleReadPath } from "./bash-read-extract.js";
import type { LastReadLedgerHost } from "../last-read-ledger.js";

interface BashInput {
  readonly command?: unknown;
  /** #502 T3:background?: boolean — 缺省 false = 前台（既有路径）。 */
  readonly background?: unknown;
}

export interface CreateBashToolOptions {
  /** #406 T3:per-engine secret registry。在场时 handler 在构造 bwrap fence 前
   *  对命令做占位符还原（`<<<SECRET_N>>>` → 真值）；缺席时命令原样透传。 */
  readonly secretRegistry?: SecretRegistry;
  /** #502 T3:后台任务管理器。在场时 `background: true` 分支可用 —— handler
   *  经 manager.spawn 起 detached 子进程后立即返回 {task_id, log_path}，不
   *  阻塞、不占 tier timer（handler 毫秒级返回 ⇒ executor tier 天然不治理
   *  后台 daemon）。缺省时 `background: true` → ToolExecutionError（fail-fast，
   *  不静默退化成前台 —— 长驻进程退化成前台会被 build tier 杀），前台路径
   *  完全不受影响。生产装配 build-engine 注入 createBackgroundTaskManager +
   *  defaultBackgroundSpawn。 */
  readonly backgroundManager?: BackgroundTaskManager;
  /** #562 T4:bash 模式 —— "readonly" 时 handler 在 isDangerousCommand 之后、
   * commandContainsSensitivePath 之前调 validateReadonlyCommand，越界命令
   * 抛 ReadonlyViolationError（extends ToolExecutionError）。缺省 "any" =
   * V1 路径逐字节不变（回归基线）。 */
  readonly bashMode?: "any" | "readonly";
  /** #562 T5:fence cwd 级只读控制 —— true 时 fence 把 cwd bind 为 --ro-bind,
   * 同时把 GIT_OPTIONAL_LOCKS=0 注入 fence env（git ≥2.14 防 `git status` 刷
   * index）。缺省 / false = 既有可写 cwd。 */
  readonly cwdReadonly?: boolean;
  /** T7 (plans/worktree-live-task-root.md §6): per-call live root cell. 在场
   * 时 handler 入口读一次冻结为 waveRoot（D2 batch snapshot），前台 /
   * background 共用同一份。缺省时退回工厂捕获 cwd。 */
  readonly liveTaskRoot?: LiveTaskRoot;
  /**
   * ADR-0092: this identity's session tmp host path. Tests inject
   * `<sessionFolder>/fence-tmp`. When omitted, per-call resolution uses
   * `projectDir` + `conversationId`, else a factory-lifetime fallback tmp.
   * It feeds `$TMPDIR` — it is never a bind target for guest `/tmp`.
   *
   * ADR-0084 asymmetry (legacy direct-factory shape only): when neither
   * `tmpDir` nor `projectDir` is given, bash allocates a fresh
   * `mkdtempSync` pad here, while `write_file`'s `resolveSessionFenceTmp`
   * returns `undefined` for the same inputs. A ledger key recorded for
   * `cat /tmp/x` therefore names a path `write_file` never resolves —
   * a dead key, so the later non-empty overwrite is refused (fail-closed,
   * the safe direction). Production assembly passes both tools the same
   * `tmpDir` / `projectDir` values, which is why this is not plumbed here;
   * tests that need the shared pad must inject `tmpDir` explicitly on both
   * sides.
   */
  readonly tmpDir?: string;
  /**
   * Session project dir (`resolveProjectSessionDir` output). With
   * `ctx.conversationId`, bash uses `<sessionFolder>/fence-tmp` as `$TMPDIR`.
   */
  readonly projectDir?: string;
  /**
   * ADR-0084 / D1: last-read ledger host. Present → a foreground command that
   * is exactly one whitelisted single-file read (exit 0) records the resolved
   * canonical path, so a later non-empty `write_file` on it passes the
   * freshness gate. Absent → nothing is recorded (legacy callers); reads stay
   * executable either way — only the ledger entry is optional.
   */
  readonly lastReadLedger?: LastReadLedgerHost;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC11/SC12:fs 隔离档 holder(详见
   * `sandbox/fs-mode.ts`)。handler 入口 per-call `fsMode?.get() ?? "global"`
   * 读一次,与 `liveTaskRoot` 的 D2 batch snapshot 纪律同款;前台 fence 与后台
   * spawn 共用同一份冻结值。缺省 → 全局档(V1 baseline 不变)。
   */
  readonly fsMode?: FsModeContext;
  /**
   * ADR-0092 Amendment 2026-09-13 / SC11:工作区档 home ro-bind 源端宿主绝对
   * 路径。缺省 `homedir()` —— 与 `tmpDir` 注入同形态(测试可注入)。生产装配
   * build-engine 透传 userHome / worker 透传 sessionRoots 的对应字段。
   */
  readonly homeRoot?: string;
  /**
   * ADR-0097 / T4:出口代理缝装配 —— 由调用面注入判定器输入(从 settings
   * `isolation.network` 读),handler 在 fence 装配期起 per-call egress
   * session,然后在 finally 释放。**缺省** = 不起 egress session(fence
   * 仍走 `--unshare-net`,等同纯断网)。生产装配在 build-engine 层注入,
   * 测试可注入 fake 工厂。
   *
   * 工厂形态而非 session 实例:per-call 装配,handler 内建 session,
   * 然后 `finally { await session.dispose() }`。start 失败(EgressRelayUnavailableError
   * 等)→ 按 spec「fail-closed 不静默降级」,本仓 expand 阶段接线为:本
   * 次调用无 egress 缝(沙箱内无代理 env、`--unshare-net` 照旧在,等同
   * 纯断网)+ typed failure 让模型 / TUI 可见 —— 不静默降级。
   */
  readonly egressPolicyFactory?: () => EgressPolicyInput | undefined;
  /**
   * T5 测试 seam:注入 `createEgressSession` 工厂，让 tier 1→mid 端到端
   * 测试可在不真起中继 / proxy 的前提下模拟「违例被记录 → drain → typed
   * failure」路径。生产装配**不传**(走默认 createEgressSession)。
   *
   * why 需要:bash handler 直接 import 真实 `createEgressSession`,而真
   * 真 http-proxy 需要 unix socket 资源与监听权限,CI 上未必具备。让测试
   * 在 stub session 里 record 一条违例 →
   * 直接走 drain → typed failure 全管线,验证「message 从 handler 流到
   * categorizeResult」不假绿。
   */
  readonly createEgressSessionFactory?: typeof createEgressSession;
  /**
   * T6:首次域名批准流的 ask inlet —— 把既有 `AskUser` 转写为
   * `(host) => Promise<boolean>`,在 bash tool 工厂闭包期构造一个
   * `EgressApprovalGate`,跨调用共享同一会话级 allowed/denied 集 +
   * in-flight 合并表。
   *
   * 缺省 = 无 ask 面,首次见到新域名直接记 `no-approval-inlet` 违例
   * (spec §Failure paths「非交互入口首见新域名」fail-closed)。
   *
   * 装配链:build-engine 层持有既有 `AskUser`,在 createBashTool 处
   * 包成 `askApproval`,再透传给本 opts(参考 plans/ bash 装配纪律)。
   * 测试可注入 fake `(host) => Boolean`。
   */
  readonly askApproval?: AskApproval;
}

/**
 * ADR-0092 Round 2(与 `liveTaskRoot` 的 D2 batch snapshot 同款纪律):fs 隔离档
 * holder 与 homeRoot 在 handler 入口读一次冻结 —— 前台 fence / background
 * spawn 共用同一份,handler 内 holder 后续翻转不渗透进本次调用。
 *
 * holder 缺席 → 全局档(V1 baseline 不变);homeRoot 缺席 → `homedir()`
 * (与 opts 注入同形态,测试可注入)。落到非空值是有意的:工作区档下空
 * homeRoot 在 bwrap 层是 typed fail-loud(不得静默退化成全局档),这里
 * 给出与生产装配同值的缺省,使该守卫只在装配真漏传时触发。
 */
function snapshotFenceInputs(opts: CreateBashToolOptions | undefined): {
  readonly mode: FsIsolationMode;
  readonly homeRoot: string;
} {
  return {
    mode: opts?.fsMode?.get() ?? FS_ISOLATION_MODE_DEFAULT,
    homeRoot: opts?.homeRoot ?? homedir(),
  };
}

/**
 * D2 batch snapshot 的 fence 输入(handler 入口冻结):fs 档 holder / homeRoot /
 * tmpDir 同 vintage —— 前台 fence 与后台 spawn 共用同一份,handler 内 holder
 * 或 cell 后续翻转不渗透进本次调用。
 */
interface FenceSnapshot {
  readonly mode: FsIsolationMode;
  readonly homeRoot: string;
  readonly tmpDir: string;
}

/**
 * ADR-0092 Round 2 / SC11/SC12:工作区档 fence 三层(home ro-bind + 两处写
 * 白名单)的源端绝对路径。global 档返回空展开 —— bwrap 侧不发射任何一层,
 * argv 与 V1 baseline 逐字节一致。
 */
function fenceWorkspaceMounts(
  mode: FsIsolationMode,
  homeRoot: string,
  workspaceRoot: string,
  tmpRoot: string
): Pick<BwrapFenceOptions, "homeRoot" | "workspaceRoot" | "tmpRoot"> {
  return mode === "workspace" ? { homeRoot, workspaceRoot, tmpRoot } : {};
}

/**
 * ADR-0097 / T5:前台 bash 调用的 egress 装配 + 执行 + 回灌整段——独立于
 * handler（S5 complexity 门）。顺序即 T1 契约「起桥 → 绑 → 注入 → 收尾」：
 * fence 装配前起 per-call session；dispose 在 finally（异常路径与正常路径
 * 同一释放通道）；违例 drain 走 typed failure 路径（第 3 跳「前缀与 tier
 * 入口」，spec §Violation feedback channel）。
 *
 * T5 升级：drain 非空或 egressStartError 在场 → 不再 ok + stderr 旁路，
 * 改抛 `ToolExecutionError(message)`（typed）；executor 经
 * `buildFailureResult` 包成 `kind: "execution_failed"`、`message` 经
 * `categorizeResult` 命中 `[network_denied]` 前缀 → mid tier（不修改
 * violation-handling.ts，挂点 `:139` 自动接通）。drain 空且无 startError
 * → 维持 V1 ok 形状（byte-identical 于 T4 前）。
 */
async function runForegroundBash(
  args: RunForegroundBashArgs
): Promise<unknown> {
  const {
    finalCommand,
    command,
    waveRoot,
    fsMode,
    homeRoot,
    tmpDir,
    fsPolicy,
    fenceEnv,
    fenceIsReadonly,
    effectiveEgressPolicyFactory,
    toolOpts: opts,
    ctx,
  } = args;
  // 起 session → 起 fence → 跑 sandbox → 装 mask → 入账 → finalize
  // 6 步，每步都是 S5 抽离后的子函数；本函数只承担「按顺序编排」。
  const egress = await startEgressSessionForCall(
    effectiveEgressPolicyFactory,
    opts?.createEgressSessionFactory
  );
  const fence = buildForegroundFence({
    finalCommand,
    fsPolicy,
    fenceEnv,
    waveRoot,
    fenceIsReadonly,
    fsMode,
    homeRoot,
    tmpDir,
    egressSession: egress.session,
  });
  const result = await runSandboxDisposingEgress(
    {
      fence,
      cwd: waveRoot,
      signal: ctx?.signal,
      env: fenceEnv,
      maxOutputCodePoints: DEFAULT_MAX_OUTPUT_CODE_POINTS,
    },
    egress.session
  );
  const mask = buildOutputMask(opts);
  await recordForegroundRead(opts, ctx, {
    command,
    exitCode: result.exitCode,
    waveRoot,
    tmpDir,
  });
  const finalPath = await finalizeEgressPath({
    egressSession: egress.session,
    egressStartError: egress.startError,
    egressInfraHint: egress.infraHint,
    egressPolicyInput: egress.policyInput,
    result,
    mask,
  });
  if (finalPath.kind === "throw") throw finalPath.throwError;
  return finalPath.envelope;
}

/**
 * `runForegroundBash` 的入参类型（拆出以控制该函数行数 ≤ 60 —— S5 软门）。
 */
interface RunForegroundBashArgs {
  finalCommand: string;
  command: string;
  waveRoot: string;
  fsMode: FsIsolationMode;
  homeRoot: string;
  tmpDir: string;
  fsPolicy: ReturnType<typeof createFsPolicy>;
  fenceEnv: Record<string, string>;
  fenceIsReadonly: boolean;
  /**
   * T6:工厂闭包期包装出的 `egressPolicyFactory`(自动注入 `approvalGate` +
   * allowlistSource fallback 为 "session")。缺席 → handler 不起 session,
   * V1 baseline 不变。
   */
  effectiveEgressPolicyFactory:
    (() => EgressPolicyInput | undefined) | undefined;
  // 完整 opts 透传（lastReadLedger 等记录面在 runForegroundBash 内消费），
  // 不拆散 —— 新增记录面时这里不再逐字段搬运。
  toolOpts: CreateBashToolOptions | undefined;
  ctx?: ToolExecutionContext;
}

/**
 * 前台 bwrap fence 构造 —— 把 `bash -c finalCommand` + fs policy + env +
 * cwd + workspace mounts + 可选 egress spec 拼成一个 fence。
 *
 * 抽离以控制 `runForegroundBash` 复杂度（S5 门）。workspaceMounts 与
 * egress 字段的填充规则见其注释；本函数仅做组装，不引入逻辑。
 *
 * egress-ssh-bridge T1（ADR-0107 换装）：egress 在场时命令链前导
 * `spec.innerBridgeScript`（沙箱内自带 node 中继监听 127.0.0.1:3128 →
 * unix socket + trap 收尾，形态见
 * session.ts `buildInnerBridgeScript`）——代理 env 指到的是沙箱内这个监听，
 * 没有前导则整条缝只有宿主半场（O3）。无 egress = payload 逐字节不变
 * （byte-identical 回归基线，invariant 3「无缝 = 无桥」）。
 */
function buildForegroundFence(args: {
  readonly finalCommand: string;
  readonly fsPolicy: ReturnType<typeof createFsPolicy>;
  readonly fenceEnv: Record<string, string>;
  readonly waveRoot: string;
  readonly fenceIsReadonly: boolean;
  readonly fsMode: FsIsolationMode;
  readonly homeRoot: string;
  readonly tmpDir: string;
  readonly egressSession: EgressSession | undefined;
}): ReturnType<typeof createBwrapFence> {
  const payload =
    args.egressSession !== undefined
      ? `${args.egressSession.spec.innerBridgeScript}\n${args.finalCommand}`
      : args.finalCommand;
  return createBwrapFence({
    command: "bash",
    args: ["-c", payload],
    fsPolicy: args.fsPolicy,
    env: args.fenceEnv,
    cwd: args.waveRoot,
    ...(args.fenceIsReadonly ? { cwdReadonly: true } : {}),
    // ADR-0092 Round 2 / SC11/SC12:工作区档 fence 三层(host root + 系统
    // 前缀 + home ro-bind + 两处写白名单)的源端绝对路径。global 档下
    // `fsPolicy.mode === "global"`,bwrap 内部自动不发射,与 V1 baseline
    // 逐字节一致。
    ...fenceWorkspaceMounts(
      args.fsMode,
      args.homeRoot,
      args.waveRoot,
      args.tmpDir
    ),
    ...(args.egressSession !== undefined
      ? { egress: args.egressSession.spec }
      : {}),
  });
}

/**
 * #406 T3:输出遮罩构造 —— handler return 前对 stdout / stderr 洗一遍。
 *
 * mask 构造在每次调用内现取（registry 值可跨 turn 变化；不模块级
 * 缓存）。缺席 secretRegistry → 不构造 mask（plan 验收 #2；不扩展
 * 「缺席仍用 env 三源 mask」）。截断权威在 executor，mask 在 truncation
 * 之后跑 —— 遮的是已截断的真值，最大遮蔽窗口。
 *
 * 独立成函数（S5 complexity 门）。
 */
function buildOutputMask(
  opts: CreateBashToolOptions | undefined
): ReturnType<typeof createOutputMask> | undefined {
  if (opts?.secretRegistry === undefined) return undefined;
  return createOutputMask(
    currentSecretValues(process.env, opts.secretRegistry.values())
  );
}

/**
 * ADR-0084 / D1:前台 fence 完成后入账「恰好读了单文件」的成功命令。
 *
 * 抽离以控制 `runForegroundBash` 复杂度（S5 门）。wrap 关系是「前台专用
 * 入口 → recordCompletedRead」：前台调用方只读一次 exit code 与 waveRoot
 * + tmpDir,薄层把它们传给既有 recordCompletedRead;不做额外逻辑。
 */
async function recordForegroundRead(
  opts: CreateBashToolOptions | undefined,
  ctx: ToolExecutionContext | undefined,
  args: {
    readonly command: string;
    readonly exitCode: number;
    readonly waveRoot: string;
    readonly tmpDir: string;
  }
): Promise<void> {
  await recordCompletedRead(opts, ctx, {
    command: args.command,
    exitCode: args.exitCode,
    root: args.waveRoot,
    sessionTmpRoot: args.tmpDir,
  });
}

/**
 * T5:违例 drain + egressStartError 检查 → typed failure / V1 ok 决策点。
 * 抽离以控制 `runForegroundBash` 复杂度(S5 门)。逻辑：
 *   - drain 非空或 startError 在场 → 拼 typed failure message 并抛
 *     `ToolExecutionError`;
 *   - 否则走 V1 ok 形状(assembleBashToolResult,byte-identical 于 T4 前)。
 *
 * 独立成函数(S5 complexity 门)。
 */
async function finalizeEgressPath(args: {
  readonly egressSession: EgressSession | undefined;
  readonly egressStartError: string | undefined;
  readonly egressInfraHint: string | undefined;
  readonly egressPolicyInput: EgressPolicyInput | undefined;
  readonly result: Awaited<ReturnType<typeof runInSandbox>>;
  readonly mask: ReturnType<typeof createOutputMask> | undefined;
}): Promise<
  | { readonly kind: "throw"; readonly throwError: ToolExecutionError }
  | {
      readonly kind: "ok";
      readonly envelope: {
        output: string;
        meta: { stdout: string; stderr: string };
      };
    }
> {
  const {
    egressSession,
    egressStartError,
    egressInfraHint,
    egressPolicyInput,
    result,
    mask,
  } = args;
  const violations =
    egressSession !== undefined ? egressSession.violationSink.drain() : [];
  if (violations.length > 0 || egressStartError !== undefined) {
    const throwError = composeEgressFailure({
      violations,
      startError: egressStartError,
      ...(egressInfraHint !== undefined ? { infraHint: egressInfraHint } : {}),
      ...(egressPolicyInput?.allowlistSource !== undefined
        ? { allowlistSource: egressPolicyInput.allowlistSource }
        : {}),
    });
    return { kind: "throw", throwError };
  }
  return {
    kind: "ok",
    envelope: assembleBashToolResult(result, mask),
  };
}

/**
 * egress session per-call 装配 —— fence 装配前起 session；失败路径
 * （EgressRelayUnavailableError 等）→ 本次调用无 egress 缝（沙箱内无代理 env、
 * `--unshare-net` 照旧在，等同纯断网）+ 失败文案由调用方进 typed
 * failure 让模型/TUI 可见（T5 起不再走 stderr 旁路）。
 *
 * 透传 policyInput：调用方在 typed failure 阶段读
 * `policyInput.allowlistSource` 拼「当前允许集来源」标注。session 内部
 * 不持有 policy 的额外引用（已在 filter 闭包里），故由 caller 端缓存。
 *
 * typed-error catch 契约（code-quality.md）：先识别判别联合的具体类型，
 * 对 EgressRelayUnavailableError 这种携带 detail + remediationHint 的
 * typed 错误直接构造结构化 `startError`；未知错误走兜底形态但保留「unknown
 * cause」标注，避免 plain object 在 `String(err)` 下打成 `[object Object]`
 * 让 `kind` / `installHint` 全部不可见。`infraHint` 由 typed-error
 * 派生并透传给 composeEgressFailure，让 typed failure message 渲染出
 * 「装哪个 + 怎么装」（spec §三类信号 + SC13 验收）。
 *
 * 独立成函数（S5 complexity 门）。
 */
async function startEgressSessionForCall(
  egressPolicyFactory: (() => EgressPolicyInput | undefined) | undefined,
  createEgressSessionFn: typeof createEgressSession = createEgressSession
): Promise<{
  session?: EgressSession;
  startError?: string;
  infraHint?: string;
  policyInput?: EgressPolicyInput;
}> {
  const policyInput = egressPolicyFactory?.();
  if (policyInput === undefined) return {};
  try {
    // fail-closed 语义由 session 内部保证；这里只捕获启动失败 → 无缝 + 留痕。
    const session = await createEgressSessionFn({ policy: policyInput });
    return { session, policyInput };
  } catch (err) {
    if (err instanceof EgressRelayUnavailableError) {
      // typed-error 分支：EgressRelayUnavailableError 携带 detail +
      // remediationHint（本产品依赖指引，ADR-0107），用 err.message 作
      // 结构化 startError；透传给 composeEgressFailure →
      // renderEgressFailureMessage，让 typed failure message 里出现
      // 「缺哪个产品依赖 + 怎么修」(SC13 验收 + typed-error catch 契约)。
      return {
        startError: err.message,
        infraHint: err.message,
        policyInput,
      };
    }
    // 兜底：未知错误保留 unknown cause 标注,不让 caller 把 plain object
    // 当 [object Object] 渲染(code-quality.md typed-error catch 契约)。
    // 把 err.message / String(err) 兜底放进 startError 时**显式标注**
    // unknown cause 防止与 typed 路径混淆。
    const fallback = err instanceof Error ? err.message : String(err);
    return {
      startError: `egress seam unavailable (unknown cause): ${fallback}`,
      infraHint: `egress seam unavailable (unknown cause): ${fallback}`,
      policyInput,
    };
  }
}

/**
 * 拼 typed failure message —— drain 非空或 egressStartError 在场时调用。
 *
 * - drain 非空：走 `renderEgressFailureMessage`（typed failure 文案，含
 *   `[network_denied]` 前缀 + 每条一行 + 共享补配指引 + 「命令已跑完」
 *   语义；infra / 域判定绝不混排同一段）。
 * - egressStartError 在场且 drain 空：把中继依赖缺失/装配失败文案拼成
 *   typed failure（带 `[network_denied]` 前缀 + 「egress seam unavailable」
 *   语义），同时合成一条 `infra-unavailable` violation 走同一渲染管线，
 *   文案一致性归一。**不**给配置键指引（infra ≠ 域判定拒绝）。
 *
 * 返回 `ToolExecutionError`（typed），抛给 executor 走
 * `buildFailureResult` → `execution_failed`。
 *
 * 独立成函数（S5 complexity 门）。
 */
function composeEgressFailure(args: {
  readonly violations: readonly EgressViolation[];
  readonly startError?: string;
  readonly infraHint?: string;
  readonly allowlistSource?: EgressPolicyInput["allowlistSource"];
}): ToolExecutionError {
  const { violations, startError, infraHint, allowlistSource } = args;
  // startError 在场但 drain 空 → 合成 infra-unavailable violation，让
  // 渲染管线统一处理（文案一致 + infra/域判定分离逻辑自动套用）。
  const effectiveViolations: EgressViolation[] =
    violations.length > 0
      ? [...violations]
      : startError !== undefined
        ? [
            {
              kind: "egress_violation",
              host: "egress-seam",
              port: 0,
              reason: "infra-unavailable",
              command: "(egress session startup)",
            },
          ]
        : [];
  const message = renderEgressFailureMessage({
    violations: effectiveViolations,
    ...(infraHint !== undefined ? { infraHint } : {}),
    ...(allowlistSource !== undefined ? { allowlistSource } : {}),
  });
  return new ToolExecutionError(message);
}

/**
 * runInSandbox + per-call egress session finally 释放——与正常路径同一
 * 通道（spec §Ownership / dispose contract 钉死的「异常路径与正常路径
 * 同一释放通道」）。dispose 幂等，重复调用安全。独立成函数（S5 门）。
 */
async function runSandboxDisposingEgress(
  runArgs: Parameters<typeof runInSandbox>[0],
  egressSession: EgressSession | undefined
): Promise<Awaited<ReturnType<typeof runInSandbox>>> {
  try {
    return await runInSandbox(runArgs);
  } finally {
    if (egressSession !== undefined) {
      try {
        await egressSession.dispose();
      } catch {
        // best-effort:dispose 异常不污染主调用方控制流。
      }
    }
  }
}

/**
 * 组装 bash tool 返回形状 —— {code, stdout, stderr} JSON + meta 旁路。
 *
 * T5 收紧：违例 / egressStartError 不再进 stderr 旁路（已转 typed failure
 * 在更上游抛走）。本函数现在只承载 V1 ok 形状 —— 与 T4 前的 byte-identical
 * 路径在同一分支。独立成函数（S5 门）。
 */
function assembleBashToolResult(
  result: Awaited<ReturnType<typeof runInSandbox>>,
  mask: ReturnType<typeof createOutputMask> | undefined
): { output: string; meta: { stdout: string; stderr: string } } {
  const stdout = mask ? mask.mask(result.stdout) : result.stdout;
  const stderr = mask ? mask.mask(result.stderr) : result.stderr;
  return {
    output: JSON.stringify({
      code: result.exitCode,
      stdout,
      stderr,
    }),
    // #693 T4 D4:bash stdout/stderr 走观测旁路(meta),TUI 从旁路取数显示
    // 5 行尾部预览（不经 encodeToolResults 进模型 tool_result，模型视野
    // 仅见 output 字段里 JSON 化的 code/stdout/stderr —— 形状不变）。
    meta: {
      stdout,
      stderr,
    },
  };
}

export function createBashTool(
  cwd: string,
  opts?: CreateBashToolOptions
): AciToolDef {
  requireBwrap();
  // ADR-0092 (D3): 工厂期只捕获 `tmpDir`（process-stable）。fsPolicy 由
  // handler per-call 重建,不闭包到工厂捕获的 cwd。
  let fallbackFenceTmp: string | undefined;
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
  // T6:首次域名批准流的会话级门件 —— 工厂闭包期构造一次,跨调用共享同一
  // allowed/denied 集 + in-flight 合并表。askApproval 缺席 → 门件内部
  // 走 fail-closed(spec §Failure paths「非交互入口首见新域名」),任何
  // 首次见到的新 host 直接 deny,违例 reason `no-approval-inlet`。
  // 注意:即便 gate 在场,「批准后是否落到持久层 settings」留 TODO(ADR-
  // 0097 §批准持久化粒度 写回 API 若有则调用,本任务未做)。
  const approvalGate: EgressApprovalGate | undefined =
    opts?.askApproval !== undefined
      ? createEgressApprovalGate({ askApproval: opts.askApproval })
      : undefined;
  // 包装 egressPolicyFactory —— 每调用返回的 policy 都会注入
  // `approvalGate`(若 gate 在场)。把 gate 注入放在 bash 工厂侧而不是
  // 调用面,保证「egressPolicyFactory 提供数据、bash 工厂注入门件」的关
  // 注点分离,egress 域不反向依赖 permission AskUser 装配。
  // 「批准成功后 allowlistSource 标注为 session」:bash 装配层把 gate 的
  // allowedThisSession 视为 session 级(批准 = 用户交互颁发的会话级放行),
  // 当 caller 没显式设 allowlistSource 时,fallback 为 "session" 以
  // 渲染「Current allowlist source: session-level allowlist」。
  const wrappedEgressPolicyFactory:
    (() => EgressPolicyInput | undefined) | undefined =
    opts?.egressPolicyFactory !== undefined
      ? () => {
          const pi = opts.egressPolicyFactory?.();
          if (pi === undefined) return undefined;
          if (approvalGate === undefined) return pi;
          if (pi.allowlistSource !== undefined) return pi;
          return { ...pi, allowlistSource: "session" as const };
        }
      : undefined;
  // 同一份 gate 也注入到 policy(由 session 装配期 filter 消费)。再次折
  // 射:在 policy 上 attach gate,egress 域按 host 决策。
  const effectiveEgressPolicyFactory:
    (() => EgressPolicyInput | undefined) | undefined =
    wrappedEgressPolicyFactory !== undefined && approvalGate !== undefined
      ? () => {
          const pi = wrappedEgressPolicyFactory();
          if (pi === undefined) return undefined;
          return { ...pi, approvalGate };
        }
      : wrappedEgressPolicyFactory;
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<unknown> => {
    const command = (input as BashInput | null)?.command;
    if (typeof command !== "string" || command.length === 0)
      throw new ToolExecutionError("bash: command must be a non-empty string");
    if (isDangerousCommand(command))
      throw new ToolExecutionError(
        `bash: dangerous command rejected: ${command}`
      );
    // #562 T4:bashMode="readonly" → enforce read-only command policy.
    // 缺省 ("any") → 此分支不进入，handler 逐字节不变（V1 回归基线）。
    // validateReadonlyCommand 抛 ReadonlyViolationError（extends
    // ToolExecutionError），executor 经既有 ToolExecutionError 路径捕获。
    if (opts?.bashMode === "readonly") {
      validateReadonlyCommand(command);
    }
    if (commandContainsSensitivePath(command))
      throw new ToolExecutionError(
        `bash: command targets a sensitive path: ${command}`
      );
    // T7 (D2): per-handler batch snapshot. cell 在入口读一次冻结为 waveRoot,
    // 贯穿整条路径（前台 fence / background spawn 拿同一份）—— handler 内
    // 后续 cell 翻转不渗透进本次调用。liveTaskRoot 缺席 → 退到工厂捕获 cwd
    // （legacy parity:无 cell 时 byte-identical 于 V1）。
    const waveRoot: string = opts?.liveTaskRoot
      ? opts.liveTaskRoot.read()
      : cwd;
    const { mode: fsMode, homeRoot } = snapshotFenceInputs(opts);
    const tmpDir = resolveBashFenceTmp(opts, ctx?.conversationId, () => {
      if (fallbackFenceTmp === undefined) {
        fallbackFenceTmp = mkdtempSync(join(tmpdir(), "iknow-fence-tmp-"));
      }
      return fallbackFenceTmp;
    });
    // #502 T3:校验链通过后才决定前台 / 后台 —— 危险命令 / 敏感路径在两侧
    // 都先执行同一闸门（background 不豁免安全检查）。
    if ((input as BashInput | null)?.background === true) {
      // ADR-0097:background spawn 与前台共用同一 fence 构造缝(沙箱纪律 G3):
      // `--unshare-net` 恒在,出网能力同样只经 egress 缝。
      // #502 review-repair（#406 roundtrip）:recordCommand 传原始占位符形态
      // input.command（占位符落盘）,command 传还原后真值（spawn 执行用,不上盘）。
      const bgCommand = opts?.secretRegistry
        ? restore(command, opts.secretRegistry)
        : command;
      // T7 (D2): background path 与 foreground path 共用同一份 waveRoot。
      // handleBackground 把 waveRoot 转给 manager.spawn → defaultBackgroundSpawn
      // 内的 createFsPolicy / createBwrapFence 也围绕 waveRoot 构造 fence。
      // ADR-0092 Round 2:fence snapshot (已冻结) 透传 BackgroundSpawnRequest
      // —— 前台 / 后台 fence 在 fs 档轴上集合相等（沙箱纪律 G3）。
      return await handleBackground(
        {
          finalCommand: bgCommand,
          recordCommand: command,
          cwd: waveRoot,
        },
        opts ?? {},
        ctx,
        { mode: fsMode, homeRoot, tmpDir },
        effectiveEgressPolicyFactory
      );
    }
    // #562 T6: bashMode="readonly" 派生 cwdReadonly:true 传给 fence + env。
    // bashMode→cwdReadonly 映射由 T6 在此装配完成 (registry 只透传 bashMode,
    // 不读 catalog)。cwdReadonly 显式 true / bashMode==="readonly" 任一即触发。
    // 缺省 "any" / undefined → 不传 cwdReadonly, T5 argv baseline 不破。
    const fenceIsReadonly =
      opts?.cwdReadonly === true || opts?.bashMode === "readonly";
    const fenceEnv = {
      ...applyCwdReadonlyFenceEnv(
        envIsolation.filter(process.env),
        fenceIsReadonly
      ),
      // ADR-0092: the session tmp host path is the draft location; guest Linux
      // `/tmp` is never bound to it, so `$TMPDIR` names the real path.
      TMPDIR: tmpDir,
    };
    // #406 T3:构造 fence 前还原占位符 —— 还原后的命令才是真正 spawn 进 bwrap
    // 的文本。原始命令（含占位符）只见于工具调用记录 / 模型上下文；模型永不
    // 见还原后的命令，只看到 bash 输出的 stdout。
    const finalCommand = opts?.secretRegistry
      ? restore(command, opts.secretRegistry)
      : command;
    // T7 (D4): fsPolicy per-call rebuild —— `tmpDir` 工厂期冻结,只有 cwd
    // 维度跟 waveRoot 联动。Round 2:policy 携带 fs 档(mode 字段),bwrap 据
    // 此在工作区档 argv 叠三层(ADR-0092 Amendment)。handler 入口 fsMode
    // 已 D2 snapshot,此处直接消费。
    const fsPolicy = createFsPolicy({ tmpDir, mode: fsMode });
    return runForegroundBash({
      finalCommand,
      command,
      waveRoot,
      fsMode,
      homeRoot,
      tmpDir,
      fsPolicy,
      fenceEnv,
      fenceIsReadonly,
      effectiveEgressPolicyFactory,
      toolOpts: opts,
      ctx,
    });
  };
  return Object.freeze({
    name: "bash",
    description:
      "Run shell commands inside the bwrap sandbox for builds, scripts, or one-shot operations without a dedicated tool; pair with read_file / grep / glob / edit_file / write_file for file work inside the fence. Returns {code, stdout, stderr}; stdout/stderr truncated at 12000 code points per stream. Hard-walls reject obvious destructive patterns and sensitive-path targets before spawn; non-hard-wall commands go through the normal permission flow. For long-running services (http servers, daemons, continuous watchers), set background: true — the call returns {task_id, log_path} immediately and the process keeps running beyond the call, outside the build-tier timeout; then read the log tail with bash_output(task_id, max_bytes?) (default 12 KB, cap 100 KB) and terminate the process group with bash_stop(task_id) (SIGTERM, 2-second grace, then SIGKILL; idempotent). Network egress leaves the fence only through the egress proxy seam: allowed domains pass, everything else is denied with [network_denied], and --unshare-net is always in effect. " +
      FENCE_WRITE_GUIDANCE,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: {
          type: "boolean",
          description:
            "When true, run the command in the background: returns {task_id, log_path} immediately and the process keeps running after the call, managed by the task registry. Use for long-lived servers or daemons; pair with bash_output (read the log) and bash_stop (terminate). Defaults to false (foreground).",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "build" as const,
    },
  });
}

/**
 * background 分支的逐调用输入(#406 roundtrip secret 还原契约):
 * `recordCommand` 是原始占位符形态(registry json 落盘用);`finalCommand`
 * 是还原后真值(只活在 spawn 调用栈,沙箱执行拿真值,不上盘);`cwd` 是
 * handler 入口冻结的 waveRoot(与前台 fence 同源)。
 *
 * ADR-0097:网络轴在前后台都是常量 —— fence 恒含 `--unshare-net`,出网
 * 只经 egress 缝,`BackgroundSpawnRequest` 无网络字段。
 */
interface BackgroundSpawnInput {
  readonly finalCommand: string;
  readonly recordCommand: string;
  readonly cwd: string;
}

/**
 * #502 T3:background 分支 —— 经 backgroundManager.spawn 起 detached 子进程后
 * 立即返回 {task_id, log_path}。不 await 子进程退出、不经 runInSandbox（无 fence
 * 二次构造）。
 *
 * #502 T5:ctx.conversationId 透传 spawn request —— 进程由哪个 session 启的就
 * 标哪个 conversationId，bash_output / bash_stop 后续按同字段做 scope 过滤。
 * ctx 缺省 → 记录里 conversation_id 落空串 → 不过滤（向后兼容，与 ADR-0021 D1.4
 * 对齐）。
 *
 * fence 输入(holder 档位 / homeRoot / tmpDir)取自 handler 入口的
 * `FenceSnapshot`,不在本函数内重读 cell 或 holder。
 */
async function handleBackground(
  input: BackgroundSpawnInput,
  opts: CreateBashToolOptions,
  ctx: ToolExecutionContext | undefined,
  { mode: fsMode, homeRoot, tmpDir }: FenceSnapshot,
  /** ADR-0097 / T7:per-call egress policy —— closure-derived,已注入
   *  approvalGate。manager.spawn 在装配期起 session,缺省 = 无缝。 */
  effectiveEgressPolicyFactory?:
    (() => EgressPolicyInput | undefined) | undefined
): Promise<{ task_id: string; log_path: string }> {
  const manager = opts.backgroundManager;
  if (!manager) {
    throw new ToolExecutionError(
      "bash: background execution is not available (no background manager configured)"
    );
  }
  const result = await manager.spawn({
    command: input.finalCommand,
    recordCommand: input.recordCommand,
    cwd: input.cwd,
    env: process.env,
    ...(ctx?.conversationId !== undefined
      ? { conversationId: ctx.conversationId }
      : {}),
    // #653 T1:background path 的 cwdReadonly 派生 —— 镜像前台
    // bashMode→cwdReadonly 映射(bash.ts fenceIsReadonly),foreground 与
    // background bwrap argv / fence env 在 cwdReadonly 轴上集合相等。
    // GIT_OPTIONAL_LOCKS 在 defaultBackgroundSpawn 于 filter 之后注入
    // (freeze-safe);此处只透传旗标,不改 env(whitelist 会剥掉该键)。
    ...(opts.bashMode === "readonly" || opts.cwdReadonly === true
      ? { cwdReadonly: true }
      : {}),
    tmpDir,
    // ADR-0092 Round 2 / SC11/SC12:工作区档 fence 三层(前台与后台集合
    // 相等,沙箱纪律 G3)。fsMode 是已 snapshot 字符串;homeRoot / tmpDir
    // 由前台 handler 同款闭合传递(同源值,不重读 cell)。
    fsMode,
    homeRoot,
    // ADR-0097 / T7:egress 缝 —— policy 由 caller(registry 装配期)
    // 注入(经 `effectiveEgressPolicyFactory` 派生,已注入 approvalGate)。
    // manager.spawn 在 spawn 装配期起 session,缺省 = caller 未透传
    // policy = 无缝(V1 baseline 等价)。后台路径无 ask 面 —— 即便
    // policy 在场,filter 见未在 `allowedDomains` 的 host 仍记
    // `no-approval-inlet` 违例(spec §Failure paths「非交互入口首见
    // 新域名」)。
    ...(effectiveEgressPolicyFactory !== undefined
      ? { egressPolicy: effectiveEgressPolicyFactory() }
      : {}),
  });
  if (result.status === "spawn_error") {
    // 与 bash 既有错误形态一致:typed-error 渲染（${kind}: ${context}）装进
    // ToolExecutionError。caller catch 契约不会被 [object Object] 污染。
    // concurrency_limit_reached 携带正面措辞 message（ADR-0021 D1.6:说明
    // 现状+可用动作+零负面词），用 message 替代 context 让模型看到可执行
    // 的后续动作；其它 kind 仍走 context 字节一致。
    const detail =
      "message" in result.error && result.error.message
        ? result.error.message
        : result.error.context;
    throw new ToolExecutionError(
      `bash: background spawn failed: ${result.error.kind}: ${detail}`
    );
  }
  return { task_id: result.task_id, log_path: result.log_path };
}

/**
 * ADR-0084 / D1 的入账调用口（判定链在这里，handler 只转交）。
 *
 * `exitCode !== 0` → 什么都没读到，不入账。提取器只认「恰好一个顶层段 +
 * 无重定向/替换 + 白名单命令 + 恰好一个文件操作数」，抽不出 path 一律不入账
 * （fail-closed）：漏记只让模型多读一次，错记会让未读的非空文件被放行。
 */
async function recordCompletedRead(
  opts: CreateBashToolOptions | undefined,
  ctx: ToolExecutionContext | undefined,
  call: {
    readonly command: string;
    readonly exitCode: number;
    readonly root: string;
    readonly sessionTmpRoot: string;
  }
): Promise<void> {
  // EXIT: 命令失败（exit != 0）→ 什么都没读到，不入账。
  if (call.exitCode !== 0) return;
  await recordSingleReadCommand(opts?.lastReadLedger, ctx, call.command, {
    root: call.root,
    sessionTmpRoot: call.sessionTmpRoot,
  });
}

/**
 * ADR-0084 / D1:把「恰好读了一个文件」的成功命令登记进 last-read 账本。
 *
 * 提取器（`extractSingleReadPath`）只做字面量判定，path 解析在本函数完成 ——
 * 与 write_file 侧的 `resolveWithinRoot(rootAtCall, …)` 同一口径，这样账本键
 * 与写入侧 target 才可能相等。解析失败（越界 / 不存在的 path 形态）→ 静默
 * 跳过：账本只影响「能不能覆盖非空文件」这一个闸，不该让读命令多出一个失败面。
 */
async function recordSingleReadCommand(
  host: LastReadLedgerHost | undefined,
  ctx: ToolExecutionContext | undefined,
  command: string,
  resolveCtx: { readonly root: string; readonly sessionTmpRoot: string }
): Promise<void> {
  // EXIT: host 缺席（legacy 调用方）或无 conversationId（不建匿名桶）→ 不入账。
  const ledger = host?.ledgerFor(ctx?.conversationId);
  if (ledger === undefined) return;
  // EXIT: 非「唯一单文件读」形态（管道 / 重定向 / 抑制输出旗标 / 原地改 /
  // 递归 / 多文件 / 非白名单）→ 不入账（fail-closed）。
  const candidate = extractSingleReadPath(command);
  if (candidate === undefined) return;
  let resolved: string;
  try {
    resolved = await resolveWithinRoot(resolveCtx.root, candidate, {
      sessionTmpRoot: resolveCtx.sessionTmpRoot,
    });
  } catch {
    // EXIT: path 解析失败（越界 / 不存在形态）→ 静默跳过；账本只影响非空
    // 覆写这一个闸，不该让读命令多出一个失败面。
    return;
  }
  ledger.record(resolved);
}

function resolveBashFenceTmp(
  opts: CreateBashToolOptions | undefined,
  conversationId: string | undefined,
  fallback: () => string
): string {
  return (
    resolveSessionFenceTmp({
      tmpDir: opts?.tmpDir,
      projectDir: opts?.projectDir,
      conversationId,
    }) ?? fallback()
  );
}
