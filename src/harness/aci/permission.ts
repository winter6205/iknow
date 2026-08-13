/**
 * ACI 能力层：权限检查兼容入口（毕业过渡）。
 *
 * 决策与决策对象已迁至 `src/harness/permission/`（#122）；
 * 本文件保留 allowlist / 危险命令识别工具（`isAllowedCommand` /
 * `isDangerousCommand` / `firstToken` / `SHELL_METACHARS`）作为纵深双保险
 * （硬墙只引用危险模式 + 敏感路径；非白名单命令落入 ask，执行期边界由 bwrap 承担）。
 *
 * `checkPermission` 现已迁出至 `permission/checkPermission`（5 步中间件链在
 * `permission/permission-executor.ts`）。为避免破坏既有测试 / 工具代码，
 * 这里 re-export `createPermissionPolicy` / `checkPermission` 的纯函数形态，
 * 与 020 之前的 prototype API 形态保持兼容。
 *
 * 也保留原有 prototype 的 `createPermissionPolicy({defaultRule, byName})`
 * 入参形态作为薄包装（内部映射至新 `createPermissionPolicy`）。
 */

import type {
  AskUser,
  PreHookBlock,
  PreToolUseHook,
  PostToolUseHook,
  PermissionOutcome,
  NormalRuleSpec,
} from "../permission/types.js";
import {
  createPermissionPolicy as createPolicyV2,
  checkPermission as checkPermissionV2,
  type PermissionPolicy as PolicyV2,
} from "../permission/policy.js";

/* -----------------------------------------------------------------------------
 * Prototype-shape thin wrapper for createPermissionPolicy
 * -------------------------------------------------------------------------- */

/** Projection of the prototype AciPermissionPolicy (defaultRule/byName). */
export interface ProtoPermissionPolicy {
  readonly defaultRule?: "allow" | "ask";
  readonly byName?: Readonly<Record<string, "allow" | "deny" | "ask">>;
}

/**
 * Back-compat: prototype callers passing `{ defaultRule, byName }` keep
 * working. Internally we map byName into normal session-style rules at
 * codeBuiltInRules slot (highest-precedence normal layer in v0 = code; the
 * wrapper injects into session so they override built-ins consistently).
 */
export function createPermissionPolicy(opts?: ProtoPermissionPolicy): PolicyV2 {
  const sessionRules: NormalRuleSpec[] = [];
  if (opts?.byName) {
    for (const [name, decision] of Object.entries(opts.byName)) {
      if (decision === "allow" || decision === "deny" || decision === "ask") {
        sessionRules.push({
          id: `proto-byname-${name}`,
          match: ({ tool }) => tool === name,
          decision,
          reason: `prototype byName: ${name} → ${decision}`,
        });
      }
    }
  }
  // defaultRule overrides category behavior; v0 simplified — see policy.ts
  const overrides = opts?.defaultRule
    ? {
        "read-only":
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
        write:
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
        execute:
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
        collaborate:
          opts.defaultRule === "allow" ? ("allow" as const) : ("ask" as const),
      }
    : undefined;
  return createPolicyV2({
    ...(sessionRules.length
      ? {
          session: {
            kind: "session" as const,
            rules: () => Object.freeze(sessionRules),
          },
        }
      : {}),
    ...(overrides ? { defaultByCategory: overrides } : {}),
  });
}

/**
 * Back-compat: pass to permission-executor / policy layer. v0 prototype callers
 * receive a wrapped shape; the prototype AciPermissionPolicy interface is no
 * longer exported as a fresh type (see types.ts re-export to PermissionPolicy).
 */
export type AciPermissionPolicyShape = PolicyV2;

/* -----------------------------------------------------------------------------
 * Bash allowlist surface (retained for bash.ts)
 * -------------------------------------------------------------------------- */

export {
  isAllowedCommand,
  isDangerousCommand,
  findDangerousPattern,
  firstToken,
  commandContainsSensitivePath,
} from "../permission/hard-walls.js";

/* -----------------------------------------------------------------------------
 * checkPermission (thin compat wrapper)
 * -------------------------------------------------------------------------- */

/** Legacy entry: takes {def, input, policy} with prototype policy shape. */
export function checkPermission(opts: {
  def: import("./types.js").AciToolDef;
  input: unknown;
  policy: PolicyV2;
}): PermissionOutcome {
  return checkPermissionV2({
    def: opts.def,
    input: opts.input,
    sources: opts.policy.sources,
    hardWalls: opts.policy.hardWalls,
    defaultByCategory: opts.policy.defaultByCategory,
  });
}

/* -----------------------------------------------------------------------------
 * Re-export from permission/ so the prototype import surface stays stable.
 * -------------------------------------------------------------------------- */

export type { AskUser, PreHookBlock, PreToolUseHook, PostToolUseHook };
