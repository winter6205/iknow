/**
 * T3 (#689): CLI `/continue` slash + pending-only NL.
 *
 * Boundary classes (spec continue_pending Testing):
 *   empty     — empty session /continue → nothing_pending, run not called
 *   negative  — table NL skip-append; single-token + prose append; not-pending
 *               NL is query; slash args → usage; ask/oneshot have no continue
 *   overflow  — overlong non-exact NL still MAX_MESSAGE_CHARS on query arm
 *   concurrent — client busy → busy_stop_first, in-flight turn not aborted
 *   exception — stale host vs disk (load wins); load throw → EXIT no run;
 *               continue_http_no_fallback (predicate fail never becomes query)
 */
import { afterAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processChatLine } from "../../src/cli/chat-session.ts";
import { HELP_TEXT, parseChatLine } from "../../src/cli/slash.ts";
import { parseArgs } from "../../src/cli/parse-args.ts";
import { MAX_MESSAGE_CHARS } from "../../src/session-api/contract.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  SessionStore,
  type SessionFileV1,
  type SessionStoreError,
} from "../../src/session-api/store/index.ts";
import type {
  AnthropicNativeMessage,
  LoopEngineDeps,
  LoopState,
} from "../../src/harness/index.ts";
import { assistantResult, makeCtx } from "./_fixtures.ts";
import type { ChatLineContext } from "../../src/cli/chat-session.ts";

const tempDirs: string[] = [];

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantText(text: string): AnthropicNativeMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantToolUse(id: string): AnthropicNativeMessage {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "noop", input: {} }],
  };
}

function toolResultOnly(id: string): AnthropicNativeMessage {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  };
}

/** P4 pending tail (tool_result-only last user). */
function pendingMessages(): AnthropicNativeMessage[] {
  return [userText("do"), assistantToolUse("t1"), toolResultOnly("t1")];
}

function sampleFile(opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: opts.id,
    title: "",
    cwd: process.cwd(),
    sanitized_at: now,
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: now,
    checkpoints: [],
    ...opts.overrides,
  };
}

async function storeFor(): Promise<{
  store: SessionStore;
  sessionDir: string;
}> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-cli-continue-"));
  tempDirs.push(tmp);
  return {
    store: new SessionStore(tmp, process.cwd()),
    sessionDir: resolveProjectSessionDir(tmp, process.cwd()),
  };
}

function spyAdapter(ctx: ChatLineContext): {
  encodeCount: { n: number };
  stepCalls: { n: number };
  stepMessages: AnthropicNativeMessage[][];
} {
  const inner = ctx.deps.adapter;
  const encodeCount = { n: 0 };
  const stepCalls = { n: 0 };
  const stepMessages: AnthropicNativeMessage[][] = [];
  const deps: LoopEngineDeps = {
    ...ctx.deps,
    adapter: {
      ...inner,
      encodeUserText: (t: string) => {
        encodeCount.n += 1;
        return inner.encodeUserText(t);
      },
      step: async (state: LoopState, request, signal) => {
        stepCalls.n += 1;
        stepMessages.push([...state.messages]);
        return inner.step(state, request, signal);
      },
    },
  };
  ctx.deps = deps;
  return { encodeCount, stepCalls, stepMessages };
}

function lastUserText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined || m.role !== "user") continue;
    const block = m.content.find((b) => b.type === "text");
    if (block !== undefined && block.type === "text") return block.text;
  }
  return undefined;
}

function lastBlockType(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string | undefined {
  const last = messages[messages.length - 1];
  return last?.content[0]?.type;
}

describe("T3 slash /continue parse + help", () => {
  it("/help output includes /continue", async () => {
    const ctx = makeCtx({ responses: [] });
    const r = await processChatLine({ line: "/help", ctx });
    assert.match(r.output, /\/continue/);
    assert.match(HELP_TEXT, /\/continue/);
  });

  it("command is case-insensitive (/CONTINUE)", () => {
    assert.deepEqual(parseChatLine("/CONTINUE"), {
      kind: "slash",
      command: "continue",
      args: [],
    });
  });
});

describe("T3 empty: empty session /continue → nothing_pending, run not called", () => {
  it("no-store empty messages → nothing_pending; encode and step stay 0", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["should-not-run"] })],
    });
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "/continue", ctx });
    assert.match(r.stderr ?? "", /nothing_pending/);
    assert.equal(r.ranQuery, undefined);
    assert.equal(spy.encodeCount.n, 0);
    assert.equal(spy.stepCalls.n, 0);
    assert.equal(ctx.state.messages.length, 0);
  });

  it("store.load not_found → nothing_pending (not not_found); run not called", async () => {
    const id = "fresh-never-saved";
    const store = {
      load: async () => {
        const err: SessionStoreError = {
          kind: "not_found",
          conversation_id: id,
        };
        throw err;
      },
    } as SessionStore;
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["should-not-run"] })],
      checkpointStore: store,
      stateOverrides: { conversationId: id, messages: [] },
    });
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "/continue", ctx });
    assert.match(r.stderr ?? "", /nothing_pending/);
    assert.doesNotMatch(r.stderr ?? "", /not_found/);
    assert.equal(r.ranQuery, undefined);
    assert.equal(spy.encodeCount.n, 0);
    assert.equal(spy.stepCalls.n, 0);
  });
});

describe("T3 negative: NL table, single-token, no-fallback, ask_out", () => {
  it("pending table NL (please continue / 请继续) skip-append; no task user appended", async () => {
    for (const line of ["please continue", "请继续", "keep going"]) {
      const ctx = makeCtx({
        responses: [assistantResult({ texts: ["continued"] })],
        stateOverrides: { messages: pendingMessages() },
      });
      const spy = spyAdapter(ctx);
      const r = await processChatLine({ line, ctx });
      assert.equal(r.ranQuery, true);
      assert.match(r.output, /continued/);
      assert.equal(spy.encodeCount.n, 0);
      assert.notEqual(lastUserText(ctx.state.messages), line);
      assert.equal(lastBlockType(spy.stepMessages[0] ?? []), "tool_result");
    }
  });

  it("nl_not_single_token: continue / 继续 / continue the migration append even when pending", async () => {
    for (const line of ["continue", "继续", "continue the migration"]) {
      const ctx = makeCtx({
        responses: [assistantResult({ texts: ["appended"] })],
        stateOverrides: { messages: pendingMessages() },
      });
      const spy = spyAdapter(ctx);
      const r = await processChatLine({ line, ctx });
      assert.equal(r.ranQuery, true);
      assert.equal(spy.encodeCount.n, 1);
      assert.equal(lastUserText(ctx.state.messages), line);
    }
  });

  it("nl_pending_only: please continue when not pending is a normal query", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["ok"] })],
      stateOverrides: {
        messages: [userText("hi"), assistantText("done")],
      },
    });
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "please continue", ctx });
    assert.equal(r.ranQuery, true);
    assert.equal(spy.encodeCount.n, 1);
    assert.equal(lastUserText(ctx.state.messages), "please continue");
    assert.doesNotMatch(r.stderr ?? "", /nothing_pending/);
  });

  it("slash even when NL would miss: /continue never becomes a user task on predicate fail", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["should-not-run"] })],
      stateOverrides: {
        messages: [userText("hi"), assistantText("done")],
      },
    });
    const spy = spyAdapter(ctx);
    const before = ctx.state.messages.length;
    const r = await processChatLine({ line: "/continue", ctx });
    assert.match(r.stderr ?? "", /nothing_pending/);
    assert.equal(spy.encodeCount.n, 0);
    assert.equal(spy.stepCalls.n, 0);
    assert.equal(ctx.state.messages.length, before);
    assert.notEqual(lastUserText(ctx.state.messages), "/continue");
  });

  it("any args → usage EXIT; run not called", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["should-not-run"] })],
      stateOverrides: { messages: pendingMessages() },
    });
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "/continue now", ctx });
    assert.match(r.stderr ?? "", /usage/i);
    assert.match(r.stderr ?? "", /\/continue/);
    assert.equal(spy.encodeCount.n, 0);
    assert.equal(spy.stepCalls.n, 0);
  });

  it("ask / oneshot have no continue entry — /continue is the query text", () => {
    const ask = parseArgs({
      argv: ["ask", "/continue"],
      interactive: false,
    });
    assert.equal(ask.command, "ask");
    assert.equal(ask.query, "/continue");

    const oneshot = parseArgs({
      argv: ["/continue"],
      interactive: false,
    });
    assert.equal(oneshot.command, "oneshot");
    assert.equal(oneshot.query, "/continue");
  });
});

describe("T3 overflow: overlong non-exact NL still MAX_MESSAGE_CHARS", () => {
  it("overlong prose is refused on the query arm; run not called", async () => {
    const line = `${"x".repeat(MAX_MESSAGE_CHARS + 1)} please continue`;
    const pending = pendingMessages();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["should-not-run"] })],
      stateOverrides: { messages: pending },
    });
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line, ctx });
    assert.match(r.stderr ?? "", /MAX_MESSAGE_CHARS|max length/i);
    assert.match(r.stderr ?? "", new RegExp(String(MAX_MESSAGE_CHARS)));
    assert.equal(spy.encodeCount.n, 0);
    assert.equal(spy.stepCalls.n, 0);
    assert.equal(ctx.state.messages.length, pending.length);
  });
});

describe("T3 concurrent: busy_stop_first does not abort in-flight turn", () => {
  it("/continue while a query is in-flight → busy_stop_first; abort stays false", async () => {
    const ac = new AbortController();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["from-inflight"] })],
      delayMs: 120,
      abortController: ac,
      stateOverrides: { messages: pendingMessages() },
    });
    const spy = spyAdapter(ctx);
    const inflight = processChatLine({ line: "work", ctx });
    await new Promise((r) => setTimeout(r, 30));
    const cont = await processChatLine({ line: "/continue", ctx });
    assert.match(cont.stderr ?? "", /busy_stop_first/);
    assert.equal(ac.signal.aborted, false);
    const finished = await inflight;
    assert.equal(finished.ranQuery, true);
    assert.match(finished.output, /from-inflight/);
    assert.equal(spy.encodeCount.n, 1);
  });

  it("busy + non-pending table NL → skip, not busy_stop_first; append path", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["appended-while-busy"] })],
      stateOverrides: {
        messages: [userText("hi"), assistantText("done")],
      },
    });
    ctx.clientBusy = { value: true };
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "please continue", ctx });
    assert.doesNotMatch(r.stderr ?? "", /busy_stop_first/);
    assert.equal(r.ranQuery, true);
    assert.equal(spy.encodeCount.n, 1);
    assert.equal(lastUserText(ctx.state.messages), "please continue");
    assert.match(r.output, /appended-while-busy/);
  });

  it("busy + pending table NL → busy_stop_first; run not called", async () => {
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["should-not-run"] })],
      stateOverrides: { messages: pendingMessages() },
    });
    ctx.clientBusy = { value: true };
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "please continue", ctx });
    assert.match(r.stderr ?? "", /busy_stop_first/);
    assert.equal(r.ranQuery, undefined);
    assert.equal(spy.encodeCount.n, 0);
    assert.equal(spy.stepCalls.n, 0);
  });

  it("pending NL while busy → busy_stop_first; original turn still completes", async () => {
    const ac = new AbortController();
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["from-inflight"] })],
      delayMs: 120,
      abortController: ac,
      stateOverrides: { messages: pendingMessages() },
    });
    const inflight = processChatLine({ line: "work", ctx });
    await new Promise((r) => setTimeout(r, 30));
    const cont = await processChatLine({ line: "please continue", ctx });
    assert.match(cont.stderr ?? "", /busy_stop_first/);
    assert.equal(ac.signal.aborted, false);
    const finished = await inflight;
    assert.match(finished.output, /from-inflight/);
  });
});

describe("T3 exception: reload_before_continue + mapStoreError + no fallback", () => {
  it("stale host messages lose to disk: continue prior includes on-disk tool_result", async () => {
    const { store } = await storeFor();
    const id = "cli-continue-stale";
    const disk: AnthropicNativeMessage[] = pendingMessages();
    await store.save({
      id,
      file: sampleFile({ id, overrides: { messages: disk } }),
    });
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["from-disk"] })],
      checkpointStore: store,
      stateOverrides: {
        conversationId: id,
        messages: [userText("do"), assistantToolUse("t1")],
      },
    });
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "/continue", ctx });
    assert.equal(r.ranQuery, true);
    assert.equal(spy.encodeCount.n, 0);
    const prior = spy.stepMessages[0] ?? [];
    const last = prior[prior.length - 1];
    assert.equal(last?.role, "user");
    assert.equal(last?.content[0]?.type, "tool_result");
    assert.equal(ctx.state.conversationId, id);
  });

  it("store.load throw → typed kind EXIT, run not called", async () => {
    const { store, sessionDir } = await storeFor();
    const id = "corrupt-cli-continue";
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, `${id}.json`), "{not-json", "utf8");
    const ctx = makeCtx({
      responses: [assistantResult({ texts: ["should-not-run"] })],
      checkpointStore: store,
      stateOverrides: {
        conversationId: id,
        messages: pendingMessages(),
      },
    });
    const spy = spyAdapter(ctx);
    const r = await processChatLine({ line: "/continue", ctx });
    assert.match(r.stderr ?? "", /parse_failed/);
    assert.match(r.stderr ?? "", new RegExp(id));
    assert.equal(spy.encodeCount.n, 0);
    assert.equal(spy.stepCalls.n, 0);
    assert.notEqual(lastUserText(ctx.state.messages), "/continue");
  });
});
