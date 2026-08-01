/**
 * T5 CLI --trace-out flag tests (GH #64).
 */
import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "../../src/cli/parse-args.ts";
import { run } from "../../src/harness/loop-engine.ts";
import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { createRegistry } from "../../src/harness/tools/registry.ts";
import { createExecutor } from "../../src/harness/tools/executor.ts";
import { createJsonlTraceService } from "../../src/harness/trace/jsonl.ts";
import { SessionHub } from "../../src/session-api/hub.ts";
import { SessionStore } from "../../src/session-api/store/index.ts";
import type { ListeningServer } from "../../src/session-api/http.ts";
import { startSessionServe } from "../../src/session-api/serve.ts";
import { assistantResult } from "./_fixtures.ts";

describe("parse-args --trace-out", () => {
  it("parses --trace-out with a file path (ask command)", () => {
    const parsed = parseArgs({
      argv: ["ask", "hello", "--trace-out", "/tmp/x.jsonl"],
    });
    assert.equal(parsed.command, "ask");
    assert.equal(parsed.query, "hello");
    assert.equal(parsed.traceOut, "/tmp/x.jsonl");
  });

  it("parses --trace-out with a file path (serve command)", () => {
    const parsed = parseArgs({
      argv: ["serve", "--trace-out", "/tmp/serve.jsonl"],
    });
    assert.equal(parsed.command, "serve");
    assert.equal(parsed.traceOut, "/tmp/serve.jsonl");
  });

  it("parses --trace-out before subcommand positional", () => {
    const parsed = parseArgs({
      argv: ["--trace-out", "/tmp/early.jsonl", "ask", "hi"],
    });
    assert.equal(parsed.command, "ask");
    assert.equal(parsed.traceOut, "/tmp/early.jsonl");
  });

  it("throws when --trace-out has no argument", () => {
    assert.throws(
      () => parseArgs({ argv: ["ask", "hello", "--trace-out"] }),
      /--trace-out requires a file path argument/
    );
  });

  it("traceOut is undefined when flag not provided", () => {
    const parsed = parseArgs({ argv: ["ask", "hello"] });
    assert.equal(parsed.traceOut, undefined);
  });

  it("traceOut preserved across early --help return", () => {
    const parsed = parseArgs({
      argv: ["--trace-out", "/tmp/x.jsonl", "--help"],
    });
    assert.equal(parsed.command, "help");
    assert.equal(parsed.traceOut, "/tmp/x.jsonl");
  });
});

describe("trace path priority resolution", () => {
  function resolveTracePath(flag: string | undefined): string {
    return flag ?? process.env.IKNOW_TRACE_OUT ?? "./trace.jsonl";
  }

  let savedEnv: string | undefined;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.IKNOW_TRACE_OUT;
    else process.env.IKNOW_TRACE_OUT = savedEnv;
  });

  it("flag wins over IKNOW_TRACE_OUT env", () => {
    savedEnv = process.env.IKNOW_TRACE_OUT;
    process.env.IKNOW_TRACE_OUT = "/tmp/env.jsonl";
    assert.equal(resolveTracePath("/tmp/flag.jsonl"), "/tmp/flag.jsonl");
  });

  it("env wins over default when no flag", () => {
    savedEnv = process.env.IKNOW_TRACE_OUT;
    process.env.IKNOW_TRACE_OUT = "/tmp/env.jsonl";
    assert.equal(resolveTracePath(undefined), "/tmp/env.jsonl");
  });

  it("default ./trace.jsonl when no flag and no env", () => {
    savedEnv = process.env.IKNOW_TRACE_OUT;
    delete process.env.IKNOW_TRACE_OUT;
    assert.equal(resolveTracePath(undefined), "./trace.jsonl");
  });
});

describe("ask path: trace service injected into harness", () => {
  let scratch: string;
  afterEach(() => {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("runHarness with JsonlTraceService writes trace.jsonl (pure-text turn)", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t5-ask-"));
    const traceFile = join(scratch, "trace.jsonl");
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [assistantResult({ texts: ["hello"] })],
    });
    const trace = createJsonlTraceService({
      filePath: traceFile,
      conversationId: "ask-conv-1",
    });
    const { result } = await run("test question", {
      adapter: model,
      executor: exec,
      registry: reg,
      maxTurns: 5,
      trace,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 1);
    assert.ok(existsSync(traceFile), "trace.jsonl must exist after run");
    const content = readFileSync(traceFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 2, "expected >=2 records (llm + turn)");
    const llmRecord = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(llmRecord["conversation_id"], "ask-conv-1");
    assert.equal(llmRecord["record_type"], "llm_call");
    const turnRecord = JSON.parse(lines[lines.length - 1]!) as Record<
      string,
      unknown
    >;
    assert.equal(turnRecord["record_type"], "turn");
  });

  it("each ask invocation creates a distinct trace instance (ADR-0003 D4)", () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t5-aid-"));
    const a = createJsonlTraceService({
      filePath: join(scratch, "a.jsonl"),
      conversationId: "conv-a",
    });
    const b = createJsonlTraceService({
      filePath: join(scratch, "b.jsonl"),
      conversationId: "conv-b",
    });
    assert.notEqual(a.recordLlmCall, b.recordLlmCall);
  });
});

describe("serve path: SessionHub traceOut creates per-session trace", () => {
  let scratch: string;
  let listening: ListeningServer | undefined;
  afterEach(async () => {
    if (listening) await listening.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    listening = undefined;
  });

  it("SessionHub with traceOut writes trace.jsonl on postMessage with session conversation_id", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t5-hub-"));
    const traceFile = join(scratch, "trace.jsonl");
    const store = new SessionStore(scratch);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [assistantResult({ texts: ["hello from hub"] })],
    });
    const hub = new SessionHub({
      store,
      deps: { adapter: model, executor: exec, registry: reg, maxTurns: 5 },
      traceOut: traceFile,
    });

    const created = await hub.createSession();
    const convId = created.session.conversation_id;
    assert.ok(convId, "createSession returns a conversation_id");

    await hub.postMessage({ conversationId: convId, text: "test query" });

    assert.ok(
      existsSync(traceFile),
      "trace.jsonl must exist after postMessage"
    );
    const content = readFileSync(traceFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 2, "expected >=2 records (llm + turn)");
    const llmRecord = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(
      llmRecord["conversation_id"],
      convId,
      "trace conversation_id must match session id (ADR-0003 D4)"
    );
  });

  it("SessionHub without traceOut does NOT write any trace file", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t5-noop-"));
    const store = new SessionStore(scratch);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [assistantResult({ texts: ["ok"] })],
    });
    const hub = new SessionHub({
      store,
      deps: { adapter: model, executor: exec, registry: reg, maxTurns: 5 },
    });
    const created = await hub.createSession();
    await hub.postMessage({
      conversationId: created.session.conversation_id,
      text: "q",
    });
    assert.equal(
      existsSync(join(scratch, "trace.jsonl")),
      false,
      "no trace.jsonl when traceOut omitted"
    );
  });

  it("startSessionServe accepts traceOut option (type + passthrough)", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t5-serve-"));
    const traceFile = join(scratch, "trace.jsonl");
    const out = await startSessionServe({
      port: 0,
      dataDir: scratch,
      traceOut: traceFile,
    });
    listening = out.listening;
    const created = await out.hub.createSession();
    assert.ok(created.session.conversation_id);
  });

  it("postMessage creates a NEW trace instance per session (not cached in deps)", async () => {
    scratch = mkdtempSync(join(tmpdir(), "trace-t5-multi-"));
    const traceFile = join(scratch, "trace.jsonl");
    const store = new SessionStore(scratch);
    const tool = createStubTool({ name: "noop", next: () => ({}) });
    const reg = createRegistry([tool]);
    const exec = createExecutor(reg);
    const model = createStubModel({
      responses: [
        assistantResult({ texts: ["reply-1"] }),
        assistantResult({ texts: ["reply-2"] }),
      ],
    });
    const hub = new SessionHub({
      store,
      deps: { adapter: model, executor: exec, registry: reg, maxTurns: 5 },
      traceOut: traceFile,
    });

    const s1 = await hub.createSession();
    const s2 = await hub.createSession();
    assert.notEqual(
      s1.session.conversation_id,
      s2.session.conversation_id,
      "sessions must have distinct ids"
    );

    await hub.postMessage({
      conversationId: s1.session.conversation_id,
      text: "q1",
    });
    await hub.postMessage({
      conversationId: s2.session.conversation_id,
      text: "q2",
    });

    const content = readFileSync(traceFile, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    assert.ok(lines.length >= 4, "both sessions appended to the same file");

    const ids = new Set([
      s1.session.conversation_id,
      s2.session.conversation_id,
    ]);
    for (const line of lines) {
      const rec = JSON.parse(line) as Record<string, unknown>;
      assert.ok(
        ids.has(rec["conversation_id"] as string),
        "conversation_id must belong to one of the two sessions"
      );
    }
  });
});
