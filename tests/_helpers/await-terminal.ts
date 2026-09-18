/**
 * 「等到某个 SubAgentManager 的任务全部终态」的共享轮询。
 *
 * 收敛三处逐字节相同的副本（tests/e2e/subagent-acceptance.test.ts、
 * tests/e2e/subagent-foreground-trace.test.ts ×2）——同步契约原先在每个
 * 用例里各推一遍，终态名集合一变就是霰弹式修改。
 *
 * **不要拿 drain 读侧当同步**：`wait:false` 的 spawn 会立即返回 `{task_id}`，
 * `run()` 可能在 fake binary 吐信封之前就收尾；而 host drain（
 * `drainPendingSubagents`）正是这些用例要**断言**的通道 —— 用它的输出去
 * 等它自己，等于自证。判据因此落在 manager 自己的四态投影（
 * `listSubagents()`）上：任务已 spawn（≥1 条）且全部终态，即 fake binary
 * 已 emit、stdout 已 parse，此时再读 drain 才是有效断言。
 *
 * 上限 `maxPolls × pollMs` 是防挂死界，不是期望等待时长 —— 正常路径在头
 * 几次轮询内就满足。超限**不抛错**：让调用方随后的断言给出真实诊断（比如
 * drain 返回空数组），比在这里抛一个泛化的超时更有信息量。
 */
import type { SubAgentManager } from "../../src/harness/subagent/manager.ts";

export interface AwaitAllTasksTerminalOptions {
  /** 两次轮询之间的间隔（毫秒）。 */
  readonly pollMs?: number;
  /** 轮询次数上限（防挂死界，不是等待时长）。 */
  readonly maxPolls?: number;
}

/** 四态投影里的终态：到达即不再变化，可用于同步。 */
function isTerminal(state: string): boolean {
  return state === "completed" || state === "failed";
}

export async function awaitAllTasksTerminal(
  manager: Pick<SubAgentManager, "listSubagents">,
  options: AwaitAllTasksTerminalOptions = {}
): Promise<void> {
  const { pollMs = 10, maxPolls = 500 } = options;
  let polls = 0;
  const allTerminal = (): boolean => {
    const infos = manager.listSubagents();
    return infos.length > 0 && infos.every((i) => isTerminal(i.state));
  };
  while (!allTerminal() && polls < maxPolls) {
    await new Promise((r) => setTimeout(r, pollMs));
    polls += 1;
  }
}
