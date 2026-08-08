/**
 * tests/cli/chat-mode-shift-tab.test.ts
 *
 * W2 扩展：REPL Shift+Tab 翻权限模式的独立单测（不依赖真实 TTY，
 * runChatSession 的 keypress 监听内部调 applyShiftTabModeFlip）。
 *
 * 覆盖边界（计划 §Validation）：
 *  - shift+tab → default → full_auto → default 循环；
 *  - plan 按 shift+tab → 直达 full_auto（不入 default）；
 *  - 非 shift+tab（普通 tab / miss shift / ctrl / meta）→ 不消费；
 *  - ctx 缺省（ask/serve 路径）→ 短路 no-op，零回归。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  applyShiftTabModeFlip,
  createPermissionModeContext,
  type PermissionMode,
  type PermissionModeContext,
} from "../../src/harness/permission/modes.js";

function ctxWithMode(initial: PermissionMode): {
  ctx: PermissionModeContext;
  get: () => PermissionMode;
} {
  const mode = createPermissionModeContext(initial);
  return {
    ctx: mode,
    get: () => mode.get(),
  };
}

describe("applyShiftTabModeFlip (REPL Shift+Tab)", () => {
  it("shift+tab: default → full_auto → default", () => {
    const { ctx, get } = ctxWithMode("default");
    const flips: PermissionMode[] = [];
    const onFlip = (next: PermissionMode): void => {
      flips.push(next);
    };

    assert.equal(
      applyShiftTabModeFlip({
        key: { name: "tab", shift: true },
        ctx,
        onFlip,
      }),
      true
    );
    assert.equal(get(), "full_auto");
    assert.deepEqual(flips, ["full_auto"]);

    // 再按 → default
    assert.equal(
      applyShiftTabModeFlip({
        key: { name: "tab", shift: true },
        ctx,
        onFlip,
      }),
      true
    );
    assert.equal(get(), "default");
    assert.deepEqual(flips, ["full_auto", "default"]);
  });

  it("plan → full_auto (jumps straight to go-mode)", () => {
    const { ctx, get } = ctxWithMode("plan");
    applyShiftTabModeFlip({
      key: { name: "tab", shift: true },
      ctx,
      onFlip: () => {},
    });
    assert.equal(get(), "full_auto");
  });

  it("plain tab (no shift) is NOT consumed → no context change", () => {
    const { ctx, get } = ctxWithMode("default");
    const consumed = applyShiftTabModeFlip({
      key: { name: "tab", shift: false },
      ctx,
      onFlip: () => {},
    });
    assert.equal(consumed, false);
    assert.equal(get(), "default");
  });

  it("shift+ctrl+tab is NOT consumed (ctrl guarded)", () => {
    const { ctx, get } = ctxWithMode("default");
    const consumed = applyShiftTabModeFlip({
      key: { name: "tab", shift: true, ctrl: true },
      ctx,
      onFlip: () => {},
    });
    assert.equal(consumed, false);
    assert.equal(get(), "default");
  });

  it("undefined key → not consumed", () => {
    const { ctx, get } = ctxWithMode("default");
    const consumed = applyShiftTabModeFlip({
      key: undefined,
      ctx,
      onFlip: () => {},
    });
    assert.equal(consumed, false);
    assert.equal(get(), "default");
  });

  it("ctx missing (ask/serve path) → no-op, zero regression", () => {
    const flips: PermissionMode[] = [];
    const consumed = applyShiftTabModeFlip({
      key: { name: "tab", shift: true },
      ctx: undefined,
      onFlip: (next) => flips.push(next),
    });
    assert.equal(consumed, false);
    assert.deepEqual(flips, []);
  });
});
