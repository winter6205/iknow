/**
 * 019 T3 demo 工具:真实可执行、非业务演示 ToolDef。
 *
 * 用途:
 *   - 为 019 real Anthropic adapter smoke(i9)提供最小真实工具集,
 *     验证 harness 在真实流量下的多 step 闭环(echo + get_time)。
 *   - 作为 ToolDef 构造范例:schema additionalProperties:false 守
 *     validation_failed 回环;handler 对 unknown input narrow 断言后
 *     返字符串(Executor 经 safeContent 编码为 model-facing payload)。
 *
 * 边界:
 *   - 纯函数,无状态,无 IO(echo 透传;get_time 仅 new Date().toISOString());
 *   - 不接 ctx.signal(017 S17 vehicle 仍是 stub-signal-tool,不在此重复);
 *   - 不 export 注册后的 Registry;装配由 smoke 自行 createRegistry([...])。
 */

import type { ToolDef } from "../tools/types.js";
import { ToolExecutionError } from "../errors.js";

/**
 * echo:回显输入文本。
 * schema additionalProperties:false -> 模型传额外字段时 Executor 走 validation_failed,
 * 不进入 handler。handler 内仍对 input.text 做 narrow 断言(TS 层 input 是 unknown)。
 */
export function createEchoTool(): ToolDef {
  return Object.freeze({
    name: "echo",
    description: "echo back the input text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (input: unknown) => {
      const t = (input as { text?: unknown }).text;
      if (typeof t !== "string") {
        // ajv 已保证 text 是 string;此断言守住运行时意外输入。
        throw new ToolExecutionError("echo: text must be string");
      }
      return t;
    },
  });
}

/**
 * get_time:返回当前 ISO 时间戳。
 * 无参数;additionalProperties:false 拒绝任何 input 字段。
 */
export function createGetTimeTool(): ToolDef {
  return Object.freeze({
    name: "get_time",
    description: "return current ISO timestamp",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    handler: async () => new Date().toISOString(),
  });
}
