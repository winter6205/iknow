/** @jsxImportSource @opentui/react */
/**
 * tests/tui/_fixtures.tsx
 *
 * Shared fixture for TUI end-to-end test assembly. Earlier tests rendered
 * `<TuiApp />` bare (banner / input-stub views only); once TuiApp fully wires
 * the state machine / slash / hub streaming, mounting requires
 * bridge/askBridge/toolEventSink/permissionMode/sessionGrants. This fixture
 * builds a minimal working stub assembly:
 *  - a real createInflightRegistry instance (deps/soleId pass);
 *  - makeDeps([]) stub LoopEngineDeps (hub issues no real network requests; a
 *    turn with no response settles, so it is fine for "mount + static UI
 *    assertion" cases);
 *  - createTuiAskUserBridge / createToolEventSink / default permission mode
 *    / empty sessionGrants;
 *  - default cwd/dataDir (test cwd).
 *
 * End-to-end turn streaming / slash / modal cases should build their own
 * assembly (in-memory adapter + custom stub model) — see
 * `tests/tui/app.test.tsx`.
 *
 * It also owns the render-tree readers (`findComposerTextArea`, `composerText`):
 * the composer's live buffer is what every draft / paste / copy case asserts
 * on, so the walker that finds the textarea stays here instead of being pasted
 * into each file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactNode } from "react";
import type { TestRendererSetup } from "@opentui/core/testing";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import {
  createToolEventSink,
  TuiApp,
  type ClipboardImageReader,
} from "../../src/tui/app.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import type { SkillCatalog } from "../../src/harness/skill/catalog.js";
import type { TuiMcpViewExt } from "../../src/tui/deps.js";
import type { CliRenderer } from "@opentui/core";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

/**
 * React reads this flag off globalThis to decide whether `act` is legal.
 * `@types/react` 19 does not declare it, so the render-smoke tests reach it
 * through a typed view instead of an untyped globalThis index.
 */
const reactActEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };

/** Enable/disable React's act environment (render-smoke harnesses bracket a mount with it). */
export function setReactActEnvironment(enabled: boolean): void {
  reactActEnv.IS_REACT_ACT_ENVIRONMENT = enabled;
}

/**
 * Run exactly one render-loop pass. `CliRenderer#loop` is private on the
 * vendored OpenTUI surface, but it is the only one-shot way to flush the
 * memory-buffered frame these render-smoke tests assert on (`start()` runs
 * the loop until `stop()`), so the reach is deliberate and pinned here.
 */
export async function flushRendererFrame(renderer: CliRenderer): Promise<void> {
  await (renderer as unknown as { loop(): Promise<void> }).loop();
}

/**
 * Depth-first walk over the OpenTUI render tree. Children are reached through
 * `getChildren()` (the renderable surface the reconciler builds); the depth cap
 * is the anti-runaway bound, not an expected tree height.
 */
function walkRenderTree(
  r: unknown,
  pred: (r: Record<string, unknown>) => boolean,
  depth = 0,
  out: Record<string, unknown>[] = []
): Record<string, unknown>[] {
  if (!r || typeof r !== "object") return out;
  const rr = r as Record<string, unknown>;
  if (pred(rr)) out.push(rr);
  if (depth > 12) return out;
  const getChildren = rr.getChildren;
  const children =
    typeof getChildren === "function" ? getChildren.call(rr) : undefined;
  if (Array.isArray(children)) {
    for (const c of children) walkRenderTree(c, pred, depth + 1, out);
  }
  return out;
}

/** The composer textarea as the render tree exposes it. */
export interface ComposerTextAreaNode {
  plainText: string;
  hasSelection(): boolean;
  getSelectedText(): string;
  /**
   * The wired content-change callback (`EditBufferRenderable#onContentChange`).
   * Exposed so a test can run work in the same task as the composer's own
   * report — after `onChange`, before React flushes — by wrapping it.
   */
  onContentChange?: ((event: unknown) => void) | undefined;
}

/**
 * The composer textarea node, or undefined while it is not mounted (the list
 * view, a modal that replaces the input). The textarea is the only renderable
 * carrying both a plain-text projection and a visual cursor, so that pair
 * identifies it without importing the class.
 */
export function findComposerTextArea(
  setup: TestRendererSetup
): ComposerTextAreaNode | undefined {
  const nodes = walkRenderTree(
    setup.renderer.root,
    (r) => "plainText" in r && "visualCursor" in r
  );
  // The walker hands back untyped renderables; the predicate above is what
  // justifies this duck-typed view of the textarea's live surface.
  return nodes[0] as unknown as ComposerTextAreaNode | undefined;
}

/** The composer's live buffer, read off the render tree; null while no
 *  textarea is mounted. */
export function composerText(setup: TestRendererSetup): string | null {
  const ta = findComposerTextArea(setup);
  return ta === undefined ? null : ta.plainText;
}

/**
 * The harness default for the `clipboardImageReader` seam: answers
 * `{ kind: "empty" }` — "the clipboard holds no bitmap" — which is what a text
 * paste really carries for every test that pastes text. The seam has to be
 * stubbed at its boundary: without it a mounted app drives the actual
 * `readClipboardImage`, a Windows interop host process that a test process
 * cannot reach and that, where it does work, reads the developer's real
 * clipboard (nondeterministic). The default is also honest about ordering: a
 * single-line paste inserts its own text before the probe is even asked, and a
 * probe that finds no bitmap substitutes nothing, so this answer leaves every
 * paste-driven buffer exactly as the paste made it. Files that need pending or
 * scripted reads inject their own reader instead (see
 * tests/tui/composer-clipboard-image.test.tsx).
 */
export const emptyClipboardImageReader: ClipboardImageReader = async () => ({
  kind: "empty",
});

export interface TuiHarnessProps {
  readonly bridge?: TuiBridge;
  readonly cwd?: string;
  readonly dataDir?: string;
  readonly initialView?: "chat" | "list" | "mcp";
  readonly onQuit?: () => void;
  /** skillCatalog injection point (slash candidates / /skill load-and-send). */
  readonly skillCatalog?: SkillCatalog;
  /** mcp extension injection point (data source for the /mcp board). */
  readonly mcp?: TuiMcpViewExt;
  /** Clipboard-image seam injection; defaults to the immediate no-bitmap
   *  answer so paste-driven tests stay hermetic. */
  readonly clipboardImageReader?: ClipboardImageReader;
  readonly children?: ReactNode;
}

/** Default stub assembly (minimal): used by mount-only tests. */
export function TuiHarness(props: TuiHarnessProps): ReactNode {
  const tmp = mkdtempSync(join(tmpdir(), "iknow-tui-harness-"));
  const bridge =
    props.bridge ??
    createTuiBridge({
      dataDir: tmp,
      workspaceRoot: tmp,
      deps: makeDeps([assistantResult({ texts: [] })]),
      inflight: createInflightRegistry(),
    });
  const askBridge = createTuiAskUserBridge();
  const toolEventSink = createToolEventSink();
  const permissionMode = createPermissionModeContext("default");
  const sessionGrants = createSessionGrants();
  return (
    <TuiApp
      bridge={bridge}
      askBridge={askBridge}
      toolEventSink={toolEventSink}
      cwd={props.cwd ?? "/tmp/proj"}
      dataDir={props.dataDir ?? tmp}
      permissionMode={permissionMode}
      sessionGrants={sessionGrants}
      clipboardImageReader={
        props.clipboardImageReader ?? emptyClipboardImageReader
      }
      initialView={props.initialView}
      onQuit={props.onQuit}
      skillCatalog={props.skillCatalog}
      mcp={props.mcp}
    />
  );
}
