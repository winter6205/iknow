/**
 * src/shared/tool-line.ts
 *
 * D1（specs/tui-human-display.md）人读过程行 SSOT：**CLI 与 TUI 共用摘要
 * 函数**（plans/tui-human-display.md T1「CLI 与 TUI 同一套 detail」）。
 * 两侧各抄一份模板字符串必然漂移，故文本层整体落在中立模块：
 *
 *   - 本模块只依赖 `string-width`（无 React / @opentui / TUI 内部模块），
 *     因此 `src/cli/*` 可安全 import —— CLI → TUI 的 import 是反向分层，
 *     禁止（R9 依赖倒置）；
 *   - `src/tui/tool-summary.ts` 对本模块做 re-export，既有 TUI 调用方与
 *     tests/tui/* 的 import 路径不变（工具行字节零变化）；
 *   - 文本收口助手（visualWidth / clipOneLine / clipOneLineVisual）：归档
 *     时代 SSOT 在 text.ts，随摘要函数一并搬入，双方共用同一预算公式。
 *
 * 人读合同（docs/CONTEXT.md `live tool line`）：进行中英文「名 + 本轮要点」
 * （search=query、fetch=url、read=path、grep=pattern）；bash 命令可见，前缀
 * `Running 1 shell command…`；思考 `Thinking…`。无 `[运行中]` / `[完成]`。
 */
import stringWidth from "string-width";

/** 视觉列宽（CJK / 全角按 2 列，string-width 口径）。 */
export function visualWidth(s: string): number {
  return stringWidth(s);
}

/** 单行裁剪（字符数口径）：折叠空白，超长按字符数截断补 `…`。 */
export function clipOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * 按**视觉宽度**截断单行（CJK 占 2 列）。保证结果 `visualWidth <= maxWidth`；
 * 省略号预留 1 列。maxWidth <= 0 返回空串。
 */
export function clipOneLineVisual(s: string, maxWidth: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (maxWidth <= 0) return "";
  if (visualWidth(oneLine) <= maxWidth) return oneLine;
  const budget = maxWidth - 1;
  let acc = "";
  let w = 0;
  for (const ch of oneLine) {
    const cw = visualWidth(ch);
    if (w + cw > budget) break;
    acc += ch;
    w += cw;
  }
  return `${acc}…`;
}

const MAX_DETAIL = 80;
/** 装饰预留（形态见 `formatToolStatusLine`）：最长前缀是失败态的
 *  `[失败] ` + 工具名，historically 定为 12 列（`[运行中] ` 9 列 + ` · `
 *  3 列的旧口径，D1 废状态括号后保留为保守常量——工具名在此预算内）。
 *  detail 收口后单行不折；running bash 的前缀另在拼装处整行兜底收口。 */
const CHROME_RESERVE = 12;

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : {};
}

function countLines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** detail 截断：给了 cols 走视觉宽度收口（保证单行不折），否则 legacy 80。 */
function clipDetail(s: string, name: string, cols: number | undefined): string {
  if (cols === undefined) return clipOneLine(s, MAX_DETAIL);
  const budget = Math.max(4, cols - visualWidth(name) - CHROME_RESERVE);
  return clipOneLineVisual(s, Math.min(MAX_DETAIL, budget));
}

/** 字段提取辅助：string 字段（缺失 → fallback），避免逐 case 重复防御。 */
function pickString(
  rec: Record<string, unknown>,
  key: string,
  fallback = "?"
): string {
  const v = rec[key];
  return typeof v === "string" ? v : fallback;
}

/** 字段提取辅助：number 字段（缺失/非有限数 → null）。 */
function pickNumber(rec: Record<string, unknown>, key: string): number | null {
  const v = rec[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** LSP 工具：共享「file[:line]」模板（definition/references/hover/...）。 */
function lspAt(rec: Record<string, unknown>, name: string): string {
  const file = pickString(rec, "file");
  const line = pickNumber(rec, "line");
  return `LSP ${name.replace("lsp_", "")} ${file}${line !== null ? `:${line}` : ""}`;
}

/** 子代理工具专属显示（与普通工具行区分；主流 Agent 惯例：子代理调用有独立
 *  视觉，不与普通工具共用 `name · detail` 过程行形态）。几何字形，无 emoji
 *  （spec #146:86）。 */
export const SUBAGENT_TOOL_LABEL = "子代理";

/** 子代理工具判定：spawn_subagent（派发）+ subagent_result（轮询）。 */
export function isSubagentTool(name: string): boolean {
  return name === "spawn_subagent" || name === "subagent_result";
}

/** 子代理工具状态字形：running → ▣，ok → ✓，failed → ✗。 */
export function subagentDisplayMark(kind: "running" | "ok" | "failed"): string {
  if (kind === "ok") return "✓";
  if (kind === "failed") return "✗";
  return "▣";
}

/** spawn 工具 input 的 catalog role 投影（与 SubagentIdentityStrip 同源 fallback）。 */
export const SUBAGENT_ROLE_FALLBACK = "general-purpose";

/** 从 spawn_subagent tool_use input 解析 catalog id（`subagent_type` → `role` → fallback）。 */
export function resolveSubagentRoleFromInput(
  rec: Record<string, unknown>
): string {
  const fromType = pickString(rec, "subagent_type", "").trim();
  if (fromType.length > 0 && fromType !== "?") return fromType;
  const fromRole = pickString(rec, "role", "").trim();
  if (fromRole.length > 0 && fromRole !== "?") return fromRole;
  return SUBAGENT_ROLE_FALLBACK;
}

function spawnSubagentSettledSummary(rec: Record<string, unknown>): string {
  return resolveSubagentRoleFromInput(rec);
}

function spawnSubagentRunningSummary(rec: Record<string, unknown>): string {
  return `${resolveSubagentRoleFromInput(rec)} running`;
}

/** write_file 摘要：`Wrote <path> (N lines)`。N = `content` 行数（空串 →
 *  真实的 0 行，区别于运行中「未知」）。 */
function wroteLinesSummary(rec: Record<string, unknown>): string {
  return `Wrote ${pickString(rec, "path")} (${countLines(rec.content)} lines)`;
}

/** edit_file 摘要：`Edited <path> (N → M lines)`。行数取 old_str / new_str
 *  自身行数（本次改动片段的规模，不是整文件）—— 改动本身由 **edit diff
 *  preview** 承担，标题行不再夹 old→new 片段。 */
function editedFileSummary(rec: Record<string, unknown>): string {
  const all = rec.replace_all === true;
  const oldLines = countLines(rec.old_str);
  const newLines = countLines(rec.new_str);
  return `Edited ${pickString(rec, "path")}${all ? " (all)" : ""} (${oldLines} → ${newLines} lines)`;
}

/** write_file 运行中摘要：路径与行数都只在**已知**时出现。运行中的 input 是
 *  流式半成品 —— `content` 缺失 / 非 string / 空串都只说明「还没到」，不是
 *  「文件有 0 行」，此时只画路径；连 `path` 都还没到 → 空串（调用方落到裸
 *  `write_file` 过程行，不画 `Wrote ?`）。落定态（summary）的空 content 才
 *  是真实的空文件，仍显示 `(0 lines)`。
 *
 *  运行中文案 = 挤档形态 `Wrote <path> (<N> lines)`：与默认预览并存 ——
 *  预览画正文，行数在标题行；子代理/多写挤视图时预览让位，标题行仍在。 */
function writeFileRunningSummary(r: Record<string, unknown>): string {
  const path = r.path;
  if (typeof path !== "string" || path.length === 0) return "";
  const content = r.content;
  if (typeof content !== "string" || content.length === 0)
    return `Wrote ${path}`;
  return `Wrote ${path} (${countLines(content)} lines)`;
}

/** 单件工具的文本显示声明：摘要 + 运行中摘要（可选）。 */
interface ToolSummaryDisplay {
  readonly summary: (rec: Record<string, unknown>) => string;
  /** 运行中摘要（可选）。字段缺席 = 运行态与落定态同文案；声明它的工具，
   *  其落定摘要含「只有 input 齐了才可信的量」（write_file 的行数）——
   *  运行中 input 是流式半成品，该量必须省略而不是显示成 0。 */
  readonly runningSummary?: (rec: Record<string, unknown>) => string;
}

/** 工具 → 文本摘要 lookup table（SSOT）。每项返回未 clip 的 detail 文本。
 *
 *  含 CLI 侧不再有「display 注册表」可查的工具（会话动作、MCP、worktree
 *  生命周期五件）—— 摘要文本单源，避免 CLI/TUI 各留一份 fallback。
 *  人读合同（specs/tui-human-display.md D1 + docs/CONTEXT.md `live tool line`）：
 *  detail 是英文「工具名 + 本轮要点」（search=query、fetch=url、read=path、
 *  grep=pattern）。
 *
 *  task worktree 生命周期五件（spec D8）—— 措辞只点名动作与目标 id，
 *  不写政策。 */
export const TOOL_SUMMARIES: Readonly<Record<string, ToolSummaryDisplay>> = {
  write_file: {
    summary: wroteLinesSummary,
    runningSummary: writeFileRunningSummary,
  },
  bash: { summary: (r) => pickString(r, "command", "") },
  edit_file: { summary: editedFileSummary },
  read_file: { summary: (r) => `Read ${pickString(r, "path")}` },
  grep: { summary: (r) => `Search ${pickString(r, "pattern")}` },
  glob: { summary: (r) => `Glob ${pickString(r, "pattern")}` },
  // web / memory / search 类：聚焦首个关键字段，避免 JSON 全文外露。
  web_search: { summary: (r) => `Search ${pickString(r, "query")}` },
  web_fetch: { summary: (r) => `Fetch ${pickString(r, "url")}` },
  memory_recall: { summary: (r) => `Recall ${pickString(r, "query")}` },
  memory_save: { summary: (r) => `Remember ${pickString(r, "title")}` },
  tool_search: {
    summary: (r) => {
      const query = pickString(r, "query", "");
      if (query.length > 0) return `Tool search ${query}`;
      if (Array.isArray(r.names) && r.names.length > 0) {
        const firstName = r.names[0];
        return `Tool search ${typeof firstName === "string" ? firstName : r.names.length}`;
      }
      return "Tool search ?";
    },
  },
  skill: { summary: (r) => `skill ${pickString(r, "name")}` },
  spawn_subagent: {
    summary: spawnSubagentSettledSummary,
    runningSummary: spawnSubagentRunningSummary,
  },
  subagent_result: { summary: (r) => `Poll ${pickString(r, "task_id")}` },
  // LSP 工具集：10 件。8 件共享 file[:line] 模板；documentSymbol / workspaceSymbol 走各自形态。
  lsp_definition: { summary: (r) => lspAt(r, "lsp_definition") },
  lsp_references: { summary: (r) => lspAt(r, "lsp_references") },
  lsp_hover: { summary: (r) => lspAt(r, "lsp_hover") },
  lsp_go_to_implementation: {
    summary: (r) => lspAt(r, "lsp_go_to_implementation"),
  },
  lsp_prepare_call_hierarchy: {
    summary: (r) => lspAt(r, "lsp_prepare_call_hierarchy"),
  },
  lsp_incoming_calls: { summary: (r) => lspAt(r, "lsp_incoming_calls") },
  lsp_outgoing_calls: { summary: (r) => lspAt(r, "lsp_outgoing_calls") },
  lsp_diagnostics: { summary: (r) => lspAt(r, "lsp_diagnostics") },
  lsp_document_symbol: {
    summary: (r) => `LSP documentSymbol ${pickString(r, "file")}`,
  },
  lsp_workspace_symbol: {
    summary: (r) => `LSP workspaceSymbol ${pickString(r, "query")}`,
  },
  // bash_output / bash_stop / todo_write / list_mcp_resources /
  // read_mcp_resource / query_trace：无内容可预览 —— 仅摘要，模型视野与现状一致。
  bash_output: {
    summary: (r) => `Bash output ${pickString(r, "task_id", "?")}`,
  },
  bash_stop: { summary: (r) => `Stopped ${pickString(r, "task_id", "?")}` },
  todo_write: { summary: (r) => `Todo ${pickString(r, "id", "?")}` },
  list_mcp_resources: { summary: () => "MCP resources" },
  read_mcp_resource: {
    summary: (r) => `MCP resource ${pickString(r, "uri", "?")}`,
  },
  query_trace: { summary: () => "Trace query" },
  // task worktree 生命周期五件（spec D5）：人读过程行用新注册名，动作 + 目标 id。
  "create-task-worktree": { summary: () => "Created worktree" },
  "enter-task-worktree": {
    summary: (r) => `Entered worktree ${pickString(r, "conversationId", "?")}`,
  },
  "exit-task-worktree": { summary: () => "Exited worktree" },
  "remove-task-worktree": {
    summary: (r) => `Removed worktree ${pickString(r, "conversationId", "?")}`,
  },
  "list-task-worktrees": { summary: () => "Listed worktrees" },
};

/**
 * 单个工具调用的参数摘要。`cols` = 终端列宽：提供时 detail 按视觉宽度
 * 收口到「装饰 + 工具名 + detail」单行放得下（窄终端不折行，行账不漂移）。
 *
 * `opts.running` = 该调用的 input 还是流式半成品（运行中）：声明了
 * `runningSummary` 的工具走运行态摘要，省略「只有 input 齐了才可信的量」
 * （write_file 行数）。未声明 → 与落定态同文案，行为不变。
 *
 * lookup table（TOOL_SUMMARIES）dispatch：每个工具独立摘要器，函数体保持
 * ≤10 行 / 圈复杂度 ≤10（complexity-anti-drift）；未知工具走 `(name)`
 * 占位符（2026-08-13 用户反馈 tool fold 不该 JSON 全文外露）。
 */
export function summarizeToolCall(
  name: string,
  input: unknown,
  cols?: number,
  opts?: { readonly running?: boolean }
): { detail: string } {
  const rec = inputRecord(input);
  const clip = (s: string): string => clipDetail(s, name, cols);
  const declared = TOOL_SUMMARIES[name];
  if (declared !== undefined) {
    const summarize =
      opts?.running === true && declared.runningSummary !== undefined
        ? declared.runningSummary
        : declared.summary;
    return { detail: clip(summarize(rec)) };
  }
  // 真未知工具：仅显示工具名占位，避免 JSON 全文外露
  // （2026-08-13 用户反馈 tool fold 不该把 input args 全 JSON stringify）。
  return { detail: clip(`(${name})`) };
}

/**
 * T5:运行中 partial JSON 文本的摘要。对逐段累积的 `partialJson` 尽力
 * `JSON.parse`：
 *  - parse 成功 → 走 `summarizeToolCall`（运行语义：注册表声明了
 *    `runningSummary` 的工具省略未知量 —— partial 里的 `content` 可能只是
 *    「还没到」，不能显示成 `（0 行）`）；
 *  - parse 失败（partial 不完整 JSON，如 `{"command":"l`）或 primitive 形态
 *    （null / 数字 / 布尔）→ `clipDetail` 原样截断显示（单源，视觉宽度纪律）；
 *  - 空串 → 空串。
 *
 * 遮蔽说明：partial 里可能含密钥形态，但增量只服务展示层中间态——完成后的
 * 权威完整 input 才进模型；此处仅视觉截断，不接 output mask（风险低，保持
 * 单行收口简单）。
 *
 * 消费方：TUI live 行 + CLI stream preview sink（CLI 无 input-complete 事件，
 * 只能拿累积的 partialJson 求 detail —— 同一函数保证两侧字节一致）。
 */
export function summarizePartialInput(
  name: string,
  partialJson: string,
  cols?: number
): string {
  if (partialJson.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(partialJson);
  } catch {
    parsed = undefined;
  }
  // 不完整 JSON（parse 失败）或 primitive 形态（null / 数字 / 布尔 —— 工具参数
  // 语义上只有 object/array）→ 原样截断显示。截断口径 = clipDetail 单源
  // （与完成态摘要同一视觉宽度纪律，避免预算公式漂移）。
  if (
    parsed === undefined ||
    (typeof parsed !== "object" && typeof parsed !== "boolean")
  ) {
    return clipDetail(partialJson, name, cols);
  }
  return summarizeToolCall(name, parsed, cols, { running: true }).detail;
}

/** 运行中 bash 过程行的人读前缀：`Running 1 shell command…`。命令可见时
 *  拼 ` · <command>`（分隔符只在有 detail 时出现 —— input 未到 / 命令为空
 *  的过程行不留悬空 ` ·`）。
 *  `1%`→`100%` 这类进度流按**同一行原地更新**（spec D6 / progress tick），
 *  不按行追加进气泡 —— 本函数只产一行，历史不存百分比。 */
export const BASH_RUNNING_PREFIX = "Running 1 shell command…";

/** 工具状态行文案 SSOT（#693 T1 D1/D7 + #tui-render-overhaul T3 +
 *  specs/tui-human-display.md D1）。
 *
 * 历史与 live 两侧的「工具状态行」拼装收敛到本函数（CLI stream preview 同源）：
 *  - 普通工具成功：`name · detail`（无状态括号，状态由颜色/glyph 表达）；
 *  - 普通工具运行中：**live tool line** —— 英文过程行，`name · detail`
 *    （detail 由 TOOL_SUMMARIES 给英文要点）；运行中的 shell 语义只体现在
 *    bash 命令前的 `Running N shell command(s)…` 段，命令本身可见；
 *  - 失败：`[失败] name · detail`（failure overlay 不在本票改动面）。
 *  - 子代理工具（spawn_subagent / subagent_result）独立形态：只画 detail
 *    （glyph / 身份行由 identity strip + SubagentPanel 承担）。
 *
 * `[运行中]` / `[完成]` 前缀整体作废（D1）—— 进行中由英文过程行表达，
 * 落定由颜色/glyph 表达。cols 透传（与 `summarizeToolCall(cols)` 同纪律）：
 * 给定时 detail 按视觉宽度收口到单行放得下；缺省 → legacy 80 字符截断
 * （既有调用方字节兼容）。`detail` 可选 override：装配层已完成事件携带
 * precomputed detail（liveToolReducer 落地）时，通过显式 detail 跳过
 * `summarizeToolCall` 重算，保证 reducer state.detail 字节一致。 */
export function formatToolStatusLine(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly status: "running" | "ok" | "failed";
  readonly detail?: string;
  readonly cols?: number;
}): string {
  const detail =
    opts.detail ??
    summarizeToolCall(opts.toolName, opts.input, opts.cols, {
      running: opts.status === "running",
    }).detail;
  // plans/tui-chrome-interaction.md T7：子代理工具（spawn_subagent /
  // subagent_result）不再以 `▣ 子代理 · detail` 形态作为 live / history 工具
  // 卡 —— 子代理状态由 identity strip（prompt 正上方 `{role} running...`）
  // + SubagentPanel（输入框下方 task list）单独表达，避免 dual render。
  // 工具卡仅保留 `detail`（spawn → `{role} running` / `{role}`；task 正文
  // 只在 SubagentPanel；subagent_result → `Poll <task_id>`）。
  if (isSubagentTool(opts.toolName)) {
    return detail;
  }
  if (opts.status === "failed") {
    if (detail.length === 0) return `[失败] ${opts.toolName}`;
    return `[失败] ${opts.toolName} · ${detail}`;
  }
  if (opts.status === "running" && opts.toolName === "bash") {
    // 运行中 bash：`Running 1 shell command… · <command>` —— 前缀给 shell
    // 语义，命令保持可见（D1「Running 的命令可见」）。detail 空（input 未到）
    // → 只有前缀（过程行仍立得住，不退化成裸工具名），不画 `· ?`、
    // 也不留悬空分隔符（单行视觉宽度收口也在下面兜底）。
    if (detail.length === 0) return BASH_RUNNING_PREFIX;
    const joined = `${BASH_RUNNING_PREFIX} · ${detail}`;
    return opts.cols !== undefined
      ? clipOneLineVisual(joined, Math.max(1, opts.cols))
      : joined;
  }
  if (detail.length === 0) return opts.toolName;
  return `${opts.toolName} · ${detail}`;
}

/** 运行时 postToolUse 事件的摘要行文案（turn 进行中逐条出现）。
 *  委托 `formatToolStatusLine`（#693 T1 D7 SSOT）—— live 完成行 / 历史
 *  完成行 / running 行共用同一文案契约，避免复制粘贴模板。
 *
 *  字节规则（spec D7 + #tui-render-overhaul T3）：
 *   - 普通工具成功：detail 非空 → `name · detail`；detail 空 → `name`。
 *     完成前缀已去掉（状态由颜色/glyph 表达），行首不残留多余空格。
 *   - 普通工具失败：`[失败] name · detail` / `[失败] name`（保留明示前缀）。
 *   - 子代理工具（spawn_subagent / subagent_result）独立形态：
 *     `✓|✗ 子代理 · detail` / `✓|✗ 子代理`（glyph 已表状态，不拼 [xxx] 前缀）。
 *
 *  kind 入参兼容 history 用例：仅识别 `"ok"`（→ ok），其它任意值按
 *  failed 处理。
 *
 *  `detail` 可选 override：装配层已完成事件携带 precomputed detail
 *  （如 liveToolReducer 落地）时，通过显式 detail 跳过 summarizeToolCall
 *  重算，保证完成事件渲染与 reducer state.detail 字节一致。
 *
 *  `cols` 透传：提供时 detail 按视觉宽度收口（与 summarizeToolCall 同纪律）；
 *  缺省 → legacy 80 字符截断（与既有调用方字节兼容）。 */
export function formatLiveToolEvent(opts: {
  readonly toolName: string;
  readonly input: unknown;
  readonly kind: string;
  /** 显式 detail override；提供时跳过 summarizeToolCall 重算。 */
  readonly detail?: string;
  /** 终端列宽（可选）：提供时 detail 按视觉宽度收口；缺省 legacy 80 截断。 */
  readonly cols?: number;
}): string {
  const status: "ok" | "failed" = opts.kind === "ok" ? "ok" : "failed";
  return formatToolStatusLine({
    toolName: opts.toolName,
    input: opts.input,
    status,
    detail: opts.detail,
    cols: opts.cols,
  });
}

/** 流式折叠行文案（恒 `Thinking…`，无实时秒数 —— 见 think-fold.ts 模块注释）。
 *  放在本模块是因为 CLI 的「思考中…」spinner 与 TUI 的折叠行必须同一文案
 *  （D1：CLI 与 TUI 共用；CLI import src/tui 是反向分层，禁止）。 */
export function formatThinkingLive(): string {
  return "Thinking…";
}
