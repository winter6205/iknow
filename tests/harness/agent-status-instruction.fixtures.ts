/**
 * spec agent-status-instruction-echo T5 轨迹夹具（黄金集 <agent_status> 面）。
 *
 * 固定输入 = 非空 stale todo 账本 + 与其冲突的 pivot 指令进场；
 * 可判定行为 = 模型下一跳首工具为 `todo_write`（先对齐账本再继续新方向），
 * 而非沿用旧任务轨迹（事故依据 conversation `ee13c787`）。
 *
 * 黄金集四件的落点（SSOT：docs/guides/prompt-development.md 名册行）：
 *   - STATIC 锁   = tests/harness/agent-status-instruction-golden.test.ts
 *   - SEAM 锁     = tests/harness/agent-status-instruction-bar.test.ts（T3 回显）
 *                    + tests/harness/agent-status-reconcile.test.ts（T4 结算）
 *   - 轨迹集离线半边 = tests/harness/agent-status-instruction-golden.test.ts
 *   - 真模型半边  = archive/tests-real-llm/agent-status-instruction-echo.test.ts
 *                    （`npm run test:real-llm`；缺 key → 如实 Not run）
 *
 * 共处纪律照 tests/harness/graph/graph-mode-notification.fixtures.ts：
 * 夹具与被锁行为同目录区，不另开总柜。
 *
 * prompt 只描述新方向的工作，绝不点名 `todo_write` 或对齐机制：把模型
 * 转向账本的唯一文案是栏里的 reconcile 常量行（SSOT：
 * src/harness/agent-status.ts 的 AGENT_STATUS_RECONCILE_LINE）。prompt 若
 * 点名工具，轨迹即空转（verdict vacuous）。
 */

export type AgentStatusInstructionFixtureId =
  | "a1-pivot-arrival-first-tool-todo-write";

export interface AgentStatusInstructionFixture {
  readonly id: AgentStatusInstructionFixtureId;
  /** Vitest `-t` 子串；夹具可单独跑。 */
  readonly title: string;
  /**
   * 播种进 `<todoDir>/todos.md` 的 stale 账本（旧方向的未完成条目）。
   * 真模型臂以 `conversationId: undefined` 装配 → 栏读根 todos.md
   * （与 readOpenTodoLines 的 legacy shared-root 形态同一 SSOT 解析）。
   */
  readonly staleLedger: string;
  /** 作为真实用户消息进 run() 的 pivot 指令。 */
  readonly pivotPrompt: string;
  /** pivot 进场后下一跳首工具的可判定 verdict。 */
  readonly expectedFirstTool: "todo_write";
}

/** prompt 命中即 verdict 空转的 token（机制归栏文案，不归用户指令）。 */
export const AGENT_STATUS_FIXTURE_FORBIDDEN_PROMPT_TOKENS: readonly string[] =
  Object.freeze([
    "todo_write",
    "todo",
    "ledger",
    "reconcile",
    "agent_status",
    "status bar",
  ]);

export const AGENT_STATUS_INSTRUCTION_FIXTURES: readonly AgentStatusInstructionFixture[] =
  Object.freeze([
    {
      id: "a1-pivot-arrival-first-tool-todo-write",
      title: "A1: pivot 进场 + 非空 stale 账本 → 首工具 todo_write",
      staleLedger:
        "- [ ] [t1] Migrate the auth module to JWT access tokens\n" +
        "- [~] [t2] Rotate refresh tokens in the session store\n",
      pivotPrompt:
        "The JWT auth migration in your current plan is cancelled — do not " +
        "touch auth anymore. We are shipping a Node 22 compatibility pass " +
        "instead: check which Node version package.json engines pins, update " +
        "that field to 22, refresh the README setup section to match, and " +
        "re-run npm test. This new direction replaces the old plan outright; " +
        "start now and report what changed.",
      expectedFirstTool: "todo_write",
    },
  ]);

export function agentStatusFixtureById(
  id: AgentStatusInstructionFixtureId
): AgentStatusInstructionFixture {
  const fixture = AGENT_STATUS_INSTRUCTION_FIXTURES.find((f) => f.id === id);
  if (fixture === undefined) throw new Error(`missing fixture: ${id}`);
  return fixture;
}
