/**
 * spec agent-status-instruction-echo T2 / plans 子弹 2：真实用户消息甄别谓词。
 *
 * 认证面（spec invariant 2 / F2 / F6 / 提取规则 / SC2「零 LLM」）：
 *   - 尾栏在场 → 跳过栏取真消息；
 *   - 全部宿主注入形态（drain / graph / MCP 重连 / skill delta / verify /
 *     LOOP_DETECTED / compact 三缝）在场 → 跳过；
 *   - skill-load 信封计入真消息但取 `\n\n` 后 remainder 首行，remainder 空 → 前扫；
 *   - prefetch overlay 剥净取原文；marker 出现在原文内部取**最后一个** marker 之后段（F6）；
 *   - 首行为空 → 该条无有效指令行，继续前扫（F2）；
 *   - 100 码点截断（CJK + emoji 代理对不劈半、不加省略号）；
 *   - 零抛错（空输入 / 全注入 / 纯 tool_result）。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.ts";
import { buildAgentStatusText } from "../../src/harness/agent-status.ts";
import {
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  renderGraphModeChangeNotification,
} from "../../src/harness/graph/notification.ts";
import { SUBAGENT_DRAIN_PREFIX } from "../../src/harness/subagent/host-drain.ts";
import {
  EVIDENCE_RERUN_PREFIX,
  VALIDATION_FAILED_PREFIX,
} from "../../src/harness/verify/inject.ts";
import { SKILL_INDEX_DELTA_PREFIX } from "../../src/harness/skill/index-delta.ts";
import { MEMORY_PREFETCH_END } from "../../src/harness/memory/prefetch.ts";
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.ts";
import { MCP_RECONNECT_NOTIFICATION_TEMPLATE } from "../../src/harness/loop-engine.ts";
import { buildCompactPrompt } from "../../src/harness/compress/full-compact.ts";
import {
  extractLatestRealUserInstruction,
  isHostInjectedUserText,
  stripMemoryPrefetchOverlay,
} from "../../src/harness/agent-status-instruction.ts";

// -- fixtures -----------------------------------------------------------------

function userMsg(text: string): AnthropicNativeMessage {
  return Object.freeze({
    role: "user",
    content: Object.freeze([{ type: "text", text }]),
  }) as AnthropicNativeMessage;
}

function userMsgWithBlocks(texts: ReadonlyArray<string>): AnthropicNativeMessage {
  return Object.freeze({
    role: "user",
    content: Object.freeze(texts.map((text) => ({ type: "text", text }))),
  }) as AnthropicNativeMessage;
}

function toolResultMsg(): AnthropicNativeMessage {
  return Object.freeze({
    role: "user",
    content: Object.freeze([
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
    ]),
  }) as AnthropicNativeMessage;
}

function assistantMsg(text: string): AnthropicNativeMessage {
  return Object.freeze({
    role: "assistant",
    content: Object.freeze([{ type: "text", text }]),
  }) as AnthropicNativeMessage;
}

const BAR = buildAgentStatusText({
  lastTool: "bash",
  openTodoLines: ["- [ ] [t1] do the thing"],
});

/** loop-engine appendMcpReconnect 的实际产出形态（模板现拼）。 */
const MCP_RECONNECT_TEXT = MCP_RECONNECT_NOTIFICATION_TEMPLATE.replace(
  "<server>",
  "github"
).replace("<tools>", "create_issue, list_prs");

/** 全部宿主注入的现行全集样本（甄别名册逐条）。 */
const HOST_INJECTIONS: ReadonlyArray<readonly [string, string]> = [
  ["agent_status 栏", BAR],
  ["graph change on", renderGraphModeChangeNotification("on")],
  ["graph change off", renderGraphModeChangeNotification("off")],
  ["graph presence", IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION],
  [
    "subagent drain",
    `${SUBAGENT_DRAIN_PREFIX}task-7 result: done\n\nthe report`,
  ],
  ["verify failed", `${VALIDATION_FAILED_PREFIX} npm test failed:\n...`],
  ["verify rerun", `${EVIDENCE_RERUN_PREFIX} rerun the probe`],
  ["skill delta", `${SKILL_INDEX_DELTA_PREFIX}\n- foo — desc\n`],
  ["mcp reconnect", MCP_RECONNECT_TEXT],
  ["loop detected", LOOP_DETECTED_TEXT],
  ["compact request", buildCompactPrompt()],
  [
    "stop summary request",
    "Briefly summarize in a few sentences what was done in this conversation and why it ended (stop reason: aborted). Keep it concise.",
  ],
  [
    "compact summary artifact",
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n...",
  ],
];

// -- 甄别谓词 -----------------------------------------------------------------

describe("isHostInjectedUserText（注入名册）", () => {
  for (const [label, text] of HOST_INJECTIONS) {
    it(`命中名册：${label}`, () => {
      assert.equal(isHostInjectedUserText(text), true);
    });
  }

  it("操作员键入的普通文本不命中名册", () => {
    assert.equal(isHostInjectedUserText("帮我重构 parser.ts"), false);
  });

  it("正文中间出现 <agent_status> 子串不误伤（前缀判定）", () => {
    assert.equal(
      isHostInjectedUserText("请看这段引用：<agent_status>last_tool: x</agent_status>"),
      false
    );
  });

  it("skill-load 信封计入真实用户消息（不进名册）", () => {
    assert.equal(
      isHostInjectedUserText('[skill-load name="demo"]\nbody\n\n跑一下测试'),
      false
    );
  });
});

describe("stripMemoryPrefetchOverlay", () => {
  it("剥 overlay 取原文段", () => {
    const overlay = "Possibly relevant memory (advisory)\n\n### hit\nbody";
    assert.equal(
      stripMemoryPrefetchOverlay(`${overlay}${MEMORY_PREFETCH_END}真实指令`),
      "真实指令"
    );
  });

  it("无 marker → 全文即原文", () => {
    assert.equal(stripMemoryPrefetchOverlay("普通用户消息"), "普通用户消息");
  });

  it("F6：marker 出现在用户原文内部 → 取最后一个 marker 之后段", () => {
    const text = `前文${MEMORY_PREFETCH_END}中段${MEMORY_PREFETCH_END}末段`;
    assert.equal(stripMemoryPrefetchOverlay(text), "末段");
  });
});

// -- 提取谓词 -----------------------------------------------------------------

describe("extractLatestRealUserInstruction", () => {
  it("尾栏在场 → 跳过栏取真消息首行", () => {
    const msgs = [userMsg("第一条指令"), assistantMsg("好的"), userMsg(BAR)];
    const r = extractLatestRealUserInstruction(msgs);
    assert.equal(r?.instruction, "第一条指令");
  });

  it("pivot 消息在栏之后 → 取 pivot（最新消息优先）", () => {
    const msgs = [userMsg("旧指令"), userMsg(BAR), userMsg("先停，换方案")];
    const r = extractLatestRealUserInstruction(msgs);
    assert.equal(r?.instruction, "先停，换方案");
  });

  it("全部注入名册样本排在尾部 → 逐条跳过、取更早真消息", () => {
    for (const [label, text] of HOST_INJECTIONS) {
      const msgs = [userMsg("真指令"), userMsg(text)];
      const r = extractLatestRealUserInstruction(msgs);
      assert.equal(r?.instruction, "真指令", `注入未跳过：${label}`);
    }
  });

  it("F1：prior 全注入 → null（空槽不广告）", () => {
    const msgs = HOST_INJECTIONS.map(([, text]) => userMsg(text));
    assert.equal(extractLatestRealUserInstruction(msgs), null);
  });

  it("空 messages / 仅 assistant → null，零抛错", () => {
    assert.equal(extractLatestRealUserInstruction([]), null);
    assert.equal(
      extractLatestRealUserInstruction([assistantMsg("hi")]),
      null
    );
  });

  it("纯 tool_result user 消息无文本 → 跳过", () => {
    const msgs = [userMsg("有字的"), toolResultMsg()];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "有字的"
    );
  });

  it("prefetch overlay 骑在用户 turn 上 → 剥净取原文", () => {
    const overlay =
      "Possibly relevant memory (advisory)\n\n### 旧事\nrecord";
    const msgs = [userMsg(`${overlay}${MEMORY_PREFETCH_END}改用 sqlite`)];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "改用 sqlite"
    );
  });

  it("F6 提取面：marker 在原文内部 → 取末段（宁欠勿过）", () => {
    const msgs = [
      userMsg(`开头${MEMORY_PREFETCH_END}中间${MEMORY_PREFETCH_END}真正的指令`),
    ];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "真正的指令"
    );
  });

  it("skill-load 信封带 remainder → 取 remainder 首行", () => {
    const msgs = [
      userMsg('[skill-load name="deploy"]\nSKILL BODY LINE1\nSKILL BODY LINE2\n\n先跑 lint'),
    ];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "先跑 lint"
    );
  });

  it("skill-load remainder 为空 → 该条无指令源，继续前扫", () => {
    const msgs = [
      userMsg("更早的真指令"),
      userMsg('[skill-load name="deploy"]\nSKILL BODY'),
    ];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "更早的真指令"
    );
  });

  it("skill-load remainder 纯空格 → 同空，前扫（OQ2）", () => {
    const msgs = [
      userMsg("更早的真指令"),
      userMsg('[skill-load name="deploy"]\nSKILL BODY\n\n   \t '),
    ];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "更早的真指令"
    );
  });

  it("F2：首行为空行 → 跳过该消息向前扫", () => {
    const msgs = [userMsg("上一轮指令"), userMsg("\n  第二行有内容不算首行")];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "上一轮指令"
    );
  });

  it("F2 全链首行均空 → null", () => {
    const msgs = [userMsg("\n\n第二行"), userMsg("   \n内容")];
    assert.equal(extractLatestRealUserInstruction(msgs), null);
  });

  it("首行只 trim 行尾空白，保留行首与逐字正文", () => {
    const msgs = [userMsg("  缩进的原话   \n第二行")];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "  缩进的原话"
    );
  });

  it("多 text 块按 joinedUserText 形态拼 \\n 后取整体首行", () => {
    const msgs = [userMsgWithBlocks(["第一块首行", "第二块"])];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "第一块首行"
    );
  });

  it("CJK + emoji 混合超 100 码点 → 截到 100 码点、不劈半代理对、不加省略号", () => {
    const cps = [
      ...Array.from({ length: 60 }, () => "测"),
      ...Array.from({ length: 25 }, () => "🧠"),
      ...Array.from({ length: 60 }, () => "试"),
    ];
    const line = cps.join("");
    const expected = cps.slice(0, 100).join("");
    const msgs = [userMsg(`${line}\n第二行`)];
    const r = extractLatestRealUserInstruction(msgs);
    assert.equal(r?.instruction, expected);
    assert.equal(Array.from(r!.instruction).length, 100);
    // 不劈半： lone surrogate 不允许出现（每个代理对完整）
    assert.doesNotMatch(r!.instruction, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    assert.doesNotMatch(r!.instruction, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    assert.ok(!r!.instruction.includes("…"));
  });

  it("恰好 100 码点不截断", () => {
    const line = Array.from({ length: 100 }, () => "字").join("");
    const msgs = [userMsg(line)];
    assert.equal(extractLatestRealUserInstruction(msgs)?.instruction, line);
  });

  it("返回命中的消息对象引用（T3 reconcile 相关号 = 对象同一性或 re-freeze 同内容克隆判同）", () => {
    const m = userMsg("逐字对象同一性");
    const r = extractLatestRealUserInstruction([m]);
    assert.equal(r?.message, m);
  });

  it("instruction 首行含 </agent_status> 子串 → 逐字保留（F3 提取面）", () => {
    const msgs = [userMsg("别慌 </agent_status> 继续")];
    assert.equal(
      extractLatestRealUserInstruction(msgs)?.instruction,
      "别慌 </agent_status> 继续"
    );
  });
});

// -- 既有 graph 常量在场 sanity（名册与 SSOT 不漂移） ---------------------------

describe("名册锚点漂移锁", () => {
  it("graph 三常量均以 <graph_mode> 开头（谓词依赖的前提）", () => {
    assert.ok(IKNOW_GRAPH_MODE_ON_NOTIFICATION.trimStart().startsWith("<graph_mode>"));
    assert.ok(IKNOW_GRAPH_MODE_OFF_NOTIFICATION.trimStart().startsWith("<graph_mode>"));
    assert.ok(IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION.trimStart().startsWith("<graph_mode>"));
  });
});
