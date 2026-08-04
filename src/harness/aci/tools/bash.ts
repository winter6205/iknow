import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { isAllowedCommand, isDangerousCommand } from "../permission.js";
import {
  BASE_ENV_WHITELIST,
  createBwrapFence,
  createEnvIsolation,
  createFsPolicy,
  createNetworkPolicy,
  createResourceLimits,
} from "../../sandbox/index.js";
import { spawnWithStopSignal, truncateByCodePoint } from "./helpers.js";

const MAX_OUTPUT_CODE_POINTS = 12_000;
const SIGNAL_EXIT_CODES: Readonly<Record<string, number>> = Object.freeze({
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGILL: 132,
  SIGTRAP: 133,
  SIGABRT: 134,
  SIGBUS: 135,
  SIGFPE: 136,
  SIGKILL: 137,
  SIGUSR1: 138,
  SIGSEGV: 139,
  SIGUSR2: 140,
  SIGPIPE: 141,
  SIGALRM: 142,
  SIGTERM: 143,
  SIGSTKFLT: 144,
  SIGCHLD: 145,
  SIGCONT: 146,
  SIGSTOP: 147,
  SIGTSTP: 148,
  SIGTTIN: 149,
  SIGTTOU: 150,
  SIGURG: 151,
  SIGXCPU: 152,
  SIGXFSZ: 153,
  SIGVTALRM: 154,
  SIGPROF: 155,
  SIGWINCH: 156,
  SIGIO: 157,
  SIGPWR: 158,
  SIGSYS: 159,
});
interface BashInput {
  readonly command?: unknown;
}
function signalExitCode(signal: NodeJS.Signals | null): number {
  return signal === null ? 1 : (SIGNAL_EXIT_CODES[signal] ?? 1);
}
function requireBwrap(): void {
  const probe = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
  if (probe.status !== 0)
    throw new ToolExecutionError(
      "bash: bwrap is required; install bwrap (≥ 0.11.1) via apt install bubblewrap or your distro equivalent"
    );
}
export function createBashTool(cwd: string): AciToolDef {
  requireBwrap();
  const fsPolicy = createFsPolicy({ cwd, home: homedir(), tmpDir: tmpdir() });
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
    if (!isAllowedCommand(command))
      throw new ToolExecutionError(
        `bash: command not in allowlist: ${command}`
      );
    const fence = createBwrapFence({
      command: "bash",
      args: ["-c", command],
      fsPolicy,
      networkPolicy,
      resourceLimits,
      env: envIsolation.filter(process.env),
      cwd,
    });
    const { done } = spawnWithStopSignal(fence.argv[0], fence.argv.slice(1), {
      cwd: process.cwd(),
      signal: ctx?.signal,
    });
    const result = await done;
    return {
      code: result.code ?? signalExitCode(result.signal),
      stdout: truncateByCodePoint(result.stdout, MAX_OUTPUT_CODE_POINTS),
      stderr: truncateByCodePoint(result.stderr, MAX_OUTPUT_CODE_POINTS),
    };
  };
  return Object.freeze({
    name: "bash",
    description:
      "Execute an allowlisted bash command in the configured working directory and return its exit code, stdout, and stderr.",
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
    },
  });
}
