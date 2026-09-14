/**
 * src/tui/live-activity-group.ts
 *
 * live activity group（过程组）纯派生 —— docs/CONTEXT.md `live activity group`
 * + specs/tui-tool-settled-appearance.md D9：进行中的**收类**工具不逐条刷
 * 标题，收成一行英文摘要（Listing / Reading / Searching 三个动词桶，
 * bash 另用 `Running N shell commands`）；keep / accent / 失败件仍逐条留
 * 标题（失败横切不进组计数）。
 *
 * 「哪件算收类」走 `deriveSlot(running: false)` 的 `inFoldCount` —— 与 idle
 * `unit fold` 同一分类核，避免出现第二份硬编码名单（Single Source of
 * Truth）；失败件在同一核里 `inFoldCount` 假，天然排除。**此谓词只判 retract
 * 类**，keep bash 另有 `isAggregatableBashRun` —— keep 永不进 idle 折叠计数，
 * 只影响 live 面聚合（CONTEXT `live tool line`：收类与聚合 bash 走过程组）。
 *
 * bash 聚合按 D9（spec specs/tui-tool-settled-appearance.md:27）「bash 用
 * `Running N shell command(s)`」：**≥2 条非失败 bash** 才聚合；单条 keep
 * bash 走普通卡片（CONTEXT `live tool line`「单条 keep bash 的命令可出现在
 * 细节槽」）；失败 bash 自留 failure-overlay 卡片（D5）。聚合 bash 计入
 * 组摘要但**不进** `inFoldCount`（keep 类不属于 idle unit fold）。
 *
 * 细节槽至多一条 = **组内最后一条 running 件**（更早的 running 已被它接棒，
 * 只剩计数）；无 running 时必须由聚合 bash 提供：取**最后一条 bash** 作短
 * 预览（D9「最后一条 keep bash 的短预览」）。收类件一旦不再 running 就只剩
 * 计数（不画标题）；仍有 running 的收类件在**逐条面**保留自己的框 —— 那是
 * 贴底活动行（`grep · Search <pattern>`），跑到一半的件必须看得见在跑什么。
 * keep / accent / 失败件**恒**逐条留框（不进组计数，故不受此上限约束）。
 *
 * 逐条面的顺序保持调用方原序（不重排）：调用方交 `liveTailSlots` 按
 * draftEpoch 回到草稿段之间 —— 挪到队尾会破坏 tool→text→tool 的轴。
 *
 * 纯函数、无 React 依赖，供单测直驱。
 */
import { deriveSlot } from "./tool-settled.js";
import type { LiveToolRun } from "./live-tool-state.js";

/** 组内动词桶（固定顺序，组内出现才画）。 */
export type LiveActivityVerb = "Listing" | "Reading" | "Searching";

const VERB_ORDER: ReadonlyArray<LiveActivityVerb> = [
  "Listing",
  "Reading",
  "Searching",
];

/** 读取族 —— 精确名 + `read_` 前缀（未注册的读类不落 Listing）。 */
const READ_EXACT: ReadonlySet<string> = new Set([
  "read_file",
  "read_mcp_resource",
]);
/** 列举族 —— 目录 / 清单枚举。 */
const LIST_EXACT: ReadonlySet<string> = new Set([
  "glob",
  "list-worktrees",
  "list_mcp_resources",
]);
/** 搜索族 —— 显式名单；未注册名缺省也落这里（收类里搜索是最大宗）。 */
const SEARCH_EXACT: ReadonlySet<string> = new Set([
  "grep",
  "web_search",
  "web_fetch",
  "memory_recall",
  "tool_search",
  "query_trace",
  "bash_output",
]);

/**
 * 收类件 → 动词桶。未注册名缺省 Searching（CONTEXT `retract class`：未知
 * 未注册工具缺省也是收）—— 只决定进哪个桶，不决定进不进组（后者归分类核）。
 */
export function liveActivityVerbOf(name: string): LiveActivityVerb {
  if (READ_EXACT.has(name) || name.startsWith("read_")) return "Reading";
  if (LIST_EXACT.has(name)) return "Listing";
  if (SEARCH_EXACT.has(name) || name.startsWith("lsp_")) return "Searching";
  return "Searching";
}

/**
 * 该件是否进过程组的 retract 计数：成功态分类核判 `inFoldCount`（收类且
 * 非失败）。**只判 retract** —— 这也是 idle `unit fold` 的计数谓词，keep
 * bash 绝不走这里（否则 keep 会漏进 idle 折叠计数）。
 */
export function isLiveActivityGroupRun(run: LiveToolRun): boolean {
  return deriveSlot(run.name, {
    running: false,
    failed: run.status === "failed",
  }).inFoldCount;
}

/**
 * 该件是否参与 bash 聚合（D9 / CONTEXT `live activity group`）：`bash` 且
 * 非失败。失败 bash 走自己的 failure-overlay 卡片（D5），不聚合。
 */
export function isAggregatableBashRun(run: LiveToolRun): boolean {
  return run.name === "bash" && run.status !== "failed";
}

/** 组内 bash 摘要段 —— 只在 >=2 条聚合时调用，故恒用复数
 *  `Running N shell commands`（D9 的 `(s)` 是占位，不打印字面量）。 */
function formatShellCommandSegment(count: number): string {
  return `Running ${count} shell commands`;
}

/**
 * 一行摘要 —— 桶按固定顺序（Listing → Reading → Searching）拼接
 * `Listing × 1 · Reading × 3`，聚合 bash 段（≥2 条）接在桶之后
 * （CONTEXT `live activity group`：bash 用 `Running N shell commands`）；
 * 无任何段 → null（不画空行）。
 *
 * ≥2 阈值来自 D9「bash 用 Running N shell command(s)」+ CONTEXT
 * `live tool line`「单条 keep bash 的命令可出现在细节槽」—— 单条 bash
 * 不需要聚合段，它自己就是那张卡片。
 *
 * 运行中与已完成同桶相加：进行中不把组换成过去时（CONTEXT `open unit`）。
 */
export function formatLiveActivitySummary(
  runs: ReadonlyArray<LiveToolRun>
): string | null {
  const counts = new Map<LiveActivityVerb, number>();
  let bashCount = 0;
  for (const run of runs) {
    if (isAggregatableBashRun(run)) {
      bashCount += 1;
      continue;
    }
    if (!isLiveActivityGroupRun(run)) continue;
    const verb = liveActivityVerbOf(run.name);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }
  const parts = VERB_ORDER.filter((verb) => (counts.get(verb) ?? 0) > 0).map(
    (verb) => `${verb} × ${counts.get(verb) ?? 0}`
  );
  if (bashCount >= 2) parts.push(formatShellCommandSegment(bashCount));
  return parts.length === 0 ? null : parts.join(" · ");
}

/** 过程组两面：进组件计数的件 / 逐条留框的件。 */
export interface LiveActivitySplit {
  /** 收类件 + 被聚合的 bash —— 过程组摘要行的计数来源。 */
  readonly groupRuns: ReadonlyArray<LiveToolRun>;
  /** 逐条留框件（keep / accent / 失败 + 当前 running 件 + 聚合细节），原序。 */
  readonly tailRuns: ReadonlyArray<LiveToolRun>;
}

/**
 * 拆分 —— 顺序保持。组 = retract 件 + 被聚合的 bash（≥2 条时全部 bash，
 * 含 running）；逐条面 = 其余件，外加**至多一条**细节槽：
 *  1. 组内最后一条 running 件（跑到一半必须看得见在跑什么；任意类 —
 *     聚合的 bash 或收类件皆可）；
 *  2. 无 running 时，聚合 bash 的**最后一条**（D9「或最后一条 keep bash
 *     的短预览」）；
 *  3. 两者皆无 → 无细节槽。
 * 单条非失败 bash 不聚合 → 它本身就在逐条面（普通 keep 卡片）。
 *
 * `running` 是**过程组的开关**（D9「turn 仍在 running 时」/「idle 落定仍走
 * **unit fold** + keep 标题」）：idle 时摘要行不画（调用方同门），聚合若
 * 仍吞卡就是静默丢件 —— keep 卡既不在组行、也不在逐条面。故 idle 面只回
 * keep / accent / 失败件（D9「keep 标题逐一保留」）；落定 **retract** 件收起
 * （D3「retract 必须 `showTitle` 与 `showPreview` 同假」），计数交调用方
 * **unit fold** 接（`liveCompletedCounts`）。
 */
export function splitLiveActivityRuns(
  runs: ReadonlyArray<LiveToolRun>,
  opts: { readonly running: boolean }
): LiveActivitySplit {
  return opts.running ? splitRunningRuns(runs) : splitIdleRuns(runs);
}

/** idle 面：组行不画（调用方同门）。只回 keep / accent / 失败件 + 仍 running
 *  的件（状态机空窗防御）；落定 **retract** 收起（D3「retract 必须
 *  `showTitle` 与 `showPreview` 同假」），计数交调用方 **unit fold**。 */
function splitIdleRuns(runs: ReadonlyArray<LiveToolRun>): LiveActivitySplit {
  return {
    groupRuns: [],
    tailRuns: runs.filter(
      (run) => run.status === "running" || !isLiveActivityGroupRun(run)
    ),
  };
}

/** 细节槽（D9 ≤1）：组内最后一条 running 件（跑到一半必须看得见在跑什么）；
 *  无 running 时退回最后一条聚合 bash（D9「最后一条 keep bash 的短预览」）。 */
function pickDetailRun(
  runs: ReadonlyArray<LiveToolRun>,
  isGroupMember: (run: LiveToolRun) => boolean,
  bashAggregated: boolean
): LiveToolRun | null {
  let detail: LiveToolRun | null = null;
  for (const run of runs) {
    if (run.status === "running" && isGroupMember(run)) detail = run;
  }
  if (detail !== null || !bashAggregated) return detail;
  // EXIT: 无 running 组内件 → 退回最后一条聚合 bash 作细节槽。
  for (const run of runs) {
    if (isAggregatableBashRun(run)) detail = run;
  }
  return detail;
}

/** running 面：组 = retract 件 + 被聚合的 bash（≥2 条时）；逐条面 = 其余件
 *  外加至多一条细节槽（`pickDetailRun`）。顺序保持调用方原序。 */
function splitRunningRuns(runs: ReadonlyArray<LiveToolRun>): LiveActivitySplit {
  let bashCount = 0;
  for (const run of runs) {
    if (isAggregatableBashRun(run)) bashCount += 1;
  }
  const bashAggregated = bashCount >= 2;
  // 单一成员公式：组 = retract 件 + 被聚合的 bash（≥2 条时）。
  const isGroupMember = (run: LiveToolRun): boolean =>
    isLiveActivityGroupRun(run) ||
    (bashAggregated && isAggregatableBashRun(run));
  const detail = pickDetailRun(runs, isGroupMember, bashAggregated);
  const groupRuns: LiveToolRun[] = [];
  const tailRuns: LiveToolRun[] = [];
  for (const run of runs) {
    if (!isGroupMember(run)) {
      tailRuns.push(run);
      continue;
    }
    groupRuns.push(run);
    // 细节槽至多一条：更早的 running 已被后来的接棒，只留计数（D9 ≤1）。
    if (run === detail) tailRuns.push(run);
  }
  return { groupRuns, tailRuns };
}
