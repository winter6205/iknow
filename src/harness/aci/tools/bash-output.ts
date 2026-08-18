/**
 * #502 T4 — bash_output ACI 工具（Track A 模型操作面）。
 *
 * 用途：读取由 `bash` 工具以 `background: true` 启动的后台任务的日志尾部，
 * 附带当前任务状态与 exit code，模型据此决定后续动作（继续等 / 调用
 * bash_stop 终止 / 调整参数后重启）。
 *
 * 数据通路：`manager.output(task_id, max_bytes)` — manager 内部已完成
 * writeChain drain + readFile + tail 截断（manager.ts:443-475）。本工具层
 * 做参数归一化 + typed-error catch 渲染（code-quality.md typed-error catch
 * 契约，禁 [object Object]）+ JSON envelope 装配。
 *
 * 参数归一化（clamp-path-with-annotation，T4 定稿）：
 *   - max_bytes 缺席 / 非 number / <=0 → DEFAULT_LOG_MAX_BYTES（12KB）
 *   - max_bytes > MAX_LOG_READ_BYTES（100KB）→ clamp 到上限，不抛错
 *   - 临界值（恰好等于上限）原样透传
 * 入参断言在 fake manager 上锁定收敛值（tests/harness/aci/bash-output-stop.test.ts
 * 「max_bytes clamp」段）；manager 内部对 effectiveMax 还会二次 clamp
 * （idempotent），工具层先钳到位避免无意义的越界调用。
 *
 * Permission（M2 决议）：read-only + 默认 allow（与 read_mcp_resource /
 * list_mcp_resources 同形态）。
 *
 * 描述（D9 决议）：仅正面引导条件（何时用 / 与什么工具配对），不写负面禁令词。
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
 * 工厂：createBashOutputTool(deps) — bash_output 工具（第 29 件）。
 *
 * 返回的 AciToolDef 满足：
 *   - name === "bash_output"
 *   - inputSchema: { task_id 必填, max_bytes? number }，additionalProperties:false
 *   - aci 元数据：read-only / concurrency-safe / cancel / fast tier
 *   - handler 输出 JSON envelope `{text, status, exit_code, task_id}`（与
 *     manager.output 返回形态一一对应，模型侧无需额外解码）。
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
      // #502 T5 / ADR-0021 D1.4:ctx.conversationId 透传 manager 做 scope 过滤。
      // ctx 缺省 → requesterConversationId undefined → manager 不过滤（向后兼容）。
      result = await opts.backgroundManager.output(
        parsed.task_id,
        maxBytes,
        ctx?.conversationId
      );
    } catch (err) {
      if (err instanceof ToolExecutionError) throw err;
      // typed-error catch 契约：kind 判别后用 renderTaskError 渲染 `${kind}:
      // ${context}`，禁 [object Object]。manager 抛 plain object（判别联合
      // BackgroundTaskError），不是 Error instance，需 JSON-or-errorMessage
      // 兜底前先用 renderTaskError 走契约路径。
      throw new ToolExecutionError(
        `bash_output: ${renderTaskError(err as BackgroundTaskError)}`
      );
    }
    return JSON.stringify(result);
  };

  return Object.freeze({
    name: "bash_output",
    description:
      "Read the log tail and current state of a background bash task previously spawned with bash(background: true). Use after a background task has returned its task_id and you want to inspect progress, check whether the command has exited, or read accumulated output before deciding the next step (continue waiting, call bash_stop to terminate, or relaunch with adjusted parameters). Pair with bash_stop to terminate the task once its output shows the work is done (server ready, build finished, error surfaced). Returns one JSON envelope with text (log tail), status (running / exited / killed / dead), exit_code, and task_id. The text is truncated by default to the last 12 KB (configurable via max_bytes, capped at 100 KB); stale tasks return empty text rather than erroring.",
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
 * 输入编译 + 严格校验：task_id 必填且为字符串（允许空串 → manager 走
 * empty_task_id typed-error 透传；非对象 / 缺 task_id / 类型错 → ToolExecutionError
 * 自身防御，schema 之外的兜底）。
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
 * max_bytes 归一化：缺席 / 非 number / <=0 → DEFAULT_LOG_MAX_BYTES；
 * > MAX_LOG_READ_BYTES → clamp 到上限；临界值（恰好等于上限）原样透传。
 * manager.output 还会对 effectiveMax 二次 clamp（idempotent），本工具层
 * 先钳到位避免无意义越界调用，并满足「工具层 clamp 入参」的契约注释。
 */
function normalizeMaxBytes(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_LOG_MAX_BYTES;
  }
  return value > MAX_LOG_READ_BYTES ? MAX_LOG_READ_BYTES : value;
}
