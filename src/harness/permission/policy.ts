import type { AciToolDef } from "../aci/types.js";
import {
  hardWalls,
  HARD_WALL_DENY_PREFIX,
  type HardWallId,
} from "./hard-walls.js";
import type {
  CodeBuiltInPolicySource,
  HardRuleSpec,
  NormalRuleSpec,
  PermissionOutcome,
  PermissionSource,
  ProjectSettingsPolicySource,
  SessionGrantsPolicySource,
  ToolCategory,
} from "./types.js";
import {
  asModeContext,
  type PermissionMode,
  type PermissionModeContext,
} from "./modes.js";

export type CategoryDefault = "allow" | "ask" | "ask+hardwall";

export const DEFAULT_BY_CATEGORY: Readonly<
  Record<ToolCategory, CategoryDefault>
> = Object.freeze({
  "read-only": "allow",
  write: "ask",
  execute: "ask",
  collaborate: "ask",
});

/**
 * #503 T10 / ADR-0022 — bash network:true 命中判定的 input 侧 shape check
 * （不含 tool gate）。isBashNetworkTrue（规则/permission-executor 共用 SSOT）
 * 与 project-settings.ts 的 `network_equals` 谓词共用这一个函数，保证
 * 「决策来源」「hint 形态」「项目层谓词」三处严格 === true 语义不再漂移。
 * 命中条件：input.network 严格 === true（非布尔 "true" / 缺省 / false →
 * 不命中）。tool gate（tool === "bash"）由各调用方承担：isBashNetworkTrue
 * 显式检查 tool；project-settings 的 buildRuleMatcher 已先检查
 * `ctx.tool === toolName`（match_tool = "bash" 规则），故进入谓词的
 * inputObj 必然来自 bash 调用，此处 shape check 与全谓词等价。
 */
export function isBashNetworkInput(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    (input as { network?: unknown }).network === true
  );
}

/**
 * #503 T10 / ADR-0022 — bash network:true 命中判定（SSOT，review-repair
 * #502/#503）。规则 `code-ask-bash-network`（policy.ts）与
 * permission-executor.ts 的 hint 判定（isNetworkBash）共用同一函数：
 * 两处逐字同形谓词收敛，保证「决策来源」与「hint 形态」一一对应不再漂移。
 * 命中条件：tool === "bash" 且 input.network 严格 === true（非布尔 "true" /
 * 缺省 / false → 不命中）。非 bash 工具同名字段不受影响（web_fetch 等走
 * 既有类别默认）。#952 起与 project-settings.ts 的 `network_equals` 谓词
 * 共享 isBashNetworkInput 的 shape check。
 */
export function isBashNetworkTrue(tool: string, input: unknown): boolean {
  return tool === "bash" && isBashNetworkInput(input);
}

function codeBuiltInRules(): ReadonlyArray<NormalRuleSpec> {
  return Object.freeze([
    {
      // `memory_save` writes into `~/.iknow/memory/<id>.md` — the agent's own
      // memory library, not the user's workspace. Treating it like a generic
      // write tool caused the agent to be fail-closed at every non-interactive
      // inlet (ask / serve, or chat TTY with no prompt available), producing
      // `[user_denied] user declined tool call: memory_save` even when the user
      // never saw a prompt. The project / session layers can still escalate to
      // ask or deny; hard-walls remain un-overrideable.
      id: "code-allow-memory-save",
      match: ({ tool }) => tool === "memory_save",
      decision: "allow",
      reason:
        "code built-in: memory_save writes into the agent memory library, not user workspace",
    },
    {
      // #440 D7 / ADR-0085: todo_write category="write" → 默认 ask;read 子模式
      // 仅读,应 bypass ask 走 allow。规则在 code 层,project/session 仍可
      // escalate 为 ask/deny;hard-wall 仍不可 override。匹配条件:tool 名 +
      // input.mode === "read"。非对象 / 缺 mode / mode 非 read → 不命中,
      // 继续走默认 write → ask(defense in depth,handler 层
      // ToolExecutionError 兜底)。
      id: "code-allow-todo-write-read",
      match: ({ tool, input }) =>
        tool === "todo_write" &&
        typeof input === "object" &&
        input !== null &&
        !Array.isArray(input) &&
        (input as { mode?: unknown }).mode === "read",
      decision: "allow",
      reason: "code built-in: todo_write read mode is read-only (bypass ask)",
    },
    {
      // #503 T10 / ADR-0022:bash network:true 强制 ask — 命中 rule 先于 mode
      // 解析(见 checkPermission 分层循环),故 full_auto 分支永远到不了这条
      // 调用,fence 形状变化(去 --unshare-net、获得宿主网络可见性)是新的
      // 批准轴,与动作批准轴正交。匹配条件:tool === "bash" 且 input.network
      // <b>严格等于 true</b>(非布尔 "true" / 缺省 / false → 不命中,走既有
      // 分类默认路径)。非 bash 工具同名字段不受影响。硬墙仍先于本规则。
      id: "code-ask-bash-network",
      match: ({ tool, input }) => isBashNetworkTrue(tool, input),
      decision: "ask",
      reason:
        "code built-in: bash network:true — host network 不经 network-guard，宿主 netns 全量可见（无 IP 过滤、无域名过滤）— explicit approval required, full_auto does not exempt network opt-in",
    },
  ]);
}

export interface PermissionPolicy {
  readonly sources: {
    readonly code: CodeBuiltInPolicySource;
    readonly project?: ProjectSettingsPolicySource;
    readonly session?: SessionGrantsPolicySource;
  };
  readonly hardWalls: ReadonlyArray<HardRuleSpec>;
  readonly defaultByCategory: Readonly<Record<ToolCategory, CategoryDefault>>;
  /** W2: process-level permission mode (default / plan / full_auto). */
  readonly mode: PermissionModeContext;
}

export interface CreatePermissionPolicyOpts {
  readonly project?: ProjectSettingsPolicySource;
  readonly session?: SessionGrantsPolicySource;
  readonly defaultByCategory?: Readonly<Record<ToolCategory, CategoryDefault>>;
  /** W2: Permission mode. Either a static value or a mutable context (REPL
   *  can flip via `/permissions full_auto` without rebuilding the engine). */
  readonly mode?: PermissionMode | PermissionModeContext;
}

export function createPermissionPolicy(
  opts?: CreatePermissionPolicyOpts
): PermissionPolicy {
  return Object.freeze({
    sources: Object.freeze({
      code: Object.freeze({
        kind: "code" as const,
        rules: codeBuiltInRules(),
      }),
      ...(opts?.project ? { project: opts.project } : {}),
      ...(opts?.session ? { session: opts.session } : {}),
    }),
    hardWalls: hardWalls(),
    defaultByCategory: opts?.defaultByCategory
      ? Object.freeze({ ...opts.defaultByCategory })
      : DEFAULT_BY_CATEGORY,
    mode: asModeContext(opts?.mode),
  });
}

export interface CheckPermissionInput {
  readonly def: AciToolDef;
  readonly input: unknown;
  readonly sources: PermissionPolicy["sources"];
  readonly hardWalls: ReadonlyArray<HardRuleSpec>;
  readonly defaultByCategory: Readonly<Record<ToolCategory, CategoryDefault>>;
  /** W2: mode context — resolved at call time so a REPL `/permissions`
   *  toggle takes effect for subsequent tool calls without rebuilding. */
  readonly mode?: PermissionModeContext;
}

export function checkPermission(opts: CheckPermissionInput): PermissionOutcome {
  const { def, input } = opts;
  const ctx = { tool: def.name, input };

  // 1. Hard-walls FIRST — un-overrideable in any mode. This is the security
  //    backstop and must run before mode resolution.
  for (const hardWall of opts.hardWalls) {
    if (hardWall.match(ctx)) {
      // SC3: prefer the input-specific reason (carries the matched pattern
      // id) over the static one when the hard-wall provides `reasonFor`.
      const specific = hardWall.reasonFor?.(ctx);
      const detail = specific ?? hardWall.reason;
      return {
        decision: "deny",
        reason: `${HARD_WALL_DENY_PREFIX} ${detail}`,
      };
    }
  }

  // 2. Layered rules (session > project > code). First match wins per layer
  //    priority. Mode does NOT relax layer rules — only fills the gap.
  const layerOrder: ReadonlyArray<PermissionSource> = [
    "session",
    "project",
    "code",
  ];
  for (const layer of layerOrder) {
    for (const rule of rulesFor(opts.sources, layer)) {
      if (rule.match(ctx)) {
        return { decision: rule.decision, reason: rule.reason };
      }
    }
  }

  // 3. Mode + category default resolution.
  const mode: PermissionMode = opts.mode?.get() ?? "default";
  const category = def.aci.category;

  if (mode === "full_auto") {
    // Full-auto allows every non-hard-walled tool. The user opted in
    // explicitly; sensitive paths / dangerous commands are still blocked by
    // step 1 above.
    return {
      decision: "allow",
      reason: `mode: full_auto → allow (${category})`,
    };
  }
  if (mode === "plan" && category !== "read-only") {
    // Plan mode treats mutating tools as denied without asking — useful for
    // "只看不改" planning sessions.
    return {
      decision: "deny",
      reason: `mode: plan blocks mutating tools (${category})`,
    };
  }
  if (opts.defaultByCategory[category] === "allow") {
    return {
      decision: "allow",
      reason: `category default: ${category} → allow`,
    };
  }
  return {
    decision: "ask",
    reason: `category default: ${category} → ask user`,
  };
}

function rulesFor(
  sources: CheckPermissionInput["sources"],
  layer: PermissionSource
): ReadonlyArray<NormalRuleSpec> {
  if (layer === "session") return sources.session?.rules() ?? [];
  if (layer === "project") return sources.project?.rules ?? [];
  return sources.code.rules;
}

export { HARD_WALL_DENY_PREFIX };
export type { HardWallId };
