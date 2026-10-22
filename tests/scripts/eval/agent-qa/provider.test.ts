/**
 * Scripted provider — the only boundary the offline path may fake, so its own
 * honesty is pinned here: one step per call in order, every call recorded, a loud
 * fault when the script runs out, and a server that really closes.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import {
  ProviderFailure,
} from "../../../../scripts/eval/agent-qa/failures.ts";
import {
  assertScriptConsumed,
  startScriptedProvider,
} from "../../../../scripts/eval/agent-qa/provider.ts";
import type { ScriptedProvider } from "../../../../scripts/eval/agent-qa/provider.ts";
import type { ScriptedStep } from "../../../../scripts/eval/agent-qa/types.ts";

const open: ScriptedProvider[] = [];

function track(provider: ScriptedProvider): ScriptedProvider {
  open.push(provider);
  return provider;
}

afterEach(async () => {
  // A leaked loopback server is a defect, so teardown is asserted-adjacent: every
  // provider this file made is stopped here even when the case failed midway.
  await Promise.all(
    open.splice(0).map((provider) => provider.stop().catch(() => undefined))
  );
});

const STEPS: readonly ScriptedStep[] = [
  {
    kind: "tool",
    toolCallId: "call-1",
    toolName: "write_file",
    input: { path: "notes/a.md", content: "alpha\n" },
  },
  { kind: "text", text: "wrote it" },
];

async function post(
  provider: ScriptedProvider,
  body: Record<string, unknown>
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${provider.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `${JSON.stringify(body)}`,
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("startScriptedProvider — one scripted step per call", () => {
  it("serves a tool step then a text step, in order, and records both bodies", async () => {
    const provider = track(await startScriptedProvider(STEPS));
    assert.equal(provider.port > 0, true);
    assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    const first = await post(provider, { stream: false, messages: [] });
    const second = await post(provider, { stream: false, messages: [1] });

    assert.equal(first.status, 200);
    assert.equal(first.json["stop_reason"], "tool_use");
    const content = first.json["content"] as Record<string, unknown>[];
    assert.equal(content[0]?.["type"], "tool_use");
    assert.equal(content[0]?.["id"], "call-1");
    assert.equal(content[0]?.["name"], "write_file");
    assert.deepEqual(content[0]?.["input"], { path: "notes/a.md", content: "alpha\n" });

    assert.equal(second.json["stop_reason"], "end_turn");
    assert.deepEqual((second.json["content"] as Record<string, unknown>[])[0], {
      type: "text",
      text: "wrote it",
    });
    assert.equal(provider.requestCount, 2);
    assert.deepEqual(provider.requests, [
      { stream: false, messages: [] },
      { stream: false, messages: [1] },
    ]);
  });

  it("reports usage when configured to", async () => {
    const provider = track(await startScriptedProvider(STEPS));
    const served = await post(provider, { stream: false });
    assert.deepEqual(served.json["usage"], { input_tokens: 11, output_tokens: 7 });
  });

  it("omits the usage key entirely under usage: absent — never a fabricated zero", async () => {
    const provider = track(await startScriptedProvider(STEPS, { usage: "absent" }));
    const served = await post(provider, { stream: false });
    assert.equal("usage" in served.json, false);
  });

  it("fails loudly when the script is exhausted instead of repeating a step", async () => {
    const provider = track(await startScriptedProvider(STEPS.slice(0, 1)));
    await post(provider, { stream: false });
    const extra = await post(provider, { stream: false });

    assert.equal(extra.status, 400);
    assert.equal(provider.scriptExhausted, true);
    // The refusal is the point: a repeated step would fake a capability.
    const error = extra.json["error"] as Record<string, unknown>;
    assert.match(String(error["message"]), /no step remains/);
  });

  it("refuses an unrouted path without consuming a step", async () => {
    const provider = track(await startScriptedProvider(STEPS));
    const missed = await fetch(`${provider.baseUrl}/v1/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(missed.status, 404);
    assert.equal(provider.requestCount, 0);
  });

  it("stops once, closes the socket, and rejects a double stop", async () => {
    const provider = await startScriptedProvider(STEPS);
    await provider.stop();
    await assert.rejects(() => provider.stop(), ProviderFailure);
    await assert.rejects(
      () => fetch(`${provider.baseUrl}/v1/messages`, { method: "POST", body: "{}" })
    );
  });
});

describe("assertScriptConsumed — external proof of the dispatch count", () => {
  it("passes when every declared step was called", async () => {
    const provider = track(await startScriptedProvider(STEPS));
    await post(provider, {});
    await post(provider, {});
    assert.doesNotThrow(() => assertScriptConsumed(provider, STEPS));
  });

  it("throws a typed provider failure when a declared step never dispatched", async () => {
    const provider = track(await startScriptedProvider(STEPS));
    await post(provider, {});
    assert.throws(
      () => assertScriptConsumed(provider, STEPS, "attempt-1"),
      (error: unknown) => {
        const failure = error as InstanceType<typeof ProviderFailure>;
        return (
          failure instanceof ProviderFailure &&
          failure.kind === "provider-failure" &&
          failure.attemptId === "attempt-1" &&
          /served 1 of 2/.test(failure.diagnostic)
        );
      }
    );
  });
});
