/**
 * #356 T4 / #361 V1.5 — spawn_subagent ACI 工具（主代理第 24/25 件之一）。
 *
 * **#361 前景 spawn 反转（ADR-0014 V1.5）**：默认 `wait:true` — 模型调一次 →
 * handler `await manager.waitFor(taskId, PER_TASK_TIMEOUT_MS, ctx.signal)`，
 * 阻塞至子代理终态，把完整 envelope 直接作 tool_result 返回。多个独立任务
 * 可在同一 turn 并行发多条 spawn_subagent（wait:true 各自阻塞，executor
 * 并发安全）。`wait:false` → 立即返 `{task_id}`（异步臂），结果由 host drain
 * 在下一轮 turn 拼入 user message / subagent_result 主动拉取。
 *
 * **依赖注入形态**：工厂收 `manager`（T2 提供）。装配层
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
 *     `ToolExecutionError`（消息含 capacity + 4/4）；
 *   - `ctx.signal` abort → waitFor reject SubAgentAbortError → handler catch →
 *     `ToolExecutionError` → executor 因 `signal.aborted === true` 归一
 *     `execution_failed: "cancelled"`（归因 = 调用侧取消）。
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentDefinition } from "./role.js";
import type { SubAgentManager } from "./manager.js";
import {
  PER_TASK_TIMEOUT_MS,
  SubAgentAbortError,
  SubAgentCapacityError,
} from "./manager.js";
import { ToolExecutionError, SubAgentSandboxRootError } from "../errors.js";

/**
 * 依赖注入：`manager` 父代理侧子代理生命周期 / 状态机 / buffer / shutdown 链
 * （T2 createSubAgentManager 的输出）。本工具消费 `spawn(def)` 同步入口 +
 * `waitFor(taskId, timeoutMs, signal)` 前景阻塞入口；drain 由 host 侧独占
 * （spec Never 暴露给 agent）。
 */
export interface SpawnSubAgentToolDeps {
  readonly manager: SubAgentManager;
}

export function createSpawnSubAgentTool(
  deps: SpawnSubAgentToolDeps
): AciToolDef {
  return Object.freeze({
    name: "spawn_subagent",
    description:
      "Delegate multi-step exploration, independent verification, or parallelizable work to a fresh sub-agent that inherits the parent's tool surface minus `spawn_subagent`. Default wait:true — the call blocks until the sub-agent finishes and returns its full result envelope (timeout 5 min default; override via timeoutMs). Issue multiple `spawn_subagent` calls in one turn to run independent tasks in parallel. Pass wait:false to run fire-and-forget: returns `{task_id}` immediately, poll later via subagent_result. Sub-agent v1 caps at one level — nested `spawn_subagent` inside a child agent returns ToolExecutionError.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description for the sub-agent.",
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
            "When true (default), block until the sub-agent finishes and return its full result envelope. When false, return {task_id} immediately and poll with subagent_result.",
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
            "Optional: per-sub-agent wallclock; default 5 min if absent.",
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
      timeoutTier: "long", // #361 前景臂：wait:true 阻塞至子代理终态（≤5min），tier 必须 ≥ PER_TASK_TIMEOUT_MS；"fast" 5s 会提前砍前景
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
      // 装配 SubAgentDefinition：可选字段透传，缺失字段从 def 上省略（manager
      // 端按 SubAgentDefinition 自身字段约束走 default deny / 默认 maxTurns 等）。
      // #356 High #1 修复：task 必填透传进 def（此前漏掉 → buildWorkerPayload
      // 读到 def.task ?? "" 永远空串 → 子代理跑空任务）。
      // #361 T13: timeoutMs 缺席时默认 PER_TASK_TIMEOUT_MS(5min),使 worker
      // 侧 wallclock 与前景 wait 对齐(注释 vs 实际 30s 不一致修复)。
      const def: SubAgentDefinition = {
        task,
        ...(typeof obj.systemPrompt === "string"
          ? { systemPrompt: obj.systemPrompt }
          : {}),
        ...(Array.isArray(obj.disallowedTools)
          ? { disallowedTools: obj.disallowedTools as ReadonlyArray<string> }
          : {}),
        ...(typeof obj.model === "string" ? { model: obj.model } : {}),
        ...(typeof obj.maxTurns === "number" ? { maxTurns: obj.maxTurns } : {}),
        ...(typeof obj.timeoutMs === "number"
          ? { timeoutMs: obj.timeoutMs }
          : { timeoutMs: PER_TASK_TIMEOUT_MS }),
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
        // #361 C1: capacity → ToolExecutionError（消息含 capacity + 4/4）。
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
        // 前景臂：显式 PER_TASK_TIMEOUT_MS(300s)——绝不能落 waitFor 缺省
        //（manager 旧缺省 30s,前景等分钟级会提前崩）。
        const envelope = await deps.manager.waitFor(
          taskId,
          PER_TASK_TIMEOUT_MS,
          ctx?.signal
        );
        // C5：成功 tool_result = envelope（executor 20000 截断,天然复用）。
        // 失败 envelope 也作 ok 数据返回（失败是数据,非异常;模型读 summary/reason）。
        return envelope;
      } catch (err) {
        // #361 C5 abort 归因：ctx.signal abort → ToolExecutionError → executor
        // 因 signal.aborted 归一 execution_failed:cancelled。
        if (err instanceof SubAgentAbortError) {
          throw new ToolExecutionError(
            `spawn_subagent: cancelled (caller aborted while waiting for task ${err.taskId})`
          );
        }
        // Fallback: ctx.signal 已 abort → 仍归因 cancelled(fake 用 plain Error
        // 配 name="SubAgentAbortError" 时走这条)。
        if (ctx?.signal?.aborted) {
          throw new ToolExecutionError(
            "spawn_subagent: cancelled by caller abort"
          );
        }
        throw err;
      }
    },
  });
}
