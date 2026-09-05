import { homedir, tmpdir } from "node:os";
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
  createResourceLimits,
  currentSecretValues,
} from "../../sandbox/index.js";
import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  requireBwrap,
  runInSandbox,
} from "../../sandbox/runner.js";
import { restore, type SecretRegistry } from "../../secret-roundtrip/index.js";
import type { BackgroundTaskManager } from "../../background/manager.js";
import type { LiveTaskRoot } from "../../session-roots.js";

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
  /** ADR-0019 (T4): per-root state anchor. Threaded into `createFsPolicy` so the
   *  fence binds `<workspaceRoot>` as a root and `<workspaceRoot>/.iknow` is
   *  covered by the protected-state pathset. Defaults to `cwd` (the legacy
   *  shape) when absent — preserves the existing bash argv for callers that
   *  don't thread per-root state (e.g. demo.ts, bash-sandbox.test.ts). */
  readonly workspaceRoot?: string;
  /** #337 T8 测试缝:home 覆盖（默认 homedir()）— production 不传 = 真实
   *  home,单测可注入 tmpdir 隔离真实 user dir。 */
  readonly home?: string;
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
   * index）。缺省 / false = V1 路径逐字节不变。bashMode→cwdReadonly 映射由 T6
   * 在 registry 装配处完成；本字段是 additive 透传缝。 */
  readonly cwdReadonly?: boolean;
  /** T7 (plans/worktree-live-task-root.md §6): per-call live root cell. 在场
   * 时 handler 入口读一次冻结为 waveRoot（D2 batch snapshot），前台 /
   * background 共用同一份；fsPolicy 与 bwrap fence 围绕 waveRoot 重建，argv
   * 形状与顺序逐字节不变（home / tmpDir / workspaceRoot 等非 cwd 维度由
   * 工厂期捕获 ⇒ 多次 rebuild 间的差异仅落在 cwd token）。缺省时退回工厂
   * 捕获 cwd —— 与 V1 路径字节一致（legacy test parity）。 */
  readonly liveTaskRoot?: LiveTaskRoot;
  /** #891 T2 (ADR-0037 §4 amendment): 改绑后的主仓只读 overlay 根。在场时
   *  handler 在活 taskRoot ≠ 身份根的波次把它透传给 bwrap fence
   *  （`--ro-bind` 后挂覆盖 writable home），前台 fence 与 background spawn
   *  消费同一 token；活 taskRoot == 身份根（未改绑 / OFF）→ 不传，argv 与
   *  V1 逐字节一致。 */
  readonly projectIdentityRoot?: string;
}

export function createBashTool(
  cwd: string,
  opts?: CreateBashToolOptions
): AciToolDef {
  requireBwrap();
  // T7 (D3): 工厂期只捕获 fsPolicy 的非 cwd 维度。home / tmpDir / workspaceRoot
  // 都是 process-stable ⇒ 多次 rebuild 间 argv SHAPE 锁定。cwd 由 handler 入口
  // 的 waveRoot 注入（见下方 handler）。把 fsPolicy 构造从工厂期移进 handler
  // —— 这是 D4 的核心：bash handler 必须 per-call rebuild fsPolicy + bwrap
  // fence,不能闭包到工厂捕获 cwd。
  const home = opts?.home ?? homedir();
  const tmpDir = tmpdir();
  const workspaceRoot = opts?.workspaceRoot;
  const networkPolicy = createNetworkPolicy();
  const resourceLimits = createResourceLimits();
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
    // #891 T2: overlay token = 改绑波次专用。活 taskRoot 就是身份根（未改绑
    // / OFF）时主仓本来就是 cwd，无需 overlay —— 不传选项，argv 与 V1 字节
    // 一致；改绑后 cwd 在身份树内，身份根 ro-bind 后挂覆盖 writable home。
    // 前台 fence 与 background spawn 消费同一 token（D2 同波同一份）。
    const identityOverlay =
      opts?.projectIdentityRoot !== undefined &&
      waveRoot !== opts.projectIdentityRoot
        ? opts.projectIdentityRoot
        : undefined;
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
      return await handleBackground(
        command,
        bgCommand,
        waveRoot,
        opts ?? {},
        ctx,
        wantsHostNetwork,
        identityOverlay
      );
    }
    // #562 T6: bashMode="readonly" 派生 cwdReadonly:true 传给 fence + env。
    // bashMode→cwdReadonly 映射由 T6 在此装配完成 (registry 只透传 bashMode,
    // 不读 catalog)。cwdReadonly 显式 true / bashMode==="readonly" 任一即触发。
    // 缺省 "any" / undefined → 不传 cwdReadonly, T5 argv baseline 不破。
    const fenceIsReadonly =
      opts?.cwdReadonly === true || opts?.bashMode === "readonly";
    const fenceEnv = applyCwdReadonlyFenceEnv(
      envIsolation.filter(process.env),
      fenceIsReadonly
    );
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
    // T7 (D4): fsPolicy per-call rebuild —— home/tmpDir/workspaceRoot 是
    // 工厂期冻结的,只有 cwd 维度跟 waveRoot 联动。argv SHAPE+ORDER 因此
    // 与 V1 字节等价,差异只落在 --bind / --chdir 的 cwd token 上。
    const fsPolicy = createFsPolicy({
      cwd: waveRoot,
      home,
      tmpDir,
      ...(workspaceRoot ? { workspaceRoot } : {}),
    });
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", finalCommand],
      fsPolicy,
      networkPolicy,
      resourceLimits,
      env: fenceEnv,
      cwd: waveRoot,
      ...(wantsHostNetwork ? { network: true } : {}),
      ...(fenceIsReadonly ? { cwdReadonly: true } : {}),
      ...(identityOverlay !== undefined
        ? { projectIdentityRoot: identityOverlay }
        : {}),
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
      "Run shell commands inside the bwrap sandbox for builds, scripts, or one-shot operations without a dedicated tool; pair with read_file / grep / glob / edit_file / write_file for file work inside the fence. Returns {code, stdout, stderr}; stdout/stderr truncated at 12000 code points per stream. Hard-walls reject obvious destructive patterns and sensitive-path targets before spawn; non-hard-wall commands go through the normal permission flow. For long-running services (http servers, daemons, continuous watchers), set background: true — the call returns {task_id, log_path} immediately and the process keeps running beyond the call, outside the build-tier timeout; then read the log tail with bash_output(task_id, max_bytes?) (default 12 KB, cap 100 KB) and terminate the process group with bash_stop(task_id) (SIGTERM, 2-second grace, then SIGKILL; idempotent). The fence is network-isolated by default; set network: true for host-network access, routed through explicit permission approval.",
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
 * #502 T3:background 分支 —— 经 backgroundManager.spawn 起 detached 子进程后
 * 立即返回 {task_id, log_path}。不 await 子进程退出、不经 runInSandbox（无 fence
 * 二次构造）。
 *
 * #502 review-repair（#406 roundtrip）:secret 还原在调用方完成 —— command 传
 * 还原后真值（只活在 spawn 调用栈,沙箱执行拿真值）；recordCommand 传原始
 * 占位符形态（registry json 落盘用,占位符在盘上）。
 *
 * #502 T5:ctx.conversationId 透传 spawn request —— 进程由哪个 session 启的就
 * 标哪个 conversationId，bash_output / bash_stop 后续按同字段做 scope 过滤。
 * ctx 缺省 → 记录里 conversation_id 落空串 → 不过滤（向后兼容，与 ADR-0021 D1.4
 * 对齐）。
 */
async function handleBackground(
  recordCommand: string,
  finalCommand: string,
  cwd: string,
  opts: CreateBashToolOptions,
  ctx?: ToolExecutionContext,
  wantsHostNetwork = false,
  identityOverlay?: string
): Promise<{ task_id: string; log_path: string }> {
  const manager = opts.backgroundManager;
  if (!manager) {
    throw new ToolExecutionError(
      "bash: background execution is not available (no background manager configured)"
    );
  }
  const result = await manager.spawn({
    command: finalCommand,
    recordCommand,
    cwd,
    workspaceRoot: opts.workspaceRoot,
    env: process.env,
    home: opts.home,
    ...(ctx?.conversationId !== undefined
      ? { conversationId: ctx.conversationId }
      : {}),
    // #503 T11:background path 的 host-network opt-in —— 透传 spawn request,
    // defaultBackgroundSpawn 据此构造 host-net fence（去 --unshare-net）。
    ...(wantsHostNetwork ? { network: true } : {}),
    // #653 T1:background path 的 cwdReadonly 派生 —— 镜像前台
    // bashMode→cwdReadonly 映射(bash.ts fenceIsReadonly),foreground 与
    // background bwrap argv / fence env 在 cwdReadonly 轴上集合相等。
    // GIT_OPTIONAL_LOCKS 在 defaultBackgroundSpawn 于 filter 之后注入
    // (freeze-safe);此处只透传旗标,不改 env(whitelist 会剥掉该键)。
    ...(opts.bashMode === "readonly" || opts.cwdReadonly === true
      ? { cwdReadonly: true }
      : {}),
    // #891 T2: 前台与后台共用同一 overlay token（D2 同波同一份）——
    // defaultBackgroundSpawn 据此把身份根 --ro-bind 后挂进 background fence。
    ...(identityOverlay !== undefined
      ? { projectIdentityRoot: identityOverlay }
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
