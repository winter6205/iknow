/**
 * #179 T6 (#147 D0/D3) — chat 增量渲染接缝。
 *
 * Three guarantees, driven through the real harness stub path (no TTY needed):
 *   1. `processChatLine` forwards its optional `onStream` to `run()`, so a
 *      streaming adapter (stub-model `streamEventsByStep` seam) delivers the
 *      complete event sequence to the chat host.
 *   2. `createStreamPreviewSink` renders text_delta increments + tool_call_start
 *      hints through an injected writer (the TTY spinner-replacement seam).
 *   3. When `onStream` is absent (the `runPiped` path always, and
 *      `runInteractive` when `process.stderr.isTTY` is false), the rendered
 *      output is unchanged — this is the structural pipe/non-TTY regression
 *      guard.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  processChatLine,
  createStreamPreviewSink,
  type StreamPreviewSink,
} from "../../src/cli/chat-session.ts";
import type { HarnessStreamEvent } from "../../src/harness/index.ts";
import {
  BASH_RUNNING_PREFIX,
  formatThinkingLive,
  formatToolStatusLine,
} from "../../src/shared/tool-line.ts";
import {
  formatToolStatusLine as tuiFormatToolStatusLine,
  registeredToolDisplayNames,
} from "../../src/tui/tool-summary.ts";
import { formatThinkingLive as tuiFormatThinkingLive } from "../../src/tui/think-fold.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";

describe("processChatLine onStream forwarding (#179 T6)", () => {
  it("forwards onStream to run(): stub stream events reach the chat host", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["hello world"] })],
      streamEventsByStep: [
        [
          { type: "text_delta", text: "hello " },
          { type: "text_delta", text: "world" },
        ],
      ],
    });
    const received: HarnessStreamEvent[] = [];
    const r = await processChatLine({
      line: "say hello",
      ctx,
      onStream: (event) => received.push(event),
    });
    assert.equal(r.ranQuery, true);
    assert.equal(r.output.includes("hello world"), true);
    assert.deepEqual(received, [
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
    ]);
  });

  it("without onStream: identical behavior (no events observed, output unchanged)", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["same"] })],
      streamEventsByStep: [[{ type: "text_delta", text: "same" }]],
    });
    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.ranQuery, true);
    assert.equal(r.output.includes("same"), true);
  });

  it("pipe / non-TTY regression: processChatLine without onStream leaves output unchanged", async () => {
    // Mirrors the structural guarantee:
    //   - runPiped always calls processChatLine({line, ctx}) (chat-session.ts:512).
    //   - runInteractive calls processChatLine({line, ctx, onStream}) only when
    //     process.stderr.isTTY is true (chat-session.ts:354-372). When stderr
    //     is not a TTY, the ternary collapses to onStream = undefined, matching
    //     this test exactly. So this test is the regression gate for both
    //     pipe / non-TTY paths: no onStream → output unchanged.
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["final"] })],
      streamEventsByStep: [
        [
          { type: "text_delta", text: "should-not-observe-1" },
          { type: "text_delta", text: "should-not-observe-2" },
          {
            type: "tool_call_start",
            name: "should-not-observe",
            id: "toolu_obs_1",
          },
        ],
      ],
    });
    const r = await processChatLine({ line: "q", ctx });
    assert.equal(r.ranQuery, true);
    assert.ok(r.output.includes("final"));
    assert.ok(!r.output.includes("should-not-observe-1"));
  });
});

/** Capture bytes written to a fake stdout / stderr writer pair. */
function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    writers: {
      writeOut: (s: string) => out.push(s),
      writeErr: (s: string) => err.push(s),
    },
  };
}

describe("createStreamPreviewSink (#179 T6 TTY spinner replacement)", () => {
  it("writes each text_delta increment through the stdout writer", () => {
    const { out, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({ type: "text_delta", text: "he" });
    sink.feed({ type: "text_delta", text: "llo" });
    assert.deepEqual(out, ["he", "llo"]);
    assert.equal(sink.textStreamed, true);
  });

  it("emits the shared tool line to stderr once the call closes", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({
      type: "tool_call_start",
      name: "bash",
      id: "toolu_bash_remaining",
    });
    // input 增量未到之前不落行：CLI 的 start 事件不携带 input，只有
    // tool_input_delta 齐了才画得出 detail（D1 合同）。
    assert.ok(err.every((chunk) => !chunk.includes("bash")));
    sink.feed({
      type: "tool_input_delta",
      id: "toolu_bash_remaining",
      partialJson: '{"command":"npm test"}',
    });
    sink.feed({ type: "text_delta", text: "done" });
    const joined = err.join("");
    assert.ok(joined.includes("Running 1 shell command… · npm test"));
    // tool_call_start is a status hint, not answer text.
    assert.equal(sink.textStreamed, true);
  });

  it("writer errors are swallowed (observer must not break the turn)", () => {
    const sink = createStreamPreviewSink({
      writeOut: () => {
        throw new Error("stdout write failed");
      },
      writeErr: () => {
        throw new Error("stderr write failed");
      },
    });
    // Must not throw.
    sink.feed({ type: "text_delta", text: "x" });
    sink.feed({ type: "tool_call_start", name: "t", id: "toolu_t_1" });
  });

  it("#195 regression: multi-line streamed text is not double-printed", () => {
    const { out, err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    // A multi-line answer delivered as several text_delta chunks.
    const chunks = ["line1\n", "line2\n", "line3"];
    for (const c of chunks) sink.feed({ type: "text_delta", text: c });
    // The FULL multi-line answer must appear on stdout exactly once.
    const joined = out.join("");
    assert.equal(out.length, chunks.length);
    assert.ok(joined.includes("line1\nline2\nline3"));
    // Count occurrences of a printable substring — must be exactly 1.
    const occurrences = joined.split("line2").length - 1;
    assert.equal(occurrences, 1, "answer text must not be duplicated");
    // Answer text must never land on stderr (only the spinner-clear sequence may).
    assert.ok(
      err.every((chunk) => !chunk.includes("line")),
      "answer text must never land on stderr"
    );
    assert.equal(sink.textStreamed, true);
  });

  it("#195 regression: textStreamed flips once and tool_call_start does not reset it", () => {
    const { writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    assert.equal(sink.textStreamed, false);
    sink.feed({ type: "text_delta", text: "a" });
    assert.equal(sink.textStreamed, true);
    sink.feed({
      type: "tool_call_start",
      name: "bash",
      id: "toolu_bash_remaining",
    });
    assert.equal(
      sink.textStreamed,
      true,
      "tool hint must not clear textStreamed"
    );
    sink.feed({ type: "text_delta", text: "b" });
    assert.equal(sink.textStreamed, true);
  });

  it("SC20: stdout never carries a complete secret (masked to ***)", () => {
    const original = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-abc123";
    try {
      const { out, writers } = captureStreams();
      const sink = createStreamPreviewSink(writers);
      sink.feed({ type: "text_delta", text: "your key is " });
      sink.feed({ type: "text_delta", text: "sk-abc123 here" });
      const stdout = out.join("");
      assert.ok(
        !stdout.includes("sk-abc123"),
        "complete secret must not be written"
      );
      // The full masked text is streamed incrementally: "sk-abc123" -> "***".
      assert.ok(stdout.includes("***"), "masked secret must appear as ***");
      assert.equal(sink.textStreamed, true);
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = original;
    }
  });

  it("documented SC20 boundary: truncated secret split across deltas leaks the first fragment", () => {
    // streamDraft.masked() is a full re-mask (T2 design) with no trailing
    // surplus, so a secret split across deltas ("sk-" then "abc123") is written
    // as the bare fragment "sk-" on the first delta, before the full masking
    // catches it. This pins the KNOWN behavior (not a bug fix): the complete
    // secret "sk-abc123" is never emitted, and once both deltas arrive the
    // accumulated secret is masked.
    const original = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-abc123";
    try {
      const { out, writers } = captureStreams();
      const sink = createStreamPreviewSink(writers);
      sink.feed({ type: "text_delta", text: "key " });
      sink.feed({ type: "text_delta", text: "sk-" });
      assert.ok(
        out.join("").includes("sk-"),
        "first fragment is a known bare write"
      );
      assert.ok(
        !out.join("").includes("sk-abc123"),
        "complete secret never emitted"
      );
      sink.feed({ type: "text_delta", text: "abc123" });
      const stdout = out.join("");
      assert.ok(!stdout.includes("sk-abc123"), "complete secret never emitted");
      assert.ok(
        stdout.includes("sk-"),
        "truncated fragment leak is documented"
      );
      // Once the full secret accumulates, the masked output shrinks (9 chars
      // -> "***" = 3 chars), so lastWrittenLen already covers the masked
      // position and no further slice is emitted. The "***" marker therefore
      // never reaches stdout for this cross-delta split (D4 documented edge).
      assert.equal(sink.textStreamed, true);
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = original;
    }
  });

  it("empty delta writes nothing extra but textStreamed still flips", () => {
    const { out, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({ type: "text_delta", text: "x" });
    sink.feed({ type: "text_delta", text: "" });
    assert.deepEqual(out, ["x"], "empty delta must not produce a second write");
    assert.equal(sink.textStreamed, true);
  });
});

/** stderr 行中「工具行」的判定：CLI 只往 stderr 写工具过程行与 spinner 清除
 *  序列，其余（答案文本）走 stdout。过滤掉纯清行序列后按顺序取工具行。 */
function toolLinesOf(err: ReadonlyArray<string>): ReadonlyArray<string> {
  return err.filter((chunk) => chunk.includes("\n")).map((c) => c.trim());
}

/** 驱动一次工具调用：start → input 增量 → 关闭（下一个非增量事件）。 */
function feedToolCall(
  sink: StreamPreviewSink,
  opts: {
    readonly id: string;
    readonly name: string;
    readonly partialJson?: string;
    readonly closeWith: HarnessStreamEvent;
  }
): void {
  sink.feed({ type: "tool_call_start", name: opts.name, id: opts.id });
  if (opts.partialJson !== undefined) {
    sink.feed({
      type: "tool_input_delta",
      id: opts.id,
      partialJson: opts.partialJson,
    });
  }
  sink.feed(opts.closeWith);
}

/** 与 shared 模块同源的期望行（不手抄模板字符串）。 */
function expectedLine(
  name: string,
  input: unknown,
  status: "running" | "ok" | "failed" = "running"
): string {
  return formatToolStatusLine({ toolName: name, input, status });
}

describe("createStreamPreviewSink: CLI 与 TUI 共用 live tool line（D1）", () => {
  it("(a) 工具行由共享函数产出：与 shared formatToolStatusLine 同字节", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    feedToolCall(sink, {
      id: "tu-shared-1",
      name: "bash",
      partialJson: '{"command":"npm test"}',
      closeWith: { type: "text_delta", text: "ok" },
    });
    const lines = toolLinesOf(err);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], expectedLine("bash", { command: "npm test" }));
    // 生产面同源闸：tui 侧 re-export 与 shared 逐字节一致（同一函数对象）。
    assert.equal(tuiFormatToolStatusLine, formatToolStatusLine);
    assert.equal(tuiFormatThinkingLive, formatThinkingLive);
  });

  it("(b) 行是英文：不含 调用工具 / [运行中] / [完成]", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    feedToolCall(sink, {
      id: "tu-en-1",
      name: "read_file",
      partialJson: '{"path":"src/app.ts"}',
      closeWith: { type: "text_delta", text: "x" },
    });
    const line = toolLinesOf(err)[0] ?? "";
    assert.equal(line, "read_file · Read src/app.ts");
    assert.ok(!line.includes("调用工具"));
    assert.ok(!line.includes("[运行中]"));
    assert.ok(!line.includes("[完成]"));
  });

  it("(c) detail 齐了才落行：bash 命令 / 路径 / 查询 / URL 均可见", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly partialJson: string;
      readonly expect: string;
    }> = [
      {
        name: "bash",
        partialJson: '{"command":"ls -la"}',
        expect: `Running 1 shell command… · ls -la`,
      },
      {
        name: "read_file",
        partialJson: '{"path":"a/b.ts"}',
        expect: "read_file · Read a/b.ts",
      },
      {
        name: "grep",
        partialJson: '{"pattern":"TODO"}',
        expect: "grep · Search TODO",
      },
      {
        name: "web_search",
        partialJson: '{"query":"bun test"}',
        expect: "web_search · Search bun test",
      },
      {
        name: "web_fetch",
        partialJson: '{"url":"https://x.dev"}',
        expect: "web_fetch · Fetch https://x.dev",
      },
    ];
    for (const c of cases) {
      const { err, writers } = captureStreams();
      const sink = createStreamPreviewSink(writers);
      feedToolCall(sink, {
        id: `tu-${c.name}`,
        name: c.name,
        partialJson: c.partialJson,
        closeWith: { type: "text_delta", text: "x" },
      });
      const lines = toolLinesOf(err);
      assert.equal(lines.length, 1, `${c.name}: exactly one line`);
      assert.equal(lines[0], c.expect, `${c.name}: detail visible`);
      assert.ok(
        lines[0] === expectedLine(c.name, JSON.parse(c.partialJson)),
        `${c.name}: same source as shared summarizer`
      );
    }
    // bash 前缀本身来自 shared 常量（不是 CLI 侧新字面量）。
    assert.ok(BASH_RUNNING_PREFIX.startsWith("Running 1 shell command"));
  });

  it("(c2) 增量 JSON 不完整 / 缺席 → 仍落一行（name-only），不 throw", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    feedToolCall(sink, {
      id: "tu-partial",
      name: "read_file",
      partialJson: '{"path":"src/partial',
      closeWith: { type: "text_delta", text: "x" },
    });
    feedToolCall(sink, {
      id: "tu-noinput",
      name: "mystery_tool",
      closeWith: { type: "text_delta", text: "y" },
    });
    const lines = toolLinesOf(err);
    assert.equal(lines.length, 2);
    // 不完整 JSON：走 summarizePartialInput 的原样截断（同一共享函数），
    // 行仍成立、detail 部分可见。
    assert.ok(lines[0]!.startsWith("read_file · "));
    assert.ok(lines[0]!.includes("src/partial"));
    assert.equal(lines[1], "mystery_tool");
  });

  it("(d) 每个工具调用恰一行：连续调用不重复、不追加", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    feedToolCall(sink, {
      id: "tu-a",
      name: "read_file",
      partialJson: '{"path":"a.ts"}',
      closeWith: { type: "tool_call_start", name: "bash", id: "tu-b" },
    });
    sink.feed({
      type: "tool_input_delta",
      id: "tu-b",
      partialJson: '{"command":"pwd"}',
    });
    sink.feed({ type: "text_delta", text: "end" });
    const lines = toolLinesOf(err);
    assert.equal(lines.length, 2, "one line per tool call");
    assert.equal(lines[0], "read_file · Read a.ts");
    assert.equal(lines[1], "Running 1 shell command… · pwd");
    // 同 id 的多个增量不产生多行（累积到关闭时才 flush）。
    const joined = err.join("");
    assert.equal(joined.split("Running 1 shell command… · pwd").length - 1, 1);
  });

  it("(d2) 同 id 多个 input 增量累积成一行（不逐段刷行）", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({ type: "tool_call_start", name: "bash", id: "tu-frag" });
    for (const frag of ['{"comma', 'nd":"git ', 'status"}']) {
      sink.feed({ type: "tool_input_delta", id: "tu-frag", partialJson: frag });
    }
    // 增量期间不落行。
    assert.ok(err.every((chunk) => !chunk.includes("bash")));
    sink.feed({ type: "stop_summary", text: "done" });
    const lines = toolLinesOf(err);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "Running 1 shell command… · git status");
  });

  it("(e) 回合结束 flush：最后一个工具调用不留悬浮（turn 尾部事件）", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({ type: "tool_call_start", name: "bash", id: "tu-last" });
    sink.feed({
      type: "tool_input_delta",
      id: "tu-last",
      partialJson: '{"command":"tail"}',
    });
    sink.feed({ type: "stop_summary", text: "" });
    const lines = toolLinesOf(err);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "Running 1 shell command… · tail");
  });

  it("(f) 非增量事件到达即 flush：thinking_delta / agent_status 同样是关闭点", () => {
    for (const closing of [
      { type: "thinking_delta", text: "hmm" },
      { type: "agent_status", lastTool: "bash", openTodoLines: [] },
      { type: "stop_summary", text: "" },
    ] as ReadonlyArray<HarnessStreamEvent>) {
      const { err, writers } = captureStreams();
      const sink = createStreamPreviewSink(writers);
      sink.feed({ type: "tool_call_start", name: "grep", id: "tu-c" });
      sink.feed({
        type: "tool_input_delta",
        id: "tu-c",
        partialJson: '{"pattern":"x"}',
      });
      sink.feed(closing);
      const lines = toolLinesOf(err);
      assert.equal(lines.length, 1, `closing=${closing.type}`);
      assert.equal(lines[0], "grep · Search x", `closing=${closing.type}`);
    }
  });

  it("(g) 其他 id 的 input 增量不属于当前工具 → 不提前 flush", () => {
    const { err, writers } = captureStreams();
    const sink = createStreamPreviewSink(writers);
    sink.feed({ type: "tool_call_start", name: "bash", id: "tu-own" });
    sink.feed({
      type: "tool_input_delta",
      id: "tu-other",
      partialJson: '{"command":"nope"}',
    });
    // 未关闭：不落行（其他 id 的增量不构成关闭点）。
    assert.ok(err.every((chunk) => !chunk.includes("bash")));
    sink.feed({
      type: "tool_input_delta",
      id: "tu-own",
      partialJson: '{"command":"yes"}',
    });
    sink.feed({ type: "text_delta", text: "z" });
    const lines = toolLinesOf(err);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], "Running 1 shell command… · yes");
  });

  it("(h) 生产面闸：CLI 不再有 调用工具 中文裸名 dump；CLI 不 import src/tui", () => {
    const src = readFileSync(
      new URL("../../src/cli/chat-session.ts", import.meta.url),
      "utf8"
    );
    // 只看代码：注释里提旧文案（如「清掉 Thinking… spinner」沿革说明）不算
    // 生产面（同 tests/tui/tool-summary.test.ts 的 readFileSync 闸纪律）。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!code.includes("调用工具"), "raw tool-name dump retired");
    assert.ok(!code.includes("思考中"), "Chinese spinner retired (D1)");
    assert.ok(
      !/from "\.\.\/tui\//.test(code),
      "CLI must not import src/tui (layering inversion)"
    );
  });

  it("(i) spinner 文案来自共享函数：Thinking…（TUI 同源）", () => {
    const src = readFileSync(
      new URL("../../src/cli/chat-session.ts", import.meta.url),
      "utf8"
    );
    assert.ok(src.includes("formatThinkingLive"));
    assert.equal(formatThinkingLive(), "Thinking…");
    assert.equal(formatThinkingLive(), tuiFormatThinkingLive());
    assert.ok(!src.includes('"思考中…"'));
  });

  it("(j) 注册表里的工作树五件人读表述为英文（D1 / create-task-worktree D5）", () => {
    const names = new Set(registeredToolDisplayNames());
    for (const n of [
      "create-task-worktree",
      "enter-task-worktree",
      "exit-task-worktree",
      "remove-task-worktree",
      "list-task-worktrees",
    ]) {
      assert.ok(names.has(n));
      const line = formatToolStatusLine({
        toolName: n,
        input: {},
        status: "ok",
      });
      assert.ok(!/[一-鿿]/.test(line), `${n} line is English: ${line}`);
    }
    assert.equal(
      formatToolStatusLine({
        toolName: "create-task-worktree",
        input: {},
        status: "ok",
      }),
      "create-task-worktree · Created worktree"
    );
    assert.equal(
      formatToolStatusLine({
        toolName: "enter-task-worktree",
        input: { conversationId: "abc" },
        status: "ok",
      }),
      "enter-task-worktree · Entered worktree abc"
    );
  });
});
