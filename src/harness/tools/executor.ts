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
  ToolOutputEnvelope,
  ToolResultMeta,
} from "./types.js";

const TIMEOUT = Symbol("executor-timeout");

/** T3: ADR-0006 — executor 兜底截断阈值。字符级 = 当前唯一可行度量(token 核算等 #136)。 */
const OUTPUT_HARD_CAP = 20000;

/** T3: ADR-0006 + 计划 T1-1 — 截断标记模板。{original} / {kept} 占位。 */
const TRUNCATION_MARKER_TEMPLATE =
  "…[executor: 输出超长已截断，原长 {original} 字符，保留 {kept} 字符；如需更多信息，用更精确的输入重新调用]";

function safeContent(payload: unknown): AnthropicContentBlock[] {
  let text: string;
  if (typeof payload === "string") {
    text = payload;
  } else if (isEnvelope(payload)) {
    // T4 #298:handler 返回结构化 envelope `{ output, meta? }` — 仅取 output
    // 字符串进 model tool_result;meta 走观测侧信道,不进模型可见 payload。
    // 其余调用面(普通 JSON-compatible 对象)不受影响。
    text = payload.output;
  } else if (isJsonCompatible(payload)) {
    text = JSON.stringify(payload);
  } else {
    // Tool/Adapter 越界:Executor 兜底,不抛错,只形成可修正信号(ADR-0005 L22)。
    text = "[executor: payload not JSON-compatible]";
  }
  return [{ type: "text", text: applyOutputCap(text) }];
}

/**
 * T4 #298 + review-Low:envelope 单一判别 — 必须是纯对象、带 string `output`，
 * 且可选 `meta` 必须为纯对象（字段仅限 string oldContent / newContent /
 * stdout / stderr）。形状以 `ToolOutputEnvelope`（types.ts SSOT）为准，杜绝
 * 3 处独立 shape-check 各自漂移；reject-fast：meta 形状非法 → 整体不算
 * envelope（meta 被丢弃）。
 */
function isEnvelope(v: unknown): v is ToolOutputEnvelope {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.output !== "string") return false;
  const m = o.meta;
  if (m === undefined) return true; // envelope with no meta
  if (m === null || typeof m !== "object" || Array.isArray(m)) return false;
  const meta = m as Record<string, unknown>;
  return (
    (meta.oldContent === undefined || typeof meta.oldContent === "string") &&
    (meta.newContent === undefined || typeof meta.newContent === "string") &&
    (meta.stdout === undefined || typeof meta.stdout === "string") &&
    (meta.stderr === undefined || typeof meta.stderr === "string")
  );
}

/** T4 #298:从已通过 isEnvelope 判别的 envelope 提取 side-channel meta。
 *  meta 形状已由守卫验证，此处仅做平凡取值（单次遍历收敛）。 */
function extractMeta(v: ToolOutputEnvelope): ToolResultMeta | undefined {
  const m = (v as unknown as Record<string, unknown>).meta as
    ToolResultMeta | undefined;
  return m;
}

/**
 * T3: ADR-0006 — 序列化后 > OUTPUT_HARD_CAP 字符 → 硬截断 + 追加 marker。
 * marker 本身计入 OUTPUT_HARD_CAP 预算(kept = OUTPUT_HARD_CAP - marker.length)。
 * 不落盘(ADR-0006 L14)。契约 X:executor 永远按实际序列化长度重新测量,
 * 不信任 payload 内声称字段(truncated / total 等都可能是 MCP 第三方伪造)。
 *
 * 注:`kept` 的位数(1~5)会让最终 marker 长度在 ±4 字符内浮动,因此走
 * "先估 → 验 → 不满足则收敛"的两阶段,保证最终总长严格 <= OUTPUT_HARD_CAP。
 */
function applyOutputCap(text: string): string {
  if (text.length <= OUTPUT_HARD_CAP) return text;
  const markerTemplate = TRUNCATION_MARKER_TEMPLATE.replace(
    "{original}",
    String(text.length)
  );
  // 第一阶段:用占位长度估算 kept(把 "{kept}" 视作最长的 5 字符,
  // 等价于"按最坏情况预留",得到一个不会越界的下界)。
  const estimateKept =
    OUTPUT_HARD_CAP - markerTemplate.replace("{kept}", "99999").length;
  let kept = Math.max(0, estimateKept);
  // 第二阶段:用真实位数替换并验证;若总长越界则逐步缩减 kept 直到满足。
  for (let i = 0; i < 8; i++) {
    const finalMarker = markerTemplate.replace("{kept}", String(kept));
    const totalLen = kept + finalMarker.length;
    if (totalLen <= OUTPUT_HARD_CAP) {
      return text.slice(0, kept) + finalMarker;
    }
    kept -= totalLen - OUTPUT_HARD_CAP;
    if (kept < 0) kept = 0;
  }
  // 极端边界兜底(几乎不可达):截断到 OUTPUT_HARD_CAP,不加 marker。
  return text.slice(0, OUTPUT_HARD_CAP);
}

/**
 * T3: ADR-0005 B-2 — JSON 兼容性严格白名单。
 *   - 放行:null / string / boolean / 有限 number / Array / 纯对象
 *     (原型 === Object.prototype)。
 *   - 拒绝:NaN / ±Infinity / Date / Map / Set / 类实例 / 循环引用。
 *   - 防栈溢出:WeakSet 记录已访问对象,重复访问即拒绝。
 */
function isJsonCompatible(v: unknown): boolean {
  return isJsonCompatibleInner(v, new WeakSet());
}

function isJsonCompatibleInner(v: unknown, seen: WeakSet<object>): boolean {
  if (v === null) return true;
  const t = typeof v;
  if (t === "string" || t === "boolean") return true;
  if (t === "number") return Number.isFinite(v as number);
  if (Array.isArray(v)) {
    if (seen.has(v)) return false;
    seen.add(v);
    return v.every((item) => isJsonCompatibleInner(item, seen));
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    if (Object.getPrototypeOf(o) !== Object.prototype) return false;
    if (seen.has(o)) return false;
    seen.add(o);
    return Object.values(o).every((value) =>
      isJsonCompatibleInner(value, seen)
    );
  }
  return false;
}

function buildStopSignal(
  outerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal | undefined; abort: () => void } {
  const child = new AbortController();
  const needUnifiedSignal =
    outerSignal !== undefined || timeoutMs !== undefined;
  const unifiedSignal = needUnifiedSignal
    ? outerSignal !== undefined
      ? AbortSignal.any([outerSignal, child.signal])
      : child.signal
    : undefined;
  return { signal: unifiedSignal, abort: () => child.abort() };
}

async function raceWithTimeout<T>(
  handlerPromise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(TIMEOUT);
    }, timeoutMs);
  });
  try {
    return await Promise.race([handlerPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type ToolDefinition = NonNullable<ReturnType<RegistryImpl["get"]>>;
type CallValidation =
  | { ok: true; def: ToolDefinition }
  | { ok: false; failure: ToolExecutionResult };

function validateCall(registry: RegistryImpl, call: ToolCall): CallValidation {
  const def = registry.get(call.name);
  if (!def) {
    return {
      ok: false,
      failure: {
        kind: "tool_not_found",
        toolUseId: call.id,
        toolName: call.name,
      },
    };
  }
  const validator = registry.getValidator(call.name);
  if (!validator) {
    // Registry 必须为其 get() 的工具暴露 validator;这是契约保证,不可达。
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        toolUseId: call.id,
        message: "validator not compiled for tool",
      },
    };
  }
  if (!validator(call.input)) {
    return {
      ok: false,
      failure: {
        kind: "validation_failed",
        toolUseId: call.id,
        message: formatAjvError(validator.errors),
      },
    };
  }
  return { ok: true, def };
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
    timeoutMs?: number,
    conversationId?: string,
    turnId?: string,
    onStream?: ToolExecutionContext["onStream"],
    messages?: ToolExecutionContext["messages"]
  ): Promise<ToolExecutionResult> {
    const validation = validateCall(registry, call);
    if (!validation.ok) return validation.failure;
    const stop = buildStopSignal(signal, timeoutMs);
    // 017 T5: conversationId 并进 ctx —— tool handler（bash-output / bash-stop）
    // 读 ctx.conversationId 透传给 manager 做 scope filter。字段缺省 = 不过滤。
    // F-4: turnId 同形态 —— spawn_subagent 读它写进 def.parentTurnId。
    const ctx: ToolExecutionContext = {
      signal: stop.signal,
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(onStream !== undefined ? { onStream } : {}),
      // T5 (ADR-0071 / SC8): 来自 call.id 的
      // Anthropic tool_use_id (模型那侧 wire id) —— 与返回 ToolExecutionResult
      // 顶上的 toolUseId 同源 (handler 自填 .toolUseId 字段不依赖此 ctx);
      // spawn_subagent 消费后写进 def.toolUseId → manager 抄进 .meta.json。
      // 直接调 handler / 测试注入不走 executeAll 的路径不填,Postel(meta 键省略)。
      toolUseId: call.id,
      ...(messages !== undefined ? { messages } : {}),
    };
    try {
      const out =
        timeoutMs === undefined
          ? await validation.def.handler(call.input, ctx)
          : await raceWithTimeout(
              Promise.resolve(validation.def.handler(call.input, ctx)),
              timeoutMs,
              stop.abort
            );
      // T4 #298:envelope 的 meta 提升为 ok result 的可选 side-channel(类型已
      // 由 T2 在 ToolExecutionResult.ok 声明);非 envelope 路径 meta 缺席。
      const meta: ToolResultMeta | undefined = isEnvelope(out)
        ? extractMeta(out)
        : undefined;
      // meta 为可选字段：`{ meta }`（含 undefined）与条件展开等价，收敛为直写。
      return {
        kind: "ok",
        toolUseId: call.id,
        payload: safeContent(out),
        meta,
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
    timeoutMs?: number,
    conversationId?: string,
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>,
    turnId?: string,
    onStream?: ToolExecutionContext["onStream"],
    // skill() 二次短路:模型可见历史只读快照,原样透传进 ctx.messages。
    messages?: ToolExecutionContext["messages"]
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const [index, call] of calls.entries()) {
      const result = await runOne(
        call,
        signal,
        timeoutMs,
        conversationId,
        turnId,
        onStream,
        messages
      );
      await onSettled?.(result, index);
      out.push(result);
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
