/**
 * #356 T4 / #361 V1.5 / #556 T3 — spawn_subagent ACI 工具（主代理第 24/25 件之一）。
 *
 * **#361 前景 spawn 反转（ADR-0014 V1.5）**：默认 `wait:true` — 模型调一次 →
 * handler `await manager.waitFor(taskId, undefined, ctx.signal)`（缺省超时
 * 由 manager 三层链 `def.timeoutMs ?? taskTimeoutMs ?? PER_TASK_TIMEOUT_MS`
 * 决定，spawn timer 同源），阻塞至子代理终态，把父可见短交差（summary /
 * changed paths / status / stop_reason）作 tool_result 返回。多个独立任务
 * 可在同一 turn 并行发多条 spawn_subagent（wait:true 各自阻塞，executor
 * 并发安全）。`wait:false` → 立即返 `{task_id}`（异步臂），chat / tui / serve
 * 由 host mailbox/subscribe 终态唤醒 silent run；subagent_result 仍可主动查询。
 *
 * **#556 T3 subagent_type routing**：可选参数 `subagent_type`（CC Agent
 * tool 字面名）→ 解析为 catalog id → 写入 `def.role`（T2 装配链路已透传到
 * envelope.role → worker 注入 persona 段）。缺省 = `general-purpose`；
 * ajv enum = catalog id 列表（运行时从 resolveAgentCatalog 派生，不写死字面）；
 * 未知值 ajv fail-fast。
 *
 * **依赖注入形态**：工厂收 `manager`（T2 提供）+ `catalog?`（T3 新增，
 * 可选 — 缺省走内部默认 `resolveAgentCatalog`）。装配层
 * `createDefaultAciRegistry` 在 `subagentManager` opts 传入时实例化；
 * 缺席时不装配（`ask` 入口零件场景；与 `memoryDir` / `skillCatalog` 条件化
 * 同形态，registry.ts Gate 3 toolsetNames 镜像过滤）。
 *
 * **append-only**：`name` 与 `ACI_TOOLSET_NAMES` 末位一一对应；不重排既有 23 件。
 *
 * 错误形态（C5 归因表）：
 *   - input 校验失败 → `ToolExecutionError` 同步抛（executor → execution_failed）；
 *   - `background:true` v1 拒收 → `ToolExecutionError`；
 *   - C1 并发超限（manager.spawn 抛 SubAgentCapacityError）→ handler catch →
 *     `ToolExecutionError`（消息含 capacity + active/limit）；
 *   - `ctx.signal` abort → waitFor reject SubAgentAbortError → handler catch →
 *     `ToolExecutionError` → executor 因 `signal.aborted === true` 归一
 *     `execution_failed: "cancelled"`（归因 = 调用侧取消）。
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentDefinition } from "./role.js";
import type { QueryBufferResult, SubAgentManager } from "./manager.js";
import {
  SubAgentAbortError,
  SubAgentCapacityError,
  SubAgentWaitTimeoutError,
} from "./manager.js";
import type { SubAgentEnvelope } from "./envelope.js";
import { projectParentVisibleEnvelope } from "./envelope.js";
import { ToolExecutionError, SubAgentSandboxRootError } from "../errors.js";
import { DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS } from "../../config/settings.js";
import {
  builtinCatalogResolver,
  type AgentCatalogResolver,
} from "./catalog.js";
import { resolveSubagentCapabilities } from "./capability.js";

/**
 * 依赖注入：`manager` 父代理侧子代理生命周期 / 状态机 / buffer / shutdown 链
 * （T2 createSubAgentManager 的输出）。本工具消费 `spawn(def)` 同步入口 +
 * `waitFor(taskId, timeoutMs, signal)` 前景阻塞入口；drain 由 host 侧独占
 * （spec Never 暴露给 agent）。
 *
 * `catalog?` 是 #556 T3 新增 seam：可选 — 缺省走内部默认 `builtinCatalogResolver`
 * （builtin catalog 双面 list + get），production 装配 `registry.ts` 不显式注入
 * （plan T3 决议：registry 职责是工具面，不是 agent 路由 — 不动 registry.ts）。
 * 测试可显式注入 fake resolver 验证 factory 真的在用 deps.catalog。
 */
export interface SpawnSubAgentToolDeps {
  readonly manager: SubAgentManager;
  /**
   * #556 T3: agent catalog resolver (双面 list + get)。
   * 可选 — 缺省 = builtin catalog (`builtinCatalogResolver`)。
   * list() 供 enum + prose list 派生；get(id) 供 handler 单 id 校验。
   */
  readonly catalog?: AgentCatalogResolver;
}

/**
 * waitFor 墙钟拒绝后按 queryBuffer 分流。SubAgentWaitTimeoutError 复用于
 * unknown task / shutdown 清 map / failed-without-envelope / 真墙钟，不能一律合成 timeout。
 */
function envelopeFromWaitTimeout(
  buffer: QueryBufferResult,
  taskId: string
): SubAgentEnvelope {
  // EXIT: not_found — 任务从未存在或 shutdown 已清 map；对模型是调用错误，不是 timeout 数据。
  if (buffer.status === "not_found") {
    throw new ToolExecutionError(
      `spawn_subagent: task ${taskId} not found after wait timeout`
    );
  }
  // EXIT: running — 墙钟到但 worker 未终态；失败是数据（C5）。
  if (buffer.status === "running") {
    return {
      status: "failed",
      reason: "timeout",
      summary: `spawn_subagent: wait timed out while task ${taskId} still running`,
      result: "",
    };
  }
  if (buffer.status === "failed") {
    // EXIT: buffer 已是失败投影（含 protocolError / crashed / timeout envelope）。
    if ("result" in buffer && typeof buffer.result === "string") {
      return projectParentVisibleEnvelope(buffer);
    }
    return {
      status: "failed",
      reason: buffer.reason,
      summary: buffer.summary,
      result: buffer.summary,
    };
  }
  // EXIT: completed ok envelope 已在 buffer。
  return projectParentVisibleEnvelope(buffer);
}

export function createSpawnSubAgentTool(
  deps: SpawnSubAgentToolDeps
): AciToolDef {
  // #556 T3: catalog resolver 闭包 — factory 内部 default = builtin catalog
  // (builtinCatalogResolver 双面 list + get)。registry.ts 不传 catalog, factory
  // 兜底 (plan T3 决议: registry 职责是工具面, 不是 agent 路由)。
  const catalog: AgentCatalogResolver = deps.catalog ?? builtinCatalogResolver;
  const catalogIds = catalog.list().map((e) => e.id);
  const proseLines = catalog
    .list()
    .map((e) => `- ${e.id}: ${e.description}`)
    .join("\n");
  return Object.freeze({
    name: "spawn_subagent",
    description:
      `Delegate a self-contained task when it needs multi-step exploration, independent verification, or parallelizable work. The default subagent type is \`general-purpose\`; use \`explore\` for read-only work. Keep every task self-contained. Default \`wait:true\` — the call blocks until the sub-agent finishes and returns the parent-visible short handoff with summary, changed paths, status, and stop_reason when available (timeout 2 hours default; override via \`timeoutMs\`). Issue multiple \`spawn_subagent\` calls in one turn only for independent tasks. Pass \`wait:false\` for fire-and-forget: returns \`{task_id}\` immediately. In chat/tui/serve, terminal completion wakes the host through the mailbox/subscribe path and starts a silent run; this is the primary completion path. Use \`subagent_result\` only for an explicit status query. At most ${DEFAULT_SUBAGENT_MAX_CONCURRENT_WORKERS} workers run simultaneously by default; when at capacity, reduce concurrency and retry after a worker completes — requests are rejected rather than queued.\n\nAvailable subagent types (set \`subagent_type\` to route):\n` +
      proseLines,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description for the sub-agent.",
        },
        subagent_type: {
          type: "string",
          // #556 T3: enum = catalog ids (运行时 resolveAgentCatalog 派生,
          // 不写死字面)。ajv fail-fast 拒未知 id (typed error 走 ToolExecutionError
          // handler 路径, 见 plan T3 防御契约)。
          enum: catalogIds,
          description:
            "Optional (#556 T3): route the sub-agent through a builtin persona. Pick one of the available subagent types listed above. Omit to keep V1 default behavior (no persona segment, general tool surface).",
        },
        systemPrompt: {
          type: "string",
          description:
            "Optional override for the sub-agent's system prompt section.",
        },
        disallowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Denylist (priority over default). Defaults to ['spawn_subagent'].",
        },
        model: {
          type: "string",
          description:
            "Optional model override (inherits parent default if absent).",
        },
        background: {
          type: "boolean",
          description:
            "Reserved v2 flag — v1 rejects this. Leave undefined or false. Passing true returns ToolExecutionError immediately.",
        },
        wait: {
          type: "boolean",
          description:
            "When true (default), block until the sub-agent finishes and return the parent-visible short handoff (summary, changed paths, status, and stop_reason when available). When false, return {task_id} immediately; in chat/tui/serve, terminal completion wakes a silent run through the host mailbox/subscription. Use subagent_result only for an explicit status query.",
        },
        maxTurns: {
          type: "integer",
          minimum: 1,
          description:
            "Optional: per-sub-agent turn cap; inherits from settings if absent.",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1,
          description:
            "Optional: per-sub-agent wallclock; default 2 hours if absent.",
        },
        sandboxRoot: {
          type: "string",
          description:
            "Optional (#357 T1): restrict the sub-agent to this directory. Must be a path inside the parent sandbox root (realpath-resolved, symlinks must point inside parent). Out-of-range or non-existent paths are rejected before any spawn occurs.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // 工具面归类为 read-only（执行耗时但不改文件系统）—— see ACR verdict 1
      lazy: false, // 常驻 prompt：spawn 是核心能力，discover 没意义
      timeoutTier: "unbounded", // wait:true 寿命 = manager per-task 钟；ACI 不 timer。long(30min) < PER_TASK(2h) 会提前 abort
      isConcurrencySafe: true, // 多个 spawn_subagent 并行调用合法（不同 task_id）
      interruptBehavior: "cancel", // 前景入口；ctx.signal abort → waitFor reject → ToolExecutionError → execution_failed:cancelled
    } as const,
    handler: async (input: unknown, ctx?: ToolExecutionContext) => {
      // input 已由 ajv strict 校验过形状（createAciRegistry 装配时编译）。
      // 此处再做运行时防御：schema 之外的 null / 数组 / 字符串都不应到此。
      const obj = (input ?? {}) as Record<string, unknown>;
      const task = obj.task;
      if (typeof task !== "string" || task.length === 0) {
        throw new ToolExecutionError(
          "spawn_subagent: missing or invalid `task`"
        );
      }
      // v1 拒绝 background:true（spec Code Style 原文 + SC4 acceptance）。
      if (obj.background === true) {
        throw new ToolExecutionError("background:true not implemented in v1");
      }
      // #361：默认值在 handler 内解析（ACI schema 不表达默认值）。缺省 = 前景。
      const wait = obj.wait !== false;
      // #556 T3 / T7: subagent_type → role 解析 (additive)。
      //   - 缺省 (undefined) → catalog.get("general-purpose") (T7 默认角色)
      //   - 已知 id → 写入 def.role (= catalog id, 透传到 envelope.role → worker
      //     装配期查 catalog 取 body 注入 persona 段, T2 链路)
      //   - 未知 id → ajv enum 已在 executor 入口拒;此处 catch 防御 (ajv 漏
      //     网 / 直接调 handler) → 转 ToolExecutionError (不静默吞掉)
      // #556 T3 + Spec review 收口: 捕获 catalog entry 用于 merge disallowedTools
      // —— 否则 explore 角色的 [edit_file, write_file] 不进入 wire,worker 工具
      // 面仍含这两个工具 (T8 acceptance "tool surface 无 edit_file/write_file" 失守)。
      const subagentType = obj.subagent_type;
      if (subagentType !== undefined && typeof subagentType !== "string") {
        // ajv strict 已拒, 此处防御
        throw new ToolExecutionError(
          "spawn_subagent: subagent_type must be a string"
        );
      }
      const requestedRole = subagentType ?? "general-purpose";
      // catalog entry.disallowedTools 与 obj.disallowedTools union (Set 去重)。
      // 两者均缺省 → undefined (V1 baseline,不动 def.disallowedTools 字段)。
      // 仅有 catalog → 应用 catalog deny (e.g. explore → [edit_file, write_file])。
      // 仅有 parent → 应用 parent deny (V1 行为)。
      // 双有 → union,parent 可 ADD 更多 deny,不可 subtract catalog 默认。
      const parentDisallowed = Array.isArray(obj.disallowedTools)
        ? (obj.disallowedTools as ReadonlyArray<string>)
        : undefined;
      let capabilities: ReturnType<typeof resolveSubagentCapabilities>;
      try {
        capabilities = resolveSubagentCapabilities({
          role: requestedRole,
          parentDisallowedTools: parentDisallowed,
          catalog,
        });
      } catch (err) {
        // Preserve the pre-extraction policy: an invalid custom catalog is
        // converted for an explicit type, while the default-role lookup
        // remains a direct typed catalog failure.
        if (subagentType === undefined) throw err;
        throw new ToolExecutionError(
          `spawn_subagent: unknown subagent_type '${subagentType}'`
        );
      }
      if (capabilities.catalogError !== undefined) {
        if (subagentType === undefined) throw capabilities.catalogError;
        throw new ToolExecutionError(
          `spawn_subagent: unknown subagent_type '${subagentType}'`
        );
      }
      const resolvedRole =
        subagentType === undefined
          ? (capabilities.catalogRole ?? requestedRole)
          : requestedRole;
      const mergedDisallowed = capabilities.disallowedTools;
      // 装配 SubAgentDefinition：可选字段透传，缺失字段从 def 上省略（manager
      // 端按 SubAgentDefinition 自身字段约束走 default deny / 默认 maxTurns 等）。
      // #356 High #1 修复：task 必填透传进 def（此前漏掉 → buildWorkerPayload
      // 读到 def.task ?? "" 永远空串 → 子代理跑空任务）。
      // #358 T2: timeoutMs 缺席时整个字段省略 —— 不在此把 percall/常量塞进
      // def.timeoutMs。理由:manager 三层链 `def.timeoutMs ?? env.subagent.
      // taskTimeoutMs ?? PER_TASK_TIMEOUT_MS` 必须让中段（settings 可配的
      // taskTimeoutMs）在模型未显式给 timeout 时生效;若这里永远补死常量,
      // 中段变成死代码(SC4 消费点证明)。
      const def: SubAgentDefinition = {
        task,
        // T4: terminal notices must be attributable to the session that
        // spawned the worker so a TUI session cannot wake another one.
        ...(ctx?.conversationId !== undefined
          ? { conversationId: ctx.conversationId }
          : {}),
        // F-4: 归属回合 —— manager 把它抄进 subagent_spawn / _state_change /
        // _stop 三类 record。ctx 缺 turnId(worker / ask / 直接调 handler)时
        // 字段整个省略,Postel 不落空值。
        ...(ctx?.turnId !== undefined ? { parentTurnId: ctx.turnId } : {}),
        // T5 (plans/session-folder-consolidation.md / SC8): 反查父 loop 那次
        // 工具调用 —— executor 已把 call.id (Anthropic tool_use_id) 装进
        // ctx.toolUseId,manager 把它抄进 .meta.json 的 toolUseId 字段。
        // 缺省(ask / 直调 handler / 测试注入)整字段省略。
        ...(ctx?.toolUseId !== undefined ? { toolUseId: ctx.toolUseId } : {}),
        // #556 T3 / T7: subagent_type 解析结果 (缺省也解析为 general-purpose)
        ...(resolvedRole !== undefined ? { role: resolvedRole } : {}),
        ...(typeof obj.systemPrompt === "string"
          ? { systemPrompt: obj.systemPrompt }
          : {}),
        // #556 T3 + Spec review 收口: catalog entry.disallowedTools 与 parent
        // disallowedTools union 后写入;两者均缺省 → 字段省略 (V1 byte-stable)。
        ...(mergedDisallowed !== undefined
          ? { disallowedTools: mergedDisallowed }
          : {}),
        ...(typeof obj.model === "string" ? { model: obj.model } : {}),
        ...(typeof obj.maxTurns === "number" ? { maxTurns: obj.maxTurns } : {}),
        ...(typeof obj.timeoutMs === "number"
          ? { timeoutMs: obj.timeoutMs }
          : {}),
        // #357 T1: 透传 sandboxRoot;manager.buildWorkerPayload 单点校验 prefix-of-parent。
        ...(typeof obj.sandboxRoot === "string"
          ? { sandboxRoot: obj.sandboxRoot }
          : {}),
      };
      let taskId: string;
      try {
        taskId = deps.manager.spawn(def).taskId;
      } catch (err) {
        // #357 T1: sandboxRoot 越界 / 不存在 → ToolExecutionError(message 面向模型)。
        if (err instanceof SubAgentSandboxRootError) {
          throw new ToolExecutionError(err.message);
        }
        // #361 C1: capacity → ToolExecutionError（消息含 capacity + active/limit）。
        if (err instanceof SubAgentCapacityError) {
          throw new ToolExecutionError(err.message);
        }
        // Fallback: fake / 外部代码抛带 capacity 文案的 Error —— 仍归因。
        if (err instanceof Error && /capacity/i.test(err.message)) {
          throw new ToolExecutionError(err.message);
        }
        throw err;
      }
      // #361 wait:false 异步臂：立即返 {task_id}，不等待。
      if (!wait) {
        return JSON.stringify({ task_id: taskId });
      }
      try {
        // 前景臂： waitFor 缺省走 manager 三层链 (def.timeoutMs ??
        // env.subagent.taskTimeoutMs ?? 7200s)。def 在 handler 内只在模型
        // 显式给 timeoutMs 时携带该字段（缺省省略），故此处传 undefined
        // 让 spawn timer 与 waitFor 的缺省值由同一 effectiveTaskTimeoutMs
        // 链决定 —— 中段 taskTimeoutMs 生效时两者天然对齐。
        const envelope = await deps.manager.waitFor(
          taskId,
          undefined,
          ctx?.signal
        );
        // C5：成功 tool_result = envelope（executor 20000 截断,天然复用）。
        // 失败 envelope 也作 ok 数据返回（失败是数据,非异常;模型读 summary/reason）。
        return projectParentVisibleEnvelope(envelope);
      } catch (err) {
        // #361 C5 abort 归因：ctx.signal abort → ToolExecutionError → executor
        // 因 signal.aborted 归一 execution_failed:cancelled。
        if (err instanceof SubAgentAbortError) {
          throw new ToolExecutionError(
            `spawn_subagent: cancelled (caller aborted while waiting for task ${err.taskId})`
          );
        }
        // concurrent: ACI/caller abort 与 wait poll 竞态时 abort 优先，
        // 不把 WaitTimeoutError 合成 timeout envelope。
        if (ctx?.signal?.aborted) {
          throw new ToolExecutionError(
            "spawn_subagent: cancelled by caller abort"
          );
        }
        if (err instanceof SubAgentWaitTimeoutError) {
          return envelopeFromWaitTimeout(
            deps.manager.queryBuffer(taskId),
            taskId
          );
        }
        throw err;
      }
    },
  });
}
