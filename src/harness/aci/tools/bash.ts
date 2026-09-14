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
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createOutputMask,
  currentSecretValues,
  type BwrapFenceOptions,
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
  /** #503 T10 / ADR-0022:network?: boolean — 缺省 false = 网络隔离（既有
   *  --unshare-net 路径）；true = 去 unshare-net、获得宿主网络可见性。 */
  readonly network?: unknown;
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

export function createBashTool(
  cwd: string,
  opts?: CreateBashToolOptions
): AciToolDef {
  requireBwrap();
  // ADR-0092 (D3): 工厂期只捕获 `tmpDir`（process-stable）。fsPolicy 由
  // handler per-call 重建,不闭包到工厂捕获的 cwd。
  let fallbackFenceTmp: string | undefined;
  const networkPolicy = createNetworkPolicy();
  const envIsolation = createEnvIsolation({ allowEnv: BASE_ENV_WHITELIST });
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
      // #503 T11:network:true + background 接线 —— fence shape 决策下沉到
      // manager.spawn（BackgroundSpawnRequest.network → defaultBackgroundSpawn
      // 构造 host-net fence）。权限层强制 ask 由 T10 policy 覆盖，工具层不重复
      // 检查；此处只解析严格 === true，非布尔 / 缺省 / false → 隔离路径。
      // #502 review-repair（#406 roundtrip）:recordCommand 传原始占位符形态
      // input.command（占位符落盘）,command 传还原后真值（spawn 执行用,不上盘）。
      const bgCommand = opts?.secretRegistry
        ? restore(command, opts.secretRegistry)
        : command;
      const wantsHostNetwork = (input as BashInput | null)?.network === true;
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
          wantsHostNetwork,
        },
        opts ?? {},
        ctx,
        { mode: fsMode, homeRoot, tmpDir }
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
    // #503 T10 / ADR-0022:network:true 透传到 fence（T9 已落地
    // createBwrapFence 的 `network` 选项 + baseArgs 内插 --unshare-net）。
    // 权限层（policy.ts code-ask-bash-network）已强制 ask full_auto 不豁免,
    // 此处只判严格 === true;非布尔 / 缺省 / false → 走既有隔离路径。
    const wantsHostNetwork = (input as BashInput | null)?.network === true;
    // T7 (D4): fsPolicy per-call rebuild —— `tmpDir` 工厂期冻结,只有 cwd
    // 维度跟 waveRoot 联动。Round 2:policy 携带 fs 档(mode 字段),bwrap 据
    // 此在工作区档 argv 叠三层(ADR-0092 Amendment)。handler 入口 fsMode
    // 已 D2 snapshot,此处直接消费。
    const fsPolicy = createFsPolicy({ tmpDir, mode: fsMode });
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", finalCommand],
      fsPolicy,
      networkPolicy,
      env: fenceEnv,
      cwd: waveRoot,
      ...(wantsHostNetwork ? { network: true } : {}),
      ...(fenceIsReadonly ? { cwdReadonly: true } : {}),
      // ADR-0092 Round 2 / SC11/SC12:工作区档 fence 三层(host root + 系统
      // 前缀 + home ro-bind + 两处写白名单)的源端绝对路径。global 档下
      // `fsPolicy.mode === "global"`,bwrap 内部自动不发射,与 V1 baseline
      // 逐字节一致。
      ...fenceWorkspaceMounts(fsMode, homeRoot, waveRoot, tmpDir),
    });
    const result = await runInSandbox({
      fence,
      cwd: waveRoot,
      signal: ctx?.signal,
      env: fenceEnv,
      maxOutputCodePoints: DEFAULT_MAX_OUTPUT_CODE_POINTS,
    });
    // #406 T3:输出遮罩 —— handler return 前对 stdout / stderr 洗一遍。
    // mask 构造在 handler 内每次现取（registry 值可跨 turn 变化；不模块级
    // 缓存）。缺席 secretRegistry → 不构造 mask（plan 验收 #2；不扩展
    // 「缺席仍用 env 三源 mask」）。截断权威在 executor，mask 在 truncation
    // 之后跑 —— 遮的是已截断的真值，最大遮蔽窗口。
    const mask =
      opts?.secretRegistry !== undefined
        ? createOutputMask(
            currentSecretValues(process.env, opts.secretRegistry.values())
          )
        : undefined;
    // ADR-0084 / D1:成功的单文件白名单读入账（判定细节见
    // `recordCompletedRead`）。入账键与 write_file 侧同源，两边才可能命中。
    await recordCompletedRead(opts, ctx, {
      command,
      exitCode: result.exitCode,
      root: waveRoot,
      // ADR-0092: session tmp is `$TMPDIR` (host pad), not guest `/tmp`.
      // Same pad is write_file's extra write root so ledger keys match.
      tmpWriteRoot: tmpDir,
    });
    return {
      output: JSON.stringify({
        code: result.exitCode,
        stdout: mask ? mask.mask(result.stdout) : result.stdout,
        stderr: mask ? mask.mask(result.stderr) : result.stderr,
      }),
      // #693 T4 D4:bash stdout/stderr 走观测旁路(meta),TUI 从旁路取数显示
      // 5 行尾部预览（不经 encodeToolResults 进模型 tool_result，模型视野
      // 仅见 output 字段里 JSON 化的 code/stdout/stderr —— 形状不变）。
      meta: {
        stdout: mask ? mask.mask(result.stdout) : result.stdout,
        stderr: mask ? mask.mask(result.stderr) : result.stderr,
      },
    };
  };
  return Object.freeze({
    name: "bash",
    description:
      "Run shell commands inside the bwrap sandbox for builds, scripts, or one-shot operations without a dedicated tool; pair with read_file / grep / glob / edit_file / write_file for file work inside the fence. Returns {code, stdout, stderr}; stdout/stderr truncated at 12000 code points per stream. Hard-walls reject obvious destructive patterns and sensitive-path targets before spawn; non-hard-wall commands go through the normal permission flow. For long-running services (http servers, daemons, continuous watchers), set background: true — the call returns {task_id, log_path} immediately and the process keeps running beyond the call, outside the build-tier timeout; then read the log tail with bash_output(task_id, max_bytes?) (default 12 KB, cap 100 KB) and terminate the process group with bash_stop(task_id) (SIGTERM, 2-second grace, then SIGKILL; idempotent). The fence is network-isolated by default; set network: true for host-network access, routed through explicit permission approval. " +
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
        // #503 T10 / ADR-0022:network?: boolean — 宿主网络批准轴。non-negative
        // 措辞（d9 门禁）：正面说明 what it does,不提 "do not"。
        network: {
          type: "boolean",
          description:
            "When true, this command gets host network access (the fence skips --unshare-net) so it can reach the LAN or the internet. Network opt-in is a separate approval axis: calls with network:true always go through explicit permission and full_auto mode does not exempt them. Defaults to false (network-isolated).",
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
 * handler 入口冻结的 waveRoot(与前台 fence 同源);`wantsHostNetwork` 是
 * `input.network === true` 的严格解析结果。
 */
interface BackgroundSpawnInput {
  readonly finalCommand: string;
  readonly recordCommand: string;
  readonly cwd: string;
  readonly wantsHostNetwork: boolean;
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
  { mode: fsMode, homeRoot, tmpDir }: FenceSnapshot
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
    // #503 T11:background path 的 host-network opt-in —— 透传 spawn request,
    // defaultBackgroundSpawn 据此构造 host-net fence（去 --unshare-net）。
    ...(input.wantsHostNetwork ? { network: true } : {}),
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
    readonly tmpWriteRoot: string;
  }
): Promise<void> {
  // EXIT: 命令失败（exit != 0）→ 什么都没读到，不入账。
  if (call.exitCode !== 0) return;
  await recordSingleReadCommand(opts?.lastReadLedger, ctx, call.command, {
    root: call.root,
    tmpWriteRoot: call.tmpWriteRoot,
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
  resolveCtx: { readonly root: string; readonly tmpWriteRoot: string }
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
      tmpWriteRoot: resolveCtx.tmpWriteRoot,
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
