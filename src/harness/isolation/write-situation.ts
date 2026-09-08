/**
 * T3 (plans/write-situation-disclosure.md) — 写处境三态判定（expand，无消费方）。
 *
 * spec SC1 / ADR-0069 Decision 2：「此刻能不能写」由一个纯函数裁决，三态枚举
 * （`writable_main` / `writable_tree` / `no_writable_root`）落 `session-roots.ts`，
 * 渲染面与 worker prior 全部消费这个枚举，不再各自判断。本阶段**无消费方**——T4/T6
 * 才接入 `skill/body.ts` / `subagent/worker.ts`。
 *
 * 边界契约：
 *   - 纯同步函数；不碰磁盘、不跑 git、不读 settings（隔离档由调用方传入）。
 *   - 形状判定**复用** `isTaskWorktreePath`（`worktree-gate.ts:575`），不平行开
 *     第二份形状逻辑——ACR bounded-context-guardian 已钉死。
 *   - empty / 空白根 → typed 结果（`no_writable_root`），不 throw 不静默放行。
 *     「主仓对文件改动只读」语义上等价于「无可写根」——告诉模型「别写」比「空串等
 *     于主仓」更安全。
 *   - overflow：极长 / 深嵌套 / 尾随分隔符——仍按 `isTaskWorktreePath` 裁决。
 */
import type { WriteSituation } from "../session-roots.js";
import { isTaskWorktreePath } from "./worktree-gate.js";

/**
 * 判定「此刻能否写、写哪」——三态。
 *
 * @param isolationOn  隔离档（由调用方从 settings 注入；本函数**不读** settings）
 * @param root         当前活根（taskRoot 快照，非主仓字符串）
 * @returns            写处境枚举（typed，never throw）
 */
export function writeSituation(
  isolationOn: boolean,
  root: string
): WriteSituation {
  // empty 臂：根缺席 / 仅空白 → fail-closed 落 `no_writable_root`。
  // 隔离 OFF 时也走这条——空白根不是「写主仓」，是「无根可写」。
  if (root.trim().length === 0) {
    return "no_writable_root";
  }

  // 隔离 OFF：写根 = 主仓（活根字符串此时无意义）。**形状判断不参与**——
  // 即使传入的是树形路径，也得说「写主仓」（negative 臂钉死）。
  if (!isolationOn) {
    return "writable_main";
  }

  // 隔离 ON：树形 → 写本会话的 task worktree；非树形 → 拒写。
  return isTaskWorktreePath(root) ? "writable_tree" : "no_writable_root";
}
