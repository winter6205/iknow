/**
 * tests/tui/modal.test.tsx
 *
 * #279 项3：TUI modal 渲染槽（ModalHost + SelectModal + reduceModalKey）。
 * 覆盖：
 *  - reduceModalKey 纯函数：y/a/n hotkey 直选（大小写不敏感）、↑↓ 导航
 *    clamp、Enter 选中当前、Esc dismiss、ctrl/meta 与无匹配字符 ignore、
 *    通用 select 同机制（hotkey 可自定义）；
 *  - selectModalRows 行账：窄终端标题 / 描述 / 选项按视觉宽度折行计入；
 *  - ModalHost 渲染：permission 盒子（标题 / 三选项 / 键位提示）、通用
 *    select 盒子、无 modal → 空；
 *  - 行账不变式：ink 实测渲染行数 === selectModalRows 预测（宽 / 窄终端）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { render } from "ink";
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

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const noKey = {
  upArrow: false,
  downArrow: false,
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
  it("y / a / n hotkey 直选（once/always/reject）", () => {
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

  it("hotkey 大小写不敏感", () => {
    expect(reduceModalKey(key("Y"), permModal)).toEqual({
      type: "select",
      value: "once",
    });
    expect(reduceModalKey(key("A"), permModal)).toEqual({
      type: "select",
      value: "always",
    });
  });

  it("↑/↓ 移动选中索引并 clamp", () => {
    expect(reduceModalKey(key("", { upArrow: true }), permModal)).toEqual({
      type: "move",
      index: 0, // 已在 0 → clamp
    });
    const down = reduceModalKey(key("", { downArrow: true }), permModal);
    expect(down).toEqual({ type: "move", index: 1 });
    const atEnd = { options: PERMISSION_ANSWERS, selectedIndex: 2 };
    expect(reduceModalKey(key("", { downArrow: true }), atEnd)).toEqual({
      type: "move",
      index: 2, // 末尾 → clamp
    });
    expect(
      reduceModalKey(key("", { upArrow: true }), {
        options: PERMISSION_ANSWERS,
        selectedIndex: 2,
      })
    ).toEqual({ type: "move", index: 1 });
  });

  it("Enter 选中当前索引项", () => {
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

  it("Esc → dismiss", () => {
    expect(reduceModalKey(key("", { escape: true }), permModal)).toEqual({
      type: "dismiss",
    });
  });

  it("ctrl/meta 组合键与无匹配字符 → ignore", () => {
    expect(reduceModalKey(key("y", { ctrl: true }), permModal)).toEqual({
      type: "ignore",
    });
    expect(reduceModalKey(key("a", { meta: true }), permModal)).toEqual({
      type: "ignore",
    });
    expect(reduceModalKey(key("x"), permModal)).toEqual({ type: "ignore" });
    expect(reduceModalKey(key(""), permModal)).toEqual({ type: "ignore" });
  });

  it("通用 select：自定义 hotkey 同样直选", () => {
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
  it("宽终端：权限 modal = 边框 2 + 标题 1 + 描述 1 + 选项 3 + 提示 1", () => {
    const ask = { tool: "bash", summaryHint: "ls -la" };
    expect(permissionModalRows(ask, 100)).toBe(8);
    // 无描述 → 少 1 行。
    expect(permissionModalRows({ tool: "bash", summaryHint: "" }, 100)).toBe(7);
  });

  it("窄终端：标题 / 描述按视觉宽度折行入账（CJK 占 2 列）", () => {
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
    expect(narrow).toBeGreaterThan(wide); // 折行后行数增加
    // 描述折行可手算：inner=40，hint 视觉宽 60 → 2 行；宽终端 1 行 → 差 1。
    expect(narrow - wide).toBe(1);
  });

  it("通用 select 内容同样入账（自定义标题 / 选项数）", () => {
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
    // 边框 2 + 标题 1 + 选项 2 + 默认提示 1 = 6。
    expect(rows).toBe(6);
  });
});

function fakeTty(rows: number, cols: number) {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    columns: number;
    rows: number;
    setRawMode: (v: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.columns = cols;
  s.rows = rows;
  s.setRawMode = (): void => {};
  s.ref = (): void => {};
  s.unref = (): void => {};
  return s;
}

describe("ModalHost 渲染", () => {
  // ink 输出 flush 需要 interactive + TTY 假面（与 app.test.tsx 同款；
  // ModalHost 本身无 useInput，stdin 仅为满足 ink 输入链路前提）。
  const mounted: Array<{ unmount: () => void }> = [];
  function mountModal(modal: TuiModal | undefined, cols: number) {
    const stdout = fakeTty(24, cols);
    const stdin = fakeTty(24, cols);
    const out: string[] = [];
    stdout.on("data", (c) => out.push(String(c)));
    const instance = render(<ModalHost modal={modal} cols={cols} />, {
      stdout,
      stdin,
      exitOnCtrlC: false,
      interactive: true,
      kittyKeyboard: { mode: "disabled" },
    });
    mounted.push(instance);
    return {
      text: async (): Promise<string> => {
        await delay(150); // ink 异步节流渲染，等首帧 flush
        return strip(out.join(""));
      },
    };
  }
  afterEach(() => {
    for (const m of mounted.splice(0)) m.unmount();
  });

  it("permission modal：标题 + 三选项 + 键位提示可见", async () => {
    const app = mountModal(
      {
        kind: "permission",
        tool: "bash",
        summaryHint: "ls -la",
        selectedIndex: 0,
      },
      100
    );
    const text = await app.text();
    expect(text).toContain("允许执行 bash？");
    expect(text).toContain("ls -la");
    expect(text).toContain("[y]");
    expect(text).toContain("本次允许");
    expect(text).toContain("[a]");
    expect(text).toContain("总是允许（本会话）");
    expect(text).toContain("[n]");
    expect(text).toContain("拒绝");
    expect(text).toContain("Esc 收起");
    // 选中项标记落在第一项。
    expect(text).toMatch(/❯ \[y\]/);
  });

  it("selectedIndex 移动选中标记", async () => {
    const app = mountModal(
      { kind: "permission", tool: "bash", summaryHint: "", selectedIndex: 2 },
      100
    );
    const text = await app.text();
    expect(text).toMatch(/❯ \[n\]/);
    expect(text).not.toMatch(/❯ \[y\]/);
  });

  it("通用 select modal 渲染自定义选项", async () => {
    const app = mountModal(
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
    const text = await app.text();
    expect(text).toContain("选择权限模式");
    expect(text).toContain("[1] Default");
    expect(text).toContain("[2] Full Auto");
    expect(text).toContain("跳过确认");
    expect(text).toMatch(/❯ \[2\]/);
  });

  it("无 modal → 空渲染", async () => {
    const app = mountModal(undefined, 100);
    const text = await app.text();
    expect(text.trim()).toBe("");
  });

  it("行账不变式：实测渲染行数 === selectModalRows（宽 / 窄终端）", async () => {
    for (const cols of [100, 44]) {
      const ask = {
        tool: "write_file",
        summaryHint: "写入 src/some/long/path/file.ts（覆盖既有内容）",
      };
      const app = mountModal(
        { kind: "permission", ...ask, selectedIndex: 0 },
        cols
      );
      const text = await app.text();
      const frame = text.replace(/\n+$/, "");
      const rendered = frame.split("\n").length;
      expect(
        rendered,
        `cols=${cols} 实测 ${rendered} === 预测 ${permissionModalRows(ask, cols)}`
      ).toBe(permissionModalRows(ask, cols));
      // 双重核对：内容描述重算一致（渲染 / 行账同源守卫）。
      expect(selectModalRows(permissionModalContent(ask), cols)).toBe(
        permissionModalRows(ask, cols)
      );
    }
  });
});
