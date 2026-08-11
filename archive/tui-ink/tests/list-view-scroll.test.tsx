/**
 * tests/tui/list-view-scroll.test.tsx
 *
 * 会话列表「超限修复」行为：
 *  - listEntryMatches 纯函数：summary / lastFinalText 子串匹配、不区分大小写、
 *    空白 query 匹配全部；
 *  - renderToString 视口窗口：rows 预算内只渲染「搜索框 + 表头 + 可视行」，
 *    会话超过视口时首尾滚动指示出现、超出部分不渲染（杜绝整帧溢出）；
 *  - 交互（ink render + 假 TTY + stdin）：键入搜索过滤、↑↓ 移出视口边缘
 *    触发翻页、Esc 清空搜索 vs 返回聊天、Home/End 跳顶/跳底。
 *
 * 用 renderToString 断言静态视口（无 real stdin 依赖），用 render + 假
 * stdin 断言滚动交互（与 app.test.tsx 同款假 TTY 基建缩小版）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { render, renderToString } from "ink";
import type { Instance } from "ink";
import {
  ListView,
  listEntryMatches,
  type TuiListEntry,
} from "../../src/tui/list-view.js";

const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]/g;
const strip = (s: string): string => s.replace(ANSI_RE, "");
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeEntry(
  id: string,
  summary: string,
  lastFinalText = "",
  runningBg = false
): TuiListEntry {
  return {
    conversation_id: id,
    updatedAt: new Date().toISOString(),
    lastFinalText,
    summary,
    runningBg,
  };
}

const manyEntries: ReadonlyArray<TuiListEntry> = Array.from(
  { length: 20 },
  (_, i) =>
    makeEntry(
      `conv-${String(i).padStart(2, "0")}`,
      `会话 ${String(i).padStart(2, "0")} 的摘要`,
      i % 4 === 0 ? `回答 ${i}` : ""
    )
);

describe("listEntryMatches（搜索过滤谓词）", () => {
  const entry = makeEntry("c1", "部署流程排查", "权限报错 403 access-denied");

  it("空 / 空白 query → 全部匹配", () => {
    expect(listEntryMatches(entry, "")).toBe(true);
    expect(listEntryMatches(entry, "   ")).toBe(true);
  });

  it("summary 子串匹配", () => {
    expect(listEntryMatches(entry, "部署")).toBe(true);
    expect(listEntryMatches(entry, "部署流程")).toBe(true);
    expect(listEntryMatches(entry, "排查")).toBe(true);
  });

  it("lastFinalText 子串匹配（含英文不区分大小写）", () => {
    expect(listEntryMatches(entry, "权限报错")).toBe(true);
    expect(listEntryMatches(entry, "403")).toBe(true);
    expect(listEntryMatches(entry, "ACCESS")).toBe(true); // 英文不区分大小写
    expect(listEntryMatches(entry, "access")).toBe(true);
  });

  it("无匹配 → false", () => {
    expect(listEntryMatches(entry, "不存在的关键词")).toBe(false);
    expect(listEntryMatches(entry, "xyz")).toBe(false);
  });
});

describe("ListView 视口窗口（renderToString，rows 预算内不溢出）", () => {
  it("rows 预算 = 搜索框 + 表头 + 有限可视行；超 20 行时底部指示出现", async () => {
    const output = await renderToString(
      <ListView
        entries={manyEntries}
        cols={80}
        rows={11}
        onOpen={() => {}}
        onBack={() => {}}
      />,
      { columns: 80 }
    );
    const plain = strip(output);
    // 搜索框 + 表头。
    expect(plain).toContain("搜索会话");
    expect(plain).toContain("会话列表");
    // 行账 SSOT：视口 6 行（rows=11 → viewHeight=6）= 伪条目 + 5 会话可见。
    expect(plain).toContain("+ 新建会话");
    expect(plain).toContain("会话 00 的摘要");
    expect(plain).toContain("会话 04 的摘要");
    // 第 6 个会话（index 5）起被视口裁掉。
    expect(plain).not.toContain("会话 05 的摘要");
    // 底部滚动指示出现。
    expect(plain).toContain("↓ 更多");
  });

  it("rows 预算内全部可见 → 无滚动指示、无溢出", async () => {
    const output = await renderToString(
      <ListView
        entries={manyEntries.slice(0, 5)}
        cols={80}
        rows={11}
        onOpen={() => {}}
        onBack={() => {}}
      />,
      { columns: 80 }
    );
    const plain = strip(output);
    expect(plain).not.toContain("↓ 更多");
    expect(plain).not.toContain("↑ 更多");
    expect(plain).not.toContain("会话 05");
  });

  it("空列表 → 提示 Enter 新建（无滚动指示）", async () => {
    const output = await renderToString(
      <ListView
        entries={[]}
        cols={80}
        rows={11}
        onOpen={() => {}}
        onBack={() => {}}
      />,
      { columns: 80 }
    );
    expect(strip(output)).toContain("暂无会话");
  });
});

// —— 交互测试：ink render + 假 TTY（缩小版 app.test.tsx 基建）——
function fakeTty(
  rows: number,
  cols: number
): PassThrough & {
  isTTY: boolean;
  columns: number;
  rows: number;
  setRawMode: (v: boolean) => void;
  ref: () => void;
  unref: () => void;
} {
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
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

describe("ListView 交互（搜索 + 滚动）", () => {
  const mounted: Instance[] = [];

  function mount(
    entries: ReadonlyArray<TuiListEntry>,
    rows: number,
    onOpen: (i: number) => void,
    onBack: () => void
  ) {
    const stdout = fakeTty(24, 100);
    const stdin = fakeTty(24, 100);
    const out: string[] = [];
    stdout.on("data", (c) => out.push(String(c)));
    const instance = render(
      <ListView
        entries={entries}
        cols={100}
        rows={rows}
        onOpen={onOpen}
        onBack={onBack}
      />,
      {
        stdout,
        stdin,
        interactive: true,
        exitOnCtrlC: false,
        kittyKeyboard: { mode: "disabled" },
      }
    );
    mounted.push(instance);
    return {
      stdin,
      text: (): string => strip(out.join("")),
      lastFrame: (): string => {
        for (let i = out.length - 1; i >= 0; i--) {
          const raw = out[i] ?? "";
          const visible = strip(raw);
          if (visible.length > 0) return visible;
        }
        return "";
      },
    };
  }

  afterEach(() => {
    for (const m of mounted.splice(0)) m.unmount();
  });

  it("键入搜索过滤：只显示匹配会话 + 无匹配提示", async () => {
    const app = mount(
      manyEntries,
      8,
      () => {},
      () => {}
    );
    await delay(200);
    // 键入 "04" → 只匹配 会话04 的摘要 + 回答04（lastFinalText）。
    for (const ch of "04") app.stdin.write(ch);
    await delay(200);
    const text = app.lastFrame();
    expect(text).toContain("会话 04 的摘要");
    expect(text).not.toContain("会话 03 的摘要");
    expect(text).not.toContain("会话 05 的摘要");
  });

  it("无匹配 → 提示「无匹配会话」", async () => {
    const app = mount(
      manyEntries,
      8,
      () => {},
      () => {}
    );
    await delay(200);
    for (const ch of "zzz") app.stdin.write(ch);
    await delay(200);
    expect(app.lastFrame()).toContain("无匹配会话");
    // 伪条目 + 新建会话 仍在（可创建）；会话行全部被过滤掉。
    expect(app.lastFrame()).toContain("+ 新建会话");
    expect(app.lastFrame()).not.toContain("会话 00 的摘要");
  });

  it("Esc 清空搜索（非返回）；再 Esc 返回聊天视图", async () => {
    let backCalled = 0;
    const app = mount(
      manyEntries,
      8,
      () => {},
      () => backCalled++
    );
    await delay(200);
    for (const ch of "04") app.stdin.write(ch);
    await delay(200);
    expect(app.lastFrame()).toContain("会话 04");
    // Esc（\x1b）→ 清空搜索。
    app.stdin.write("");
    await delay(200);
    expect(app.lastFrame()).toContain("会话 00 的摘要"); // 全量回来了
    expect(backCalled).toBe(0);
    // 再 Esc → 返回聊天。
    app.stdin.write("");
    await delay(200);
    expect(backCalled).toBe(1);
  });

  it("↑↓ 移出视口边缘翻页；Home/End 跳顶/跳底", async () => {
    const app = mount(
      manyEntries,
      11,
      () => {},
      () => {}
    );
    await delay(200);
    // 初始视口 6 行（rows=11 → viewHeight=6）：伪条目 + 会话00..04。
    expect(app.lastFrame()).toContain("会话 00 的摘要");
    expect(app.lastFrame()).not.toContain("会话 05 的摘要");
    // 连续 ↓ 越过视口下缘 → 触发翻页，滚动指示出现。
    for (let i = 0; i < 8; i++) app.stdin.write("[B");
    await delay(200);
    // 光标已到 index 8（会话07），视口下移 → 可见会话 05+。
    expect(app.lastFrame()).toContain("会话 05 的摘要");
    // End → 跳底：伪条目 + 末尾若干会话，底部指示消失。
    app.stdin.write("[F"); // End
    await delay(200);
    const bottom = app.lastFrame();
    expect(bottom).toContain("会话 19 的摘要");
    expect(bottom).not.toContain("↓ 更多");
    // Home → 跳顶：回到 会话00，顶部指示消失。
    app.stdin.write("[H"); // Home
    await delay(200);
    const top = app.lastFrame();
    expect(top).toContain("会话 00 的摘要");
    expect(top).not.toContain("↑ 更多");
  });
});
