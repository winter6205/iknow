/**
 * tests/tui/quit-abort.test.ts
 *
 * SC12（`specs/agent-control-surface.md` Slice D）/ plan task 7：`/quit` 必须
 * 先 abort 当前前台 turn，再等收尾 —— 否则前景 `spawn_subagent(wait:true)`
 * 的 inflight promise 会一直等到子代理 per-task 墙钟（缺省 7200s），退出挂起。
 *
 * 本测钉纯助手 `abortForegroundTurnOnQuit`（不渲染 TUI）：只 abort 活跃会话
 * 的 `running-fg` controller；后台会话（`running-bg`）与 draft 会话不动。
 * 助手内用的是 `canInterrupt` 单一判据（Ctrl+C / Esc / 双 Esc 同源消费），
 * 所以这里同时是那条状态机不变式的回归锚点。
 *
 * abort 出口链路（R2 票面已核实）在本测之外由
 * `tests/tui/wait-cancel-abort.test.tsx` 走到真实 manager.waitFor。
 */
import { describe, expect, test } from "bun:test";
import { abortForegroundTurnOnQuit } from "../../src/tui/quit-abort.js";
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
