/**
 * tests/tui/subagent-poll-fingerprint.test.ts
 *
 * 1Hz subagent poll signature SSOT (`subagentFingerprint` in app.tsx).
 * `refreshLiveProjections` skips `setSubagents` when the fingerprint matches
 * the ref, so an unchanged live set no longer drives a whole-tree repaint
 * every second. Pinned here:
 *  - order-independent: the bridge's list can shuffle without changing the
 *    visible set (per-item strings are sorted before joining);
 *  - each rendered field moves the signature: state / taskPreview / endedAt /
 *    title / activity (including its nested tool input) each yield a
 *    different string;
 *  - empty list is stable across calls, so the mount seed and the first poll
 *    tick agree on an idle ask surface (no redundant set on the first tick).
 */
import { describe, expect, test } from "bun:test";
import {
  subagentFingerprint,
  subagentPollSignature,
  subagentPollSignatureIfChanged,
} from "../../src/tui/app.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";

function sub(
  overrides: Partial<SubagentInfo> & { readonly taskId: string }
): SubagentInfo {
  return {
    state: "running",
    taskPreview: "查找文档",
    startedAt: "2026-09-07T12:00:00.000Z",
    ...overrides,
  };
}

describe("subagentFingerprint", () => {
  test("same fields, different order → same string (order-independent)", () => {
    const a = sub({ taskId: "task-a", role: "explore" });
    const b = sub({ taskId: "task-b", role: "general-purpose" });
    expect(subagentFingerprint([a, b])).toBe(subagentFingerprint([b, a]));
  });

  test("state change → different string", () => {
    const running = sub({ taskId: "task-a" });
    const done = sub({ taskId: "task-a", state: "completed" });
    expect(subagentFingerprint([running])).not.toBe(
      subagentFingerprint([done])
    );
  });

  test("taskPreview change → different string", () => {
    const a = sub({ taskId: "task-a", taskPreview: "查找文档" });
    const b = sub({ taskId: "task-a", taskPreview: "查新闻" });
    expect(subagentFingerprint([a])).not.toBe(subagentFingerprint([b]));
  });

  test("title change → different string", () => {
    const a = sub({ taskId: "task-a", title: "写测试" });
    const b = sub({ taskId: "task-a", title: "改文档" });
    expect(subagentFingerprint([a])).not.toBe(subagentFingerprint([b]));
  });

  test("activity change (including nested tool input) → different string", () => {
    const idle = sub({ taskId: "task-a", activity: null });
    const reading = sub({
      taskId: "task-a",
      activity: { toolName: "read_file", toolInput: { path: "a.md" } },
    });
    const otherInput = sub({
      taskId: "task-a",
      activity: { toolName: "read_file", toolInput: { path: "b.md" } },
    });
    expect(subagentFingerprint([idle])).not.toBe(
      subagentFingerprint([reading])
    );
    expect(subagentFingerprint([reading])).not.toBe(
      subagentFingerprint([otherInput])
    );
  });

  test("endedAt change (state held constant) → different string", () => {
    const first = sub({
      taskId: "task-a",
      state: "completed",
      endedAt: "2026-09-07T12:01:00.000Z",
    });
    const second = sub({
      taskId: "task-a",
      state: "completed",
      endedAt: "2026-09-07T12:02:00.000Z",
    });
    expect(subagentFingerprint([first])).not.toBe(
      subagentFingerprint([second])
    );
  });

  test("empty list is stable across calls", () => {
    expect(subagentFingerprint([])).toBe(subagentFingerprint([]));
  });
});

/**
 * The poll gate must not freeze wall-clock-derived text: a live row prints
 * elapsed seconds, and a terminal row stays visible / counted only until its
 * retention window elapses. While any row is clock-sensitive the signature
 * carries the current second; a fully static set keeps one signature and can
 * skip `setSubagents`.
 */
describe("subagentPollSignature（时钟敏感的轮询门控）", () => {
  const NOW = Date.parse("2026-09-07T12:00:10.000Z");

  test("live row: content alone is not enough — each second changes the signature", () => {
    const list = [sub({ taskId: "task-a" })];
    const first = subagentPollSignature(list, NOW);
    expect(subagentPollSignature(list, NOW + 999)).toBe(first);
    expect(subagentPollSignatureIfChanged(first, list, NOW + 999)).toBeNull();
    const next = subagentPollSignature(list, NOW + 1000);
    expect(next).not.toBe(first);
    expect(subagentPollSignatureIfChanged(first, list, NOW + 1000)).toBe(next);
  });

  test("completed after the fade window: content alone gates (static)", () => {
    const list = [
      sub({
        taskId: "task-a",
        state: "completed",
        endedAt: "2026-09-07T12:00:00.000Z", // 10 s before NOW > 5 s
      }),
    ];
    const first = subagentPollSignature(list, NOW);
    expect(subagentPollSignature(list, NOW + 1000)).toBe(first);
    expect(subagentPollSignatureIfChanged(first, list, NOW + 1000)).toBeNull();
  });

  test("completed inside the fade window: ticks, then goes static when it expires", () => {
    const list = [
      sub({
        taskId: "task-a",
        state: "completed",
        endedAt: "2026-09-07T12:00:08.000Z", // 2 s before NOW
      }),
    ];
    const first = subagentPollSignature(list, NOW);
    expect(subagentPollSignature(list, NOW + 1000)).not.toBe(first);
    const lastTick = subagentPollSignature(list, NOW + 3000); // age 5 s
    const expired = subagentPollSignature(list, NOW + 4000); // age 6 s → gone
    expect(expired).not.toBe(lastTick);
    expect(subagentPollSignatureIfChanged(lastTick, list, NOW + 4000)).toBe(
      expired
    );
    expect(subagentPollSignature(list, NOW + 5000)).toBe(expired);
  });

  test("failed inside the 30 s window ticks; past it is static", () => {
    const list = [
      sub({
        taskId: "task-a",
        state: "failed",
        reason: "boom",
        endedAt: "2026-09-07T12:00:00.000Z", // 10 s before NOW
      }),
    ];
    const first = subagentPollSignature(list, NOW);
    expect(subagentPollSignature(list, NOW + 1000)).not.toBe(first);
    const lastTick = subagentPollSignature(list, NOW + 20_000); // age 30 s
    const expired = subagentPollSignature(list, NOW + 21_000); // age 31 s
    expect(expired).not.toBe(lastTick);
    expect(subagentPollSignature(list, NOW + 22_000)).toBe(expired);
  });

  test("empty list is static across seconds", () => {
    const first = subagentPollSignature([], NOW);
    expect(subagentPollSignature([], NOW + 1000)).toBe(first);
    expect(subagentPollSignatureIfChanged(first, [], NOW + 1000)).toBeNull();
  });
});
