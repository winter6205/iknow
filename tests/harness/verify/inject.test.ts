import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  buildClassifierEnvelope,
  buildValidationEnvelope,
  truncateExcerpt,
} from "../../../src/harness/verify/inject.ts";
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

    // 1. first line carries attempt + verdict + source markers (A8 固定英文).
    assert.ok(
      envelope.startsWith(
        "[VALIDATION FAILED] attempt=2/12 verdict=true-failure source=classifier\n"
      ),
      "first line must be VALIDATION FAILED marker with attempt/verdict/source\n---\n" +
        envelope
    );

    // 2. fixed-shape envelope (A8: 无 command/exit_code/failed_count/signature).
    assert.ok(
      envelope.includes("\ntask: 为 SessionGoal 增加 status 字段并落盘\n")
    );
    assert.ok(envelope.includes('\nmissing: ["部署到 staging", "迁移脚本"]\n'));
    assert.ok(
      envelope.includes(
        "\nreason: goal 已写入 session store,但 staging 部署步骤未执行\n"
      )
    );

    // 3. command-path fields must NOT appear (A8).
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

    // A8 explicit: 无 command / exit_code / failed_count / signature
    assert.equal(envelope.includes("command:"), false);
    assert.equal(envelope.includes("exit_code:"), false);
    assert.equal(envelope.includes("failed_count:"), false);
    assert.equal(envelope.includes("signature:"), false);
  });
});
