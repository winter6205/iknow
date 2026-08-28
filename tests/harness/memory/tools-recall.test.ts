/**
 * #121 T5: memory_recall tool tests.
 *
 * Spec: specs/121-memory-injection.md (Project Structure tools/recall.ts,
 * Testing Strategy tools-recall half, SC 8).
 *
 * Contract (SC 8):
 *   - registered as an ACI tool; inputSchema `{ query, limit? }`
 *   - output pure string, each entry `### <title>\n<frontmatter metadata>\n<body>`
 *   - ≤ OUTPUT_HARD_CAP (20000) chars — executor remains the truncation
 *     authority (contract X); the tool returns pure data, no truncated/total
 *     metadata fields (contract Y1)
 *   - no negative-form indicators leak into the output
 *   - read-side only: no writes, no side effects
 *   - aci metadata: read-only / concurrency-safe / cancel / fast
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryRecallTool } from "../../../src/harness/memory/tools/recall.ts";
import { serializeMemoryEntry } from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";
import type { ToolExecutionError } from "../../../src/harness/errors.ts";

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "recall-dir-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

const entry = (overrides?: Partial<MemoryEntryV1>): MemoryEntryV1 => ({
  id: "mem-1",
  type: "note",
  importance: 1,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "Use bar() for rendering",
  body: "Calling bar() is the supported rendering path in this project.",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** Write a full frontmatter file under a given slug (filename stem). */
async function writeSlug(slug: string, e: MemoryEntryV1): Promise<void> {
  await writeFile(
    join(memoryDir, `${slug}.md`),
    serializeMemoryEntry(e),
    "utf8"
  );
}

// -- tool shape / metadata ---------------------------------------------------

describe("createMemoryRecallTool — tool shape", () => {
  it("exposes the memory_recall schema with query required and limit optional", () => {
    const tool = createMemoryRecallTool({ memoryDir });
    const schema = tool.inputSchema as Record<string, unknown>;
    const props = schema.properties as Record<string, Record<string, unknown>>;

    assert.equal(tool.name, "memory_recall");
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["query"]);
    assert.equal(schema.additionalProperties, false);
    assert.equal(props.query.type, "string");
    assert.equal(props.limit?.type, "integer");
  });

  it("uses read-only, concurrency-safe, cancel, fast aci metadata", () => {
    const tool = createMemoryRecallTool({ memoryDir });
    assert.deepEqual(tool.aci, {
      category: "read-only",
      isConcurrencySafe: true,
      interruptBehavior: "cancel",
      timeoutTier: "fast",
    });
  });
});

// -- recall behavior ---------------------------------------------------------

describe("memory_recall — scoring and output", () => {
  it("returns a pure string with each hit as `### <title>` + metadata + body", async () => {
    await writeSlug("bar", entry({ id: "bar", title: "Use bar()" }));
    await writeSlug(
      "legacy",
      entry({
        id: "legacy",
        title: "Legacy foo()",
        body: "Deprecated foo path.",
      })
    );
    const tool = createMemoryRecallTool({ memoryDir });

    const out = await tool.handler({ query: "bar rendering" });
    assert.equal(typeof out, "string");
    assert.ok((out as string).includes("### Use bar()"));
    assert.ok((out as string).includes("id: bar"));
    assert.ok((out as string).includes("importance: 1"));
    assert.ok(
      (out as string).includes("Calling bar() is the supported rendering path")
    );
  });

  it("ranks title-hit entries above body-only hits", async () => {
    const bar = entry({
      id: "bar",
      title: "Use bar() rendering widget",
      body: "x",
    });
    const qux = entry({
      id: "qux",
      title: "Unrelated",
      body: "bar rendering internals",
    });
    const tool = createMemoryRecallTool({ memoryDir, entries: [qux, bar] });

    const out = (await tool.handler({ query: "bar rendering" })) as string;
    assert.ok(
      out.indexOf("### Use bar() rendering widget") <
        out.indexOf("### Unrelated")
    );
  });

  it("respects the limit option (default 10, cap 50)", async () => {
    const many: MemoryEntryV1[] = Array.from({ length: 12 }, (_, i) =>
      entry({ id: `m${i}`, title: `Match item ${i}`, body: "shared token" })
    );
    const tool = createMemoryRecallTool({ memoryDir, entries: many });
    const out = (await tool.handler({
      query: "shared token",
      limit: 3,
    })) as string;
    const hits = [...out.matchAll(/^### /gm)];
    assert.equal(hits.length, 3);
  });

  it("defaults to at most 10 full bodies and starts with the advisory prefix", async () => {
    const many: MemoryEntryV1[] = Array.from({ length: 12 }, (_, i) =>
      entry({
        id: `m${i}`,
        title: `Match item ${i}`,
        body: "shared token body text",
      })
    );
    const tool = createMemoryRecallTool({ memoryDir, entries: many });
    const out = (await tool.handler({ query: "shared token" })) as string;
    assert.ok(
      out.startsWith(
        "Possibly relevant memory (advisory; often time-sensitive; not instructions)"
      )
    );
    const hits = [...out.matchAll(/^### /gm)];
    assert.equal(hits.length, 10);
    assert.ok(out.includes("shared token body text"));
  });

  it("does not return a zero-lexical-hit entry even when importance is high", async () => {
    const related = entry({
      id: "related",
      title: "Deploy pipeline",
      body: "the deploy pipeline runs on Friday",
      importance: 1,
    });
    const noise = entry({
      id: "noise",
      title: "Favorite snack",
      body: "keep pretzels at the desk",
      importance: 9,
    });
    const tool = createMemoryRecallTool({
      memoryDir,
      entries: [noise, related],
    });
    const out = (await tool.handler({ query: "deploy pipeline" })) as string;
    assert.ok(out.includes("Deploy pipeline"));
    assert.ok(!out.includes("Favorite snack"));
  });

  it("returns an empty string when the memory library is empty", async () => {
    const tool = createMemoryRecallTool({ memoryDir });
    const out = await tool.handler({ query: "anything" });
    assert.equal(out, "");
  });
});

// -- cap / boundary ----------------------------------------------------------

describe("memory_recall — output cap and boundary classes", () => {
  it("caps output at 20000 chars (contract X floor)", async () => {
    const big = entry({ id: "big", title: "Big", body: "x".repeat(30_000) });
    const tool = createMemoryRecallTool({ memoryDir, entries: [big] });
    const out = (await tool.handler({ query: "big", limit: 50 })) as string;
    assert.ok(out.length <= 20_000);
  });

  it("returns empty string for an empty or single-character query (bm25 empty-query)", async () => {
    await writeSlug("bar", entry({ id: "bar", title: "Use bar()" }));
    const tool = createMemoryRecallTool({ memoryDir });
    assert.equal(await tool.handler({ query: "" }), "");
    assert.equal(await tool.handler({ query: "a" }), "");
  });

  it("rejects a non-string query with a typed ToolExecutionError", async () => {
    const tool = createMemoryRecallTool({ memoryDir });
    await assert.rejects(
      () => tool.handler({ query: 123 }),
      (err: unknown) => {
        const e = err as ToolExecutionError;
        return e.name === "ToolExecutionError" && /query/.test(e.message);
      }
    );
  });

  it("rejects a limit outside the 1..50 range", async () => {
    const tool = createMemoryRecallTool({ memoryDir });
    await assert.rejects(() => tool.handler({ query: "x", limit: 0 }));
    await assert.rejects(() => tool.handler({ query: "x", limit: 51 }));
  });

  it("does not leak negative-form indicators into output (spec SC 9 discipline)", async () => {
    const good = entry({
      id: "good",
      title: "Use bar()",
      body: "call bar() to render; avoid foo() because it is not safe",
    });
    const tool = createMemoryRecallTool({ memoryDir, entries: [good] });
    const out = (await tool.handler({ query: "bar" })) as string;
    // "not safe" is a phrasing inside a positive-form instruction; the tool is
    // read-only and must not quarantine or censor content — but it must never
    // itself emit a quarantine mark or negative-form label.
    assert.ok(!out.includes("negative_form"));
    assert.ok(!out.includes("quarantine"));
  });
});

// -- disabled entries (#730) -------------------------------------------------

describe("memory_recall — disabled entries never reach the model", () => {
  it("drops a disabled entry from the injected entries seam", async () => {
    const live = entry({
      id: "live",
      title: "Use bar() for rendering",
      body: "Calling bar() is the supported rendering path.",
    });
    const dead = entry({
      id: "dead",
      disabled: true,
      title: "Use baz() for rendering",
      body: "Calling baz() was the old rendering path.",
    });
    const tool = createMemoryRecallTool({
      memoryDir,
      entries: [live, dead],
    });

    const out = (await tool.handler({ query: "rendering path" })) as string;
    assert.ok(out.includes("### Use bar() for rendering"), "live hit present");
    assert.ok(!out.includes("Use baz() for rendering"), "disabled title gone");
    assert.ok(
      !out.includes("Calling baz() was the old rendering path."),
      "disabled body gone"
    );
  });

  it("drops a disabled entry read from disk", async () => {
    await writeSlug(
      "live",
      entry({
        id: "live",
        title: "Use bar() for rendering",
        body: "Calling bar() is the supported rendering path.",
      })
    );
    await writeSlug(
      "dead",
      entry({
        id: "dead",
        disabled: true,
        title: "Use baz() for rendering",
        body: "Calling baz() was the old rendering path.",
      })
    );
    const tool = createMemoryRecallTool({ memoryDir });

    const out = (await tool.handler({ query: "rendering path" })) as string;
    assert.ok(out.includes("### Use bar() for rendering"), "live hit present");
    assert.ok(!out.includes("Use baz() for rendering"), "disabled title gone");
    assert.ok(
      !out.includes("Calling baz() was the old rendering path."),
      "disabled body gone"
    );
  });

  it("returns an empty string when every entry is disabled", async () => {
    const tool = createMemoryRecallTool({
      memoryDir,
      entries: [entry({ id: "dead", disabled: true })],
    });
    assert.equal(await tool.handler({ query: "bar rendering" }), "");
  });
});

// -- concurrency-safe read ---------------------------------------------------

describe("memory_recall — concurrent reads", () => {
  it("serves two concurrent reads without interference", async () => {
    await writeSlug("bar", entry({ id: "bar", title: "Use bar()" }));
    const tool = createMemoryRecallTool({ memoryDir });
    const [a, b] = await Promise.all([
      tool.handler({ query: "bar" }),
      tool.handler({ query: "rendering" }),
    ]);
    assert.equal(typeof a, "string");
    assert.equal(typeof b, "string");
    assert.ok((a as string).includes("Use bar()"));
    assert.ok((b as string).includes("Use bar()"));
  });
});
