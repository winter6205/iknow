// One-way dependency (sandbox base layer ← verify consumer layer):
// truncateByCodePoint is consumed via the sandbox re-export, never pulled from
// the ACI decoration layer — avoids a reverse verify → ACI dependency.
import { truncateByCodePoint } from "../sandbox/index.js";
import type { EvidenceContext } from "./types.js";

export const DEFAULT_MAX_CHARS = 20_000;

export const VALIDATION_FIXED_INSTRUCTION =
  "Fix the failures above. Do not claim completion until validation passes.";

/** Host-injected verify envelopes (fail / evidence rerun / not verified).
 *  Model-facing only. */
export const VALIDATION_FAILED_PREFIX = "[VALIDATION FAILED]";
export const EVIDENCE_RERUN_PREFIX = "[VERIFY: rerun needed]";
export const NOT_RUN_PREFIX = "[VERIFY: not verified]";

/** True when text is a verify-loop envelope, not a user-typed query. */
export function isVerifyInjectedText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith(VALIDATION_FAILED_PREFIX) ||
    t.startsWith(EVIDENCE_RERUN_PREFIX) ||
    t.startsWith(NOT_RUN_PREFIX)
  );
}

export interface BuildValidationEnvelopeArgs {
  readonly round: number;
  readonly maxRounds: number;
  readonly verdict: "true-failure" | "unstable";
  readonly command: string;
  readonly exitCode: number;
  readonly failedCount?: number;
  readonly signature?: string;
  /** Untruncated raw verification output. */
  readonly outputExcerpt: string;
  /** Code-point cap for the embedded output. Defaults to 20_000. */
  readonly maxChars?: number;
}

export function truncateExcerpt(text: string, maxChars: number): string {
  return truncateByCodePoint(text, maxChars);
}

export function buildValidationEnvelope(
  args: BuildValidationEnvelopeArgs
): string {
  const excerpt = truncateExcerpt(
    args.outputExcerpt,
    args.maxChars ?? DEFAULT_MAX_CHARS
  );

  const fields: string[] = [
    `${VALIDATION_FAILED_PREFIX} attempt=${args.round}/${args.maxRounds} verdict=${args.verdict}`,
    `command: ${args.command}`,
    `exit_code: ${args.exitCode}`,
  ];
  if (args.failedCount !== undefined)
    fields.push(`failed_count: ${args.failedCount}`);
  if (args.signature !== undefined) fields.push(`signature: ${args.signature}`);

  // Keep the fixed instruction on its own line even when the raw output has no
  // trailing newline; empty output must not introduce a blank line.
  const separator = excerpt.length > 0 && !excerpt.endsWith("\n") ? "\n" : "";

  return `${fields.join("\n")}\noutput_excerpt:\n${excerpt}${separator}${VALIDATION_FIXED_INSTRUCTION}\n`;
}

/**
 * Envelope builder for classifier-reported failures (distinct from the
 * command-path envelope).
 *
 * Unlike the command envelope it carries no command / exit_code / failed_count /
 * signature (command-path fields the judge does not know); instead: task +
 * reason + missing[].
 *
 * Shape contract:
 *   [VALIDATION FAILED] attempt=N/M verdict=true-failure source=classifier
 *   task: <goal.text>
 *   missing: ["...", "..."]
 *   reason: <judge one-line>
 *   Fix the failures above. Do not claim completion until validation passes.
 *
 * Newlines inside task collapse to a single space — the envelope stays
 * fixed-shape (one line per field; a multi-line task must not break field
 * parsing). The reason value goes through truncateExcerpt at its field
 *
 // (ADR-0006)
 * position (DRY).
 */
export interface BuildClassifierEnvelopeArgs {
  readonly round: number;
  readonly maxRounds: number;
  /** The session.goal.text (or query fallback) — what the judge evaluated. */
  readonly task: string;
  /** Judge-listed missing items (fail variant). Rendered as JSON-ish array. */
  readonly missing: readonly string[];
  /** Judge's one-line rationale. Truncated via truncateExcerpt. */
  readonly reason: string;
  /** Code-point cap for the reason value. Defaults to DEFAULT_MAX_CHARS. */
  readonly maxChars?: number;
  /**
   * Evidence report card. Absent → envelope bytes unchanged (frozen Postel
   * contract, regression anchor). Present → an `evidence_context:` block is
   * inserted after the missing/reason fields and before the fixed instruction
   * (five lines: checker_verdict / reasons / executed_commands /
   * rerun_attempted / evidence_summary, plus the multi-line summary block);
   * evidenceSummary goes through truncateExcerpt(DEFAULT_MAX_CHARS).
   */
  readonly evidenceContext?: EvidenceContext;
}

export function buildClassifierEnvelope(
  args: BuildClassifierEnvelopeArgs
): string {
  const truncatedReason = truncateExcerpt(
    args.reason,
    args.maxChars ?? DEFAULT_MAX_CHARS
  );

  // missing renders as a JSON-ish string array; empty renders as "[]".
  // Upstream order is preserved (tests pin it).
  const missingJson = `[${args.missing.map((m) => JSON.stringify(m)).join(", ")}]`;

  // Collapse task line terminators (CR/LF/U+2028/U+2029) to single spaces:
  // the envelope keeps its fixed shape — a multi-line goal.text must not
  // produce extra field lines.
  const taskLine = args.task.replace(/\r\n|[\r\n\u2028\u2029]/g, " ");

  const fields: string[] = [
    `${VALIDATION_FAILED_PREFIX} attempt=${args.round}/${args.maxRounds} verdict=true-failure source=classifier`,
    `task: ${taskLine}`,
    `missing: ${missingJson}`,
    `reason: ${truncatedReason}`,
  ];

  const head = fields.join("\n");

  // No evidenceContext → envelope bytes identical to the frozen legacy shape.
  if (args.evidenceContext === undefined) {
    return `${head}\n${VALIDATION_FIXED_INSTRUCTION}\n`;
  }

  // evidenceContext present → insert the evidence_context block after
  // missing/reason and before the fixed instruction. evidenceSummary goes
  // through truncateExcerpt(DEFAULT_MAX_CHARS).
  const ctx = args.evidenceContext;
  const summaryCap = args.maxChars ?? DEFAULT_MAX_CHARS;
  const truncatedSummary = truncateExcerpt(ctx.evidenceSummary, summaryCap);
  const reasonsJson = `[${ctx.reasons.map((r) => JSON.stringify(r)).join(", ")}]`;
  const commandsJson = `[${ctx.executedCommands
    .map((c) => JSON.stringify(c))
    .join(", ")}]`;
  const contextBlock = [
    "evidence_context:",
    `checker_verdict: ${ctx.checkerVerdict}`,
    `reasons: ${reasonsJson}`,
    `executed_commands: ${commandsJson}`,
    `rerun_attempted: ${ctx.rerunAttempted}`,
    "evidence_summary:",
    truncatedSummary,
  ].join("\n");

  // evidence_summary is a multi-line block (one line per run); no extra
  // separator when it already ends with \n, otherwise one \n before the fixed
  // instruction.
  const separator = contextBlock.endsWith("\n") ? "" : "\n";
  return `${head}\n${contextBlock}${separator}${VALIDATION_FIXED_INSTRUCTION}\n`;
}

/**
 * Rerun-envelope closing instruction, deliberately different from
 * VALIDATION_FIXED_INSTRUCTION: the rerun envelope says "you claimed
 * completion but real test evidence is missing — run the command and show the
 * framework's green summary", a different kind from the validation-failure
 * (fix-the-failure) envelope.
 */
export const EVIDENCE_RERUN_FIXED_INSTRUCTION =
  "Run the command and show the test framework's green-summary line; do not claim completion until verification passes.";

export interface BuildEvidenceRerunEnvelopeArgs {
  readonly round: number;
  readonly maxRounds: number;
  /** EvidenceReport.reasons (show at most 5; the rest collapses to "…N more" to keep the envelope small). */
  readonly reasons: ReadonlyArray<string>;
  /** Runnable command: config.command ?? probeVerifyCommand(...). */
  readonly command: string;
}

/**
 * Evidence-rerun envelope builder (verbatim shape below).
 *
 * Shape contract:
 *   [VERIFY: rerun needed] attempt=N/M
 *   You claimed completion, but the automated evidence check did not find
 *   real test execution in the transcript.
 *   Missing:
 *   - <reason 1>
 *   - <reason 2>
 *   Run this command and include the test framework's green-summary line in
 *   your next response (e.g. "5 passed" / "Tests: 5 passed"):
 *     <command>
 *   Run the command and show the test framework's green-summary line; do not
 *   claim completion until verification passes.
 *
 * Semantically distinct from the [VALIDATION FAILED] envelope: a rerun gives
 * the model one chance to supply evidence after the evidence check; the prefix
 * is [VERIFY: rerun needed]; empty reasons → the Missing section is omitted.
 */
export function buildEvidenceRerunEnvelope(
  args: BuildEvidenceRerunEnvelopeArgs
): string {
  const truncatedReasons = args.reasons.slice(0, 5);
  const lines: string[] = [
    `${EVIDENCE_RERUN_PREFIX} attempt=${args.round}/${args.maxRounds}`,
    "You claimed completion, but the automated evidence check did not find",
    "real test execution in the transcript.",
  ];
  if (truncatedReasons.length > 0) {
    lines.push("Missing:");
    for (const reason of truncatedReasons) lines.push(`- ${reason}`);
    const extra = args.reasons.length - truncatedReasons.length;
    if (extra > 0) lines.push(`…${extra} more`);
  }
  lines.push(
    "Run this command and include the test framework's green-summary line in",
    'your next response (e.g. "5 passed" / "Tests: 5 passed"):',
    `  ${args.command}`
  );
  lines.push(EVIDENCE_RERUN_FIXED_INSTRUCTION);
  return `${lines.join("\n")}\n`;
}

/**
 * Not-verified envelope closing instruction. Deliberately NOT the
 * VALIDATION_FIXED_INSTRUCTION ("fix the failures"): nothing failed. And
 * deliberately NOT EVIDENCE_RERUN_FIXED_INSTRUCTION: the rerun envelope names
 * a concrete command to re-run and asks for a green-summary line. A terminal
 * `not_run` need not have a command to name at all — the only producer of it
 * today (the classifier branch) runs with an empty `config.command` — and must
 * not imply a plain retry is enough. It states the honest fact (nothing was
 * verified) and asks the model to produce test evidence before claiming
 * completion again.
 */
export const NOT_RUN_FIXED_INSTRUCTION =
  "This turn is not verified — no test evidence was produced, so do not treat it as passing. Run the project's tests and show the test framework's green-summary line before claiming completion.";

export interface BuildNotRunEnvelopeArgs {
  readonly round: number;
  readonly maxRounds: number;
  /**
   * The configured `verify.command`, when the loop has one. `not_run` is
   * reachable with an empty command (the classifier branch, the only producer
   * today), so this is optional: absent → the envelope names no command and
   * says so rather than inventing one (a copy naming an unrunnable command
   * would be a new, subtler lie).
   */
  readonly command?: string;
}

/**
 * Not-verified envelope builder (verbatim shape below).
 *
 * Shape contract:
 *   [VERIFY: not verified] attempt=N/M
 *   You reported the task as complete, but this turn produced no verifiable
 *   test evidence, so the result is not verified — not passed and not failed.
 *   Run the project's tests and include the test framework's green-summary
 *   line (e.g. "5 passed" / "Tests: 5 passed") in your next response before
 *   claiming completion again.
 *     <command>
 *   <NOT_RUN_FIXED_INSTRUCTION>
 *
 * A DEDICATED envelope rather than an extension of the evidence-rerun one: the
 * rerun envelope's trigger is weak evidence with a concrete command to re-run,
 * and its obligation is "run this exact command". A terminal `not_run` has
 * neither — it ends the loop, so it must report the honest state without
 * implying the model can simply retry.
 *
 * The success case is NEVER injected (spec): the model already knows its own
 * command exited 0, and injecting it would be noise.
 */
export function buildNotRunEnvelope(args: BuildNotRunEnvelopeArgs): string {
  const command = (args.command ?? "").trim();
  const lines: string[] = [
    `${NOT_RUN_PREFIX} attempt=${args.round}/${args.maxRounds}`,
    "You reported the task as complete, but this turn produced no verifiable",
    "test evidence, so the result is not verified — not passed and not failed.",
  ];
  if (command.length > 0) {
    lines.push(
      "Run the project's tests and include the test framework's green-summary",
      'line (e.g. "5 passed" / "Tests: 5 passed") in your next response before',
      "claiming completion again:",
      `  ${command}`
    );
  } else {
    lines.push(
      "No verify command is configured for this project, so run the project's",
      "tests yourself and include the test framework's green-summary line",
      '(e.g. "5 passed" / "Tests: 5 passed") in your next response before',
      "claiming completion again."
    );
  }
  lines.push(NOT_RUN_FIXED_INSTRUCTION);
  return `${lines.join("\n")}\n`;
}
