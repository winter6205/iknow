/**
 * Pure-logic unit tests for the "+" button on sidebar group headers (node + vitest).
 *
 * Mirrors the `tests/web/session-list-group.test.ts` pattern — import pure
 * functions directly, no jsdom / fetch. The web package may not install vitest,
 * so the root vitest collects these tests.
 *
 * Coverage:
 * - shouldShowPlusButton: non-unbound group → true; unbound → false; boundary
 *   (isActive never matters)
 * - plusButtonLabel: label template (`在 <basename> 内新建会话`, "new session in <basename>"),
 *   basename boundaries (empty / special chars / long string)
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  plusButtonLabel,
  shouldShowPlusButton,
} from "../../web/src/lib/sidebar-plus.ts";
import type { WorkspaceGroup } from "../../web/src/lib/session-list.ts";

function group(over: Partial<WorkspaceGroup>): WorkspaceGroup {
  return {
    key: "/r/a",
    label: "a",
    sessions: [],
    latestUpdatedAt: "",
    isActive: false,
    isUnbound: false,
    ...over,
  };
}

describe("shouldShowPlusButton", () => {
  it("bound 组 (isUnbound=false) → true", () => {
    assert.equal(
      shouldShowPlusButton(group({ isUnbound: false, label: "proj" })),
      true
    );
  });

  it("(未绑定) 组 (isUnbound=true) → false (隐藏 + 按钮)", () => {
    assert.equal(
      shouldShowPlusButton(group({ isUnbound: true, label: "(未绑定)" })),
      false
    );
  });

  it("active + bound 组 → true (活跃组也可以快速新建同根会话)", () => {
    assert.equal(
      shouldShowPlusButton(
        group({ isActive: true, isUnbound: false, label: "current" })
      ),
      true
    );
  });

  it("active + unbound → false (active 救不了 unbound, sentinel 组一律无 +)", () => {
    // Boundary: an unbound group theoretically cannot be isActive (without
    // workspaceRoot it never matches the currentConversationId hit pattern),
    // but shouldShowPlusButton must trust isUnbound only, unaffected by isActive.
    assert.equal(
      shouldShowPlusButton(
        group({ isActive: true, isUnbound: true, label: "(未绑定)" })
      ),
      false
    );
  });
});

describe("plusButtonLabel", () => {
  it("典型 basename → '在 <name> 内新建会话'", () => {
    assert.equal(plusButtonLabel("iknow"), "在 iknow 内新建会话");
  });

  it("(未绑定) 组的 label 也会原样套模板 (调用方应先 shouldShowPlusButton 过滤)", () => {
    // The function is unaware of isUnbound — the caller must pass a filtered group.label.
    // The template itself is stable for any label.
    assert.equal(plusButtonLabel("(未绑定)"), "在 (未绑定) 内新建会话");
  });

  it("空 label → 渲染 '在  内新建会话' (中间双空格; 防御性, 调用方不应传空)", () => {
    // No trim, to avoid swallowing legitimate surrounding spaces in group.label (rare but lenient).
    assert.equal(plusButtonLabel(""), "在  内新建会话");
  });

  it("长 label + 含特殊字符 (/) → 完整保留", () => {
    assert.equal(
      plusButtonLabel("feat/sidebar-plus"),
      "在 feat/sidebar-plus 内新建会话"
    );
  });
});
