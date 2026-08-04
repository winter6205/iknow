import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import { isAllowedCommand, isDangerousCommand } from "../permission.js";
import { spawnWithStopSignal, truncateByCodePoint } from "./helpers.js";

const MAX_OUTPUT_CODE_POINTS = 12_000;

interface BashInput {
  readonly command?: unknown;
}

/**
 * Create the model-facing bash tool rooted at cwd.
 *
 * The allowlist is a temporary gate until the OS sandbox in #123 lands; cwd
 * alone is not a security boundary. The cwd factory parameter is the reserved
 * sandbox hook: #123 can supply an isolated workspace without changing the
 * model-visible contract.
 */
export function createBashTool(cwd: string): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<unknown> => {
    const command = (input as BashInput | null)?.command;
    if (typeof command !== "string" || command.length === 0) {
      throw new ToolExecutionError("bash: command must be a non-empty string");
    }

    // Blacklist first preserves the specific rejection while the allowlist
    // remains the primary temporary gate before #123 provides real isolation.
    if (isDangerousCommand(command)) {
      throw new ToolExecutionError(
        `bash: dangerous command rejected: ${command}`
      );
    }
    if (!isAllowedCommand(command)) {
      throw new ToolExecutionError(
        `bash: command not in allowlist: ${command}`
      );
    }

    const { done } = spawnWithStopSignal("bash", ["-c", command], {
      cwd,
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

// Conventional shell signal → exit-code mapping (128 + signal number).
// Covers the Linux signal names surfaced by Node's child_process; the map is
// intentionally narrow — we do not promise fidelity for every platform-specific
// signal name. Unknown signals fall back to 1 (handled in the caller).
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

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return SIGNAL_EXIT_CODES[signal] ?? 1;
}
