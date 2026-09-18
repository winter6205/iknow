/**
 * #645 T1 / ADR-0028 / CONTEXT「状态栏」: 现势快照 —— 纯构造器 + IO 读取器。
 *
 * 边界:
 *   - `buildAgentStatusText` 纯函数(无 IO、无时间 / 随机依赖),T3(TUI
 *     只读最新现势)复用同一份快照计算发事件,不与消息编码内部耦合;
 *   - `readOpenTodoLines` 只投影 `<projectDir>/<conversationId>/todos.md`
 *     里未完成的条目(pending + in_progress,绝不含 completed),按账本语法
 *     SSOT 规范化成带 id 的行形态(`- [ ] [tN] subject` /
 *     `- [~] [tN] subject`);文件缺席 / 空文件 / 全完成 / 读取失败 →
 *     空列表,绝不把读失败抛进模型回合(当"无 todo 段"静默处理);
 *     `projectDir` 在 T2 / session-folder-consolidation 起是「会话文件夹根」
 *     (`resolveProjectSessionDir(baseDir, projectIdentityRoot)`),由 chat /
 *     serve / TUI 三入口用同一对 `(baseDir, projectIdentityRoot)` 派生,保证
 *     同一会话解析到同一 projectDir(T2 关键判据);
 *   - 栏文本只承载代码算出的现势(last_tool + 未完成 todo 段),不含政策
 *     散言 / 读规则 / 跳过条件(那些归 T2 的 system 前缀与 tool
 *     description)。空槽不广告:无未勾项时整段缺席,不印空列表。
 *
 * 本模块不改 todo_write 的 read/add/update/replace 语义（ADR-0085 三件事 +
 * replace 整表逃生口；`check` 已并入 update）,只读文件。
 */
import { readFile } from "node:fs/promises";
import type { AnthropicNativeMessage } from "./model-adapter/types.js";
import { formatLedgerLine, parseLedger } from "./aci/tools/todo-ledger.js";
import { resolveConversationTodoPath } from "./aci/tools/todo-write.js";

// 投影锚点:账本语法 SSOT 是 todo-ledger.ts 的 parseLedger / formatLedgerLine
// —— 投影不再按行前缀逐字透传,而是解析后重建规范行(带 id、状态标记正确),
// 写入侧与投影侧共用同一份语法定义,畸形 / 遗留行也走同一条解析路径。

/**
 * 本回合尚未跑过工具时的 last_tool 值(ADR-0028 Consequences:
 * "本回合尚未跑过工具则为 idle")。
 */
export const AGENT_STATUS_IDLE_TOOL = "idle";

/**
 * reconcile 行的固定文本(spec invariant 4:它是栏内行不是 system,
 * 跨回合 / 跨会话字节恒定)。导出为常量件供测试与注入名册完备性锁引用。
 */
export const AGENT_STATUS_RECONCILE_LINE =
  "reconcile: A new user instruction has arrived; if it conflicts with the current todo ledger, reconcile the ledger via todo_write first, then continue.";

/** 现势快照数据(栏文本的单一真源;T3 从同一份数据发 TUI 事件)。 */
export interface AgentStatusSnapshot {
  /** 上一跳刚完成的工具名(run 作用域);本回合尚未跑过工具 = "idle"。 */
  readonly lastTool: string;
  /** 未完成条目的规范账本行(pending + in_progress,带 id);无 = 空列表。 */
  readonly openTodoLines: ReadonlyArray<string>;
  /**
   * 最新真实用户指令首行逐字回显(spec ADR-0103);null / 缺席 → 整行缺席
   * (空槽不广告)。可选是为了让 T3 接线前的旧装配点(compute / TUI 事件)
   * 原样编译,parse 侧总是显式给出 null。
   */
  readonly instruction?: string | null;
  /**
   * 本栏是否携带 pivot reconcile 标记(进场后首跳一次性);false / 缺席 →
   * 整行缺席。结算算法归 T3,这里只承载字段。
   */
  readonly reconcile?: boolean;
}

/**
 * 纯构造器:快照数据 → 栏文本。
 *
 * 形状(最小机器可读 `<agent_status>` 包装):
 *
 * ```
 * <agent_status>
 * last_tool: <name>
 * instruction: <最新真实用户指令首行逐字>(null / 缺席 → 整行缺席)
 * reconcile: <固定标记句>(false / 缺席 → 整行缺席)
 * todos:
 * - [ ] <item>
 * </agent_status>
 * ```
 *
 * instruction / reconcile / todo 段都是「空槽不广告」的可选段;标量段
 * (instruction / reconcile)与 last_tool 一律排在 `todos:` 头之前(次序纪律)。
 */
/** 栏文本形态检测（TUI 隐藏注入气泡、turn 边界、测试夹具共用）。 */
export function isAgentStatusText(text: string): boolean {
  return text.trimStart().startsWith("<agent_status>");
}

export function buildAgentStatusText(snapshot: AgentStatusSnapshot): string {
  // 次序纪律(spec invariant 5):标量字段行全部先于 `todos:` 头,todo 行
  // 永远占栏末段 —— 这是旧解析器吃新栏仍得正确子集(回滚安全)的根。
  const lines: string[] = ["<agent_status>", `last_tool: ${snapshot.lastTool}`];
  if (snapshot.instruction !== null && snapshot.instruction !== undefined) {
    lines.push(`instruction: ${snapshot.instruction}`);
  }
  if (snapshot.reconcile === true) {
    lines.push(AGENT_STATUS_RECONCILE_LINE);
  }
  if (snapshot.openTodoLines.length > 0) {
    lines.push("todos:");
    lines.push(...snapshot.openTodoLines);
  }
  lines.push("</agent_status>");
  return lines.join("\n");
}

const LAST_TOOL_PREFIX = "last_tool: ";
const INSTRUCTION_PREFIX = "instruction: ";
const RECONCILE_PREFIX = "reconcile: ";

/**
 * 栏文本 → 现势快照(TUI resume hydrate / 测试直驱)。畸形输入 → null,不 throw。
 * 旧格式栏(无 instruction / reconcile 行)是合法输入 → 显式缺省
 * `instruction: null, reconcile: false`(spec F4,不判畸形)。
 */
export function parseAgentStatusText(text: string): AgentStatusSnapshot | null {
  if (!isAgentStatusText(text)) return null;
  const lines = text.split("\n");
  if (lines.length < 2) return null;
  if (lines[0] !== "<agent_status>") return null;
  if (lines[lines.length - 1] !== "</agent_status>") return null;
  const body = lines.slice(1, -1);
  const lastToolLine = body.find((l) => l.startsWith(LAST_TOOL_PREFIX));
  if (lastToolLine === undefined) return null;
  const instructionLine = body.find((l) => l.startsWith(INSTRUCTION_PREFIX));
  const reconcile = body.some((l) => l.startsWith(RECONCILE_PREFIX));
  const todoHeaderIndex = body.findIndex((l) => l === "todos:");
  // `todos:` 头之前的未知标量行(前向兼容)不进 todo 列表:头后才是 todo 段。
  const openTodoLines =
    todoHeaderIndex >= 0 ? body.slice(todoHeaderIndex + 1) : [];
  return Object.freeze({
    lastTool: lastToolLine.slice(LAST_TOOL_PREFIX.length),
    openTodoLines: Object.freeze([...openTodoLines]),
    instruction:
      instructionLine === undefined
        ? null
        : instructionLine.slice(INSTRUCTION_PREFIX.length),
    reconcile,
  });
}

/**
 * messages 里末条 agent_status user 消息 → 快照(冷启动 hydrate SSOT)。
 * 无栏 / 末栏畸形 → null;不读 todos.md。
 */
export function agentStatusFromMessages(
  messages: ReadonlyArray<AnthropicNativeMessage>
): AgentStatusSnapshot | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const text = m.content
      .flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n");
    if (!isAgentStatusText(text)) continue;
    return parseAgentStatusText(text);
  }
  return null;
}

/**
 * 未完成条目 → 规范账本行(保序)。completed 不投影 —— 状态栏只报没做完的。
 */
function projectUnfinishedItems(content: string): ReadonlyArray<string> {
  return parseLedger(content)
    .filter((i) => i.status !== "completed")
    .map((i) => formatLedgerLine(i).trimEnd());
}

/**
 * IO 读取器:读 `<todoDir>/[<conversationId>/]todos.md`,只投影未完成的
 * 条目(pending + in_progress,保序),按账本语法 SSOT 规范化成带 id 的行。
 * conversationId 在场 → 读该会话自己的账本(与 todo_write 写入侧同一 SSOT
 * 解析);缺席 → 根 todos.md(向后兼容)。文件缺席 / 空文件 / 全完成 /
 * 任何读取失败 → 空列表;绝不 throw(调用侧是即将进行的模型回合,读失败
 * 按"无 todo 段"处理,无 fallback 噪音)。
 */
export async function readOpenTodoLines(
  todoDir: string,
  conversationId?: string
): Promise<ReadonlyArray<string>> {
  const filePath = resolveConversationTodoPath({
    projectDir: todoDir,
    conversationId,
  });
  try {
    const content = await readFile(filePath, "utf8");
    return projectUnfinishedItems(content);
  } catch {
    // EXIT: 任何读失败(含 ENOENT / EACCES / ENOTDIR)→ 空列表
    // (ADR-0028 静默收敛:读失败当"无 todo 段",绝不抛进模型回合)
    return [];
  }
}

/**
 * 组合计算:读 todos.md 投影未勾行 + last_tool → 快照数据与栏文本。
 * T3(TUI 只读订阅)从同一份数据 / 文本派生 UI,不另建账本。
 * 永不 throw(读取失败由 readOpenTodoLines 收敛为空列表)。
 */
export async function computeAgentStatusSnapshot(opts: {
  readonly lastTool: string;
  readonly todoDir: string;
  /** 在场 → 投影该会话自己的账本(SSOT 与 todo_write 写入侧同源)。 */
  readonly conversationId?: string;
}): Promise<AgentStatusSnapshot & { readonly text: string }> {
  const snapshot: AgentStatusSnapshot = {
    lastTool: opts.lastTool,
    openTodoLines: await readOpenTodoLines(opts.todoDir, opts.conversationId),
  };
  return { ...snapshot, text: buildAgentStatusText(snapshot) };
}
