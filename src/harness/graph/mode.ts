/**
 * graph mode overlay —— 会话级编排开关的单点（ADR-0030）。
 *
 * graph mode **不是** `PermissionMode`：授权轴（ask / auto / plan）与编排轴
 * （进不进图）是两根轴，缠在一起会污染 policy 并让 D-β coordinator 更难拆。
 * 所以 `PERMISSION_MODES` 不动，Graph 只在本模块里作为一个布尔 overlay 存在。
 *
 * 本模块承担四件事，都是三入口（chat / TUI / serve）共享的单点 —— 三处各写
 * 一份就会漂移：
 *
 * - **值域**：`parseGraphFlag` —— `/graph` 与 settings 共用一套布尔字面。
 * - **初值链**：`resolveGraphMode` —— settings > 默认关。graph 是可选 overlay，
 *   默认任务仍走一次性 `spawn_subagent` 不进图，缺省必须是关。刻意**没有 env
 *   支路**：产品 SSOT = Shift+Tab + `/graph` + settings（spec 假设 11），
 *   env gate 已被 ADR-0014 否过一次。
 * - **可变 holder**：`GraphModeContext` 镜像 `PermissionModeContext` —— REPL /
 *   TUI / serve 就地翻，引擎不重建。
 * - **三态轮 + 命令语义**：`nextShiftTabAgentMode` / `applyGraphCommand` ——
 *   `Default → Auto → Graph → Default`，`/graph on|off` 是非 TTY 对等物。
 *
 * 边界：只从 `harness/permission/modes.js` 取 `PermissionMode` 值域与共享的
 * 键位守卫（graph → permission 单向；permission 不认识 graph，Graph 永不进
 * `PERMISSION_MODES`）。不 import config/ —— settings 段以结构化投影
 * `GraphModeDefaults` 接进来，避免 harness → config 的反向依赖。
 */

import {
  DEFAULT_PERMISSION_MODE,
  isShiftTabKey,
  modeLabel,
  nextShiftTabMode,
  type PermissionMode,
  type PermissionModeContext,
  type ShiftTabKeyShape,
} from "../permission/modes.js";

/** 会话级 graph 开关快照。 */
export interface GraphModeState {
  /** graph 编排 overlay 是否启用。关 = 任务照常走一次性 `spawn_subagent`。 */
  readonly enabled: boolean;
}

/** 默认关 —— graph = 可选 overlay 的产品缺省。 */
export const GRAPH_MODE_DEFAULT_STATE: GraphModeState = Object.freeze({
  enabled: false,
});

/**
 * `settings.graph` 段的结构投影（`IknowSettingsGraph` 结构可赋值）。
 * 用结构而非 import，见文件头「边界」。
 */
export interface GraphModeDefaults {
  readonly enabled?: boolean;
}

const TRUE_LITERALS: ReadonlySet<string> = new Set(["on", "true", "1", "yes"]);
const FALSE_LITERALS: ReadonlySet<string> = new Set([
  "off",
  "false",
  "0",
  "no",
]);

/**
 * `/graph` 参数与 settings 的布尔值域。`on|true|1|yes` / `off|false|0|no`，
 * trim + 大小写不敏感；boolean 原样透传（settings 段已是 boolean）。
 *
 * 非法值返回 `undefined` 而不是抛 —— 与 settings 的「非法值回退不抛错」纪律
 * 一致；调用方据此回退下一层（settings 非法 → 默认关）。
 */
export function parseGraphFlag(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (TRUE_LITERALS.has(v)) return true;
  if (FALSE_LITERALS.has(v)) return false;
  return undefined;
}

/** 装配期初值来源：settings > 默认关。 */
export function resolveGraphMode(opts?: {
  readonly settings?: GraphModeDefaults;
}): GraphModeState {
  return Object.freeze({
    enabled: opts?.settings?.enabled ?? GRAPH_MODE_DEFAULT_STATE.enabled,
  });
}

/**
 * 可变 holder —— `/graph` 与 Shift+Tab 在运行中的会话里就地翻同一个开关，
 * 引擎不重建。形态镜像 `PermissionModeContext`。
 */
export interface GraphModeContext {
  /** 当前快照（冻结；改快照不影响 holder）。 */
  readonly get: () => GraphModeState;
  readonly setEnabled: (enabled: boolean) => void;
}

export function createGraphModeContext(
  initial: GraphModeState = GRAPH_MODE_DEFAULT_STATE
): GraphModeContext {
  let current: GraphModeState = Object.freeze({ ...initial });
  return Object.freeze({
    get: () => current,
    setEnabled: (enabled: boolean) => {
      current = Object.freeze({ ...current, enabled });
    },
  });
}

// ── Shift+Tab 三态轮（ADR-0030）────────────────────────────────────────────

/** 两根轴的联合快照：授权轴 + 编排 overlay。 */
export interface AgentModeSnapshot {
  readonly permission: PermissionMode;
  readonly graph: boolean;
}

/** 人读标签（TUI / REPL 状态行）。Graph 盖过 permission 标签显示。 */
export type AgentModeLabel = "Default" | "Plan Mode" | "Auto" | "Graph";

export function agentModeLabel(snapshot: AgentModeSnapshot): AgentModeLabel {
  return snapshot.graph ? "Graph" : modeLabel(snapshot.permission);
}

/**
 * Shift+Tab 三态轮 `Default → Auto → Graph → Default`（ADR-0030）。
 *
 * - Graph 态按一下 → 回 Default（编排关 + 授权回 default），轮闭合；
 * - Auto 态按一下 → 进 Graph，**permission 冻结在 full_auto** —— 进图不改
 *   ask/auto 语义（SC1）；
 * - 其余（default / plan）按一下 → Auto。`plan` 沿用 `nextShiftTabMode` 的
 *   既有裁决：不是轮里的一站，一次 Shift+Tab 直接到 full_auto，且不开 graph
 *   （plan 会话不该被误触推进两格）。
 */
export function nextShiftTabAgentMode(
  current: AgentModeSnapshot
): AgentModeSnapshot {
  if (current.graph) {
    return { permission: DEFAULT_PERMISSION_MODE, graph: false };
  }
  if (current.permission === "full_auto") {
    return { permission: "full_auto", graph: true };
  }
  return { permission: nextShiftTabMode(current.permission), graph: false };
}

/**
 * 把一次 Shift+Tab 键击应用到「授权 holder + graph holder」两根轴上。
 *
 * 键位守卫与单轴版共用 `isShiftTabKey`（permission/modes.ts SSOT），所以
 * TUI（opentui Key）与 REPL（node:readline Key）两处照旧同源。
 *
 * `permission` 缺席 → 短路 no-op（ask/serve 早期路径）。`graph` 缺席 →
 * 退化成既有单轴 permission 轮（未接 overlay 的入口零行为变化）。
 */
export function applyShiftTabAgentModeFlip(opts: {
  readonly key: ShiftTabKeyShape | undefined;
  readonly permission: PermissionModeContext | undefined;
  readonly graph: GraphModeContext | undefined;
  readonly onFlip: (next: AgentModeSnapshot) => void;
}): boolean {
  if (!isShiftTabKey(opts.key)) return false;
  const permission = opts.permission;
  if (!permission) return false;
  const graph = opts.graph;
  const current: AgentModeSnapshot = {
    permission: permission.get(),
    graph: graph?.get().enabled ?? false,
  };
  const next = graph
    ? nextShiftTabAgentMode(current)
    : { permission: nextShiftTabMode(current.permission), graph: false };
  permission.set(next.permission);
  graph?.setEnabled(next.graph);
  opts.onFlip(next);
  return true;
}

// ── `/graph` 命令（非 TTY 对等物）──────────────────────────────────────────

/** `/graph` 的三态命令（三入口共享）。 */
export type GraphCommand =
  | { readonly kind: "status" }
  | { readonly kind: "set"; readonly enabled: boolean }
  | { readonly kind: "usage" };

export const GRAPH_MODE_USAGE_TEXT = "Usage: /graph [on|off|status]";

/**
 * `/graph` args 解析。空 / `status` → 查询；`on|off` → 翻开关；其它（含多余
 * args）→ usage。
 *
 * 多余 args 不被静默忽略：`/graph on extra` 说明用户以为 `extra` 有意义，
 * 照 `on` 执行等于替他猜。
 */
export function parseGraphCommand(args: ReadonlyArray<string>): GraphCommand {
  const head = (args[0] ?? "").trim().toLowerCase();
  if (head === "" && args.length <= 1) return { kind: "status" };
  if (head === "status" && args.length === 1) return { kind: "status" };
  if (args.length === 1) {
    const enabled = parseGraphFlag(head);
    if (enabled !== undefined) return { kind: "set", enabled };
  }
  return { kind: "usage" };
}

function onOff(value: boolean): string {
  return value ? "on" : "off";
}

/** 状态回显（三入口同一行）。 */
export function formatGraphStatus(state: GraphModeState): string {
  return `图模式: ${onOff(state.enabled)}（下一次 run() 装配生效）`;
}

/** 执行结果：`ok=false` 表示没改任何状态，`text` 是给用户看的那一行。 */
export interface GraphCommandResult {
  readonly ok: boolean;
  readonly text: string;
}

/**
 * 在 holder 上执行一条 `/graph` 命令，并给出用户可见文案。
 *
 * 三入口都调本函数：chat 走 stdout/stderr、TUI 走 notice、serve 把 `text`
 * 放进响应体交给 web 渲染 —— 载体不同，语义与字面同源。
 */
export function applyGraphCommand(
  ctx: GraphModeContext,
  args: ReadonlyArray<string>
): GraphCommandResult {
  const cmd = parseGraphCommand(args);
  switch (cmd.kind) {
    case "status":
      return { ok: true, text: formatGraphStatus(ctx.get()) };
    case "set":
      ctx.setEnabled(cmd.enabled);
      return {
        ok: true,
        text: `图模式已切换: ${onOff(cmd.enabled)}（下一次 run() 装配生效）`,
      };
    case "usage":
      return { ok: false, text: GRAPH_MODE_USAGE_TEXT };
  }
}

/**
 * 自由文本 args 切词（`/graph on` 的 " on " 段）。serve 的 wire 上传的是已切
 * 好的数组；TUI / web 从一行原文里取剩余段时用它。
 */
export function splitGraphArgs(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}
