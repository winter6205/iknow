/**
 * tests/tui/agent-status-panel.test.ts
 *
 * #647 T3 / ADR-0028 / CONTEXT「状态栏」:TUI 只读最新现势 ——
 *   - 状态唯一来源是 harness 在注入 `<agent_status>` 栏的同一计算点发出的
 *     `agent_status` 流事件(agentStatusFromEvent 投影;replace-on-event,
 *     每个事件产**完整独立**的快照 → 单 state 槽整体替换,无历史、无合并);
 *   - 显示:有未勾项 → 单行 `□ a · b · c`(不印 last_tool);无未勾项 → 0 行;
 *   - src/tui 绝不读 todos.md / 不 import 账本读取器(grep 守卫:不出现
 *     第二份 todo 状态源);
 *   - 行数入账 chromeReserveRows.agentStatusRows(行账 SSOT)。
 *
 * bun:test(纯函数直驱,不依赖 React 渲染)。
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
// 冷启动 hydrate:栏文本 parse + messages 末栏投影
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
// 状态来源:事件 → 快照(replace-on-event 语义的构造性证据)
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
    // replace-on-event 的构造性证据:每个事件的投影都是自包含快照,不读取、
    // 不保留任何先前状态 → app 的单 state 槽 setAgentStatus(投影) 即
    // 「旧快照被整体替换」,不可能出现新旧混合(第二份账本)。
    const older = agentStatusFromEvent(
      agentStatusEvent("idle", ["- [ ] old task"])
    )!;
    const newer = agentStatusFromEvent(agentStatusEvent("bash", []))!;
    expect(newer.lastTool).toBe("bash");
    expect([...newer.openTodoLines]).toEqual([]);
    expect([...older.openTodoLines]).toEqual(["- [ ] old task"]);
    // 不同引用、无共享数组。
    expect(newer).not.toBe(older);
  });
});

// ---------------------------------------------------------------------------
// spec agent-status-instruction-echo 子弹5 / T4：显示面不动 —— 事件映射扩
// （容忍并透传 instruction/reconcile），AgentStatusLine 消费面零变化。
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
    // 显示面不动:hydrate 出来的新字段照样只投影 todo 行
    const lines = agentStatusLines(snapshot, 80);
    expect(lines.length).toBe(1);
    expect(lines[0]!.text).toContain("keep going");
  });
});

// ---------------------------------------------------------------------------
// 投影:快照 → 显示行
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
      // 视觉宽度(CJK 2 列)不超 cols。
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
// 不另建账本:src/tui 绝不读 todos.md(grep 守卫)
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
// 行账联动:agentStatusLines 投影 ↔ chromeReserveRows(投影-入账 linkage)
// 注:缺省 → 基线 7 不变的 invariant 由 SSOT 本家 chrome-budget.test.ts 钉死
//(本文件不重复;此处只测「投影行数 == 入账行数」的联动)。
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
// 端到端:loop emit → hub wrappedOnStream 透传 → bridge postMessage → 宿主回调
// (TUI 读口的产品路径;AC ①「同一份现势」在真实链路上交叉断言)
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
        // makeDeps 不带 agentStatus;显式补上 chat surface 的装配形状
        //(build-engine surface !== "ask" 时装 agentStatus,见 build-engine.ts)。
        deps: {
          ...makeDeps([assistantResult({ texts: ["ok"] })]),
          agentStatus: { todoDir },
        },
        inflight: createInflightRegistry(),
      });
      const id = await bridge.ensureSession(undefined);
      // #304601e3:loop-engine 现按 conversationId 读
      // `<todoDir>/<conversationId>/todos.md`(与 todo_write 写入侧同一 SSOT,
      // 见 resolveConversationTodoPath)。先 ensureSession 拿到 conversationId,
      // 再把种子账本写到该会话自己的子目录。
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

      // 同一份现势:落盘会话里模型实际看到的栏文本含同一字段(未勾项在场、
      // 已勾项缺席)。
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
