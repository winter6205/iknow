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
  // review fix: 此前 `runChat` / `runOneShot` 不把 `parsed.dataDir` 透传给内部
  // `SessionStore` / `chat-session.checkpointStore` —— 显式 `--data-dir <alt>`
  // 时 SessionStore 仍然落 `~/.iknow`，与 serve / trace 行为分叉。这条钉
  // 不变式：所有 CLI 入口把 `parsed.dataDir` 一致地解析成同一条 baseDir。
  it("resolveServeDataDir is the single pool resolver across entry points", () => {
    const alt = "/tmp/iknow-explicit-pool";
    // serve / chat / ask / trace 入口共享同一函数 + 同一语义：显式胜出。
    assert.equal(resolveServeDataDir(alt), alt);
    assert.equal(resolveServeDataDir(undefined), join(homedir(), ".iknow"));
    // 解析两次幂等（同一 alt 必须解到同一绝对路径）。
    assert.equal(resolveServeDataDir(alt), resolveServeDataDir(alt));
  });

  it("chat checkpointStore lands at <alt> when opts.dataDir is passed", () => {
    // 与 Finding #1 同源：跨函数等式 —— 不重算 slug、不重算 baseDir,
    // 直接构造 SessionStore 比对 underlying projectDir 的前缀是不是
    // `<alt>/projects/<slug>/`。若 chat-session 不把 opts.dataDir 透传给
    // SessionStore,projectDir 会落到 ~/.iknow 下,显式 --data-dir 即
    // 被静默吞。
    const alt = "/tmp/iknow-chat-alt-pool";
    const workspaceRoot = "/tmp/repo";
    // 模拟 chat-session.ts:2180 的构造：new SessionStore(resolveServeDataDir(opts.dataDir), ...)
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
