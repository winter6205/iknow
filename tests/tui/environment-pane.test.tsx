/** @jsxImportSource @opentui/react */
/**
 * tests/tui/environment-pane.test.tsx
 *
 * T5 (#653 G1 / 包1-感知): `EnvironmentPane` —— TUI 人读 chrome 的环境现势
 * 独立槽位投影(DESIGN 钉死名;`EnvSnapshotPane` 已退役)。
 *
 *   - 数据唯一来源是 harness 在回合边界发出的 `env_snapshot` 流事件;
 *     `envSnapshotFromEvent` 投影:env_snapshot → EnvSnapshot(冻结);其余
 *     事件 → null。replace-on-event 与 agentStatusFromEvent 同形态。
 *   - 渲染:正常态 → cwd / gitBranch / dirtyCount / diffPreview 完整可见;
 *     超长 diffPreview(>2000 cp)→ 走 truncateByCodepoints 兜底截断,
 *     标记 `[truncated N chars]` 出现在输出中(spec 2000 cp 上限,
 *     UI 兜底再截)。
 *   - EXIT 退化态:按 degradeReason 投影 DESIGN 占位
 *     `(cwd unavailable)` / `(not a git repo)` / `(git unavailable)`。
 *   - 行账:`envSnapshotLines` 行数 → chromeReserveRows.envPaneRows
 *     (SSOT,与 agentStatusRows 同款 linkage,基线 7 不变)。
 *   - 反向契约:src/tui/environment-pane.tsx 零命中 `agent_status`
 *     (平行独立流,绝不挂 agent_status 渲染路径)。
 *
 * 与 agent-status-panel.test.ts 同形态(bun:test + 纯函数直驱 +
 * OpenTUI renderOnce 集成)。
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { testRender } from "@opentui/react/test-utils";
import {
  EnvironmentPane,
  envSnapshotFromEvent,
  envSnapshotLines,
  resolveWorktreeChromeRoot,
  sessionLocationLines,
} from "../../src/tui/environment-pane.js";
import { chromeReserveRows } from "../../src/tui/app.js";
import type { EnvSnapshot } from "../../src/harness/env-snapshot.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.ts";

// ---------------------------------------------------------------------------
// fixtures:与 chatView test 等文件共用同样的快照构型。
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<EnvSnapshot> = {}): EnvSnapshot {
  return {
    cwd: "/repo",
    gitBranch: "main",
    gitStatus: "## main\n M src/foo.ts\n",
    dirtyCount: 1,
    diffPreview: "diff --git a/src/foo.ts b/src/foo.ts\n-old\n+new\n",
    degradeReason: null,
    ...overrides,
  };
}

function envSnapshotEvent(snap: EnvSnapshot): HarnessStreamEvent {
  return { type: "env_snapshot", snapshot: snap };
}

// ---------------------------------------------------------------------------
// 投影:事件 → EnvSnapshot
// ---------------------------------------------------------------------------

describe("envSnapshotFromEvent: 事件 → EnvSnapshot", () => {
  test("env_snapshot 事件 → 完整 EnvSnapshot(冻结)", () => {
    const snap = makeSnapshot();
    const out = envSnapshotFromEvent(envSnapshotEvent(snap));
    expect(out).not.toBeNull();
    expect(out!.cwd).toBe("/repo");
    expect(out!.gitBranch).toBe("main");
    expect(out!.dirtyCount).toBe(1);
    expect(out!.diffPreview).toBe(snap.diffPreview);
    expect(out!.degradeReason).toBeNull();
    expect(Object.isFrozen(out!)).toBe(true);
  });

  test("非 env_snapshot 事件 → null(调用方保持旧快照不变)", () => {
    expect(envSnapshotFromEvent({ type: "text_delta", text: "x" })).toBeNull();
    expect(
      envSnapshotFromEvent({
        type: "agent_status",
        lastTool: "idle",
        openTodoLines: [],
      })
    ).toBeNull();
    expect(
      envSnapshotFromEvent({ type: "stop_summary", text: "s" })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 投影:EnvSnapshot → 显示行
// ---------------------------------------------------------------------------

describe("envSnapshotLines: EnvSnapshot → 显示行", () => {
  test("null 快照(尚未有事件)→ 0 行(面板不渲染)", () => {
    expect(envSnapshotLines(null, 80)).toEqual([]);
  });

  test("正常态:cwd + branch + dirtyCount + diffPreview 全可见", () => {
    const lines = envSnapshotLines(makeSnapshot(), 80);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const joined = lines.map((l) => l.text).join("\n");
    expect(joined).toContain("/repo");
    expect(joined).toContain("main");
    expect(joined).toContain("1");
    // diffPreview 内容(可能折叠空白后展示)——至少能命中 file path
    expect(joined).toContain("src/foo.ts");
  });

  test("超长 diffPreview (>2000 cp) → 截断 + marker (cols 大于上限)", () => {
    // 3000 cp 的 ASCII diff → 经 truncateByCodepoints 兜底截到 ≤ MAX_ENV_DIFF_CHARS,
    // 末尾追加 [truncated N chars] 标记。UI 投影层 col 预算足够宽,marker 可见。
    // (CJK 输入虽然 codepoint 数 = 上限,但 visualWidth 翻倍 → cols=2500 时 marker
    // 会被视觉裁剪,这是按视觉宽度截断的合理行为;ASCII 是 marker 可见的代表。)
    const longDiff = "a".repeat(3000);
    const snap = makeSnapshot({ diffPreview: longDiff });
    const lines = envSnapshotLines(snap, 2500);
    const joined = lines.map((l) => l.text).join("\n");
    expect(joined).toContain("[truncated");
    // 标记至少报告丢弃 1000 chars(3000 - 2000)。
    expect(joined).toMatch(/truncated\s+\d+\s+chars/);
  });

  test("EXIT cwd_unavailable → 占位 (cwd unavailable)", () => {
    const snap = makeSnapshot({
      cwd: "",
      gitBranch: null,
      gitStatus: null,
      dirtyCount: null,
      diffPreview: null,
      degradeReason: "cwd_unavailable",
    });
    const lines = envSnapshotLines(snap, 80);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("(cwd unavailable)");
    expect(lines[0]!.text).not.toContain("环境现势不可用");
  });

  test("EXIT not_a_git_repo → 占位 (not a git repo)", () => {
    const snap = makeSnapshot({
      cwd: "/scratch",
      gitBranch: null,
      gitStatus: null,
      dirtyCount: null,
      diffPreview: null,
      degradeReason: "not_a_git_repo",
    });
    const lines = envSnapshotLines(snap, 80);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("/scratch");
    expect(lines[0]!.text).toContain("(not a git repo)");
    expect(lines[0]!.text).not.toContain("环境现势不可用");
  });

  test("EXIT git_unavailable → 占位 (git unavailable)", () => {
    const snap = makeSnapshot({
      cwd: "/work",
      gitBranch: null,
      gitStatus: null,
      dirtyCount: null,
      diffPreview: null,
      degradeReason: "git_unavailable",
    });
    const lines = envSnapshotLines(snap, 80);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("/work");
    expect(lines[0]!.text).toContain("(git unavailable)");
  });

  test("行宽受 cols 限制:任何单行视觉宽度 ≤ cols", () => {
    const lines = envSnapshotLines(makeSnapshot(), 40);
    for (const line of lines) {
      const width = [...line.text].reduce((acc, ch) => {
        const cp = ch.codePointAt(0)!;
        return acc + (cp > 0x2e7f ? 2 : 1);
      }, 0);
      expect(width).toBeLessThanOrEqual(40);
    }
  });
});

// ---------------------------------------------------------------------------
// 渲染集成:OpenTUI renderOnce 验证 EnvironmentPane 实际可见
// ---------------------------------------------------------------------------

async function renderPane(snap: EnvSnapshot | null, cols: number) {
  const setup = await testRender(
    <EnvironmentPane snapshot={snap} cols={cols} />,
    {
      width: cols,
      height: 12,
    }
  );
  await setup.renderOnce();
  return setup;
}

describe("EnvironmentPane render integration", () => {
  test("正常态 snapshot → 帧文本含 cwd / branch / diff 内容", async () => {
    const setup = await renderPane(makeSnapshot(), 80);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("/repo");
    expect(frame).toContain("main");
    expect(frame).toContain("src/foo.ts");
    await setup.renderer.destroy();
  });

  test("null snapshot → 帧不渲染组件(空内容)", async () => {
    const setup = await renderPane(null, 80);
    const frame = setup.captureCharFrame().trim();
    expect(frame).not.toContain("(not a git repo)");
    expect(frame).not.toContain("/repo");
    await setup.renderer.destroy();
  });

  test("退化态 snapshot → 帧含 (not a git repo) 占位", async () => {
    const degraded: EnvSnapshot = {
      cwd: "/scratch",
      gitBranch: null,
      gitStatus: null,
      dirtyCount: null,
      diffPreview: null,
      degradeReason: "not_a_git_repo",
    };
    const setup = await renderPane(degraded, 80);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("/scratch");
    expect(frame).toContain("(not a git repo)");
    await setup.renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// 行账联动:envSnapshotLines ↔ chromeReserveRows.envPaneRows
// ---------------------------------------------------------------------------

describe("chromeReserveRows: envPaneRows 投影联动", () => {
  const base = {
    noticeRows: 0,
    inputHintRows: 0,
    bgLine: false,
    inputRows: 1,
  };

  test("envPaneRows 缺省(undefined) = 0,不占底部行账(基线 7 不变)", () => {
    const a = chromeReserveRows({ ...base });
    const b = chromeReserveRows({ ...base, envPaneRows: undefined });
    expect(b).toBe(a);
    expect(a).toBe(7);
  });

  test("envPaneRows=2 → 预算 +2;与其他项叠加", () => {
    const rows = envSnapshotLines(makeSnapshot(), 80).length;
    expect(rows).toBeGreaterThanOrEqual(2);
    const withEnv = chromeReserveRows({ ...base, envPaneRows: rows });
    expect(withEnv - 7).toBe(rows);
  });

  test("退化态(1 行)→ 预算 +1", () => {
    const degraded: EnvSnapshot = {
      cwd: "/s",
      gitBranch: null,
      gitStatus: null,
      dirtyCount: null,
      diffPreview: null,
      degradeReason: "git_unavailable",
    };
    const rows = envSnapshotLines(degraded, 80).length;
    expect(rows).toBe(1);
    expect(chromeReserveRows({ ...base, envPaneRows: rows })).toBe(8);
  });

  test("null snapshot → 0 行 → 预算不增", () => {
    const rows = envSnapshotLines(null, 80).length;
    expect(rows).toBe(0);
    expect(chromeReserveRows({ ...base, envPaneRows: rows })).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 反向契约:src/tui/environment-pane.tsx 零命中 agent_status
// ---------------------------------------------------------------------------

describe("no agent_status in environment-pane: 平行独立流", () => {
  test("src/tui/environment-pane.tsx 不含 agent_status 字面量", () => {
    const file = join(
      import.meta.dir,
      "..",
      "..",
      "src",
      "tui",
      "environment-pane.tsx"
    );
    const src = readFileSync(file, "utf8");
    expect(src.includes("agent_status")).toBe(false);
  });

  test("src/tui/environment-pane.tsx 不读 todos.md / todoDir / agent-status", () => {
    const file = join(
      import.meta.dir,
      "..",
      "..",
      "src",
      "tui",
      "environment-pane.tsx"
    );
    const src = readFileSync(file, "utf8");
    for (const marker of [
      "todos.md",
      "todoDir",
      "agent-status",
      "agentStatus",
    ]) {
      expect(src.includes(marker)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-0037 T5: session worktree 隔离现势行（只读投影）
// ---------------------------------------------------------------------------

describe("sessionLocationLines: 会话位置行常驻（spec D7 / SC6）", () => {
  test("主仓（未绑树）→ 1 行 `路径 · 分支`；旧「仅 task 树才显示」合同作废", () => {
    // SC6：主仓 + 非 task 路径仍渲染 1 行 —— 不得 0 行。文案 = 项目根叶子
    // + 分支（人读 `~/projects/iknow · master` 形态）。
    const lines = sessionLocationLines({
      projectRoot: "/home/user/projects/iknow",
      branch: "master",
      cols: 80,
    });
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toBe("iknow · master");
  });

  test("分支未知（快照尚未到）→ 仍 1 行，只画路径段（不留悬空分隔符）", () => {
    // 启动首拍：env_snapshot 还没到 → 位置行不得因此消失（D7「禁止
    // void envSnapshot 后 0 行」）。
    for (const branch of [undefined, null, "", "   "]) {
      const lines = sessionLocationLines({
        projectRoot: "/home/user/projects/iknow",
        branch,
        cols: 80,
      });
      expect(lines.length).toBe(1);
      expect(lines[0]!.text).toBe("iknow");
      expect(lines[0]!.text.includes("·")).toBe(false);
    }
  });

  test("绑任务树 → 同一槽换成树上路径（不是多一行、不是从无到有）", () => {
    const bound = sessionLocationLines({
      projectRoot: "/repo",
      worktreeRoot: "/repo/.iknow/worktrees/conv-1",
      branch: "feat/x",
      cols: 80,
    });
    const unbound = sessionLocationLines({
      projectRoot: "/repo",
      branch: "feat/x",
      cols: 80,
    });
    // 两态都恰好 1 行 —— 绑树只换路径。
    expect(unbound.length).toBe(1);
    expect(bound.length).toBe(1);
    expect(bound[0]!.text).toBe("repo/.iknow/worktrees/conv-1 · feat/x");
    expect(bound[0]!.text).not.toContain("/repo/.iknow/worktrees/conv-1");
  });

  test("不带 dirty / diff：未提交计数与 diff 内容不进位置行", () => {
    const lines = sessionLocationLines({
      projectRoot: "/repo",
      branch: "main",
      cols: 80,
    });
    const text = lines[0]!.text;
    expect(text.includes("clean")).toBe(false);
    expect(text.includes("未提交")).toBe(false);
    expect(text.includes("Δ")).toBe(false);
  });

  test("行宽受 cols 限制：超长路径按视觉宽度单行截断", () => {
    const longRoot = `/repo/${"w".repeat(200)}`;
    const lines = sessionLocationLines({
      projectRoot: longRoot,
      branch: "master",
      cols: 40,
    });
    expect(lines.length).toBe(1);
    const width = [...lines[0]!.text].reduce((acc, ch) => {
      const cp = ch.codePointAt(0)!;
      return acc + (cp > 0x2e7f ? 2 : 1);
    }, 0);
    expect(width).toBeLessThanOrEqual(40);
  });
});

describe("EnvironmentPane: projectRoot 给定 → 常驻位置行（分支取快照）", () => {
  test("快照在场 → `路径 · 分支`；同一槽只 1 行", async () => {
    const setup = await testRender(
      <EnvironmentPane
        snapshot={makeSnapshot({ cwd: "/repo", gitBranch: "main" })}
        projectRoot="/repo"
        cols={80}
      />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("repo · main");
    await setup.renderer.destroy();
  });

  test("快照缺席（启动首拍）→ 仍画路径段，不渲染成 0 行", async () => {
    const setup = await testRender(
      <EnvironmentPane snapshot={null} projectRoot="/repo" cols={80} />,
      { width: 80, height: 10 }
    );
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("repo");
    await setup.renderer.destroy();
  });
});

// ---------------------------------------------------------------------------
// ADR-0037 T5 挂载契约:app.tsx 渲染隔离现势行并入账 envPaneRows 槽位
// ---------------------------------------------------------------------------

describe("app.tsx 位置行挂载契约（D7 / SC6）", () => {
  test("src/tui/app.tsx 消费 sessionLocationLines（chat 视图常驻位置行）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "tui", "app.tsx"),
      "utf8"
    );
    expect(src.includes("sessionLocationLines")).toBe(true);
    expect(src.includes("resolveWorktreeChromeRoot")).toBe(true);
    expect(src.includes("liveTaskRoot")).toBe(true);
    // 绑定判定不再决定显隐：旧投影退场。
    expect(src.includes("worktreeIsolationLines")).toBe(false);
  });

  test("位置行入账 envPaneRows = 投影行数（常驻 1 行，主仓也算）", () => {
    const rows = sessionLocationLines({
      projectRoot: "/repo",
      branch: "main",
      cols: 80,
    }).length;
    expect(rows).toBe(1);
    expect(
      chromeReserveRows({
        noticeRows: 0,
        inputHintRows: 0,
        bgLine: false,
        inputRows: 1,
        envPaneRows: rows,
      })
    ).toBe(7 + 1);
  });
});

describe("resolveWorktreeChromeRoot: 活 taskRoot 优先于会话主根", () => {
  test("会话仍是主仓、活根已是 task worktree → 用活根", () => {
    expect(
      resolveWorktreeChromeRoot("/repo", "/repo/.iknow/worktrees/label-a")
    ).toBe("/repo/.iknow/worktrees/label-a");
  });

  test("活根缺席或非树、会话已是 task worktree → 用会话根", () => {
    expect(
      resolveWorktreeChromeRoot("/repo/.iknow/worktrees/conv-1", undefined)
    ).toBe("/repo/.iknow/worktrees/conv-1");
    expect(resolveWorktreeChromeRoot("/repo", "/repo")).toBeUndefined();
  });
});

describe("TUI chrome 不画环境现势", () => {
  test("src/tui/app.tsx 不挂载 EnvironmentPane（只留 ContextBar 一行）", () => {
    const src = readFileSync(
      join(import.meta.dir, "..", "..", "src", "tui", "app.tsx"),
      "utf8"
    );
    expect(src.includes("<EnvironmentPane")).toBe(false);
  });
});

// DESIGN 验收:src/tui/ 下 EnvironmentPane 唯一 + environment-* 文件名。
describe("EnvironmentPane 唯一组件名", () => {
  test("src/tui/ 下 EnvironmentPane / environment-pane 仅一处定义", () => {
    const tuiDir = join(import.meta.dir, "..", "..", "src", "tui");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
        } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
          files.push(p);
        }
      }
    };
    walk(tuiDir);
    let defCount = 0;
    let fileMentions = 0;
    let legacyName = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/export\s+(function|const)\s+EnvironmentPane\b/.test(src)) defCount++;
      if (file.endsWith("environment-pane.tsx")) fileMentions++;
      if (/export\s+(function|const)\s+EnvSnapshotPane\b/.test(src))
        legacyName++;
    }
    expect(fileMentions).toBe(1);
    expect(defCount).toBe(1);
    expect(legacyName).toBe(0);
  });
});
