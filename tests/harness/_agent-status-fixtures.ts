/**
 * Shared agent-status test fixtures.
 *
 * Not collected by vitest on purpose (no `.test.ts` suffix) — mirrors the
 * `tests/cli/_fixtures.ts` convention: the spy-adapter pattern that records
 * per-step `state.messages` is kept in ONE place so the bar suite and the
 * stream-event suite cannot fork.
 *
 * Used by:
 *   - tests/harness/agent-status-bar.test.ts (bar append contract)
 *   - tests/harness/agent-status-stream.test.ts (agent_status stream event)
 */
import { afterAll } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LoopAdapter } from "../../src/harness/loop-engine.ts";
import { PromptTooLongError } from "../../src/harness/errors.ts";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../src/harness/model-adapter/types.ts";
import type { ToolExecutionResult } from "../../src/harness/tools/types.ts";
import { createStubTool } from "../../src/harness/stubs/stub-tool.ts";
import { assistantResult } from "../cli/_fixtures.ts";

// -- tmp todoDir lifecycle -----------------------------------------------------

/**
 * A per-case todoDir (under tmpdir); omitting initialContent = no todos.md.
 * Dirs are registered by this module and cleaned up in afterAll (the hook is
 * registered once per importing test file).
 */
const tempDirs: string[] = [];

export async function makeTodoDir(initialContent?: string): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "iknow-agent-status-"));
  tempDirs.push(tmp);
  if (initialContent !== undefined) {
    await writeFile(join(tmp, "todos.md"), initialContent, "utf8");
  }
  return tmp;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// -- spy adapter ----------------------------------------------------------------

export type StepAction =
  | { readonly kind: "reply"; readonly result: AssistantTurnResult }
  | { readonly kind: "promptTooLong" };

/**
 * Extension seam: a callback at the entry of every (tools-bearing) model call
 * (after the captured record, before the script is consumed). Return values are
 * recorded in `entrySamples` in call order (the stream-event suite samples "how
 * many agent_status events had arrived at call entry"; the bar suite passes no
 * hooks → always empty).
 */
export interface SpyAdapterHooks<TSample = unknown> {
  readonly sampleAtEntry?: () => TSample;
}

/**
 * Spy adapter: captures the state.messages seen by each (tools-bearing) model
 * call and replays reply / PromptTooLongError from the script. Calls without
 * tools (compact-summary / wrap-up-summary rounds) return empty text, consume
 * no script step and record nothing in captured (bars / events only attach to
 * main-loop model calls).
 */
export function makeSpyAdapter<TSample = unknown>(
  actions: ReadonlyArray<StepAction>,
  hooks?: SpyAdapterHooks<TSample>
): {
  readonly adapter: LoopAdapter;
  /** Messages seen by each tools-bearing model call (in call order). */
  readonly captured: ReadonlyArray<ReadonlyArray<AnthropicNativeMessage>>;
  /** request.system seen by each tools-bearing model call (absent = undefined; guards "injection never enters system"). */
  readonly systemsCaptured: ReadonlyArray<string | undefined>;
  /** Return values of hooks.sampleAtEntry in call order; no hooks → always empty array. */
  readonly entrySamples: ReadonlyArray<TSample>;
} {
  const captured: ReadonlyArray<AnthropicNativeMessage>[] = [];
  const systemsCaptured: (string | undefined)[] = [];
  const entrySamples: TSample[] = [];
  let next = 0;
  const adapter: LoopAdapter = Object.freeze({
    encodeUserText: (t: string): AnthropicNativeMessage => ({
      role: "user",
      content: [{ type: "text", text: t }],
    }),
    encodeToolResults: (
      results: ReadonlyArray<ToolExecutionResult>
    ): AnthropicContentBlock[] =>
      results.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        is_error: r.kind !== "ok",
        content: [
          {
            type: "text" as const,
            text:
              r.kind === "ok"
                ? JSON.stringify(r.payload ?? [])
                : `[${r.kind}] ${"message" in r ? r.message : ""}`,
          },
        ],
      })),
    step: async (
      state: { readonly messages: ReadonlyArray<AnthropicNativeMessage> },
      request: { readonly tools?: unknown; readonly system?: string }
    ): Promise<AssistantTurnResult> => {
      if (request.tools === undefined) {
        return assistantResult({
          texts: [],
          toolCalls: [],
          supplierStop: "success",
        });
      }
      captured.push(state.messages);
      systemsCaptured.push(request.system);
      if (hooks?.sampleAtEntry !== undefined) {
        entrySamples.push(hooks.sampleAtEntry());
      }
      const action = actions[next];
      next += 1;
      if (action === undefined) {
        throw new Error("spy adapter: action script exhausted");
      }
      if (action.kind === "promptTooLong") {
        throw new PromptTooLongError("synthetic 400 prompt-too-long");
      }
      return action.result;
    },
  });
  return { adapter, captured, systemsCaptured, entrySamples };
}

// -- tools ----------------------------------------------------------------------

export function okEchoTool(name = "echo"): ReturnType<typeof createStubTool> {
  return createStubTool({
    name,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    next: (input: unknown) => input,
  });
}

// -- bar text extraction / parsing ------------------------------------------------

export function isBarBlock(
  b: AnthropicContentBlock
): b is { type: "text"; text: string } {
  return b.type === "text" && b.text.startsWith("<agent_status>");
}

/** Collect all bar texts in messages (in appearance order). */
export function barTexts(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) {
      if (isBarBlock(b)) out.push(b.text);
    }
  }
  return out;
}

export interface ParsedBar {
  readonly lastTool: string;
  readonly todoLines: string[];
}

export function parseBar(text: string): ParsedBar {
  const lines = text.split("\n");
  assert.equal(lines[0], "<agent_status>");
  assert.equal(lines[lines.length - 1], "</agent_status>");
  const body = lines.slice(1, -1);
  const lastToolLine = body.find((l) => l.startsWith("last_tool: "));
  assert.ok(lastToolLine !== undefined, `bar missing last_tool line: ${text}`);
  const todoHeaderIndex = body.findIndex((l) => l === "todos:");
  const todoLines = todoHeaderIndex >= 0 ? body.slice(todoHeaderIndex + 1) : [];
  return { lastTool: lastToolLine.slice("last_tool: ".length), todoLines };
}
