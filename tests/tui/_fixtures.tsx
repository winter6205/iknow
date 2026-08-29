/** @jsxImportSource @opentui/react */
/**
 * tests/tui/_fixtures.tsx
 *
 * #343 T6-C：TUI 端到端测试装配共享 fixture。T1/T5 测试历史用 `<TuiApp />`
 * 裸渲染（仅 T1/T5 视角的 banner / 输入框 stub），T6 起 TuiApp 完整接入
 * 状态机/slash/hub 流式——必须提供 bridge/askBridge/toolEventSink/permissionMode/
 * sessionGrants 才能 mount。本 fixture 统一造出最小可用的 stub 装配：
 *  - createInflightRegistry 真实实例（deps/soleId 通过）；
 *  - makeDeps([]) stub LoopEngineDeps（hub 不发实际网络请求，跑 turn 时
 *    缺响应会 settle，OK 用于「mount 渲染 + 静态 UI 断言」类用例）；
 *  - createTuiAskUserBridge / createToolEventSink / default permission mode
 *    / 空 sessionGrants；
 *  - 默认 cwd/dataDir（测试 cwd）。
 *
 * 端到端 turn 流式 / slash / modal 等用例应另起装配（in-memory adapter +
 * 自定义 stub-model）——见 `tests/tui/app.test.tsx`。
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
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

export interface TuiHarnessProps {
  readonly bridge?: TuiBridge;
  readonly cwd?: string;
  readonly dataDir?: string;
  readonly initialView?: "chat" | "list" | "mcp";
  readonly onQuit?: () => void;
  /** #337 Phase C：skillCatalog 注入口（slash 候选 / /skill 加载发送）。 */
  readonly skillCatalog?: SkillCatalog;
  /** #361 Phase D：mcp 扩展注入口（/mcp 看板数据源）。 */
  readonly mcp?: TuiMcpViewExt;
  readonly children?: ReactNode;
}

/** 默认 stub 装配（最小化）：T1/T5 类 mount-only 测试用它。 */
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
