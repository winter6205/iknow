/**
 * #121 T6: buildMessageParams system-field injection (spec SC 1 + Testing
 * Strategy buildMessageParams half).
 *
 * `buildMessageParams(opts, state, request)` gained an optional `system?`
 * string that is included in the returned MessageCreateParams only when the
 * caller supplies a non-empty value (ask path passes none → behavior is
 * byte-identical to before; KV cache prefix stability is preserved).
 *
 * The function is exported (T6) so these tests import it directly and assert
 * on the actual params object that would be sent to the SDK.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { buildMessageParams } from "../../src/harness/model-adapter/anthropic-adapter.ts";
import type {
  AnthropicNativeMessage,
  LoopState,
} from "../../src/harness/model-adapter/types.ts";
import type { RealAnthropicAdapterOptions } from "../../src/harness/model-adapter/anthropic-adapter.ts";

const userMsg = (text: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const initState = (msgs: AnthropicNativeMessage[] = []): LoopState => ({
  messages: msgs,
  turnCount: 0,
});

function makeOpts(): RealAnthropicAdapterOptions {
  return {
    // client is only referenced by step(), never by buildMessageParams; a
    // minimal structural stub satisfies the type.
    client: {} as never,
    model: "claude-test-model",
    maxTokens: 256,
  };
}

describe("buildMessageParams — system field (#121 T6 / SC 1)", () => {
  it("includes `system` when request.system is a non-empty string", () => {
    const params = buildMessageParams(makeOpts(), initState([userMsg("hi")]), {
      system: "layered instructions",
    });
    assert.equal(params.system, "layered instructions");
  });

  it("omits the system key when request.system is undefined (ask path)", () => {
    const params = buildMessageParams(
      makeOpts(),
      initState([userMsg("hi")]),
      {}
    );
    assert.equal(
      "system" in params,
      false,
      "system must be absent when undefined"
    );
  });

  it("does not include an empty-string system (undefined-only injection)", () => {
    const params = buildMessageParams(makeOpts(), initState([userMsg("hi")]), {
      system: "",
    });
    assert.equal(
      "system" in params,
      false,
      "empty string must not create a system key"
    );
  });

  it("keeps model / max_tokens / messages unchanged when system is present", () => {
    const params = buildMessageParams(makeOpts(), initState([userMsg("hi")]), {
      system: "sys",
    });
    assert.equal(params.model, "claude-test-model");
    assert.equal(params.max_tokens, 256);
    assert.equal(params.messages.length, 1);
  });

  it("conditionally injects tools alongside system (existing behavior preserved)", () => {
    const params = buildMessageParams(makeOpts(), initState([userMsg("hi")]), {
      system: "sys",
      tools: [
        {
          name: "t",
          description: "d",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    assert.equal(params.system, "sys");
    assert.ok(Array.isArray(params.tools), "tools present alongside system");
    assert.equal((params.tools as ReadonlyArray<unknown>).length, 1);
  });
});
