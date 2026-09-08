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
/**
 * 落定态分类（spec D8：keep / retract / accent 三类成功态分类表）。
 * "subagent" 不在 D8 三类内 —— 仅 spawn_subagent / subagent_result 使用，
 * 核在 class 分派之前特判为 keep-title-only（标题留、无预览、不进计数、
 * default 色），glyph 差异留给渲染层。设为显式字面量而非缺项 + `!` 断言：
 * 让「声明缺失 / 谎报」在编译期或跨核闸（tool-settled.test 子代理集合单源）
 * 处失败，而不是运行时静默解析成 retract。
 */
export type SettledClass = "keep" | "retract" | "accent" | "subagent";

/** slot 颜色 token（映射 tuiPalette；dim 不由核决定 —— dim 只属成功 bash 尾巴）。 */
export type SettledColor = "default" | "accent" | "error";

/** slot 颜色 token → 调色板前景色（D7 渲染映射单源）。
 *  default 落 dim（工具标题行的既有次级形态）；dim 本身不由核决定，映射
 *  归渲染层，但两处渲染（message-blocks / live-tool-preview）共用本函数，
 *  避免 color→palette 对照表漂移。theme.ts 纯 TS、无 React 依赖，核可安全
 *  引用类型。 */
export function settledColorToFg(
  color: SettledColor,
  palette: {
    readonly default: string;
    readonly accent: string;
    readonly error: string;
  }
): string {
  switch (color) {
    case "error":
      return palette.error;
    case "accent":
      return palette.accent;
    case "default":
      return palette.default;
  }
}

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
 * spawn_subagent / subagent_result 以 "subagent" class 显式在表（D8 三类
 * 之外，核按 keep-title-only 给 slot —— 标题留、无预览、不进计数、default
 * 色），glyph 差异留给渲染层。
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
  // disclosure-index-align T2: skill_search 已删（spec ADR-0046 / SC5）。
  // 历史回放记录里仍有该名（tool_result 已写入 message），按缺省 retract
  // 兜底（settledClassOf 未注册名缺省 retract）—— 无需显式声明。
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
  // 三类之外（D8「沿用独立 glyph」）：显式声明，核在 class 分派前特判
  // keep-title-only —— 注册表与核共享同一子代理名单，跨核闸钉住一致性。
  spawn_subagent: "subagent",
  subagent_result: "subagent",
};

/** class 查询：未注册名缺省 retract（spec D1「未知工具缺省 retract、无预览」）。 */
export function settledClassOf(name: string): SettledClass {
  return TOOL_SETTLED_CLASS[name] ?? "retract";
}

/** 成功态按 class 分派的 slot。 */
function slotForClass(cls: SettledClass): SettledSlot {
  switch (cls) {
    case "keep":
      // D4 keep：标题留；showPreview 由调用方预览通道再过滤。
      // docs/CONTEXT.md keep class：bash 成功只留带命令的标题（不带结果
      // 预览），write / edit 留完成态 6 行预览；其余 keep（bash_stop /
      // todo_write / memory_save）无预览内容自然为空。「谁真留预览」由
      // KEEP_WITH_PREVIEW 决定（bash 不在其中，仅 write_file / edit_file）。
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
    case "subagent":
      // D8 三类之外：keep-title-only（glyph 差异留给渲染层）。
      return KEEP_TITLE_ONLY_SLOT;
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

/** D4 中带预览足迹的 keep 工具（write·edit 既有 6 行预览窗）。
 *  bash 已不在集合 —— docs/CONTEXT.md keep class 收口：成功 bash 只留
 *  带命令的标题、不带结果预览（result preview 只属于 live running）。 */
const KEEP_WITH_PREVIEW: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
]);

/**
 * 落定态单一派生（spec D1）。输入工具名与 { running, failed }，输出渲染 slot。
 * 失败横切在最后一步：任何 class 失败 → 标题留、error 色、不进计数、无预览。
 * 纯函数，无共享可变状态。
 */
export function deriveSlot(name: string, state: SettledState): SettledSlot {
  // 失败横切最后一步（D5）：error 优先于 accent / keep。
  if (state.failed) return FAILED_SLOT;
  if (state.running) return RUNNING_SLOT;
  const cls = settledClassOf(name);
  // 子代理不进三类（spec D8「沿用独立 glyph」）—— class 表显式声明
  // "subagent"，与未注册名缺省 retract 分流（不按 retract 兜底折叠）。
  if (cls === "subagent") return KEEP_TITLE_ONLY_SLOT;
  if (cls === "retract") return RETRACT_SLOT;
  if (cls === "accent") return ACCENT_SLOT;
  // keep 内部再分：write / edit 带 6 行预览足迹，其余只留标题（D4）。
  // bash 成功落定走 KEEP_TITLE_ONLY_SLOT（CONTEXT keep class：只留带命令
  // 的标题）—— 与 bash_stop / todo_write / memory_save 同形态。
  return KEEP_WITH_PREVIEW.has(name)
    ? KEEP_WITH_PREVIEW_SLOT
    : KEEP_TITLE_ONLY_SLOT;
}
