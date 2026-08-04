/**
 * ACI 能力层：装饰执行器（毕业过渡）。
 *
 * 5-step middleware (preToolUse → checkPermission → askUser → inner → postToolUse)
 * 现已在 `src/harness/permission/permission-executor.ts` 实现；本文件保留
 * 原型 API（createAciExecutor / AciExecutorOptions / onDecision 观测钩子），
 * 内部转调到新的 PermissionExecutor。
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
  Registry,
} from "../tools/types.js";
import type { PermissionOutcome } from "../permission/types.js";
import {
  createPermissionExecutor,
  type PermissionExecutorOptions,
} from "../permission/permission-executor.js";
import { createAciCatalog } from "../permission/permission-executor.js";
import { createPermissionPolicy } from "./permission.js";

export interface AciExecutorOptions {
  readonly inner: Executor;
  readonly catalog?: import("./types.js").AciCatalog;
  readonly policy?: ReturnType<typeof createPermissionPolicy>;
  /** Legacy shape compat: when no registry/catalog passed, build catalog from registry. */
  readonly registry?: Registry;
  /** Optional askUser injection (defaults to no-ask for prototype/test callers). */
  readonly askUser?: PermissionExecutorOptions["askUser"];
  /** Optional hooks; default no-op. */
  readonly hooks?: {
    readonly preToolUse?: PermissionExecutorOptions["preToolUse"];
    readonly postToolUse?: PermissionExecutorOptions["postToolUse"];
  };
  /** 观测钩子：每次权限决策回调（demo/测试用，不参与决策）。 */
  readonly onDecision?: (call: ToolCall, outcome: PermissionOutcome) => void;
}

/**
 * Decorate inner Executor with the 5-step permission middleware.
 * Back-compat shim: built on top of permission/permission-executor so the
 * prototype tests (which import from aci/) keep passing without changing their
 * call sites.
 */
export function createAciExecutor(opts: AciExecutorOptions): Executor {
  const policy = opts.policy ?? createPermissionPolicy();
  // Build a registry-compatible surface: if catalog was passed, wrap it as a
  // Registry. Otherwise expect opts.registry to have been provided.
  let registry: Registry | undefined = opts.registry;
  if (!registry && opts.catalog) {
    const all = opts.catalog.all();
    registry = Object.freeze({
      list: () => all,
      get: (name: string) => opts.catalog!.get(name),
    });
  }
  if (!registry) {
    throw new Error(
      "createAciExecutor: either `catalog` or `registry` must be provided"
    );
  }
  const askUser = opts.askUser ?? (async () => true); // prototype default: no-ask approve
  const executor = createPermissionExecutor({
    inner: opts.inner,
    registry,
    policy,
    askUser,
    preToolUse: (ctx) => {
      // prototype had no preToolUse; v0 keeps backward behavior (always undefined).
      // onDecision is recorded separately via middleware below.
      return opts.hooks?.preToolUse?.(ctx);
    },
    postToolUse: opts.hooks?.postToolUse,
  });
  // Wrap executeAll to fire onDecision (legacy observational hook).
  if (!opts.onDecision) return executor;
  const onDecision = opts.onDecision;
  return Object.freeze({
    executeAll: async (
      calls: ReadonlyArray<ToolCall>,
      signal?: AbortSignal,
      timeoutMs?: number
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      // The 5-step middleware already records postToolUse results. To preserve
      // legacy onDecision semantics (fires regardless of decision), we replay
      // checkPermission here for each call. The actual decision still comes
      // from the middleware — this is purely observational.
      // (Prototype tests assert onDecision fires for each call.)
      const catalog = createAciCatalog(registry!);
      for (const call of calls) {
        const def = catalog.get(call.name);
        if (!def) {
          // unknown tool → decision defaults to allow (delegated to inner)
          onDecision(call, {
            decision: "allow",
            reason: "unknown tool — delegated to inner",
          });
          continue;
        }
        // Best-effort observation; if hard-wall triggers, the middleware will
        // still emit the corresponding execution_failed result.
        const { checkPermission } = await import("../permission/policy.js");
        const outcome = checkPermission({
          def,
          input: call.input,
          sources: policy.sources,
          hardWalls: policy.hardWalls,
          defaultByCategory: policy.defaultByCategory,
        });
        onDecision(call, outcome);
      }
      return executor.executeAll(calls, signal, timeoutMs);
    },
  });
}
