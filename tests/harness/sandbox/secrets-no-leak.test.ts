import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readSandboxSource(): string {
  return readdirSync("src/harness/sandbox")
    .filter((name) => name.endsWith(".ts"))
    .map((name) => readFileSync(join("src/harness/sandbox", name), "utf8"))
    .join("\n");
}

describe("sandbox secret literal guard", () => {
  it("does not hardcode the canonical LLM key name", () => {
    assert.equal(readSandboxSource().includes("ANTHROPIC_AUTH_TOKEN"), false);
  });
});
