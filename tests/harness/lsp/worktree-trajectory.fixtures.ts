/**
 * Golden-set fixtures for the LSP worktree-path trajectory
 * (plans/lsp-worktree-paths.md T4): after a live task-root rebind, every LSP
 * symbol query / mutation and every worktree lifecycle transition resolves
 * against the ACTIVE worktree, and the main checkout is left byte-identical.
 *
 * Placement follows the roster rule (docs/guides/prompt-development.md): the
 * set lives with the behavior it locks, under tests/harness/lsp/, beside the
 * other live-directory / rebind regressions. This file is the INDEPENDENT
 * WITNESS both halves bind to — every path, symbol name, tool name, prompt and
 * refusal marker below is a literal taken from the behavior contract, never
 * imported from src (a src edit that drifts the contract must fail the halves,
 * not follow along).
 *
 * Halves (both required for a set green; offline alone is never a set pass):
 *   offline half    = tests/harness/lsp/worktree-trajectory.test.ts
 *     (real production tool layer + real worktree provisioner seams + a real
 *      typescript-language-server)
 *   real-model half = real-llm/worktree-trajectory.test.ts
 *     (registered in TRACKED_INCLUDE of vitest.real-llm.config.ts)
 *
 * The fixture is pure data + tiny pure predicates + a filesystem seed helper;
 * each half supplies its own execution (a scripted tool-level driver offline,
 * the live model in the real-model half) and its own assertions, so the shared
 * surface is the fixed INPUT and the decidable FACTS, exactly the
 * verify-status-contract.fixtures.ts discipline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* ------------------------------ fixed tree facts ------------------------------ */

/** Relative path of the seeded source file — SAME path in every tree. */
export const RELATIVE_TS = "src/unique.ts";

/** The unique symbol declared in RELATIVE_TS (committed, so every worktree inherits it). */
export const UNIQUE_SYMBOL = "worktreeTrajectoryUnique";

/**
 * A TOP-LEVEL function in RELATIVE_TS. The file-omitted `workspace/symbol`
 * query (find_symbol) only returns top-level declarations (tsserver `navto`
 * does not list class members), so the file-less case targets THIS symbol; it
 * is also the top-level hover witness — a top-level function's declaration
 * begins at `export`, so a resolver that positions hover at the line start
 * instead of the identifier fails on this symbol. The hover / call-hierarchy /
 * rename cases otherwise target the class method UNIQUE_SYMBOL.
 */
export const WORKSPACE_QUERY_SYMBOL = "worktreeTrajectoryTopLevel";

/**
 * The class that declares UNIQUE_SYMBOL, and the NESTED `Class/method` path to
 * it. A nested path resolves only when the server returns the class's
 * `children`, so this path is the witness that the tree is genuinely nested.
 */
export const WIDGET_CLASS = "WorktreeTrajectoryWidget";
export const NESTED_METHOD_PATH = `${WIDGET_CLASS}/${UNIQUE_SYMBOL}`;

/** A caller of UNIQUE_SYMBOL — the witness that call-hierarchy returns a non-empty result. */
export const CALLER_SYMBOL = "worktreeTrajectoryCaller";

/** The rename target: after a worktree rename the ACTIVE tree declares this,
 *  the main checkout still declares UNIQUE_SYMBOL. */
export const RENAMED_SYMBOL = "worktreeTrajectoryRenamed";

/* --- the "enter an existing worktree" case carries its OWN unique symbol in a
       file that only that tree has, so a query result naming it proves the
       entered tree's bytes were the ones served. --- */
export const OWNER_RELATIVE_TS = "src/owner_unique.ts";
export const OWNER_SYMBOL = "worktreeTrajectoryOwnerSymbol";

/** The interactive one-shot `.iknow` anchor dir under a main checkout. */
export const WORKTREE_SUBDIR = join(".iknow", "worktrees");

/* ------------------------------ model-visible tool vocabulary ------------------------------ */

/** The worktree lifecycle tools (model-facing names). */
export const WORKTREE_TOOL_NAMES = [
  "create-worktree",
  "enter-worktree",
  "exit-worktree",
] as const;

/** The symbol-query tools this set drives. */
export const QUERY_TOOL_NAMES = [
  "find_declaration",
  "find_symbol",
  "get_hover",
  "get_symbols_overview",
  "list_incoming_calls",
] as const;

/** The symbol-mutation tool this set drives. */
export const RENAME_TOOL_NAME = "rename_symbol";

/* ------------------------------ refusal markers ------------------------------ */

/** The no-root sentinel's prefix (`renderNoServer`, reason "no-root"): an input
 *  resolved OUTSIDE the active root stops the NearestRoot walk at the live
 *  directory and is refused — never answered from a stale tree. */
export const NO_ROOT_SENTINEL_PREFIX = "(no LSP project root found";

/**
 * The no-anchor sentinel prefix (`renderNoProjectAnchor`). It is what a fully
 * file-omitted `workspace/symbol` returns against the real
 * typescript-language-server on a document-less client: TSLS `navto` cannot
 * resolve a project until a document is open, so the answer is the documented
 * sentinel — which interpolates the LIVE root, so it is still decidable
 * evidence that the file-omitted query selected the ACTIVE tree (never the
 * stale one).
 */
export const NO_PROJECT_ANCHOR_PREFIX =
  "(LSP workspace/symbol has no project anchor under ";

/** The unsafe-path case: a relative input that escapes the active worktree
 *  (`<worktree>/../../../outside-project.ts` → the main checkout's parent
 *  sibling). It must be refused with a no-root sentinel naming the LIVE root,
 *  and must create no file anywhere. */
export const UNSAFE_ESCAPE_RELATIVE = "../../../outside-project.ts";

/* ------------------------------ source + seed fixtures ------------------------------ */

/**
 * The seeded source: a top-level declaration plus a class with two methods at
 * fixed positions. The methods back the hover / call-hierarchy cases — the
 * class method `worktreeTrajectoryCaller` calls `worktreeTrajectoryUnique`, so
 * call-hierarchy has a real caller, and the nested symbol_path
 * `WorktreeTrajectoryWidget/worktreeTrajectoryUnique` is a real path in the
 * file's symbol tree. The client advertises
 * `textDocument.documentSymbol.hierarchicalDocumentSymbolSupport`, so the
 * server answers `textDocument/documentSymbol` with a nested `DocumentSymbol`
 * tree that carries `selectionRange`; the resolver positions at the symbol's
 * own name, where hover returns real content.
 *
 * No `package.json` on purpose — the provisioner's default project-dep
 * installer then skips with `no_package_json`, so no case shells out to a real
 * `npm ci`. `package-lock.json` IS the TypeScript NearestRoot marker.
 */
export function tsSource(
  unique = UNIQUE_SYMBOL,
  caller = CALLER_SYMBOL,
  topLevel = WORKSPACE_QUERY_SYMBOL
): string {
  return [
    `export function ${topLevel}(): number {`,
    `  return 1;`,
    `}`,
    ``,
    `export class WorktreeTrajectoryWidget {`,
    `  ${unique}(): number {`,
    `    return 1;`,
    `  }`,
    ``,
    `  ${caller}(): number {`,
    `    return this.${unique}();`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * A minimal TypeScript project config. It makes tsserver load a CONFIGURED
 * project for the tree instead of an inferred one, so the anchored
 * `workspace/symbol` query keeps answering after the open window closes.
 *
 * Measured: a genuinely file-OMITTED `workspace/symbol` still answers
 * "No Project." on the real TypeScript language server — it resolves a project
 * only for an open document. That path's evidence is therefore the documented
 * no-anchor sentinel naming the LIVE root; the symbol-returning half rides
 * the anchored query. See the `wt-workspace-query-file-omitted` case.
 */
const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: { strict: true, target: "ES2020", module: "ESNext" },
    include: ["src/**/*.ts"],
  },
  null,
  2
)}\n`;

/** Write the main-checkout seed (lockfile/tsconfig markers + the shared source). */
export function seedRepoTree(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG, "utf8");
  writeFileSync(join(root, RELATIVE_TS), tsSource(), "utf8");
}

/**
 * Write a tree-EXCLUSIVE file (its own unique symbol + project markers) into an
 * already-existing tree — the "enter an existing worktree" witness. Called
 * after the owner tree is created and before the session enters it, so a
 * successful query naming OWNER_SYMBOL proves the entered tree's bytes were
 * served (the main checkout and every other tree lack this file).
 */
export function seedOwnerTree(root: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package-lock.json"), "{}\n", "utf8");
  writeFileSync(join(root, "tsconfig.json"), TSCONFIG, "utf8");
  writeFileSync(join(root, OWNER_RELATIVE_TS), tsSource(OWNER_SYMBOL), "utf8");
}

/* ------------------------------ pure predicates (both halves) ------------------------------ */

/** True when `name` is declared as an identifier token in `text`. */
export function declaresSymbol(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

/** Every `file://` URI appearing anywhere in a tool-result string. */
export function fileUrisIn(text: string): string[] {
  return [...text.matchAll(/file:\/\/[^"'\\\s)]+/g)].map((m) => m[0]!);
}

/* ------------------------------ fixed cases ------------------------------ */

export type TrajectoryCaseKind =
  | "create-query-rename"
  | "enter-query"
  | "workspace-query-file-omitted"
  | "exit-confirm-original"
  | "unsafe-refusal"
  | "hover-known-symbol"
  | "hover-top-level-symbol"
  | "hover-nested-method"
  | "call-hierarchy-known-symbol";

export type TrajectoryCase = {
  readonly id: string;
  readonly title: string;
  readonly kind: TrajectoryCaseKind;
  /**
   * The fixed model-facing input. `<OWNER_ID>` is substituted per run with the
   * conversation id that owns the pre-created tree (enter case only); every
   * other case is self-contained (it creates the tree it needs).
   */
  readonly prompt: string;
};

export const TRAJECTORY_CASES: readonly TrajectoryCase[] = [
  {
    id: "wt-create-query-rename",
    title: "create a worktree then query/rename its unique symbol",
    kind: "create-query-rename",
    prompt:
      "Use the create-worktree tool to create this conversation's isolated task worktree. " +
      "Then, inside that worktree, use the rename_symbol tool with the RELATIVE file path " +
      "`src/unique.ts`, symbol_path `worktreeTrajectoryUnique`, and new_name " +
      "`worktreeTrajectoryRenamed` to rename the function. Report the tool results. " +
      "Do not run bash or use any tool other than create-worktree and rename_symbol.",
  },
  {
    id: "wt-enter-query",
    title: "enter an existing worktree and query its unique symbol",
    kind: "enter-query",
    prompt:
      "Use the enter-worktree tool with conversationId `<OWNER_ID>` to enter that existing task " +
      "worktree. Then use find_declaration with file `src/owner_unique.ts` and symbol_path " +
      "`worktreeTrajectoryOwnerSymbol`, and report the result. Do not run bash.",
  },
  {
    id: "wt-workspace-query-file-omitted",
    title: "a file-omitted workspace query returns a worktree symbol",
    kind: "workspace-query-file-omitted",
    prompt:
      "Use the create-worktree tool to create this conversation's isolated task worktree. " +
      "Then call find_symbol with query `worktreeTrajectoryTopLevel` and NO `file` argument " +
      "(a pure workspace-level query), and report the result. Do not run bash.",
  },
  {
    id: "wt-exit-confirm-original",
    title: "exit and confirm the original tree's symbol and bytes",
    kind: "exit-confirm-original",
    prompt:
      "Use the create-worktree tool to create this conversation's isolated task worktree. " +
      "Then rename the function `worktreeTrajectoryUnique` in `src/unique.ts` (symbol_path " +
      "`worktreeTrajectoryUnique`) to `worktreeTrajectoryRenamed`. Then use exit-worktree to " +
      "return to the main repository checkout, and use find_declaration with file `src/unique.ts` " +
      "and symbol_path `worktreeTrajectoryUnique` to confirm the original declaration is back in " +
      "the main checkout. Report the tool results. Do not run bash.",
  },
  {
    id: "wt-unsafe-refusal",
    title: "refuse an unsafe path with no side effects",
    kind: "unsafe-refusal",
    prompt:
      "Use get_symbols_overview with the RELATIVE file path `../../../outside-project.ts` and " +
      "report the tool's answer verbatim. Do not run bash and do not create or modify any file.",
  },
  {
    id: "wt-hover-known-symbol",
    title: "hover a known symbol in the active worktree",
    kind: "hover-known-symbol",
    prompt:
      "Use the create-worktree tool to create this conversation's isolated task worktree. " +
      "Then use get_hover with file `src/unique.ts` and symbol_path `worktreeTrajectoryUnique`, " +
      "and report the type signature. Do not run bash.",
  },
  {
    id: "wt-hover-top-level-symbol",
    title: "hover a top-level symbol in the active worktree",
    kind: "hover-top-level-symbol",
    prompt:
      "Use the create-worktree tool to create this conversation's isolated task worktree. " +
      "Then use get_hover with file `src/unique.ts` and symbol_path " +
      "`worktreeTrajectoryTopLevel`, and report the type signature. Do not run bash.",
  },
  {
    id: "wt-hover-nested-method",
    title: "hover a nested Class/method in the active worktree",
    kind: "hover-nested-method",
    prompt:
      "Use the create-worktree tool to create this conversation's isolated task worktree. " +
      "Then use get_hover with file `src/unique.ts` and symbol_path " +
      "`WorktreeTrajectoryWidget/worktreeTrajectoryUnique`, and report the type signature. " +
      "Do not run bash.",
  },
  {
    id: "wt-call-hierarchy-known-symbol",
    title: "call-hierarchy a known symbol in the active worktree",
    kind: "call-hierarchy-known-symbol",
    prompt:
      "Use the create-worktree tool to create this conversation's isolated task worktree. " +
      "Then use list_incoming_calls with file `src/unique.ts` and symbol_path " +
      "`worktreeTrajectoryUnique`, and report which functions call it. Do not run bash.",
  },
];
