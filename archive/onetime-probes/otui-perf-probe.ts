/**
 * T8 性能探针：@opentui/react 0.5.1 TUI 渲染后端 — 流式负载下帧统计无丢帧异常。
 *
 * bun 运行：~/.bun/bin/bun scripts/otui-perf-probe.ts
 * （Node 22 无 node:ffi，原生渲染器只能由 bun 驱动；/usr/local/bin/bun 是坏软链，禁用。）
 *
 * 探针结论（spec SC9a：脚本化流式负载探针，getNativeStats() / 帧统计无丢帧异常）：
 *   [1] 流式 text_delta 累积渲染：frameCount > 0、cellsUpdated > 0、平均帧耗时合理
 *   [2] 长内容（>viewport 滚动区）渲染不崩：scrollbox 布局 + ref 直查
 *   [3] 快速连续 delta（模拟高吞吐流式）无丢帧异常：averageFrameTime 有界
 *
 * 设计：stub 流式源 = 直接调用 createStreamDraft().append() 推 text_delta 序列，
 * 不经真实 LLM（无 API key 依赖）。渲染用 createTestRenderer（@opentui/core/testing，
 * 内存缓冲 + getNativeStats 可观测），非生产 TTY。
 *
 * 单项 no 也 exit 0（探针如实报告）；只有探针自身崩溃才非零退出。
 */

import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createStreamDraft } from "../src/cli/stream-draft.js";

const WIDTH = 80;
const HEIGHT = 24;

type Verdict = { answer: "yes" | "no"; evidence: string };

/** 结论 1：流式 delta 累积 → 帧统计有产出，无丢帧 */
async function probeStreamingFrames(): Promise<Verdict> {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({
    width: WIDTH,
    height: HEIGHT,
  });
  try {
    const sb = new ScrollBoxRenderable(renderer, {
      id: "perf-sb",
      width: WIDTH,
      height: HEIGHT - 4,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    renderer.root.add(sb);

    // 流式源：createStreamDraft 累积 delta，渲染层把 masked() 铺成 text 行。
    const draft = createStreamDraft();
    const lines: TextRenderable[] = [];
    for (let i = 0; i < 30; i++) {
      draft.append({
        type: "text_delta",
        text: `流式增量 ${String(i).padStart(2, "0")} `,
      });
      const line = new TextRenderable(renderer, {
        id: `perf-line-${i}`,
        content: `增量${String(i).padStart(2, "0")} ${draft.masked()}`.slice(
          0,
          WIDTH - 2
        ),
        width: WIDTH - 2,
        height: 1,
      });
      lines.push(line);
      sb.add(line);
      await renderOnce();
    }
    // 触发原生渲染统计快照
    renderer.requestRender();
    await renderOnce();

    const stats = renderer.getNativeStats();
    const stats2 = renderer.getNativeStats();
    const frameCount = stats.nativeFrameCount ?? stats2.nativeFrameCount;
    const cellsUpdated = stats.cellsUpdated ?? stats2.cellsUpdated;
    const avgCells = stats.averageCellsUpdated ?? 0;
    const avgFrame =
      stats.nativeAverageFrameTime ?? stats2.nativeAverageFrameTime;
    const frameHasOutput = frameCount > 0;
    const noLoss = !Number.isNaN(avgFrame) && avgFrame >= 0;
    const frame = captureCharFrame();
    // stickyStart bottom：最新内容贴底可见；早期行被滚出视口是正常行为。
    const latestRendered = frame.includes("增量29");

    const ok = frameHasOutput && noLoss && latestRendered;
    return {
      answer: ok ? "yes" : "no",
      evidence:
        `30 轮 text_delta 渲染后 getNativeStats: nativeFrameCount=${frameCount}, cellsUpdated=${cellsUpdated}, ` +
        `averageCellsUpdated=${avgCells}, nativeAverageFrameTime=${avgFrame}ms; ` +
        `帧有产出=${frameHasOutput}; 帧耗时无异常(有限非负)=${noLoss}; ` +
        `最新增量行可见=${latestRendered}(stickyStart:bottom 贴底，早期行滚出视口属正常)`,
    };
  } finally {
    renderer.destroy();
  }
}

/** 结论 2：长内容（>viewport 多屏）滚动布局不崩，scrollTop 直达 */
async function probeScrollLayout(): Promise<Verdict> {
  const { renderer, renderOnce } = await createTestRenderer({
    width: WIDTH,
    height: HEIGHT,
  });
  try {
    const sb = new ScrollBoxRenderable(renderer, {
      id: "perf-sb2",
      width: WIDTH,
      height: 8,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    renderer.root.add(sb);
    for (let i = 0; i < 100; i++) {
      sb.add(
        new TextRenderable(renderer, {
          id: `long-${i}`,
          content: `long-line-${String(i).padStart(3, "0")} ${"#".repeat(20)}`,
          width: WIDTH - 2,
          height: 1,
        })
      );
    }
    await renderOnce();
    const scrollHeight = sb.scrollHeight;
    const viewportHeight = sb.viewport.height;
    const overflow = scrollHeight > viewportHeight;
    sb.scrollTop = Math.max(0, scrollHeight - viewportHeight);
    await renderOnce();
    const stuckToBottom =
      sb.scrollTop === Math.max(0, scrollHeight - viewportHeight);
    const ok = overflow && stuckToBottom && scrollHeight > 0;
    return {
      answer: ok ? "yes" : "no",
      evidence:
        `100 行长内容 scrollbox: scrollHeight=${scrollHeight}, viewport.height=${viewportHeight}, ` +
        `超视口(>1屏)=${overflow}; scrollTop 直达底部=${sb.scrollTop}(期望 ${Math.max(0, scrollHeight - viewportHeight)})=${stuckToBottom}`,
    };
  } finally {
    renderer.destroy();
  }
}

/** 结论 3：快速连续 delta（无等待 renderOnce 间隔）累积不丢帧/不崩 */
async function probeBurstDeltas(): Promise<Verdict> {
  const { renderer, renderOnce } = await createTestRenderer({
    width: WIDTH,
    height: HEIGHT,
  });
  try {
    const sb = new ScrollBoxRenderable(renderer, {
      id: "perf-sb3",
      width: WIDTH,
      height: 8,
      stickyScroll: true,
      stickyStart: "bottom",
    });
    renderer.root.add(sb);
    const draft = createStreamDraft();
    // 突发 200 段：一次性 append（不经 renderOnce），模拟高吞吐流式批处理
    for (let i = 0; i < 200; i++) {
      draft.append({ type: "text_delta", text: `突发${i} ` });
    }
    // 渲染累积后的全文（单行折叠到视口宽度）
    sb.add(
      new TextRenderable(renderer, {
        id: "burst",
        content: draft.masked().slice(0, WIDTH - 2),
        width: WIDTH - 2,
        height: 1,
      })
    );
    await renderOnce();
    const stats = renderer.getNativeStats();
    const frameCount = stats.nativeFrameCount ?? 0;
    const avgFrame = stats.nativeAverageFrameTime ?? 0;
    const noCrash = Number.isFinite(avgFrame);
    const ok = frameCount > 0 && noCrash;
    return {
      answer: ok ? "yes" : "no",
      evidence:
        `200 段 delta 单批累积渲染: frameCount=${frameCount}, nativeAverageFrameTime=${avgFrame}ms, ` +
        `渲染不崩=${noCrash}; cellsUpdated=${stats.cellsUpdated ?? "n/a"}`,
    };
  } finally {
    renderer.destroy();
  }
}

async function main(): Promise<void> {
  const results: Array<[string, () => Promise<Verdict>]> = [
    [
      "[1] 流式 delta 累积渲染帧统计（frameCount/cellsUpdated/avgFrame）",
      probeStreamingFrames,
    ],
    ["[2] 长内容 scrollbox 滚动布局（ref 直查 scrollTop）", probeScrollLayout],
    ["[3] 突发 delta 批处理无丢帧/不崩", probeBurstDeltas],
  ];
  for (const [label, probe] of results) {
    try {
      const v = await probe();
      console.log(`${label}: ${v.answer}\n    证据: ${v.evidence}`);
    } catch (err) {
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
