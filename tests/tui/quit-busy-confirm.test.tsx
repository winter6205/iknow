/** @jsxImportSource @opentui/react */
/**
 * tests/tui/quit-busy-confirm.test.tsx — the app.tsx wiring of the /quit busy
 * set (pure rule and per-conversation join are pinned in quit-busy.test.ts;
 * this file needs a renderer because the proposition is what the user sees when
 * they press /quit):
 *
 *   T1: a session whose parent turn is `idle` but that holds a live background
 *       bash task must ask for confirmation on the first /quit instead of
 *       reaping the process group silently, and exit on the second.
 *   T2: same for a live subagent; a terminal (completed) subagent must not
 *       raise the prompt.
 *   T3: a session with nothing outstanding exits on the first /quit.
 *   T4: the active `running-fg` turn stays a one-press quit — /quit aborts it
 *       first (quit-abort.ts semantics, same proposition as the real-chain
 *       SC12 in wait-cancel-abort.test.tsx), so the busy gate must not turn it
 *       into a confirmation round.
 *   T4b: that same press does not reach a detached background task of the very
 *       same conversation, so T4's exemption must not swallow it.
 *   T4c: a `wait:true` subagent of that conversation is represented by the
 *       parent's running-fg chrome, so it stays exempt like the turn itself.
 *   T4d: a `wait:false` subagent outlives the turn, so the exemption must not
 *       swallow it either — it reads like T4b, not like T4c.
 *   T5: a live task no session row claims is still reaped by the process exit,
 *       so attribution must not exempt it from the notice either.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import type { TestRendererSetup } from "@opentui/core/testing";
import { TuiApp, createToolEventSink } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  type TuiBridge,
  type TuiPostResult,
} from "../../src/tui/hub-bridge.js";
import type { SessionHub } from "../../src/session-api/hub.js";
import { createTuiAskUserBridge } from "../../src/tui/ask-user.js";
import { createPermissionModeContext } from "../../src/harness/permission/index.js";
import { createSessionGrants } from "../../src/harness/permission/session-grants.js";
import {
  createDraftSession,
  type SessionRunState,
  type TuiSessionState,
} from "../../src/tui/session-state.js";
import type { SubagentInfo } from "../../src/harness/subagent/manager.js";
import type { BackgroundLiveTask } from "../../src/harness/background/manager.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import { captureStderr } from "../_helpers/capture-stderr.ts";

const COLS = 80;
const ROWS = 30;
const CONV = "conv-quit-busy";

interface Rig {
  readonly setup: TestRendererSetup;
  /** Mutable source: what the hub-side live background projection answers. */
  readonly bgTasks: BackgroundLiveTask[];
  /** Mutable source: what bridge.listSubagents answers. */
  readonly subagents: SubagentInfo[];
  /** Conversations whose quit actually reached `props.onQuit` (its argument). */
  readonly quitCalls: string[];
  readonly aborted: string[];
  readonly typeText: (text: string) => Promise<void>;
  readonly flatFrame: () => string;
  readonly dispose: () => Promise<void>;
}

function sessionFile(dataDir: string): SessionFileV1 {
  return {
    conversation_id: CONV,
    schemaVersion: 1,
    workspaceRoot: dataDir,
    messages: [],
    updatedAt: "2026-10-10T00:00:00.000Z",
    turnCount: 0,
    jsonMode: false,
    title: CONV,
    cwd: dataDir,
    sanitized_at: "2026-10-10T00:00:00.000Z",
  };
}

function bgTask(taskId: string, conversationId: string): BackgroundLiveTask {
  return { task_id: taskId, conversation_id: conversationId };
}

function subagent(
  taskId: string,
  state: SubagentInfo["state"],
  foreground = false
): SubagentInfo {
  return {
    taskId,
    state,
    taskPreview: `worker ${taskId}`,
    startedAt: "2026-10-10T00:00:00.000Z",
    conversationId: CONV,
    // The manager writes the key only when true; `wait:false` rows omit it.
    ...(foreground ? { foreground: true } : {}),
  };
}

async function until(
  cond: () => boolean,
  ms = 8000,
  label = ""
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until timeout: ${label}`);
}

/**
 * `suspendFgTurn` makes the first turn hang until aborted, so the session
 * really sits in running-fg when /quit is pressed (T4).
 */
async function mountApp(opts: {
  readonly runState?: SessionRunState;
  readonly bgTasks?: BackgroundLiveTask[];
  readonly subagents?: SubagentInfo[];
  readonly suspendFgTurn?: boolean;
}): Promise<Rig> {
  const dataDir = mkdtempSync(join(tmpdir(), "iknow-quit-busy-"));
  const file = sessionFile(dataDir);
  const bgTasks = [...(opts.bgTasks ?? [])];
  const subagents = [...(opts.subagents ?? [])];
  const quitCalls: string[] = [];
  const aborted: string[] = [];
  let posts = 0;

  const bridge: TuiBridge = {
    // /quit reads nothing from the hub in this test; the live background-task
    // projection is the bridge member below.
    hub: {} as unknown as SessionHub,
    store: undefined as never,
    ensureSession: async (id) => id ?? CONV,
    postMessage: ({ signal }) => {
      posts += 1;
      if (opts.suspendFgTurn === true && posts === 1) {
        return new Promise<TuiPostResult>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted.push(CONV);
            resolve({
              conversationId: CONV,
              finalText: "",
              stopReason: "cancelled",
              turnCount: posts,
              jsonMode: false,
              lastUsage: null,
              interrupted: false,
            });
          });
        });
      }
      return Promise.resolve({
        conversationId: CONV,
        finalText: "",
        stopReason: "completed",
        turnCount: posts,
        jsonMode: false,
        lastUsage: null,
      });
    },
    listSessions: async () => [],
    loadSessionFile: async () => file,
    openSession: async () => {
      throw new Error("unused: no session is opened here");
    },
    compactSession: async () => ({
      compacted: false,
      reason: "below_token_threshold" as const,
    }),
    continueSession: async () => {
      throw new Error("unused");
    },
    rewindSession: async () => ({ file }),
    listRewindTargets: async () => [],
    inflight: createInflightRegistry(),
    contextWindow: 200_000,
    // The live background-task source /quit reads (mutable rig source above).
    listLiveBackgroundTasks: () => [...bgTasks],
    listSubagents: () => [...subagents],
    abortSubagentTask: () => false,
    abortSessionForegroundWork: () => [],
    subscribeSubagentTerminal: () => () => {},
    wakeFromSubagent: async () => undefined,
  };

  const session: TuiSessionState = Object.freeze({
    ...createDraftSession(),
    conversationId: CONV,
    runState: opts.runState ?? "idle",
  });

  const stderr = captureStderr();
  const setup = await testRender(
    <TuiApp
      bridge={bridge}
      askBridge={createTuiAskUserBridge()}
      toolEventSink={createToolEventSink()}
      cwd="/tmp/proj"
      dataDir={dataDir}
      permissionMode={createPermissionModeContext("default")}
      sessionGrants={createSessionGrants()}
      initialSession={session}
      onQuit={() => {
        quitCalls.push(CONV);
      }}
    />,
    { width: COLS, height: ROWS, exitOnCtrlC: false, consoleMode: "disabled" }
  );

  /** mockInput parses stdin asynchronously; bursts drop keys, so pace them. */
  const typeText = async (text: string): Promise<void> => {
    for (const ch of text) {
      setup.mockInput.pressKey(ch);
      await new Promise((r) => setTimeout(r, 60));
      await setup.renderOnce();
    }
    setup.mockInput.pressEnter();
    await new Promise((r) => setTimeout(r, 60));
    await setup.renderOnce();
  };

  return {
    setup,
    bgTasks,
    subagents,
    quitCalls,
    aborted,
    typeText,
    flatFrame: () => setup.captureCharFrame().replace(/\s+/g, ""),
    dispose: async () => {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
      stderr.restore();
    },
  };
}

describe("/quit 忙集合接线", () => {
  test("活跃后台 bash 任务在 TUI 中显示任务 id 和所属会话", async () => {
    const app = await mountApp({ bgTasks: [bgTask("bg-visible", CONV)] });
    try {
      await app.setup.renderOnce();
      expect(app.flatFrame()).toContain("本TUI后台任务");
      expect(app.flatFrame()).toContain("bg-visible");
      expect(app.flatFrame()).toContain(CONV);
    } finally {
      await app.dispose();
    }
  });

  test("Esc 取消退出确认后任务继续可见，再次确认仍需新一轮确认", async () => {
    const app = await mountApp({ bgTasks: [bgTask("bg-cancel", CONV)] });
    try {
      await app.typeText("/quit");
      await until(
        () =>
          app.flatFrame().includes("再次/quit确认停止当前TUI拥有的全部工作"),
        8000,
        "live 后台任务未进入退出确认"
      );

      app.setup.mockInput.pressEscape();
      await app.setup.renderOnce();
      await until(
        () => app.flatFrame().includes("已取消退出"),
        8000,
        "Esc 未取消退出确认"
      );
      expect(app.quitCalls.length).toBe(0);
      expect(app.flatFrame()).toContain("bg-cancel");

      await app.typeText("/quit");
      await until(
        () =>
          app.flatFrame().includes("再次/quit确认停止当前TUI拥有的全部工作"),
        8000,
        "取消后再次退出应重新要求确认"
      );
      expect(app.quitCalls.length).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("首次确认后出现新后台任务时刷新确认，不直接停止新任务", async () => {
    const app = await mountApp({ bgTasks: [bgTask("bg-before", CONV)] });
    try {
      await app.typeText("/quit");
      await until(
        () => app.flatFrame().includes("再次/quit确认"),
        8000,
        "live 后台任务未进入退出确认"
      );

      app.bgTasks.push(bgTask("bg-added-after-prompt", CONV));
      await app.typeText("/quit");
      await until(
        () => app.flatFrame().includes("退出确认期间工作状态发生变化"),
        8000,
        "新增后台任务没有刷新退出确认"
      );
      expect(app.quitCalls.length).toBe(0);

      await app.typeText("/quit");
      await until(
        () => app.quitCalls.length === 1,
        8000,
        "确认最新工作后未退出"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T1 idle + live 后台 bash 任务：第一次 /quit 要确认，第二次才退", async () => {
    const app = await mountApp({ bgTasks: [bgTask("bg-1", CONV)] });
    try {
      await app.typeText("/quit");
      await until(
        () =>
          app.flatFrame().includes("再次/quit确认停止当前TUI拥有的全部工作"),
        8000,
        "idle+后台任务 未触发二次确认"
      );
      // The wording branch is the point: a live background task is stoppable
      // work, so the notice must not promise it persists to disk.
      expect(app.flatFrame()).toContain("存在后台任务或子代理仍在运行");
      expect(app.quitCalls.length).toBe(0);

      await app.typeText("/quit");
      await until(
        () => app.quitCalls.length === 1,
        8000,
        "第二次 /quit 未退出"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T2 idle + live 子代理：第一次 /quit 要确认", async () => {
    const app = await mountApp({ subagents: [subagent("t1", "running")] });
    try {
      await app.typeText("/quit");
      await until(
        () =>
          app.flatFrame().includes("再次/quit确认停止当前TUI拥有的全部工作"),
        8000,
        "idle+live 子代理 未触发确认"
      );
      expect(app.quitCalls.length).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T2b idle + 终态子代理：不等、不确认，一次 /quit 直接退出", async () => {
    const app = await mountApp({
      subagents: [subagent("t1", "completed"), subagent("t2", "failed")],
    });
    try {
      await app.typeText("/quit");
      await until(() => app.quitCalls.length === 1, 8000, "终态子代理仍拦退出");
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T3 idle + 无后台任务 + 无子代理 + 无在途 promise：一次 /quit 直接退出", async () => {
    const app = await mountApp({});
    try {
      await app.typeText("/quit");
      await until(() => app.quitCalls.length === 1, 8000, "无活会话退出失败");
      expect(app.flatFrame()).not.toContain(
        "再次/quit确认停止当前TUI拥有的全部工作"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T4 running-fg 前台 turn：/quit 先 abort 再收尾，一次按下不变成二次确认", async () => {
    const app = await mountApp({ suspendFgTurn: true });
    try {
      await app.typeText("hi");
      await until(
        () => app.flatFrame().includes("运行中"),
        8000,
        "未进入 running-fg"
      );

      await app.typeText("/quit");
      await until(
        () => app.aborted.length === 1,
        8000,
        "/quit 未 abort 前台 turn"
      );
      await until(
        () => app.quitCalls.length === 1,
        8000,
        "前台 turn 下 /quit 未退出"
      );
      expect(app.flatFrame()).not.toContain(
        "再次/quit确认停止当前TUI拥有的全部工作"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T4b running-fg + 同会话 live 后台任务：abort 停不掉它，仍要确认", async () => {
    const app = await mountApp({
      suspendFgTurn: true,
      bgTasks: [bgTask("bg-1", CONV)],
    });
    try {
      await app.typeText("hi");
      await until(
        () => app.flatFrame().includes("运行中"),
        8000,
        "未进入 running-fg"
      );

      await app.typeText("/quit");
      await until(
        () =>
          app.flatFrame().includes("再次/quit确认停止当前TUI拥有的全部工作"),
        8000,
        "running-fg+后台任务 未触发二次确认"
      );
      expect(app.quitCalls.length).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T4c running-fg + 同会话 wait:true 子代理：父轮在代表它，一次按下就退", async () => {
    const app = await mountApp({
      suspendFgTurn: true,
      subagents: [subagent("t1", "running", true)],
    });
    try {
      await app.typeText("hi");
      await until(
        () => app.flatFrame().includes("运行中"),
        8000,
        "未进入 running-fg"
      );

      await app.typeText("/quit");
      await until(
        () => app.quitCalls.length === 1,
        8000,
        "可打断会话的前端子代理拦住了退出"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T4d running-fg + 同会话 wait:false 子代理：这一按停不掉它，仍要确认", async () => {
    // A `wait:false` worker outlives the turn that dispatched it — the same
    // promise `background: true` makes for a shell task. The quit press aborts
    // the turn and the foreground fan-out selects `foreground === true` rows
    // only, so nothing before the second press stops it.
    const app = await mountApp({
      suspendFgTurn: true,
      subagents: [subagent("t1-bg", "running")],
    });
    try {
      await app.typeText("hi");
      await until(
        () => app.flatFrame().includes("运行中"),
        8000,
        "未进入 running-fg"
      );

      await app.typeText("/quit");
      await until(
        () =>
          app.flatFrame().includes("再次/quit确认停止当前TUI拥有的全部工作"),
        8000,
        "wait:false 子代理未触发二次确认"
      );
      expect(app.flatFrame()).toContain("存在后台任务或子代理仍在运行");
      expect(app.quitCalls.length).toBe(0);
    } finally {
      await app.dispose();
    }
  }, 30_000);

  test("T5 退出 reap 是进程级的：无会话行认领的 live 后台任务也要确认", async () => {
    // Per-conversation attribution sizes the WAIT set; it cannot exempt work
    // from the NOTICE, because `built.shutdown()` reaps every task of this
    // engine's manager whoever spawned it (base evidence: the record reads
    // `killed` after a single-press quit).
    const app = await mountApp({
      bgTasks: [bgTask("bg-other", "conv-someone-elses")],
    });
    try {
      await app.typeText("/quit");
      await until(
        () =>
          app.flatFrame().includes("再次/quit确认停止当前TUI拥有的全部工作"),
        8000,
        "未认领的后台任务没进确认门"
      );
      expect(app.flatFrame()).toContain("存在后台任务或子代理仍在运行");
      expect(app.quitCalls.length).toBe(0);

      await app.typeText("/quit");
      await until(
        () => app.quitCalls.length === 1,
        8000,
        "第二次 /quit 未退出"
      );
    } finally {
      await app.dispose();
    }
  }, 30_000);
});
