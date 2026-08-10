/**
 * #356 T4 — spawn_subagent ACI 工具（主代理第 24/25 件之一）。
 *
 * 模型调一次 → 同步返 `{task_id}` JSON（≤50ms，handler 不阻塞）→
 * 子进程独立跑完整 loop，父代理立即推下一轮。结果由 `SubAgentManager`
 * 收口（queryBuffer / waitFor / drainCompleted），host drain 在下一轮 turn
 * 把 completed envelope 拼入 user message。
 *
 * **依赖注入形态**：工厂收 `manager`（T2 提供）。装配层
 * `createDefaultAciRegistry` 在 `subagentManager` opts 传入时实例化；
 * 缺席时不装配（`ask` 入口零件场景；与 `memoryDir` / `skillCatalog` 条件化
 * 同形态，registry.ts Gate 3 toolsetNames 镜像过滤）。
 *
 * **append-only**：`name` 与 `ACI_TOOLSET_NAMES` 末位一一对应；不重排既有 23 件。
 *
 * 错误形态：`ToolExecutionError` 同步抛（input 校验失败 / `background:true`
 * v1 拒收），由 aci-executor 包成 `execution_failed` result 反馈给模型。
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentDefinition } from "./role.js";
import type { SubAgentManager } from "./manager.js";
import { ToolExecutionError } from "../errors.js";

/**
 * 依赖注入：`manager` 父代理侧子代理生命周期 / 状态机 / buffer / shutdown 链
 * （T2 createSubAgentManager 的输出）。本工具仅消费 `spawn(def) → {taskId}`
 * 同步入口；buffer / waitFor / drain 由 host 侧独占（spec Never 暴露给 agent）。
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
      "Spawn a sub-agent to explore / verify in a separate process. Returns a task_id immediately; the sub-agent runs concurrently while the main loop continues. Use subagent_result(task_id) to poll status; completed results are auto-injected into the next turn as a user message (host drain). Pass system_prompt to scope the sub-agent's role; pass disallowed_tools to deny write tools (e.g. ['edit_file','write_file'] for a verifier). v1 forbids nested spawn_subagent — sub-agent worker processes cannot spawn further sub-agents.",
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
      },
      required: ["task"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // 工具面归类为 read-only（执行耗时但不改文件系统）—— see ACR verdict 1
      lazy: false, // 常驻 prompt：spawn 是核心能力，discover 没意义
      timeoutTier: "fast", // 同步返 task_id 极快；真实等待由 host drain 异步接管
      isConcurrencySafe: true, // 多个 spawn_subagent 并行调用合法（不同 task_id）
      interruptBehavior: "cancel", // 同步入口；signal 来时直接弃 task
    } as const,
    handler: (input: unknown, _ctx?: ToolExecutionContext) => {
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
      // 装配 SubAgentDefinition：可选字段透传，缺失字段从 def 上省略（manager
      // 端按 SubAgentDefinition 自身字段约束走 default deny / 默认 maxTurns 等）。
      // #356 High #1 修复：task 必填透传进 def（此前漏掉 → buildWorkerPayload
      // 读到 def.task ?? "" 永远空串 → 子代理跑空任务）。
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
          : {}),
      };
      const { taskId } = deps.manager.spawn(def);
      return JSON.stringify({ task_id: taskId });
    },
  });
}
