/** @jsxImportSource @opentui/react */
/**
 * tests/tui/modal.test.tsx
 *
 * TUI modal render slot (OpenTUI ModalHost + SelectModal + reduceModalKey).
 * Coverage:
 *  - reduceModalKey pure function: y/a/n hotkey direct select (case
 *    insensitive), ↑↓ navigation clamp, Enter picks current, Esc dismisses,
 *    ctrl/meta and unmatched chars ignored, generic select uses the same
 *    mechanism (customizable hotkeys);
 *  - selectModalRows row accounting: title / description / options counted
 *    with visual-width wrapping on narrow terminals;
 *  - ModalHost render: permission box (title / three options / key hint),
 *    generic select box, no modal → empty frame;
 *  - row-accounting invariant: measured box height via captureCharFrame
 *    (border lines ╭→╰) === selectModalRows prediction (wide / narrow
 *    terminal, CJK description).
 */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import {
  ModalHost,
  PERMISSION_ANSWERS,
  permissionModalContent,
  permissionModalRows,
  reduceModalKey,
  selectModalRows,
  type ModalKeyEvent,
  type SelectOption,
  type TuiModal,
} from "../../src/tui/modal.js";

const noKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  tab: false,
  space: false,
  return: false,
  escape: false,
  ctrl: false,
  meta: false,
};

function key(
  input: string,
  patch?: Partial<ModalKeyEvent["key"]>
): ModalKeyEvent {
  return { input, key: { ...noKey, ...patch } };
}

const permModal = { options: PERMISSION_ANSWERS, selectedIndex: 0 };

describe("reduceModalKey（权限确认 y/a/n）", () => {
  test("y / a / n hotkey 直选（once/always/reject）", () => {
    expect(reduceModalKey(key("y"), permModal)).toEqual({
      type: "select",
      value: "once",
    });
    expect(reduceModalKey(key("a"), permModal)).toEqual({
      type: "select",
      value: "always",
    });
    expect(reduceModalKey(key("n"), permModal)).toEqual({
      type: "select",
      value: "reject",
    });
  });

  test("hotkey 大小写不敏感", () => {
    expect(reduceModalKey(key("Y"), permModal)).toEqual({
      type: "select",
      value: "once",
    });
    expect(reduceModalKey(key("A"), permModal)).toEqual({
      type: "select",
      value: "always",
    });
  });

  test("↑/↓ 移动选中索引并 clamp", () => {
    expect(reduceModalKey(key("", { upArrow: true }), permModal)).toEqual({
      type: "move",
      index: 0, // already at 0 → clamp
    });
    const down = reduceModalKey(key("", { downArrow: true }), permModal);
    expect(down).toEqual({ type: "move", index: 1 });
    const atEnd = { options: PERMISSION_ANSWERS, selectedIndex: 2 };
    expect(reduceModalKey(key("", { downArrow: true }), atEnd)).toEqual({
      type: "move",
      index: 2, // at last index → clamp
    });
    expect(
      reduceModalKey(key("", { upArrow: true }), {
        options: PERMISSION_ANSWERS,
        selectedIndex: 2,
      })
    ).toEqual({ type: "move", index: 1 });
  });

  test("Enter 选中当前索引项", () => {
    expect(reduceModalKey(key("", { return: true }), permModal)).toEqual({
      type: "select",
      value: "once",
    });
    expect(
      reduceModalKey(key("", { return: true }), {
        options: PERMISSION_ANSWERS,
        selectedIndex: 2,
      })
    ).toEqual({ type: "select", value: "reject" });
  });

  test("Esc → dismiss", () => {
    expect(reduceModalKey(key("", { escape: true }), permModal)).toEqual({
      type: "dismiss",
    });
  });

  test("ctrl/meta 组合键与无匹配字符 → ignore", () => {
    expect(reduceModalKey(key("y", { ctrl: true }), permModal)).toEqual({
      type: "ignore",
    });
    expect(reduceModalKey(key("a", { meta: true }), permModal)).toEqual({
      type: "ignore",
    });
    expect(reduceModalKey(key("x"), permModal)).toEqual({ type: "ignore" });
    expect(reduceModalKey(key(""), permModal)).toEqual({ type: "ignore" });
  });

  test("通用 select：自定义 hotkey 同样直选", () => {
    const options: ReadonlyArray<SelectOption> = [
      { value: "default", label: "Default", hotkey: "1" },
      { value: "full_auto", label: "Full Auto", hotkey: "2" },
    ];
    const modal = { options, selectedIndex: 0 };
    expect(reduceModalKey(key("2"), modal)).toEqual({
      type: "select",
      value: "full_auto",
    });
    expect(
      reduceModalKey(key("", { return: true }), { ...modal, selectedIndex: 1 })
    ).toEqual({ type: "select", value: "full_auto" });
  });
});

describe("selectModalRows（modal 行账 SSOT）", () => {
  test("宽终端：权限 modal = 边框 2 + 标题 1 + 描述 1 + 选项 3 + 提示 1", () => {
    const ask = { tool: "bash", summaryHint: "ls -la" };
    expect(permissionModalRows(ask, 100)).toBe(8);
    // no description → one row fewer.
    expect(permissionModalRows({ tool: "bash", summaryHint: "" }, 100)).toBe(7);
  });

  test("窄终端：标题 / 描述按视觉宽度折行入账（CJK 占 2 列）", () => {
    const longHint =
      "rm -rf /some/very/long/path/that/wraps/on/narrow/terminals";
    const wide = permissionModalRows(
      { tool: "bash", summaryHint: longHint },
      100
    );
    const narrow = permissionModalRows(
      { tool: "bash", summaryHint: longHint },
      44
    );
    expect(narrow).toBeGreaterThan(wide); // wrapping adds rows
    // describable by hand: inner=40, hint visual width 60 → 2 rows; wide terminal 1 row → diff 1.
    expect(narrow - wide).toBe(1);
  });

  test("通用 select 内容同样入账（自定义标题 / 选项数）", () => {
    const rows = selectModalRows(
      {
        title: "选择权限模式",
        options: [
          { value: "default", label: "Default" },
          { value: "full_auto", label: "Full Auto" },
        ],
      },
      80
    );
    // borders 2 + title 1 + options 2 + default hint 1 = 6.
    expect(rows).toBe(6);
  });
});

/** Measured modal box height in the frame: lines from top border (╭) to bottom border (╰). */
function modalBoxHeight(frame: string): number {
  const lines = frame.split("\n");
  const top = lines.findIndex((l) => l.includes("╭"));
  const bottom = lines.findIndex((l) => l.includes("╰"));
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeGreaterThan(top);
  return bottom - top + 1;
}

async function renderModal(modal: TuiModal | undefined, cols: number) {
  const setup = await testRender(<ModalHost modal={modal} cols={cols} />, {
    width: cols,
    height: 30,
  });
  await setup.renderOnce();
  return setup;
}

describe("ModalHost 渲染", () => {
  test("permission modal：标题 + 三选项 + 键位提示可见", async () => {
    const setup = await renderModal(
      {
        kind: "permission",
        tool: "bash",
        summaryHint: "ls -la",
        selectedIndex: 0,
      },
      100
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("允许执行 bash？");
    expect(frame).toContain("ls -la");
    expect(frame).toContain("[y]");
    expect(frame).toContain("本次允许");
    expect(frame).toContain("[a]");
    expect(frame).toContain("总是允许（本会话）");
    expect(frame).toContain("[n]");
    expect(frame).toContain("拒绝");
    expect(frame).toContain("Esc 收起");
    // the selection marker lands on the first option.
    expect(frame).toContain("❯ [y]");
    await setup.renderer.destroy();
  });

  test("selectedIndex 移动选中标记", async () => {
    const setup = await renderModal(
      { kind: "permission", tool: "bash", summaryHint: "", selectedIndex: 2 },
      100
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("❯ [n]");
    expect(frame).not.toContain("❯ [y]");
    await setup.renderer.destroy();
  });

  test("通用 select modal 渲染自定义选项", async () => {
    const setup = await renderModal(
      {
        kind: "select",
        title: "选择权限模式",
        options: [
          { value: "default", label: "Default", hotkey: "1" },
          {
            value: "full_auto",
            label: "Full Auto",
            hotkey: "2",
            description: "跳过确认",
          },
        ],
        selectedIndex: 1,
      },
      100
    );
    const frame = setup.captureCharFrame();
    expect(frame).toContain("选择权限模式");
    expect(frame).toContain("[1] Default");
    expect(frame).toContain("[2] Full Auto");
    expect(frame).toContain("跳过确认");
    expect(frame).toContain("❯ [2]");
    await setup.renderer.destroy();
  });

  test("无 modal → 空帧", async () => {
    const setup = await renderModal(undefined, 100);
    expect(setup.captureCharFrame().trim()).toBe("");
    await setup.renderer.destroy();
  });

  test("行账不变式：实测盒子高度 === selectModalRows（宽 / 窄终端）", async () => {
    for (const cols of [100, 44]) {
      const ask = {
        tool: "write_file",
        summaryHint: "写入 src/some/long/path/file.ts（覆盖既有内容）",
      };
      const setup = await renderModal(
        { kind: "permission", ...ask, selectedIndex: 0 },
        cols
      );
      const height = modalBoxHeight(setup.captureCharFrame());
      expect(
        height,
        `cols=${cols} 实测 ${height} === 预测 ${permissionModalRows(ask, cols)}`
      ).toBe(permissionModalRows(ask, cols));
      // double check: recomputed from content description (render / row-accounting share one source).
      expect(selectModalRows(permissionModalContent(ask), cols)).toBe(
        permissionModalRows(ask, cols)
      );
      await setup.renderer.destroy();
    }
  });
});
