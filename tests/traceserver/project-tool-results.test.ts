import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import {
  projectToolResults,
  projectToolResultsFromTrace,
} from "../../src/traceserver/project-tool-results.ts";

const toolUse = (id: string, name: string) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
});

const toolResult = (
  tool_use_id: string,
  content: unknown,
  is_error?: boolean
) => ({
  role: "user",
  content: [
    {
      type: "tool_result",
      tool_use_id,
      content,
      ...(is_error === undefined ? {} : { is_error }),
    },
  ],
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0))
    rmSync(directory, { recursive: true });
});

describe("projectToolResults", () => {
  it("projects paired tool results with the assistant tool name", () => {
    const messages = [
      toolUse("toolu-1", "bash"),
      toolResult("toolu-1", [{ type: "text", text: "created file" }]),
      toolResult("toolu-1", " and checked it", true),
    ];

    assert.deepEqual(projectToolResults(messages), [
      {
        tool_use_id: "toolu-1",
        name: "bash",
        is_error: true,
        chars: 27,
        preview: "created file and checked it",
      },
    ]);
  });

  it("returns an empty array when no tool result is present", () => {
    assert.deepEqual(projectToolResults([toolUse("toolu-1", "bash")]), []);
    assert.deepEqual(projectToolResults([]), []);
  });

  it("keeps previews bounded and marks long results as truncated", () => {
    const text = "x".repeat(401);
    const [result] = projectToolResults([
      toolUse("toolu-1", "bash"),
      toolResult("toolu-1", text),
    ]);

    assert.equal(result?.chars, 401);
    assert.ok(result?.preview.endsWith("...[truncated]"));
    assert.ok((result?.preview.length ?? Infinity) <= 400);
  });

  it("is deterministic when projected concurrently", async () => {
    const messages = [
      toolUse("toolu-1", "bash"),
      toolResult("toolu-1", "stable output"),
    ];

    const projections = await Promise.all(
      Array.from({ length: 2 }, () =>
        Promise.resolve(projectToolResults(messages))
      )
    );

    assert.deepEqual(projections[0], projections[1]);
  });
});

describe("projectToolResultsFromTrace", () => {
  it("projects full messages and their blob references identically", async () => {
    const fullMessages = [
      toolUse("toolu-1", "bash"),
      toolResult("toolu-1", "blob output"),
    ];
    const serialized = JSON.stringify(fullMessages[1]);
    const sha = createHash("sha256").update(serialized).digest("hex");

    const fromFull = await projectToolResultsFromTrace(fullMessages);
    const fromBlob = await projectToolResultsFromTrace(
      [fullMessages[0], { sha, bytes: Buffer.byteLength(serialized) }],
      {
        readBlob: async (requestedSha) =>
          requestedSha === sha ? serialized : "",
      }
    );

    assert.deepEqual(fromBlob, fromFull);
  });

  it("reads blob references from traceFilePath (SC7)", async () => {
    // SC7: blob 目录由 `dirname(traceFilePath)/blobs` 派生 —— 不再单独传
    // traceDir, 调用方只提供 trace 文件路径即可, 派生在 `dereferenceTraceMessages`
    // 内完成。fixture: 临时会话文件夹 + trace.jsonl + 同目录 blobs/, 验证 blob
    // 被读出且 dereferenced 输出与 fullMessages 等价。
    const sessionFolder = mkdtempSync(
      join(tmpdir(), "iknow-project-tool-results-")
    );
    tempDirs.push(sessionFolder);
    const blobDir = join(sessionFolder, "blobs");
    mkdirSync(blobDir);
    const traceFilePath = join(sessionFolder, "trace.jsonl");
    const message = toolResult("toolu-1", "on disk");
    const serialized = JSON.stringify(message);
    const sha = createHash("sha256").update(serialized).digest("hex");
    writeFileSync(join(blobDir, sha), serialized, "utf8");

    assert.deepEqual(
      await projectToolResultsFromTrace(
        [
          toolUse("toolu-1", "bash"),
          { sha, bytes: Buffer.byteLength(serialized) },
        ],
        { traceFilePath }
      ),
      [
        {
          tool_use_id: "toolu-1",
          name: "bash",
          is_error: false,
          chars: 7,
          preview: "on disk",
        },
      ]
    );
  });

  it("returns an empty projection when blob dereferencing fails", async () => {
    await assert.doesNotReject(async () => {
      const projection = await projectToolResultsFromTrace(
        [{ sha: "missing", bytes: 10 }],
        {
          readBlob: () => {
            throw new Error("missing blob");
          },
        }
      );
      assert.deepEqual(projection, []);
    });
  });
});
