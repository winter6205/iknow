/**
 * T2 (#688): SessionHub.continueSession — reload, predicate, skip-append run.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionHub } from "../../src/session-api/hub.ts";
import {
  CURRENT_SCHEMA_VERSION,
  pinGoal,
  resolveConversationDir,
  resolveProjectSessionDir,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { SessionStoreError } from "../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../src/session-api/store/index.ts";
import type {
  AnthropicNativeMessage,
  LoopEngineDeps,
  LoopState,
} from "../../src/harness/index.ts";
import { ValidationError } from "../../src/shared/errors.ts";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";
import { LOOP_DETECTED_TEXT } from "../../src/harness/tool-loop-detect.ts";

let baseDir: string;
let sessionDir: string;
let store: SessionStore;

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-hub-continue-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

function userText(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
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

function sampleFile(opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 {
  const { id, overrides = {} } = opts;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    workspaceRoot: process.cwd(),
    ...overrides,
  };
}

async function seed(
  id: string,
  overrides: Partial<SessionFileV1>
): Promise<void> {
  await store.save({ id, file: sampleFile({ id, overrides }) });
}

function spyDeps(responses: Parameters<typeof makeDeps>[0]): {
  deps: LoopEngineDeps;
  encodeCount: { n: number };
  stepMessages: AnthropicNativeMessage[][];
  stepCalls: { n: number };
} {
  const inner = makeDeps(responses);
  const encodeCount = { n: 0 };
  const stepMessages: AnthropicNativeMessage[][] = [];
  const stepCalls = { n: 0 };
  const deps: LoopEngineDeps = {
    ...inner,
    adapter: {
      ...inner.adapter,
      encodeUserText: (t: string) => {
        encodeCount.n += 1;
        return inner.adapter.encodeUserText(t);
      },
      step: async (state: LoopState, request, signal) => {
        stepCalls.n += 1;
        stepMessages.push([...state.messages]);
        return inner.adapter.step(state, request, signal);
      },
    },
  };
  return { deps, encodeCount, stepMessages, stepCalls };
}

describe("continueSession predicate rejects without run", () => {
  it("empty session → ValidationError nothing_pending field=continue, step not called", async () => {
    const { deps, stepCalls } = spyDeps([
      assistantResult({ texts: ["should-not-run"] }),
    ]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const { session } = await hub.createSession();
    await assert.rejects(
      () => hub.continueSession(session.conversation_id),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.["field"], "continue");
        assert.match(err.message, /nothing_pending/);
        return true;
      }
    );
    assert.equal(stepCalls.n, 0);
  });

  it("pinned goal → goal_active, step not called", async () => {
    const { deps, stepCalls } = spyDeps([
      assistantResult({ texts: ["should-not-run"] }),
    ]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const { session } = await hub.createSession();
    await seed(session.conversation_id, {
      messages: [userText("do"), assistantToolUse("t1"), toolResultOnly("t1")],
      goal: pinGoal({
        current: undefined,
        text: "keep going auto",
        now: new Date().toISOString(),
      }),
    });
    await assert.rejects(
      () => hub.continueSession(session.conversation_id),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.["field"], "continue");
        assert.match(err.message, /goal_active/);
        return true;
      }
    );
    assert.equal(stepCalls.n, 0);
  });

  it("LOOP_DETECTED tail → fused_clean_stop, step not called", async () => {
    const { deps, stepCalls } = spyDeps([
      assistantResult({ texts: ["should-not-run"] }),
    ]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const { session } = await hub.createSession();
    await seed(session.conversation_id, {
      messages: [userText("do"), userText(LOOP_DETECTED_TEXT)],
    });
    await assert.rejects(
      () => hub.continueSession(session.conversation_id),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.details?.["field"], "continue");
        assert.match(err.message, /fused_clean_stop/);
        return true;
      }
    );
    assert.equal(stepCalls.n, 0);
  });
});

describe("continueSession skip-append + reload_before_continue", () => {
  it("P4 disk tail tool_result is in prior; encodeUserText count = 0; same conversationId", async () => {
    const { deps, encodeCount, stepMessages } = spyDeps([
      assistantResult({ texts: ["continued"] }),
    ]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const { session } = await hub.createSession();
    const id = session.conversation_id;
    const diskMessages: AnthropicNativeMessage[] = [
      userText("do"),
      assistantToolUse("t1"),
      toolResultOnly("t1"),
    ];
    await seed(id, { messages: diskMessages, turnCount: 1 });
    const res = await hub.continueSession(id);
    assert.equal(res.session.conversation_id, id);
    assert.equal(encodeCount.n, 0);
    assert.ok(stepMessages[0]);
    const last = stepMessages[0]![stepMessages[0]!.length - 1];
    assert.equal(last?.role, "user");
    assert.equal(last?.content[0]?.type, "tool_result");
    assert.equal(res.turn.query, "");
    assert.equal(res.turn.answer.stopReason, "completed");
    assert.equal(res.turn.answer.finalText, "continued");
  });

  it("trailing interrupt stays in priorMessages passed to run", async () => {
    const interrupt: AnthropicNativeMessage = {
      role: "system",
      content: [{ type: "text", text: "Interrupted by user." }],
    };
    const { deps, stepMessages, encodeCount } = spyDeps([
      assistantResult({ texts: ["after interrupt"] }),
    ]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const { session } = await hub.createSession();
    await seed(session.conversation_id, {
      messages: [
        userText("do"),
        assistantToolUse("t1"),
        toolResultOnly("t1"),
        interrupt,
      ],
    });
    await hub.continueSession(session.conversation_id);
    assert.equal(encodeCount.n, 0);
    const prior = stepMessages[0] ?? [];
    const last = prior[prior.length - 1];
    assert.equal(last?.role, "system");
    assert.equal(
      last?.content[0] && last.content[0].type === "text"
        ? last.content[0].text
        : "",
      "Interrupted by user."
    );
  });

  it("orphan tool_use on disk is closeout-paired before adapter.step", async () => {
    const { deps, stepMessages } = spyDeps([
      assistantResult({ texts: ["closed out"] }),
    ]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const { session } = await hub.createSession();
    await seed(session.conversation_id, {
      messages: [userText("do"), assistantToolUse("orphan-1")],
    });
    await hub.continueSession(session.conversation_id);
    const seen = stepMessages[0] ?? [];
    const useIds = seen.flatMap((m) =>
      m.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          return b.type === "tool_use" ? b.id : "";
        })
    );
    const resultIds = new Set(
      seen.flatMap((m) =>
        m.content
          .filter((b) => b.type === "tool_result")
          .map((b) => (b.type === "tool_result" ? b.tool_use_id : ""))
      )
    );
    for (const id of useIds) {
      assert.ok(resultIds.has(id), `tool_use ${id} must be paired before step`);
    }
  });
});

describe("continueSession store.load failures", () => {
  it("missing session → not_found, step not called", async () => {
    const { deps, stepCalls } = spyDeps([assistantResult({ texts: ["no"] })]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    await assert.rejects(
      () => hub.continueSession("no-such-continue-id"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "not_found");
        return true;
      }
    );
    assert.equal(stepCalls.n, 0);
  });

  it("corrupt file → parse_failed, step not called", async () => {
    const { deps, stepCalls } = spyDeps([assistantResult({ texts: ["no"] })]);
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const dir = resolveConversationDir({
      projectDir: sessionDir,
      conversationId: "corrupt-continue",
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "corrupt-continue.json"), "{not-json", "utf8");
    await assert.rejects(
      () => hub.continueSession("corrupt-continue"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        assert.equal(e.kind, "parse_failed");
        return true;
      }
    );
    assert.equal(stepCalls.n, 0);
  });
});

describe("continueSession serialize queue — no busy_stop_first", () => {
  it("two concurrent continues on the same id run serially and never throw busy_stop_first", async () => {
    const inner = makeDeps(
      [
        assistantResult({ texts: ["first-continue"] }),
        assistantResult({ texts: ["second-should-reject-or-run"] }),
      ],
      { delayMs: 40 }
    );
    let inflight = 0;
    let maxInflight = 0;
    const deps: LoopEngineDeps = {
      ...inner,
      adapter: {
        ...inner.adapter,
        step: async (state, request, signal) => {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          try {
            return await inner.adapter.step(state, request, signal);
          } finally {
            inflight -= 1;
          }
        },
      },
    };
    const hub = new SessionHub({ store, deps, workspaceRoot: process.cwd() });
    const { session } = await hub.createSession();
    await seed(session.conversation_id, {
      messages: [userText("do"), assistantToolUse("t1"), toolResultOnly("t1")],
    });
    const results = await Promise.allSettled([
      hub.continueSession(session.conversation_id),
      hub.continueSession(session.conversation_id),
    ]);
    assert.equal(maxInflight, 1, "serialize must not overlap step()");
    for (const r of results) {
      if (r.status === "rejected") {
        assert.ok(r.reason instanceof ValidationError);
        assert.doesNotMatch(String(r.reason.message), /busy_stop_first/);
        assert.notEqual(r.reason.details?.["field"], "busy");
      }
    }
    assert.ok(results.some((r) => r.status === "fulfilled"));
  });
});
