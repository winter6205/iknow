/**
 * tests/cli/chat-mode-shift-tab.test.ts
 *
 * Standalone unit test for the REPL Shift+Tab permission-mode flip: no real
 * TTY needed, since runChatSession's keypress listener delegates to
 * applyShiftTabModeFlip.
 *
 * Boundaries covered:
 *  - shift+tab cycles default → full_auto → default;
 *  - shift+tab from plan jumps straight to full_auto (skips default);
 *  - non-shift+tab (plain tab / missing shift / ctrl / meta) is not consumed;
 *  - absent ctx (ask/serve path) short-circuits to a no-op, zero regression.
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

    // second press → default
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
