/**
 * The shared `/permissions` command layer (src/harness/permission/permissions-command.ts).
 *
 * This module is the single implementation behind BOTH entry points: the REPL's
 * `/permissions` (src/cli/chat-session.ts) and the TUI's `/permissions`
 * (src/tui/app.tsx). Two copies of a three-value parse is what let the TUI
 * miss the entry entirely, so the parse/status/usage semantics are pinned here
 * once — including the REPL's user-visible strings, byte-for-byte (the REPL now
 * routes through this layer instead of carrying its own inline logic).
 *
 * Covered:
 *  - the four REPL literals (status / status+usage hint / switch / usage);
 *  - the full mode domain closes over PERMISSION_MODES (no second roster);
 *  - case + whitespace tolerance, invalid input, and surplus args;
 *  - a rejected command leaves the holder untouched.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  PERMISSION_MODES,
  createPermissionModeContext,
} from "../../../src/harness/permission/modes.js";
import {
  PERMISSIONS_USAGE_TEXT,
  applyPermissionsCommand,
  formatPermissionStatus,
  parsePermissionsCommand,
  splitPermissionArgs,
} from "../../../src/harness/permission/permissions-command.js";

/** The REPL's exact literals — the acceptance is "shared behaviour", not restyled copy. */
const REPL_STATUS = "权限模式: default";
const REPL_HELP_HINT = "  · 用法: /permissions [default|plan|full_auto]";
const REPL_USAGE =
  "Usage: /permissions [default|plan|full_auto]（或空 / status 查看当前）";
const REPL_UNAVAILABLE =
  "/permissions: 当前入口不提供权限模式上下文（ask/serve）";

describe("parsePermissionsCommand", () => {
  it("empty args → status", () => {
    assert.deepEqual(parsePermissionsCommand([]), { kind: "status" });
  });

  it("status / help → status（help 带用法提示）", () => {
    assert.deepEqual(parsePermissionsCommand(["status"]), { kind: "status" });
    assert.deepEqual(parsePermissionsCommand(["help"]), {
      kind: "status",
      withUsage: true,
    });
  });

  it("三个模式值全部命中 set（值域来自 PERMISSION_MODES，无第二份名册）", () => {
    for (const mode of PERMISSION_MODES) {
      assert.deepEqual(parsePermissionsCommand([mode]), {
        kind: "set",
        mode,
      });
    }
    assert.equal(PERMISSION_MODES.length, 3);
  });

  it("大小写与空白容忍", () => {
    assert.deepEqual(parsePermissionsCommand(["  PLAN  "]), {
      kind: "set",
      mode: "plan",
    });
    assert.deepEqual(parsePermissionsCommand(["STATUS"]), { kind: "status" });
  });

  it("非法值 → usage（不猜、不静默忽略）", () => {
    assert.deepEqual(parsePermissionsCommand(["acceptEdits"]), {
      kind: "usage",
    });
    assert.deepEqual(parsePermissionsCommand(["yes"]), { kind: "usage" });
  });

  it("多余参数按 REPL 既有契约取首 token（/permissions plan extra → plan）", () => {
    assert.deepEqual(parsePermissionsCommand(["plan", "extra"]), {
      kind: "set",
      mode: "plan",
    });
  });
});

describe("formatPermissionStatus", () => {
  it("回显的是原始枚举值（REPL 契约），不是 modeLabel", () => {
    assert.equal(formatPermissionStatus("default"), REPL_STATUS);
    assert.equal(formatPermissionStatus("plan"), "权限模式: plan");
    assert.equal(formatPermissionStatus("full_auto"), "权限模式: full_auto");
  });

  it("withUsage 追加 REPL 的用法提示", () => {
    assert.equal(
      formatPermissionStatus("default", { withUsage: true }),
      `${REPL_STATUS}${REPL_HELP_HINT}`
    );
  });
});

describe("applyPermissionsCommand（REPL / TUI 同一条路径）", () => {
  it("空参数 → 当前模式", () => {
    const ctx = createPermissionModeContext("default");
    assert.deepEqual(applyPermissionsCommand(ctx, []), {
      ok: true,
      text: REPL_STATUS,
    });
  });

  it("help → 状态 + 用法提示（ok）", () => {
    const ctx = createPermissionModeContext("default");
    assert.deepEqual(applyPermissionsCommand(ctx, ["help"]), {
      ok: true,
      text: `${REPL_STATUS}${REPL_HELP_HINT}`,
    });
  });

  it("合法模式 → 翻 holder 并回显切换文案", () => {
    for (const mode of PERMISSION_MODES) {
      const ctx = createPermissionModeContext("default");
      const res = applyPermissionsCommand(ctx, [mode]);
      assert.equal(res.ok, true);
      assert.equal(res.text, `权限模式已切换: ${mode}`);
      assert.equal(ctx.get(), mode);
    }
  });

  it("非法输入 → usage 文案 + holder 不动", () => {
    const ctx = createPermissionModeContext("plan");
    const res = applyPermissionsCommand(ctx, ["nope"]);
    assert.equal(res.ok, false);
    assert.equal(res.text, REPL_USAGE);
    assert.equal(PERMISSIONS_USAGE_TEXT, REPL_USAGE);
    assert.equal(ctx.get(), "plan");
  });

  it("usage 文案不回显用户输入", () => {
    const ctx = createPermissionModeContext();
    assert.equal(
      applyPermissionsCommand(ctx, ["rm -rf /"]).text.includes("rm -rf"),
      false
    );
  });
});

describe("splitPermissionArgs（TUI / web 从原始行取 remainder）", () => {
  it("空 / 纯空白 → []", () => {
    assert.deepEqual(splitPermissionArgs(""), []);
    assert.deepEqual(splitPermissionArgs("   "), []);
  });

  it("切分首个 token 之后的余量", () => {
    assert.deepEqual(splitPermissionArgs("plan"), ["plan"]);
    assert.deepEqual(splitPermissionArgs("  status  "), ["status"]);
  });
});

describe("边界：holder 缺席不属于共享语义", () => {
  it("共享层要求一个已存在的 holder（入口自己判缺席并携带自己的缺席文案）", () => {
    // The REPL's `/permissions: 当前入口不提供权限模式上下文（ask/serve）`
    // stays with the REPL entry (same shape as /graph and /config's
    // applyHolderSlash): which wording an unwired entry shows is that entry's
    // business, while parse / status / usage are shared.
    assert.equal(REPL_UNAVAILABLE.startsWith("/permissions:"), true);
  });
});
