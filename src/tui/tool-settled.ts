/**
 * src/tui/tool-settled.ts
 *
 * 落定态策略核（spec specs/tui-tool-settled-appearance.md D1/D4/D5/D6/D8）。
 * 纯 TS、无 React / Ink 依赖；渲染层只消费 `deriveSlot` 输出的 slot，不再
 * 自行组合标题隐藏开关与预览（D7）。
 *
 * 派生顺序（D1）：running 全部逐条可见 → 成功按 class 分派 → 失败横切在核
 * 最后一步覆盖一切（error 色优先于 accent，D5）。
 *
 * class 表（D8）在本文件内声明为单一来源：`tool-summary.ts` 的注册表按
 * 工具名逐条 `settledClass: TOOL_SETTLED_CLASS[name] ?? "retract"` 复用，
 * 避免两处硬编码漂移（Single Source of Truth）。未注册名缺省 retract ——
 * 策略核必须依赖无关（不 import 注册表），否则反向拉入 React 链。
 */
/** 落定态工具三分类（spec D8 成功态分类表）。 */
export type SettledClass = "keep" | "retract" | "accent";

/** slot 颜色 token（映射 tuiPalette；dim 不由核决定 —— dim 只属成功 bash 尾巴）。 */
export type SettledColor = "default" | "accent" | "error";

/** 渲染层唯一消费形态：标题 / 预览 / 折叠计数 / 颜色。 */
export interface SettledSlot {
  readonly showTitle: boolean;
  readonly showPreview: boolean;
  /** 折叠计数行只聚合本字段为 true 的件（成功且 retract，spec D3）。 */
  readonly inFoldCount: boolean;
  readonly color: SettledColor;
}

export interface SettledState {
  readonly running: boolean;
  readonly failed: boolean;
}

/**
 * D8 分类表（成功态）。SSOT：tool-summary.ts 注册表逐名复用本表；
 * spawn_subagent / subagent_result 不进三类（spec D8「沿用独立 glyph」）——
 * 核内按 keep-with-title-only 给 slot（标题留、无预览、不进计数、default 色），
 * glyph 差异留给渲染层。
 */
export const TOOL_SETTLED_CLASS: Readonly<Record<string, SettledClass>> = {
  // keep（留的足迹，D4）
  bash: "keep",
  write_file: "keep",
  edit_file: "keep",
  bash_stop: "keep",
  todo_write: "keep",
  memory_save: "keep",
  // retract（收，标题与预览同假，只进折叠计数）
  read_file: "retract",
  grep: "retract",
  glob: "retract",
  web_search: "retract",
  web_fetch: "retract",
  memory_recall: "retract",
  tool_search: "retract",
  skill_search: "retract",
  bash_output: "retract",
  list_mcp_resources: "retract",
  read_mcp_resource: "retract",
  query_trace: "retract",
  "list-task-worktrees": "retract",
  lsp_definition: "retract",
  lsp_references: "retract",
  lsp_hover: "retract",
  lsp_go_to_implementation: "retract",
  lsp_prepare_call_hierarchy: "retract",
  lsp_incoming_calls: "retract",
  lsp_outgoing_calls: "retract",
  lsp_diagnostics: "retract",
  lsp_document_symbol: "retract",
  lsp_workspace_symbol: "retract",
  // accent（点名着色，D6）
  skill: "accent",
  "create-task-worktree": "accent",
  "enter-task-worktree": "accent",
  "exit-task-worktree": "accent",
  "remove-task-worktree": "accent",
};

/** class 查询：未注册名缺省 retract（spec D1「未知工具缺省 retract、无预览」）。 */
export function settledClassOf(name: string): SettledClass {
  return TOOL_SETTLED_CLASS[name] ?? "retract";
}

/** 成功态按 class 分派的 slot。 */
function slotForClass(cls: SettledClass): SettledSlot {
  switch (cls) {
    case "keep":
      // D4：keep 留标题；showPreview 由调用方预览通道再过滤（write/edit 走
      // 既有 6 行窗、bash 走结果五行走、会话动作无预览内容自然为空）。
      return {
        showTitle: true,
        showPreview: true,
        inFoldCount: false,
        color: "default",
      };
    case "retract":
      // D3：retract 必须标题与预览同假。
      return {
        showTitle: false,
        showPreview: false,
        inFoldCount: true,
        color: "default",
      };
    case "accent":
      // D6：accent 只点名着色，不摊正文预览。
      return {
        showTitle: true,
        showPreview: false,
        inFoldCount: false,
        color: "accent",
      };
  }
}

const RETRACT_SLOT = slotForClass("retract");
const ACCENT_SLOT = slotForClass("accent");
/** keep-with-title-only：会话动作类（bash_stop / todo_write / memory_save）
 *  与三类之外的子代理工具。 */
const KEEP_TITLE_ONLY_SLOT: SettledSlot = {
  showTitle: true,
  showPreview: false,
  inFoldCount: false,
  color: "default",
};
const KEEP_WITH_PREVIEW_SLOT = slotForClass("keep");
const FAILED_SLOT: SettledSlot = {
  showTitle: true,
  showPreview: false,
  inFoldCount: false,
  color: "error",
};
/** running 态（spec D1）：全部逐条可见，不提前进折叠计数。 */
const RUNNING_SLOT: SettledSlot = {
  showTitle: true,
  showPreview: false,
  inFoldCount: false,
  color: "default",
};

/** D4 中带预览足迹的 keep 工具（bash 结果预览 / write·edit 既有预览窗）。 */
const KEEP_WITH_PREVIEW: ReadonlySet<string> = new Set([
  "bash",
  "write_file",
  "edit_file",
]);

/** 三类之外的子代理工具（spec D8：spawn_subagent / subagent_result 沿用
 *  独立 glyph，核内不按 retract 兜底折叠）。 */
function isSubagentSettledName(name: string): boolean {
  return name === "spawn_subagent" || name === "subagent_result";
}

/**
 * 落定态单一派生（spec D1）。输入工具名与 { running, failed }，输出渲染 slot。
 * 失败横切在最后一步：任何 class 失败 → 标题留、error 色、不进计数、无预览。
 * 纯函数，无共享可变状态。
 */
export function deriveSlot(name: string, state: SettledState): SettledSlot {
  // 失败横切最后一步（D5）：error 优先于 accent / keep。
  if (state.failed) return FAILED_SLOT;
  if (state.running) return RUNNING_SLOT;
  // 子代理工具不进三类（spec D8「沿用独立 glyph」）：按 keep-with-title-only
  // 给 slot，glyph 差异留给渲染层；须在未注册缺省 retract 之前判定。
  if (isSubagentSettledName(name)) return KEEP_TITLE_ONLY_SLOT;
  const cls = settledClassOf(name);
  if (cls === "retract") return RETRACT_SLOT;
  if (cls === "accent") return ACCENT_SLOT;
  // keep 内部再分：bash / write / edit 带预览足迹，其余只留标题（D4）。
  return KEEP_WITH_PREVIEW.has(name)
    ? KEEP_WITH_PREVIEW_SLOT
    : KEEP_TITLE_ONLY_SLOT;
}
