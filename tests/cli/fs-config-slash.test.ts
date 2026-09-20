/**
 * ADR-0092 — chat REPL `/config` (the slash peer across the three entry points).
 *
 * Two layers:
 *   1. `applySlashCommand` parses `/config` into `{ type: "config", args }`,
 *      passing args through verbatim (value domain and wording live in one
 *      place: `harness/sandbox/fs-mode.ts`);
 *   2. `processChatLine` runs `applyFsModeCommand` on the host's `fsMode`
 *      holder — mode switch / status query / invalid-arg usage all share the
 *      same literals as TUI and serve; holder absent (ask entry) → stderr hint,
 *      no state change.
 *
 * Not persisted: like `/graph`, it only flips the holder (chat has no settings
 * write-back channel; TUI's persistence surface is `onPersistFsMode`, outside
 * this entry point's contract).
 */
import { describe, expect, test } from "vitest";
import assert from "node:assert/strict";
import {
  applySlashCommand,
  HELP_TEXT,
  type SlashContext,
} from "../../src/cli/slash.ts";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { createFsModeContext } from "../../src/harness/sandbox/fs-mode.ts";
import { makeState } from "./_fixtures.ts";
import type { LoopEngineDeps } from "../../src/harness/loop-engine.ts";

function mockCtx(overrides: Partial<SlashContext> = {}): SlashContext {
  return { state: makeState(), ...overrides };
}

/** When processChatLine only takes the slash branch it never touches deps; this is a non-callable placeholder. */
const UNUSED_DEPS = {} as unknown as LoopEngineDeps;

describe("/config 解析 (cli slash)", () => {
  test("空 args → { type: config, args: [] }", () => {
    expect(
      applySlashCommand({ command: "config", args: [], ctx: mockCtx() })
    ).toEqual({ type: "config", args: [] });
  });

  test("args 原样透传（解析归 harness/sandbox/fs-mode.ts 单点）", () => {
    expect(
      applySlashCommand({
        command: "config",
        args: ["fs", "workspace"],
        ctx: mockCtx(),
      })
    ).toEqual({ type: "config", args: ["fs", "workspace"] });
  });

  test("HELP_TEXT 列出 /config", () => {
    assert.match(HELP_TEXT, /\/config/);
  });
});

describe("/config 执行 (chat host holder)", () => {
  test("fs workspace → holder 翻到工作区档；fs global → 翻回", async () => {
    const fsMode = createFsModeContext();
    const ctx = { deps: UNUSED_DEPS, state: makeState(), fsMode };

    const toWorkspace = await processChatLine({
      line: "/config fs workspace",
      ctx,
    });
    assert.equal(toWorkspace.quit, false);
    assert.match(toWorkspace.output, /已切换/);
    assert.match(toWorkspace.output, /workspace/);
    assert.equal(fsMode.get(), "workspace");

    const toGlobal = await processChatLine({ line: "/config fs global", ctx });
    assert.match(toGlobal.output, /已切换/);
    assert.equal(fsMode.get(), "global");
  });

  test("/config / /config status → 只回状态，不改 holder", async () => {
    const fsMode = createFsModeContext("workspace");
    const ctx = { deps: UNUSED_DEPS, state: makeState(), fsMode };

    const bare = await processChatLine({ line: "/config", ctx });
    assert.match(bare.output, /文件系统隔离档/);
    assert.match(bare.output, /workspace/);
    assert.equal(fsMode.get(), "workspace");

    const status = await processChatLine({ line: "/config status", ctx });
    assert.match(status.output, /文件系统隔离档/);
    assert.equal(fsMode.get(), "workspace");
  });

  test("非法参数 → stderr usage，不改状态", async () => {
    const fsMode = createFsModeContext();
    const ctx = { deps: UNUSED_DEPS, state: makeState(), fsMode };
    const res = await processChatLine({ line: "/config maybe", ctx });
    assert.equal(res.output, "");
    assert.match(res.stderr ?? "", /Usage: \/config/);
    assert.equal(fsMode.get(), "global");
  });

  test("holder 缺席（ask 入口）→ stderr 提示，不抛", async () => {
    const ctx = { deps: UNUSED_DEPS, state: makeState() };
    const res = await processChatLine({ line: "/config fs workspace", ctx });
    assert.equal(res.output, "");
    // Not "Unknown command /config" (missing from the verb table) — the command
    // IS recognized; this entry point just has no holder injected (same shape
    // as the /graph absent-holder message).
    assert.match(res.stderr ?? "", /^\/config: /);
    assert.doesNotMatch(res.stderr ?? "", /Unknown command/);
  });
});
