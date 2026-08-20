/**
 * serve-workspace T6 — Sidebar 组头"+"按钮的纯逻辑单测 (node + vitest)。
 *
 * 镜像 `tests/web/session-list-group.test.ts` 模式 — 直接 import 纯函数,
 * 不依赖 jsdom / fetch。web 包禁装 vitest (spec A8/A10), 测试由根 vitest
 * 收集。
 *
 * 覆盖:
 * - shouldShowPlusButton: 非 unbound 组 → true; unbound → false; 边界
 *   (active=非 unbound 也 true; active=unbound 也 false)
 * - plusButtonLabel: 文案模板 (`在 <basename> 内新建会话`), 边界 basename
 *   (空 / 含特殊字符 / 长字符串)
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
    // 边界: 理论上 unbound 组不可能 isActive (无 workspaceRoot 不会匹配
    // currentConversationId 的命中模式), 但 shouldShowPlusButton 应只信
    // isUnbound 一票, 不被 isActive 影响。
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
    // 该函数不感知 isUnbound — 调用方负责传过滤后的 group.label。
    // 测试模板本身对任意 label 都稳定。
    assert.equal(plusButtonLabel("(未绑定)"), "在 (未绑定) 内新建会话");
  });

  it("空 label → 渲染 '在  内新建会话' (中间双空格; 防御性, 调用方不应传空)", () => {
    // 不做 trim, 避免吞掉 group.label 内部的合法前后空格(罕见但宽容)。
    assert.equal(plusButtonLabel(""), "在  内新建会话");
  });

  it("长 label + 含特殊字符 (/) → 完整保留", () => {
    assert.equal(
      plusButtonLabel("feat/sidebar-plus"),
      "在 feat/sidebar-plus 内新建会话"
    );
  });
});
