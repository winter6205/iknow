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

export type CategoryDefault = "allow" | "ask" | "ask+hardwall";

export const DEFAULT_BY_CATEGORY: Readonly<
  Record<ToolCategory, CategoryDefault>
> = Object.freeze({
  "read-only": "allow",
  write: "ask",
  execute: "ask",
  collaborate: "ask",
});

function codeBuiltInRules(): ReadonlyArray<NormalRuleSpec> {
  return Object.freeze([]);
}

export interface PermissionPolicy {
  readonly sources: {
    readonly code: CodeBuiltInPolicySource;
    readonly project?: ProjectSettingsPolicySource;
    readonly session?: SessionGrantsPolicySource;
  };
  readonly hardWalls: ReadonlyArray<HardRuleSpec>;
  readonly defaultByCategory: Readonly<Record<ToolCategory, CategoryDefault>>;
}

export interface CreatePermissionPolicyOpts {
  readonly project?: ProjectSettingsPolicySource;
  readonly session?: SessionGrantsPolicySource;
  readonly defaultByCategory?: Readonly<Record<ToolCategory, CategoryDefault>>;
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
  });
}

export interface CheckPermissionInput {
  readonly def: AciToolDef;
  readonly input: unknown;
  readonly sources: PermissionPolicy["sources"];
  readonly hardWalls: ReadonlyArray<HardRuleSpec>;
  readonly defaultByCategory: Readonly<Record<ToolCategory, CategoryDefault>>;
}

export function checkPermission(opts: CheckPermissionInput): PermissionOutcome {
  const { def, input } = opts;
  const ctx = { tool: def.name, input };

  for (const hardWall of opts.hardWalls) {
    if (hardWall.match(ctx)) {
      return {
        decision: "deny",
        reason: `${HARD_WALL_DENY_PREFIX} ${hardWall.reason}`,
      };
    }
  }

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

  const category = def.aci.category;
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
