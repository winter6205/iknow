/**
 * ADR-0113 session-list-title T4: lite 无工具标题生成模块单测。
 * 覆盖 sanitize / prompt 构造 / collectTitleSource 触发闸(寒暄、过短)/
 * createLiteTitleGenerator 单次补全的 happy / throw / 空响应 / timeout 分支。
 * 纯模块测试不碰 hub —— hub 触发语义见 tests/session-api/hub-title-generation.test.ts。
 */
import { describe, expect, it } from "vitest";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { CompactAdapter } from "../../src/harness/index.ts";
import {
  buildTitlePrompt,
  collectTitleSource,
  createLiteTitleGenerator,
  liteTitleGeneratorOptions,
  MAX_TITLE_CHARS,
  sanitizeSessionTitle,
} from "../../src/session-api/title-generation.ts";
import { assistantResult } from "../cli/_fixtures.ts";

// -- helpers -----------------------------------------------------------------

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResultUser(): AnthropicNativeMessage {
  const block: AnthropicContentBlock = {
    type: "tool_result",
    tool_use_id: "t1",
    content: "ok",
    is_error: false,
  };
  return { role: "user", content: [block] };
}

/** 脚本化 CompactAdapter：step 返回给定结果 / 抛错 / 永挂起；记录调用入参。 */
function makeAdapter(
  behavior:
    | { kind: "text"; text: string }
    | { kind: "throws"; error: unknown }
    | { kind: "never" }
): {
  adapter: CompactAdapter;
  calls: Array<{
    state: LoopState;
    request: Record<string, unknown>;
    signal: AbortSignal | undefined;
  }>;
} {
  const calls: Array<{
    state: LoopState;
    request: Record<string, unknown>;
    signal: AbortSignal | undefined;
  }> = [];
  const adapter: CompactAdapter = {
    encodeUserText: (t: string): AnthropicNativeMessage => userMsg(t),
    step: async (state, request, signal): Promise<AssistantTurnResult> => {
      calls.push({
        state,
        request: request as Record<string, unknown>,
        signal,
      });
      if (behavior.kind === "throws") throw behavior.error;
      if (behavior.kind === "never") {
        return new Promise<AssistantTurnResult>(() => {});
      }
      return assistantResult({
        texts: [behavior.text],
        toolCalls: [],
        supplierStop: "success",
      });
    },
  };
  return { adapter, calls };
}

// -- sanitizeSessionTitle -----------------------------------------------------

describe("sanitizeSessionTitle", () => {
  it("trims and keeps a normal single-line title", () => {
    expect(sanitizeSessionTitle("  登录模块重构  ")).toBe("登录模块重构");
  });

  it("flattens multi-line output into one line", () => {
    expect(sanitizeSessionTitle("登录\n模块\r\n重构")).toBe("登录 模块 重构");
  });

  it("collapses runs of whitespace", () => {
    expect(sanitizeSessionTitle("a    b\t\tc")).toBe("a b c");
  });

  it("caps length at MAX_TITLE_CHARS (80, aligned with extractTitle)", () => {
    const long = "字".repeat(120);
    const out = sanitizeSessionTitle(long);
    expect(out.length).toBe(MAX_TITLE_CHARS);
    expect(MAX_TITLE_CHARS).toBe(80);
  });

  it("returns empty string for blank / whitespace-only input", () => {
    expect(sanitizeSessionTitle("")).toBe("");
    expect(sanitizeSessionTitle("  \n\t ")).toBe("");
  });

  it("strips common quoted wrappers", () => {
    expect(sanitizeSessionTitle("「登录模块重构」")).toBe("登录模块重构");
    expect(sanitizeSessionTitle('"login refactor"')).toBe("login refactor");
  });
});

// -- buildTitlePrompt ---------------------------------------------------------

describe("buildTitlePrompt", () => {
  it("includes user queries and single-turn instruction", () => {
    const prompt = buildTitlePrompt({
      userQueries: ["帮我重构登录模块", "再补上单元测试"],
      assistantText: "已完成重构",
    });
    expect(prompt).toContain("帮我重构登录模块");
    expect(prompt).toContain("再补上单元测试");
    expect(prompt).toContain("已完成重构");
  });

  it("omits the assistant section when assistantText is empty", () => {
    const prompt = buildTitlePrompt({
      userQueries: ["q1"],
      assistantText: "",
    });
    expect(prompt).toContain("q1");
    expect(prompt).not.toContain("助手回复：");
  });

  it("includes the assistant section when assistantText is present", () => {
    const prompt = buildTitlePrompt({
      userQueries: ["q1"],
      assistantText: "a1",
    });
    expect(prompt).toContain("助手回复：a1");
  });

  it("caps query count and per-query length", () => {
    const many = Array.from({ length: 9 }, (_, i) => `问题${i}`);
    const longQ = "长".repeat(300);
    const prompt = buildTitlePrompt({
      userQueries: [...many.slice(0, 5), longQ],
      assistantText: "",
    });
    expect(prompt).toContain("问题4");
    expect(prompt).not.toContain("问题5");
    expect(prompt).not.toContain(longQ);
  });
});

// -- collectTitleSource (触发闸：spec Does 5 / 语义 (e)) ------------------------

describe("collectTitleSource", () => {
  it("returns source for a normal substantive first query", () => {
    const src = collectTitleSource(
      [userMsg("帮我重构登录模块并补齐测试"), assistantMsg("好的，开始")],
      "好的，开始"
    );
    expect(src).toBeDefined();
    expect(src?.userQueries).toEqual(["帮我重构登录模块并补齐测试"]);
    expect(src?.assistantText).toBe("好的，开始");
  });

  it("greeting-only conversation → undefined (不单独烧 lite)", () => {
    expect(
      collectTitleSource(
        [userMsg("你好"), assistantMsg("你好！有什么可以帮你？")],
        "你好！有什么可以帮你？"
      )
    ).toBeUndefined();
  });

  it("greeting first + substantive later → uses substantive queries only", () => {
    const src = collectTitleSource(
      [
        userMsg("你好"),
        assistantMsg("你好！"),
        userMsg("请把 session 列表加上标题"),
        assistantMsg("收到"),
      ],
      "收到"
    );
    expect(src).toBeDefined();
    expect(src?.userQueries).toEqual(["请把 session 列表加上标题"]);
  });

  it("short query with NO assistant text → undefined (过短：等助手文本)", () => {
    expect(collectTitleSource([userMsg("改个bug")], "")).toBeUndefined();
    expect(
      collectTitleSource([userMsg("改个bug"), assistantMsg("修好了")], "修好了")
    ).toBeDefined();
  });

  it("skips tool_result-only user messages and empty-text queries", () => {
    const src = collectTitleSource(
      [toolResultUser(), userMsg("   "), userMsg("实现一个贪吃蛇游戏吧")],
      "完成"
    );
    expect(src?.userQueries).toEqual(["实现一个贪吃蛇游戏吧"]);
  });

  it("no user messages at all → undefined", () => {
    expect(collectTitleSource([], "")).toBeUndefined();
  });
});

// -- createLiteTitleGenerator --------------------------------------------------

describe("createLiteTitleGenerator", () => {
  it("resolves raw model text on a single no-tools completion", async () => {
    const { adapter, calls } = makeAdapter({
      kind: "text",
      text: "登录模块重构",
    });
    const gen = createLiteTitleGenerator({ adapter });
    const out = await gen({
      userQueries: ["帮我重构登录模块"],
      assistantText: "好的",
    });
    expect(out).toBe("登录模块重构");
    // 恰好一次 step 调用；请求对象冻结且不含 tools（无工具补全）
    expect(calls.length).toBe(1);
    expect(calls[0].request.onStream).toBeUndefined();
    expect("tools" in calls[0].request).toBe(false);
    // state 只含 1 条 prompt user 消息
    expect(calls[0].state.messages.length).toBe(1);
    expect(calls[0].state.messages[0].role).toBe("user");
  });

  it("returns undefined (never rejects) when the adapter throws", async () => {
    const { adapter } = makeAdapter({
      kind: "throws",
      error: new Error("boom"),
    });
    const gen = createLiteTitleGenerator({ adapter });
    await expect(
      gen({ userQueries: ["q"], assistantText: "" })
    ).resolves.toBeUndefined();
  });

  it("returns undefined on empty / whitespace-only model response", async () => {
    const { adapter } = makeAdapter({ kind: "text", text: "   \n " });
    const gen = createLiteTitleGenerator({ adapter });
    await expect(
      gen({ userQueries: ["q"], assistantText: "" })
    ).resolves.toBeUndefined();
  });

  it("times out: resolves undefined and aborts the in-flight signal", async () => {
    const { adapter, calls } = makeAdapter({ kind: "never" });
    const gen = createLiteTitleGenerator({ adapter, timeoutMs: 20 });
    const out = await gen({ userQueries: ["q"], assistantText: "" });
    expect(out).toBeUndefined();
    expect(calls.length).toBe(1);
    expect(calls[0].signal?.aborted).toBe(true);
  });
});

// -- liteTitleGeneratorOptions (host 装配缝：键缺席纪律) -------------------------

describe("liteTitleGeneratorOptions", () => {
  const liteEnv = {
    llm: {
      baseUrl: "https://example.invalid",
      model: "fake/main",
      apiKey: "k",
      fallback: [],
      maxOutputTokens: 1024,
      liteModel: {
        model: "fake/lite",
        baseUrl: "https://lite.invalid",
        apiKey: "lite-k",
      },
    },
  };
  const noLiteEnv = { llm: { ...liteEnv.llm, liteModel: undefined } };

  it("两源缺席 → 空对象（titleGenerator 键不出现）", () => {
    expect(liteTitleGeneratorOptions({})).toEqual({});
  });

  it("env 源无 liteModel → 键缺席；overrideEnv 提供 lite → 产出 generator", () => {
    expect(liteTitleGeneratorOptions({ env: noLiteEnv as never })).toEqual({});
    const out = liteTitleGeneratorOptions({ env: liteEnv as never });
    expect(typeof out.titleGenerator).toBe("function");
  });

  it("envProvider 在场优先于 env 快照", () => {
    const out = liteTitleGeneratorOptions({
      envProvider: () => liteEnv as never,
      env: noLiteEnv as never,
    });
    expect(typeof out.titleGenerator).toBe("function");
  });
});
