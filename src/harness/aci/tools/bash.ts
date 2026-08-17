import { homedir, tmpdir } from "node:os";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { isDangerousCommand } from "../permission.js";
import { commandContainsSensitivePath } from "../../permission/hard-walls.js";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createResourceLimits,
} from "../../sandbox/index.js";
import {
  DEFAULT_MAX_OUTPUT_CODE_POINTS,
  requireBwrap,
  runInSandbox,
} from "../../sandbox/runner.js";
import { restore, type SecretRegistry } from "../../secret-roundtrip/index.js";
import type { BackgroundTaskManager } from "../../background/manager.js";

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
}

export function createBashTool(
  cwd: string,
  opts?: CreateBashToolOptions
): AciToolDef {
  requireBwrap();
  const fsPolicy = createFsPolicy({
    cwd,
    home: opts?.home ?? homedir(),
    tmpDir: tmpdir(),
    ...(opts?.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
  });
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
    if (commandContainsSensitivePath(command))
      throw new ToolExecutionError(
        `bash: command targets a sensitive path: ${command}`
      );
    // #502 T3:校验链通过后才决定前台 / 后台 —— 危险命令 / 敏感路径在两侧
    // 都先执行同一闸门（background 不豁免安全检查）。
    if ((input as BashInput | null)?.background === true) {
      // #503 T11 TODO:network:true + background 接线 —— 后台路径不在 T10 范
      // 围内(默认 spawn 是 host-net 隐含行为,后续需要协调 manager.spawn
      // 是否透传 fence shape 变化)。此处先保留 input.network 解析点占位,
      // T11 任务里把 fence shape 决策下沉到 manager.spawn。
      const bgCommand = opts?.secretRegistry
        ? restore(command, opts.secretRegistry)
        : command;
      return await handleBackground(bgCommand, cwd, opts ?? {});
    }
    const fenceEnv = envIsolation.filter(process.env);
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
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", finalCommand],
      fsPolicy,
      networkPolicy,
      resourceLimits,
      env: fenceEnv,
      cwd,
      ...(wantsHostNetwork ? { network: true } : {}),
    });
    const result = await runInSandbox({
      fence,
      cwd,
      signal: ctx?.signal,
      env: fenceEnv,
      maxOutputCodePoints: DEFAULT_MAX_OUTPUT_CODE_POINTS,
    });
    return {
      code: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return Object.freeze({
    name: "bash",
    description:
      "Run shell commands inside the bwrap sandbox for builds, scripts, or one-shot operations without a dedicated tool; pair with read_file / grep / glob / edit_file / write_file for file work inside the fence. Returns {code, stdout, stderr}; stdout/stderr truncated at 12000 code points per stream. Hard-walls reject obvious destructive patterns and sensitive-path targets before spawn; non-hard-wall commands go through the normal permission flow. Long-running processes that need to outlive the call are killed when the build-tier 5-minute timeout fires, and listeners inside the fence are not reachable from the host because bwrap is network-isolated.",
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
 * 二次构造）。secret 还原后的 finalCommand 在这里已是输入（调用方校验链之后
 * 还原），占位符不进 registry / log。
 */
async function handleBackground(
  finalCommand: string,
  cwd: string,
  opts: CreateBashToolOptions
): Promise<{ task_id: string; log_path: string }> {
  const manager = opts.backgroundManager;
  if (!manager) {
    throw new ToolExecutionError(
      "bash: background execution is not available (no background manager configured)"
    );
  }
  const result = await manager.spawn({
    command: finalCommand,
    cwd,
    workspaceRoot: opts.workspaceRoot,
    env: process.env,
    home: opts.home,
  });
  if (result.status === "spawn_error") {
    // 与 bash 既有错误形态一致:typed-error 渲染（${kind}: ${context}）装进
    // ToolExecutionError。caller catch 契约不会被 [object Object] 污染。
    throw new ToolExecutionError(
      `bash: background spawn failed: ${result.error.kind}: ${result.error.context}`
    );
  }
  return { task_id: result.task_id, log_path: result.log_path };
}
