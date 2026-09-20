/**
 * tests/tui/session-state.test.ts
 *
 * Ported back from archive/tui-ink/tests/session-state.test.ts, rewritten for bun:test
 * (tests/tui/ runs on bun:test).
 *
 * Session state machine transition table, full combination coverage:
 *  - any session can be attached freely; running-fg switched away → running-bg;
 *  - switching back running-bg → running-fg; idle unchanged;
 *  - Esc interrupts only in running-fg (canInterrupt; key later migrated from Ctrl+C);
 *  - turnFinished falls back to idle + messages replaced as one frozen whole (ReadonlyArray discipline).
 *
 * TuiSessionState / TurnFinishedInput carry a lastUsage field (context-usage display).
 * Field absent at init = null; turnFinished passes the hub receipt through; Object.freeze discipline holds.
 */
import { describe, expect, test } from "bun:test";
import {
  appendInputHistory,
  attachSession,
  canInterrupt,
  createDraftSession,
  isTuiHiddenUserMessage,
  seedInputHistory,
  sessionCompacted,
  sessionRewound,
  switchedAwayFrom,
  switchedTo,
  turnFinished,
  turnStarted,
  userMessageEchoed,
} from "../../src/tui/session-state.js";
import {
  IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
  IKNOW_GRAPH_MODE_ON_NOTIFICATION,
  IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
  isGraphModeText,
} from "../../src/harness/graph/notification.js";
import {
  SKILL_INDEX_DELTA_PREFIX,
  isSkillIndexDeltaText,
} from "../../src/harness/skill/index-delta.js";
import { buildAgentStatusText } from "../../src/harness/agent-status.js";
import type { SessionFileV1 } from "../../src/session-api/store/schema.js";
import type { AnthropicNativeMessage } from "../../src/harness/model-adapter/types.js";

const msg = (
  text: string,
  role: "user" | "assistant" = "user"
): AnthropicNativeMessage => ({
  role,
  content: [{ type: "text", text }],
});

function sampleFile(overrides?: Partial<SessionFileV1>): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2,
    conversation_id: "conv-1",
    messages: [msg("你好"), msg("你好，有什么可以帮你？", "assistant")],
    jsonMode: false,
    turnCount: 1,
    updatedAt: now,
    title: "你好",
    cwd: "/tmp/proj",
    sanitized_at: now,
    ...overrides,
  };
}

describe("session-state: draft / attach", () => {
  test("createDraftSession：未建档、空消息、idle、冻结", () => {
    const draft = createDraftSession();
    expect(draft.conversationId).toBeUndefined();
    expect(draft.messages).toHaveLength(0);
    expect(draft.runState).toBe("idle");
    expect(Object.isFrozen(draft)).toBe(true);
    expect(Object.isFrozen(draft.messages)).toBe(true);
  });

  test("createDraftSession：lastUsage 初值 null（无首轮 usage）", () => {
    expect(createDraftSession().lastUsage).toBeNull();
  });

  test("attachSession：从文件恢复（消息冻结拷贝，不与源共享引用）", () => {
    const file = sampleFile();
    const attached = attachSession(file);
    expect(attached.conversationId).toBe("conv-1");
    expect(attached.messages).toHaveLength(2);
    expect(attached.turnCount).toBe(1);
    expect(attached.runState).toBe("idle");
    expect(Object.isFrozen(attached.messages)).toBe(true);
    expect(attached.messages).not.toBe(file.messages);
  });

  test("attachSession：lastUsage 初值 null（lastUsage 只来自运行时回执，不从文件读）", () => {
    expect(attachSession(sampleFile()).lastUsage).toBeNull();
  });
});

describe("session-state: 三态转换表（Q1a）", () => {
  test("turnStarted：idle → running-fg；非 idle 保持原状态", () => {
    const draft = createDraftSession();
    const started = turnStarted(draft);
    expect(started.runState).toBe("running-fg");
    // a duplicate start (caller bug) neither throws nor changes anything
    expect(turnStarted(started)).toBe(started);
  });

  test("switchedAwayFrom：running-fg → running-bg（后台继续执行）", () => {
    const running = turnStarted(createDraftSession());
    expect(switchedAwayFrom(running).runState).toBe("running-bg");
  });

  test("switchedAwayFrom：idle 会话切走不变", () => {
    const idle = createDraftSession();
    expect(switchedAwayFrom(idle)).toBe(idle);
  });

  test("switchedTo：running-bg → running-fg；idle 不变", () => {
    const bg = switchedAwayFrom(turnStarted(createDraftSession()));
    expect(switchedTo(bg).runState).toBe("running-fg");
    const idle = createDraftSession();
    expect(switchedTo(idle)).toBe(idle);
  });

  test("canInterrupt：仅 running-fg 可打断（Esc 作用域 Q1a）", () => {
    const draft = createDraftSession();
    expect(canInterrupt(draft)).toBe(false);
    const fg = turnStarted(draft);
    expect(canInterrupt(fg)).toBe(true);
    const bg = switchedAwayFrom(fg);
    expect(canInterrupt(bg)).toBe(false);
  });

  test("turnFinished：落回 idle + 消息/turnCount/updatedAt 整体替换", () => {
    const started = turnStarted(createDraftSession());
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("问"),
      msg("答", "assistant"),
    ];
    const done = turnFinished(started, {
      conversationId: "conv-9",
      messages,
      turnCount: 1,
      updatedAt: "2026-08-05T00:00:00.000Z",
      jsonMode: false,
      stopReason: "completed",
    });
    expect(done.runState).toBe("idle");
    expect(done.conversationId).toBe("conv-9");
    expect(done.messages).toHaveLength(2);
    expect(done.lastStopReason).toBe("completed");
    expect(Object.isFrozen(done.messages)).toBe(true);
  });

  test("turnFinished：cancelled 也落回 idle（hub DROP_REASONS 不落盘由 hub 保证）", () => {
    const started = turnStarted(createDraftSession());
    const done = turnFinished(started, {
      conversationId: "conv-9",
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
      stopReason: "cancelled",
      lastUsage: null,
    });
    expect(done.runState).toBe("idle");
    expect(done.lastStopReason).toBe("cancelled");
  });
});

describe("session-state: lastUsage（T3，上下文用量显示）", () => {
  test("turnFinished 传 lastUsage → state.lastUsage 命中 + 冻结纪律保持", () => {
    const lastUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 300,
    };
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("问"),
      msg("答", "assistant"),
    ];
    const done = turnFinished(createDraftSession(), {
      conversationId: "conv-t3",
      messages,
      turnCount: 1,
      updatedAt: "2026-08-05T00:00:00.000Z",
      jsonMode: false,
      stopReason: "completed",
      lastUsage,
    });
    expect(done.lastUsage).toEqual(lastUsage);
    expect(Object.isFrozen(done)).toBe(true);
    expect(Object.isFrozen(done.messages)).toBe(true);
  });

  test("turnFinished 无 lastUsage（null）→ state.lastUsage 为 null", () => {
    const done = turnFinished(createDraftSession(), {
      conversationId: "conv-t3",
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
      stopReason: "completed",
      lastUsage: null,
    });
    expect(done.lastUsage).toBeNull();
  });
});

describe("session-state: workspaceRoot（ADR-0037 T5，worktree 隔离现势）", () => {
  test("createDraftSession：workspaceRoot 初值 undefined（未绑定 = 无隔离状态）", () => {
    expect(createDraftSession().workspaceRoot).toBeUndefined();
  });

  test("attachSession：文件带 workspaceRoot（T3 改绑落盘）→ state 携带该根", () => {
    const wt = "/repo/.iknow/worktrees/conv-1";
    const file = sampleFile({ workspaceRoot: wt });
    const attached = attachSession(file);
    expect(attached.workspaceRoot).toBe(wt);
  });

  test("attachSession：文件无 workspaceRoot（开关 OFF / 尚未 mutate）→ undefined", () => {
    expect(attachSession(sampleFile()).workspaceRoot).toBeUndefined();
  });

  test("turnFinished：回执带 workspaceRoot（改绑回合的落盘文件）→ state 携带", () => {
    const started = turnStarted(createDraftSession());
    const done = turnFinished(started, {
      conversationId: "conv-t5",
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
      stopReason: "completed",
      workspaceRoot: "/repo/.iknow/worktrees/conv-t5",
    });
    expect(done.workspaceRoot).toBe("/repo/.iknow/worktrees/conv-t5");
  });

  test("turnFinished：回执不带 workspaceRoot（普通回合）→ 保留既有值，不误清", () => {
    const bound = attachSession(
      sampleFile({ workspaceRoot: "/repo/.iknow/worktrees/conv-1" })
    );
    const done = turnFinished(bound, {
      conversationId: "conv-1",
      messages: [],
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
      stopReason: "completed",
    });
    expect(done.workspaceRoot).toBe("/repo/.iknow/worktrees/conv-1");
  });

  test("sessionCompacted / sessionRewound：保留 workspaceRoot（非 turn 路径不改绑定）", () => {
    const bound = attachSession(
      sampleFile({ workspaceRoot: "/repo/.iknow/worktrees/conv-1" })
    );
    const input = {
      messages: [] as ReadonlyArray<AnthropicNativeMessage>,
      turnCount: 0,
      updatedAt: "",
      jsonMode: false,
    };
    expect(sessionCompacted(bound, input).workspaceRoot).toBe(
      "/repo/.iknow/worktrees/conv-1"
    );
    expect(sessionRewound(bound, input).workspaceRoot).toBe(
      "/repo/.iknow/worktrees/conv-1"
    );
  });
});

describe("session-state: userMessageEchoed (T2 即时回显)", () => {
  test("正常追加：messages 末尾新增 user text 消息，其余字段不变", () => {
    const draft = createDraftSession();
    const echoed = userMessageEchoed(draft, "你好");
    expect(echoed.messages).toHaveLength(1);
    expect(echoed.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "你好" }],
    });
    // all other session fields kept verbatim.
    expect(echoed.conversationId).toBe(draft.conversationId);
    expect(echoed.turnCount).toBe(draft.turnCount);
    expect(echoed.runState).toBe(draft.runState);
  });

  test("空文本不追加（返回原状态）", () => {
    const draft = createDraftSession();
    expect(userMessageEchoed(draft, "")).toBe(draft);
    expect(userMessageEchoed(draft, "   ")).toBe(draft);
    expect(draft.messages).toHaveLength(0);
  });

  test("冻结纪律：返回新冻结状态，不 mutate 原状态", () => {
    const draft = createDraftSession();
    const echoed = userMessageEchoed(draft, "冻结测试");
    expect(Object.isFrozen(echoed)).toBe(true);
    expect(Object.isFrozen(echoed.messages)).toBe(true);
    expect(Object.isFrozen(echoed.messages[0]!)).toBe(true);
    // the original state was not mutated.
    expect(draft.messages).toHaveLength(0);
  });

  test("在既有消息后追加（不覆盖历史）", () => {
    const started = turnStarted(createDraftSession());
    const first = userMessageEchoed(started, "第一条");
    const second = userMessageEchoed(first, "第二条");
    expect(second.messages).toHaveLength(2);
    expect(second.messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "第二条" }],
    });
  });

  test("plans T5：displayText 与 sent 分离 —— echo 仅追加 displayText，不含 sent 正文", () => {
    // skill-load scenario: sent carries the full skill body (deterministically effective in model
    // history), displayText is the trimmed buildSkillLoadText shape (empty body + same remainder),
    // so the render layer's projectSkillLoadUserText extracts the same {name, remainder} —
    // the in-flight echo and the on-disk transcript display agree.
    const draft = createDraftSession();
    const sent = '[skill-load name="echo"]\n# 回声技能\nfull body\n\n帮我做 X';
    const displayText = '[skill-load name="echo"]\n\n帮我做 X';
    const echoed = userMessageEchoed(draft, displayText);
    expect(echoed.messages).toHaveLength(1);
    const only = echoed.messages[0]!;
    expect(only).toEqual({
      role: "user",
      content: [{ type: "text", text: displayText }],
    });
    // explicit assertion: the echo form never contains the sent body (core decoupling guarantee).
    expect(
      only.content[0]!.type === "text" ? only.content[0]!.text : ""
    ).not.toContain("# 回声技能");
    expect(
      only.content[0]!.type === "text" ? only.content[0]!.text : ""
    ).not.toContain("full body");
    // not shared with sent (sent still goes through sendTurn → postMessage → model history).
    expect(sent).not.toBe(displayText);
  });
});

describe("session-state: sessionCompacted（/compact 落盘后刷新）", () => {
  const compactedMessages: ReadonlyArray<AnthropicNativeMessage> = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "[compaction boundary — earlier messages cleared]",
        },
      ],
    },
    msg("尾部消息"),
  ];

  test("压缩后：消息/turnCount/updatedAt 替换，runState 归 idle", () => {
    const lastUsage = {
      inputTokens: 100,
      outputTokens: 20,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    // build an idle session that already ran a turn and holds lastUsage.
    const afterTurn = turnFinished(turnStarted(createDraftSession()), {
      conversationId: "conv-1",
      messages: [msg("问"), msg("答", "assistant")],
      turnCount: 1,
      updatedAt: "2026-08-05T00:00:00.000Z",
      jsonMode: false,
      stopReason: "completed",
      lastUsage,
    });
    const compacted = sessionCompacted(afterTurn, {
      messages: compactedMessages,
      turnCount: 1,
      updatedAt: "2026-08-06T00:00:00.000Z",
      jsonMode: false,
    });
    expect(compacted.runState).toBe("idle");
    expect(compacted.messages).toHaveLength(2);
    expect(compacted.messages[0]).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "[compaction boundary — earlier messages cleared]",
        },
      ],
    });
    expect(compacted.updatedAt).toBe("2026-08-06T00:00:00.000Z");
    // key semantics: compaction is not a turn, lastUsage / lastStopReason are kept.
    expect(compacted.lastUsage).toEqual(lastUsage);
    expect(compacted.lastStopReason).toBe("completed");
    expect(Object.isFrozen(compacted.messages)).toBe(true);
  });

  test("非 idle（running-fg）→ 保持原状态（与 turnStarted 同护栏语义）", () => {
    const running = turnStarted(createDraftSession());
    const result = sessionCompacted(running, {
      messages: compactedMessages,
      turnCount: 99,
      updatedAt: "2026-08-06T00:00:00.000Z",
      jsonMode: false,
    });
    expect(result).toBe(running); // same object reference, no replacement
  });
});

describe("session-state: isTuiHiddenUserMessage（host 注入不进 ❯ 气泡）", () => {
  test("agent_status 栏为 hidden；普通 query 否", () => {
    expect(
      isTuiHiddenUserMessage(
        msg("<agent_status>\nlast_tool: idle\n</agent_status>")
      )
    ).toBe(true);
    expect(
      isTuiHiddenUserMessage(
        msg(
          "<agent_status>\nlast_tool: web_search\ntodos:\n- [ ] 查新闻\n</agent_status>"
        )
      )
    ).toBe(true);
    expect(isTuiHiddenUserMessage(msg("真实问题"))).toBe(false);
  });

  test("含 instruction/reconcile 段的新格式栏仍 hidden（spec 子弹5 前缀判定不变）", () => {
    const bar = buildAgentStatusText({
      lastTool: "bash",
      openTodoLines: ["- [ ] 查新闻"],
      instruction: "pivot：改查天气",
      reconcile: true,
    });
    expect(isTuiHiddenUserMessage(msg(bar))).toBe(true);
    // a real user message containing instruction:/reconcile: → no false positive (new sections do not affect the prefix check)
    expect(isTuiHiddenUserMessage(msg("instruction: 这行开头的真实问题"))).toBe(
      false
    );
    expect(
      isTuiHiddenUserMessage(msg("reconcile: 先对齐账本是什么意思？"))
    ).toBe(false);
  });

  test("graph_mode 三条现势通知为 hidden（切换 ON/OFF + 每 run presence）；普通 query 否", () => {
    // same discipline as agent_status — the producer's own predicate
    // (isGraphModeText in src/harness/graph/notification.ts) decides hidden;
    // all three constants share one prefix, the TUI draws no ❯ bubble for them.
    for (const text of [
      IKNOW_GRAPH_MODE_ON_NOTIFICATION,
      IKNOW_GRAPH_MODE_OFF_NOTIFICATION,
      IKNOW_GRAPH_MODE_PRESENCE_NOTIFICATION,
    ]) {
      expect(isGraphModeText(text)).toBe(true);
      expect(isTuiHiddenUserMessage(msg(text))).toBe(true);
    }
    // forged shape: mentioning `<graph_mode>` only inside the body (not line-start) is not an
    // envelope — the predicate uses the same trimStart prefix check as agent_status, no user text collateral.
    expect(
      isTuiHiddenUserMessage(msg("为什么 transcript 里有 <graph_mode> 标签？"))
    ).toBe(false);
    expect(isTuiHiddenUserMessage(msg("真实问题"))).toBe(false);
  });

  test("drain / VALIDATION / VERIFY 为 hidden；普通 query 否", () => {
    expect(
      isTuiHiddenUserMessage(
        msg('## Sub-agent abc result: {"kind":"abort"}\n\n{}')
      )
    ).toBe(true);
    expect(
      isTuiHiddenUserMessage(
        msg("[VALIDATION FAILED] attempt=1/12 verdict=true-failure")
      )
    ).toBe(true);
    expect(
      isTuiHiddenUserMessage(msg("[VERIFY: rerun needed] attempt=1/12"))
    ).toBe(true);
    expect(isTuiHiddenUserMessage(msg("真实问题"))).toBe(false);
    expect(isTuiHiddenUserMessage(msg("答", "assistant"))).toBe(false);
  });

  test("skill-index delta listing 为 hidden（ADR-0098 第五类注入信封）；普通 query 否", () => {
    // ADR-0098: the delta listing is host-injected model history, not operator
    // keystrokes — the TUI draws no ❯ bubble. The producer's own predicate (isSkillIndexDeltaText
    // in src/harness/skill/index-delta.ts) must hit its own constant; the consumer side only calls
    // the predicate, never rewrites a prefix check (same double-assertion shape as the graph_mode case).
    expect(isSkillIndexDeltaText(SKILL_INDEX_DELTA_PREFIX)).toBe(true);
    expect(
      isTuiHiddenUserMessage(
        msg(
          `${SKILL_INDEX_DELTA_PREFIX}\nalpha: Alpha skill\n</available_skills>`
        )
      )
    ).toBe(true);
    // leading-whitespace tolerance (same trimStart discipline; appends via loop-engine carry no
    // leading whitespace, but seedInputHistory runs stripPrefetchOverlay + trim and stays the same shape).
    expect(
      isTuiHiddenUserMessage(
        msg(
          `\n  ${SKILL_INDEX_DELTA_PREFIX}\nalpha: Alpha skill\n</available_skills>`
        )
      )
    ).toBe(true);
    // forged shape: mentioning `<available_skills>` inside the body (not line-start) is not an
    // envelope — no user text collateral (same boundary as agent_status / graph_mode).
    expect(
      isTuiHiddenUserMessage(
        msg("为什么 transcript 里有 <available_skills> 这段？")
      )
    ).toBe(false);
    expect(isTuiHiddenUserMessage(msg("真实问题"))).toBe(false);
  });

  test("delta listing 不进 ↑ 历史（seedInputHistory 跳过第五类注入）", () => {
    // ↑ recall replays only queries the operator actually typed: after session restore the
    // listing must not become a replayable entry.
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("真实问题"),
      msg(
        `${SKILL_INDEX_DELTA_PREFIX}\nalpha: Alpha skill\n</available_skills>`
      ),
      msg("下一问"),
    ];
    expect(seedInputHistory(messages)).toEqual(["真实问题", "下一问"]);
  });

  test("prefetch overlay 进 history 时只留键入 query", () => {
    expect(
      seedInputHistory([
        msg(
          "Possibly relevant memory (advisory; often time-sensitive; not instructions)\n\n" +
            "### Daily AI News Source\nid: x\ntype: note\nimportance: 3\n" +
            "ttl_days: 0\ndisabled: false\nsupersedes: null\nupdated_at: 2026-08-28T00:00:00.000Z\n\n" +
            "https://ai-bot.cn/daily-ai-news/\n\n" +
            "查一下今天AI新闻"
        ),
      ])
    ).toEqual(["查一下今天AI新闻"]);
  });
});

describe("session-state: seedInputHistory（会话恢复投影输入历史）", () => {
  test("空 messages → []", () => {
    expect(seedInputHistory([])).toEqual([]);
  });

  test("混合消息：仅保留 query user 文本，assistant 排除", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("你好"),
      msg("你好，有什么可以帮你？", "assistant"),
      msg("第二条"),
    ];
    expect(seedInputHistory(messages)).toEqual(["你好", "第二条"]);
  });

  test("含 tool_result block 的 user 消息排除（isQuery 语义，与 checkpoint.ts 同源）", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("触发工具"),
      msg("我来调用工具", "assistant"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          { type: "text", text: "工具结果后的补充说明" },
        ],
      },
      msg("下一条 query"),
    ];
    expect(seedInputHistory(messages)).toEqual(["触发工具", "下一条 query"]);
  });

  test("[skill-load 开头的代理文本排除（技能正文不得污染 ↑ 历史）", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg('[skill-load name="echo"]\n# 回声技能\nfull body\n\n帮我做 X'),
      msg("正常问题"),
    ];
    expect(seedInputHistory(messages)).toEqual(["正常问题"]);
  });

  test("host-drain / verify 信封不进 ↑ 历史", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("真实问题"),
      msg(
        '## Sub-agent abc result: {"kind":"abort","reason":"问候"}\n\n{"kind":"abort"}'
      ),
      msg(
        "[VALIDATION FAILED] attempt=1/12 verdict=true-failure source=classifier\ntask: x"
      ),
      msg("[VERIFY: rerun needed] attempt=1/12\nRun this command"),
      msg("下一问"),
    ];
    expect(seedInputHistory(messages)).toEqual(["真实问题", "下一问"]);
  });

  test("相邻重复抑制；非相邻重复保留", () => {
    expect(seedInputHistory([msg("dup"), msg("dup")])).toEqual(["dup"]);
    expect(seedInputHistory([msg("a"), msg("b"), msg("a")])).toEqual([
      "a",
      "b",
      "a",
    ]);
  });

  test("多 text block：全部 text 用 \\n 连接（用户输入全文）", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      {
        role: "user",
        content: [
          { type: "text", text: "第一段" },
          { type: "text", text: "第二段" },
        ],
      },
    ];
    expect(seedInputHistory(messages)).toEqual(["第一段\n第二段"]);
  });

  test("纯空白 / 无 text block 的文本跳过", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("   "),
      msg("\n\t"),
      { role: "user", content: [] },
    ];
    expect(seedInputHistory(messages)).toEqual([]);
  });

  test("trim 后入历史：首尾空白剥除", () => {
    expect(seedInputHistory([msg("  hi  ")])).toEqual(["hi"]);
  });

  test("真实 turn 顺序保留（多轮 + tool 往返混合）", () => {
    const messages: ReadonlyArray<AnthropicNativeMessage> = [
      msg("第一问"),
      msg("答一", "assistant"),
      msg("第二问"),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "bash", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "out" }],
      },
      msg("答二", "assistant"),
      msg("第三问"),
    ];
    expect(seedInputHistory(messages)).toEqual(["第一问", "第二问", "第三问"]);
  });
});

describe("session-state: appendInputHistory（提交追加）", () => {
  test("空历史追加 → [text]", () => {
    expect(appendInputHistory([], "x")).toEqual(["x"]);
  });

  test("相邻重复：末条相同 → 返回同一引用（app.tsx setState 身份依赖）", () => {
    const history: ReadonlyArray<string> = ["x"];
    const appended = appendInputHistory(history, "x");
    expect(appended).toEqual(["x"]);
    expect(appended).toBe(history);
  });

  test("空白输入不追加：'' 与 '   ' 均返回原引用（空历史同样成立）", () => {
    const empty: ReadonlyArray<string> = [];
    expect(appendInputHistory(empty, "")).toBe(empty);
    const history: ReadonlyArray<string> = ["x"];
    expect(appendInputHistory(history, "")).toBe(history);
    expect(appendInputHistory(history, "   ")).toBe(history);
  });

  test("正常追加：新数组包含原条目 + 新条目，原数组不 mutate", () => {
    const history: ReadonlyArray<string> = ["x"];
    const appended = appendInputHistory(history, "y");
    expect(appended).toEqual(["x", "y"]);
    expect(appended).not.toBe(history);
    expect(history).toEqual(["x"]);
  });

  test("text 保持原样（不 trim；上游 handleSubmit 已 trim）", () => {
    expect(appendInputHistory([], "  keep  ")).toEqual(["  keep  "]);
  });
});
