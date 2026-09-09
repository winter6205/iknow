/**
 * #356 T5 — subagent_result ACI 工具（主代理第 25/25 件）。
 *
 * 模型用 `spawn_subagent` 拿到 `task_id` 后，用本工具轮询 `SubAgentManager`
 * 四态 buffer：not_found / running / completed / failed（父可见短交差以
 * summary / paths / status / stop_reason 为中心）。与 spawn 一样同步非阻塞
 * （≤10ms），直返 `manager.queryBuffer(taskId)` 的序列化结果；不做 sleep /
 * 不 await——
 * 轮询节奏由模型侧自主决定（completed 结果 host drain 也会在下一轮 turn
 * 拼入 user message，本工具是主动拉取面）。
 *
 * **依赖注入形态**：工厂收 `manager`（T2 提供）。装配层
 * `createDefaultAciRegistry` 在 `subagentManager` opts 传入时实例化；
 * 缺席时不装配（与 spawn_subagent 同形态，registry.ts Gate 3 镜像过滤）。
 *
 * **append-only**：`name` 与 `ACI_TOOLSET_NAMES` 末位一一对应；spawn_subagent
 * 在前、本工具在最后，不重排既有 24 件。
 *
 * 错误形态：`ToolExecutionError` 同步抛（input 校验失败），由 aci-executor
 * 包成 `execution_failed` result 反馈给模型。
 */
import type { AciToolDef } from "../aci/types.js";
import type { ToolExecutionContext } from "../tools/types.js";
import type { SubAgentManager } from "./manager.js";
import type { PadQueryResult } from "./pad-inspect.js";
import { projectParentVisibleEnvelope } from "./envelope.js";
import { ToolExecutionError } from "../errors.js";

/**
 * 依赖注入：`manager` 父代理侧子代理生命周期 / 状态机 / buffer / shutdown 链
 * （T2 createSubAgentManager 的输出）。本工具仅消费 `queryBuffer(taskId)`
 * 同步四态查询；waitFor / drain 由 host 侧独占（spec Never 暴露给 agent）。
 */
export interface SubAgentResultToolDeps {
  readonly manager: SubAgentManager;
}

function serializePoll(
  result: ReturnType<SubAgentManager["queryBuffer"]>
): object {
  if (
    result.status === "ok" ||
    (result.status === "failed" &&
      "result" in result &&
      typeof result.result === "string")
  ) {
    return projectParentVisibleEnvelope(result);
  }
  return result;
}

function parseTmpPath(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ToolExecutionError("subagent_result: invalid `tmp_path`");
  }
  return raw.length > 0 ? raw : undefined;
}

function serializePadOrPoll(
  result: ReturnType<SubAgentManager["queryBuffer"]>,
  pad: PadQueryResult,
  tmpPath: string | undefined
): string {
  if (pad.status === "not_found") {
    return JSON.stringify({ status: "not_found" });
  }
  if (pad.status === "rejected") {
    return JSON.stringify({ status: "rejected", reason: pad.reason });
  }
  if (pad.status === "read") {
    return JSON.stringify({
      status: "ok",
      tmp_path: tmpPath,
      content: pad.content,
      truncated: pad.truncated,
    });
  }
  return JSON.stringify({
    ...serializePoll(result),
    tmp_names: pad.names,
  });
}

export function createSubAgentResultTool(
  deps: SubAgentResultToolDeps
): AciToolDef {
  return Object.freeze({
    name: "subagent_result",
    description:
      "Poll a sub-agent that was spawned with wait:false (or re-check after a wait:true completion); sync non-blocking, call again later to re-poll. Returns one JSON object whose parent-visible short handoff centers on `status`, `summary`, changed paths (`fileRefs`), and `stop_reason` when available: `status` ∈ `not_found` (no such task — unknown or expired id) / `running` / `completed` / `failed` (failed reports `reason` and `summary`). With only `task_id`, also lists top-level names on that worker's fence `/tmp` pad (`tmp_names`). Optional relative `tmp_path` reads one pad file (truncation same as read_file); `..` or pad escape is a typed reject.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task_id returned by spawn_subagent.",
        },
        tmp_path: {
          type: "string",
          description:
            "Optional path relative to that worker's fence /tmp pad. Omit to list top-level names; pass to read one file.",
        },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only", // 查询面只读 buffer，不产生副作用
      isConcurrencySafe: true, // 多个 task_id 并行轮询合法
      interruptBehavior: "cancel", // 同步入口；signal 来时直接弃查询
      timeoutTier: "fast", // 同步查询 buffer 极快（≤10ms）
      lazy: false, // 常驻 prompt：poll 是核心能力，discover 没意义
    } as const,
    handler: (input: unknown, _ctx?: ToolExecutionContext) => {
      // input 已由 ajv strict 校验过形状（createAciRegistry 装配时编译）。
      // 此处再做运行时防御：schema 之外的 null / 数组 / 字符串都不应到此。
      const obj = (input ?? {}) as Record<string, unknown>;
      const taskId = obj.task_id;
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new ToolExecutionError(
          "subagent_result: missing or invalid `task_id`"
        );
      }
      const tmpPath = parseTmpPath(obj.tmp_path);
      // 同步非阻塞：queryBuffer + queryPad（无 waitFor / drain）。
      const result = deps.manager.queryBuffer(taskId);
      if (result.status === "not_found") {
        return JSON.stringify({ status: "not_found" });
      }
      const queryPad = deps.manager.queryPad;
      if (queryPad !== undefined) {
        return serializePadOrPoll(result, queryPad(taskId, tmpPath), tmpPath);
      }
      return JSON.stringify(serializePoll(result));
    },
  });
}
