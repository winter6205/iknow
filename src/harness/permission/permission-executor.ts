/**
 * src/harness/permission/permission-executor.ts
 *
 * 5-step middleware executor (spec plan T2 D1 / D2):
 *
 *   1. preToolUse(call, def)           [hook — may short-circuit]
 *   2. checkPermission({def, input})   [pure resolver: hard-walls → layers → default]
 *   3. askUser({tool, input, hint})    [only when decision = ask]
 *   4. inner.executeAll([call])        [only when decision = allow]
 *   5. postToolUse(result)             [hook — observability only]
 *
 * deny → push execution_failed, never call inner (zero side effect).
 */

import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
  Registry,
} from "../tools/types.js";
import type { AciCatalog, AciToolDef } from "../aci/types.js";
import { checkPermission, type PermissionPolicy } from "./policy.js";
import { VIOLATION_PREFIXES } from "./prefixes.js";
import type { AskUser, PreToolUseHook, PostToolUseHook } from "./types.js";

// Permission-executor prefixes consumed from the SSOT table. Keeping a local
// const alias preserves the call-site ergonomics (no template-literal drift).
const USER_DENIED_PREFIX = VIOLATION_PREFIXES.userDenied;
const PERMISSION_DENIED_PREFIX = VIOLATION_PREFIXES.permissionDenied;
const HOOK_BLOCKED_PREFIX = VIOLATION_PREFIXES.hookBlocked;

/**
 * Build an AciCatalog from a ToolRegistry by name. v0 the catalog is
 * "ACI-aware" only via category / interruptBehavior / isConcurrencySafe;
 * tools lacking AciMeta are treated as read-only safe-by-default.
 */
export function createAciCatalog(registry: Registry): AciCatalog {
  const list = registry.list();
  const byName = new Map<string, AciToolDef>();
  for (const def of list) {
    const aci = (def as { aci?: AciToolDef["aci"] }).aci;
    if (!aci) continue;
    byName.set(
      def.name,
      Object.freeze({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        handler: def.handler,
        aci: Object.freeze({
          category: aci.category,
          isConcurrencySafe: aci.isConcurrencySafe,
          interruptBehavior: aci.interruptBehavior,
        }),
      }) as AciToolDef
    );
  }
  return Object.freeze({
    get: (name: string) => byName.get(name),
    all: () => Object.freeze([...byName.values()]) as ReadonlyArray<AciToolDef>,
  });
}

export interface PermissionExecutorOptions {
  readonly inner: Executor;
  readonly registry: Registry;
  readonly policy: PermissionPolicy;
  readonly askUser: AskUser;
  readonly preToolUse?: PreToolUseHook;
  readonly postToolUse?: PostToolUseHook;
}

/**
 * Factory for the permission-middleware Executor. Per-call rules:
 *  - catalog miss → delegate to inner one call at a time.
 *  - hook_blocked → execution_failed with [hook_blocked] prefix.
 *  - deny → execution_failed [permission_denied] prefix, inner not called.
 *  - ask → await askUser; false → execution_failed [user_denied] prefix.
 *  - allow → inner.executeAll([call]) and return its single result.
 */
export function createPermissionExecutor(
  opts: PermissionExecutorOptions
): Executor {
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

  async function executeAll(
    calls: ReadonlyArray<ToolCall>,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<ReadonlyArray<ToolExecutionResult>> {
    const out: ToolExecutionResult[] = [];
    for (const call of calls) {
      const def = catalog.get(call.name);

      // Step 0: catalog miss → delegate to inner one-at-a-time
      if (!def) {
        const [result] = await opts.inner.executeAll([call], signal, timeoutMs);
        out.push(result as ToolExecutionResult);
        continue;
      }

      // Step 1: preToolUse hook
      const hookDecision = pre({ tool: def.name, input: call.input });
      if (hookDecision !== undefined) {
        out.push({
          kind: "execution_failed",
          toolUseId: call.id,
          message: `${HOOK_BLOCKED_PREFIX} ${hookDecision.reason}`,
        });
        continue;
      }

      // Step 2: checkPermission (hard walls → layers → default)
      const outcome = checkPermission({
        def,
        input: call.input,
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });

      // Step 3: ask path
      if (outcome.decision === "ask") {
        const hint = summarizeInput(call.input);
        const approved = await askUser({
          tool: def.name,
          input: call.input,
          summaryHint: hint,
        });
        if (!approved) {
          out.push({
            kind: "execution_failed",
            toolUseId: call.id,
            message: `${USER_DENIED_PREFIX} user declined tool call: ${def.name}`,
          });
          continue;
        }
        // user approved → fall through to allow
      } else if (outcome.decision === "deny") {
        // Step 4 zero-side-effect: don't call inner
        out.push({
          kind: "execution_failed",
          toolUseId: call.id,
          message: `${PERMISSION_DENIED_PREFIX} ${outcome.reason}`,
        });
        continue;
      }

      // Step 4: allow → delegate to inner
      const [result] = await opts.inner.executeAll([call], signal, timeoutMs);
      out.push(result as ToolExecutionResult);

      // Step 5: postToolUse hook (fire-and-forget)
      const r = result as ToolExecutionResult;
      const message =
        r.kind === "execution_failed" || r.kind === "validation_failed"
          ? r.message
          : undefined;
      const payload = r.kind === "ok" ? r.payload : undefined;
      post({
        toolUseId: r.toolUseId,
        name: def.name,
        input: call.input,
        kind: r.kind,
        message,
        payload,
      });
    }
    return out;
  }

  return Object.freeze({ executeAll });
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
