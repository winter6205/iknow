/**
 * CLI host processChatLine + parseArgs + usage tests (T5 acceptance).
 *
 * Rewrite against the harness `LoopEngineDeps` API (020 cutover). The source
 * has frozen shape:
 *   `parseArgs`            → no `mode`/`modeExplicit` fields
 *   `resolveStartupMode`   → deleted from `src/cli/runtime.ts`
 *   `usageText()`          → no `--mode` line; still mentions `chat` / `ask`
 *   `processChatLine(ctx)` → `ctx = { deps: LoopEngineDeps; state: CliChatState }`
 *
 * Tests deleted because the underlying feature is gone: `--mode` flag,
 * `resolveStartupMode`, `/mode` slash command.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/parse-args.ts";
import {
  processChatLine,
  seedResumeMessages,
  type ChatLineContext,
} from "../src/cli/chat-session.ts";
import { isInteractive } from "../src/cli/session-io.ts";
import { getVersion, usageText } from "../src/cli/usage.ts";
import { applySlashCommand } from "../src/cli/slash.ts";
import type { AnthropicNativeMessage } from "../src/harness/index.ts";
import {
  MEMORY_ADVISORY_PREFIX,
  MEMORY_PREFETCH_END,
} from "../src/harness/memory/index.ts";
import {
  CURRENT_SCHEMA_VERSION,
  SessionStore,
  type SessionFileV1,
} from "../src/session-api/store/index.ts";
import { createStubTool } from "../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../src/harness/tools/registry.ts";
import { createExecutor } from "../src/harness/tools/executor.ts";
import {
  assistantResult,
  makeCtx,
  makeNative,
  makeState,
} from "./cli/_fixtures.ts";

describe("parseArgs", () => {
  it("defaults bare invocation to chat when interactive", () => {
    const p = parseArgs({ argv: [], interactive: true });
    assert.equal(p.command, "chat");
    assert.equal(p.missingQuery, false);
  });

  it("defaults bare invocation to help when non-interactive", () => {
    const p = parseArgs({ argv: [], interactive: false });
    assert.equal(p.command, "help");
  });

  it("flags-only on TTY defaults to chat", () => {
    const p = parseArgs({
      argv: ["--json"],
      interactive: true,
    });
    assert.equal(p.command, "chat");
    assert.equal(p.json, true);
  });

  it("flags-only non-TTY defaults to help", () => {
    const p = parseArgs({ argv: ["--json"], interactive: false });
    assert.equal(p.command, "help");
  });

  it("chat subcommand", () => {
    // 020: --mode flag is gone from parseArgs; passing it now falls through to
    // the rest bucket (it becomes a positional arg). Test only asserts that the
    // subcommand shape is preserved.
    const p = parseArgs({ argv: ["chat"], interactive: false });
    assert.equal(p.command, "chat");
    // The frozen ParsedCli has NO mode/modeExplicit fields anymore.
    assert.equal(
      (p as unknown as { mode?: unknown }).mode,
      undefined,
      "ParsedCli no longer carries a `mode` field"
    );
    assert.equal(
      (p as unknown as { modeExplicit?: unknown }).modeExplicit,
      undefined,
      "ParsedCli no longer carries a `modeExplicit` field"
    );
  });

  it("ask with query", () => {
    const p = parseArgs({ argv: ["ask", "公司的退款政策是什么？"] });
    assert.equal(p.command, "ask");
    assert.equal(p.query, "公司的退款政策是什么？");
    assert.equal(p.missingQuery, false);
  });

  it("ask without query sets missingQuery (no demo default)", () => {
    const p = parseArgs({ argv: ["ask"] });
    assert.equal(p.command, "ask");
    assert.equal(p.query, "");
    assert.equal(p.missingQuery, true);
  });

  it("oneshot bare query (compat)", () => {
    const p = parseArgs({ argv: ["hello world"] });
    assert.equal(p.command, "oneshot");
    assert.equal(p.query, "hello world");
    assert.equal(p.missingQuery, false);
  });

  it("-h / --help → help", () => {
    assert.equal(parseArgs({ argv: ["-h"] }).command, "help");
    assert.equal(parseArgs({ argv: ["--help", "ask", "x"] }).command, "help");
  });

  it("-V / --version sets versionOnly", () => {
    const v = parseArgs({ argv: ["--version"] });
    assert.equal(v.command, "help");
    assert.equal(v.versionOnly, true);
    assert.equal(parseArgs({ argv: ["-V"] }).versionOnly, true);
  });
});

describe("usage / version", () => {
  it("getVersion returns semver-like string", () => {
    assert.match(getVersion(), /^\d+\.\d+\.\d+/);
  });

  it("usageText mentions chat and ask (bilingual) and does NOT mention --mode / --role", () => {
    const t = usageText();
    assert.match(t, /chat/);
    assert.match(t, /ask/);
    assert.match(t, /iknow/);
    assert.match(t, /交互对话|interactive chat/i);
    assert.match(t, /单次 JSON|one-shot JSON/i);
    // 020 cutover: --mode flag and /mode command are gone.
    assert.ok(
      !t.includes("--mode"),
      "usageText must not advertise the removed --mode flag"
    );
    assert.ok(
      !t.includes("/mode"),
      "usageText must not advertise the removed /mode slash command"
    );
    // caller_role machinery retired: --role flag and --governance-timeout are gone.
    assert.ok(
      !t.includes("--role"),
      "usageText must not advertise the removed --role flag"
    );
    assert.ok(
      !t.includes("/role"),
      "usageText must not advertise the removed /role slash command"
    );
    assert.ok(
      !t.includes("--governance-timeout"),
      "usageText must not advertise the removed --governance-timeout flag"
    );
  });
});

describe("isInteractive", () => {
  it("is false when streams are not TTYs", () => {
    const stdin = { isTTY: false } as NodeJS.ReadStream;
    const stdout = { isTTY: false } as NodeJS.WriteStream;
    assert.equal(isInteractive({ stdin, stdout }), false);
  });

  it("is true only when both are TTYs", () => {
    const stdin = { isTTY: true } as NodeJS.ReadStream;
    const stdout = { isTTY: true } as NodeJS.WriteStream;
    assert.equal(isInteractive({ stdin, stdout }), true);
    assert.equal(
      isInteractive({ stdin, stdout: { isTTY: false } as NodeJS.WriteStream }),
      false
    );
  });
});

describe("slash /status", () => {
  it("renders messages.length + jsonMode; no role=/mode=/priors= lines", () => {
    // 020: applySlashCommand now lives in src/cli/slash.ts with CliChatState.
    // Status text uses `messages=N`, NOT `turns=N` and NOT `priors=N`.
    const state = makeState({
      messages: [
        makeNative({ role: "user", text: "q" }),
        makeNative({ role: "assistant", text: "a" }),
      ],
      jsonMode: true,
    });
    const effect = applySlashCommand({
      command: "status",
      args: [],
      ctx: { state },
    });
    assert.equal(effect.type, "info");
    if (effect.type !== "info") return;
    assert.match(effect.text, /messages=2/);
    assert.match(effect.text, /json=on/);
    assert.ok(!effect.text.includes("role="), "no role= line in status");
    assert.ok(!effect.text.includes("mode="), "no mode= line in status");
    assert.ok(!effect.text.includes("priors="), "no priors= line in status");
  });
});

describe("processChatLine (pipe simulation)", () => {
  it("empty line is no-op", async () => {
    const ctx = makeCtx({ responses: [] });
    const r = await processChatLine({ line: "   ", ctx });
    assert.equal(r.quit, false);
    assert.equal(r.output, "");
    assert.equal(r.ranQuery, undefined);
  });

  it("slash /help and /quit", async () => {
    const ctx = makeCtx({ responses: [] });
    const help = await processChatLine({ line: "/help", ctx });
    assert.equal(help.quit, false);
    assert.match(help.output, /\/status/);

    const quit = await processChatLine({ line: "/quit", ctx });
    assert.equal(quit.quit, true);
  });

  it("slash /status via processChatLine — host wires messages=N + json", async () => {
    const state = makeState({
      messages: [
        makeNative({ role: "user", text: "q" }),
        makeNative({ role: "assistant", text: "a" }),
      ],
    });
    const ctx: ChatLineContext = {
      deps: makeCtx({ responses: [] }).deps,
      state,
    };
    const r = await processChatLine({ line: "/status", ctx });
    assert.equal(r.quit, false);
    // 020 frozen shape: messages=N, json=off (default).
    assert.match(r.output, /messages=2/);
    assert.match(r.output, /json=off/);
    // NO legacy role=/mode=/priors= lines (CLI no longer carries those concepts).
    assert.ok(!r.output.includes("role="));
    assert.ok(!r.output.includes("mode="));
    assert.ok(!r.output.includes("priors="));
  });

  it("serial two-query pipe: second sees priors; order preserved", async () => {
    // Same ctx reused across two queries proves the host 续传 priorMessages.
    // Each query independently produces [user, assistant]; messages strictly grows.
    const ctx = makeCtx({
      responses: [
        assistantResult({ texts: ["a1"] }),
        assistantResult({ texts: ["a2"] }),
      ],
    });

    const r1 = await processChatLine({ line: "first question", ctx });
    assert.equal(r1.quit, false);
    assert.equal(r1.ranQuery, true);
    assert.ok(r1.output.length > 0);
    // Human format always renders the status line so scripts can read stopReason.
    assert.match(r1.output, /stop=completed/);
    // Turn 1 produced [user, assistant] = 2 messages.
    assert.equal(ctx.state.messages.length, 2);
    assert.equal(ctx.state.messages[0]!.role, "user");
    assert.equal(ctx.state.messages[1]!.role, "assistant");

    const beforeTurn2 = ctx.state.messages.length;
    const r2 = await processChatLine({ line: "second question", ctx });
    assert.equal(r2.ranQuery, true);
    assert.ok(r2.output.length > 0);
    assert.match(r2.output, /stop=completed/);
    // Messages strictly grew — turn 2 seeded priorMessages from ctx.state.messages.
    assert.ok(
      ctx.state.messages.length > beforeTurn2,
      "messages must strictly grow after turn 2"
    );
    // First user message of turn 1 is still present (history is append-only).
    assert.equal(ctx.state.messages[0]!.role, "user");
    assert.equal(
      (ctx.state.messages[0]!.content[0] as { type: "text"; text: string })
        .text,
      "first question"
    );
    // The user turn from turn 1 + assistant turn from turn 1 are preserved at
    // the head of history, then turn 2 appended its own [user, assistant].
    assert.equal(ctx.state.messages.length, beforeTurn2 + 2);
  });

  it("prepends prefetch overlay onto the user message, not into system", async () => {
    const captured: string[] = [];
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
    });
    ctx.overlayMemoryPrefetch = async () => "PREFETCH_ONLY";
    ctx.deps = {
      ...ctx.deps,
      system: async () => {
        captured.push("system");
        return "SYSTEM_ONLY";
      },
    };
    await processChatLine({ line: "user question", ctx });
    const userText = (
      ctx.state.messages[0]!.content[0] as { type: "text"; text: string }
    ).text;
    assert.ok(userText.includes("PREFETCH_ONLY"));
    assert.ok(userText.includes("user question"));
    assert.ok(!userText.includes("SYSTEM_ONLY"));
    assert.deepEqual(captured, ["system"]);
  });

  it("does not re-inject the same memory on a second chat query while the first block stays in history", async () => {
    const ctx = makeCtx({
      responses: [
        assistantResult({ texts: ["a1"] }),
        assistantResult({ texts: ["a2"] }),
      ],
    });
    const overlay =
      `${MEMORY_ADVISORY_PREFIX}\n\n### T\nid: mem-1\n\nbody` +
      `${MEMORY_PREFETCH_END}`;
    const seenExcluded: string[][] = [];
    ctx.overlayMemoryPrefetch = async (_query, prefetchOpts) => {
      seenExcluded.push([...(prefetchOpts?.excludeIds ?? [])]);
      return seenExcluded.length === 1 ? overlay : "";
    };

    await processChatLine({ line: "same question", ctx });
    await processChatLine({ line: "same question", ctx });

    // Turn 1 injected with an empty set; turn 2 saw mem-1 excluded.
    assert.deepEqual(seenExcluded[0], []);
    assert.deepEqual(seenExcluded[1], ["mem-1"]);
    // History keeps turn 1's advisory block; turn 2's user message has none.
    const userTexts = ctx.state.messages
      .filter((m) => m.role === "user")
      .map(
        (m) => (m.content[0] as { type: "text"; text: string }).text ?? ""
      );
    assert.ok(userTexts[0]!.includes(MEMORY_ADVISORY_PREFIX));
    assert.ok(!userTexts[1]!.includes(MEMORY_ADVISORY_PREFIX));
    assert.ok(userTexts[1]!.includes("same question"));
  });

  it("does not re-inject advisory blocks recovered from resumed history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iknow-cli-prefetch-resume-"));
    try {
      const store = new SessionStore(dir);
      const conversationId = "cli-prefetch-resume-1";
      const now = "2026-01-01T00:00:00.000Z";
      const overlay =
        `${MEMORY_ADVISORY_PREFIX}\n\n### T\nid: mem-7\n\nbody` +
        `${MEMORY_PREFETCH_END}`;
      const file: SessionFileV1 = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: conversationId,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: `${overlay}earlier question` },
            ],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "earlier answer" }],
          },
        ],
        jsonMode: false,
        turnCount: 1,
        updatedAt: now,
        title: "",
        cwd: process.cwd(),
        sanitized_at: now,
        checkpoints: [],
      };
      await store.save({ id: conversationId, file });

      // seedResumeMessages is the exact --resume seed path in runChatSession.
      const seeded = await seedResumeMessages({
        store,
        id: conversationId,
      });
      const ctx = makeCtx({
        responses: [assistantResult({ texts: ["a1"] })],
        stateOverrides: { messages: seeded.messages, conversationId },
      });
      const seenExcluded: string[][] = [];
      ctx.overlayMemoryPrefetch = async (_query, prefetchOpts) => {
        seenExcluded.push([...(prefetchOpts?.excludeIds ?? [])]);
        return "";
      };

      await processChatLine({ line: "resumed question", ctx });

      assert.ok(
        seenExcluded[0]!.includes("mem-7"),
        "resumed advisory ids must reach the overlay as excludeIds"
      );
      const lastUser = [
        ...ctx.state.messages,
      ]
        .reverse()
        .find((m) => m.role === "user")!;
      const lastUserText = (
        lastUser.content[0] as { type: "text"; text: string }
      ).text;
      assert.ok(
        !lastUserText.includes(MEMORY_ADVISORY_PREFIX),
        "resumed conversation must not re-inject"
      );
      assert.ok(lastUserText.includes("resumed question"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unknown slash goes to stderr field", async () => {
    const ctx = makeCtx({ responses: [] });
    const r = await processChatLine({ line: "/nope", ctx });
    assert.equal(r.output, "");
    assert.ok(r.stderr);
    assert.match(r.stderr!, /Unknown command/);
  });

  it("/json on switches answer formatting to harness-native JSON", async () => {
    // JSON output is the harness RunResult projection. Top-level keys:
    // finalText / stopReason / turnCount / trace. messages is intentionally omitted.
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["answer"] })],
    });
    await processChatLine({ line: "/json on", ctx });
    assert.equal(ctx.state.jsonMode, true);
    const r = await processChatLine({ line: "any question", ctx });
    assert.ok(r.output.startsWith("{"));
    const parsed = JSON.parse(r.output) as Record<string, unknown>;
    assert.ok("finalText" in parsed, "JSON output must carry `finalText`");
    assert.ok("stopReason" in parsed, "JSON output must carry `stopReason`");
    assert.ok("turnCount" in parsed, "JSON output must carry `turnCount`");
    assert.ok("trace" in parsed, "JSON output must carry `trace`");
    // JSON keys must be the harness envelope only (whitelist).
    const allowed = new Set(["finalText", "stopReason", "turnCount", "trace"]);
    const extra: string[] = [];
    for (const k of Object.keys(parsed)) if (!allowed.has(k)) extra.push(k);
    assert.deepEqual(
      extra,
      [],
      `JSON must have only envelope keys, got extra: ${extra.join(",")}`
    );
  });

  it("/reset clears conversation bag via processChatLine but preserves session", async () => {
    // 020: /reset clears `messages` only; session is preserved.
    const ctx = makeCtx({
      responses: [
        assistantResult({ texts: ["a"] }),
        assistantResult({ texts: ["a"] }),
      ],
    });
    const session = ctx.state.session;
    ctx.state.messages = [
      makeNative({ role: "user", text: "q" }),
      makeNative({ role: "assistant", text: "a" }),
    ];
    assert.equal(ctx.state.messages.length, 2);

    const r = await processChatLine({ line: "/reset", ctx });
    assert.equal(r.quit, false);
    assert.match(r.output, /cleared|Session/i);
    assert.equal(ctx.state.messages.length, 0);
    // Session object survives reset (same reference).
    assert.equal(ctx.state.session, session);
  });

  it("agent throw surfaces on stderr without quitting", async () => {
    // Build deps whose adapter.step rejects synchronously → run() rejects.
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const registry = createRegistry([tool]);
    const executor = createExecutor(registry);
    const adapter = Object.freeze({
      encodeUserText: (t: string): AnthropicNativeMessage => ({
        role: "user",
        content: [{ type: "text", text: t }],
      }),
      encodeToolResults: () => [] as AnthropicNativeMessage["content"],
      step: async () => {
        throw new Error("boom-agent");
      },
    });
    const ctx: ChatLineContext = {
      deps: {
        adapter,
        executor,
        registry,
        maxTurns: 5,
      },
      state: makeState(),
    };
    const r = await processChatLine({ line: "any question", ctx });
    assert.equal(r.quit, false);
    assert.equal(r.output, "");
    assert.equal(r.ranQuery, true);
    assert.ok(r.stderr);
    assert.match(r.stderr!, /boom-agent/);
  });
});

/**
 * #152 T5 + #T6 (D5) 接线：chat-session `processChatLine` 尊重 `showThinking`。
 *
 * 默认（缺省/`false`）：输出面（`r.output`）不含 thinking 文本。
 * `ctx.showThinking === true`：输出面显示折叠摘要行 + 答案正文
 * （T6 行为变更 — 之前为展开全文；TTY 无折叠交互，摘要行即折叠态，
 * 与 TUI 默认折叠一致）。本测试不直接测渲染函数本身（那在
 * tests/cli/format.test.ts），只测接线。
 */
describe("chat-session thinking 可见开关接线 (#152 T5 + #T6 折叠摘要)", () => {
  it("showThinking 缺省（false）：output 不含 thinking 文本", async () => {
    const ctx = makeCtx({
      responses: [
        assistantResult({
          texts: ["answer"],
          thinkingBlocks: [
            {
              type: "thinking",
              thinking: "HIDDEN_THINKING_MUST_NOT_SHOW",
              signature: "sig_w1",
            },
          ],
        }),
      ],
    });
    const r = await processChatLine({ line: "any question", ctx });
    assert.equal(r.ranQuery, true);
    assert.ok(r.output.includes("answer"));
    assert.ok(
      !r.output.includes("HIDDEN_THINKING_MUST_NOT_SHOW"),
      "default off: thinking must not leak into output"
    );
  });

  it("ctx.showThinking === true：output 含折叠摘要 + 仍含 text（全文不展开）", async () => {
    // T6 (D5): chat 端 showThinking=true 改为折叠摘要行（不再展开 thinking
    // 全文），与 TUI 默认折叠一致。
    const ctx = makeCtx({
      responses: [
        assistantResult({
          texts: ["answer"],
          thinkingBlocks: [
            {
              type: "thinking",
              thinking: "VISIBLE_THINKING_SHOULD_SHOW",
              signature: "sig_w2",
            },
          ],
        }),
      ],
    });
    ctx.showThinking = true;
    const r = await processChatLine({ line: "any question", ctx });
    assert.equal(r.ranQuery, true);
    assert.ok(r.output.includes("answer"), "正文仍出现");
    assert.ok(r.output.includes("思考（1 段）"), "折叠摘要行出现（T6 行为）");
    assert.ok(
      !r.output.includes("VISIBLE_THINKING_SHOULD_SHOW"),
      "折叠态：thinking 全文不展开（防止直接暴露模型内部文本）"
    );
  });

  it("JSON 模式：showThinking 不影响 JSON 输出（machine 通道）", async () => {
    const ctx = makeCtx({
      responses: [
        assistantResult({
          texts: ["answer"],
          thinkingBlocks: [
            {
              type: "thinking",
              thinking: "JSON_CHANNEL_MUST_NOT_LEAK",
              signature: "sig_w3",
            },
          ],
        }),
      ],
      stateOverrides: { jsonMode: true },
    });
    ctx.showThinking = true;
    await processChatLine({ line: "/json on", ctx });
    const r = await processChatLine({ line: "any question", ctx });
    assert.equal(r.ranQuery, true);
    // JSON channel never includes thinking regardless of the switch.
    assert.ok(!r.output.includes("JSON_CHANNEL_MUST_NOT_LEAK"));
    const parsed = JSON.parse(r.output) as Record<string, unknown>;
    assert.ok("finalText" in parsed);
  });

  it("thinking 进 ctx.state.messages（权威历史）但不出现在默认 output（两面分离）", async () => {
    // 可见面 = 展示通道（output）；保留面 = 权威历史（state.messages）。
    // 默认开关关闭时：历史仍含 thinking（可被后续 replay），但 output 无 thinking。
    const ctx = makeCtx({
      responses: [
        assistantResult({
          texts: ["answer"],
          thinkingBlocks: [
            {
              type: "thinking",
              thinking: "KEEP_IN_HISTORY_BUT_HIDE_FROM_OUTPUT",
              signature: "sig_w4",
            },
          ],
        }),
      ],
    });
    const r = await processChatLine({ line: "any question", ctx });
    // output 面：不含 thinking。
    assert.ok(!r.output.includes("KEEP_IN_HISTORY_BUT_HIDE_FROM_OUTPUT"));
    // 权威历史：含 thinking 全字段（保留面不被可见开关影响）。
    const assistantMsg = ctx.state.messages[1]!;
    assert.equal(assistantMsg.role, "assistant");
    const thinkingBlock = assistantMsg.content[0] as {
      type: "thinking";
      thinking: string;
      signature: string;
    };
    assert.equal(thinkingBlock.type, "thinking");
    assert.equal(
      thinkingBlock.thinking,
      "KEEP_IN_HISTORY_BUT_HIDE_FROM_OUTPUT"
    );
    assert.equal(thinkingBlock.signature, "sig_w4");
  });
});
