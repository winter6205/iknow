/**
 * Golden set for todo_write multi-item add (SC7).
 *
 * Invariant (specs/agent-control-surface.md Slice C / SC7, ADR-0085):
 * one `add` call carrying a multi-step plan appends N pending items keyed by
 * N fresh ids — the plan is never folded into a single line. Durable form:
 * `- [ ] [t<N>] <subject>`.
 *
 * Prompt-development: the fixture is the fixed input + decidable trajectory;
 * the offline half (todo-multi-add.test.ts) proves the tool accepts the
 * fixture shape and produces the decidable ledger.
 *
 * 登记缺口：本集暂无 real-LLM 半边（首工具轨迹需真跑模型），故「模型是否真
 * 会一次 add 多条」尚未被轨迹集判定；补半边时须把新文件加入
 * vitest.real-llm.config.ts 的 include。
 */

export type TodoMultiAddFixtureId = "sc7-plan-multi-step";

export interface TodoMultiAddFixture {
  readonly id: TodoMultiAddFixtureId;
  /** Vitest `-t` substring; each fixture is individually runnable. */
  readonly title: string;
  readonly spec: "SC7";
  readonly userPrompt: string;
  /** The `add` call the model is expected to make on its first todo_write. */
  readonly expectedAddInput: { readonly mode: "add"; readonly items: ReadonlyArray<string> };
}

const PLAN_STEPS: ReadonlyArray<string> = [
  "read env.ts and settings.ts interfaces",
  "write the failing merge test",
  "implement the project-file allowlist",
  "run npm test and fix regressions",
];

export const TODO_MULTI_ADD_FIXTURES: readonly TodoMultiAddFixture[] =
  Object.freeze([
    {
      id: "sc7-plan-multi-step",
      spec: "SC7",
      title: "SC7: multi-step plan → one todo_write add carrying items[...] (N ids)",
      userPrompt:
        "This settings change spans four steps: read the env/settings interfaces, " +
        "write the failing merge test, implement the project-file allowlist, then run " +
        "npm test and fix regressions. Track these four steps in the todo ledger so " +
        "progress persists across turns, then start with step one.",
      expectedAddInput: { mode: "add", items: PLAN_STEPS },
    },
  ]);

export function todoMultiAddFixtureById(
  id: TodoMultiAddFixtureId
): TodoMultiAddFixture {
  const found = TODO_MULTI_ADD_FIXTURES.find((f) => f.id === id);
  if (found === undefined) {
    throw new Error(`todo multi-add fixture missing: ${id}`);
  }
  return found;
}

/**
 * Expected durable ledger for the fixture's add call: one pending line per
 * step, ids t1..tN in plan order.
 */
export function expectedLedgerLines(
  fixture: TodoMultiAddFixture
): ReadonlyArray<string> {
  return fixture.expectedAddInput.items.map(
    (subject, index) => `- [ ] [t${index + 1}] ${subject}`
  );
}
