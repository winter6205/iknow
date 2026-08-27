/**
 * auto-memory T3: ingest.ts tests (extract → ops → persist).
 *
 * Spec: specs/auto-memory.md D2/D4; ADR-0031 Decision 2/3/5. The four ops
 * (ADD / UPDATE / SUPERSEDE / NOOP) must be observable from a transcript
 * slice plus a fake LLM; persisted entries carry `source: auto`; negative-form
 * and low-confidence candidates never reach disk.
 *
 * Five boundary classes (ACR defensive-contract-validator):
 *   empty      — no candidates / empty transcript → nothing written
 *   negative   — negative-form phrasing rejected before any disk mutation
 *   overflow   — oversized candidate batch is capped, not written unbounded
 *   concurrent — ingest racing memory_save leaves no half-written entry
 *   exception  — LLM throw / unparseable output → typed MemoryExtractError
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MemoryExtractError,
  buildExtractPrompt,
  decideMemoryOps,
  extractMemoryCandidates,
  ingestMemory,
  parseMemoryEntry,
  persistMemoryOps,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type {
  MemoryCandidate,
  MemoryEntryV1,
  MemoryExtractLlm,
} from "../../../src/harness/memory/index.ts";
import { createMemorySaveTool } from "../../../src/harness/memory/tools/save.ts";

// -- fixtures ----------------------------------------------------------------

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "memory-ingest-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

const NOW_ISO = "2026-08-26T00:00:00.000Z";

/** Deterministic slug source so assertions can name the written file. */
const seqBytes = (): ((n: number) => Buffer) => {
  let i = 0;
  return (n: number) => Buffer.alloc(n, ++i);
};

const llmReturning = (raw: string): MemoryExtractLlm => ({
  complete: async () => raw,
});

const candidate = (o?: Partial<MemoryCandidate>): MemoryCandidate => ({
  title: "Use bar() for concurrency",
  body: "bar() is the thread-safe entry point in this repo.",
  type: "note",
  importance: 2,
  ...o,
});

const entry = (o?: Partial<MemoryEntryV1>): MemoryEntryV1 => ({
  id: "mem-1",
  type: "note",
  importance: 1,
  ttl_days: 0,
  disabled: false,
  supersedes: null,
  title: "Use bar() for concurrency",
  body: "bar() is the thread-safe entry point in this repo.",
  updated_at: "2026-08-01T00:00:00.000Z",
  ...o,
});

const put = async (slug: string, o?: Partial<MemoryEntryV1>): Promise<void> => {
  await writeFile(
    join(memoryDir, `${slug}.md`),
    serializeMemoryEntry(entry({ id: slug, ...o })),
    "utf8"
  );
};

const readSlug = async (slug: string): Promise<MemoryEntryV1> =>
  parseMemoryEntry(await readFile(join(memoryDir, `${slug}.md`), "utf8"));

const slugsOnDisk = async (): Promise<string[]> =>
  (await readdir(memoryDir))
    .filter((n) => n.endsWith(".md") && n !== "MEMORY.md")
    .map((n) => n.slice(0, -3))
    .sort();

const TRANSCRIPT = [
  "user: which entry point is safe to call from two threads?",
  "assistant: bar() is the thread-safe entry point in this repo.",
].join("\n");

// -- buildExtractPrompt ------------------------------------------------------

describe("buildExtractPrompt", () => {
  it("embeds the transcript slice and asks for a JSON array", () => {
    const prompt = buildExtractPrompt(TRANSCRIPT);
    assert.ok(prompt.includes(TRANSCRIPT), "transcript must reach the model");
    assert.ok(/json/i.test(prompt), "output contract must be stated");
  });

  it("states the affirmative-phrasing rule so the model does not fight the gate", () => {
    assert.ok(/affirmative/i.test(buildExtractPrompt(TRANSCRIPT)));
  });
});

// -- extractMemoryCandidates -------------------------------------------------

describe("extractMemoryCandidates", () => {
  it("parses a JSON array of candidates", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Use bar()",
          body: "bar() is thread-safe.",
          type: "convention",
          importance: 3,
          confidence: 0.9,
        },
      ])
    );
    const out = await extractMemoryCandidates(TRANSCRIPT, llm);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.title, "Use bar()");
    assert.equal(out[0]!.type, "convention");
    assert.equal(out[0]!.importance, 3);
  });

  it("tolerates a fenced ```json block", async () => {
    const llm = llmReturning(
      '```json\n[{"title":"T","body":"B","confidence":0.9}]\n```'
    );
    const out = await extractMemoryCandidates(TRANSCRIPT, llm);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.type, "note", "type defaults to note");
    assert.equal(out[0]!.importance, 1, "importance defaults to 1");
  });

  // empty boundary
  it("returns [] for an empty JSON array", async () => {
    assert.deepEqual(
      await extractMemoryCandidates(TRANSCRIPT, llmReturning("[]")),
      []
    );
  });

  it("returns [] without calling the model for a blank transcript", async () => {
    let calls = 0;
    const llm: MemoryExtractLlm = {
      complete: async () => {
        calls++;
        return "[]";
      },
    };
    assert.deepEqual(await extractMemoryCandidates("   ", llm), []);
    assert.equal(calls, 0, "a blank transcript must not spend an LLM call");
  });

  // negative boundary
  it("drops a negative-form candidate before it can be persisted", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Never call foo()",
          body: "foo() is unsafe.",
          confidence: 0.99,
        },
        { title: "Use bar()", body: "bar() is thread-safe.", confidence: 0.99 },
      ])
    );
    const out = await extractMemoryCandidates(TRANSCRIPT, llm);
    assert.deepEqual(
      out.map((c) => c.title),
      ["Use bar()"]
    );
  });

  it("drops a low-confidence candidate", async () => {
    const llm = llmReturning(
      JSON.stringify([
        { title: "Maybe", body: "Unsure about this.", confidence: 0.1 },
      ])
    );
    assert.deepEqual(await extractMemoryCandidates(TRANSCRIPT, llm), []);
  });

  it("drops a candidate with a missing or empty title/body", async () => {
    const llm = llmReturning(
      JSON.stringify([
        { title: "", body: "orphan body", confidence: 0.9 },
        { title: "orphan title", body: "", confidence: 0.9 },
        { body: "no title at all", confidence: 0.9 },
      ])
    );
    assert.deepEqual(await extractMemoryCandidates(TRANSCRIPT, llm), []);
  });

  it("clamps importance into 1..5", async () => {
    const llm = llmReturning(
      JSON.stringify([
        { title: "A", body: "aa", importance: 99, confidence: 0.9 },
        { title: "B", body: "bb", importance: -4, confidence: 0.9 },
      ])
    );
    const out = await extractMemoryCandidates(TRANSCRIPT, llm);
    assert.deepEqual(
      out.map((c) => c.importance),
      [5, 1]
    );
  });

  // overflow boundary
  it("caps an oversized candidate batch", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      title: `Fact ${i}`,
      body: `Body number ${i} of the batch.`,
      confidence: 0.9,
    }));
    const out = await extractMemoryCandidates(
      TRANSCRIPT,
      llmReturning(JSON.stringify(many))
    );
    assert.ok(
      out.length > 0 && out.length <= 8,
      `expected a capped batch, got ${out.length}`
    );
  });

  // exception boundary
  it("wraps unparseable model output in a typed MemoryExtractError", async () => {
    await assert.rejects(
      () =>
        extractMemoryCandidates(
          TRANSCRIPT,
          llmReturning("I think maybe nothing?")
        ),
      (e: unknown) => e instanceof MemoryExtractError
    );
  });

  it("wraps an LLM transport failure in a typed MemoryExtractError", async () => {
    const llm: MemoryExtractLlm = {
      complete: async () => {
        throw new Error("socket hang up");
      },
    };
    await assert.rejects(
      () => extractMemoryCandidates(TRANSCRIPT, llm),
      (e: unknown) => e instanceof MemoryExtractError
    );
  });
});

// -- decideMemoryOps ---------------------------------------------------------

describe("decideMemoryOps", () => {
  it("ADDs when the store is empty", () => {
    const ops = decideMemoryOps([candidate()], []);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.kind, "ADD");
  });

  it("ADDs when no neighbor is near the candidate", () => {
    const ops = decideMemoryOps(
      [
        candidate({
          title: "Release cadence",
          body: "Releases ship every Tuesday.",
        }),
      ],
      [{ slug: "old", entry: entry() }]
    );
    assert.equal(ops[0]!.kind, "ADD");
  });

  it("NOOPs an exact restatement of an existing entry", () => {
    const ops = decideMemoryOps(
      [candidate()],
      [{ slug: "old", entry: entry() }]
    );
    assert.equal(ops[0]!.kind, "NOOP");
    assert.equal(ops[0]!.kind === "NOOP" ? ops[0]!.slug : "", "old");
  });

  it("UPDATEs the neighbor when the candidate adds detail on the same subject", () => {
    const ops = decideMemoryOps(
      [
        candidate({
          body: "bar() is the thread-safe entry point in this repo, and it retries once on contention.",
        }),
      ],
      [{ slug: "old", entry: entry() }]
    );
    assert.equal(ops[0]!.kind, "UPDATE");
    assert.equal(ops[0]!.kind === "UPDATE" ? ops[0]!.slug : "", "old");
  });

  it("SUPERSEDEs when the same subject carries a materially different body", () => {
    const ops = decideMemoryOps(
      [
        candidate({
          body: "Concurrency now routes through the scheduler queue; direct calls were removed in v3.",
        }),
      ],
      [{ slug: "old", entry: entry() }]
    );
    assert.equal(ops[0]!.kind, "SUPERSEDE");
    assert.equal(ops[0]!.kind === "SUPERSEDE" ? ops[0]!.supersedes : "", "old");
  });

  it("ignores disabled entries when picking a neighbor", () => {
    const ops = decideMemoryOps(
      [candidate()],
      [{ slug: "old", entry: entry({ disabled: true }) }]
    );
    assert.equal(
      ops[0]!.kind,
      "ADD",
      "a disabled entry is not a live neighbor"
    );
  });

  it("returns [] for no candidates", () => {
    assert.deepEqual(
      decideMemoryOps([], [{ slug: "old", entry: entry() }]),
      []
    );
  });

  it("is pure — deciding twice yields the same verdicts", () => {
    const existing = [{ slug: "old", entry: entry() }];
    const first = decideMemoryOps([candidate()], existing);
    const second = decideMemoryOps([candidate()], existing);
    assert.deepEqual(first, second);
  });
});

// -- persistMemoryOps --------------------------------------------------------

describe("persistMemoryOps", () => {
  it("writes an ADD as a new slug carrying source: auto", async () => {
    const written = await persistMemoryOps(
      memoryDir,
      [{ kind: "ADD", candidate: candidate() }],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.equal(written.length, 1);
    const stored = await readSlug(written[0]!.slug);
    assert.equal(
      (stored as unknown as Record<string, unknown>)["source"],
      "auto",
      "provenance must land on disk"
    );
    assert.equal(stored.title, "Use bar() for concurrency");
    assert.equal(stored.updated_at, NOW_ISO);
  });

  it("rewrites the neighbor slug in place on UPDATE and bumps updated_at", async () => {
    await put("old");
    await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "UPDATE",
          slug: "old",
          candidate: candidate({
            body: "bar() is thread-safe and retries once.",
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.deepEqual(
      await slugsOnDisk(),
      ["old"],
      "UPDATE must not fork a new slug"
    );
    const stored = await readSlug("old");
    assert.equal(stored.body.trim(), "bar() is thread-safe and retries once.");
    assert.equal(stored.updated_at, NOW_ISO);
  });

  it("writes a new slug with a supersedes pointer on SUPERSEDE", async () => {
    await put("old");
    const written = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "SUPERSEDE",
          supersedes: "old",
          candidate: candidate({
            body: "Concurrency routes through the scheduler queue.",
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    const fresh = await readSlug(written[0]!.slug);
    assert.equal(fresh.supersedes, "old");
    assert.equal(
      (fresh as unknown as Record<string, unknown>)["source"],
      "auto"
    );
    const old = await readSlug("old");
    assert.equal(
      old.disabled,
      false,
      "persist soft-disables nothing; GC owns that"
    );
  });

  it("writes nothing for a NOOP", async () => {
    await put("old");
    const before = await readFile(join(memoryDir, "old.md"), "utf8");
    const written = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "NOOP",
          slug: "old",
          candidate: candidate(),
          reason: "restatement",
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.deepEqual(written, []);
    assert.equal(await readFile(join(memoryDir, "old.md"), "utf8"), before);
  });

  // negative boundary — the gate is enforced at the write path too, not only
  // at extract, so a hand-built op cannot smuggle a prohibition onto disk.
  it("rejects a negative-form candidate before any disk mutation", async () => {
    await assert.rejects(
      () =>
        persistMemoryOps(
          memoryDir,
          [
            {
              kind: "ADD",
              candidate: candidate({ body: "Never call foo() here." }),
            },
          ],
          { now: () => NOW_ISO, randomBytes: seqBytes() }
        ),
      (e: unknown) => /negative_form/.test((e as Error).message)
    );
    assert.deepEqual(await slugsOnDisk(), []);
  });

  it("appends the new entry to the MEMORY.md index", async () => {
    const written = await persistMemoryOps(
      memoryDir,
      [{ kind: "ADD", candidate: candidate() }],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    const index = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
    assert.ok(index.includes(`${written[0]!.slug}.md`), index);
  });
});

// -- ingestMemory ------------------------------------------------------------

describe("ingestMemory", () => {
  it("turns a transcript into a source: auto entry end to end", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "bar() is the thread-safe entry point in this repo.",
          importance: 3,
          confidence: 0.95,
        },
      ])
    );
    const result = await ingestMemory({
      memoryDir,
      transcript: TRANSCRIPT,
      llm,
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.deepEqual(
      result.ops.map((o) => o.kind),
      ["ADD"]
    );
    const slugs = await slugsOnDisk();
    assert.equal(slugs.length, 1);
    const stored = await readSlug(slugs[0]!);
    assert.equal(
      (stored as unknown as Record<string, unknown>)["source"],
      "auto"
    );
    assert.equal(stored.importance, 3);
  });

  it("reports NOOP and writes nothing when the fact is already stored", async () => {
    await put("old");
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "bar() is the thread-safe entry point in this repo.",
          confidence: 0.95,
        },
      ])
    );
    const result = await ingestMemory({
      memoryDir,
      transcript: TRANSCRIPT,
      llm,
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.deepEqual(
      result.ops.map((o) => o.kind),
      ["NOOP"]
    );
    assert.deepEqual(await slugsOnDisk(), ["old"]);
  });

  it("soft-disables the superseded entry by running GC after the write", async () => {
    await put("old");
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "Concurrency now routes through the scheduler queue; direct calls were removed.",
          confidence: 0.95,
        },
      ])
    );
    const result = await ingestMemory({
      memoryDir,
      transcript: TRANSCRIPT,
      llm,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
      randomBytes: seqBytes(),
    });
    assert.deepEqual(
      result.ops.map((o) => o.kind),
      ["SUPERSEDE"]
    );
    assert.equal((await readSlug("old")).disabled, true);
  });

  // empty boundary
  it("writes nothing when the model finds no memorable fact", async () => {
    const result = await ingestMemory({
      memoryDir,
      transcript: TRANSCRIPT,
      llm: llmReturning("[]"),
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.deepEqual(result.ops, []);
    assert.deepEqual(await slugsOnDisk(), []);
  });

  // exception boundary
  it("propagates a typed MemoryExtractError so the host can decide", async () => {
    const llm: MemoryExtractLlm = {
      complete: async () => {
        throw new Error("model unavailable");
      },
    };
    await assert.rejects(
      () =>
        ingestMemory({
          memoryDir,
          transcript: TRANSCRIPT,
          llm,
          now: () => NOW_ISO,
          randomBytes: seqBytes(),
        }),
      (e: unknown) => e instanceof MemoryExtractError
    );
    assert.deepEqual(
      await slugsOnDisk(),
      [],
      "a failed extract writes nothing"
    );
  });

  // concurrent boundary
  it("does not half-write when a memory_save lands during ingest", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "bar() is the thread-safe entry point in this repo.",
          confidence: 0.95,
        },
      ])
    );
    // Distinct slug source per writer: the point of this test is a real
    // two-writer race, not a slug collision between two identical fakes.
    const save = createMemorySaveTool({
      memoryDir,
      now: () => NOW_ISO,
      randomBytes: () => Buffer.from("aabbccddeeff", "hex"),
    });
    await Promise.all([
      ingestMemory({
        memoryDir,
        transcript: TRANSCRIPT,
        llm,
        now: () => NOW_ISO,
        randomBytes: seqBytes(),
      }),
      save.handler({
        title: "Release cadence",
        body: "Releases ship every Tuesday.",
      }),
    ]);
    const slugs = await slugsOnDisk();
    assert.equal(slugs.length, 2, "both writers must land their entry");
    for (const slug of slugs) {
      parseMemoryEntry(await readFile(join(memoryDir, `${slug}.md`), "utf8"));
    }
    assert.ok(
      (await readdir(memoryDir)).every((n) => !n.endsWith(".tmp")),
      "no tmp files left behind"
    );
  });
});
