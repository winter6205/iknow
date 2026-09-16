// ARCHIVED (2026-09-15, T7 specs/tui-activity-block.md Superseded)：本文件认证的旧合同 = live activity group + unit fold 双时态；该不变式已随活动块单时态（deriveActivityBlocks 单源）永久消失，替代覆盖见 tests/tui/{activity-block,t4-thinking-only-live-then-fold,t5-quiet-tools-body-slot,t6-text-splits-weld}.test.*。

/**
 * Archived 2026-09-15 (plans/tui-activity-block.md T7): T7 退役过程块 spec 旧
 * 「unit fold + live activity group 双时态」 —— `src/tui/live-activity-group.ts`
 * 已删除，`formatLiveActivitySummary` / `splitLiveActivityRuns` /
 * `liveActivityVerbOf` / `isLiveActivityGroupRun` 不再被生产代码调用。过程块
 * spec 重新锚定：进行中收类与 keep / bash 都走 `deriveActivityBlocks`
 * → unanchored blocks（同 messageIndex 落 tail 标题）；同批 retract 只在块
 * called 计数出现一次（spec S7），不再画 `Listing × N · Running N shell
 * commands` 一行英文摘要。新的活动块派生覆盖在本目录 `t5-*.test.tsx` /
 * `activity-block.test.ts` / `chat-view-thinking-tool-fold.test.tsx`。
 *
 * ── original header ──────────────────────────────────────────────────────
 * tests/tui/live-activity-group.test.ts
 *
 * 不变式(docs/CONTEXT.md live activity group + specs/tui-tool-settled-appearance.md D9):
 * 进行中的收类工具**不逐条刷标题**,收成一行英文摘要(Listing / Reading /
 * Searching 三个动词桶聚合);>=2 条非失败 bash 追加 `Running N shell commands`
 * 段(单条 bash 不聚合,自己就是那张卡片);细节槽至多一条(组内最后一条
 * running 件,无 running 时 = 最后一条聚合 bash);keep / accent / 失败件仍
 * 逐条留标题(failure overlay 不进过程组计数,失败 bash 不聚合)。
 *
 * 5 类边界:empty(空 runs → summary null)/ negative(keep 与失败件不进组)/
 * overflow(多条收类仍一行)/ concurrent(纯函数稳定)/ exception(未注册名缺省
 * 仍归一个桶,不静默丢件)。
 */
import { describe, expect, test } from "bun:test";
import {
  formatLiveActivitySummary,
  liveActivityVerbOf,
  splitLiveActivityRuns,
} from "../../src/tui/live-activity-group.js";
import type { LiveToolRun } from "../../src/tui/live-tool-state.js";

function run(
  name: string,
  status: LiveToolRun["status"],
  id: string = `tu-${name}-${status}`
): LiveToolRun {
  return { id, name, status, input: {} };
}

describe("liveActivityVerbOf（动词桶）", () => {
  test("读取族 → Reading；搜索族 → Searching；列举族 → Listing", () => {
    expect(liveActivityVerbOf("read_file")).toBe("Reading");
    expect(liveActivityVerbOf("read_mcp_resource")).toBe("Reading");
    expect(liveActivityVerbOf("grep")).toBe("Searching");
    expect(liveActivityVerbOf("web_search")).toBe("Searching");
    expect(liveActivityVerbOf("lsp_definition")).toBe("Searching");
    expect(liveActivityVerbOf("glob")).toBe("Listing");
    expect(liveActivityVerbOf("list-worktrees")).toBe("Listing");
  });

  test("exception:未注册名仍落一个桶（收类缺省 retract，不静默丢件）", () => {
    // 具体桶对未注册名不是合同（CONTEXT 只钉「缺省也是收」），钉的是
    // 「必有桶、且稳定」—— 掉出三桶等于该件在过程组里消失。
    const verbs = ["Listing", "Reading", "Searching"] as const;
    for (const name of ["brand_new_query_tool", "brand_new_thing"]) {
      expect(verbs).toContain(liveActivityVerbOf(name));
      expect(liveActivityVerbOf(name)).toBe(liveActivityVerbOf(name));
    }
  });
});

describe("formatLiveActivitySummary（一行摘要）", () => {
  test("empty:空 runs → null（不画空行）", () => {
    expect(formatLiveActivitySummary([])).toBeNull();
  });

  test("negative:keep / accent / 失败件不进摘要", () => {
    expect(
      formatLiveActivitySummary([
        run("bash", "ok"),
        run("write_file", "ok"),
        run("skill", "ok"),
        run("read_file", "failed"),
      ])
    ).toBeNull();
  });

  test("overflow:多条收类按桶聚合成一行（逐名不刷屏）", () => {
    const summary = formatLiveActivitySummary([
      run("read_file", "ok", "r1"),
      run("grep", "running", "g1"),
      run("read_file", "ok", "r2"),
      run("glob", "ok", "l1"),
      run("read_file", "running", "r3"),
    ]);
    // 桶顺序固定 Listing → Reading → Searching，与插入顺序无关。
    expect(summary).toBe("Listing × 1 · Reading × 3 · Searching × 1");
    expect(summary).not.toContain("read_file");
  });

  test("concurrent:同输入多次调用结果一致（纯函数稳定）", () => {
    const runs = [run("read_file", "ok", "r1"), run("grep", "ok", "g1")];
    expect(formatLiveActivitySummary(runs)).toBe(
      formatLiveActivitySummary(runs)
    );
  });

  test("exception:running 与完成态同桶相加（进行中不换成过去时）", () => {
    expect(
      formatLiveActivitySummary([
        run("read_file", "running", "r1"),
        run("read_file", "ok", "r2"),
      ])
    ).toBe("Reading × 2");
  });

  test("bash 聚合：>=2 条非失败 bash -> `Running N shell commands`（复数）", () => {
    expect(
      formatLiveActivitySummary([
        run("bash", "ok", "b1"),
        run("bash", "running", "b2"),
      ])
    ).toBe("Running 2 shell commands");
  });

  test("bash 单条：不追加聚合段（单条 keep bash 自己就是细节槽卡片）", () => {
    expect(formatLiveActivitySummary([run("bash", "ok", "b1")])).toBeNull();
    expect(
      formatLiveActivitySummary([
        run("bash", "running", "b1"),
        run("read_file", "ok", "r1"),
      ])
    ).toBe("Reading × 1");
  });

  test("bash + 收类：桶段在前、bash 段接后（3 bash + 1 read_file）", () => {
    expect(
      formatLiveActivitySummary([
        run("read_file", "ok", "r1"),
        run("bash", "ok", "b1"),
        run("bash", "ok", "b2"),
        run("bash", "ok", "b3"),
      ])
    ).toBe("Reading × 1 · Running 3 shell commands");
  });

  test("negative:失败 bash 不进聚合计数（D5 failure overlay 自留卡片）", () => {
    expect(
      formatLiveActivitySummary([
        run("bash", "failed", "b1"),
        run("bash", "ok", "b2"),
      ])
    ).toBeNull();
  });
});

describe("splitLiveActivityRuns（组 / 逐条面 / 细节槽）", () => {
  /** running 面（过程组 chrome 生效）的拆分包 —— 本 describe 其余用例的默认面。 */
  function splitRunning(runs: ReadonlyArray<LiveToolRun>) {
    return splitLiveActivityRuns(runs, { running: true });
  }

  test("idle:聚合停摆 —— keep 件回逐条面（卡不得被静默吞掉）", () => {
    // 不变式（CONTEXT `live activity group`「idle 仍走 unit fold + keep
    // 标题」）：过程组是进行中 chrome，摘要行在 idle 不画；聚合若仍吞卡，
    // keep 卡既不在组行也不在逐条面 = 静默丢件。
    const split = splitLiveActivityRuns(
      [run("bash", "ok", "b1"), run("bash", "ok", "b2")],
      { running: false }
    );
    expect(split.groupRuns).toHaveLength(0);
    expect(split.tailRuns.map((r) => r.id)).toEqual(["b1", "b2"]);
  });

  test("idle:落定 retract 收起（showTitle/showPreview 同假，不摊标题）", () => {
    // 不变式（D3 `specs/tui-tool-settled-appearance.md`:22「retract 必须
    // showTitle 与 showPreview 同假」/ SC2 overflow「≥20 条成功 retract 仍
    // 一行计数，不摊成标题」）：idle 面不得把落定 retract 放回逐条面 ——
    // liveToolPreviewBox 只取 slot 颜色、不查 showTitle，放回即整屏刷标题。
    const split = splitLiveActivityRuns(
      [
        run("read_file", "ok", "r1"),
        run("bash", "ok", "b1"),
        run("skill", "ok", "s1"),
      ],
      { running: false }
    );
    expect(split.groupRuns).toHaveLength(0);
    // retract 收起；keep bash 与 accent skill 留逐条面。
    expect(split.tailRuns.map((r) => r.id)).toEqual(["b1", "s1"]);
  });

  test("idle:仍 running 的 retract 不静默丢（状态机空窗防御）", () => {
    // running 件在 idle 帧上无历史可依（尚未落盘），逐条面必须接住 ——
    // 收起只针对已落定件（有 history id 可被 unit fold 计数）。
    const split = splitLiveActivityRuns(
      [run("read_file", "running", "r-run")],
      { running: false }
    );
    expect(split.groupRuns).toHaveLength(0);
    expect(split.tailRuns.map((r) => r.id)).toEqual(["r-run"]);
  });

  test("empty:空 runs → 两面皆空", () => {
    const split = splitRunning([]);
    expect(split.groupRuns).toHaveLength(0);
    expect(split.tailRuns).toHaveLength(0);
  });

  test("negative:keep / accent / 失败件进逐条面，不进组", () => {
    const bash = run("bash", "ok");
    const skill = run("skill", "ok");
    const failedRead = run("read_file", "failed");
    const split = splitRunning([bash, skill, failedRead]);
    expect(split.groupRuns).toHaveLength(0);
    expect(split.tailRuns.map((r) => r.id)).toEqual([
      bash.id,
      skill.id,
      failedRead.id,
    ]);
  });

  test("细节槽：当前 running 件即使属收类也留逐条框（贴底活动行），完成的收不留", () => {
    const write = run("write_file", "running", "w1");
    const readOk = run("read_file", "ok", "r-ok");
    const grep = run("grep", "running", "g1");
    const split = splitRunning([write, readOk, grep]);
    // 组计数含全部收类（running 与完成同桶 —— 不换过去时）。
    expect(split.groupRuns.map((r) => r.id)).toEqual(["r-ok", "g1"]);
    // 逐条面 = 非收类件 + 当前 running 件（细节槽）；已完成的读不留框。
    expect(split.tailRuns.map((r) => r.id)).toEqual(["w1", "g1"]);
  });

  test("细节槽 = 最后一条 running 件（任意类）；更早的 running 收类只进计数", () => {
    const earlySearch = run("web_search", "running", "s1");
    const lateRead = run("read_file", "running", "r1");
    const split = splitRunning([earlySearch, lateRead]);
    // 两条都进组计数（进行中不换过去时）。
    expect(split.groupRuns.map((r) => r.id)).toEqual(["s1", "r1"]);
    // 细节槽至多一条 = 最后一条 running；更早的 s1 只留下计数。
    // harness 串行下不会同时有两条 running，本断言钉的是「至多一条」本身。
    expect(split.tailRuns.map((r) => r.id)).toEqual(["r1"]);
  });

  test("bash 聚合：>=2 条非失败 bash 只留最后一条卡片（其余只进组）", () => {
    const split = splitRunning([
      run("bash", "ok", "b1"),
      run("bash", "ok", "b2"),
      run("bash", "ok", "b3"),
    ]);
    // 组计数含全部聚合 bash。
    expect(split.groupRuns.map((r) => r.id)).toEqual(["b1", "b2", "b3"]);
    // 无 running → 细节槽 = 最后一条 bash（D9「最后一条 keep bash 的短预览」）。
    expect(split.tailRuns.map((r) => r.id)).toEqual(["b3"]);
  });

  test("bash 单条：不聚合 -> 普通 keep 卡片留在逐条面（无组段）", () => {
    const split = splitRunning([
      run("bash", "ok", "b1"),
      run("read_file", "ok", "r1"),
    ]);
    expect(split.groupRuns.map((r) => r.id)).toEqual(["r1"]);
    expect(split.tailRuns.map((r) => r.id)).toEqual(["b1"]);
  });

  test("bash 聚合 + running bash：细节槽 = running bash，完成 bash 不留卡片", () => {
    const split = splitRunning([
      run("bash", "ok", "b1"),
      run("bash", "running", "b2"),
    ]);
    expect(split.groupRuns.map((r) => r.id)).toEqual(["b1", "b2"]);
    // 逐条框按原顺序返回 —— 调用方交 `liveTailSlots` 按 draftEpoch 回到
    // 原位；挪到队尾会破坏 tool→text→tool 的轴（见
    // tests/tui/chat-view-scroll.test.tsx 第二段草稿用例）。
    expect(split.tailRuns.map((r) => r.id)).toEqual(["b2"]);
  });

  test("细节槽唯一：running 收类件接棒时，聚合 bash 的末条也只剩计数", () => {
    const split = splitRunning([
      run("bash", "ok", "b1"),
      run("bash", "ok", "b2"),
      run("read_file", "running", "r1"),
    ]);
    expect(split.groupRuns.map((r) => r.id)).toEqual(["b1", "b2", "r1"]);
    expect(split.tailRuns.map((r) => r.id)).toEqual(["r1"]);
  });

  test("negative:失败 bash 不进聚合、不占细节槽（自留 failure overlay 卡片）", () => {
    const failed = run("bash", "failed", "b-fail");
    const split = splitRunning([
      run("bash", "ok", "b1"),
      run("bash", "ok", "b2"),
      failed,
    ]);
    expect(split.groupRuns.map((r) => r.id)).toEqual(["b1", "b2"]);
    expect(split.tailRuns.map((r) => r.id)).toEqual(["b2", "b-fail"]);
  });

  test("concurrent:同输入多次调用结果一致（纯函数稳定）", () => {
    const runs = [run("read_file", "running", "r1"), run("bash", "ok")];
    const a = splitRunning(runs);
    const b = splitRunning(runs);
    expect(a.groupRuns.map((r) => r.id)).toEqual(b.groupRuns.map((r) => r.id));
    expect(a.tailRuns.map((r) => r.id)).toEqual(b.tailRuns.map((r) => r.id));
  });

  test("exception:顺序保持（组内 / 逐条各自稳定）", () => {
    const split = splitRunning([
      run("bash", "ok", "b1"),
      run("read_file", "ok", "r1"),
      run("write_file", "running", "w1"),
      run("grep", "ok", "g1"),
    ]);
    expect(split.groupRuns.map((r) => r.id)).toEqual(["r1", "g1"]);
    // w1 是 running → 细节槽；逐条面 = b1 + w1（r1 / g1 已进组）。
    expect(split.tailRuns.map((r) => r.id)).toEqual(["b1", "w1"]);
  });
});
