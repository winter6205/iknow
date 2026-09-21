/**
 * D9 description audit — regression guard.
 *
 * Spec: docs/handoff/2026-08-17-wayfinder-440-decisions.md D6/D9 paradigm:
 * tool descriptions must use positive-trigger phrasing (when to use, what
 * to pair it with) plus inline governance constraints (limits / side
 * effects / boundaries), and must NOT contain any NEGATIVE_PHRASES.
 *
 * Scope:
 *   - Assemble createDefaultAciRegistry with ALL conditional deps present
 *     so every tool (including the 5 already-D9-compliant ones: todo_write,
 *     list_mcp_resources, read_mcp_resource, bash_output, bash_stop) is
 *     exercised.
 *   - Iterate every tool from the registry catalog and assert:
 *       1. description length > 0 (sanity)
 *       2. no NEGATIVE_PHRASE appears in any description
 *
 * The guard fails fast if any future description edit accidentally
 * re-introduces an imperative ("do not", "never", …) or a CJK blocklist
 * word ("不要", "禁止", … = negative imperatives). Mirrors the style block already pinned in
 * tests/harness/aci/tools/todo-write.test.ts.
 *
 * Isolation: pure in-memory fixture (no real fs mutations); mkdtemp dirs
 * are scratch anchors only (the tools themselves are not invoked).
 *
 * CI portability: createBashTool calls requireBwrap() at assembly time
 * (bash.ts) and the CI runner has no bubblewrap. Mock requireBwrap to
 * a no-op instead of stubbing createBashTool (the registry-workspace-root
 * pattern): the guard must audit the REAL bash description, so the factory
 * stays real and only the host-capability probe is replaced. requireBwrap
 * is assembly-time only — the bash handler never invokes it — and the
 * runner.js mock covers the index.js re-export binding bash.ts consumes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/harness/sandbox/runner.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../../src/harness/sandbox/runner.js")
    >();
  return { ...actual, requireBwrap: () => {} };
});

import {
  createDefaultAciRegistry,
  ACI_TOOLSET_NAMES,
} from "../../../../src/harness/aci/tools/registry.js";
import { createSkillCatalog } from "../../../../src/harness/skill/catalog.js";
import {
  getAgentEntry,
  resolveAgentCatalog,
} from "../../../../src/harness/subagent/catalog.js";
import {
  SPAWN_DISPATCH_LESSON,
  SPAWN_DISPATCH_LESSON_CONCURRENCY_PATTERN,
} from "../../../../src/harness/subagent/spawn-subagent-tool.js";
import type { IknowEnv } from "../../../../src/config/env.js";
import type { SubAgentManager } from "../../../../src/harness/subagent/manager.js";
import type { McpManager } from "../../../../src/harness/mcp/manager.js";
import type { BackgroundTaskManager } from "../../../../src/harness/background/manager.js";
import type { CreateWorktreeProvisionFn } from "../../../../src/harness/aci/tools/create-worktree.js";
import type { WorktreeEnterToolDeps } from "../../../../src/harness/aci/tools/enter-worktree.js";
import type { WorktreeExitToolDeps } from "../../../../src/harness/aci/tools/exit-worktree.js";
import type { ListWorktreesToolDeps } from "../../../../src/harness/aci/tools/list-worktrees.js";
import type { RemoveWorktreeToolDeps } from "../../../../src/harness/aci/tools/remove-worktree.js";

/** 12-word blocklist — mirrors the list in tests/harness/aci/tools/todo-write.test.ts.
 *
 * Discipline verdict: this table bans only model-facing negative imperatives
 * ("do not" / "never" / "不要"…). Risk/refusal description words (reject / out of
 * scope / guard…) are objective statements of tool behavior (web_fetch's SSRF
 * guard rejects, edit_file's lint rejects, memory_save's negative-form reject)
 * — they issue no prohibition to the model, and the guard paradigm allows
 * "inline governance constraints" wording. Adding such words would force
 * out-of-scope rewrites of four existing descriptions, so the blocklist stays closed. */
const NEGATIVE_PHRASES: ReadonlyArray<string> = [
  "do not",
  "don't",
  "avoid",
  "should not",
  "shouldn't",
  "never",
  "simple task",
  "trivial",
  "不要",
  "避免",
  "禁止",
  "切勿",
];

/** Positive-guidance construct (trigger verb) whitelist. A description must
 *  match at least one — pinning the writing form to "when to use / what to
 *  pair with" instead of negative imperatives. Same idea as the positive-keys
 *  in todo-write.test.ts, but lifted to toolset level.
 *  Word-choice principle: cover the verb spectrum of the existing ACI tools
 *  (use / pair / read / run / fetch / search / discover / load / list / poll /
 *  maintain / capture / delegate / resolve / apply / create / terminate /
 *  return) — any description matching one passes; all current wording matches
 *  (hand-checked, with vitest as the backstop). */
const POSITIVE_TRIGGER_PATTERN =
  /\b(use|pair|read|run|fetch|search|discover|load|list|poll|maintain|capture|delegate|resolve|apply|create|terminate|return)\b/i;

/** Minimal env (only web fields are consumed by the registry factory). */
function makeWebEnv(): Pick<IknowEnv, "web"> {
  return { web: { searchUrl: undefined, proxy: undefined } };
}

/** Fake SubAgentManager — sufficient for assembly. Mirrors registry.test.ts:51-57. */
const fakeSubagentManager = {
  spawn: () => ({ taskId: "fake-id" }),
  queryBuffer: () => ({ status: "not_found" as const }),
  waitFor: () => Promise.reject(new Error("not used")),
  shutdown: () => Promise.resolve(),
  drainCompleted: () => [],
  listActive: () => [],
  abortTask: () => false,
  // The interface gained read-only enumeration methods — the fake completes them to stay structurally compatible.
  getCapacity: () => 15,
  listSubagents: () => [],
  // SubAgentManager interface extension: subscribe (mailbox contract)
  subscribe: () => () => {},
} as unknown as SubAgentManager;

/** Fake McpManager — sufficient for assembly. Mirrors registry.test.ts:63-70. */
const fakeMcpManager: McpManager = {
  start: () => Promise.resolve(),
  reload: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
  status: () => [],
  listResources: () => Promise.reject(new Error("fake: list not stubbed")),
  readResource: () => Promise.reject(new Error("fake: read not stubbed")),
} as unknown as McpManager;

/** Fake backgroundManager — sufficient for assembly (the handler is never reached). */
const fakeBackgroundManager: BackgroundTaskManager = {
  spawn: () => Promise.reject(new Error("fake: spawn not stubbed")),
  status: () => Promise.reject(new Error("fake: status not stubbed")),
  output: () => Promise.reject(new Error("fake: output not stubbed")),
  stop: () => Promise.reject(new Error("fake: stop not stubbed")),
  shutdown: () => Promise.resolve(),
  registerConversationDeletedListener: () => undefined,
  onConversationDeleted: () => undefined,
} as unknown as BackgroundTaskManager;

/** ADR-0037 worktree isolation host fakes — sufficient for assembly.
 * Handler-path unit tests live in each tool's own directory; this file only audits the description guard. */
const fakeWorktreeProvision: CreateWorktreeProvisionFn = async () =>
  "/tmp/fake-worktree";
const fakeWorktreeEnter: WorktreeEnterToolDeps["worktreeEnter"] = async () => ({
  path: "/tmp/fake-worktree",
  receipt: "entered task worktree: /tmp/fake-worktree",
});
const fakeWorktreeExit: WorktreeExitToolDeps["worktreeExit"] = async () =>
  "/tmp/fake-main";
const fakeWorktreeList: ListWorktreesToolDeps["worktreeList"] = async () => [];
const fakeWorktreeRemove: RemoveWorktreeToolDeps["worktreeRemove"] =
  async () => ({
    label: undefined,
    conversationId: "fake-conversation",
    path: "/tmp/fake-worktree",
    branch: "iknow/task-fake-conversation",
    head: "fake-head",
    branchDeleted: false,
  });

describe("#483 D9 — regression guard: every ACI tool description avoids NEGATIVE_PHRASES", () => {
  // Once the default path became ledger-aware, spawn_subagent's description self-resolves
  // from createMergedCatalogResolver() and appends the descriptions of every plugin agent
  // under <home>/.iknow/plugins when building the prose list. This guard tests the tool's
  // OWN fixed wording (negative imperatives like do not / never) and must not be polluted
  // by locally installed plugin agent wording — inject a builtin-only resolver explicitly
  // so the prose list contains only builtins, decoupled from this machine (the
  // `agentCatalog` option at the registry assembly seam).
  const builtinOnlyCatalog = {
    list: () => resolveAgentCatalog(),
    get: (id: string) => getAgentEntry(id),
  };
  // Assemble once for the whole suite. Reusing the same registry across
  // every assertion keeps the test cheap and guarantees a stable tool set.
  const reg = createDefaultAciRegistry({
    env: makeWebEnv(),
    sandboxRoot: "/tmp/root",
    memoryDir: "/tmp/root/memory",
    skillCatalog: createSkillCatalog([]),
    subagentManager: fakeSubagentManager,
    todoDir: "/tmp/root/session-1/todos",
    mcpManager: fakeMcpManager,
    backgroundManager: fakeBackgroundManager,
    // With the graph overlay present → run_graph joins the registry (its description is bound by the same guard).
    graphAssembly: { enabled: () => true },
    // worktree isolation (ADR-0037): conditioned assembly of the 3 tools — they join the registry only when the host seam is present.
    worktreeProvision: fakeWorktreeProvision,
    worktreeEnter: fakeWorktreeEnter,
    worktreeExit: fakeWorktreeExit,
    worktreeList: fakeWorktreeList,
    worktreeRemove: fakeWorktreeRemove,
    agentCatalog: builtinOnlyCatalog,
  });

  // Sanity: the registry assembled with every conditional dep present contains
  // the whole toolset. If this drifts, the gate below would silently cover a
  // smaller set — surface the drift explicitly so the failure mode is
  // unambiguous. (The count itself is pinned by the size test at the end.)
  it("registry contains the full ACI toolset (assembly sanity)", () => {
    const names = reg.catalog.all().map((t) => t.name);
    expect(names).toEqual([...ACI_TOOLSET_NAMES]);
  });

  // One assertion per NEGATIVE_PHRASE keeps the failure message pointed at
  // the offending word. Per-tool coverage lives in the it.each block below.
  it.each(NEGATIVE_PHRASES)(
    `no tool description contains the blocklist phrase "${"%s"}"`,
    (phrase) => {
      const lower = phrase.toLowerCase();
      const offenders = reg.catalog
        .all()
        .filter((t) => t.description.toLowerCase().includes(lower));
      expect(
        offenders,
        `phrase "${phrase}" leaked into: ${offenders
          .map((o) => `${o.name}`)
          .join(", ")}`
      ).toEqual([]);
    }
  );

  // ── STATIC lock for the dispatch lesson ─────────────────────────────────
  // The dispatch lesson inside spawn_subagent's description has exactly one source
  // of truth, the module constant SPAWN_DISPATCH_LESSON: this asserts the
  // description embeds that constant verbatim (a re-typed copy would drift), and
  // pins each of the four disciplines the model-visible face must state clearly —
  // deleting a sentence goes RED, the wording itself stays unconstrained. In the
  // golden-set roster the subagent row only has STATIC/SEAM coverage (see
  // docs/guides/prompt-development.md); this STATIC lock is that row's full coverage.
  it("spawn_subagent description carries the four dispatch disciplines — Layer 1 item 1", () => {
    const spawn = reg.catalog.all().find((t) => t.name === "spawn_subagent");
    expect(spawn).toBeDefined();
    const desc = spawn!.description;
    const lessonStart = desc.indexOf(SPAWN_DISPATCH_LESSON);
    expect(lessonStart).toBeGreaterThan(-1);
    const lesson = desc.slice(lessonStart);

    expect(lesson).toMatch(/explore/i); // explore before writing
    // operator-workflow concurrency discipline: a numeric cap + concurrent/workers semantics, judged by meaning
    expect(lesson).toMatch(SPAWN_DISPATCH_LESSON_CONCURRENCY_PATTERN);
    expect(lesson).toContain("create-worktree"); // isolation builds the tree first
    expect(lesson).toMatch(/skill catalog/i); // consult the skill catalog first
    // The discipline sentence must not degrade into a hard-cap promise: the 15 hard limit stays declared exactly once by the existing paragraph.
    expect(desc.match(/at capacity/gi) ?? []).toHaveLength(1);
  });

  it("every tool has a non-empty description (sanity baseline)", () => {
    const empty = reg.catalog.all().filter((t) => t.description.length === 0);
    expect(
      empty,
      `tools with empty description: ${empty.map((o) => o.name).join(", ")}`
    ).toEqual([]);
  });

  // ── Guard extension (broaden without weakening) ────────────────────────
  // All existing blocklist / conditional-assembly assertions are kept.

  it("every tool description carries positive-guidance substance (> 30 chars) — d9 扩面", () => {
    const tooShort = reg.catalog
      .all()
      .filter((t) => t.description.length <= 30);
    expect(
      tooShort,
      `descriptions too short to carry positive guidance: ${tooShort
        .map((o) => o.name)
        .join(", ")}`
    ).toEqual([]);
  });

  it("every tool description uses a positive trigger construct (use X / pair with Y / returns…) — d9 扩面", () => {
    const missing = reg.catalog
      .all()
      .filter((t) => !POSITIVE_TRIGGER_PATTERN.test(t.description));
    expect(
      missing,
      `descriptions without a positive trigger phrasing: ${missing
        .map((o) => o.name)
        .join(", ")}`
    ).toEqual([]);
  });

  // Core: the bash top-level description must state the positive loop "long-lived
  // server → background:true / bash_output / bash_stop" in the model-visible field (the
  // schema field description is only the second line of defense; the model reads the
  // top-level description at tool-selection time). This assertion locks the trio keywords.
  it('bash description documents the background-loop trio ("background: true" / "bash_output" / "bash_stop") — T7 核心', () => {
    const bash = reg.catalog.all().find((t) => t.name === "bash");
    expect(bash).toBeDefined();
    const desc = bash!.description.toLowerCase();
    expect(desc).toContain("background: true");
    expect(desc).toContain("bash_output");
    expect(desc).toContain("bash_stop");
  });

  // The pre-D9 baseline would have included bash's "Don't have a dedicated
  // tool" and a number of imperative "do not" / "never" fragments. After the
  // audit, what this file pins is that every tool in the assembled catalog is
  // positive-trigger phrased (the it.each blocklist assertions higher up) plus
  // that the assembly sanity check above really covers the whole toolset.
  it("toolset size after audit: 46 (full conditional-deps assembly, incl. task worktree discovery/removal + subagent_stop + subagent_continue + read_image; T5 退役 10 lsp_*; disclosure-index-align T2 退役 skill_search)", () => {
    expect(ACI_TOOLSET_NAMES).toHaveLength(46);
    expect(reg.catalog.all()).toHaveLength(ACI_TOOLSET_NAMES.length);
  });

  // ── ADR-0084 D7: write-gate and read-window documentation duties (STATIC lock while no trajectory set exists) ─
  // read_file / write_file changed description and failure text in this pass; the
  // golden-set roster has no trajectory set for these two (see
  // docs/guides/prompt-development.md and the gap registry in the commit body). Until a
  // trajectory set exists, pin at least the new contracts the model-visible face must
  // state clearly at the STATIC layer: the write gate requires read_file first, and the
  // read window must no longer advertise a default of 200 lines.
  it("write_file description names read_file as the freshness precondition — ADR-0084 D7", () => {
    const writeFile = reg.catalog.all().find((t) => t.name === "write_file");
    expect(writeFile).toBeDefined();
    const desc = writeFile!.description.toLowerCase();
    expect(desc).toContain("read_file");
    expect(desc).toContain("edit_file");
    // The empty-file / brand-new exemption must be on the model-visible face, otherwise the model would do a pointless read before creating.
    expect(desc).toContain("brand-new");
  });

  it("read_file description describes EOF-by-default and the 16000-cp page, not a default line window — ADR-0084 D1c", () => {
    const readFile = reg.catalog.all().find((t) => t.name === "read_file");
    expect(readFile).toBeDefined();
    const desc = readFile!.description.toLowerCase();
    expect(desc).toContain("end of file");
    expect(desc).toContain("16000");
    expect(desc).toContain("offset");
    // The old contract's default of 200 lines must no longer appear on the model-visible face.
    expect(desc).not.toContain("default 200");
    expect(desc).not.toContain("200 lines");
    // Inline truncation of an over-budget line has no offset continuation path — the
    // model-visible face must say so, or the model would loop on the same offset following the continuation hint (ADR-0006 D4, no silent truncation).
    expect(desc).toContain("truncation marker");
    expect(desc).toContain("not reachable via offset paging");
  });

  // ── create-worktree description matches the taskWorktreePath SSOT.
  // A valid kebab-case label IS the leaf; without one the leaf is the
  // conversation id. Identity (gitdir sidecar) is decoupled from the folder
  // name. The description must NOT promise a `<label>--<conversationId>`
  // template, and it must state the actual rule so the model doesn't ask for
  // a free-form path or build expectations off the legacy `--` shape.
  it("create-worktree description matches taskWorktreePath naming SSOT — #1030", () => {
    const createWorktree = reg.catalog
      .all()
      .find((t) => t.name === "create-worktree");
    expect(createWorktree).toBeDefined();
    const desc = createWorktree!.description;
    // negative: the old `<label>--<conversationId>` template is not what the
    // provisioner builds — see `taskWorktreePath` (worktree-gate.ts).
    expect(desc).not.toContain("<label>--<conversationId>");
    // positive: the description states the actual rule the SSOT enforces.
    expect(desc).toContain("leaf name");
    expect(desc).toContain("conversation id");
    expect(desc).toContain("identity");
  });

  // Symbol-query tool descriptions must be written around symbol identity — any
  // "line N / character M" mandatory phrasing regresses to the coordinate path and breaks
  // the spec rule against line/column as the primary input for these tools.
  it("symbol query tool descriptions describe symbol identity, not line/character — T2", () => {
    const symbolTools = [
      "find_symbol",
      "find_declaration",
      "find_referencing_symbols",
      "find_implementations",
      "get_symbols_overview",
      "get_hover",
      "get_diagnostics_for_file",
      "prepare_call_hierarchy",
      "list_incoming_calls",
      "list_outgoing_calls",
    ];
    const offenders = reg.catalog
      .all()
      .filter((t) => symbolTools.includes(t.name))
      .filter((t) =>
        /\bline\b|\bcharacter\b|0-based|1-based/i.test(t.description)
      );
    expect(
      offenders,
      `coordinate phrasing leaked into: ${offenders.map((o) => o.name).join(", ")}`
    ).toEqual([]);
    // Counter-check: every tool description mentions symbol (identity-first phrasing present).
    const withoutIdentity = reg.catalog
      .all()
      .filter((t) => symbolTools.includes(t.name))
      .filter((t) => !/symbol/i.test(t.description));
    expect(withoutIdentity.map((t) => t.name)).toEqual([
      // Diagnostics are asked per file — no symbol identity to speak of (the spec lists it as a file-level tool).
      "get_diagnostics_for_file",
    ]);
  });
});
