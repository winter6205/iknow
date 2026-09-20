import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildClassifierEnvelope,
  buildEvidenceRerunEnvelope,
  buildValidationEnvelope,
  isVerifyInjectedText,
  truncateExcerpt,
} from "../../../src/harness/verify/inject.ts";
import type { EvidenceContext } from "../../../src/harness/verify/types.ts";
import { truncateByCodePoint } from "../../../src/harness/aci/tools/helpers.ts";

const FIXED_INSTRUCTION =
  "Fix the failures above. Do not claim completion until validation passes.";

const ENVELOPE_REQUIRED_FIELDS = [
  "[VALIDATION FAILED]",
  "command:",
  "exit_code:",
  "output_excerpt:",
  FIXED_INSTRUCTION,
] as const;

const ENVELOPE_OPTIONAL_FIELDS = ["failed_count:", "signature:"] as const;

function assertEnvelopeShape(
  envelope: string,
  options?: { optionalFieldsPresent?: boolean }
): void {
  const fields =
    options?.optionalFieldsPresent === false
      ? ENVELOPE_REQUIRED_FIELDS
      : [...ENVELOPE_REQUIRED_FIELDS, ...ENVELOPE_OPTIONAL_FIELDS];
  for (const field of fields) {
    assert.ok(
      envelope.includes(field),
      `envelope must include ${JSON.stringify(field)}\n---\n${envelope}`
    );
  }
  assert.ok(
    envelope.endsWith(FIXED_INSTRUCTION + "\n"),
    `envelope must end with the fixed instruction on the last line\n---\n${envelope}`
  );
}

describe("isVerifyInjectedText", () => {
  it("matches validation and rerun envelopes; rejects user queries", () => {
    assert.equal(
      isVerifyInjectedText("[VALIDATION FAILED] attempt=1/12"),
      true
    );
    assert.equal(
      isVerifyInjectedText("  [VERIFY: rerun needed] attempt=1/12"),
      true
    );
    assert.equal(isVerifyInjectedText("hello"), false);
    assert.equal(isVerifyInjectedText(""), false);
  });
});

describe("truncateExcerpt", () => {
  it("truncates output excerpt at 20000 chars", () => {
    const output = "x".repeat(25_000);
    const truncated = truncateExcerpt(output, 20_000);
    assert.equal(Array.from(truncated).length, 20_000);
    assert.ok(truncated.length <= 20_000);
    assert.equal(truncated, truncateByCodePoint(output, 20_000));
  });

  it("does not split a surrogate pair at the boundary", () => {
    // 20_000 chars of ASCII then an emoji whose code point straddles the cut.
    const output = "a".repeat(19_999) + "😀" + "zzz";
    const truncated = truncateExcerpt(output, 20_000);
    assert.equal(truncated.endsWith("😀"), true);
    assert.equal(truncated.endsWith("😀z"), false);
  });

  it("preserves full multi-code-point characters", () => {
    const output = "中中中😀🎉"; // 3 CJK + 2 emoji = 5 code points
    assert.equal(truncateExcerpt(output, 5), output);
    assert.equal(truncateExcerpt(output, 4), "中中中😀");
    assert.equal(truncateExcerpt(output, 3), "中中中");
  });

  it("leaves short output unchanged", () => {
    const output = "short output";
    assert.equal(truncateExcerpt(output, 20_000), output);
  });

  it("handles empty output", () => {
    assert.equal(truncateExcerpt("", 20_000), "");
  });

  it("rejects a negative maximum", () => {
    assert.throws(() => truncateExcerpt("abc", -1), RangeError);
  });
});

describe("buildValidationEnvelope", () => {
  it("matches the spec envelope byte-for-byte on field names", () => {
    const envelope = buildValidationEnvelope({
      round: 2,
      maxRounds: 12,
      verdict: "true-failure",
      command: "npm test",
      exitCode: 1,
      failedCount: 3,
      signature: "exit=1|tests/auth.test.ts:login rejects bad token",
      outputExcerpt: "some failure output\n",
    });

    assertEnvelopeShape(envelope);

    assert.ok(
      envelope.startsWith(
        "[VALIDATION FAILED] attempt=2/12 verdict=true-failure\n"
      ),
      "first line must be the VALIDATION FAILED marker with attempt and verdict\n---\n" +
        envelope
    );
    assert.ok(envelope.includes("\ncommand: npm test\n"));
    assert.ok(envelope.includes("\nexit_code: 1\n"));
    assert.ok(envelope.includes("\nfailed_count: 3\n"));
    assert.ok(
      envelope.includes(
        "\nsignature: exit=1|tests/auth.test.ts:login rejects bad token\n"
      )
    );
    assert.ok(
      envelope.includes("\noutput_excerpt:\nsome failure output\n"),
      "output_excerpt must carry the (possibly truncated) raw output verbatim\n---\n" +
        envelope
    );
    assert.ok(
      envelope.endsWith("some failure output\n" + FIXED_INSTRUCTION + "\n")
    );
  });

  it("matches the spec envelope line-for-line", () => {
    const envelope = buildValidationEnvelope({
      round: 2,
      maxRounds: 12,
      verdict: "true-failure",
      command: "npm test",
      exitCode: 1,
      failedCount: 3,
      signature: "exit=1|tests/auth.test.ts:login rejects bad token",
      outputExcerpt: "some failure output\n",
    });

    assert.deepEqual(envelope.split("\n"), [
      "[VALIDATION FAILED] attempt=2/12 verdict=true-failure",
      "command: npm test",
      "exit_code: 1",
      "failed_count: 3",
      "signature: exit=1|tests/auth.test.ts:login rejects bad token",
      "output_excerpt:",
      "some failure output",
      FIXED_INSTRUCTION,
      "",
    ]);
  });

  it("truncates long output inside the envelope to the default 20000 code points", () => {
    const bigOutput = "x".repeat(30_000);
    const envelope = buildValidationEnvelope({
      round: 1,
      maxRounds: 12,
      verdict: "true-failure",
      command: "npm test",
      exitCode: 1,
      failedCount: 1,
      signature: "exit=1",
      outputExcerpt: bigOutput,
    });

    const excerptLine = envelope.split("\n").find((l) => l.startsWith("x"));
    assert.ok(excerptLine !== undefined);
    assert.equal(Array.from(excerptLine).length, 20_000);
  });

  it("honors a custom maxChars", () => {
    const envelope = buildValidationEnvelope({
      round: 1,
      maxRounds: 3,
      verdict: "unstable",
      command: "npm test",
      exitCode: 2,
      failedCount: 4,
      signature: "exit=2",
      outputExcerpt: "abcdefgh",
      maxChars: 4,
    });
    assert.ok(envelope.includes("\noutput_excerpt:\nabcd\n"));
  });

  it("omits failed_count and signature when absent", () => {
    const envelope = buildValidationEnvelope({
      round: 3,
      maxRounds: 12,
      verdict: "true-failure",
      command: "npm test",
      exitCode: 1,
      outputExcerpt: "",
    });

    assert.ok(!envelope.includes("failed_count:"));
    assert.ok(!envelope.includes("signature:"));
    assert.ok(!envelope.includes("failedCount"));
    assert.ok(!envelope.includes("failedCount:"));
    assert.ok(!envelope.includes("outputExcerpt"));
    assert.ok(envelope.includes("output_excerpt:\n"));
    assert.ok(envelope.includes("command: npm test"));
    assert.ok(envelope.includes("exit_code: 1"));
    assertEnvelopeShape(envelope, { optionalFieldsPresent: false });
  });

  it("is append-only as a single user message with no forged tool calls", () => {
    const envelope = buildValidationEnvelope({
      round: 1,
      maxRounds: 12,
      verdict: "true-failure",
      command: "npm test",
      exitCode: 1,
      failedCount: 2,
      signature: "exit=1",
      outputExcerpt: "boom",
    });

    assert.equal(typeof envelope, "string");
    assert.equal(envelope.includes('"tool_use"'), false);
    assert.equal(envelope.includes('"tool_result"'), false);
    assert.equal(envelope.includes("tool_use"), false);
    assert.ok(envelope.startsWith("[VALIDATION FAILED]"));
  });

  it("handles empty output with absent optional fields", () => {
    const envelope = buildValidationEnvelope({
      round: 1,
      maxRounds: 12,
      verdict: "unstable",
      command: "npm run probe",
      exitCode: 137,
      outputExcerpt: "",
    });

    assertEnvelopeShape(envelope, { optionalFieldsPresent: false });
    assert.deepEqual(envelope.split("\n"), [
      "[VALIDATION FAILED] attempt=1/12 verdict=unstable",
      "command: npm run probe",
      "exit_code: 137",
      "output_excerpt:",
      FIXED_INSTRUCTION,
      "",
    ]);
  });
});

describe("buildClassifierEnvelope", () => {
  it("matches the spec envelope line-for-line (happy path)", () => {
    const envelope = buildClassifierEnvelope({
      round: 2,
      maxRounds: 12,
      task: "为 SessionGoal 增加 status 字段并落盘",
      missing: ["部署到 staging", "迁移脚本"],
      reason: "goal 已写入 session store,但 staging 部署步骤未执行",
    });

    // 1. first line carries attempt + verdict + source markers (fixed English text).
    assert.ok(
      envelope.startsWith(
        "[VALIDATION FAILED] attempt=2/12 verdict=true-failure source=classifier\n"
      ),
      "first line must be VALIDATION FAILED marker with attempt/verdict/source\n---\n" +
        envelope
    );

    // 2. fixed-shape envelope (no command/exit_code/failed_count/signature).
    assert.ok(
      envelope.includes("\ntask: 为 SessionGoal 增加 status 字段并落盘\n")
    );
    assert.ok(envelope.includes('\nmissing: ["部署到 staging", "迁移脚本"]\n'));
    assert.ok(
      envelope.includes(
        "\nreason: goal 已写入 session store,但 staging 部署步骤未执行\n"
      )
    );

    // 3. command-path fields must NOT appear.
    assert.equal(envelope.includes("command:"), false);
    assert.equal(envelope.includes("exit_code:"), false);
    assert.equal(envelope.includes("failed_count:"), false);
    assert.equal(envelope.includes("signature:"), false);

    // 4. deepEqual against expected shape line-for-line.
    assert.deepEqual(envelope.split("\n"), [
      "[VALIDATION FAILED] attempt=2/12 verdict=true-failure source=classifier",
      "task: 为 SessionGoal 增加 status 字段并落盘",
      'missing: ["部署到 staging", "迁移脚本"]',
      "reason: goal 已写入 session store,但 staging 部署步骤未执行",
      FIXED_INSTRUCTION,
      "",
    ]);

    // 5. ends with the fixed instruction (reuse assertEnvelopeShape analogue).
    assert.ok(envelope.endsWith(FIXED_INSTRUCTION + "\n"));
  });

  it("renders an empty missing array as []", () => {
    const envelope = buildClassifierEnvelope({
      round: 1,
      maxRounds: 12,
      task: "ensure code review report merges cleanly",
      missing: [],
      reason: "single judge line",
    });

    assert.ok(envelope.includes("\nmissing: []\n"));
    assert.ok(envelope.startsWith("[VALIDATION FAILED]"));
    assert.ok(envelope.endsWith(FIXED_INSTRUCTION + "\n"));
    assert.equal(envelope.includes("command:"), false);
    assert.equal(envelope.includes("exit_code:"), false);
  });

  it("renders multiple missing items verbatim, preserving order", () => {
    const envelope = buildClassifierEnvelope({
      round: 3,
      maxRounds: 12,
      task: "task text",
      missing: [
        "deploy to staging",
        "write migration script",
        "update runbook",
        "notify on-call",
      ],
      reason: "reason",
    });

    const expectedLine =
      'missing: ["deploy to staging", "write migration script", "update runbook", "notify on-call"]';
    assert.ok(envelope.includes("\n" + expectedLine + "\n"));
    assert.deepEqual(envelope.split("\n"), [
      "[VALIDATION FAILED] attempt=3/12 verdict=true-failure source=classifier",
      "task: task text",
      expectedLine,
      "reason: reason",
      FIXED_INSTRUCTION,
      "",
    ]);
  });

  it("collapses multi-line task content to a single line", () => {
    // Multi-line goal.text must not break the fixed-shape envelope: each field
    // is exactly one line, newlines (CR/LF/U+2028/U+2029) inside task collapse
    // to a single space.
    const envelope = buildClassifierEnvelope({
      round: 1,
      maxRounds: 12,
      task: "line one\nline two\r\nline three line four line five",
      missing: ["item"],
      reason: "judge reason",
    });

    assert.deepEqual(envelope.split("\n"), [
      "[VALIDATION FAILED] attempt=1/12 verdict=true-failure source=classifier",
      "task: line one line two line three line four line five",
      'missing: ["item"]',
      "reason: judge reason",
      FIXED_INSTRUCTION,
      "",
    ]);
    assert.ok(envelope.endsWith(FIXED_INSTRUCTION + "\n"));
    assert.equal(envelope.includes("command:"), false);
  });

  it("truncates a very long reason via truncateExcerpt", () => {
    // 200 chars is far below the 20_000 default; pick something that exercises
    // the helper while remaining well-formed after truncation. Use a custom
    // upper bound by passing maxChars so the test is deterministic.
    const longReason = "judge ".repeat(40); // 240 chars
    const envelope = buildClassifierEnvelope({
      round: 1,
      maxRounds: 12,
      task: "task",
      missing: ["x"],
      reason: longReason,
      maxChars: 100,
    });

    // The reason header is `reason: <truncated>` and must respect maxChars
    // on the value portion (counting from the first reason char). Assert a
    // literal expected string so the oracle is not the helper under test.
    const reasonLine = envelope
      .split("\n")
      .find((l) => l.startsWith("reason: "));
    assert.ok(reasonLine !== undefined);
    const value = reasonLine.slice("reason: ".length);
    assert.equal(value, "judge ".repeat(16) + "judg");
    // Code-point integrity: truncation must not split a surrogate pair.
    assert.equal(value, truncateByCodePoint(longReason, 100));
  });

  it("leaves a short reason unchanged", () => {
    const envelope = buildClassifierEnvelope({
      round: 1,
      maxRounds: 12,
      task: "task",
      missing: ["x"],
      reason: "concise judge one-liner",
    });

    assert.ok(
      envelope.includes("\nreason: concise judge one-liner\n"),
      "short reason must be embedded verbatim\n---\n" + envelope
    );
    assert.deepEqual(envelope.split("\n"), [
      "[VALIDATION FAILED] attempt=1/12 verdict=true-failure source=classifier",
      "task: task",
      'missing: ["x"]',
      "reason: concise judge one-liner",
      FIXED_INSTRUCTION,
      "",
    ]);
  });

  it("ends with the fixed instruction line and uses VALIDATION_FIXED_INSTRUCTION verbatim", () => {
    const envelope = buildClassifierEnvelope({
      round: 5,
      maxRounds: 12,
      task: "any",
      missing: ["a"],
      reason: "b",
    });

    assert.ok(envelope.endsWith(FIXED_INSTRUCTION + "\n"));
    // The reason line precedes the instruction by exactly one newline.
    const lines = envelope.split("\n");
    assert.equal(lines[lines.length - 2], FIXED_INSTRUCTION);
    assert.equal(lines[lines.length - 1], "");
  });

  it("does not contain command-path field names", () => {
    const envelope = buildClassifierEnvelope({
      round: 2,
      maxRounds: 12,
      task: "task",
      missing: ["a", "b"],
      reason: "judge",
    });

    // Explicit: no command / exit_code / failed_count / signature fields.
    assert.equal(envelope.includes("command:"), false);
    assert.equal(envelope.includes("exit_code:"), false);
    assert.equal(envelope.includes("failed_count:"), false);
    assert.equal(envelope.includes("signature:"), false);
  });
});

/**
 * Rerun-envelope builder tests — asserts the final agreed copy verbatim plus
 * the rerun-specific closing instruction. assertEnvelopeShape is not reused
 * (it pins command-path fields); assertions are inlined.
 */
describe("buildEvidenceRerunEnvelope", () => {
  // Rerun-specific tail instruction as its own constant (does not reuse
  // VALIDATION_FIXED_INSTRUCTION); pinned verbatim test-side.
  const RERUN_INSTRUCTION =
    "Run the command and show the test framework's green-summary line; do not claim completion until verification passes.";

  it("matches the B1 OQ1 final copy verbatim (attempt=N/M + command embedded + Missing)", () => {
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons: [
        "no bash test execution before claim found",
        "no run satisfies exit-0 + green-summary evidence threshold",
      ],
      command: "npm test",
    });

    // Final agreed copy, verbatim.
    assert.deepEqual(envelope.split("\n"), [
      "[VERIFY: rerun needed] attempt=1/12",
      "You claimed completion, but the automated evidence check did not find",
      "real test execution in the transcript.",
      "Missing:",
      "- no bash test execution before claim found",
      "- no run satisfies exit-0 + green-summary evidence threshold",
      "Run this command and include the test framework's green-summary line in",
      'your next response (e.g. "5 passed" / "Tests: 5 passed"):',
      "  npm test",
      RERUN_INSTRUCTION,
      "",
    ]);
  });

  it("renders attempt=N/M from round and maxRounds", () => {
    const envelope = buildEvidenceRerunEnvelope({
      round: 2,
      maxRounds: 4,
      reasons: ["x"],
      command: "pytest",
    });
    assert.ok(
      envelope.startsWith("[VERIFY: rerun needed] attempt=2/4\n"),
      "header line must carry attempt and maxRounds\n---\n" + envelope
    );
  });

  it("embeds the command verbatim (no truncation, 2-space indent)", () => {
    const command = "npx vitest run tests/foo.test.ts --runInBand";
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons: ["x"],
      command,
    });
    assert.ok(
      envelope.includes(`\n  ${command}\n`),
      "command must be embedded verbatim with 2-space indent\n---\n" + envelope
    );
  });

  it("truncates reasons beyond 5 and appends …N more", () => {
    const reasons = Array.from({ length: 8 }, (_, i) => `reason ${i + 1}`);
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons,
      command: "npm test",
    });
    // First 5 reasons verbatim, original order.
    for (const r of [
      "reason 1",
      "reason 2",
      "reason 3",
      "reason 4",
      "reason 5",
    ]) {
      assert.ok(
        envelope.includes(`- ${r}`),
        `must include first 5 reasons verbatim, missing: ${r}\n---\n${envelope}`
      );
    }
    assert.ok(!envelope.includes("- reason 6"), "must not include 6th reason");
    assert.ok(!envelope.includes("- reason 7"), "must not include 7th reason");
    assert.ok(!envelope.includes("- reason 8"), "must not include 8th reason");
    // …3 more (8-5=3 omitted); overflow collapses to "…N more" to keep the envelope small
    assert.ok(
      envelope.includes("…3 more"),
      `must append …N more line for omitted reasons\n---\n${envelope}`
    );
  });

  it("omits the Missing section entirely when reasons is empty", () => {
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons: [],
      command: "npm test",
    });
    assert.ok(
      !envelope.includes("Missing:"),
      "empty reasons → omit Missing section\n---\n" + envelope
    );
    assert.ok(
      !envelope.includes("- "),
      "empty reasons → no bullet lines\n---\n" + envelope
    );
    // Remaining structure stays intact (header + body + command + tail)
    assert.ok(envelope.startsWith("[VERIFY: rerun needed]"));
    assert.ok(envelope.includes("  npm test\n"));
    assert.ok(envelope.endsWith(RERUN_INSTRUCTION + "\n"));
  });

  it("ends with the rerun-specific fixed instruction (does not reuse VALIDATION_FIXED_INSTRUCTION)", () => {
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons: ["x"],
      command: "npm test",
    });
    assert.ok(
      envelope.endsWith(RERUN_INSTRUCTION + "\n"),
      `must end with the rerun instruction verbatim\n---\n${envelope}`
    );
    assert.equal(
      envelope.includes(FIXED_INSTRUCTION),
      false,
      "must not reuse VALIDATION_FIXED_INSTRUCTION (B5 替换为补跑专属指令)"
    );
    // Second-to-last line = RERUN_INSTRUCTION, last line = ""
    const lines = envelope.split("\n");
    assert.equal(lines[lines.length - 2], RERUN_INSTRUCTION);
    assert.equal(lines[lines.length - 1], "");
  });

  it("does not use the VALIDATION FAILED prefix (B1 刻意区分语义)", () => {
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons: ["x"],
      command: "npm test",
    });
    assert.ok(envelope.startsWith("[VERIFY: rerun needed]"));
    assert.equal(
      envelope.includes("[VALIDATION FAILED]"),
      false,
      "must not use [VALIDATION FAILED] prefix (B1: 区分验证失败 vs 补跑两类)"
    );
  });

  it("is append-only as a single user message with no forged tool calls", () => {
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons: ["x"],
      command: "npm test",
    });
    assert.equal(typeof envelope, "string");
    assert.equal(envelope.includes('"tool_use"'), false);
    assert.equal(envelope.includes('"tool_result"'), false);
    assert.equal(envelope.includes("tool_use"), false);
  });

  it("does not carry command-path field names (command / exit_code / failed_count / signature)", () => {
    const envelope = buildEvidenceRerunEnvelope({
      round: 1,
      maxRounds: 12,
      reasons: ["x"],
      command: "npm test",
    });
    // The rerun envelope carries only: attempt + Missing(reasons) + command + tail (no exit_code etc.).
    assert.equal(envelope.includes("exit_code:"), false);
    assert.equal(envelope.includes("failed_count:"), false);
    assert.equal(envelope.includes("signature:"), false);
    // The command string appears only as the 2-space-indented line after
    // "your next response ...", never as a "command: npm test" key-value pair.
    assert.equal(envelope.includes("command: npm test"), false);
  });
});

/**
 * buildClassifierEnvelope evidence_context extension — the evidence checklist
 * rides inside the failure-fix envelope. The existing buildClassifierEnvelope
 * cases (describe above) are untouched; this describe only adds the
 * present/absent directions for evidenceContext.
 */
describe("buildClassifierEnvelope with evidenceContext (#449b B6)", () => {
  /** Full EvidenceContext fixture (multi-line summary exercises truncation). */
  function makeEvidenceContext(): EvidenceContext {
    return {
      checkerVerdict: "EVIDENCE_INSUFFICIENT",
      reasons: ["no bash test execution before claim found", "stale evidence"],
      executedCommands: ["npx vitest run", "pytest"],
      rerunAttempted: true,
      evidenceSummary:
        "npx vitest run exit=1 green=false\npytest exit=0 green=true",
    };
  }

  it("evidence_context 段字段齐 (checker_verdict/reasons/executed_commands/rerun_attempted/evidence_summary)", () => {
    const envelope = buildClassifierEnvelope({
      round: 2,
      maxRounds: 12,
      task: "goal text",
      missing: ["m1"],
      reason: "judge one-liner",
      evidenceContext: makeEvidenceContext(),
    });

    // Section order: after missing/reason, before the fixed instruction.
    const idxEvidence = envelope.indexOf("\nevidence_context:\n");
    const idxReason = envelope.indexOf("\nreason: judge one-liner\n");
    const idxInstruction = envelope.indexOf("\n" + FIXED_INSTRUCTION + "\n");
    assert.ok(idxReason > -1, "reason line present");
    assert.ok(
      idxEvidence > -1,
      "evidence_context section marker present\n---\n" + envelope
    );
    assert.ok(idxInstruction > -1, "fixed instruction present");
    assert.ok(
      idxReason < idxEvidence && idxEvidence < idxInstruction,
      "evidence_context must sit after missing/reason and before the fixed instruction"
    );
    assert.ok(envelope.endsWith(FIXED_INSTRUCTION + "\n"));

    // Header (missing/reason section) must match the plain envelope — regression anchor.
    const headerEnd = idxEvidence + 1;
    const header = envelope.slice(0, headerEnd);
    assert.ok(header.includes("\ntask: goal text\n"));
    assert.ok(header.includes('\nmissing: ["m1"]\n'));
    assert.ok(header.includes("\nreason: judge one-liner\n"));

    // evidence_context section checked line-by-line via deepEqual (multi-line evidenceSummary block).
    const tail = envelope.slice(idxEvidence + 1);
    const tailLines = tail.split("\n");
    // The tail ends with the summary's last line + FIXED_INSTRUCTION + "";
    // when the summary itself ends with \n the last line is "". Slice after the summary block.
    const summaryStart =
      tailLines.findIndex((l) => l === "evidence_summary:") + 1;
    assert.ok(summaryStart > 0, "evidence_summary: marker must precede block");
    const summaryEnd = tailLines.length - 2; // last = "", second-to-last = FIXED_INSTRUCTION
    const summaryLines = tailLines.slice(summaryStart, summaryEnd);
    assert.deepEqual(summaryLines, [
      "npx vitest run exit=1 green=false",
      "pytest exit=0 green=true",
    ]);
    // First 5 tail lines: evidence_context: + checker_verdict + reasons + executed_commands + rerun_attempted.
    assert.deepEqual(tailLines.slice(0, 5), [
      "evidence_context:",
      "checker_verdict: EVIDENCE_INSUFFICIENT",
      'reasons: ["no bash test execution before claim found", "stale evidence"]',
      'executed_commands: ["npx vitest run", "pytest"]',
      "rerun_attempted: true",
    ]);
  });

  it("evidenceSummary 截到 20000 codepoints (truncateExcerpt, B1 OQ2)", () => {
    const evidenceSummary = "x".repeat(25_000);
    const envelope = buildClassifierEnvelope({
      round: 1,
      maxRounds: 12,
      task: "t",
      missing: [],
      reason: "r",
      evidenceContext: {
        checkerVerdict: "EVIDENCE_INSUFFICIENT",
        reasons: [],
        executedCommands: [],
        rerunAttempted: false,
        evidenceSummary,
      },
    });
    // The evidence_summary block sits between the "evidence_summary:" marker and
    // FIXED_INSTRUCTION; extract exactly that substring.
    const markerIdx = envelope.indexOf("evidence_summary:\n");
    const instructionIdx = envelope.lastIndexOf(
      "\n" + FIXED_INSTRUCTION + "\n"
    );
    assert.ok(markerIdx > -1, "evidence_summary marker present");
    assert.ok(instructionIdx > -1, "fixed instruction present");
    const block = envelope.slice(
      markerIdx + "evidence_summary:\n".length,
      instructionIdx
    );
    assert.equal(
      Array.from(block).length,
      20_000,
      "evidence_summary block must be truncated to 20000 code points"
    );
    assert.equal(block, truncateByCodePoint(evidenceSummary, 20_000));
  });

  it("evidenceContext 缺席 → 信封与既有逐字节一致 (回归锚)", () => {
    const baseArgs = {
      round: 2,
      maxRounds: 12,
      task: "为 SessionGoal 增加 status 字段并落盘",
      missing: ["部署到 staging"],
      reason: "goal 已写入 session store,但 staging 部署步骤未执行",
    };
    const base = buildClassifierEnvelope(baseArgs);
    const withUndefined = buildClassifierEnvelope({
      ...baseArgs,
      evidenceContext: undefined,
    });
    assert.equal(
      withUndefined,
      base,
      "absent evidenceContext must not alter the envelope byte-for-byte"
    );
    assert.equal(
      withUndefined.includes("evidence_context"),
      false,
      "no evidence_context section when evidenceContext is undefined (Postel)"
    );
  });

  it("evidenceContext 缺席 → 仍无 command 路径字段名", () => {
    const envelope = buildClassifierEnvelope({
      round: 1,
      maxRounds: 12,
      task: "t",
      missing: ["a"],
      reason: "b",
    });
    assert.equal(envelope.includes("command:"), false);
    assert.equal(envelope.includes("exit_code:"), false);
    assert.equal(envelope.includes("failed_count:"), false);
    assert.equal(envelope.includes("signature:"), false);
  });
});
