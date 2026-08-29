/** @jsxImportSource @opentui/react */
/**
 * tests/tui/prompt-input-backspace.test.tsx
 *
 * 2026-08-15 用户反馈「输入框内容到多行的时候按 backspace，光标就会直接从
 * 尾部跳到第一个字」—— 即多行输入下 backspace 后光标被重置到 buffer 起点。
 *
 * 侦察结论（前 agent 实测）：
 *  - 多行 CJK wrap 成 2 视觉行内部 backspace：光标正常后退（visualCol
 *    42→40，删 1 个 CJK），不跳头 —— 库内部 visualCol/logicalCol 账目自洽；
 *  - prompt-input.tsx 受控同步 effect 的 `ta.plainText !== props.value`
 *    守卫在正常打字/backspace 路径一直成立，setText 覆盖从未发生。
 *
 * 2026-08-15 本轮定位结论（实测证据）：
 *  - 纯 backspace 各场景（wrap 内部 / unwrap 边界 / 跨 \n 边界 / 单行）光标
 *    均正常后退 —— backspace 本身无 bug；
 *  - 真凶 = prompt-input.tsx 受控同步 effect：程序写入路径（↑ 历史召回 /
 *    Tab 补全 / 回退 anchor 填回）调 `ta.setText(value)`，OpenTUI upstream
 *    setText 把光标重置到 offset 0（实测 "历史消息二" 召回后 offset=0）。
 *    用户随后按 backspace 想删尾部 → 光标已停第一个字，表现为「光标跳到开头」。
 *  - 修复：setText 后补 `ta.gotoBufferEnd()` 恢复末尾（本 app 程序写入全是
 *    全量替换 / 尾部追加，末尾光标 = 正确 UX）。
 *  - 排除项（修订 2026-08-15）：mockInput.typeText / 用户逐字输入 / 删除路
 *    径不触发 setText —— buffer 已先行经 onContentChange 回读更新，
 *    `ta.plainText !== props.value` 守卫恒为 false（恒不成立），分支不进
 *    入。paste（app.tsx:586 usePaste 直接 setInputValue(prev => prev + text)
 *    走 setState）会触发 setText + gotoBufferEnd：pasteBracketedText 实测
 *    多行粘贴后 plainText = 末尾追加文本（保留 \n），offset = 文本末尾列
 *    —— paste 后末尾光标是正确 UX，故也纳入回归（见 (h)）。
 *  - 补充：rewind 回退后 anchor 填回（app.tsx:1101 setInputValue(anchor)
 *    走 setState）与 submit 清空（app.tsx:1109 setInputValue("") 走 setText
 *    空串 + gotoBufferEnd no-op）均经同一受控同步 effect，分别见 (i)/(j)。
 *
 * 本文件把边界补全为回归套件：
 *  (a) wrap 跨 unwrap 边界：文本恰好 2 视觉行，backspace 到缩回 1 行的那
 *      一击，光标必须仍在文本末尾（offset = 新宽度列，非 0）；
 *  (b) 真实换行（Shift+Enter 产 \n）多行 backspace 跨行边界 → 光标不跳头；
 *  (c) 单行 backspace 不回归（光标正常后退）；
 *  (d) wrap 多行内部 backspace（不跨边界）光标正常（固化防回归）；
 *  (e) 程序写入（历史召回 ↑）→ 光标在末尾（setText 归零回归）；
 *  (f) 程序写入（Tab 补全）→ 光标在末尾（setText 归零回归）；
 *  (g) 单行程序写入 → 光标也在末尾（不回归，轮询等待降低并行 flaky）；
 *  (h) 程序写入（paste 多行追加）→ 光标在末尾（usePaste setState 触发
 *      setText 回归；pasteBracketedText 实测保留 \n 走末尾追加语义，
 *      plainText = "ab历\n史\n回\n退"）；
 *  (i) 程序写入（anchor 填回，长多行）→ 光标在末尾（组件级 setState 模拟
 *      app.tsx:1101，因 rewind 端到端需会话+checkpoint+picker UI 联动，
 *      单元级直接验证受控同步 effect 等价）；
 *  (j) submit 清空（Enter 提交）→ setInputValue("") → setText 空串 +
 *      gotoBufferEnd no-op → offset 0，文本 0，无 crash。
 *
 * 观察手段：walk renderer.root 找 textarea renderable（plainText +
 * visualCursor），直查 `offset`/`visualCol`（screen cursorState 只能拿到
 * 屏幕坐标，受 chrome 布局/滚动影响，不够精确）。
 *
 * offset 语义（实测）：visualCursor.offset = 文本宽列（CJK 1 字=2 列，
 * "abc"→3，"历史消息二"→10，"第一行\n第二行"→13）。文本末尾 offset =
 * 每行宽度列之和 + 换行符数。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useState } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { PromptInput } from "../../src/tui/prompt-input.js";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

interface TaSnapshot {
  textLen: number;
  offset: number;
  visualCol: number;
  height: number;
}

function walk(
  r: unknown,
  pred: (r: Record<string, unknown>) => boolean,
  depth = 0,
  out: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (!r || typeof r !== "object") return out;
  const rr = r as Record<string, unknown>;
  if (pred(rr)) out.push(rr);
  if (depth > 12) return out;
  const children = rr.getChildren?.();
  if (Array.isArray(children)) {
    for (const c of children) walk(c, pred, depth + 1, out);
  }
  return out;
}

function taSnapshot(setup: TestRendererSetup): TaSnapshot[] {
  const tas = walk(
    setup.renderer.root,
    (r) => "plainText" in r && "visualCursor" in r
  );
  return tas.map((t) => {
    const vc = (
      t as unknown as { visualCursor: { offset: number; visualCol: number } }
    ).visualCursor;
    return {
      textLen: (t.plainText as string).length,
      offset: vc.offset,
      visualCol: vc.visualCol,
      height: (t as unknown as { height?: unknown }).height as number,
    };
  });
}

async function settle(setup: TestRendererSetup, ms = 120): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
  await setup.renderOnce();
}

/**
 * 轮询式等待：直到 textarea 快照满足断言或超时（默认 2000ms，25ms 间隔）。
 * 替代固定 sleep —— 并行全量下新用例 (g) 偶发时序抖动源于固定 sleep 不足
 * （effect/setState 流未 flush 完就读快照）；轮询等到真实条件成立才能稳。
 *
 * 只在新用例与 (g) 处替换 settle；其余已有用例的 settle 路径不动。
 */
async function waitUntil(
  setup: TestRendererSetup,
  pred: (snaps: TaSnapshot[]) => boolean,
  label: string,
  timeoutMs = 2000,
  intervalMs = 25
): Promise<TaSnapshot[]> {
  const start = Date.now();
  let last: TaSnapshot[] = [];
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    await setup.renderOnce();
    last = taSnapshot(setup);
    if (pred(last)) return last;
  }
  throw new Error(`waitUntil timeout (${label}): ${JSON.stringify(last)}`);
}

interface MountCtx {
  readonly bridge: TuiBridge;
  readonly setup: TestRendererSetup;
  readonly destroy: () => Promise<void>;
}

async function mount(): Promise<MountCtx> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-tui-bs-"));
  const bridge = createTuiBridge({
    dataDir,
    workspaceRoot: dataDir,
    deps: makeDeps([assistantResult({ texts: [] })]),
    inflight: createInflightRegistry(),
  });
  let setupRef: TestRendererSetup | undefined;
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      onQuit={() => {
        if (setupRef && !setupRef.renderer.isDestroyed)
          setupRef.renderer.destroy();
      }}
    />,
    {
      width: 80,
      height: 30,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    }
  );
  setupRef = setup;
  await new Promise((r) => setTimeout(r, 300));
  await setup.waitForVisualIdle();
  return {
    bridge,
    setup,
    destroy: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    },
  };
}

describe("输入框 backspace 光标不跳头（2026-08-15 用户反馈）", () => {
  test("(c) 单行输入 backspace：光标正常后退", async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("abc");
      await settle(app.setup);
      const before = taSnapshot(app.setup)[0];
      expect(before.offset).toBe(3);

      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // 删 1 字符，光标停在末尾（offset=2，非 0）。
      expect(after.textLen).toBe(2);
      expect(after.offset).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(d) wrap 多行内部 backspace：光标正常后退（不跨 unwrap 边界）", async () => {
    const app = await mount();
    try {
      // 39 CJK 全角 → 视觉宽 78 > inner 74 → wrap 2 行（实测）。
      const cjk =
        "的换行行为是否正确本汉字序列测试一下长文本的换行行为是否正确汉字序列测试一下长";
      await app.setup.mockInput.typeText(cjk, 0);
      await settle(app.setup);
      const before = taSnapshot(app.setup)[0];
      // 39 字符；offset=78 = 文本宽列（CJK 1 字=2 列），wrap 2 行。
      expect(before.textLen).toBe(39);
      expect(before.offset).toBe(78);
      expect(before.height).toBe(2);

      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // 删 1 CJK，仍在 wrap 2 行内，光标停在末尾（offset=76，非 0）。
      expect(after.textLen).toBe(38);
      expect(after.offset).toBe(76);
      expect(after.height).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(a) wrap 跨 unwrap 边界 backspace：光标仍停在文本末尾（不跳头）", async () => {
    const app = await mount();
    try {
      // 用较短的超长文本把 wrap 行数压到 2，并让删 1 个 CJK 后恰好退回 1 行。
      // innerCols = 80 - 6 = 74；需 visualWidth(文本) > 74 但 visualWidth(删尾1) <= 74。
      // visualWidth 为偶数，取 76：文本 38 个 CJK（宽 76 → 2 行），删 1 个后 74 → 1 行。
      // base 33 字 → 补 5 个「换」垫到 38 字（实测：38 字宽 76 = 2 行；
      // 删 1 → 37 字宽 74 = 恰 1 行）。
      const base =
        "本汉字序列测试一下长文本的换行行为是否正确本汉字序列测试一下长文本";
      const cjk = (base + "换换换换换").slice(0, 38);
      expect(cjk.length).toBe(38);
      const beforeType = taSnapshot(app.setup)[0];
      expect(beforeType.textLen).toBe(0);

      await app.setup.mockInput.typeText(cjk, 0);
      await settle(app.setup);
      const full = taSnapshot(app.setup)[0];
      expect(full.textLen).toBe(38);
      expect(full.offset).toBe(76);
      expect(full.height).toBe(2);

      // 删 1 个 CJK → 视觉宽 74 = innerCols → 恰好缩回 1 行（unwrap 边界）。
      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const unwrapped = taSnapshot(app.setup)[0];
      expect(unwrapped.textLen).toBe(37);
      expect(unwrapped.height).toBe(1);
      // 回归断言：光标必须仍在文本末尾（offset=74，非 0）。
      expect(unwrapped.offset).toBe(74);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(b) 真实换行（Shift+Enter 产 \\n）backspace 跨行边界：光标停在合并行末尾", async () => {
    const app = await mount();
    try {
      // 第一行短文本 + Shift+Enter 换行 → 光标停在 \n 后（新行行首，实测
      // visualRow=1 visualCol=0 offset=7）；此时 backspace 即删 \n 跨行。
      await app.setup.mockInput.typeText("第一行");
      await settle(app.setup);
      app.setup.mockInput.pressEnter({ shift: true });
      await settle(app.setup);

      const before = taSnapshot(app.setup)[0];
      // 内容 = "第一行\n"：字符数 4；offset=7 = 6+1（CJK 双宽 + \n 1 列）。
      expect(before.textLen).toBe(4);
      expect(before.offset).toBe(7);
      expect(before.height).toBe(2);

      // 光标在 \n 后（新行行首），backspace → 删 \n，两行合并，光标停合并行末尾。
      app.setup.mockInput.pressBackspace();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      expect(after.textLen).toBe(3); // "第一行" 3 个字符
      expect(after.height).toBe(1);
      // 不跳头：offset=6（3 字 × 2 列）是文本末尾。
      expect(after.offset).toBe(6);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(e) 程序写入（↑ 历史召回多行）→ 光标在末尾（setText 归零回归）", async () => {
    const app = await mount();
    try {
      // 种一条多行历史：Shift+Enter 换行 + Enter 提交 → handleSubmit 入历史。
      await app.setup.mockInput.typeText("历史第一行");
      await settle(app.setup);
      app.setup.mockInput.pressEnter({ shift: true });
      await settle(app.setup);
      await app.setup.mockInput.typeText("历史第二行");
      await settle(app.setup);
      app.setup.mockInput.pressEnter();
      await settle(app.setup, 300);

      // 空输入下 ↑ 召回 → props.onChange(历史多行) → setText + gotoBufferEnd。
      app.setup.mockInput.pressArrow("up");
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // 内容 = "历史第一行\n历史第二行"：字符数 5+1+5 = 11；末尾 offset = 10+1+10 = 21 列。
      expect(after.textLen).toBe(11);
      expect(after.offset).toBe(21);
      expect(after.height).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(f) 程序写入（Tab 补全）→ 光标在末尾（setText 归零回归）", async () => {
    const app = await mount();
    try {
      // "/hel" 唯一匹配 → Tab 补全为 "/help "（全量替换路径）。
      await app.setup.mockInput.typeText("/hel", 0);
      await settle(app.setup);
      app.setup.mockInput.pressTab();
      await settle(app.setup);
      const after = taSnapshot(app.setup)[0];
      // 内容 "/help "：6 字符；末尾 offset = 6（全 ASCII）。
      expect(after.textLen).toBe(6);
      expect(after.offset).toBe(6);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(g) 单行程序写入 → 光标也在末尾（不回归）", async () => {
    const app = await mount();
    try {
      // 种一条单行历史。
      await app.setup.mockInput.typeText("历史消息");
      await settle(app.setup);
      app.setup.mockInput.pressEnter();
      await settle(app.setup, 300);

      // ↑ 召回单行历史 → setText + gotoBufferEnd。
      app.setup.mockInput.pressArrow("up");
      // 轮询等待替换固定 sleep：并行全量下 (g) 曾偶发在 effect/setState 流
      // 尚未 flush 完就读到旧快照而失败，等 textLen 到 4 才继续。
      const after = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 4 && snaps[0]?.offset === 8,
        "(g) 单行召回后光标在末尾"
      );
      expect(after[0].textLen).toBe(4);
      // 4 字 × 2 列 = 8，光标在末尾非 0。
      expect(after[0].offset).toBe(8);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(h) 程序写入（paste 多行追加）→ 光标在末尾（usePaste setState 触发 setText 回归）", async () => {
    const app = await mount();
    try {
      // 真实 paste 事件（pasteBracketedText 发 bracketed-paste 序列，走
      // app.tsx:586 usePaste setInputValue(prev => prev + text) setState）。
      // 实测保留 \n：plainText = "ab历\n史\n回\n退"，末尾追加语义。
      await app.setup.mockInput.typeText("ab", 0);
      await settle(app.setup);
      expect(taSnapshot(app.setup)[0].offset).toBe(2);

      await app.setup.mockInput.pasteBracketedText("历\n史\n回\n退");
      const after = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 9,
        "(h) paste 多行追加后光标在末尾"
      );
      const snap = after[0];
      // 内容 "ab历\n史\n回\n退"：9 字符（2 ASCII + 4 CJK + 3 \n）。
      expect(snap.textLen).toBe(9);
      // 末尾 offset = 2(ab) + 2+1+2+1+2+1+2("历\n史\n回\n退" 宽) = 13 列；非 0。
      expect(snap.offset).toBe(13);
      // 视觉末行首列（"退" CJK 宽 2），光标真在最后一行末尾。
      expect(snap.visualCol).toBe(2);
    } finally {
      await app.destroy();
    }
  }, 30_000);

  test("(i) 程序写入（anchor 填回，长多行）→ 光标在末尾（setText 归零回归）", async () => {
    // rewind 端到端需 会话文件 + checkpoint + rewind picker UI 联动，且
    // app.tsx:1101 只是 setInputValue(anchorTextForInput) 的 setState —— 与
    // 本组件受控同步 effect 的交互等价。此处组件级直接 render PromptInput +
    // 外部改 value 模拟该程序写入路径，聚焦断言「setText + gotoBufferEnd 后
    // 光标在末尾」这一回归点（历史召回 (e)/(g) 已覆盖同 effect 端到端路径）。
    let fill: ((s: string) => void) | null = null;
    function Harness() {
      const [v, setV] = useState("");
      fill = setV;
      return (
        <PromptInput
          value={v}
          cols={80}
          active
          onChange={setV}
          onSubmit={() => {}}
        />
      );
    }
    const setup = await testRender(<Harness />, {
      width: 80,
      height: 10,
      exitOnCtrlC: false,
      consoleMode: "disabled",
      kittyKeyboard: true,
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      await setup.renderOnce();

      // 长多行 anchor（3 行 CJK）填回 —— setState → setText + gotoBufferEnd。
      const ANCHOR = "锚点第一行\n锚点第二行\n锚点第三行";
      fill!(ANCHOR);
      const after = await waitUntil(
        setup,
        (snaps) => snaps[0]?.textLen === 17,
        "(i) anchor 填回后光标在末尾"
      );
      const snap = after[0];
      // "锚点第一行\n锚点第二行\n锚点第三行" = 5+1+5+1+5 = 17 字符。
      expect(snap.textLen).toBe(17);
      // 末尾 offset = 10+1+10+1+10 = 32 列；非 0（setText 归零回归）。
      expect(snap.offset).toBe(32);
      // 视觉末行首列（"锚点第三行" 首字），证明光标真在最后一行不是恰巧在
      // 某行行首。
      expect(snap.visualCol).toBe(10);
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  }, 15_000);

  test('(j) submit 清空 → setText("") + gotoBufferEnd no-op → offset 0 不 crash', async () => {
    const app = await mount();
    try {
      await app.setup.mockInput.typeText("abc", 0);
      await settle(app.setup);
      expect(taSnapshot(app.setup)[0].offset).toBe(3);

      // Enter 提交 → app.tsx:1109 setInputValue("") → setText("") +
      // gotoBufferEnd（空串上 no-op）。空消息 no-op（handleSubmit 早退），
      // 不产生辅助内容。
      app.setup.mockInput.pressEnter();
      const after = await waitUntil(
        app.setup,
        (snaps) => snaps[0]?.textLen === 0 && snaps[0]?.offset === 0,
        "(j) submit 清空后 offset 0"
      );
      expect(after[0].textLen).toBe(0);
      expect(after[0].offset).toBe(0);
    } finally {
      await app.destroy();
    }
  }, 30_000);
});
