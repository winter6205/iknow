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
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactNode } from "react";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import {
  createInflightRegistry,
  createTuiBridge,
  type TuiBridge,
} from "../../src/tui/hub-bridge.js";
import { createToolEventSink, TuiApp } from "../../src/tui/app.js";
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
      initialView={props.initialView}
      onQuit={props.onQuit}
      skillCatalog={props.skillCatalog}
      mcp={props.mcp}
    />
  );
}
