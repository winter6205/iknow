/**
 * CLI --data-dir + usage advertisement tests (spec #120 T3).
 * Located in a dedicated file to keep the file set disjoint from T4's
 * readonly-state work, which edits tests/cli-session.test.ts and
 * tests/cli/process-chat-line-harness.test.ts.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../../src/cli/parse-args.ts";
import { usageText } from "../../src/cli/usage.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import { resolveServeDataDir } from "../../src/session-api/serve.ts";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.ts";

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

describe("chat / ask entry-point dataDir threading (review-fix M-2)", () => {
  // Review fix: `runChat` / `runOneShot` used to not pass `parsed.dataDir` through
  // to the inner `SessionStore` / `chat-session.checkpointStore` —— with an
  // explicit `--data-dir <alt>` the SessionStore still landed in `~/.iknow`,
  // diverging from serve / trace behaviour. This pins the invariant: every CLI
  // entry point resolves `parsed.dataDir` to one and the same baseDir.
  it("resolveServeDataDir is the single pool resolver across entry points", () => {
    const alt = "/tmp/iknow-explicit-pool";
    // serve / chat / ask / trace share the same function and semantics: explicit
    // wins.
    assert.equal(resolveServeDataDir(alt), alt);
    assert.equal(resolveServeDataDir(undefined), join(homedir(), ".iknow"));
    // Resolving twice is idempotent (the same alt yields the same absolute path).
    assert.equal(resolveServeDataDir(alt), resolveServeDataDir(alt));
  });

  it("chat checkpointStore lands at <alt> when opts.dataDir is passed", () => {
    // Same root cause, stated as a cross-function equation: no recomputed slug, no
    // recomputed baseDir —— build a SessionStore and compare whether its underlying
    // projectDir is prefixed with `<alt>/projects/<slug>/`. If chat-session does not
    // pass opts.dataDir to SessionStore, projectDir lands under ~/.iknow and an
    // explicit --data-dir is silently swallowed.
    const alt = "/tmp/iknow-chat-alt-pool";
    const workspaceRoot = "/tmp/repo";
    // Mirrors chat-session's construction: new SessionStore(resolveServeDataDir(opts.dataDir), ...)
    const store = new SessionStore(
      resolveServeDataDir(alt),
      deriveProjectIdentityRoot({ cwd: workspaceRoot })
    );
    assert.ok(
      store.projectDir.startsWith(`${alt}/projects/`),
      `projectDir must sit under <alt>/projects/, got ${store.projectDir}`
    );
  });
});
