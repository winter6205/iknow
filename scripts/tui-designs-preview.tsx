/** @jsxImportSource @opentui/react */
/**
 * Preview entry for the 5 thinking-panel design variants.
 *
 * Boots a minimal OpenTUI render loop: the selected thinking design panel
 * on the left (driven by live interaction), design metadata on the right.
 * Keys 1-5 switch designs; q or Esc quits.
 *
 * Usage:
 *   $HOME/.bun/bin/bun run scripts/tui-designs-preview.ts
 *
 * Deliberately decoupled from the product TUI entry (src/tui/run.tsx):
 * bootstrap a renderer and mount DesignGallery only, with zero business
 * context (no session / bridge / deps).
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
