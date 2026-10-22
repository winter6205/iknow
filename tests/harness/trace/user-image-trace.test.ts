/**
 * T4 trace-projection clause: "final request/trace projection preserve image
 * blocks".
 *
 * The observable is the row on disk plus the body files behind its refs,
 * written by the production `createJsonlTraceService` into a real temporary
 * pool during a real `run()`. The adapter is the production
 * `createRealAnthropicAdapter`, so the retained dispatch evidence is the
 * post-projection request object the SDK call site actually received — a
 * text-only stand-in could not produce these bytes. Only the external model
 * service is stubbed (an in-process fake `messages.create`).
 *
 * What must NOT happen is a silent flattening: a content array reduced to a
 * string, an image block dropped, or its base64 payload inlined into a text
 * block. Each case therefore reads the retained body back verbatim.
 */

import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Message as SdkMessage,
  ContentBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import { createRealAnthropicAdapter } from "../../../src/harness/model-adapter/anthropic-adapter.ts";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";
import { run } from "../../../src/harness/loop-engine.ts";
import { createRegistry } from "../../../src/harness/tools/registry.ts";
import { createStubTool } from "../../../src/harness/stubs/stub-tool.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/model-adapter/types.ts";
import {
  PNG_1X1_BASE64,
  imageBlock,
  textBlock,
} from "../../fixtures/image-payloads.ts";
import { parseJsonl } from "./_fixtures.ts";

const CONVERSATION_ID = "conv-user-image-trace";

const OK_MESSAGE: SdkMessage = {
  id: "msg_user_image_1",
  type: "message",
  role: "assistant",
  model: "claude-test-model",
  content: [{ type: "text", text: "a red square" }] as ContentBlock[],
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

const dirs: string[] = [];

function poolDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "iknow-user-image-trace-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** The user paste: text plus one real base64 image block, in gesture order. */
const PASTED: AnthropicNativeMessage = {
  role: "user",
  content: [textBlock("what is in this?"), imageBlock(PNG_1X1_BASE64)],
};

interface TraceRun {
  readonly dir: string;
  readonly rows: Array<Record<string, unknown>>;
  /** Params object the SDK call site received, one entry per dispatch. */
  readonly dispatched: unknown[];
  readonly failures: number;
}

async function imageTraceRun(): Promise<TraceRun> {
  const dir = poolDir();
  const dispatched: unknown[] = [];
  const client = {
    messages: {
      create: async (params: unknown): Promise<SdkMessage> => {
        dispatched.push(params);
        return OK_MESSAGE;
      },
    },
  };
  const trace = createJsonlTraceService({
    filePath: dir,
    conversationId: CONVERSATION_ID,
  });
  const adapter = createRealAnthropicAdapter({
    client: client as unknown as Parameters<
      typeof createRealAnthropicAdapter
    >[0]["client"],
    model: "claude-test-model",
    maxTokens: 64,
  });
  await run(
    "what is in this?",
    {
      adapter,
      executor: { executeAll: async () => [] },
      registry: createRegistry([
        createStubTool({ name: "noop", next: () => ({}) }),
      ]),
      maxTurns: 5,
      trace,
    },
    undefined,
    { userMessage: PASTED }
  );
  return {
    dir,
    rows: parseJsonl(join(dir, `${CONVERSATION_ID}.jsonl`)),
    dispatched,
    failures: trace.traceWriteFailures,
  };
}

function llmCallRow(
  rows: Array<Record<string, unknown>>
): Record<string, unknown> {
  const row = rows.find((r) => r["record_type"] === "llm_call");
  assert.ok(row, "the production writer must emit one llm_call row");
  return row;
}

/** Content-level blob refs written by `toBlobReferences`: {role, content:{sha, bytes}}. */
interface RowMessageRef {
  role: unknown;
  content: { sha: string; bytes: number };
}

function bodyOf(dir: string, sha: string): string {
  return readFileSync(join(dir, "blobs", sha), "utf8");
}

function userContentBody(dir: string, ref: RowMessageRef): unknown {
  return JSON.parse(bodyOf(dir, ref.content.sha));
}

describe("llm_call retains the user image block instead of flattening it", () => {
  it("the messages channel keeps a block array with the image arm verbatim", async () => {
    const { dir, rows, failures } = await imageTraceRun();
    assert.equal(failures, 0);
    const row = llmCallRow(rows);
    const refs = row["messages"] as RowMessageRef[];
    assert.equal(refs.length, 1, "one user turn in history");
    assert.equal(refs[0]!.role, "user");
    // The shape tag is what protects the read side: a flattened string would
    // be stored as {kind:"str"}, which is exactly the loss this clause forbids.
    const payload = userContentBody(dir, refs[0]!) as {
      kind: string;
      v: unknown;
    };
    assert.equal(payload.kind, "blocks");
    assert.deepEqual(payload.v, [
      { type: "text", text: "what is in this?" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: PNG_1X1_BASE64,
        },
      },
    ]);
  });

  it("the dispatch-evidence channel retains the projected image block", async () => {
    const { dir, rows, dispatched } = await imageTraceRun();
    // The dispatch channel is the post-projection request object, so it is
    // where an unknown-block fail-closed would surface first.
    assert.equal(dispatched.length, 1);
    const sent = dispatched[0] as { messages: unknown[] };
    const image = (sent.messages[0] as { content: unknown[] }).content[1] as {
      type: string;
    };
    assert.equal(image.type, "image");

    const row = llmCallRow(rows);
    const entries = row["dispatch_evidence"] as Array<{
      invocationId: string;
      outcome: string;
      messages: { sha: string };
    }>;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.outcome, "ok");
    assert.deepEqual(
      JSON.parse(bodyOf(dir, entries[0]!.messages.sha)),
      sent.messages
    );
  });

  it("the base64 payload is never inlined into a text block", async () => {
    const { dir, rows } = await imageTraceRun();
    const refs = llmCallRow(rows)["messages"] as RowMessageRef[];
    const content = userContentBody(dir, refs[0]!) as {
      v: Array<{ type: string; text?: string }>;
    };
    assert.deepEqual(
      content.v.map((b) => b.type),
      ["text", "image"]
    );
    for (const block of content.v) {
      assert.equal(
        (block.text ?? "").includes(PNG_1X1_BASE64),
        false,
        "attachment bytes must ride in source.data, not in text"
      );
    }
  });
});
