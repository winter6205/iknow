/**
 * #1076: the Node intercept message for TUI must not point users at an npm
 * script that only exists in the iknow repo.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { tuiNodeInterceptMessage, usageText } from "../../src/cli/usage.ts";

describe("tuiNodeInterceptMessage", () => {
  const cliFile = "/opt/iknow/dist/cli.js";
  const msg = tuiNodeInterceptMessage(cliFile);

  it("points at bun + this CLI file, not npm run dev:tui as the only command", () => {
    assert.match(msg, /Bun/);
    assert.match(msg, /bun .*\/opt\/iknow\/dist\/cli\.js"? tui/);
    assert.equal(msg.includes("请改用：npm run dev:tui"), false);
  });

  it("says chat/ask/serve still work on Node and workspace is cwd", () => {
    assert.match(msg, /chat/);
    assert.match(msg, /cwd|目标项目/i);
  });
});

describe("usageText — tui Bun", () => {
  it("says TUI needs Bun from any project, and npm run dev:tui is iknow-repo only", () => {
    const t = usageText();
    assert.match(t, /tui.*Bun|Bun.*tui/is);
    assert.match(t, /iknow 仓库根|iknow repo/i);
  });
});
