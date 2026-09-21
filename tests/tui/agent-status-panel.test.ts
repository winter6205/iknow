/**
 * tests/tui/agent-status-panel.test.ts
 *
 * ADR-0028 / CONTEXT `状态栏` (status bar): the TUI is read-only on the latest
 * current state ——
 *   - sole status source: the `agent_status` stream event the harness emits at
 *     the same computation point that injects the `<agent_status>` bar
 *     (agentStatusFromEvent projection; replace-on-event: each event yields a
 *     **complete, standalone** snapshot → one state slot replaced wholesale,
 *     no history, no merge);
 *   - display: open items → single line `□ a · b · c` (last_tool not printed);
 *     no open items → 0 lines;
 *   - src/tui never reads todos.md / never imports the ledger reader
 *     (grep guard: no second todo-state source);
 *   - line count feeds chromeReserveRows.agentStatusRows (line-ledger SSOT).
 *
 * bun:test (pure functions driven directly, no React rendering).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";
import {
  buildAgentStatusText,
  parseAgentStatusText,
  agentStatusFromMessages,
} from "../../src/harness/agent-status.js";
import {
  agentStatusFromEvent,
  agentStatusLines,
} from "../../src/tui/agent-status-line.js";
import { chromeReserveRows } from "../../src/tui/app.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import type { HarnessStreamEvent } from "../../src/harness/stream.js";

function agentStatusEvent(
  lastTool: string,
  openTodoLines: ReadonlyArray<string>
): HarnessStreamEvent & { type: "agent_status" } {
  return { type: "agent_status", lastTool, openTodoLines };
}

// ---------------------------------------------------------------------------
// Cold-start hydrate: bar-text parse + last-bar projection from messages
// ---------------------------------------------------------------------------

describe("parseAgentStatusText / agentStatusFromMessages: resume hydrate SSOT", () => {
  test("buildAgentStatusText → parseAgentStatusText 往返", () => {
    const snapshot = {
      lastTool: "web_search",
      openTodoLines: ["- [ ] alpha", "- [ ] beta"],
    };
    const parsed = parseAgentStatusText(buildAgentStatusText(snapshot));
    expect(parsed).not.toBeNull();
    expect(parsed!.lastTool).toBe("web_search");
    expect([...parsed!.openTodoLines]).toEqual(["- [ ] alpha", "- [ ] beta"]);
  });

  test("无 todos 段 → openTodoLines 空", () => {
    const parsed = parseAgentStatusText(
      "<agent_status>\nlast_tool: idle\n</agent_status>"
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.lastTool).toBe("idle");
    expect([...parsed!.openTodoLines]).toEqual([]);
  });

  test("畸形栏 → null 不 throw", () => {
    expect(parseAgentStatusText("not a bar")).toBeNull();
    expect(parseAgentStatusText("<agent_status>\n</agent_status>")).toBeNull();
    expect(
      parseAgentStatusText("<agent_status>\nlast_tool: x\nmissing close")
    ).toBeNull();
  });

  test("agentStatusFromMessages: 取末条 agent_status user 消息", () => {
    const olderBar = buildAgentStatusText({
      lastTool: "idle",
      openTodoLines: ["- [ ] old"],
    });
    const newerBar = buildAgentStatusText({
      lastTool: "bash",
      openTodoLines: ["- [ ] new task"],
    });
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "query" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: olderBar }] },
      { role: "assistant", content: [{ type: "text", text: "ok2" }] },
      { role: "user", content: [{ type: "text", text: newerBar }] },
    ];
    const snapshot = agentStatusFromMessages(messages);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.lastTool).toBe("bash");
    expect([...snapshot!.openTodoLines]).toEqual(["- [ ] new task"]);
  });

  test("无 agent_status 消息 → null", () => {
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: "plain query" }] },
    ];
    expect(agentStatusFromMessages(messages)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status source: event → snapshot (constructive evidence of replace-on-event)
// ---------------------------------------------------------------------------

describe("agentStatusFromEvent: 事件是快照的唯一来源", () => {
  test("agent_status 事件 → 完整独立快照(字段即事件字段,冻结)", () => {
    const snapshot = agentStatusFromEvent(
      agentStatusEvent("echo", ["- [ ] alpha", "- [ ] beta"])
    );
    expect(snapshot).not.toBeNull();
    expect(snapshot!.lastTool).toBe("echo");
    expect([...snapshot!.openTodoLines]).toEqual(["- [ ] alpha", "- [ ] beta"]);
    expect(Object.isFrozen(snapshot!)).toBe(true);
  });

  test("非 agent_status 事件 → null(调用方保持旧快照不变)", () => {
    expect(agentStatusFromEvent({ type: "text_delta", text: "x" })).toBeNull();
    expect(
      agentStatusFromEvent({ type: "tool_call_start", name: "bash", id: "t1" })
    ).toBeNull();
    expect(
      agentStatusFromEvent({ type: "stop_summary", text: "s" })
    ).toBeNull();
  });

  test("latest-only:后一事件的快照与前一份零共享 —— 整体替换而非合并", () => {
    // Constructive evidence of replace-on-event: each event's projection is a
    // self-contained snapshot that reads/keeps no prior state → the app's
    // single-slot setAgentStatus(projection) is wholesale replacement; a mix of
    // old and new (a second ledger) cannot occur.
    const older = agentStatusFromEvent(
      agentStatusEvent("idle", ["- [ ] old task"])
    )!;
    const newer = agentStatusFromEvent(agentStatusEvent("bash", []))!;
    expect(newer.lastTool).toBe("bash");
    expect([...newer.openTodoLines]).toEqual([]);
    expect([...older.openTodoLines]).toEqual(["- [ ] old task"]);
    // distinct references, no shared arrays
    expect(newer).not.toBe(older);
  });
});

// ---------------------------------------------------------------------------
// spec agent-status-instruction-echo bullet 5: display surface unchanged ——
// event mapping extends (tolerates and passes through instruction/reconcile),
// AgentStatusLine consumption surface sees zero change.
// ---------------------------------------------------------------------------

describe("agentStatusFromEvent: instruction/reconcile 透传（事件映射扩）", () => {
  test("带 instruction/reconcile 段的事件 → 快照逐字透传两字段", () => {
    const snapshot = agentStatusFromEvent({
      type: "agent_status",
      lastTool: "bash",
      openTodoLines: ["- [ ] alpha"],
      instruction: "先别查新闻，改查天气",
      reconcile: true,
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.instruction).toBe("先别查新闻，改查天气");
    expect(snapshot!.reconcile).toBe(true);
  });

  test("旧事件（无新槽）→ 快照退回旧字段集形态，key 缺席（F1）", () => {
    const snapshot = agentStatusFromEvent(
      agentStatusEvent("echo", ["- [ ] alpha"])
    )!;
    expect("instruction" in snapshot).toBe(false);
    expect("reconcile" in snapshot).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("instruction=false/reconcile 在场等混合形态只透传事件实际值，不造默认", () => {
    const s1 = agentStatusFromEvent({
      type: "agent_status",
      lastTool: "echo",
      openTodoLines: [],
      instruction: null,
      reconcile: false,
    })!;
    expect(s1.instruction).toBeNull();
    expect(s1.reconcile).toBe(false);
    const s2 = agentStatusFromEvent({
      type: "agent_status",
      lastTool: "echo",
      openTodoLines: [],
      reconcile: true,
    })!;
    expect("instruction" in s2).toBe(false);
    expect(s2.reconcile).toBe(true);
  });
});

describe("T4 显示面不动: 带新段事件的渲染与旧事件逐字节相同", () => {
  test("agentStatusLines(新段快照) 与 agentStatusLines(旧快照) 逐字节相同", () => {
    const lines = ["- [ ] [t1] alpha task", "- [ ] [t2] beta 任务"];
    const legacy = agentStatusFromEvent(agentStatusEvent("bash", lines))!;
    const extended = agentStatusFromEvent({
      type: "agent_status",
      lastTool: "bash",
      openTodoLines: lines,
      instruction: "pivot 指令首行",
      reconcile: true,
    })!;
    for (const cols of [80, 40, 12]) {
      expect(JSON.stringify(agentStatusLines(extended, cols))).toBe(
        JSON.stringify(agentStatusLines(legacy, cols))
      );
    }
  });

  test("chrome 不加 instruction/reconcile 行（Out-of-scope 钉子）", () => {
    const snapshot = agentStatusFromEvent({
      type: "agent_status",
      lastTool: "bash",
      openTodoLines: ["- [ ] alpha task"],
      instruction: "pivot 指令首行",
      reconcile: true,
    })!;
    const rendered = agentStatusLines(snapshot, 80)
      .map((l) => l.text)
      .join("\n");
    expect(rendered).not.toContain("pivot 指令首行");
    expect(rendered.toLowerCase()).not.toContain("reconcile");
    expect(rendered).toContain("alpha task");
  });
});

describe("agentStatusFromMessages: 新格式栏冷启动 hydrate（TUI 消费面）", () => {
  test("含 instruction/reconcile 段的栏 hydrate 得合法快照，todo 段不被标量行污染", () => {
    const bar = buildAgentStatusText({
      lastTool: "todo_write",
      openTodoLines: ["- [ ] [t1] keep going"],
      instruction: "换方向",
      reconcile: true,
    });
    const messages: AnthropicNativeMessage[] = [
      { role: "user", content: [{ type: "text", text: bar }] },
    ];
    const snapshot = agentStatusFromMessages(messages);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.lastTool).toBe("todo_write");
    expect(snapshot!.instruction).toBe("换方向");
    expect(snapshot!.reconcile).toBe(true);
    expect([...snapshot!.openTodoLines]).toEqual(["- [ ] [t1] keep going"]);
    // Display surface unchanged: hydrated new fields still project only todo lines
    const lines = agentStatusLines(snapshot, 80);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("keep going");
  });
});

// ---------------------------------------------------------------------------
// Projection: snapshot → display lines
// ---------------------------------------------------------------------------

describe("agentStatusLines: 现势投影", () => {
  test("null 快照(尚未有事件)→ 0 行(面板不渲染)", () => {
    expect(agentStatusLines(null, 80)).toEqual([]);
  });

  test("无未勾项 → 0 行(不印 last_tool)", () => {
    const lines = agentStatusLines(
      { lastTool: "read_file", openTodoLines: [] },
      80
    );
    expect(lines).toEqual([]);
  });

  test("有未勾项 → 单行用 · 拼接(剥掉 '- [ ] ' 前缀;不印 last_tool)", () => {
    const lines = agentStatusLines(
      {
        lastTool: "todo_write",
        openTodoLines: ["- [ ] alpha task", "- [ ] beta task"],
      },
      80
    );
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("alpha task");
    expect(lines[0]!.text).toContain("beta task");
    expect(lines[0]!.text).toContain(" · ");
    expect(lines[0]!.text).not.toContain("last_tool");
    expect(lines[0]!.text).not.toContain("- [ ]");
  });

  test("多项仍只占 1 行(窄宽截断)", () => {
    const items = Array.from({ length: 6 }, (_, i) => `- [ ] task ${i + 1}`);
    const lines = agentStatusLines(
      { lastTool: "idle", openTodoLines: items },
      40
    );
    expect(lines.length).toBe(1);
    const width = [...lines[0]!.text].reduce((acc, ch) => {
      const cp = ch.codePointAt(0)!;
      return acc + (cp > 0x2e7f ? 2 : 1);
    }, 0);
    expect(width).toBeLessThanOrEqual(40);
  });

  test("超长条目按视觉宽度截断到单行(不溢出 cols)", () => {
    const longItem = `- [ ] ${"很长的任务".repeat(30)}`;
    const lines = agentStatusLines(
      { lastTool: "bash", openTodoLines: [longItem] },
      40
    );
    expect(lines.length).toBe(1);
    for (const line of lines) {
      // CJK chars count as 2 columns; total must not exceed cols.
      const width = [...line.text].reduce((acc, ch) => {
        const cp = ch.codePointAt(0)!;
        return acc + (cp > 0x2e7f ? 2 : 1);
      }, 0);
      expect(width).toBeLessThanOrEqual(40);
    }
  });

  test("无未勾项(含 last_tool 换行)→ 仍 0 行", () => {
    const lines = agentStatusLines(
      { lastTool: "weird\nname", openTodoLines: [] },
      80
    );
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No second ledger: src/tui never reads todos.md (grep guard)
// ---------------------------------------------------------------------------

describe("no second todo ledger: src/tui 不读 todos.md", () => {
  test("src/tui 全部源码无 todos.md / TODOS_FILE / readOpenTodoLines 引用", () => {
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
    expect(files.length).toBeGreaterThan(0);
    const banned = ["todos.md", "TODOS_FILE", "readOpenTodoLines"];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const marker of banned) {
        expect(src.includes(marker)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Line-ledger linkage: agentStatusLines projection ↔ chromeReserveRows.
// The "default → baseline 7 unchanged" invariant is pinned by its SSOT home
// chrome-budget.test.ts (not duplicated here; only "projected rows ==
// accounted rows" linkage is tested).
// ---------------------------------------------------------------------------

describe("chromeReserveRows: agentStatusRows 投影联动", () => {
  const base = {
    noticeRows: 0,
    inputHintRows: 0,
    bgLine: false,
    inputRows: 1,
  };

  test("有未勾项 → 投影 1 行,入账 +1", () => {
    const rows = agentStatusLines(
      {
        lastTool: "todo_write",
        openTodoLines: ["- [ ] alpha task", "- [ ] beta task"],
      },
      80
    ).length;
    expect(rows).toBe(1);
    expect(chromeReserveRows({ ...base, agentStatusRows: rows })).toBe(7 + 1);
  });

  test("无未勾项的现势 = 投影 0 行 → 入账不增", () => {
    const snapshot = { lastTool: "idle", openTodoLines: [] as const };
    const rows = agentStatusLines(snapshot, 80).length;
    expect(rows).toBe(0);
    expect(chromeReserveRows({ ...base, agentStatusRows: rows })).toBe(7);
  });

  test("尚无快照(null)→ 投影 0 行 → 入账不增(app 预算口径同款联动)", () => {
    const rows = agentStatusLines(null, 80).length;
    expect(rows).toBe(0);
    expect(chromeReserveRows({ ...base, agentStatusRows: rows })).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: loop emit → hub wrappedOnStream passthrough → bridge
// postMessage → host callback (the TUI read path; the spec's "same current
// state" claim is cross-asserted on the real chain)
// ---------------------------------------------------------------------------

describe("端到端:bridge postMessage 透传 agent_status 事件", () => {
  test("chat 形状 deps(agentStatus 在场)→ onStream 收到事件,字段 === 落盘会话里的栏", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "iknow-agent-status-e2e-"));
    try {
      const todoDir = join(baseDir, "todos-dir");
      await mkdir(todoDir, { recursive: true });
      const bridge = createTuiBridge({
        dataDir: baseDir,
        workspaceRoot: baseDir,
        // makeDeps omits agentStatus; explicitly add the chat-surface assembly
        // shape (agentStatus is wired when build-engine surface !== "ask", see build-engine.ts).
        deps: {
          ...makeDeps([assistantResult({ texts: ["ok"] })]),
          agentStatus: { todoDir },
        },
        inflight: createInflightRegistry(),
      });
      const id = await bridge.ensureSession(undefined);
      // loop-engine now reads `<todoDir>/<conversationId>/todos.md` by
      // conversationId (same SSOT as the todo_write writer side, see
      // resolveConversationTodoPath). ensureSession first to obtain the
      // conversationId, then seed the ledger in that conversation's subdir.
      await mkdir(join(todoDir, id), { recursive: true });
      await writeFile(
        join(todoDir, id, "todos.md"),
        "- [ ] e2e open task\n- [x] e2e done task\n",
        "utf8"
      );
      const events: HarnessStreamEvent[] = [];
      await bridge.postMessage({
        conversationId: id,
        text: "跑一步",
        onStream: (event) => events.push(event),
      });

      const received = events.filter(
        (e): e is Extract<HarnessStreamEvent, { type: "agent_status" }> =>
          e.type === "agent_status"
      );
      expect(received.length).toBe(1);
      expect(received[0]!.lastTool).toBe("idle");
      expect([...received[0]!.openTodoLines]).toEqual([
        "- [ ] [t1] e2e open task",
      ]);

      // Same current state: the bar text the model actually sees in the
      // persisted conversation carries the same fields (open items present,
      // done items absent).
      const file = await bridge.loadSessionFile(id);
      const barMsg = [...file.messages]
        .reverse()
        .find(
          (m) =>
            m.role === "user" &&
            m.content.some(
              (b) => b.type === "text" && b.text.startsWith("<agent_status>")
            )
        );
      expect(barMsg).toBeDefined();
      const barText = barMsg!.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      expect(barText).toContain("last_tool: idle");
      expect(barText).toContain("- [ ] [t1] e2e open task");
      expect(barText).not.toContain("[x]");
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
