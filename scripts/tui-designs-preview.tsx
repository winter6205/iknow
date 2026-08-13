/** @jsxImportSource @opentui/react */
/**
 * scripts/tui-designs-preview.ts — 思考面板 5 版设计 demo 预览入口。
 *
 * 启动一个最小的 OpenTUI 渲染循环，左侧铺当前选中的 thinking design
 * 面板（实时受交互驱动），右侧展示设计元数据。数字键 1-5 切换设计，
 * 字母 q 或 Esc 退出。
 *
 * 用法：
 *   $HOME/.bun/bin/bun run scripts/tui-designs-preview.ts
 *
 * 与 TUI 产品入口（src/tui/run.tsx）解耦：仅 bootstrap 渲染器 + 挂载
 * DesignGallery，零业务上下文（无 session / no bridge / no deps）。
 */
import { createCliRenderer, CliRenderEvents } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { DesignGallery } from "../src/tui/designs/gallery.js";

const RENDERER_CONFIG = {
  exitOnCtrlC: true,
  screenMode: "alternate-screen" as const,
};

const renderer = await createCliRenderer(RENDERER_CONFIG);
const root = createRoot(renderer);
const cols = renderer.width;

let destroyed = false;
const quit = (): void => {
  if (destroyed) return;
  destroyed = true;
  try {
    renderer.destroy();
  } catch {
    // ignore double destroy
  }
};

root.render(<DesignGallery cols={cols} onQuit={quit} />);

await new Promise<void>((resolve) => {
  renderer.once(CliRenderEvents.DESTROY, () => resolve());
});
