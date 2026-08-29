import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createQueryTraceCore,
} from "../../src/traceserver/query-trace-core.ts";
import { TraceQueryValidationError } from "../../src/traceserver/query-trace-errors.ts";

const traceDirs: string[] = [];

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

describe("query_trace traceserver core", () => {
  it("throws a traceserver validation error for invalid detail", async () => {
    const traceDir = mkdtempSync(join(tmpdir(), "iknow-query-trace-core-"));
    traceDirs.push(traceDir);
    writeFileSync(join(traceDir, "c1.jsonl"), "");

    await assert.rejects(
      () =>
        createQueryTraceCore({ traceDir })({
          conversation_id: "c1",
          record_id: "llm-1",
          detail: "everything",
        }),
      (error: unknown) =>
        error instanceof TraceQueryValidationError &&
        error.field === "detail"
    );
  });
});
