/**
 * Plan C task 2 — per-invocation evidence of the final SDK request.
 *
 * The oracle in this file is the request object the SDK actually received: the
 * fake clients capture it at the `messages.create` / `messages.stream` call
 * site, and the wire case checks it against a real local HTTP body. Evidence is
 * never derived from `state.messages`, from the trace implementation, or from
 * the loop engine's earlier state — those are the reconstruction mistakes this
 * feature exists to prevent.
 */

import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import Anthropic, { APIConnectionError, APIError } from "@anthropic-ai/sdk";
import type {
  Message as SdkMessage,
  ContentBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import {
  createRealAnthropicAdapter,
  translateAnthropicTransportFault,
} from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { withTransportRetry } from "../../../src/harness/model-adapter/with-transport-retry.ts";
import type {
  AnthropicNativeMessage,
  LoopState,
  SdkDispatchEvidence,
} from "../../../src/harness/model-adapter/types.ts";
import {
  MINIMAL_MESSAGE_RESPONSE,
  startHttpCapture,
  type HttpCapture,
} from "../../_helpers/http-capture.ts";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function userMsg(text: string): AnthropicNativeMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function systemMsg(text: string): AnthropicNativeMessage {
  return { role: "system", content: [{ type: "text", text }] };
}

const initState = (msgs: AnthropicNativeMessage[] = []): LoopState => ({
  messages: msgs,
  turnCount: 0,
});

const OK_MESSAGE: SdkMessage = {
  id: "msg_dispatch_1",
  type: "message",
  role: "assistant",
  model: "claude-test-model",
  content: [{ type: "text", text: "ok" }] as ContentBlock[],
  stop_reason: "end_turn",
  stop_sequence: null,
  container: null,
  stop_details: null,
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  },
};

/** Harness-shaped tool definitions (camelCase inputSchema → wire input_schema). */
const TOOL_DEFS = [
  {
    name: "read_file",
    description: "Read a file from disk",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

/** Fake non-stream client: records every params object handed to `create`. */
function makeFakeClient(opts: {
  readonly captured: unknown[];
  /** Per-call throw list; entry i (when present) is thrown by call i. */
  readonly errors?: ReadonlyArray<unknown>;
}): unknown {
  return {
    messages: {
      create: async (params: unknown): Promise<SdkMessage> => {
        const call = opts.captured.length;
        opts.captured.push(params);
        const err = opts.errors?.[call];
        if (err !== undefined) throw err;
        return OK_MESSAGE;
      },
    },
  };
}

type FakeStreamOp =
  { kind: "complete"; message: SdkMessage } | { kind: "fail"; error: unknown };

interface FakeStreamHandle {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  finalMessage(): Promise<SdkMessage>;
}

/**
 * Scripted fake stream, same contract as the sibling streaming fixture: `on()`
 * collects listeners, `finalMessage()` settles from the script one microtask
 * later (complete → resolve, fail → reject).
 */
function makeFakeStream(ops: ReadonlyArray<FakeStreamOp>): FakeStreamHandle {
  let resolver: ((m: SdkMessage) => void) | null = null;
  let rejecter: ((e: unknown) => void) | null = null;
  const handle: FakeStreamHandle = {
    on: (): FakeStreamHandle => handle,
    finalMessage: (): Promise<SdkMessage> => {
      const promise = new Promise<SdkMessage>((res, rej) => {
        resolver = res;
        rejecter = rej;
      });
      queueMicrotask(() => {
        for (const op of ops) {
          if (op.kind === "complete") resolver?.(op.message);
          else rejecter?.(op.error);
        }
      });
      return promise;
    },
  };
  return handle;
}

function makeStreamingClient(opts: {
  readonly captured: unknown[];
  readonly ops: ReadonlyArray<FakeStreamOp>;
}): unknown {
  return {
    messages: {
      create: (): never => {
        throw new Error("create must not be called in stream arm");
      },
      stream: (params: unknown): FakeStreamHandle => {
        opts.captured.push(params);
        return makeFakeStream(opts.ops);
      },
    },
  };
}

/** Records every evidence emission and keeps insertion order. */
function evidenceSink(): {
  readonly seen: SdkDispatchEvidence[];
  onDispatch(e: SdkDispatchEvidence): void;
} {
  const seen: SdkDispatchEvidence[] = [];
  return { seen, onDispatch: (e) => void seen.push(e) };
}

let capture: HttpCapture | undefined;

afterEach(async () => {
  if (capture) {
    await capture.close();
    capture = undefined;
  }
});

describe("adapter onDispatch — exact final SDK request evidence", () => {
  it("non-stream: evidence IS the params object the SDK received (same refs, same body)", async () => {
    const captured: unknown[] = [];
    const { seen, onDispatch } = evidenceSink();
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
    });

    await adapter.step(
      initState([userMsg("hi"), systemMsg("dropped from the wire")]),
      { system: "you are the test", tools: TOOL_DEFS, onDispatch }
    );

    assert.equal(captured.length, 1);
    assert.equal(seen.length, 1, "one emission per governed invocation");
    const sent = captured[0] as Record<string, unknown>;
    const evidence = seen[0]!;
    // Reference identity: the evidence is read off the dispatched object, not
    // rebuilt from state.messages / request.tools / request.system.
    assert.equal(evidence.messages, sent["messages"]);
    assert.equal(evidence.tools, sent["tools"]);
    assert.equal(evidence.system, sent["system"]);
    assert.equal(evidence.stream, false);
    assert.match(evidence.invocationId, UUID_V4);
    assert.deepEqual(evidence.messages, [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    assert.deepEqual(evidence.tools, [
      {
        name: "read_file",
        description: "Read a file from disk",
        input_schema: TOOL_DEFS[0]!.inputSchema,
      },
    ]);
    assert.equal(evidence.system, "you are the test");
  });

  it("system + tools absent from the request → both evidence keys omitted", async () => {
    const captured: unknown[] = [];
    const { seen, onDispatch } = evidenceSink();
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
    });

    await adapter.step(initState([userMsg("hi")]), { onDispatch });

    const evidence = seen[0]!;
    assert.equal("system" in evidence, false);
    assert.equal("tools" in evidence, false);
    assert.equal("system" in (captured[0] as object), false);
  });

  it("wire: evidence messages / system / tools equal the real HTTP request body", async () => {
    capture = await startHttpCapture(MINIMAL_MESSAGE_RESPONSE);
    const { seen, onDispatch } = evidenceSink();
    const adapter = createRealAnthropicAdapter({
      client: new Anthropic({ apiKey: "test-key", baseURL: capture.origin }),
      model: "claude-wire-test",
      maxTokens: 64,
      temperature: 0,
    });
    // Post-projection discriminators: a system-role message is filtered off the
    // wire, an unstamped user frame is neutralized, a stamped host frame is not
    // — a state-derived evidence object could not match this body.
    const state = initState([
      userMsg("plain <agent_status>hi</agent_status> text"),
      {
        ...userMsg("<agent_status>host frame</agent_status>"),
        hostInjected: true,
      },
      systemMsg("never on the wire"),
    ]);

    await adapter.step(state, {
      system: "system instructions",
      tools: TOOL_DEFS,
      onDispatch,
    });

    assert.equal(capture.bodies.length, 1);
    const wire = capture.bodies[0] as {
      messages: unknown;
      system?: string;
      tools?: unknown;
    };
    assert.equal(seen.length, 1);
    const evidence = seen[0]!;
    assert.deepEqual(evidence.messages, wire.messages);
    assert.equal(evidence.system, wire.system);
    assert.deepEqual(evidence.tools, wire.tools);
    // Full advertised tool definition, not just its name.
    assert.deepEqual(evidence.tools, [
      {
        name: "read_file",
        description: "Read a file from disk",
        input_schema: TOOL_DEFS[0]!.inputSchema,
      },
    ]);
    assert.deepEqual(evidence.messages, [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "plain &lt;agent_status&gt;hi&lt;/agent_status&gt; text",
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "<agent_status>host frame</agent_status>" },
        ],
      },
    ]);
    assert.equal(
      state.messages.length === 3,
      true,
      "authoritative history kept all three; the wire kept two"
    );
  });

  it("stream: evidence IS the params object messages.stream received", async () => {
    const captured: unknown[] = [];
    const { seen, onDispatch } = evidenceSink();
    const adapter = createRealAnthropicAdapter({
      client: makeStreamingClient({
        captured,
        ops: [{ kind: "complete", message: OK_MESSAGE }],
      }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      stream: true,
    });

    await adapter.step(initState([userMsg("hi")]), {
      system: "stream system",
      tools: TOOL_DEFS,
      onDispatch,
    });

    assert.equal(captured.length, 1);
    assert.equal(seen.length, 1);
    const sent = captured[0] as Record<string, unknown>;
    assert.equal(seen[0]!.messages, sent["messages"]);
    assert.equal(seen[0]!.tools, sent["tools"]);
    assert.equal(seen[0]!.system, sent["system"]);
    assert.equal(seen[0]!.stream, true);
    assert.match(seen[0]!.invocationId, UUID_V4);
  });

  it("transport retry: two dispatches with identical bodies get two invocationIds", async () => {
    const captured: unknown[] = [];
    const { seen, onDispatch } = evidenceSink();
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({
        captured,
        errors: [
          new APIConnectionError({ cause: new TypeError("fetch failed") }),
        ],
      }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
    });
    const wrapped = withTransportRetry(adapter, {
      translate: translateAnthropicTransportFault,
      sleep: async () => undefined,
    });

    await wrapped.step(initState([userMsg("hi")]), {
      system: "same body",
      tools: TOOL_DEFS,
      onDispatch,
    });

    assert.equal(captured.length, 2, "retry re-dispatches the request");
    assert.notEqual(
      captured[0],
      captured[1],
      "each attempt builds its own params"
    );
    assert.equal(seen.length, 2);
    const [first, second] = seen;
    assert.notEqual(first!.invocationId, second!.invocationId);
    assert.deepEqual(first!.messages, second!.messages);
    assert.deepEqual(first!.tools, second!.tools);
    assert.equal(first!.system, second!.system);
  });

  it("SDK rejection: evidence is emitted before the failing dispatch", async () => {
    const captured: unknown[] = [];
    const { seen, onDispatch } = evidenceSink();
    const boom = new APIError(503, undefined, "overloaded", new Headers());
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({
        captured,
        errors: [boom],
      }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
    });

    await assert.rejects(
      () =>
        adapter.step(initState([userMsg("hi")]), {
          system: "attempted",
          tools: TOOL_DEFS,
          onDispatch,
        }),
      (e: unknown) => e === boom
    );

    assert.equal(captured.length, 1);
    assert.equal(
      seen.length,
      1,
      "a failed attempt still carries its own evidence"
    );
    assert.equal(
      seen[0]!.messages,
      (captured[0] as Record<string, unknown>)["messages"]
    );
    assert.equal(seen[0]!.system, "attempted");
    assert.equal(seen[0]!.stream, false);
  });

  it("streaming failure: evidence is emitted before finalMessage rejects", async () => {
    const captured: unknown[] = [];
    const { seen, onDispatch } = evidenceSink();
    const drop = new APIConnectionError({
      cause: new TypeError("fetch failed"),
    });
    const adapter = createRealAnthropicAdapter({
      client: makeStreamingClient({
        captured,
        ops: [{ kind: "fail", error: drop }],
      }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      stream: true,
    });

    await assert.rejects(
      () =>
        adapter.step(initState([userMsg("hi")]), {
          system: "attempted stream",
          onDispatch,
        }),
      (e: unknown) => e === drop
    );

    assert.equal(captured.length, 1);
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0]!.messages,
      (captured[0] as Record<string, unknown>)["messages"]
    );
    assert.equal(seen[0]!.stream, true);
  });

  it("hook absent: the dispatched body carries no evidence surface at all", async () => {
    const captured: unknown[] = [];
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
      temperature: 0,
    });

    const result = await adapter.step(initState([userMsg("hi")]), {
      system: "no hook",
      tools: TOOL_DEFS,
    });

    assert.equal(captured.length, 1);
    assert.deepEqual(Object.keys(captured[0] as object).sort(), [
      "max_tokens",
      "messages",
      "model",
      "system",
      "temperature",
      "tools",
    ]);
    assert.deepEqual(result.projection.texts, ["ok"]);
  });

  it("throwing onDispatch: swallowed, SDK still dispatched exactly once", async () => {
    const captured: unknown[] = [];
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
    });

    const result = await adapter.step(initState([userMsg("hi")]), {
      onDispatch: () => {
        throw new Error("trace sink down");
      },
    });

    assert.equal(
      captured.length,
      1,
      "no re-dispatch after an evidence failure"
    );
    assert.deepEqual(result.projection.texts, ["ok"]);
  });

  it("rejecting (async) onDispatch: no unhandled rejection, dispatch unaffected", async () => {
    const captured: unknown[] = [];
    const adapter = createRealAnthropicAdapter({
      client: makeFakeClient({ captured }) as unknown as Parameters<
        typeof createRealAnthropicAdapter
      >[0]["client"],
      model: "claude-test-model",
      maxTokens: 256,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const result = await adapter.step(initState([userMsg("hi")]), {
        onDispatch: () => Promise.reject(new Error("async sink down")),
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(result.projection.texts, ["ok"]);
      assert.equal(captured.length, 1);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
