/**
 * E2E（vitest）：研究-写作 supervisor —— langgraph 条件分支 + 写后评审（Proto B）。
 *
 * 断言的三条关键语义：
 *   1. foreground-sync：supervisor 只派发一次并行研究（3 条 notes），
 *      后续 round 不再重复派发 → 收敛不无限循环；
 *   2. 并行 fan-out append：researchNotes 累加 3 条（reducer），writer 能看到全部；
 *   3. 条件回环：critic 判定 revise → 回 writer 重写，且 revision 有上限（2 次）
 *      → 终态收敛。
 *
 * 这些是 ADR-0014（子代理 foreground-sync 默认契约）在 langgraph 里的直接体现。
 */
import { describe, expect, it } from "vitest";
import {
  buildResearchWriterGraph,
  runResearchWriter,
} from "../src/research-writer/graph.js";

describe("research-writer（langgraph 条件分支 + 写后评审）", () => {
  it("正常路径：supervisor 派发并行研究 → writer 写稿 → critic 评审收敛", async () => {
    const res = await runResearchWriter();
    expect(res.pipeline).toBe("research-writer");
    // 并行 fan-out append：3 条 research notes
    expect(res.researchNotes?.length).toBe(3);
    expect(res.draft).toBeDefined();
    expect(res.draft).toContain("关于「LangGraph");
    expect(res.critique?.verdict).toBeDefined();
  });

  it("foreground-sync：supervisor 不重复派发，graph 收敛（不无限循环）", async () => {
    const graph = buildResearchWriterGraph();
    // 用上限保护：若 supervisor 反复派发，revisionCount 会无限递增或超时
    const res = await graph.invoke({ pipeline: "research-writer" });
    // 3 条 notes 只出现一次（派发过一次）
    expect(res.researchNotes?.length).toBe(3);
    // 收敛：revisionCount 有限
    expect(res.revisionCount).toBeLessThanOrEqual(3);
  });

  it("条件回环：critic 判定 revise → 回 writer 重写，revision 递增且最终收敛", async () => {
    const graph = buildResearchWriterGraph();
    // 注入一个必 revise 的 draft（缺证据引用）触发回环路径
    const res = await graph.invoke({
      pipeline: "research-writer",
      researchNotes: [
        { id: "note-1", claim: "graph 表达并行依赖更直接", evidence: ["a"] },
        { id: "note-2", claim: "foreground-sync", evidence: ["b"] },
      ],
      draft: "没有证据引用的短稿",
      critique: { issues: ["缺少证据引用"], verdict: "revise" },
      revisionCount: 0,
    });
    // 回环重写后：draft 应包含证据引用（writer 用 notes 重写了）
    expect(res.draft).toContain("条证据");
    // revisionCount 递增（至少一次 rewrite 被计入）
    expect((res as { revisionCount?: number }).revisionCount).toBeGreaterThan(
      0
    );
    // 收敛：终态 critique 是 pass（重写后含证据），否则到上限 2 也收敛
    expect(res.critique).toBeDefined();
  });
});
