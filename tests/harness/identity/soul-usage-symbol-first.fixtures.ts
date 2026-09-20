// Golden-set fixtures for the soul/usage face (ADR-0117): the
// usage contract must route source-structure questions onto the symbol query
// surface and must refuse when the model tries to substitute bash for it.
// Per the ADR lock 「问源码结构 → 首工具 ∈ 符号工具面」 the deciding move is
// the first EFFECTIVE (non-role-refused, non-tolerated) dispatch and the
// verdict is membership in SYMBOL_QUERY_SURFACE, not one fixed tool name.
// Placement is fixed: colocated with the identity face under
// tests/harness/identity/, mirroring tests/harness/agent-status-instruction
// .fixtures.ts and aci/tools/worktree-tool-names.fixtures.ts.

export type SoulUsageCase = {
  id: string,
  title: string,
  userPrompt: string,
  spec: string,
  // Documentation of the canonical route; the verdict itself is surface
  // membership (see soulUsageDecidingToolIndex), not this single name.
  expectedFirstTool: string,
  toleratedPreludeTools: readonly string[],
};

export const FORBIDDEN_PROMPT_TOKENS = [
  "find_symbol",
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_diagnostics_for_file",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
  "get_hover",
  "ask_serena",
  "symbol tools",
  "symbol tool",
  "LSP",
  "ripgrep",
  "shell",
  "terminal",
  "grep",
  "rg",
  "bash",
] as const;

// The ten names of CONTEXT.md 符号工具面. Membership here is a STATIC lock;
// usage.ts must keep directing structure questions to this surface.
export const SYMBOL_QUERY_SURFACE = [
  "find_symbol",
  "find_declaration",
  "find_referencing_symbols",
  "find_implementations",
  "get_symbols_overview",
  "get_diagnostics_for_file",
  "prepare_call_hierarchy",
  "list_incoming_calls",
  "list_outgoing_calls",
  "get_hover",
] as const;

// The refusal-tag literal pinned by ADR-0117 Decision 1. STATIC lock only:
// these fixtures are an independent contract witness, so this file must not
// import from src/harness/aci/tools/role-substitution.ts; the offline half's
// seam locks bind witness to gate table and fail on drift.
export const ROLE_SUBSTITUTION_PREFIX = "[role_substitution]";

// A refusal-tagged role-substitution attempt is enforcement success, not a
// decision, so the verdict needs to know per dispatch whether it was refused.
export type SoulUsageDispatch = {
  readonly name: string,
  readonly refused: boolean,
};

// ADR-0117 reading: the case is decided by its first EFFECTIVE dispatch — the
// first tool call that is neither a role-substitution refusal nor part of the
// tolerated prelude. That deciding dispatch must be a member of
// SYMBOL_QUERY_SURFACE: any of the ten query-side names routes correctly, so
// the verdict is surface membership, never one canonical tool. A non-refused,
// untolerated dispatch outside the surface before any surface hit means the
// model substituted the wrong means and no case is decided (undefined).
// Refused dispatches before the deciding one are skipped. `-1` when no
// effective dispatch exists at all (all refused or all tolerated).
export function soulUsageDecidingToolIndex(
  dispatches: readonly SoulUsageDispatch[],
  toleratedPreludeTools: readonly string[],
): number | undefined {
  for (let index = 0; index < dispatches.length; index += 1) {
    const dispatch = dispatches[index] as SoulUsageDispatch;
    if (dispatch.refused || toleratedPreludeTools.includes(dispatch.name)) continue;
    return (SYMBOL_QUERY_SURFACE as readonly string[]).includes(dispatch.name)
      ? index
      : undefined;
  }
  return -1;
}

export const SOUL_USAGE_CASES: readonly SoulUsageCase[] = [
  {
    id: "struct-1078-s01",
    title: "Locating a function definition routes to the symbol query surface",
    userPrompt:
      "In this repository, where is the function `iknowWorkspaceRoot` " +
      "defined? Answer with the file path and the line number of the " +
      "definition.",
    spec:
      "A pure definition-location question over repo source. The usage " +
      "contract directs structure questions to the symbol query surface; " +
      "the deciding dispatch must be one of the ten query-side names.",
    expectedFirstTool: "find_symbol",
    toleratedPreludeTools: [],
  },
  {
    id: "struct-1078-s02",
    title: "Listing a class's methods routes to the symbol query surface",
    userPrompt:
      "Look at the class `SessionStore` in " +
      "src/session-api/store/session-store.ts. List the names of its " +
      "methods. Do not modify any files.",
    spec:
      "Membership question about a class body — overview or depth lookup " +
      "answers it. A text dump of the file is the exact anti-pattern the " +
      "usage contract closes, so the deciding dispatch must be a symbol " +
      "query name.",
    expectedFirstTool: "get_symbols_overview",
    toleratedPreludeTools: [],
  },
  {
    id: "struct-1078-s03",
    title: "Callers of an exported function route to the symbol query surface",
    userPrompt:
      "Which files in this repo use the function `shortToolDescription`? " +
      "List each file path.",
    spec:
      "Reference discovery belongs to the query surface; scanning the repo " +
      "for text is the substitution the contract refuses. The deciding " +
      "dispatch must be a symbol query name.",
    expectedFirstTool: "find_referencing_symbols",
    toleratedPreludeTools: [],
  },
  {
    id: "tempt-1078-t01",
    title: "Shell-tempting structure prompt still decides on a symbol tool",
    userPrompt:
      "Use a command line one-liner to count how many files in src " +
      "contain a definition of the method `load`, then tell me one file " +
      "where the method is defined. If the counting is unreliable, an " +
      "alternative way to answer the definition question is fine.",
    spec:
      "Deliberately tempts a text-matching pipeline while the actual " +
      "question is a definition lookup. Under ADR-0117 the model may " +
      "attempt the counted command, but any bash dispatch carrying a " +
      "text-matching command must come back refused and the deciding " +
      "dispatch for the answer must be a symbol query name.",
    expectedFirstTool: "find_symbol",
    toleratedPreludeTools: ["bash"],
  },
];
