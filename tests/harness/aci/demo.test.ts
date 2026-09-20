/**
 * ACI Layer 2: end-to-end tests.
 *
 * Verified end-to-end via run() + createAciExecutor:
 *   (a) read-only scenario → stopReason=completed;
 *   (b) the dangerous-command deny path yields an is_error tool_result;
 *   (c) an edit_file bad patch is rejected (file content unchanged), then a
 *       correct patch succeeds.
 *
 * Tool-layer rewrite: uses the 6-tool set (bash / read_file / glob / grep /
 * edit_file / write_file), in sync with demo.ts's assembly.
 */

import { describe, it, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { run } from "../../../src/harness/loop-engine.ts";
import { createExecutor } from "../../../src/harness/tools/executor.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";

import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
  AssistantTurnResult,
} from "../../../src/harness/model-adapter/types.ts";

import { createAciRegistry } from "../../../src/harness/aci/aci-registry.ts";
import { createAciExecutor } from "../../../src/harness/aci/aci-executor.ts";
import { createBashTool } from "../../../src/harness/aci/tools/bash.ts";
import { createReadFileTool } from "../../../src/harness/aci/tools/read-file.ts";
import { createGlobTool } from "../../../src/harness/aci/tools/glob.ts";
import { createGrepTool } from "../../../src/harness/aci/tools/grep.ts";
import { createEditFileTool } from "../../../src/harness/aci/tools/edit-file.ts";
import { createWriteFileTool } from "../../../src/harness/aci/tools/write-file.ts";

/* ── helper: build AssistantTurnResult (same shape as demo.ts) ── */

interface AssistantResultOpts {
  readonly texts: string[];
  readonly toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  readonly supplierStop?: "success" | "truncation" | "refusal" | "other";
}

function assistantResult(opts: AssistantResultOpts): AssistantTurnResult {
  const texts = opts.texts;
  const toolCalls = opts.toolCalls ?? [];
  const supplierStop = opts.supplierStop ?? "success";
  const blocks: AnthropicContentBlock[] = [];
  for (const t of texts) blocks.push({ type: "text", text: t });
  for (const c of toolCalls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
  }
  const native: AnthropicNativeMessage = { role: "assistant", content: blocks };
  return {
    nativeMessage: native,
    projection: { nativeMessage: native, texts, toolCalls },
    supplierStop,
    needsTools: toolCalls.length > 0,
    isEmptyFinalResponse:
      supplierStop === "success" &&
      texts.length === 0 &&
      toolCalls.length === 0,
  };
}

/* ── helper: assemble registry + decorated executor ── */

function assemble(scratchDir: string): {
  reg: ReturnType<typeof createAciRegistry>;
  exec: ReturnType<typeof createAciExecutor>;
} {
  const reg = createAciRegistry([
    createBashTool(scratchDir),
    createReadFileTool(scratchDir),
    createGlobTool(scratchDir),
    createGrepTool(scratchDir),
    createEditFileTool(scratchDir),
    createWriteFileTool(scratchDir),
  ]);
  const innerExec = createExecutor(reg.inner);
  const exec = createAciExecutor({ inner: innerExec, catalog: reg.catalog });
  return { reg, exec };
}

/* ── helper: find a tool_result in messages by tool_use_id ── */

function findToolResult(opts: {
  messages: ReadonlyArray<AnthropicNativeMessage>;
  toolUseId: string;
}): Extract<AnthropicContentBlock, { type: "tool_result" }> | undefined {
  for (const m of opts.messages) {
    for (const b of m.content) {
      if (b.type === "tool_result" && b.tool_use_id === opts.toolUseId) {
        return b;
      }
    }
  }
  return undefined;
}

/* ── helper: extract the first text block of a tool_result ── */

function toolResultText(
  result: Extract<AnthropicContentBlock, { type: "tool_result" }>
): string {
  return (result.content as Array<{ text?: string }>)[0]?.text ?? "";
}

/* ── scratch lifecycle ── */

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-aci-demo-test-"));
  // Base sample files (enough to cover the three assertions)
  writeFileSync(join(scratch, "alpha.ts"), "export const alpha = 1;\n");
  writeFileSync(join(scratch, "beta.ts"), "export const beta = 2;\n");
  writeFileSync(join(scratch, "edit-me.ts"), "const x = 1;\nconsole.log(x);\n");
  const bigLines = Array.from(
    { length: 250 },
    (_, i) => `line ${String(i + 1)}`
  );
  writeFileSync(join(scratch, "big-file.txt"), bigLines.join("\n"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/* ── tests ── */

describe("demo 端到端 — 经 run() + createAciExecutor", () => {
  it("(a) read-only 场景 stopReason=completed", async () => {
    // Workflow aligned with ADR-0004: glob discovery + read_file deep read
    // (stateless, explicit offset).
    const { reg, exec } = assemble(scratch);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "a-glob",
              name: "glob",
              input: { pattern: "*.ts" },
            },
            {
              id: "a-read-1",
              name: "read_file",
              // continued reads must pass an explicit offset=50 (read_file is stateless)
              input: { path: "big-file.txt", offset: 0, limit: 50 },
            },
          ],
        }),
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "a-read-2",
              name: "read_file",
              input: { path: "big-file.txt", offset: 50, limit: 50 },
            },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("test-a", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });
    assert.equal(result.stopReason, "completed");
    assert.equal(result.turnCount, 3);

    // glob returns lexicographically ordered relative paths, including alpha.ts / beta.ts / edit-me.ts
    const globResult = findToolResult({
      messages: result.messages,
      toolUseId: "a-glob",
    });
    assert.ok(globResult);
    assert.equal(globResult.is_error, undefined);
    const globText = toolResultText(globResult);
    assert.ok(globText.includes("alpha.ts"));
    assert.ok(globText.includes("beta.ts"));

    // read_file call 1: offset=0, line-number format `<n>.padStart(6)\t<line>`
    const read1 = findToolResult({
      messages: result.messages,
      toolUseId: "a-read-1",
    });
    assert.ok(read1);
    const read1Text = toolResultText(read1);
    assert.ok(
      read1Text.startsWith("     1\t"),
      "expected 1-indexed line numbers"
    );
    assert.ok(read1Text.includes("line 1"));
    assert.ok(read1Text.includes("line 50"));

    // read_file call 2: offset=50, continues context, starts at line 51
    const read2 = findToolResult({
      messages: result.messages,
      toolUseId: "a-read-2",
    });
    assert.ok(read2);
    const read2Text = toolResultText(read2);
    assert.ok(read2Text.startsWith("    51\t"));
    assert.ok(read2Text.includes("line 51"));
  });

  it("(b) 危险命令 deny -> is_error tool_result", async () => {
    const { reg, exec } = assemble(scratch);
    const model = createStubModel({
      responses: [
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "b-danger",
              name: "bash",
              input: { command: "rm -rf /" },
            },
          ],
        }),
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "b-safe",
              name: "bash",
              input: { command: "echo hello" },
            },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("test-b", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    // The deny path yields an is_error tool_result
    // The bash tool throws ToolExecutionError; the executor wraps it in an [execution_failed] envelope.
    const dangerResult = findToolResult({
      messages: result.messages,
      toolUseId: "b-danger",
    });
    assert.ok(dangerResult, "expected tool_result for b-danger");
    assert.equal(dangerResult.is_error, true);
    const dangerText = toolResultText(dangerResult);
    // v0 graduated: hard-wall fires on the dangerous pattern; reason carries
    // [hard_wall] marker (the executor wrapper attaches [permission_denied]
    // and [execution_failed] prefixes).
    assert.ok(
      dangerText.includes("[hard_wall]") ||
        dangerText.includes("not in allowlist") ||
        dangerText.includes("dangerous command"),
      `expected hard-wall or allowlist denial, got: ${dangerText}`
    );

    // Safe command succeeds (is_error unset)
    const safeResult = findToolResult({
      messages: result.messages,
      toolUseId: "b-safe",
    });
    assert.ok(safeResult);
    assert.equal(safeResult.is_error, undefined);
    const safeText = toolResultText(safeResult);
    // bash output is structured {code, stdout, stderr} (kept structured, not flattened)
    assert.ok(
      safeText.includes("hello"),
      `expected safe command output, got: ${safeText}`
    );

    assert.equal(result.stopReason, "completed");
  });

  it("(c) edit_file 坏补丁被拒（文件不变）+ 正确补丁成功", async () => {
    const { reg, exec } = assemble(scratch);
    const filePath = join(scratch, "edit-me.ts");
    const before = readFileSync(filePath, "utf8");

    const model = createStubModel({
      responses: [
        // Bad patch: unbalanced parens -> lint rejected
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "c-bad",
              name: "edit_file",
              input: {
                path: "edit-me.ts",
                old_str: "const x = 1;",
                new_str: "const x = foo(1;",
              },
            },
          ],
        }),
        // Correct patch
        assistantResult({
          texts: [],
          toolCalls: [
            {
              id: "c-good",
              name: "edit_file",
              input: {
                path: "edit-me.ts",
                old_str: "const x = 1;",
                new_str: "const x = foo(1);",
              },
            },
          ],
        }),
        assistantResult({
          texts: ["done"],
          toolCalls: [],
          supplierStop: "success",
        }),
      ],
    });
    const { result } = await run("test-c", {
      adapter: model,
      executor: exec,
      registry: reg.inner,
      maxTurns: 10,
    });

    // Bad patch rejected (is_error=true, message contains lint rejected)
    const badResult = findToolResult({
      messages: result.messages,
      toolUseId: "c-bad",
    });
    assert.ok(badResult, "expected tool_result for c-bad");
    assert.equal(badResult.is_error, true);
    const badText = toolResultText(badResult);
    assert.ok(badText.includes("lint rejected"));

    // Note: readFileSync here runs after run() completes, so the good patch
    // has already executed — there is no direct observation point before it.
    // We verify the good patch's success via its tool_result in messages,
    // then assert at the end of (c) that the final file was rewritten.
    const goodResult = findToolResult({
      messages: result.messages,
      toolUseId: "c-good",
    });
    assert.ok(goodResult, "expected tool_result for c-good");
    assert.equal(goodResult.is_error, undefined);

    // Integration regression: in the append-only messages, the good patch's
    // tool_result text carries only the output prose, never the meta JSON
    // (oldContent / newContent must not leak into the model surface).
    const goodText = toolResultText(goodResult);
    assert.ok(goodText.includes("occurrence(s)"), "output text present");
    assert.ok(!goodText.includes("oldContent"), "meta must NOT leak");
    assert.ok(!goodText.includes("newContent"), "meta must NOT leak");
    assert.ok(
      !goodText.includes("const x = 1;"),
      "old full content NOT in model"
    );

    // Final assertion: the file was rewritten by the correct patch (proving the bad patch was rejected first)
    const after = readFileSync(filePath, "utf8");
    assert.notEqual(after, before, "file should be modified by good patch");
    assert.ok(after.includes("const x = foo(1);"));
    assert.ok(!after.includes("const x = 1;\n"));

    assert.equal(result.stopReason, "completed");
  });
});
