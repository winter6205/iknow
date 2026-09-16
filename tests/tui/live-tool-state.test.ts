/**
 * tests/tui/live-tool-state.test.ts
 *
 * #578：unmatched post_tool_use 不得 append 幽灵 live 行（与 history
 * `[失败]` 双重渲染）。OpenTUI 合同：未匹配 id 与 unmatched
 * tool_input_delta 一样 return prev。archive/tui-ink 的 append + length 2
 * 合同已倒置。匹配 id 仍 in-place ok/failed。
 */
import { describe, expect, test } from "bun:test";
import {
  liveTailSlots,
  liveToolReduce,
  type LiveToolRun,
} from "../../src/tui/live-tool-state.js";

describe("liveToolReduce (#578 unmatched post_tool_use 不 append)", () => {
  test("empty prev + unmatched post_tool_use → return prev（不 append 幽灵行）", () => {
    const prev: ReadonlyArray<LiveToolRun> = [];
    const next = liveToolReduce(prev, {
      kind: "post_tool_use",
      id: "toolu_ghost",
      name: "write_file",
      input: {},
      ok: false,
      message: "validation_failed",
    });
    expect(next).toBe(prev);
    expect(next).toHaveLength(0);
  });

  test("id 不匹配的 post_tool_use → return prev（不 append，length 保持 1）", () => {
    const started: ReadonlyArray<LiveToolRun> = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_unknown",
      name: "noop",
    });
    const next = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_other",
      name: "noop",
      input: {},
      ok: true,
    });
    expect(next).toBe(started);
    expect(next).toHaveLength(1);
    expect(next[0]?.status).toBe("running");
  });

  test("匹配 id 的 post_tool_use ok → in-place 转 ok", () => {
    const started: ReadonlyArray<LiveToolRun> = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_1",
      name: "echo",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_1",
      name: "echo",
      input: { value: "x" },
      ok: true,
      detail: "执行摘要",
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      id: "toolu_1",
      name: "echo",
      status: "ok",
      detail: "执行摘要",
    });
  });

  test("匹配 id 的 post_tool_use failed → in-place 转 failed", () => {
    const started: ReadonlyArray<LiveToolRun> = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_x",
      name: "bash",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_x",
      name: "bash",
      input: { command: "ls" },
      ok: false,
      message: "exit 1",
      detail: "ls",
    });
    expect(done).toHaveLength(1);
    expect(done[0]?.status).toBe("failed");
    expect(done[0]?.message).toBe("exit 1");
  });
});

describe("liveToolReduce (T5 完成件一律 in-place 保留,不再删除)", () => {
  // plans/tui-live-activity-fold.md T5:旧 #589 的「成功只读直删」与
  // chat-view 的 history-id 过滤叠加成双删 —— 历史已含该 tool_use 时
  // MessageBlocks 按 slot 隐去标题,reducer 又抹掉 live 件,帧上空白。
  // 落点由消费侧决定(group 计数 / unit fold 计数),reducer 只如实转态。
  test("start + ok read_file → 留在数组,状态 ok(落点由渲染侧决定)", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-rf-ok",
      name: "read_file",
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "tu-rf-ok",
      name: "read_file",
      input: { path: "a.ts" },
      ok: true,
      detail: "读取 a.ts",
    });
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      id: "tu-rf-ok",
      name: "read_file",
      status: "ok",
    });
  });

  test("start + ok grep / glob → 同样留在数组(keep / retract 一视同仁)", () => {
    const grep = liveToolReduce(
      liveToolReduce([], {
        kind: "tool_call_start",
        id: "tu-grep-ok",
        name: "grep",
      }),
      {
        kind: "post_tool_use",
        id: "tu-grep-ok",
        name: "grep",
        input: { pattern: "foo" },
        ok: true,
        detail: "grep foo",
      }
    );
    const glob = liveToolReduce(
      liveToolReduce([], {
        kind: "tool_call_start",
        id: "tu-glob-ok",
        name: "glob",
      }),
      {
        kind: "post_tool_use",
        id: "tu-glob-ok",
        name: "glob",
        input: { pattern: "*.ts" },
        ok: true,
        detail: "glob *.ts",
      }
    );
    expect(grep.map((r) => r.status)).toEqual(["ok"]);
    expect(glob.map((r) => r.status)).toEqual(["ok"]);
  });

  test("failed read_file 与随后成功 read_file 同在(失败不被成功顶掉)", () => {
    const failStarted = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-rf-fail",
      name: "read_file",
    });
    const afterFail = liveToolReduce(failStarted, {
      kind: "post_tool_use",
      id: "tu-rf-fail",
      name: "read_file",
      input: { path: "missing.ts" },
      ok: false,
      message: "ENOENT",
      detail: "读取 missing.ts",
    });
    const okStarted = liveToolReduce(afterFail, {
      kind: "tool_call_start",
      id: "tu-rf-ok2",
      name: "read_file",
    });
    const afterOk = liveToolReduce(okStarted, {
      kind: "post_tool_use",
      id: "tu-rf-ok2",
      name: "read_file",
      input: { path: "b.ts" },
      ok: true,
      detail: "读取 b.ts",
    });
    expect(afterOk).toHaveLength(2);
    expect(afterOk[0]).toMatchObject({
      id: "tu-rf-fail",
      name: "read_file",
      status: "failed",
      message: "ENOENT",
    });
    expect(afterOk[1]).toMatchObject({
      id: "tu-rf-ok2",
      name: "read_file",
      status: "ok",
    });
  });

  test("write_file ok 与随后成功 read_file 同在(顺序保持)", () => {
    const writeStarted = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-wf-ok",
      name: "write_file",
    });
    const afterWrite = liveToolReduce(writeStarted, {
      kind: "post_tool_use",
      id: "tu-wf-ok",
      name: "write_file",
      input: { path: "a.ts", content: "x" },
      ok: true,
      detail: "写入 a.ts（1 行）",
    });
    const readStarted = liveToolReduce(afterWrite, {
      kind: "tool_call_start",
      id: "tu-rf-after-wf",
      name: "read_file",
    });
    const afterRead = liveToolReduce(readStarted, {
      kind: "post_tool_use",
      id: "tu-rf-after-wf",
      name: "read_file",
      input: { path: "a.ts" },
      ok: true,
      detail: "读取 a.ts",
    });
    expect(afterRead.map((r) => r.id)).toEqual(["tu-wf-ok", "tu-rf-after-wf"]);
  });

  test("完成只读不删除夹在中间的 running sibling(两者都在)", () => {
    const readStarted = liveToolReduce([], {
      kind: "tool_call_start",
      id: "tu-rf-sib",
      name: "read_file",
    });
    const withSibling = liveToolReduce(readStarted, {
      kind: "tool_call_start",
      id: "tu-grep-run",
      name: "grep",
    });
    const afterReadOk = liveToolReduce(withSibling, {
      kind: "post_tool_use",
      id: "tu-rf-sib",
      name: "read_file",
      input: { path: "a.ts" },
      ok: true,
      detail: "读取 a.ts",
    });
    expect(afterReadOk.map((r) => r.id)).toEqual(["tu-rf-sib", "tu-grep-run"]);
    expect(afterReadOk[1]).toMatchObject({
      id: "tu-grep-run",
      name: "grep",
      status: "running",
    });
  });
});

describe("liveToolReduce draftEpoch（工具插在第 N 段草稿之后）", () => {
  test("tool_call_start 携带 draftEpoch: 1 → 条目记录该值", () => {
    const runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_late",
      name: "write_file",
      draftEpoch: 1,
    });
    expect(runs[0]?.draftEpoch).toBe(1);
  });

  test("tool_call_start 缺省 draftEpoch → 条目无标记（epoch 0，先于第一段草稿）", () => {
    const runs = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_early",
      name: "web_search",
    });
    expect(runs[0]?.draftEpoch).toBeUndefined();
  });

  test("post_tool_use 完成重建条目时保留 draftEpoch", () => {
    const started = liveToolReduce([], {
      kind: "tool_call_start",
      id: "toolu_late_keep",
      name: "write_file",
      draftEpoch: 2,
    });
    const done = liveToolReduce(started, {
      kind: "post_tool_use",
      id: "toolu_late_keep",
      name: "write_file",
      input: { path: "a.txt" },
      ok: true,
      detail: "写入 a.txt",
    });
    expect(done[0]?.status).toBe("ok");
    expect(done[0]?.draftEpoch).toBe(2);
  });
});

describe("liveTailSlots 按 epoch 交错工具与草稿段", () => {
  // T7（specs/tui-activity-block.md）：`liveTailSlots` 只承接 **keep / 失
  // 败** 的 live 工具 —— retract 类（read_file / grep / web_search / 等）
  // 由 unanchored 活动块（`appendLiveBlocks`）承接，不进 tail。失败件
  // 仍走 tail `[失败]` 行。本 describe 改用 keep 名（bash / write_file）
  // 验证 tail 的 epoch 交错。
  const run = (id: string, name: string, draftEpoch?: number): LiveToolRun => ({
    id,
    name,
    status: "running",
    input: undefined,
    ...(draftEpoch === undefined ? {} : { draftEpoch }),
  });

  test("empty：无工具无草稿 → 空槽", () => {
    expect(liveTailSlots([], [])).toEqual([]);
  });

  test("缺省 epoch 0 的工具在第一段草稿之上", () => {
    const slots = liveTailSlots([run("a", "bash")], ["hello"]);
    expect(slots).toEqual([
      { kind: "tools", runs: [run("a", "bash")] },
      { kind: "draft", text: "hello" },
    ]);
  });

  test("tool→text→tool→text：早工具 / 段0 / 晚工具 / 段1", () => {
    const early = run("a", "bash");
    const late = run("b", "write_file", 1);
    const slots = liveTailSlots([early, late], ["first", "second"]);
    expect(slots.map((s) => s.kind)).toEqual([
      "tools",
      "draft",
      "tools",
      "draft",
    ]);
    expect(slots[0]).toEqual({ kind: "tools", runs: [early] });
    expect(slots[1]).toEqual({ kind: "draft", text: "first" });
    expect(slots[2]).toEqual({ kind: "tools", runs: [late] });
    expect(slots[3]).toEqual({ kind: "draft", text: "second" });
  });

  test("negative：epoch 大于 segments.length → 工具挂在末尾，不丢弃", () => {
    const extra = run("z", "write_file", 3);
    const slots = liveTailSlots([extra], ["only"]);
    expect(slots).toEqual([
      { kind: "draft", text: "only" },
      { kind: "tools", runs: [extra] },
    ]);
  });

  test("exception：空草稿段跳过、缺字段不抛", () => {
    const early = run("a", "bash");
    expect(() => liveTailSlots([early], ["", "kept"])).not.toThrow();
    const slots = liveTailSlots([early], ["", "kept"]);
    expect(slots).toEqual([
      { kind: "tools", runs: [early] },
      { kind: "draft", text: "kept" },
    ]);
  });

  test("retract 名被剥掉 → 不进 tail（由 unanchored 块承接）", () => {
    // T7：read_file / web_search / grep 等 retract 类**只**进 unanchored
    // 块，不进 tail 工具卡。失败件（status=failed）作为例外仍走 tail
    // `[失败]` 行。
    const retract = run("r", "web_search");
    const failedRetract: LiveToolRun = {
      id: "fr",
      name: "grep",
      status: "failed",
      input: undefined,
    };
    const slots = liveTailSlots([retract, failedRetract], ["hi"]);
    expect(slots).toEqual([
      { kind: "tools", runs: [failedRetract] },
      { kind: "draft", text: "hi" },
    ]);
  });

  test("表外 retract 名同样被剥 —— 判定走 settledClassOf 单一来源", () => {
    // T7 修复（review H1）：剥除判定不得用固定名 Set —— TOOL_SETTLED_CLASS
    // 的 retract 类含 web_fetch / memory_recall / glob / lsp_* 等表外名，
    // 若按名硬编码会漏剥 → 块与 tail 双画（specs/tui-activity-block.md
    // Never「不另造第二套分类表」）。本用例钉住：任意 settledClassOf ===
    // "retract" 的名（含注册表内非著名成员与未注册兜底名）都进块不进 tail。
    const offRegistry = run("o1", "web_fetch");
    const unregistered = run("o2", "some_unregistered_tool");
    const lsp = run("o3", "lsp_references");
    const keepBash = run("k", "bash");
    const slots = liveTailSlots([offRegistry, unregistered, lsp, keepBash], []);
    expect(slots).toEqual([{ kind: "tools", runs: [keepBash] }]);
  });
});
