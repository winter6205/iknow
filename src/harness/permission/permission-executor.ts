/**
 * src/harness/permission/permission-executor.ts
 *
 * 5-step middleware executor (spec plan T2 D1 / D2):
 *
 *   1. preToolUse(call, def)           [hook — may short-circuit; throw → fail-closed]
 *   2. checkPermission({def, input})   [pure resolver: hard-walls → layers → default]
 *   3. askUser({tool, input, hint})    [only when decision = ask]
 *   4. inner.executeAll([call])        [only when decision = allow]
 *   5. postToolUse(result)             [hook — observability only; throw → fire-and-forget]
 *
 * deny → push execution_failed, never call inner (zero side effect).
 * 钩子异常语义（#126 D3）:pre 抛异常 fail-closed（execution_failed + [hook_error]，
 * inner 零调用，loop 继续）;post 抛异常 fire-and-forget（结果不变，仅 onHookError 观测）。
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
  Registry,
  ToolDef,
} from "../tools/types.js";
import type { AciCatalog, AciToolDef } from "../aci/types.js";
import {
  checkPermission,
  isBashNetworkTrue,
  type PermissionPolicy,
} from "./policy.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";
import type {
  AskUser,
  PreHookBlock,
  PreToolUseHook,
  PostToolUseHook,
} from "./types.js";

// Permission-executor prefixes consumed from the SSOT table. Keeping a local
// const alias preserves the call-site ergonomics (no template-literal drift).
const USER_DENIED_PREFIX = VIOLATION_PREFIXES.userDenied;
const PERMISSION_DENIED_PREFIX = VIOLATION_PREFIXES.permissionDenied;
const HOOK_BLOCKED_PREFIX = VIOLATION_PREFIXES.hookBlocked;
const HOOK_ERROR_PREFIX = VIOLATION_PREFIXES.hookError;

/**
 * Hook-error 载荷（#126 D3 异常语义的观测侧信道）。phase 区分异常来源：
 *   - "pre"：PreToolUseHook 抛异常 → fail-closed（调用判 execution_failed）
 *   - "post"：PostToolUseHook 抛异常 → fire-and-forget（结果不变，仅观测）
 *   - "guard-init"：secrets-guard 构造期 pattern 编译失败（T3 消费者）
 */
export interface HookErrorEvent {
  readonly phase: "pre" | "post" | "guard-init";
  readonly tool?: string;
  readonly message: string;
}

/**
 * Build an AciCatalog from a ToolRegistry by name. v0 the catalog is
 * "ACI-aware" only via category / interruptBehavior / isConcurrencySafe;
 * tools lacking AciMeta are treated as read-only safe-by-default.
 *
 * `get` 动态委托 registry.get — 兼容构造后通过 `reg.registerExternal`
 * 动态注册的 mcp__ 工具（#337）。`all()` 仍返回构造期快照，供权限层
 * 遍历 enumerate 用。
 */
export function createAciCatalog(registry: Registry): AciCatalog {
  const list = registry.list();
  const byName = new Map<string, AciToolDef>();
  for (const def of list) {
    const aci = (def as { aci?: AciToolDef["aci"] }).aci;
    if (!aci) continue;
    byName.set(def.name, project(def));
  }
  return Object.freeze({
    get: (name: string) => {
      const hit = byName.get(name);
      if (hit !== undefined) return hit;
      // 动态源兜底：registerExternal 注册的 mcp__ 工具不在构造期快照里
      const dynamic = registry.get(name);
      if (!dynamic) return undefined;
      const aci = (dynamic as { aci?: AciToolDef["aci"] }).aci;
      if (!aci) return undefined;
      return project(dynamic);
    },
    all: () => Object.freeze([...byName.values()]) as ReadonlyArray<AciToolDef>,
  });
}

/**
 * ToolDef → AciToolDef 投影(SSOT)。构造期快照路径与动态 get 兜底共用,
 * 避免投影字段漂移(注释、name/description/inputSchema/handler + aci 三元组)。
 */
function project(def: ToolDef): AciToolDef {
  const aci = (def as { aci?: AciToolDef["aci"] }).aci!;
  return Object.freeze({
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: def.handler,
    aci: Object.freeze({
      category: aci.category,
      isConcurrencySafe: aci.isConcurrencySafe,
      interruptBehavior: aci.interruptBehavior,
    }),
  }) as AciToolDef;
}

export interface PermissionExecutorOptions {
  readonly inner: Executor;
  readonly registry: Registry;
  readonly policy: PermissionPolicy;
  readonly askUser: AskUser;
  readonly preToolUse?: PreToolUseHook;
  readonly postToolUse?: PostToolUseHook;
  /** 钩子异常观测回调（#126 D3）。默认不传 = 静默吞（post）/
   *  无告警渠道（pre 仍 fail-closed，仅缺观测）。 */
  readonly onHookError?: (e: HookErrorEvent) => void;
}

export type PermissionGate =
  | { readonly kind: "blocked"; readonly result: ToolExecutionResult }
  | { readonly kind: "proceed"; readonly def: AciToolDef | undefined };

export interface PermissionRuntime {
  readonly executor: Executor;
  readonly gateOne: (call: ToolCall) => Promise<PermissionGate>;
  readonly runAllowed: (
    call: ToolCall,
    def: AciToolDef | undefined,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string
  ) => Promise<ToolExecutionResult>;
}

/**
 * Factory for the permission-middleware Executor. Per-call rules:
 *  - catalog miss → delegate to inner one call at a time.
 *  - hook_blocked → execution_failed with [hook_blocked] prefix.
 *  - deny → execution_failed [permission_denied] prefix, inner not called.
 *  - ask → await askUser; false → execution_failed [user_denied] prefix.
 *  - allow → inner.executeAll([call]) and return its single result.
 *
 * #653:gateOne / runAllowed 拆开,ACI 可先串行闸门再并行 inner
 * (pre-hook → permission 不与其它 call 的 inner 重叠)。
 */
export function createPermissionRuntime(
  opts: PermissionExecutorOptions
): PermissionRuntime {
  if (!opts.askUser) {
    throw new Error(
      "permission executor: ask_inlet_missing (AskUser implementation is required at construction)"
    );
  }
  const catalog = createAciCatalog(opts.registry);
  const pre: PreToolUseHook = opts.preToolUse ?? (() => undefined);
  const post: PostToolUseHook = opts.postToolUse ?? (() => undefined);
  const askUser = opts.askUser;
  const policy = opts.policy;
  const onHookError = opts.onHookError;

  async function gateOne(call: ToolCall): Promise<PermissionGate> {
    const def = catalog.get(call.name);
    if (!def) return { kind: "proceed", def: undefined };

    let hookDecision: PreHookBlock | undefined;
    try {
      hookDecision = pre({ tool: def.name, input: call.input });
    } catch (err) {
      const sanitized = errMsg(err, call.input);
      onHookError?.({ phase: "pre", tool: def.name, message: sanitized });
      return {
        kind: "blocked",
        result: {
          kind: "execution_failed",
          toolUseId: call.id,
          message: `${HOOK_ERROR_PREFIX} pre-hook threw: ${sanitized}`,
        },
      };
    }
    if (hookDecision !== undefined) {
      return {
        kind: "blocked",
        result: {
          kind: "execution_failed",
          toolUseId: call.id,
          message: `${HOOK_BLOCKED_PREFIX} ${hookDecision.reason}`,
        },
      };
    }

    const outcome = checkPermission({
      def,
      input: call.input,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    });

    if (outcome.decision === "ask") {
      const networkRequested = isNetworkBash(def.name, call.input);
      const hint = networkRequested
        ? summarizeNetworkBash(call.input)
        : summarizeInput(call.input);
      const approved = await askUser({
        tool: def.name,
        input: call.input,
        summaryHint: hint,
        ...(networkRequested ? { network: true } : {}),
      });
      if (!approved) {
        return {
          kind: "blocked",
          result: {
            kind: "execution_failed",
            toolUseId: call.id,
            message: `${USER_DENIED_PREFIX} user declined tool call: ${def.name}`,
          },
        };
      }
    } else if (outcome.decision === "deny") {
      return {
        kind: "blocked",
        result: {
          kind: "execution_failed",
          toolUseId: call.id,
          message: `${PERMISSION_DENIED_PREFIX} ${outcome.reason}`,
        },
      };
    }
    return { kind: "proceed", def };
  }

  async function runAllowed(
    call: ToolCall,
    def: AciToolDef | undefined,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string
  ): Promise<ToolExecutionResult> {
    const [result] = await opts.inner.executeAll(
      [call],
      signal,
      timeoutMs,
      conversationId
    );
    const r = result as ToolExecutionResult;
    if (!def) return r;
    const message =
      r.kind === "execution_failed" || r.kind === "validation_failed"
        ? r.message
        : undefined;
    const payload = r.kind === "ok" ? r.payload : undefined;
    const meta = r.kind === "ok" ? r.meta : undefined;
    try {
      post({
        toolUseId: r.toolUseId,
        name: def.name,
        input: call.input,
        kind: r.kind,
        message,
        payload,
        meta,
      });
    } catch (err) {
      onHookError?.({
        phase: "post",
        tool: def.name,
        message: errMsg(err, call.input),
      });
    }
    return r;
  }

  async function executeAll(
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    onSettled?: (
      result: ToolExecutionResult,
      index: number
    ) => void | Promise<void>
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const [index, call] of calls.entries()) {
      const gate = await gateOne(call);
      const result =
        gate.kind === "blocked"
          ? gate.result
          : await runAllowed(call, gate.def, signal, timeoutMs, conversationId);
      await onSettled?.(result, index);
      out.push(result);
    }
    return out;
  }

  return Object.freeze({
    executor: Object.freeze({ executeAll }),
    gateOne,
    runAllowed,
  });
}

export function createPermissionExecutor(
  opts: PermissionExecutorOptions
): Executor {
  return createPermissionRuntime(opts).executor;
}

/** Compact human-readable summary used as askUser hint (≤ 80 chars). */
function summarizeInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    if (s.length <= 80) return s;
    return s.slice(0, 77) + "...";
  } catch {
    return "(unserializable input)";
  }
}

/**
 * #503 T10 / ADR-0022:bash network:true 是宿主网络批准轴。判定条件委托给
 * policy.ts 的 `isBashNetworkTrue` SSOT —— 决策来源与 hint 形态一一对应，
 * review-repair #502/#503 收敛两处逐字同形谓词。
 */
function isNetworkBash(tool: string, input: unknown): boolean {
  return isBashNetworkTrue(tool, input);
}

/** `<<<SECRET_N>>>` 占位符（#406 roundtrip 产物，#503 出站警告触发器）。 */
const SECRET_PLACEHOLDER_RE = /<<<SECRET_\d+>>>/;

/** 命令摘要截断基数（与 summarizeInput 同级 80 字符封顶 + "..."）。 */
const NETWORK_HINT_BASE_MAX = 80;
const NETWORK_HINT_MARKER = "[请求宿主网络] ";
const SECRET_WARNING =
  " [secret 警告] 命令含 secret 占位符，批准后真值可能随命令出站";

/**
 * bash network:true 的 ask hint：`[请求宿主网络] <命令摘要>`，命令摘要沿用
 * summarizeInput 的 80 字符 + "..." 截断风格；命令含 `<<<SECRET_N>>>`
 * 占位符时追加 [secret 警告]（只 mark warning，不读出真值 —— 视图无权
 * 读取 registry 内容，ADR-0022 Decision 3）。非字符串命令兜底走原 JSON 路径。
 */
function summarizeNetworkBash(input: unknown): string {
  const command = (input as { command?: unknown } | null)?.command;
  let hint: string;
  if (typeof command === "string" && command.length > 0) {
    const markerLen = NETWORK_HINT_MARKER.length;
    if (command.length + markerLen <= NETWORK_HINT_BASE_MAX) {
      hint = `${NETWORK_HINT_MARKER}${command}`;
    } else {
      hint =
        NETWORK_HINT_MARKER +
        command.slice(0, NETWORK_HINT_BASE_MAX - markerLen - 3) +
        "...";
    }
    if (SECRET_PLACEHOLDER_RE.test(command)) {
      hint += SECRET_WARNING;
    }
    return hint;
  }
  // command 缺失 / 非字符串（规则已命中 network:true）→ 兜底走原 JSON 路径。
  return summarizeInput(input);
}

/**
 * Hook 异常的脱敏消息（spec Constraints (b)）：只含异常类名 + 截断后的
 * message，≤200 字符，绝不回灌原始 input 内容（security-boundaries
 * 「错误信息不泄露敏感细节」）。
 *
 * 任何 throw 都拿到（非 Error 抛掷物如 string/number 走 String()），
 * `Error.prototype.toString` 类名优先；超长 message 硬截断到 200 字符封顶。
 * 若 error message 内嵌了 input 的序列化原文，先整段剔除再截断——仅截断
 * 不足以兑现「不回灌 input」，敏感串可能落在截断窗口内（如下述测试把
 * input JSON 放在 message 开头）。
 *
 * 截断上限要「预留前缀余量」：pre fail-closed 会再包一层
 * `[hook_error] pre-hook threw: `（29 字符），若 errMsg 本身占满 200，
 * 组装后的 message 会超 200。按静态前缀长度预留，确保组装结果始终 ≤200。
 */
function errMsg(err: unknown, input?: unknown): string {
  let raw: string;
  if (err instanceof Error) {
    raw = err.message.length > 0 ? `${err.name}: ${err.message}` : String(err);
  } else {
    raw = String(err);
  }
  if (input !== undefined) {
    try {
      const serialized = JSON.stringify(input);
      if (serialized.length > 0 && raw.includes(serialized)) {
        raw = raw.split(serialized).join("[input]");
      }
    } catch {
      // 序列化失败（循环引用等）→ 保持原样，截断兜底
    }
  }
  // 静态前缀余量：`${HOOK_ERROR_PREFIX} pre-hook threw: ` 的固定开销
  const prefixOverhead = HOOK_ERROR_PREFIX.length + " pre-hook threw: ".length;
  const max = 200 - prefixOverhead;
  return raw.length <= max ? raw : raw.slice(0, max - 1) + "…";
}
