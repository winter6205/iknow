/**
 * The attempt's token total is the sum of every llm_call row, or null when the
 * trace was not read whole. A first page of 200 is not the attempt, and a cut
 * or a skipped line is not a smaller sum.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";

import { traceTokenTotals } from "../../../../scripts/eval/agent-qa/dispatch.ts";

const roots: string[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-qa-trace-usage-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function llmLine(index: number, inputTokens: number): string {
  return JSON.stringify({
    record_type: "llm_call",
    started_at: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
    status: "ok",
    input_tokens: inputTokens,
    output_tokens: 1,
  });
}

describe("traceTokenTotals", () => {
  it("adds the row past the 200-row page instead of stopping on the first page", () => {
    const path = join(scratch(), "trace.jsonl");
    const lines = Array.from({ length: 200 }, (_, index) => llmLine(index, 1));
    lines.push(llmLine(200, 50));
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");

    const totals = traceTokenTotals(path);
    assert.equal(totals.inputTokens, 250);
    assert.equal(totals.outputTokens, 201);
  });

  it("returns null rather than the rows that fit when the byte window cuts the file", () => {
    const path = join(scratch(), "trace.jsonl");
    const lines = [llmLine(0, 5), llmLine(1, 7), llmLine(2, 11)];
    const text = `${lines.join("\n")}\n`;
    writeFileSync(path, text, "utf8");

    const totals = traceTokenTotals(path, { maxBytes: text.indexOf("\n") });
    assert.equal(totals.inputTokens, null);
    assert.equal(totals.outputTokens, null);
    assert.notEqual(totals.inputTokens, 5);
  });

  it("returns null rather than a partial sum when a line cannot be parsed", () => {
    const path = join(scratch(), "trace.jsonl");
    writeFileSync(
      path,
      `${llmLine(0, 5)}\n{not-json\n${llmLine(1, 7)}\n`,
      "utf8"
    );

    const totals = traceTokenTotals(path);
    assert.equal(totals.inputTokens, null);
    assert.equal(totals.outputTokens, null);
    assert.notEqual(totals.inputTokens, 5);
    assert.notEqual(totals.inputTokens, 12);
  });
});
