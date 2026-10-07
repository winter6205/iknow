/**
 * bash_output ACI tool — the model-facing surface for background tasks.
 *
 * Reads the log tail of a task spawned via `bash(background: true)` along
 * with current status and exit code, so the model can decide its next move
 * (keep waiting / bash_stop / relaunch with adjusted parameters).
 *
 * Data path: `manager.output(task_id, max_bytes)` — the manager already
 * drains the writeChain, reads the file and tail-truncates. This tool layer
 * only does input normalization + typed-error catch rendering
 * (code-quality.md typed-error catch contract, no [object Object]) + JSON
 * envelope assembly.
 *
 * max_bytes normalization (clamp path with annotation):
 *   - absent / non-number / <=0 → DEFAULT_LOG_MAX_BYTES (12KB)
 *   - > MAX_LOG_READ_BYTES (100KB) → clamped to the cap, no throw
 *   - boundary value (exactly the cap) passes through unchanged
 * The manager clamps effectiveMax a second time internally (idempotent);
 * clamping here first avoids pointless over-cap calls.
 *
 * Permission: read-only + default allow (same shape as read_mcp_resource /
 * list_mcp_resources).
 *
 * Description: positively-framed guidance only (when to use / which tools
 * to pair with), no negative prohibitions.
 */
import type { AciToolDef } from "../types.js";
import type { ToolExecutionContext } from "../../tools/types.js";
import { ToolExecutionError } from "../../errors.js";
import {
  DEFAULT_LOG_MAX_BYTES,
  MAX_LOG_READ_BYTES,
} from "../../background/manager.js";
import type {
  BackgroundOutputResult,
  BackgroundTaskManager,
} from "../../background/manager.js";
import { renderTaskError } from "../../background/registry.js";
import type { BackgroundTaskError } from "../../background/registry.js";

export interface CreateBashOutputToolOptions {
  readonly backgroundManager: BackgroundTaskManager;
}

interface BashOutputInput {
  readonly task_id?: unknown;
  readonly max_bytes?: unknown;
}

/**
 * A background-task refusal on the read route, carrying the manager's
 * discriminated failure.
 *
 * The manager already decided which kind it is; the rendered message alone
 * leaves a caller parsing prose to recover it. `kind` / `context` / `cause`
 * keep that identity (and the underlying cause where the union carries one) on
 * the owning interface, while the message keeps the exact text the existing
 * consumers match on.
 */
export class BashOutputTaskError extends ToolExecutionError {
  override readonly name: string = "BashOutputTaskError";
  /** The manager's discriminated refusal kind, verbatim. */
  readonly kind: string;
  /** The manager's context for that kind, verbatim. */
  readonly context: string;
  /** The union's `cause` when this kind carries one, else undefined. */
  readonly cause: string | undefined;
  constructor(args: {
    readonly kind: string;
    readonly context: string;
    readonly cause: string | undefined;
    readonly message: string;
  }) {
    super(args.message);
    this.kind = args.kind;
    this.context = args.context;
    this.cause = args.cause;
  }
}

/**
 * Typed-error catch contract: discriminate `kind`, then render via
 * renderTaskError as `${kind}: ${context}` — never [object Object]. The
 * manager throws plain objects (the BackgroundTaskError discriminated union),
 * not Error instances, so the contract path must run before any
 * JSON-or-errorMessage fallback. The rendered text is unchanged; the kind /
 * context / cause ride on the typed error so a caller can branch without
 * parsing prose.
 */
function projectTaskError(err: unknown): BashOutputTaskError {
  const taskError = err as Partial<BackgroundTaskError> & { kind: string };
  return new BashOutputTaskError({
    kind: taskError.kind,
    context: taskError.context ?? "",
    cause:
      "cause" in taskError && typeof taskError.cause === "string"
        ? taskError.cause
        : undefined,
    message: `bash_output: ${renderTaskError(err as BackgroundTaskError)}`,
  });
}

/**
 * Factory: createBashOutputTool(deps) — the bash_output tool.
 *
 * The returned AciToolDef satisfies:
 *   - name === "bash_output"
 *   - inputSchema: { task_id required, max_bytes? number },
 *     additionalProperties:false
 *   - aci metadata: read-only / concurrency-safe / cancel / fast tier
 *   - handler emits the JSON envelope `{text, stderr, status, exit_code,
 *     task_id}` (one-to-one with manager.output's return shape, no extra
 *     decoding on the model side).
 */
export function createBashOutputTool(
  opts: CreateBashOutputToolOptions
): AciToolDef {
  const handler = async (
    input: unknown,
    ctx?: ToolExecutionContext
  ): Promise<string> => {
    const parsed = compileOutputInput(input);
    const maxBytes = normalizeMaxBytes(parsed.max_bytes);
    let result: BackgroundOutputResult;
    try {
      // ADR-0021: pass ctx.conversationId to the manager for scope
      // filtering. Missing ctx → requesterConversationId undefined → no
      // filtering (backward compatible).
      result = await opts.backgroundManager.output(
        parsed.task_id,
        maxBytes,
        ctx?.conversationId
      );
    } catch (err) {
      // EXIT: an already-typed tool error (compile / schema layer) travels
      // unchanged; anything else is the manager's discriminated refusal and is
      // projected onto BashOutputTaskError.
      if (err instanceof ToolExecutionError) throw err;
      throw projectTaskError(err);
    }
    return JSON.stringify(result);
  };

  return Object.freeze({
    name: "bash_output",
    description:
      "Read the log tail and current state of a background bash task previously spawned with bash(background: true). Use after a background task has returned its task_id and you want to inspect progress, check whether the command has exited, or read accumulated output before deciding the next step (continue waiting, call bash_stop to terminate, or relaunch with adjusted parameters). Pair with bash_stop to terminate the task once its output shows the work is done (server ready, build finished, error surfaced). Returns one JSON envelope with text (log tail, stdout and stderr interleaved), stderr (the same window containing only what the task wrote to stderr, empty when it wrote none), status (running / exited / killed / dead), exit_code, and task_id. Read stderr to classify a line instead of parsing the merged text. The text is truncated by default to the last 12 KB (configurable via max_bytes, capped at 100 KB); stale tasks return empty text rather than erroring.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description:
            "Background task id returned by bash(background: true); the same task_id used to read this tail or call bash_stop later.",
        },
        max_bytes: {
          type: "integer",
          minimum: 1,
          description:
            "Optional override for the log-tail window in bytes. Defaults to 12 KB; values larger than 100 KB are clamped to the 100 KB upper bound.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    handler,
    aci: {
      category: "read-only" as const,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      timeoutTier: "fast" as const,
    },
  });
}

/**
 * Input compile + strict validation: task_id is required and must be a
 * string (empty string allowed → the manager's empty_task_id typed error
 * passes through; non-object / missing task_id / wrong type →
 * ToolExecutionError as this layer's own defense beyond the schema).
 */
function compileOutputInput(input: unknown): {
  readonly task_id: string;
  readonly max_bytes: unknown;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolExecutionError("[bash_output] input must be an object");
  }
  const raw = input as BashOutputInput;
  if (typeof raw.task_id !== "string") {
    throw new ToolExecutionError(
      "[bash_output] task_id is required and must be a string"
    );
  }
  return { task_id: raw.task_id, max_bytes: raw.max_bytes };
}

/**
 * max_bytes normalization: absent / non-number / <=0 → DEFAULT_LOG_MAX_BYTES;
 * > MAX_LOG_READ_BYTES → clamp to the cap; boundary value (exactly the cap)
 * passes through unchanged. manager.output clamps effectiveMax again
 * (idempotent); clamping here first avoids pointless over-cap calls and
 * fulfills the "tool layer clamps its inputs" contract comment.
 */
function normalizeMaxBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LOG_MAX_BYTES;
  }
  return value > MAX_LOG_READ_BYTES ? MAX_LOG_READ_BYTES : value;
}
