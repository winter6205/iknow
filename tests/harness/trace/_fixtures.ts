/**
 * Shared trace-test fixtures. Local to tests/harness/trace — keeps duplication
 * out of individual test files. Mirrors the tests/cli/_fixtures.ts convention
 * (underscore-prefixed helper module co-located with the suite it serves).
 */
import { readFileSync } from "node:fs";

export function parseJsonl(filePath: string): Array<Record<string, unknown>> {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(String.fromCharCode(10))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
