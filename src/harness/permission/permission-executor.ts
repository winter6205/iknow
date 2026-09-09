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
import type { HarnessStreamEvent } from "../stream.js";
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
const CANCELLED_RESULT_MESSAGE = "cancelled";

/**
 * Hook-error 载荷（#126 D3 异常语义的观测侧信道）。phase 区分异常来源：
 *   - "pre"：PreToolUseHook 抛异常 → fail-closed（调用判 execution_failed）
 *   - "post"：PostToolUseHook 抛异常 → fire-and-forget（结果不变，仅观测）
 *   - "guard-init"：secrets-guard 构造期 pattern 编译失败（T3 消费者）
 *   - "user-rule-init"：用户钩子（user hooks） 规则 pattern 构造期编译失败（hook router
 *     消费者，specs/user-hook-router.md SC6 —— 规则整条剔除 + 告警）
 */
export interface HookErrorEvent {
  readonly phase: "pre" | "post" | "guard-init" | "user-rule-init";
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
 *
 * B4 / ADR-0043 §2 + T3 / ADR-0046 §3:第二参 `isDiscovered`(可选)是
 * 「未加载即调用」闸门的数据源 —— 装配层把 AciRegistry.isDiscovered
 * 注入到这,gateOne 据此对未 discover() 的 mcp__ 工具调用走 hydrate
 * 路径(本轮 discover + input 校验 → 执行或投影,详见 gateOne)。第三
 * 参 `discover`(可选)是 hydrate 副作用入口 —— 闸门对未 discover 的
 * mcp__ 工具调用此函数把名字纳入 discovered set(下一轮 visibleSchemas
 * 尾部追加 schema)。
 *
 * 缺席(`undefined`)→ 闸门放过(非 ACI registry 装配的路径,如 worker
 * 子代理或 stub 测试,行为与 T3 之前一致,byte-stable)。
 */
export function createAciCatalog(
  registry: Registry,
  isDiscovered?: (name: string) => boolean,
  discover?: (name: string) => void
): AciCatalog {
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
    ...(isDiscovered ? { isDiscovered } : {}),
    ...(discover ? { discover } : {}),
  });
}

/**
 * ToolDef → AciToolDef 投影(SSOT)。构造期快照路径与动态 get 兜底共用,
 * 避免投影字段漂移(注释、name/description/inputSchema/handler + aci 三元组)。
 *
 * T4 / ADR-0046 §3:`lazy` 必须穿过投影 —— gateOne 的 hydrate 判定读
 * `def.aci.lazy`(schema 退场的内建件靠这个字段被识别,名字上没有 `mcp__`
 * 前缀可认)。仅 `true` 时写入,让常驻件的投影形状字节级不变。
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
      ...(aci.lazy === true ? { lazy: true as const } : {}),
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
  /**
   * B4 / ADR-0043 §2:「已加载」检查入口 —— permission-executor 据此拒绝
   * 未 discover 即调的 mcp__ 工具调用。装配层 (build-engine) 把
   * `AciRegistry.isDiscovered` 注入;缺席 = 闸门放过(非 ACI registry 装
   * 配的路径或 stub 测试,行为与 B4 之前 byte-stable)。
   */
  readonly isDiscovered?: (name: string) => boolean;
  /**
   * T3 / ADR-0046 §3:hydrate 副作用入口 —— 闸门对未 discover 的 mcp__
   * 工具调用此函数把名字纳入 discovered set(下一轮 visibleSchemas 尾部
   * 追加 schema,自动复制 ACI 纪律)。缺席(`undefined`)→ 闸门视作「非
   * ACI registry 装配的路径」,行为与 T3 之前一致(直接交给 inner)。
   */
  readonly discover?: (name: string) => void;
}

export type PermissionGate =
  | { readonly kind: "blocked"; readonly result: ToolExecutionResult }
  | { readonly kind: "proceed"; readonly def: AciToolDef | undefined };

export interface PermissionRuntime {
  readonly executor: Executor;
  readonly gateOne: (
    call: ToolCall,
    signal?: AbortSignal
  ) => Promise<PermissionGate>;
  readonly runAllowed: (
    call: ToolCall,
    def: AciToolDef | undefined,
    signal?: AbortSignal,
    timeoutMs?: number,
    conversationId?: string,
    turnId?: string,
    onStream?: (event: HarnessStreamEvent) => void
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
  const catalog = createAciCatalog(
    opts.registry,
    opts.isDiscovered,
    opts.discover
  );
  const pre: PreToolUseHook = opts.preToolUse ?? (() => undefined);
  const post: PostToolUseHook = opts.postToolUse ?? (() => undefined);
  const askUser = opts.askUser;
  const policy = opts.policy;
  const onHookError = opts.onHookError;

  async function gateOne(
    call: ToolCall,
    signal?: AbortSignal
  ): Promise<PermissionGate> {
    const def = catalog.get(call.name);
    if (!def) return { kind: "proceed", def: undefined };

    // T3 / T4 / ADR-0046 §3:未 discover 的 lazy 工具被直呼 → hydrate(本轮
    // discover(name) → 下一轮 visibleSchemas 尾部追加 schema);input 通过
    // 该工具 inputSchema → 直接执行;否则返非 error 文本投影
    // {name, description, inputSchema},引导模型补齐 input。
    //   - 判定 = 「`mcp__` 前缀(MCP 工具天然 lazy,即使 catalog 未带 aci.lazy
    //     也按 T3 原样识别)**或** `def.aci.lazy === true`(T4:schema 溢出
    //     退场的内建件被 `retireBuiltin` stamp lazy,名字上无前缀可认)」且
    //     `isDiscovered` 在场且返 false。核心七件永不 lazy(退场候选
    //     derivation 层剔除 CORE_TOOL_NAMES),故常驻件永不进本分支。
    //   - 闸门顺序在 pre-hook 之前:hydrate 不是用户权限问题,pre-hook 不该
    //     拦;input 校验就地做(ajv 编译用 def.inputSchema 一次性编 + WeakMap
    //     缓存,后续直呼复用)。
    //   - `catalog.discover` / `catalog.isDiscovered` 缺席 → 闸门放过
    //     (非 ACI registry 装配的路径或 stub 测试,行为与 T3 之前一致
    //     —— 不破坏 worker / hub runDeps)。
    if (
      (def.name.startsWith("mcp__") || def.aci.lazy === true) &&
      catalog.isDiscovered !== undefined &&
      !catalog.isDiscovered(def.name)
    ) {
      // hydrate 副作用(在 input 校验前):即使 input 不合法,discover 也照发
      // —— spec:discover 必须发生在执行前;下一轮 tools 尾部可见该 schema,
      // 模型有 schema 后才能正确补 input。
      catalog.discover?.(def.name);
      const validator = getOrCompileValidator(def);
      if (validator(call.input)) {
        return { kind: "proceed", def };
      }
      // input 不通过 schema → 非 error 文本投影(model-facing OK,把
      // schema 显式送回,引导模型补 input;is_error = false 因为 kind 是 ok)。
      // 形态 = gateOne 既有二值契约(blocked = 裁决完成、inner 不执行,
      // result 原样透传为 tool result)内携带 ok result:消费面
      // (aci-executor)对 blocked.result.kind 无假设,加第三 arm 只为
      // 类型可读性会迫使全部闸门调用点适配,收益不成比例。
      return {
        kind: "blocked",
        result: {
          kind: "ok",
          toolUseId: call.id,
          payload: [
            {
              type: "text",
              text: JSON.stringify({
                name: def.name,
                description: def.description,
                inputSchema: def.inputSchema,
              }),
            },
          ],
        },
      };
    }

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
      if (isAborted(signal)) {
        return {
          kind: "blocked",
          result: {
            kind: "execution_failed",
            toolUseId: call.id,
            message: CANCELLED_RESULT_MESSAGE,
          },
        };
      }
      const networkRequested = isNetworkBash(def.name, call.input);
      const hint = networkRequested
        ? summarizeNetworkBash(call.input)
        : summarizeInput(call.input);
      let approved = false;
      try {
        approved = await askUser({
          tool: def.name,
          input: call.input,
          summaryHint: hint,
          ...(signal !== undefined ? { signal } : {}),
          ...(networkRequested ? { network: true } : {}),
        });
      } catch {
        // EXIT: an unavailable approval inlet must deny the call; never allow
        // a tool side effect merely because the user prompt failed.
        approved = false;
      }
      if (isAborted(signal)) {
        // EXIT: caller cancellation wins over a late approval; AskUser cannot
        // revive a call after the permission wait has been cancelled.
        return {
          kind: "blocked",
          result: {
            kind: "execution_failed",
            toolUseId: call.id,
            message: CANCELLED_RESULT_MESSAGE,
          },
        };
      }
      if (!approved) {
        return {
          kind: "blocked",
          result: {
            kind: "execution_failed",
            toolUseId: call.id,
            message: isAborted(signal)
              ? CANCELLED_RESULT_MESSAGE
              : `${USER_DENIED_PREFIX} user declined tool call: ${def.name}`,
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
    conversationId?: string,
    turnId?: string,
    onStream?: (event: HarnessStreamEvent) => void
  ): Promise<ToolExecutionResult> {
    const [result] = await opts.inner.executeAll(
      [call],
      signal,
      timeoutMs,
      conversationId,
      undefined,
      turnId,
      onStream
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
    ) => void | Promise<void>,
    turnId?: string,
    onStream?: (event: HarnessStreamEvent) => void
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const [index, call] of calls.entries()) {
      const gate = await gateOne(call, signal);
      const result =
        gate.kind === "blocked"
          ? gate.result
          : await runAllowed(
              call,
              gate.def,
              signal,
              timeoutMs,
              conversationId,
              turnId,
              onStream
            );
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

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** `<<<SECRET_N>>>` 占位符（#406 roundtrip 产物，#503 出站警告触发器）。 */
const SECRET_PLACEHOLDER_RE = /<<<SECRET_\d+>>>/;

/** 命令摘要截断基数（与 summarizeInput 同级 80 字符封顶 + "..."）。 */
const NETWORK_HINT_BASE_MAX = 80;
const NETWORK_HINT_MARKER = "[请求宿主网络·不经 network-guard] ";
const SECRET_WARNING =
  " [secret 警告] 命令含 secret 占位符，批准后真值可能随命令出站";
/** #951:常驻披露 tail —— host netns 下可达面全量公开（80 封顶之外追加）。 */
const NETWORK_HINT_TAIL =
  "（宿主 netns 全量可见：localhost 服务 / 局域网 / link-local 元数据 169.254.169.254；无 IP 过滤、无域名过滤）";

/**
 * bash network:true 的 ask hint：`[请求宿主网络·不经 network-guard] <命令摘要>`
 * + 常驻 tail。命令摘要沿用 summarizeInput 的 80 字符 + "..." 截断风格
 * （截断基数按 markerLen 动态预留：80 - markerLen - 3，新 marker 26 字符
 * → 预留 51，markerLen + 3 = 29 ≤ 80，slice 不会为负退化）；命令含
 * `<<<SECRET_N>>>` 占位符时追加 [secret 警告]（只 mark warning，不读出
 * 真值 —— 视图无权读取 registry 内容，ADR-0022 Decision 3）。tail 与
 * secret 警告都叠加在 80 封顶之外（#951：批准轴诚实化，两段披露不可被
 * 截断吃掉）。非字符串命令兜底走原 JSON 路径。
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
    return hint + NETWORK_HINT_TAIL;
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

// ---------------------------------------------------------------------------
// T3 / ADR-0046 §3 — 直呼加载 ajv 校验
// ---------------------------------------------------------------------------

import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

/**
 * T3 直呼加载的 input 校验:为 def.inputSchema 编一份 ajv validator,
 * 按 def 实例缓存(WeakMap)。与 inner executor 持有的 validator 是两份
 * 独立 ajv 实例 —— T3 这条路径走闸门同步校验,inner 仍按既有路径异步
 * 校验一次(success 路径 ajv 双跑可接受:单 tool call per turn,mcp__ 默认
 * lazy 不进 prompt schema,本路径极少触发)。
 *
 * `strict: true` 沿用 aci-registry 同源配置(spawn_subagent / read_file
 * 等已有 schema 已通过该 strict 校验,本路径不应引入新错误)。
 *
 * `addFormats` 同步注册 `date-time` / `uri` 等格式 —— 与 registry 一致。
 */
const HYDRATE_AJV = new Ajv.default({ strict: true, allErrors: true });
addFormats.default(HYDRATE_AJV);
const HYDRATE_VALIDATOR_CACHE = new WeakMap<AciToolDef, ValidateFunction>();

function getOrCompileValidator(def: AciToolDef): ValidateFunction {
  let v = HYDRATE_VALIDATOR_CACHE.get(def);
  if (v !== undefined) return v;
  // 编译失败(inputSchema 非法):走 typed-error 路径与 aci-registry 一致;
  // 当前只会在构造期未校验过的动态 def 出现 —— 已知 mcp__ 经
  // `registerExternal` 已 ajv 编译过,本路径仅复用,不重新发现错误。
  v = HYDRATE_AJV.compile(def.inputSchema);
  HYDRATE_VALIDATOR_CACHE.set(def, v);
  return v;
}
