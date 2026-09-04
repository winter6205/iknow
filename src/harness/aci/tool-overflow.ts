/**
 * B6 / ADR-0043 §3 — 溢出治理判定层(纯逻辑)。
 *
 * 装配期(`buildHarnessEngine` 在 `await mcpManager.start()` 之后)一次性判定:
 * 可延迟工具池(MCP 工具天然 deferrable + 标记 deferrable 的内建低频件)
 * schema 总量超过端点模型 context window 的 10% 时,按退场次序逐件退到名字
 * 目录,直至总量 ≤ 阈值或池空。**只首轮一次**,会话内不重算。
 *
 * 退场机制 = stamp `aci.lazy: true`(B4 §2 已立:lazy 工具 schema 不进
 * visibleSchemas,名字进 mcp_name_directory 段;模型可经 tool_search 按需
 * 拉回)。
 *
 * 退场次序(SSOT,ADR-0043 §3 钉死):trace 读侧三件
 * (query_trace / list_sessions / get_record) → web_search / web_fetch → 其
 * 余低频件按实测面积排。**核心七件永不退场**(bash / read_file / edit_file
 * / write_file / grep / glob / spawn_subagent),即使被标 deferrable 也不参
 * 与判定。
 *
 * countTokens 调用失败 / 缺席 → 跳过本会话(全部 deferrable 内建件保持常
 * 驻),首轮不抛错、不重试,由调用方 `console.warn` 记录。
 *
 * 本模块**纯逻辑**:不绑 build-engine / 不绑 ACI executor;输入 tools +
 * countTokens 闭包 + 阈值,输出 retire 名单 + reason。装配层拿到 retire
 * 名单后遍历 stamp `aci.lazy: true`(MutationField:此字段仅此一处允许
 * 写,符合 #224 B4 发现的"装配期 const 不可变"契约 —— registry 装配时
 * AciToolDef 是冻结的,但**本模块在 registry 构造前**对工厂内 def 写入
 * lazy:true 是构造期一次性副作用,等同于在 factories 工厂内手工 stamp)。
 */

import type { AciToolDef } from "./types.js";

/**
 * 内建件退场次序(SSOT,ADR-0043 §3 预置)。
 *
 *   - trace 读侧三件:query_trace / list_sessions / get_record
 *     (面积 × 低频从大到小;query_trace 行轴面积最大,get_record 内容轴面积
 *     通常最小)
 *   - web_search / web_fetch:网络出口 + 低频
 *
 * 「其余低频查询件按实测面积排」超出预置次序的扩名 = Confirms with human
 * 项,本常量不动 —— 实施时若发现明显该进的候选项,在报告中列证据,不改
 * 数组(plan B6 §3)。
 */
export const DEFERRABLE_BUILTIN_RETIRE_ORDER: ReadonlyArray<string> =
  Object.freeze([
    "query_trace",
    "list_sessions",
    "get_record",
    "web_search",
    "web_fetch",
  ] as const);

/** 核心七件 SSOT —— 永不退场,即使被标 deferrable。 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "read_file",
  "edit_file",
  "write_file",
  "grep",
  "glob",
  "spawn_subagent",
]);

/** countTokens 闭包契约 —— SDK 0.115 `client.messages.countTokens`
 *  调用面的最小投影:实测量(>= 0)或抛错。 */
export type CountTokensFn = () => Promise<number>;

/** 装配层传过来的可延迟池 = 标记 deferrable 的内建件 + MCP 工具(在调用
 *  方按 register 名单的 mcp__ 前缀过滤)。**核心件已被调用方剔除**(SSOT
 *  守门),本函数信任入参不含核心件。 */
export interface OverflowJudgeOpts {
  readonly tools: ReadonlyArray<AciToolDef>;
  /** 阈值 = contextWindow * 0.1(由调用方在装配层算好传入,本函数不读
   *  env —— 纯逻辑)。 */
  readonly threshold: number;
  readonly countTokens: CountTokensFn;
}

export type OverflowJudgeResult =
  | { readonly reason: "no_overflow"; readonly retire: ReadonlyArray<string> }
  | { readonly reason: "retired"; readonly retire: ReadonlyArray<string> }
  | {
      readonly reason: "countTokens_failed";
      readonly retire: ReadonlyArray<string>;
      readonly cause: unknown;
    };

/**
 * 首轮溢出治理判定 —— 一次到位,内部循环退场。
 *
 * 步骤:
 *   1. 收集「候选退场名单」 = 标记 deferrable 且不在核心件名单里的工具
 *      名(按 `DEFERRABLE_BUILTIN_RETIRE_ORDER` 次序,其他 deferrable
 *      候选排在预置次序之后,见 `extraOrder`)。
 *   2. 第一次 `countTokens` 实测:成功 → 与阈值比较;失败 → 跳过
 *      本会话(返回 `countTokens_failed`,调用方 warn + 不动工具集)。
 *   3. 总量 ≤ 阈值 → `no_overflow`(调用方零动作)。
 *   4. 总量 > 阈值 → 按候选次序逐件退,每退 1 件重测 1 次 countTokens;
 *      退出循环当 ≤ 阈值或池空。
 *   5. 全退完仍超阈值 → `retired` 仍带上全部候选(已尽力,核心件永不退
 *      场,这是 hard ceiling);调用方零 warn(不是错误,只是面积不够)。
 *
 * 候选名单 derivation:
 *   - 内建低频件 = 出现在 `DEFERRABLE_BUILTIN_RETIRE_ORDER` 且标 deferrable
 *     的工具,按预置次序
 *   - 其余 deferrable(MCP 工具天然 + 未来追加的内建件)= 按 catalog.all()
 *     注册次序(原序),列在预置次序之后
 *
 * 注:`runOverflowJudge` 接收的 `tools` 已是**装配期冻结的 def 列表**,
 * 不区分内建 / MCP —— registry.all() / reg.catalog.all() 都不动次序(本
 * 函数内部只按 `name` 排)。
 */
export async function runOverflowJudge(
  opts: OverflowJudgeOpts
): Promise<OverflowJudgeResult> {
  const candidateOrder = deriveCandidateOrder(opts.tools);
  if (candidateOrder.length === 0) {
    // 池空 → 跳过判定,直接 no_overflow(无错)
    return { reason: "no_overflow", retire: [] };
  }
  // 第一次实测
  let total: number;
  try {
    total = await opts.countTokens();
  } catch (cause) {
    return { reason: "countTokens_failed", retire: [], cause };
  }
  if (!Number.isFinite(total) || total < 0) {
    // 非法值 → 同失败语义(失败 = 跳过,retire 空)
    return {
      reason: "countTokens_failed",
      retire: [],
      cause: new Error(`countTokens returned non-finite: ${total}`),
    };
  }
  if (total <= opts.threshold) {
    return { reason: "no_overflow", retire: [] };
  }
  // 退场循环:每退 1 件重测 1 次
  const retired: string[] = [];
  for (const name of candidateOrder) {
    retired.push(name);
    let next: number;
    try {
      next = await opts.countTokens();
    } catch (cause) {
      // 中途 countTokens 失败 = retire 名单仅供参考 —— 调用方 skip 语义下
      // 不应用(全量 deferrable 保持常驻);之前已退的件保留(已 latch),
      // 不再追加。返回 countTokens_failed + 当前 retire,调用方 warn。
      return { reason: "countTokens_failed", retire: retired, cause };
    }
    if (next <= opts.threshold) {
      return { reason: "retired", retire: retired };
    }
  }
  // 池空仍超阈值(罕见:核心件全在 + 大量 deferrable)→ 尽力退,retire
  // 含全部候选;reason = "retired"(已尽力,不是错误)
  return { reason: "retired", retire: retired };
}

/**
 * 候选退场名单 derivation:
 *   - 出现在 `DEFERRABLE_BUILTIN_RETIRE_ORDER` 的 deferrable 内建件 → 按
 *     预置次序
 *   - 其他 deferrable(MCP 工具天然 + 未来追加的内建件)= 按 registry 原
 *     序,列在预置次序之后
 *
 * 核心件已被 callers 剔除(本函数不二次过滤 —— 调用方负责把 bash 等剔
 * 除后再传入,以便调用方同时算核心件 schema 总量纳入 countTokens 实测
 * 面,即"模拟首轮请求完整面")。
 */
function deriveCandidateOrder(
  tools: ReadonlyArray<AciToolDef>
): ReadonlyArray<string> {
  const defSet = new Set<string>();
  for (const t of tools) {
    // 核心七件(即使标 deferrable)永不参与 —— hard ceiling(ADR-0043 §3
    // 钉死 + B6 plan §3 确认)。本过滤在候选 derivation 层一次性完成;
    // 后续 retire 写入由 retireBuiltin 同步守门(核心件不在预置次序 +
    // deriveCandidateOrder 已剔除)。
    if (CORE_TOOL_NAMES.has(t.name)) continue;
    if (t.aci.deferrable === true) defSet.add(t.name);
  }
  const ordered: string[] = [];
  for (const name of DEFERRABLE_BUILTIN_RETIRE_ORDER) {
    if (defSet.has(name)) ordered.push(name);
  }
  // 其他 deferrable 按 registry 原序(本函数信任入参 tools 的次序 =
  // registry 注册序)
  for (const t of tools) {
    if (
      t.aci.deferrable === true &&
      !CORE_TOOL_NAMES.has(t.name) &&
      !DEFERRABLE_BUILTIN_RETIRE_ORDER.includes(t.name)
    ) {
      ordered.push(t.name);
    }
  }
  return ordered;
}
