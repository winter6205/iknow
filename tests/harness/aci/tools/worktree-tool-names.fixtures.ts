/**
 * Golden set for the worktree ACI rename (ADR-0082 family).
 *
 * Invariant: the registered model-facing worktree tools are the `-worktree`
 * family (create / enter / exit / list / remove), and a fixed operator input
 * has a decidable first tool — operator asks to create → `create-worktree`,
 * asks to list → `list-worktrees`.
 *
 * Prompt-development (`docs/guides/prompt-development.md`): fixtures ship
 * with the description edit. First-tool verdicts run under
 * `npm run test:real-llm` (archive/tests-real-llm sibling); missing key →
 * explicit skip + Not run.
 */

export const WORKTREE_TOOL_NAMES = Object.freeze([
  "create-worktree",
  "enter-worktree",
  "exit-worktree",
  "list-worktrees",
  "remove-worktree",
] as const);

export type WorktreeToolName = (typeof WORKTREE_TOOL_NAMES)[number];

/** Registered names before ADR-0082 — banned from the model surface. */
export const LEGACY_WORKTREE_TOOL_NAMES = Object.freeze([
  "create-task-worktree",
  "enter-task-worktree",
  "exit-task-worktree",
  "list-task-worktrees",
  "remove-task-worktree",
] as const);

export type WorktreeToolFixtureId = "sc3-create" | "sc4-list";

export interface WorktreeToolFixture {
  readonly id: WorktreeToolFixtureId;
  /** Vitest `-t` substring; each fixture is individually runnable. */
  readonly title: string;
  readonly userPrompt: string;
  readonly spec: "SC3" | "SC4";
  /** The first tool call the model must make for this input. */
  readonly expectedFirstTool: WorktreeToolName;
  /**
   * Tools allowed to appear BEFORE `expectedFirstTool` without making the
   * verdict undecidable. Only the read-only discovery pair qualifies:
   * `grep` / `glob` are how the agent inspects the repo before calling a
   * worktree tool, and a golden fixture must not punish a legitimate
   * reconnaissance step (prompt-development: a decidable trajectory does not
   * mean exactly one call).
   * Any other tool before `expectedFirstTool` fails the fixture — in
   * particular `bash`, which is what a model reaches for when it tries to
   * emulate `list-worktrees` by hand.
   */
  readonly toleratedPreludeTools: readonly string[];
}

export const WORKTREE_TOOL_FIXTURES: readonly WorktreeToolFixture[] =
  Object.freeze([
    {
      id: "sc3-create",
      spec: "SC3",
      title:
        "SC3: operator asks to create a worktree → first tool create-worktree",
      userPrompt:
        "隔离开着，我这个会话还没有绑工作树。先建一棵工作树，标签 fix-648；" +
        "后面的改动都放进那棵树里。",
      expectedFirstTool: "create-worktree",
      toleratedPreludeTools: ["grep", "glob"],
    },
    {
      id: "sc4-list",
      spec: "SC4",
      title:
        "SC4: operator asks which worktrees exist → first tool list-worktrees",
      userPrompt:
        "这个仓库现在有哪些 task 工作树？用 list-worktrees 工具列出来给我看看，" +
        "我不需要新建。不要用 bash 或 git 命令代替它。",
      expectedFirstTool: "list-worktrees",
      toleratedPreludeTools: ["grep", "glob"],
    },
  ]);

/**
 * Index of the first tool call that is NOT a tolerated prelude, i.e. the
 * tool the trajectory is actually decided on. `-1` when the whole trace is
 * prelude (the caller treats that as "no decidable first tool").
 */
export function decidingToolIndex(
  uses: ReadonlyArray<{ readonly name: string }>,
  fixture: { readonly toleratedPreludeTools: readonly string[] }
): number {
  return uses.findIndex((u) => !fixture.toleratedPreludeTools.includes(u.name));
}

export function worktreeFixtureById(
  id: WorktreeToolFixtureId
): WorktreeToolFixture {
  const found = WORKTREE_TOOL_FIXTURES.find((f) => f.id === id);
  if (found === undefined) {
    throw new Error(`worktree tool fixture missing: ${id}`);
  }
  return found;
}
