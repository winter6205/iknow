/**
 * #645 T1 / ADR-0028 / CONTEXT「状态栏」: 现势快照 —— 纯构造器 + IO 读取器。
 *
 * 边界:
 *   - `buildAgentStatusText` 纯函数(无 IO、无时间 / 随机依赖),T3(TUI
 *     只读最新现势)复用同一份快照计算发事件,不与消息编码内部耦合;
 *   - `readOpenTodoLines` 只投影 `<todoDir>/todos.md` 里 `- [ ]` 开头的
 *     未勾行,逐字保留;文件缺席 / 空文件 / 全勾 / 读取失败 → 空列表,
 *     绝不把读失败抛进模型回合(当"无 todo 段"静默处理);
 *   - 栏文本只承载代码算出的现势(last_tool + 未勾 todo 段),不含政策
 *     散言 / 读规则 / 跳过条件(那些归 T2 的 system 前缀与 tool
 *     description)。空槽不广告:无未勾项时整段缺席,不印空列表。
 *
 * 本模块不改 todo_write 的 add/check/list 语义,只读文件。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OPEN_PREFIX, TODOS_FILE } from "./aci/tools/todo-write.js";

// 未勾行锚点:直接复用账本写入方 todo-write.ts 导出的 OPEN_PREFIX —— 写入
// 与投影共享同一真源(含尾随空格,只匹配写入方产出的行形态,不误匹配裸
// "- [ ]" 拼接的畸形行)。todo 账本文件名同理(TODOS_FILE)。

/**
 * 本回合尚未跑过工具时的 last_tool 值(ADR-0028 Consequences:
 * "本回合尚未跑过工具则为 idle")。
 */
export const AGENT_STATUS_IDLE_TOOL = "idle";

/** 现势快照数据(栏文本的单一真源;T3 从同一份数据发 TUI 事件)。 */
export interface AgentStatusSnapshot {
  /** 上一跳刚完成的工具名(run 作用域);本回合尚未跑过工具 = "idle"。 */
  readonly lastTool: string;
  /** todos.md 里逐字投影的未勾 `- [ ]` 行;无未勾项 = 空列表。 */
  readonly openTodoLines: ReadonlyArray<string>;
}

/**
 * 纯构造器:快照数据 → 栏文本。
 *
 * 形状(最小机器可读 `<agent_status>` 包装):
 *
 * ```
 * <agent_status>
 * last_tool: <name>
 * todos:
 * - [ ] <item>
 * </agent_status>
 * ```
 *
 * todo 段(`todos:` 头 + 未勾行)仅在存在未勾项时出现 —— 空槽不广告。
 */
export function buildAgentStatusText(snapshot: AgentStatusSnapshot): string {
  const lines: string[] = ["<agent_status>", `last_tool: ${snapshot.lastTool}`];
  if (snapshot.openTodoLines.length > 0) {
    lines.push("todos:");
    lines.push(...snapshot.openTodoLines);
  }
  lines.push("</agent_status>");
  return lines.join("\n");
}

/**
 * IO 读取器:读 `<todoDir>/todos.md`,只投影 `- [ ]` 开头的未勾行(逐字,
 * 保序)。文件缺席 / 空文件 / 全勾 / 任何读取失败 → 空列表;绝不 throw
 * (调用侧是即将进行的模型回合,读失败按"无 todo 段"处理,无 fallback
 * 噪音)。
 */
export async function readOpenTodoLines(
  todoDir: string
): Promise<ReadonlyArray<string>> {
  try {
    const content = await readFile(join(todoDir, TODOS_FILE), "utf8");
    return content.split("\n").filter((line) => line.startsWith(OPEN_PREFIX));
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
}): Promise<AgentStatusSnapshot & { readonly text: string }> {
  const snapshot: AgentStatusSnapshot = {
    lastTool: opts.lastTool,
    openTodoLines: await readOpenTodoLines(opts.todoDir),
  };
  return { ...snapshot, text: buildAgentStatusText(snapshot) };
}
