/**
 * D3 能力探针：@opentui/core@0.5.1 TUI 迁移三项能力裁决。
 *
 * bun 运行：~/.bun/bin/bun scripts/otui-capability-probe.ts
 * （Node 22 无 node:ffi，原生渲染器只能由 bun 驱动；/usr/local/bin/bun 是坏软链，禁用。）
 *
 * 探针结论（每项 yes/no + 证据；单项 no 也 exit 0，只有探针自身崩溃才非零）：
 *   [1] ScrollBoxRenderable stickyScroll 智能模式：上滚暂停 auto-scroll、回底恢复
 *   [2] TextRenderable selectable 下 CJK 双宽字符选区对齐
 *   [3] selection 剪贴板通道：OSC52 自动写 vs 需应用层接线
 */

import { Writable } from "node:stream";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

const WIDTH = 40;
const HEIGHT = 12;

type Verdict = { answer: "yes" | "no"; evidence: string };

function firstVisibleLine(frame: string): string | null {
  const m = frame.match(/line-(\d+)/);
  return m ? m[0] : null;
}

function lastVisibleLine(frame: string): string | null {
  const matches = [...frame.matchAll(/line-(\d+)/g)];
  return matches.length > 0 ? matches[matches.length - 1][0] : null;
}

/** 结论 1：stickyScroll 智能模式 */
async function probeStickyScroll(): Promise<Verdict> {
  const { renderer, mockMouse, renderOnce, captureCharFrame } =
    await createTestRenderer({
      width: WIDTH,
      height: HEIGHT,
    });
  try {
    // stickyScroll 默认 false，必须显式 opt-in；stickyStart "bottom" = 聊天流场景
    const sb = new ScrollBoxRenderable(renderer, {
      id: "probe-sb",
      width: WIDTH,
      height: 8,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    renderer.root.add(sb);

    const makeLine = (n: number) =>
      new TextRenderable(renderer, {
        id: `line-${n}`,
        content: `line-${String(n).padStart(2, "0")} ${"#".repeat(20)}`,
        width: WIDTH - 2,
        height: 1,
      });

    for (let i = 1; i <= 30; i++) sb.add(makeLine(i));
    await renderOnce();
    const frameAtBottom = captureCharFrame();
    const stuckToBottom = lastVisibleLine(frameAtBottom) === "line-30";

    // 用户上滚：优先 mockMouse 滚轮；hit-test/焦点不通则回退 scrollTop setter
    let scrollMethod = "mockMouse.scroll(wheel-up)";
    for (let i = 0; i < 5; i++) await mockMouse.scroll(5, 4, "up");
    await renderOnce();
    if (sb.scrollTop === 0) {
      scrollMethod = "scrollTop setter fallback (wheel 未驱动)";
      sb.scrollTop = Math.max(1, sb.scrollHeight - 8 - 10);
    }
    const scrolledUp = sb.scrollTop > 0;
    const userTopLine = firstVisibleLine(captureCharFrame());

    // 追加新内容：智能模式应停在用户位置，不跳底
    for (let i = 31; i <= 40; i++) sb.add(makeLine(i));
    await renderOnce();
    const frameAfterAppend = captureCharFrame();
    const stayedAtUserPosition =
      userTopLine !== null &&
      firstVisibleLine(frameAfterAppend) === userTopLine &&
      lastVisibleLine(frameAfterAppend) !== "line-40";

    // 回底（reengage point）：sticky 恢复，追加内容应跟随到底
    sb.scrollTop = Math.max(0, sb.scrollHeight - sb.viewport.height);
    await renderOnce();
    for (let i = 41; i <= 45; i++) sb.add(makeLine(i));
    await renderOnce();
    const resumedFollow = lastVisibleLine(captureCharFrame()) === "line-45";

    const ok =
      stuckToBottom && scrolledUp && stayedAtUserPosition && resumedFollow;
    return {
      answer: ok ? "yes" : "no",
      evidence:
        `ScrollBoxRenderable(stickyScroll:true, stickyStart:"bottom") 初始贴底=${stuckToBottom}; ` +
        `上滚(${scrollMethod})后 scrollTop=${sb.scrollTop}>0=${scrolledUp}; ` +
        `追加10行后停留在 ${firstVisibleLine(frameAfterAppend)}(期望 ${userTopLine})=${stayedAtUserPosition}; ` +
        `回底后追加5行跟随到 line-45=${resumedFollow}。` +
        `机制：_hasManualScroll 暂停 + isAtStickyReengagePoint(±1 行容差) 恢复；stickyScroll 默认 false 需显式开启`,
    };
  } finally {
    renderer.destroy();
  }
}

/** 结论 2：selectable CJK 双宽选择 */
async function probeCjkSelection(): Promise<Verdict> {
  const { renderer, mockMouse, renderOnce, captureCharFrame, captureSpans } =
    await createTestRenderer({
      width: 30,
      height: 4,
    });
  try {
    const text = new TextRenderable(renderer, {
      id: "probe-cjk",
      content: "你好世界Hello",
      width: 30,
      height: 1,
      selectable: true,
      selectionBg: "#0055aa",
    });
    renderer.root.add(text);
    await renderOnce();
    const frameBefore = captureCharFrame();
    const rendersIntact = frameBefore.includes("你好世界Hello");

    // 拖选列 0..3：双宽字符下应恰好覆盖「你好」（你=0-1列，好=2-3列）
    await mockMouse.drag(0, 0, 3, 0);
    await renderOnce();
    const sel = renderer.getSelection();
    const selectedText = sel?.getSelectedText() ?? "";
    const alignedWholeChars = selectedText === "你好";

    // 选区高亮应恰好覆盖「你好」（width=4 列）：captureSpans 结构 { spans: [{ text, bg, width }] }
    let highlightText = "";
    let highlightWidth = -1;
    try {
      const spans = captureSpans();
      const line = spans.lines[0] as {
        spans?: Array<{
          text: string;
          width: number;
          bg?: { buffer?: Record<string, number> };
        }>;
      };
      for (const span of line.spans ?? []) {
        const b = span.bg?.buffer;
        // selectionBg #0055aa → (0,85,170)
        if (b && b["1"] === 85 && b["2"] === 170) {
          highlightText = span.text;
          highlightWidth = span.width;
        }
      }
    } catch {
      // spans 结构随版本变化，忽略
    }
    const highlightAligned = highlightText === "你好" && highlightWidth === 4;

    // 半字起点拖选（列 1..4，「你」中间起步）：选文必须是原文的完整子串，不得出现半个字符
    await mockMouse.click(20, 3); // 清选区
    await renderOnce();
    await mockMouse.drag(1, 0, 4, 0);
    await renderOnce();
    const midDragText = renderer.getSelection()?.getSelectedText() ?? "";
    const midDragWholeChars =
      midDragText.length > 0 &&
      "你好世界Hello".includes(midDragText.trim() || midDragText);
    const frameAfter = captureCharFrame();
    const stillIntact = frameAfter.includes("你好世界Hello");

    const ok =
      rendersIntact && alignedWholeChars && highlightAligned && stillIntact;
    return {
      answer: ok ? "yes" : "no",
      evidence:
        `captureCharFrame 原文完整=${rendersIntact}; drag(0→3 列) getSelectedText()=${JSON.stringify(selectedText)}(期望"你好")=${alignedWholeChars}; ` +
        `高亮 span=${JSON.stringify(highlightText)} width=${highlightWidth}(期望"你好"/4 列)=${highlightAligned}; ` +
        `半字起点 drag(1→4 列) 选文=${JSON.stringify(midDragText)} 无半字=${midDragWholeChars}; ` +
        `选后帧文本仍完整=${stillIntact}`,
    };
  } finally {
    renderer.destroy();
  }
}

class RecordingStream extends Writable {
  readonly isTTY = true;
  readonly columns: number;
  readonly rows: number;
  chunks: Buffer[] = [];
  constructor(columns = 40, rows = 8) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  override _write(
    chunk: unknown,
    _enc: BufferEncoding,
    cb: (error?: Error | null) => void
  ): void {
    this.chunks.push(Buffer.from(chunk as Uint8Array));
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
  getColorDepth(): number {
    return 24;
  }
}

/** 结论 3：selection 剪贴板通道 */
async function probeClipboardChannel(): Promise<Verdict> {
  const stdout = new RecordingStream(30, 4);
  // bufferedOutput:"stdout" 走 NativeSpanFeed → 原生输出（含 OSC52）会经 JS 流可观测；
  // 测试默认 "memory" 模式下原生输出留在内存，观察不到字节。
  const { renderer, mockMouse, renderOnce } = await createTestRenderer({
    width: 30,
    height: 4,
    stdout: stdout as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
  });
  try {
    const text = new TextRenderable(renderer, {
      id: "probe-copy",
      content: "copy-me 复制",
      width: 30,
      height: 1,
      selectable: true,
    });
    renderer.root.add(text);
    await renderOnce();

    // 不接任何应用层复制：拖选完成后看输出流有无 OSC52 → 判断是否自动写
    const selectionEvents: string[] = [];
    renderer.on("selection", (sel: { getSelectedText(): string }) => {
      selectionEvents.push(sel.getSelectedText());
      // 故意不调用 copyToClipboardOSC52，验证自动性
    });
    await mockMouse.drag(0, 0, 6, 0);
    await renderOnce();
    await new Promise((r) => setTimeout(r, 80)); // feed 异步落流
    const autoOsc52 = stdout.text().includes("\u001b]52;");
    const eventFired = selectionEvents.length > 0;

    // 应用层接线：selection 事件回调里调 copyToClipboardOSC52
    const osc52Supported = renderer.isOsc52Supported();
    const copied = renderer.copyToClipboardOSC52(
      selectionEvents[0] ?? "copy-me"
    );
    await renderOnce();
    await new Promise((r) => setTimeout(r, 80));
    const wiredOsc52 = stdout.text().includes("\u001b]52;");

    const channel = autoOsc52
      ? "OSC52 自动写"
      : eventFired
        ? '需应用层接线：renderer.on("selection") → selection.getSelectedText() → renderer.copyToClipboardOSC52(text)'
        : "未知（selection 事件未触发）";
    const ok = eventFired && (autoOsc52 || (copied && wiredOsc52));
    const osc52Seq = stdout
      .text()
      .match(/\u001b\]52;[^\u0007\u001b]*(?:\u001b\\|\u0007)?/)?.[0];
    return {
      answer: ok ? "yes" : "no",
      evidence:
        `通道=${channel}; 无接线时 OSC52 自动出现=${autoOsc52}; "selection" 事件触发=${eventFired}(选文=${JSON.stringify(selectionEvents[0] ?? null)}); ` +
        `copyToClipboardOSC52() 返回=${copied}, isOsc52Supported()=${osc52Supported}, 接线后 OSC52 写入输出流=${wiredOsc52}` +
        (osc52Seq ? `, 实际序列=${JSON.stringify(osc52Seq.slice(0, 40))}` : ""),
    };
  } finally {
    renderer.destroy();
  }
}

async function main(): Promise<void> {
  const results: Array<[string, () => Promise<Verdict>]> = [
    ["[1] stickyScroll 智能模式（上滚暂停/回底恢复）", probeStickyScroll],
    ["[2] <text selectable> CJK 双宽选择对齐", probeCjkSelection],
    ["[3] selection 剪贴板通道", probeClipboardChannel],
  ];
  for (const [label, probe] of results) {
    try {
      const v = await probe();
      console.log(`${label}: ${v.answer}\n    证据: ${v.evidence}`);
    } catch (err) {
      // 单项探针崩溃不算探针整体失败，如实报告 no + 错误
      console.log(
        `${label}: no\n    证据: 探针执行异常: ${err instanceof Error ? err.stack : String(err)}`
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("探针自身崩溃:", err);
    process.exit(1);
  });
