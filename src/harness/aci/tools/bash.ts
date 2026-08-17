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

interface BashInput {
  readonly command?: unknown;
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
    const fenceEnv = envIsolation.filter(process.env);
    // #406 T3:构造 fence 前还原占位符 —— 还原后的命令才是真正 spawn 进 bwrap
    // 的文本。原始命令（含占位符）只见于工具调用记录 / 模型上下文；模型永不
    // 见还原后的命令，只看到 bash 输出的 stdout。
    const finalCommand = opts?.secretRegistry
      ? restore(command, opts.secretRegistry)
      : command;
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", finalCommand],
      fsPolicy,
      networkPolicy,
      resourceLimits,
      env: fenceEnv,
      cwd,
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
      properties: { command: { type: "string" } },
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
