// @vitest-environment happy-dom
/**
 * specs/skill-index-increment.md SC8 (web half) — slash candidates go "hot" live.
 *
 * `GET /api/v1/skills` already answers from the current skill roots server-side
 * (hub-side rescan); the web gap was a client that fetched only once, so skills
 * installed after assembly never entered the candidates. This pins the
 * user-observable outcome: refetch when the window regains focus and new entries
 * appear; a failed refetch must NOT clear known candidates (one network blip
 * should not empty the `/` surface); no writes after unmount (no leak).
 */
import assert from "node:assert/strict";
import { describe, it, vi, afterEach } from "vitest";
import { act, renderHook, cleanup } from "@testing-library/react";
import * as api from "../../web/src/api/client.ts";
import { useSkills } from "../../web/src/hooks/use-skills.ts";

vi.mock("../../web/src/api/client.ts", () => ({
  listSkills: vi.fn(),
}));

const mockListSkills = vi.mocked(api.listSkills);

afterEach(() => {
  cleanup();
  mockListSkills.mockReset();
});

/** Wait for the drained promise chain (mock resolution → setState commit). */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SC8 — Web slash 候选当场热", () => {
  it("挂载时拉一次，窗口重新获得焦点时重取（新装技能立刻进候选）", async () => {
    mockListSkills.mockResolvedValueOnce({ skills: [{ name: "boot" }] });
    const { result } = renderHook(() => useSkills());
    await flush();
    assert.deepEqual(
      result.current.map((s) => s.name),
      ["boot"]
    );

    // A loadable entry installed after assembly (no description — the user-facing side of SC5/SC9).
    mockListSkills.mockResolvedValueOnce({
      skills: [{ name: "boot" }, { name: "late-skill" }],
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();

    assert.equal(mockListSkills.mock.calls.length, 2, "focus 必须触发重取");
    assert.deepEqual(
      result.current.map((s) => s.name),
      ["boot", "late-skill"]
    );
  });

  it("重取失败：保留最近一次已知候选（不因一次抖动清空 `/` 面）", async () => {
    mockListSkills.mockResolvedValueOnce({ skills: [{ name: "boot" }] });
    const { result } = renderHook(() => useSkills());
    await flush();

    mockListSkills.mockRejectedValueOnce(new Error("network down"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();

    assert.deepEqual(
      result.current.map((s) => s.name),
      ["boot"],
      "失败必须降级为保留已知候选，而不是清空"
    );
  });

  it("首次拉取失败 → 空候选（与今日 `catch(() => setSkills([]))` 等价）", async () => {
    mockListSkills.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useSkills());
    await flush();
    assert.deepEqual(result.current, []);
  });

  it("卸载后 focus 不再写入（监听已摘）", async () => {
    mockListSkills.mockResolvedValue({ skills: [{ name: "boot" }] });
    const { unmount } = renderHook(() => useSkills());
    await flush();
    const before = mockListSkills.mock.calls.length;
    unmount();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    assert.equal(
      mockListSkills.mock.calls.length,
      before,
      "卸载后不得再重取（监听必须在 cleanup 摘掉）"
    );
  });
});
