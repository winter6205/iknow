/**
 * PROTOTYPE — self-written Graph multi-task orchestration: skill-check /
 * routing gate.
 *
 * Design question: can a skill-check / routing gate run before each node to
 * decide which skill contract applies (with the power to block or reroute)?
 *
 * Model: a skill catalog (skill name → one-line contract description) plus
 * the pure function skillCheckGate (nodeId → route / block decision). The
 * executor wraps a gate layer outside: block → skipped; route → call the
 * underlying executor and record the applied skill. Pure logic, no IO, no
 * console.
 *
 * Boundary: pure logic layer, depends only on ./types; parallel to
 * ./partition-by-coupling with no mutual dependency.
 */

/** Skill catalog entry: name + one-line contract description. */
export interface SkillContract {
  readonly name: string;
  readonly description: string;
}

/** Skill catalog used by this prototype: skill name → one-line contract description. */
export const skillCatalog: Readonly<Record<string, SkillContract>> = {
  "code-review": {
    name: "code-review",
    description: "审查 diff，只读",
  },
  tdd: {
    name: "tdd",
    description: "先写失败测试再实现",
  },
};

/** Gate tri-state decision: route applies a skill, block intercepts. */
export type GateDecision =
  | { readonly decision: "route"; readonly skill: string }
  | { readonly decision: "block"; readonly reason: string };

/** Default routing table (for the zero-arg gate): nodeId → skill name. */
const DEFAULT_NODE_SKILL_MAP: Readonly<Record<string, string>> = {
  "review-code": "code-review",
  "write-test": "tdd",
};

/** Default high-risk node table (for the zero-arg gate): nodeId → block reason. */
const DEFAULT_BLOCKED_NODES: Readonly<Record<string, string>> = {
  "deploy-prod": "prototype 禁止生产部署类操作",
};

/**
 * skillCheckGate: the routing gate before node execution (pure function).
 *
 * Shape = pre-spawn hook — deliberately not a module-level map; same
 * structure as the judge's allowed-tools table. opts.?? defaults to the
 * module-level constants so stateless callers work too; callers with opts
 * (e.g. createSubAgentNodeExecutor) inject per-graph config, avoiding
 * global-map pollution and staying testable.
 *
 * Decisions:
 * - hit in the block table → block + reason;
 * - hit in the skill routing table → route + skill name;
 * - otherwise → route (pass through, skill = "").
 */
export interface SkillCheckOptions {
  readonly nodeSkillMap?: Readonly<Record<string, string>>;
  readonly blockedNodes?: Readonly<Record<string, string>>;
}

export function skillCheckGate(
  nodeId: string,
  opts?: SkillCheckOptions
): GateDecision {
  const blockedTable = opts?.blockedNodes ?? DEFAULT_BLOCKED_NODES;
  const routeTable = opts?.nodeSkillMap ?? DEFAULT_NODE_SKILL_MAP;

  const blocked = blockedTable[nodeId];
  if (blocked !== undefined) {
    return { decision: "block", reason: blocked };
  }
  const skill = routeTable[nodeId];
  if (skill !== undefined) {
    return { decision: "route", skill };
  }
  // Plain node with no matching skill: pass through without applying a contract.
  return { decision: "route", skill: "" };
}
