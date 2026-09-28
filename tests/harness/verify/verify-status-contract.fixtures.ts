// Golden-set fixtures for the verify three-value outcome (spec
// verify-status-contract SC12): passed / not_run(insufficient) /
// not_run(contradicted) / the failed family unchanged. Placement follows the
// roster rule — the set lives with the behavior it locks, under
// tests/harness/verify/, mirroring tests/harness/identity/
// soul-usage-symbol-first.fixtures.ts.
//
// This file is the independent contract witness: every human-visible string
// and every wire shape below is an INDEPENDENT literal taken from the spec's
// locked copy, never imported from src (a src edit that drifts the copy must
// fail here, not follow along). Only message/record *shapes* borrow src types
// as type-only imports — types are erased at runtime, so no witness coupling.
//
// Halves (both required for a set green; offline alone is never a green):
//   offline half    = tests/harness/verify/verify-status-contract.test.ts
//   real-model half = real-llm/verify-status-contract.test.ts
//     (registered in TRACKED_INCLUDE of vitest.real-llm.config.ts)

import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../../src/harness/model-adapter/types.js";

/* ------------------------------ locked wire vocabulary ------------------------------ */

/** The five projectable outcomes — the union surface this set locks.
 *  aborted / disabled are the NON-projectable states (case 7 below). */
export type LockedOutcome =
  "passed" | "failed" | "unstable" | "escalated" | "not_run";

export type LockedNotRunReason = "insufficient" | "contradicted";

/** One wire-expectation record: the projected VerifyAnswerView fields plus
 *  the two human renderings (TUI banner label, CLI report label) locked as
 *  independent literals. */
export type LockedPresentation = {
  readonly outcome: LockedOutcome;
  /** Present iff outcome === "not_run" (wire coupling, spec Q-A). */
  readonly notRunReason?: LockedNotRunReason;
  /** Banner glyph pinned by the spec (⚠ shared with unstable for not_run). */
  readonly bannerGlyph: string;
  /** Banner label text (TUI), locked copy. */
  readonly bannerLabel: string;
  /** CLI report label, locked copy. */
  readonly cliLabel: string;
  /** Whether the CLI line carries the "not judged complete" suffix. */
  readonly cliNotJudgedSuffix: boolean;
  /** Color-role lock: which palette relationship the line must satisfy.
   *  "amber"  = same fg as unstable, NOT passed-green, NOT failed-red
   *  "green"  = passed fg
   *  "red"    = failed / escalated fg
   *  "amber-unstable" = the unstable row itself (anchor for the not_run check) */
  readonly colorRole: "green" | "red" | "amber" | "amber-unstable";
};

/** Locked CLI suffix for the failed family (spec keeps it unchanged). */
export const CLI_NOT_JUDGED_SUFFIX = "—— 未判完成，结果以验证为准。";

/* ------------------------------ presentation locks, one per surface point ------------------------------ */

export const PASSED_PRESENTATION: LockedPresentation = {
  outcome: "passed",
  bannerGlyph: "✓",
  bannerLabel: "验证通过",
  cliLabel: "验证通过",
  cliNotJudgedSuffix: false,
  colorRole: "green",
};

export const NOT_RUN_INSUFFICIENT_PRESENTATION: LockedPresentation = {
  outcome: "not_run",
  notRunReason: "insufficient",
  bannerGlyph: "⚠",
  bannerLabel: "未验证（证据不足）",
  cliLabel: "未验证（证据不足）",
  cliNotJudgedSuffix: false,
  colorRole: "amber",
};

export const NOT_RUN_CONTRADICTED_PRESENTATION: LockedPresentation = {
  outcome: "not_run",
  notRunReason: "contradicted",
  bannerGlyph: "⚠",
  bannerLabel: "未验证（证据冲突）",
  cliLabel: "未验证（证据冲突）",
  cliNotJudgedSuffix: false,
  colorRole: "amber",
};

export const FAILED_PRESENTATION: LockedPresentation = {
  outcome: "failed",
  bannerGlyph: "✗",
  bannerLabel: "验证未通过",
  cliLabel: "验证未通过",
  cliNotJudgedSuffix: true,
  colorRole: "red",
};

export const UNSTABLE_PRESENTATION: LockedPresentation = {
  outcome: "unstable",
  bannerGlyph: "⚠",
  bannerLabel: "验证不稳定",
  cliLabel: "验证不稳定（套件干扰）",
  cliNotJudgedSuffix: true,
  colorRole: "amber-unstable",
};

export const ESCALATED_PRESENTATION: LockedPresentation = {
  outcome: "escalated",
  bannerGlyph: "⤴",
  bannerLabel: "验证耗尽（升级后仍未通过）",
  cliLabel: "验证耗尽（升级后仍未通过）",
  cliNotJudgedSuffix: true,
  colorRole: "red",
};

/**
 * The two not_run copies must never collapse onto one string (spec Boundaries:
 * 「未验证（证据不足）」 and 「未验证（证据冲突）」 are different facts).
 * Both halves assert this inequality against these literals.
 */
export const NOT_RUN_LABELS_MUST_DIFFER: readonly [string, string] = [
  NOT_RUN_INSUFFICIENT_PRESENTATION.bannerLabel,
  NOT_RUN_CONTRADICTED_PRESENTATION.bannerLabel,
];

/* ------------------------------ terminal-record vocabulary ------------------------------ */

/** Independent literals for the loop-record shape the trajectory rides on
 *  (name-only witness: the offline half additionally imports the constants
 *  from src to bind witness to the real values; drift on the src side then
 *  fails the binding test, not the whole table silently). */
export const LOCKED_HITL_SKIP_REASON = "hitl_skip_completion_judge";
export const LOCKED_INSUFFICIENT_VERDICT = "EVIDENCE_INSUFFICIENT";
export const LOCKED_CONTRADICTED_VERDICT = "EVIDENCE_CONTRADICTED";

/* ------------------------------ trajectory cases (loop-driven) ------------------------------ */

/** Standard vitest green summary line (same shape as the evidence-checker
 *  fixture transcript; written independently here as part of the witness). */
const VITEST_GREEN = " ✓ Tests  3 passed (3)\n";
const GREEN_TEST_COMMAND = "npx vitest run";

function greenRunBlocks(id: string): AnthropicContentBlock[] {
  return [
    {
      type: "tool_use",
      id,
      name: "bash",
      input: { command: GREEN_TEST_COMMAND },
    },
    {
      type: "tool_result",
      tool_use_id: id,
      content: JSON.stringify({ code: 0, stdout: VITEST_GREEN, stderr: "" }),
    },
  ];
}

function textBlock(text: string): AnthropicContentBlock {
  return { type: "text", text };
}

/**
 * write_file tool_use block. The target-path key is parameterized: the
 * production ACI schema key is `path` (write-file.ts ALLOWED_KEYS), `filePath`
 * is the legacy fixture spelling. Default keeps the legacy key so existing
 * cases stay byte-identical; the {path} variant certifies the real tool-call
 * form.
 */
function writeBlock(
  id: string,
  filePath: string,
  content: unknown,
  pathKey: "path" | "filePath" = "filePath"
): AnthropicContentBlock {
  return {
    type: "tool_use",
    id,
    name: "write_file",
    input: { [pathKey]: filePath, content },
  };
}

function toolUseBlock(id: string, command: string): AnthropicContentBlock {
  return { type: "tool_use", id, name: "bash", input: { command } };
}

function doneTurn(): AnthropicNativeMessage {
  return { role: "assistant", content: [textBlock("implemented")] };
}

/**
 * What the offline half asserts against the loop for a trajectory case.
 * `allowedLoopOutcomes` is a SET, not one value: the vocabulary step ends the
 * HITL skip as passed + named skip record (locked live by the hitl suite),
 * while the gate step (spec SC9) may end the same turn directly as not_run.
 * Both are honest — what this set locks is that the loop never leaves the
 * allowed set (never failed/unstable on these shapes) and that the WIRE is
 * exactly the locked presentation either way.
 * `evidenceVerdict: null` = key must be ABSENT on the terminal record
 * (SUFFICIENT / pass short-circuit persists nothing).
 */
export type LockedTerminalRecord = {
  readonly allowedLoopOutcomes: readonly LockedOutcome[];
  /** Terminal record's `reason` (null = absent/undefined). */
  readonly reason: string | null;
  /** Terminal record's `evidenceVerdict` (null = key absent). */
  readonly evidenceVerdict: string | null;
};

export type TrajectoryCase = {
  readonly id: string;
  readonly title: string;
  readonly spec: string;
  /** Full turn message array the stub runFn returns (post-run shape). */
  readonly messages: readonly AnthropicNativeMessage[];
  readonly terminal: LockedTerminalRecord;
  readonly wire: LockedPresentation;
};

export const TRAJECTORY_CASES: readonly TrajectoryCase[] = [
  {
    id: "vsc-pass-01",
    title: "green vitest run, no later edits → passed short-circuit",
    spec:
      "A completed turn whose only test run exited 0 with a vitest green " +
      "summary line. All five evidence conditions hold → SUFFICIENT → pass. " +
      "The wire shows passed with no notRunReason key (byte-invisible).",
    messages: [
      { role: "user", content: [textBlock("fix the parser")] },
      { role: "assistant", content: greenRunBlocks("p01-t") },
      doneTurn(),
    ],
    terminal: {
      allowedLoopOutcomes: ["passed"],
      reason: null,
      evidenceVerdict: null,
    },
    wire: PASSED_PRESENTATION,
  },
  {
    id: "vsc-notrun-insufficient-01",
    title: "code edit, zero test runs → not_run(insufficient)",
    spec:
      "A completed turn that edited a non-doc source file and never ran a " +
      "test command. The checker has no test evidence → INSUFFICIENT; HITL " +
      "skips the completion judge. The projection must show not_run with " +
      "reason insufficient — never 验证通过, never an absent field.",
    messages: [
      { role: "user", content: [textBlock("refactor src/foo.ts")] },
      {
        role: "assistant",
        content: [writeBlock("i01-w", "src/foo.ts", "// refactored\n")],
      },
      doneTurn(),
    ],
    terminal: {
      // The HITL skip exit ends the classifier loop with the honest not_run
      // terminal plus the named skip record; the set still admits the
      // earlier passed+skip spelling because the wire lock — not the
      // internal terminal spelling — is the contract (the projection maps
      // both).
      allowedLoopOutcomes: ["passed", "not_run"],
      reason: LOCKED_HITL_SKIP_REASON,
      evidenceVerdict: LOCKED_INSUFFICIENT_VERDICT,
    },
    wire: NOT_RUN_INSUFFICIENT_PRESENTATION,
  },
  {
    id: "vsc-notrun-contradicted-01",
    title: "green run then emptied the test file → not_run(contradicted)",
    spec:
      "A completed turn that shows a green run and then writes the test file " +
      "EMPTY — the classic delete-tests-to-fake-green shape. Checker → " +
      "CONTRADICTED; HITL skips the judge (no rebuke round, ADR-0073 rule " +
      "3). The projection must show not_run with reason contradicted.",
    messages: [
      { role: "user", content: [textBlock("make the suite green")] },
      { role: "assistant", content: greenRunBlocks("c01-t") },
      {
        role: "assistant",
        content: [writeBlock("c01-w", "src/foo.test.ts", "")],
      },
      doneTurn(),
    ],
    terminal: {
      allowedLoopOutcomes: ["passed", "not_run"],
      reason: LOCKED_HITL_SKIP_REASON,
      evidenceVerdict: LOCKED_CONTRADICTED_VERDICT,
    },
    wire: NOT_RUN_CONTRADICTED_PRESENTATION,
  },
  {
    id: "vsc-notrun-contradicted-02",
    title: "green run then rm -f of the test file → not_run(contradicted)",
    spec:
      "The rm-variant of the contradicted shape (test deleted via a bash " +
      "rm instead of an empty write). Same HITL skip EXIT, same honest " +
      "not_run(contradicted) wire.",
    messages: [
      { role: "user", content: [textBlock("make the suite green")] },
      { role: "assistant", content: greenRunBlocks("c02-t") },
      {
        role: "assistant",
        content: [toolUseBlock("c02-r", "rm -f src/foo.test.ts")],
      },
      doneTurn(),
    ],
    terminal: {
      allowedLoopOutcomes: ["passed", "not_run"],
      reason: LOCKED_HITL_SKIP_REASON,
      evidenceVerdict: LOCKED_CONTRADICTED_VERDICT,
    },
    wire: NOT_RUN_CONTRADICTED_PRESENTATION,
  },
  {
    id: "vsc-notrun-contradicted-03",
    title:
      "green run then emptied the test file with the production {path} key → not_run(contradicted)",
    spec:
      "The emptied-test-file shape arrives with the production ACI input key " +
      "`path` (write-file.ts ALLOWED_KEYS), not the legacy filePath fixture " +
      "spelling. The checker must see the same binary contradiction — the " +
      "hard veto is keyed on the tool-call form the model really emits. " +
      "Offline-only case: the locked wire presentation is unchanged, so the " +
      "real-model half needs no new prompt.",
    messages: [
      { role: "user", content: [textBlock("make the suite green")] },
      { role: "assistant", content: greenRunBlocks("c03-t") },
      {
        role: "assistant",
        content: [writeBlock("c03-w", "src/foo.test.ts", "", "path")],
      },
      doneTurn(),
    ],
    terminal: {
      allowedLoopOutcomes: ["passed", "not_run"],
      reason: LOCKED_HITL_SKIP_REASON,
      evidenceVerdict: LOCKED_CONTRADICTED_VERDICT,
    },
    wire: NOT_RUN_CONTRADICTED_PRESENTATION,
  },
];

/* ------------------------------ projection-table cases (direct shapes) ------------------------------ */

/** Minimal record shape projectVerifyHumanView consumes. */
export type DirectProjectionCase = {
  readonly id: string;
  readonly title: string;
  readonly input: {
    readonly outcome: string;
    readonly rounds: number;
    readonly records: ReadonlyArray<{
      readonly reason?: string;
      readonly evidenceVerdict?: string;
    }>;
  };
  /** Expected wire presentation, or null when the shape must NOT project. */
  readonly wire: LockedPresentation | null;
  /** When true the wire must be exactly {outcome, rounds} — no
   *  notRunReason key present. */
  readonly wireWithoutReason: boolean;
};

export const DIRECT_PROJECTION_CASES: readonly DirectProjectionCase[] = [
  {
    id: "vsc-direct-legacy-passed-skip",
    title:
      "legacy passed + hitl-skip + INSUFFICIENT projects not_run(insufficient)",
    // The exact shape in historic conversation aa6c2a69… (final_outcome=
    // passed persisted next to the skip record): mapped at read time, no
    // data migration.
    input: {
      outcome: "passed",
      rounds: 1,
      records: [
        {
          reason: LOCKED_HITL_SKIP_REASON,
          evidenceVerdict: LOCKED_INSUFFICIENT_VERDICT,
        },
      ],
    },
    wire: NOT_RUN_INSUFFICIENT_PRESENTATION,
    wireWithoutReason: false,
  },
  {
    id: "vsc-direct-terminal-not-run",
    title: "terminal not_run (loop vocabulary) projects not_run",
    // Forward lock for the gate step: once the loop itself ends not_run, the
    // projection keeps it not_run; with no skip record the reason defaults
    // to insufficient (nothing was verified — the conservative kind).
    input: {
      outcome: "not_run",
      rounds: 1,
      records: [
        {
          reason: LOCKED_HITL_SKIP_REASON,
          evidenceVerdict: LOCKED_CONTRADICTED_VERDICT,
        },
      ],
    },
    wire: NOT_RUN_CONTRADICTED_PRESENTATION,
    wireWithoutReason: false,
  },
  {
    id: "vsc-direct-terminal-not-run-no-record",
    title:
      "terminal not_run with no skip record defaults the reason to insufficient",
    input: { outcome: "not_run", rounds: 0, records: [] },
    wire: NOT_RUN_INSUFFICIENT_PRESENTATION,
    wireWithoutReason: false,
  },
  {
    id: "vsc-direct-failed",
    title: "failed passes through unchanged",
    input: { outcome: "failed", rounds: 3, records: [] },
    wire: FAILED_PRESENTATION,
    wireWithoutReason: true,
  },
  {
    id: "vsc-direct-unstable",
    title: "unstable passes through unchanged",
    input: { outcome: "unstable", rounds: 2, records: [] },
    wire: UNSTABLE_PRESENTATION,
    wireWithoutReason: true,
  },
  {
    id: "vsc-direct-escalated",
    title: "escalated passes through unchanged",
    input: { outcome: "escalated", rounds: 5, records: [] },
    wire: ESCALATED_PRESENTATION,
    wireWithoutReason: true,
  },
  {
    id: "vsc-direct-passed-clean",
    title: "passed with no skip record stays passed (SUFFICIENT short-circuit)",
    input: { outcome: "passed", rounds: 1, records: [] },
    wire: PASSED_PRESENTATION,
    wireWithoutReason: true,
  },
  {
    id: "vsc-direct-aborted",
    title: "aborted never enters the wire",
    input: { outcome: "aborted", rounds: 0, records: [] },
    wire: null,
    wireWithoutReason: false,
  },
  {
    id: "vsc-direct-disabled",
    title: "disabled (bare / gate no-op run) never enters the wire",
    input: { outcome: "disabled", rounds: 0, records: [] },
    wire: null,
    wireWithoutReason: false,
  },
];

/* ------------------------------ malformed-wire table ------------------------------ */

/**
 * verifyFromWire runtime-boundary cases. The discriminator and the outcome
 * are COUPLED on the wire — both violation directions must degrade to
 * unavailable/malformed_view, never to a rendered lie.
 */
export type MalformedWireCase = {
  readonly id: string;
  readonly title: string;
  readonly raw: unknown;
};

export const MALFORMED_WIRE_CASES: readonly MalformedWireCase[] = [
  {
    id: "vsc-malformed-not-run-no-reason",
    title: "not_run without notRunReason is malformed",
    raw: { outcome: "not_run", rounds: 1 },
  },
  {
    id: "vsc-malformed-not-run-garbage-reason",
    title: "not_run with an unknown notRunReason is malformed",
    raw: { outcome: "not_run", rounds: 1, notRunReason: "garbage" },
  },
  {
    id: "vsc-malformed-passed-with-reason",
    title: "a present notRunReason on passed is malformed",
    raw: { outcome: "passed", rounds: 1, notRunReason: "insufficient" },
  },
  {
    id: "vsc-malformed-unknown-outcome",
    title: "an outcome outside the five is malformed",
    raw: { outcome: "maybe", rounds: 1 },
  },
];

/* ------------------------------ render helpers (shared by both halves) ------------------------------ */

/** Expected TUI banner line text for a locked presentation (hitl mode;
 *  auto mode prefixes `[auto] ` — same shape both halves check). */
export function expectedBannerText(
  p: LockedPresentation,
  rounds: number
): string {
  return `${p.bannerGlyph} ${p.bannerLabel}（${rounds} 轮）`;
}

/** Expected CLI report line for a locked presentation. */
export function expectedCliLine(p: LockedPresentation, rounds: number): string {
  const base = `[验证] ${p.cliLabel}（${rounds} 轮）`;
  // Locked copy attaches directly after the 「N 轮）」 bracket (no join space).
  return p.cliNotJudgedSuffix ? `${base}${CLI_NOT_JUDGED_SUFFIX}` : base;
}

/* ------------------------------ model-facing injection locks ------------------------------ */

/**
 * The model-facing not-verified envelope (spec: the not-run case IS returned to
 * the model; the success case is NOT). Independent literals, same witness
 * discipline as the presentation tables above — a src rewrite of the copy must
 * fail here rather than follow along.
 *
 * `NOT_RUN_ENVELOPE_PREFIX` is the third host-injected verify prefix (alongside
 * [VALIDATION FAILED] and [VERIFY: rerun needed]); it is deliberately NOT one of
 * those two, because it carries a different obligation: nothing failed, and
 * there is no concrete command to re-run.
 */
export const NOT_RUN_ENVELOPE_PREFIX = "[VERIFY: not verified]";

/** The honest meaning the envelope must state: not verified, not a pass, not a failure. */
export const NOT_RUN_ENVELOPE_MEANING = [
  "You reported the task as complete, but this turn produced no verifiable",
  "test evidence, so the result is not verified — not passed and not failed.",
] as const;

/** The obligation: produce test evidence before claiming completion again. */
export const NOT_RUN_ENVELOPE_OBLIGATION = "run the project's tests"; // case-insensitive match in the halves

/** Copy for the no-command shape (classifier branch): says so, invents nothing. */
export const NOT_RUN_ENVELOPE_NO_COMMAND =
  "No verify command is configured for this project";

/** Copy for the configured-command shape: names the command verbatim. */
export function expectedNotRunEnvelope(opts: {
  readonly round: number;
  readonly maxRounds: number;
  readonly command?: string;
}): string {
  const command = (opts.command ?? "").trim();
  const head = [
    `${NOT_RUN_ENVELOPE_PREFIX} attempt=${opts.round}/${opts.maxRounds}`,
    ...NOT_RUN_ENVELOPE_MEANING,
  ].join("\n");
  return command.length > 0 ? `${head}\n  ${command}` : head;
}
