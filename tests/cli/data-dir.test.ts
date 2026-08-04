/**
 * CLI --data-dir + usage advertisement tests (spec #120 T3).
 * Located in a dedicated file to keep the file set disjoint from T4's
 * readonly-state work, which edits tests/cli-session.test.ts and
 * tests/cli/process-chat-line-harness.test.ts.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/parse-args.ts";
import { usageText } from "../../src/cli/usage.ts";

describe("parseArgs --data-dir", () => {
  it("parses --data-dir <dir> into ParsedCli.dataDir", () => {
    const p = parseArgs({ argv: ["serve", "--data-dir", "/tmp/x"] });
    assert.equal(p.command, "serve");
    assert.equal(p.dataDir, "/tmp/x");
  });

  it("works for relative paths and preserves the raw string", () => {
    const p = parseArgs({ argv: ["serve", "--data-dir", "data/custom"] });
    assert.equal(p.dataDir, "data/custom");
  });

  it("dataDir defaults to undefined when the flag is omitted", () => {
    const p = parseArgs({ argv: ["serve"] });
    assert.equal(p.command, "serve");
    assert.equal(p.dataDir, undefined);
  });

  it("throws when --data-dir is followed by no value", () => {
    assert.throws(
      () => parseArgs({ argv: ["serve", "--data-dir"] }),
      /--data-dir/
    );
  });

  it("coexists with --port (no cross-flag contamination)", () => {
    const p = parseArgs({
      argv: ["serve", "--port", "9000", "--data-dir", "/tmp/x"],
    });
    assert.equal(p.port, 9000);
    assert.equal(p.dataDir, "/tmp/x");
  });
});

describe("usageText — --data-dir advertisement", () => {
  it("usageText mentions --data-dir <dir> (bilingual)", () => {
    const t = usageText();
    assert.match(t, /--data-dir <dir>/);
    // Both languages should appear next to the flag in the Options block.
    assert.match(t, /session pool root/i);
    assert.match(t, /会话池|共享池/i);
  });

  it("usageText preserves the existing --port / --host entries (no regression)", () => {
    const t = usageText();
    assert.match(t, /--port <n>/);
    assert.match(t, /--host <addr>/);
  });
});
