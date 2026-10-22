/**
 * tests/tui/quit-abort.test.ts
 *
 * `/quit` must abort the current foreground turn first, then wait for
 * settle — otherwise a foreground `spawn_subagent(wait:true)` inflight
 * promise would wait out the sub-agent's per-task wall clock (default 7200s)
 * and quit would hang.
 *
 * This test pins the pure helper `abortForegroundTurnOnQuit` (no TUI render):
 * it aborts only the active session's `running-fg` controller; background
 * sessions (`running-bg`) and draft sessions are left alone. The helper uses
 * the single `canInterrupt` predicate (consumed by Ctrl+C / Esc / double-Esc
 * from the same source), so this doubles as the regression anchor for that
 * state-machine invariant.
 *
 * The abort exit path is covered outside this test by
 * `tests/tui/wait-cancel-abort.test.tsx`, which reaches the real manager.waitFor.
 */
import { describe, expect, test } from "bun:test";
import {
  abortForegroundTurnOnQuit,
  abortOwnedWorkOnQuit,
  removeOwnedTurnController,
  trackOwnedTurnController,
} from "../../src/tui/quit-abort.js";
import {
  createDraftSession,
  type TuiSessionState,
} from "../../src/tui/session-state.js";

function session(over: Partial<TuiSessionState>): TuiSessionState {
  return Object.freeze({ ...createDraftSession(), ...over });
}

function lookup(map: Map<string, AbortController>) {
  return { get: (id: string) => map.get(id) };
}

describe("abortForegroundTurnOnQuit（SC12）", () => {
  test("running-fg + controller 在场 → abort 该 controller", () => {
    const controller = new AbortController();
    const aborters = new Map([["conv-1", controller]]);
    expect(controller.signal.aborted).toBe(false);

    const aborted = abortForegroundTurnOnQuit({
      session: session({ conversationId: "conv-1", runState: "running-fg" }),
      aborters: lookup(aborters),
    });

    expect(aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  test("后台会话（running-bg）不动 —— 二次确认分支仍负责等它落盘", () => {
    const controller = new AbortController();
    const aborters = new Map([["conv-bg", controller]]);

    const aborted = abortForegroundTurnOnQuit({
      session: session({ conversationId: "conv-bg", runState: "running-bg" }),
      aborters: lookup(aborters),
    });

    expect(aborted).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  test("idle 会话不动（无前台 turn 可打断）", () => {
    const controller = new AbortController();
    const aborters = new Map([["conv-idle", controller]]);

    expect(
      abortForegroundTurnOnQuit({
        session: session({ conversationId: "conv-idle", runState: "idle" }),
        aborters: lookup(aborters),
      })
    ).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  test("empty: draft（conversationId undefined）→ no-op，不抛错", () => {
    const aborters = new Map<string, AbortController>();
    expect(() =>
      abortForegroundTurnOnQuit({
        session: session({ runState: "running-fg" }),
        aborters: lookup(aborters),
      })
    ).not.toThrow();
    expect(
      abortForegroundTurnOnQuit({
        session: session({ runState: "running-fg" }),
        aborters: lookup(aborters),
      })
    ).toBe(false);
  });

  test("negative: turn 收尾竞态（controller 已摘表）→ no-op，不伪造 controller", () => {
    const aborters = new Map<string, AbortController>();
    expect(
      abortForegroundTurnOnQuit({
        session: session({
          conversationId: "conv-race",
          runState: "running-fg",
        }),
        aborters: lookup(aborters),
      })
    ).toBe(false);
  });

  test("只动当前会话 —— 他会话 controller 不被牵连", () => {
    const active = new AbortController();
    const other = new AbortController();
    const aborters = new Map([
      ["conv-active", active],
      ["conv-other", other],
    ]);

    abortForegroundTurnOnQuit({
      session: session({
        conversationId: "conv-active",
        runState: "running-fg",
      }),
      aborters: lookup(aborters),
    });

    expect(active.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
  });

  test("concurrent: 重复调用幂等（第二次仍返回 true，signal 保持 aborted）", () => {
    const controller = new AbortController();
    const aborters = new Map([["conv-1", controller]]);
    const input = {
      session: session({ conversationId: "conv-1", runState: "running-fg" }),
      aborters: lookup(aborters),
    };

    expect(abortForegroundTurnOnQuit(input)).toBe(true);
    expect(abortForegroundTurnOnQuit(input)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("abortOwnedWorkOnQuit（confirmed TUI process exit）", () => {
  test("中止当前 TUI 的所有 conversation turn 和手工 compaction，重复调用安全", () => {
    const active = new AbortController();
    const switchedBackground = new AbortController();
    const compaction = new AbortController();
    const aborters = new Map([
      ["conv-active", active],
      ["conv-switched", switchedBackground],
    ]);

    abortOwnedWorkOnQuit({ aborters, compaction });
    abortOwnedWorkOnQuit({ aborters, compaction });

    expect(active.signal.aborted).toBe(true);
    expect(switchedBackground.signal.aborted).toBe(true);
    expect(compaction.signal.aborted).toBe(true);
  });

  test("同一会话的重叠 turn 都在当前 TUI 的 abort 集合内", () => {
    const olderTurn = new AbortController();
    const newerTurn = new AbortController();
    const byConversation = new Map<string, AbortController>();
    const owned = new Set<AbortController>();
    trackOwnedTurnController(byConversation, owned, "conv-overlap", olderTurn);
    trackOwnedTurnController(byConversation, owned, "conv-overlap", newerTurn);

    abortOwnedWorkOnQuit({ aborters: owned });

    expect(olderTurn.signal.aborted).toBe(true);
    expect(newerTurn.signal.aborted).toBe(true);
  });

  test("旧 turn finally 不会移除同会话较新的 interrupt controller", () => {
    const olderTurn = new AbortController();
    const newerTurn = new AbortController();
    const byConversation = new Map<string, AbortController>();
    const owned = new Set<AbortController>();
    trackOwnedTurnController(byConversation, owned, "conv-overlap", olderTurn);
    trackOwnedTurnController(byConversation, owned, "conv-overlap", newerTurn);

    removeOwnedTurnController(byConversation, owned, "conv-overlap", olderTurn);

    expect(byConversation.get("conv-overlap")).toBe(newerTurn);
    expect(owned.has(newerTurn)).toBe(true);
    expect(owned.has(olderTurn)).toBe(false);
  });
});
