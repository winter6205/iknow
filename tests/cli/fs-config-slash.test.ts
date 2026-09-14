/**
 * ADR-0092 / SC13 —— chat REPL 的 `/config`（三入口 slash 对等物）。
 *
 * 两层：
 *   1. `applySlashCommand` 把 `/config` 解析成 `{ type: "config", args }`，
 *      args 原样透传（值域与文案单点在 `harness/sandbox/fs-mode.ts`）；
 *   2. `processChatLine` 在 host 的 `fsMode` holder 上执行 `applyFsModeCommand`
 *      —— 切档 / 状态查询 / 非法参数 usage 与 TUI / serve 同一份字面；
 *      holder 缺席（ask 入口）→ stderr 提示不改状态。
 *
 * 不落盘：与 `/graph` 同款只翻 holder（chat 无 settings 写回通道；TUI 的
 * 持久化面是 `onPersistFsMode`，不在本入口合同内）。
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

/** processChatLine 只走 slash 分支时不碰 deps；给个不可调用的占位。 */
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
    // 不是 "Unknown command /config"（词表漏项）—— 命令已认识，只是本入口
    // 没注入 holder（与 /graph 缺席文案同形态）。
    assert.match(res.stderr ?? "", /^\/config: /);
    assert.doesNotMatch(res.stderr ?? "", /Unknown command/);
  });
});
