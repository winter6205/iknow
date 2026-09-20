/**
 * Pure-logic unit tests for the sidebar's per-workspace grouping (node + vitest).
 *
 * Mirrors `tests/web/session-info.test.ts` (import pure functions directly, no
 * jsdom / fetch). The web package may not install vitest, so the root vitest
 * collects these tests.
 *
 * Covers grouping (key + label + count), active-group pinning, unbound forced
 * last, latest-desc ordering inside and across groups, and boundaries (empty /
 * all unbound / all bound / missing fields).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  groupSessionsByWorkspace,
  type WorkspaceGroup,
} from "../../web/src/lib/session-list.ts";
import type { SessionListItem } from "../../web/src/api/types.ts";

function item(opts: {
  readonly id: string;
  readonly updatedAt: string;
  readonly workspaceRoot?: string;
}): SessionListItem {
  return {
    conversation_id: opts.id,
    updatedAt: opts.updatedAt,
    lastFinalText: "",
    title: "",
    workspaceRoot: opts.workspaceRoot,
  };
}

function asGroups(g: readonly WorkspaceGroup[]): Array<{
  key: string;
  label: string;
  count: number;
  isActive: boolean;
  isUnbound: boolean;
  ids: string[];
}> {
  return g.map((grp) => ({
    key: grp.key,
    label: grp.label,
    count: grp.sessions.length,
    isActive: grp.isActive,
    isUnbound: grp.isUnbound,
    ids: grp.sessions.map((s) => s.conversation_id),
  }));
}

describe("groupSessionsByWorkspace — 基本分组", () => {
  it("按 workspaceRoot 折叠成同一组, key = workspaceRoot", () => {
    const sessions = [
      item({
        id: "a",
        updatedAt: "2026-07-30T12:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "b",
        updatedAt: "2026-07-30T10:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "c",
        updatedAt: "2026-07-30T08:00:00.000Z",
        workspaceRoot: "/r/b",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    // two groups: with active=null, order only by latest in-group updatedAt desc
    const keys = groups.map((g) => g.key).sort();
    assert.deepEqual(keys, ["/r/a", "/r/b"]);
    // no unbound group unless some sessions lack workspaceRoot
    assert.equal(
      groups.find((g) => g.key === "(未绑定)"),
      undefined
    );
  });

  it("缺 workspaceRoot 字段 → 进 '(未绑定)' 组, key 为 '(未绑定)'", () => {
    const sessions = [
      item({ id: "old1", updatedAt: "2026-07-30T01:00:00.000Z" }),
      item({ id: "old2", updatedAt: "2026-07-30T02:00:00.000Z" }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.key, "(未绑定)");
    assert.equal(groups[0]?.isUnbound, true);
  });

  it("label = basename(root), '/r/a' → 'a'", () => {
    const sessions = [
      item({
        id: "x",
        updatedAt: "2026-07-30T12:00:00.000Z",
        workspaceRoot: "/home/winner/projects/iknow",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups[0]?.label, "iknow");
  });

  it("(未绑定) 组 label 固定为 '(未绑定)'", () => {
    const sessions = [item({ id: "u", updatedAt: "2026-07-30T01:00:00.000Z" })];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups[0]?.label, "(未绑定)");
  });

  it("组头计数 = sessions.length (label 之外的数字)", () => {
    const sessions = [
      item({
        id: "1",
        updatedAt: "2026-07-30T03:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "2",
        updatedAt: "2026-07-30T02:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "3",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.sessions.length, 3);
  });
});

describe("groupSessionsByWorkspace — 排序 (AC #2)", () => {
  it("活跃组置顶", () => {
    const sessions = [
      item({
        id: "a-old",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "b-new",
        updatedAt: "2026-07-30T05:00:00.000Z",
        workspaceRoot: "/r/b",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, "b-new");
    // active group (/r/b) pinned first; the other ordered by latest updatedAt desc
    assert.equal(groups[0]?.key, "/r/b");
    assert.equal(groups[0]?.isActive, true);
  });

  it("活跃组在多组中不论最新与否都置顶", () => {
    // the active group is the older one; the other group has newer sessions
    const sessions = [
      item({
        id: "old",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/older",
      }),
      item({
        id: "new1",
        updatedAt: "2026-07-30T05:00:00.000Z",
        workspaceRoot: "/r/newer",
      }),
      item({
        id: "new2",
        updatedAt: "2026-07-30T06:00:00.000Z",
        workspaceRoot: "/r/newer",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, "old");
    assert.equal(groups[0]?.key, "/r/older"); // active group pinned first
    assert.equal(groups[0]?.isActive, true);
    assert.equal(groups[1]?.key, "/r/newer"); // others sorted by latest desc
  });

  it("(未绑定) 组固定末尾, 即便其最新", () => {
    const sessions = [
      item({ id: "u", updatedAt: "2026-07-30T05:00:00.000Z" }), // unbound
      item({
        id: "b1",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/b",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    // no active session → latest-desc ordering, but unbound is forced last
    assert.equal(groups[groups.length - 1]?.key, "(未绑定)");
  });

  it("(未绑定) 组在有活跃会话时也固定末尾", () => {
    const sessions = [
      item({
        id: "active",
        updatedAt: "2026-07-30T05:00:00.000Z",
        workspaceRoot: "/r/active",
      }),
      item({ id: "u1", updatedAt: "2026-07-30T06:00:00.000Z" }),
      item({ id: "u2", updatedAt: "2026-07-30T04:00:00.000Z" }),
    ];
    const groups = groupSessionsByWorkspace(sessions, "active");
    assert.equal(groups[0]?.key, "/r/active"); // active pinned first
    assert.equal(groups[groups.length - 1]?.key, "(未绑定)"); // unbound last
  });

  it("其余组按组内最新 updatedAt 倒序", () => {
    const sessions = [
      item({
        id: "mid",
        updatedAt: "2026-07-30T03:00:00.000Z",
        workspaceRoot: "/r/mid",
      }),
      item({
        id: "newer",
        updatedAt: "2026-07-30T05:00:00.000Z",
        workspaceRoot: "/r/newer",
      }),
      item({
        id: "newer2",
        updatedAt: "2026-07-30T05:30:00.000Z",
        workspaceRoot: "/r/newer",
      }),
      item({
        id: "older",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/older",
      }),
      item({
        id: "active",
        updatedAt: "2026-07-30T02:00:00.000Z",
        workspaceRoot: "/r/active",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, "active");
    // /r/active on top (active); then /r/newer (latest 05:30), /r/mid, /r/older
    assert.deepEqual(
      groups.map((g) => g.key),
      ["/r/active", "/r/newer", "/r/mid", "/r/older"]
    );
  });

  it("活跃组的 session 在 currentBoundRoot 不匹配时也置顶 — '找得到当前会话'优先", () => {
    // Current session "missing" is in /r/a, even though /r/b has newer sessions.
    // The active group must not sink: currentConversationId alone decides isActive.
    // (currentBoundRoot was later removed as a param — it never affected ordering.)
    const sessions = [
      item({
        id: "missing",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "b1",
        updatedAt: "2026-07-30T05:00:00.000Z",
        workspaceRoot: "/r/b",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, "missing");
    assert.equal(groups[0]?.key, "/r/a"); // active pinned first
    assert.equal(groups[0]?.isActive, true);
  });
});

describe("groupSessionsByWorkspace — isActive / isUnbound 标志", () => {
  it("仅当 currentConversationId 在该组内时 isActive=true", () => {
    const sessions = [
      item({
        id: "a1",
        updatedAt: "2026-07-30T02:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "b1",
        updatedAt: "2026-07-30T03:00:00.000Z",
        workspaceRoot: "/r/b",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, "b1");
    const a = groups.find((g) => g.key === "/r/a");
    const b = groups.find((g) => g.key === "/r/b");
    assert.equal(a?.isActive, false);
    assert.equal(b?.isActive, true);
  });

  it("currentConversationId 缺席 → 没有组 isActive=true", () => {
    const sessions = [
      item({
        id: "a1",
        updatedAt: "2026-07-30T02:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups[0]?.isActive, false);
  });

  it("(未绑定) 组的 isUnbound=true, 其他组 false", () => {
    const sessions = [
      item({ id: "u", updatedAt: "2026-07-30T02:00:00.000Z" }),
      item({
        id: "a",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    const u = groups.find((g) => g.key === "(未绑定)");
    const a = groups.find((g) => g.key === "/r/a");
    assert.equal(u?.isUnbound, true);
    assert.equal(a?.isUnbound, false);
  });
});

describe("groupSessionsByWorkspace — 组内排序 (AC #5)", () => {
  it("同组内 session 仍按 sortSessionsByUpdatedDesc (新到旧)", () => {
    const sessions = [
      item({
        id: "old",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "new",
        updatedAt: "2026-07-30T05:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "mid",
        updatedAt: "2026-07-30T03:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    const a = groups.find((g) => g.key === "/r/a");
    assert.deepEqual(
      a?.sessions.map((s) => s.conversation_id),
      ["new", "mid", "old"]
    );
  });
});

describe("groupSessionsByWorkspace — latestUpdatedAt", () => {
  it("组的 latestUpdatedAt = 该组最新一条 session 的 updatedAt", () => {
    const sessions = [
      item({
        id: "old",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "new",
        updatedAt: "2026-07-30T05:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups[0]?.latestUpdatedAt, "2026-07-30T05:00:00.000Z");
  });
});

describe("groupSessionsByWorkspace — 边界", () => {
  it("空 sessions → 空数组", () => {
    assert.deepEqual(groupSessionsByWorkspace([], null), []);
  });

  it("全 unbound → 单组 '(未绑定)'", () => {
    const sessions = [
      item({ id: "u1", updatedAt: "2026-07-30T02:00:00.000Z" }),
      item({ id: "u2", updatedAt: "2026-07-30T01:00:00.000Z" }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    const simplified = asGroups(groups);
    assert.deepEqual(simplified, [
      {
        key: "(未绑定)",
        label: "(未绑定)",
        count: 2,
        isActive: false,
        isUnbound: true,
        ids: ["u1", "u2"],
      },
    ]);
  });

  it("混合 bound + unbound → unbound 在末 (无活跃会话时)", () => {
    const sessions = [
      item({
        id: "b",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/b",
      }),
      item({ id: "u", updatedAt: "2026-07-30T05:00:00.000Z" }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.key, "/r/b");
    assert.equal(groups[1]?.key, "(未绑定)");
  });

  it("不修改输入数组 (纯函数)", () => {
    const sessions = [
      item({
        id: "a",
        updatedAt: "2026-07-30T01:00:00.000Z",
        workspaceRoot: "/r/a",
      }),
      item({
        id: "b",
        updatedAt: "2026-07-30T02:00:00.000Z",
        workspaceRoot: "/r/b",
      }),
    ];
    const beforeIds = sessions.map((s) => s.conversation_id);
    groupSessionsByWorkspace(sessions, null);
    assert.deepEqual(
      sessions.map((s) => s.conversation_id),
      beforeIds
    );
  });

  it("缺字段的 session 与绑定的 session 不会混进同一组", () => {
    const sessions = [
      item({ id: "x", updatedAt: "2026-07-30T02:00:00.000Z" }),
      item({
        id: "y",
        updatedAt: "2026-07-30T03:00:00.000Z",
        workspaceRoot: "/r/y",
      }),
    ];
    const groups = groupSessionsByWorkspace(sessions, null);
    assert.equal(groups.length, 2);
    assert.equal(groups.find((g) => g.key === "(未绑定)")?.sessions.length, 1);
    assert.equal(groups.find((g) => g.key === "/r/y")?.sessions.length, 1);
  });
});
