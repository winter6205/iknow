/**
 * PROTOTYPE — Self-written Graph 多任务编排：Proto B — skill-check / 路由门禁。
 *
 * 设计问题：每个节点执行前能否跑一个 skill-check / 路由门禁，决定套用哪个
 * skill 契约（可拦截 / 改路由）？
 *
 * 建模：skill 目录（skill 名 → 一句话契约描述）+ skillCheckGate 纯函数
 * （nodeId → 三态决策 route / block）。executor 在外层包一层 gate：
 * block → skipped；route → 调底层 executor 并记录套用的 skill。
 * 纯逻辑，无 IO、无 console。
 *
 * 边界：纯逻辑层，仅依赖 ./types；与 ./partition-by-coupling 并列互不依赖。
 */

/** Skill 目录条目：skill 名 + 一句话契约描述。 */
export interface SkillContract {
  readonly name: string;
  readonly description: string;
}

/** 本原型使用的 skill 目录：skill 名 → 一句话契约描述。 */
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

/** Gate 三态决策：route 套用 skill，block 拦截。 */
export type GateDecision =
  | { readonly decision: "route"; readonly skill: string }
  | { readonly decision: "block"; readonly reason: string };

/** 默认路由表（零参 gate 用）：nodeId → skill 名。 */
const DEFAULT_NODE_SKILL_MAP: Readonly<Record<string, string>> = {
  "review-code": "code-review",
  "write-test": "tdd",
};

/** 默认高危节点表（零参 gate 用）：nodeId → 拦截 reason。 */
const DEFAULT_BLOCKED_NODES: Readonly<Record<string, string>> = {
  "deploy-prod": "prototype 禁止生产部署类操作",
};

/**
 * skillCheckGate：节点执行前的路由门禁（纯函数）。
 *
 * 形态 = pre-spawn hook（per graph-insertion-research §6 Q6：「不要模块级 map，
 * 判官 JUDGE_ALLOWED_TOOLS 同构」）。opts.?? 缺省走模块级常量，让无状态
 * 调用者也能用；有 opts 的调用者（如 createSubAgentNodeExecutor）注入每图
 * 配置，避免全局 map 污染 / 可测试。
 *
 * 决策：
 * - block 表命中 → block + reason；
 * - skill 路由表命中 → route + skill 名；
 * - 其它 → route（放行，skill = ""）。
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
  // 无匹配 skill 的普通节点：放行但不套契约。
  return { decision: "route", skill: "" };
}
