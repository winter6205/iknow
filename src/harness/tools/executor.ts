/**
 * Executor (015 拥有) — Foundation 的工具执行器。
 *
 * 边界:
 *   - 接收 014 合法有序 tool-call 投影(身份 + 工具名 + 原始 input);
 *   - 串行执行(无并行、无短路、无自动重试);
 *   - 严格校验走 Registry 暴露的已编译 validator(`registry.getValidator`),
 *     与构造期同源 schema,绝不二次编译;
 *   - 严格校验失败 / 工具不存在 / 工具运行时异常 三类失败统一形成结构化
 *     ToolExecutionResult,而非抛出(以保证 Assistant 不污染权威历史);
 *   - 工具返回值规范化为 model-facing payload(允许字符串或 JSON-compatible
 *     结构化值);未知异常被净化为通用失败,绝不暴露 stack / 内部路径 / 凭据;
 *   - Executor 不读取 / 不构造供应商原生字段,Model Adapter 负责编码。
 */

import type { AnthropicContentBlock } from "../model-adapter/types.js";
import type { RegistryImpl } from "./registry.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types.js";

const TIMEOUT = Symbol("executor-timeout");

function safeContent(payload: unknown): AnthropicContentBlock[] {
  if (typeof payload === "string") {
    return [{ type: "text", text: payload }];
  }
  if (isJsonCompatible(payload)) {
    return [{ type: "text", text: JSON.stringify(payload) }];
  }
  // Tool/Adapter 越界:Executor 兜底,不抛错,只形成可修正信号。
  return [{ type: "text", text: "[executor: payload not JSON-compatible]" }];
}

function isJsonCompatible(v: unknown): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return true;
  if (Array.isArray(v)) return v.every(isJsonCompatible);
  if (t === "object") {
    const o = v as Record<string, unknown>;
    return Object.values(o).every(isJsonCompatible);
  }
  return false;
}

/**
 * 构造 Executor。Executor 持有 Registry,通过 `registry.getValidator` 复用
 * 构造期已编译的 ajv ValidateFunction(015 同源 schema 强制);Executor 本体
 * 不再创建任何 ajv 实例,Registry 不可变,Executor 也不持有任何可变状态。
 */
export function createExecutor(registry: RegistryImpl): Executor {
  async function runOne(
    call: ToolCall,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ToolExecutionResult> {
    const def = registry.get(call.name);
    if (!def) {
      return {
        kind: "tool_not_found",
        toolUseId: call.id,
        toolName: call.name,
      };
    }
    const validator = registry.getValidator(call.name);
    if (!validator) {
      // Registry 必须为其 get() 的工具暴露 validator;这是契约保证,不可达。
      return {
        kind: "validation_failed",
        toolUseId: call.id,
        message: "validator not compiled for tool",
      };
    }
    if (!validator(call.input)) {
      const msg = formatAjvError(validator.errors);
      return {
        kind: "validation_failed",
        toolUseId: call.id,
        message: msg,
      };
    }
    // signal 原样透传,不创建子 signal,以保留调用方的取消身份。
    const ctx: ToolExecutionContext = { signal };
    try {
      let out: unknown;
      if (timeoutMs === undefined) {
        out = await def.handler(call.input, ctx);
      } else {
        // timeout 在外层约束执行时长,不依赖 handler 内部支持取消。
        let timer: ReturnType<typeof setTimeout> | undefined;
        const handlerPromise = Promise.resolve(def.handler(call.input, ctx));
        const timeoutPromise = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(TIMEOUT), timeoutMs);
        });
        try {
          out = await Promise.race([handlerPromise, timeoutPromise]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }
      return {
        kind: "ok",
        toolUseId: call.id,
        payload: safeContent(out),
      };
    } catch (err) {
      return {
        kind: "execution_failed",
        toolUseId: call.id,
        message: signal?.aborted
          ? "cancelled"
          : err === TIMEOUT
            ? "timeout"
            : sanitizeFailure(err),
      };
    }
  }

  async function executeAll(
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const call of calls) {
      out.push(await runOne(call, signal, timeoutMs));
    }
    return out;
  }

  return Object.freeze({ executeAll });
}

function formatAjvError(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) return "invalid input";
  const e = errors[0] as { instancePath?: string; message?: string };
  const where =
    e.instancePath && e.instancePath.length > 0 ? e.instancePath : "(root)";
  return `invalid input at ${where}: ${e.message ?? "schema violation"}`;
}

function sanitizeFailure(err: unknown): string {
  if (err instanceof ToolExecutionError) {
    return err.message;
  }
  return "tool execution failed";
}

// Late import to break potential cycle: ToolExecutionError referenced here.
import { ToolExecutionError } from "../errors.js";
