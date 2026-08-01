/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：装饰执行器。
 *
 * 验证问题：权限检查（ch04 阶段④）能否以装饰器模式包在冻结 Executor 外，
 * deny 路径不调 inner（零副作用），allow/pass_through 委托 inner 执行。
 * 不修改协议；串行、无短路、无自动重试（deferred：原型只验证装饰形状，
 * explicitly not 构建并发调度或失败恢复层）。
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../tools/types.js";
import type {
  AciCatalog,
  AciPermissionPolicy,
  PermissionOutcome,
} from "./types.js";
import { checkPermission, createPermissionPolicy } from "./permission.js";

export interface AciExecutorOptions {
  readonly inner: Executor;
  readonly catalog: AciCatalog;
  readonly policy?: AciPermissionPolicy;
  /** 观测钩子：每次权限决策回调（demo/测试用，不参与决策）。 */
  readonly onDecision?: (call: ToolCall, outcome: PermissionOutcome) => void;
}

/**
 * 装饰 inner Executor，在执行前注入权限检查（阶段④）。
 *
 * 逐个 call 串行处理（保持 calls 顺序，无短路）：
 *   - catalog 查不到 → 交给 inner（inner 产 tool_not_found）；
 *   - checkPermission → deny → 直接产 execution_failed，不调 inner；
 *   - allow / pass_through → await inner.executeAll([call], signal, timeoutMs) 取唯一结果。
 * 每次决策调 onDecision（观测用，不影响决策）。
 */
export function createAciExecutor(opts: AciExecutorOptions): Executor {
  const { inner, catalog } = opts;
  const policy: AciPermissionPolicy = opts.policy ?? createPermissionPolicy();
  const onDecision = opts.onDecision;

  async function executeAll(
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const call of calls) {
      const def = catalog.get(call.name);
      if (!def) {
        // 未知工具：交给 inner，由 inner 产 tool_not_found。
        const [result] = await inner.executeAll([call], signal, timeoutMs);
        out.push(result as ToolExecutionResult);
        continue;
      }
      const outcome = checkPermission({ def, input: call.input, policy });
      onDecision?.(call, outcome);
      if (outcome.decision === "deny") {
        // deny：不调 inner，直接产结构化失败（message 带 [permission_denied] 前缀）。
        out.push({
          kind: "execution_failed",
          toolUseId: call.id,
          message: `[permission_denied] ${outcome.reason}`,
        });
        continue;
      }
      // allow / pass_through：委托 inner 执行单个 call，取唯一结果。
      const [result] = await inner.executeAll([call], signal, timeoutMs);
      out.push(result as ToolExecutionResult);
    }
    return out;
  }

  return Object.freeze({ executeAll });
}
