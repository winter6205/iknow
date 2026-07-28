/**
 * Stub tool (T4):Foundation 的替身 ToolDef。
 *
 * 接受 next() 回调生成返回值或抛出,完全确定性,无时间 / 随机 / IO 依赖;
 * 仅供测试。`next` 与 Tool/Adapter 接口一致,Executor 把它当作真实工具
 * 来严格校验 + 执行。
 */

import type { ToolDef } from "../tools/types.js";

export interface StubToolOptions {
  readonly name: string;
  /** 接收 input 返回值或抛出,完全确定性。 */
  readonly next: (input: unknown) => unknown;
  /** 可选 JSON Schema。默认接受任意对象(测试替身不在 Gate A 严管之列)。 */
  readonly inputSchema?: Record<string, unknown>;
}

export function createStubTool(opts: StubToolOptions): ToolDef {
  return Object.freeze({
    name: opts.name,
    description: `stub ${opts.name}`,
    inputSchema: opts.inputSchema ?? { type: "object" },
    handler: (async (input: unknown) => opts.next(input)) as ToolDef["handler"],
  });
}