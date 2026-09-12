/**
 * auto-memory T3: ingest.ts tests (extract → ops → persist).
 *
 * Spec: specs/auto-memory.md D2/D4; ADR-0031 Decision 2/3/5. The extraction
 * ops (ADD / UPDATE / NOOP) must be observable from a transcript slice plus
 * a fake LLM — SUPERSEDE is dream-path only, but its persist support stays
 * observable via a hand-built op. Persisted entries carry `source: auto`;
 * negative-form and low-confidence candidates never reach disk.
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
  STATIC_LAYER_OVERLAP_FLOOR,
  STATIC_LAYER_PROMPT_CAP,
  buildExtractPrompt,
  decideMemoryOps,
  dropOverlappingStaticLayer,
  extractMemoryCandidates,
  ingestMemory,
  parseMemoryEntry,
  persistMemoryOps,
  scoreMemoryEntries,
  selectPrefetchHits,
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

/** MEMORY.md lines linking the slug — the index rows a human would read. */
const indexLines = async (slug: string): Promise<string[]> =>
  (await readFile(join(memoryDir, "MEMORY.md"), "utf8"))
    .split("\n")
    .filter((line) => line.includes(`(${slug}.md)`));

/** Exactly the line the ADD path writes, so UPDATE can be seeded a stale one. */
const indexLine = (slug: string, o: Partial<MemoryEntryV1>): string => {
  const e = entry({ id: slug, ...o });
  return `- [${e.title}](${slug}.md) · importance=${e.importance} · updated_at=${e.updated_at}`;
};

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

  it("embeds the static instruction layer and the extract-discipline sentences", () => {
    const layer = "Always use bun for this project's package manager.";
    const prompt = buildExtractPrompt(TRANSCRIPT, layer);
    assert.ok(
      prompt.includes(layer),
      "static layer must reach the extract model"
    );
    assert.ok(
      prompt.includes(
        "Never output a candidate that repeats or paraphrases the project or user instruction files already loaded in every session."
      )
    );
    assert.ok(
      prompt.includes(
        "Never keep what the repository itself shows: architecture, file paths, or fixes already merged."
      )
    );
    assert.ok(
      prompt.includes(
        "Keep corrections the user made to your work, and preferences the user explicitly confirmed."
      )
    );
  });

  it("caps an oversized static layer in the extract prompt", () => {
    const huge = "abcdefghij".repeat(STATIC_LAYER_PROMPT_CAP);
    const prompt = buildExtractPrompt(TRANSCRIPT, huge);
    assert.ok(prompt.includes("[truncated"));
    assert.ok(prompt.length < huge.length);
  });

  it("states the conversation-language keyword rule so a Chinese query can lexically hit English entries", () => {
    assert.ok(
      buildExtractPrompt(TRANSCRIPT).includes(
        "Include keywords in the conversation's own language — when the conversation is not in English, carry its key terms verbatim in the candidate's title or body so lexical recall can match."
      ),
      "the bilingual keyword discipline must reach the extract model verbatim"
    );
  });
});

// -- extractMemoryCandidates -------------------------------------------------

describe("extractMemoryCandidates", () => {
  it("forwards the static layer into the FakeLLM prompt", async () => {
    const layer = "Prefer bun over npm in this repo.";
    let seen = "";
    const llm: MemoryExtractLlm = {
      complete: async (prompt) => {
        seen = prompt;
        return "[]";
      },
    };
    await extractMemoryCandidates(TRANSCRIPT, llm, undefined, layer);
    assert.ok(seen.includes(layer));
  });

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

// -- closed memory_type enum (#731) ------------------------------------------

describe("extractMemoryCandidates — closed memory_type enum", () => {
  const extractTypes = async (
    types: ReadonlyArray<unknown>
  ): Promise<ReadonlyArray<string>> => {
    const llm = llmReturning(
      JSON.stringify(
        types.map((type, i) => ({
          title: `Title ${i}`,
          body: `Body ${i}`,
          ...(type === undefined ? {} : { type }),
          confidence: 0.9,
        }))
      )
    );
    const out = await extractMemoryCandidates(TRANSCRIPT, llm);
    return out.map((c) => c.type);
  };

  it("preserves the five legal types verbatim", async () => {
    const legal = ["convention", "decision", "gotcha", "constraint", "note"];
    assert.deepEqual(await extractTypes(legal), legal);
  });

  it("normalizes an illegal, missing, or non-string type to note", async () => {
    assert.deepEqual(await extractTypes(["weird", undefined, "", 7]), [
      "note",
      "note",
      "note",
      "note",
    ]);
  });

  it("normalizes a case-variant type to note (exact match only)", async () => {
    assert.deepEqual(await extractTypes(["Gotcha", " note "]), [
      "note",
      "note",
    ]);
  });

  it("persists an illegal extracted type as note through a full ingest", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "bar() is the thread-safe entry point in this repo.",
          type: "weird",
          confidence: 0.9,
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
    assert.equal(result.written.length, 1);
    const written = await readSlug(result.written[0]!.slug);
    assert.equal(written.type, "note");
  });

  it("persists a legal extracted type verbatim through a full ingest", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "bar() is the thread-safe entry point in this repo.",
          type: "convention",
          confidence: 0.9,
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
    assert.equal(result.written.length, 1);
    const written = await readSlug(result.written[0]!.slug);
    assert.equal(written.type, "convention");
  });
});

const STATIC_LAYER =
  "Always use bun for this project's package manager and keep the committed lockfile.";

describe("dropOverlappingStaticLayer", () => {
  it("drops a candidate that restates the static layer", () => {
    const kept = dropOverlappingStaticLayer(
      [
        candidate({
          title: "Always use bun for this project's package manager",
          body: "Always use bun for this project's package manager and keep the committed lockfile.",
        }),
      ],
      STATIC_LAYER
    );
    assert.deepEqual(kept, []);
  });

  it("keeps a candidate that is unrelated to the static layer", () => {
    const unrelated = candidate({
      title: "Retry Anthropic adapter on 529",
      body: "The Anthropic adapter retries on HTTP 529 before failing the turn.",
    });
    const kept = dropOverlappingStaticLayer([unrelated], STATIC_LAYER);
    assert.deepEqual(kept, [unrelated]);
  });

  it("does not drop candidates when the static layer is empty", () => {
    const fact = candidate();
    assert.deepEqual(dropOverlappingStaticLayer([fact], ""), [fact]);
    assert.deepEqual(dropOverlappingStaticLayer([fact], "   "), [fact]);
  });

  it("drops a zero-token candidate when the static layer has tokens", () => {
    const emptyTokens = candidate({ title: "A", body: "B" });
    assert.deepEqual(
      dropOverlappingStaticLayer([emptyTokens], STATIC_LAYER),
      []
    );
  });

  it("pins the overlap floor at 0.9", () => {
    assert.equal(STATIC_LAYER_OVERLAP_FLOOR, 0.9);
  });

  it("does not treat a large instruction file as overlapping an unrelated fact", () => {
    const filler = Array.from(
      { length: 80 },
      (_, i) =>
        `Paragraph ${i} describes local coding conventions for module boundaries and error handling.`
    ).join("\n\n");
    const unrelated = candidate({
      title: "Retry Anthropic adapter on 529",
      body: "The Anthropic adapter retries on HTTP 529 before failing the turn.",
    });
    const restating = candidate({
      title: "Always use bun for this project's package manager",
      body: "Always use bun for this project's package manager and keep the committed lockfile.",
    });
    const kept = dropOverlappingStaticLayer(
      [unrelated, restating],
      `${filler}\n\n${STATIC_LAYER}`
    );
    assert.deepEqual(kept, [unrelated]);
  });
});

// -- bilingual keyword discipline (extract write path → lexical recall) ------

/**
 * Acceptance fixture (plan auto-memory-prefetch-dedup T5): a Chinese session
 * yields an English entry that carries the session's key terms verbatim, so a
 * Chinese query can hit it through the shared tokenize + scoreMemoryEntries
 * instead of being dropped as a zero-hit entry. The keyword-free twin is what
 * an extractor without the discipline would produce — same topic, but no
 * token a Chinese query can match.
 */
describe("extract bilingual keyword discipline", () => {
  const QUERY = "查一下今天AI新闻";
  const bilingual = entry({
    id: "bilingual",
    title: "Follow these AI 新闻 sources for daily model releases",
    body: "The assistant tracks AI 新闻 from official model labs each morning.",
  });
  const keywordFree = entry({
    id: "keyword-free",
    title:
      "Follow artificial-intelligence news outlets for daily model releases",
    body: "The assistant tracks model releases from official labs each morning.",
  });

  it("keeps a Chinese-session English entry lexically reachable from a Chinese query", async () => {
    const llm = llmReturning(
      JSON.stringify([
        { title: bilingual.title, body: bilingual.body, confidence: 0.95 },
      ])
    );
    const result = await ingestMemory({
      memoryDir,
      transcript: "user: 查一下今天AI新闻\nassistant: 我来汇总今天的AI新闻。",
      llm,
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.equal(result.written.length, 1);
    const stored = await readSlug(result.written[0]!.slug);
    const scored = scoreMemoryEntries(QUERY, [stored])[0]!;
    assert.ok(
      scored.titleHits > 0,
      "title keywords must hit the Chinese query"
    );
    assert.ok(scored.bodyHits > 0, "body keywords must hit the Chinese query");
  });

  it("leaves a keyword-free English twin unmatched by the same Chinese query", () => {
    const scored = scoreMemoryEntries(QUERY, [keywordFree])[0]!;
    assert.equal(scored.titleHits, 0, "no English token matches a CJK query");
    assert.equal(scored.bodyHits, 0, "no English token matches a CJK query");
  });

  it("survives the zero-hit prefetch filter while its keyword-free twin is dropped", () => {
    const hits = selectPrefetchHits(QUERY, [keywordFree, bilingual]);
    assert.deepEqual(
      hits.map((hit) => hit.entry.id),
      [bilingual.id]
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

  it("NOOPs an equivalent pure-Chinese entry instead of adding a duplicate", () => {
    const cjk = candidate({
      title: "线程安全入口",
      body: "调用路径保持线程安全",
    });
    const ops = decideMemoryOps(
      [cjk],
      [
        {
          slug: "old",
          entry: entry({
            title: "线程安全入口",
            body: "调用路径保持线程安全",
          }),
        },
      ]
    );
    assert.equal(ops[0]!.kind, "NOOP");
  });

  it("does not treat two empty-token candidates as neighbors", () => {
    const ops = decideMemoryOps(
      [candidate({ title: "!!!", body: "。。。" })],
      [
        {
          slug: "old",
          entry: entry({ title: "???", body: "、、、" }),
        },
      ]
    );
    assert.equal(ops[0]!.kind, "ADD");
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

  it("UPDATEs when the same subject carries a materially different body", () => {
    const ops = decideMemoryOps(
      [
        candidate({
          body: "Concurrency now routes through the scheduler queue; direct calls were removed in v3.",
        }),
      ],
      [{ slug: "old", entry: entry() }]
    );
    assert.equal(ops[0]!.kind, "UPDATE");
    assert.equal(ops[0]!.kind === "UPDATE" ? ops[0]!.slug : "", "old");
  });

  // SC1 (specs/auto-memory-layering.md): extraction never supersedes. A
  // low word-overlap body on a same-subject neighbor is a different aspect,
  // not a contradiction — it must land as ADD or UPDATE, never SUPERSEDE.
  it("never SUPERSEDEs — a low-overlap body on the same subject lands as ADD or UPDATE", () => {
    const ops = decideMemoryOps(
      [
        candidate({
          body: "bar() accepts an optional timeout parameter for deadline enforcement.",
        }),
      ],
      [{ slug: "old", entry: entry() }]
    );
    const kind = ops[0]!.kind;
    assert.ok(
      kind === "ADD" || kind === "UPDATE",
      `expected ADD or UPDATE, got ${kind}`
    );
  });

  it("carries the neighbor's ttl_days into an UPDATE op", () => {
    const ops = decideMemoryOps(
      [
        candidate({
          body: "bar() is the thread-safe entry point in this repo, and it retries once on contention.",
        }),
      ],
      [{ slug: "old", entry: entry({ ttl_days: 30 }) }]
    );
    assert.ok(ops[0]!.kind === "UPDATE");
    assert.equal(
      ops[0]!.kind === "UPDATE" ? ops[0]!.ttlDays : -1,
      30,
      "UPDATE must preserve the stored entry's ttl_days"
    );
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
          supersedes: ["old"],
          candidate: candidate({
            body: "Concurrency routes through the scheduler queue.",
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    const fresh = await readSlug(written[0]!.slug);
    assert.deepEqual(fresh.supersedes, ["old"]);
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

  it("preserves the neighbor's ttl_days on UPDATE while ADD keeps the deps ttl", async () => {
    await put("old", { ttl_days: 30 });
    // Decide against the store so the UPDATE op carries the stored ttl_days.
    const ops = decideMemoryOps(
      [
        candidate({
          body: "bar() is the thread-safe entry point in this repo, and it retries once on contention.",
        }),
      ],
      [{ slug: "old", entry: entry({ ttl_days: 30 }) }]
    );
    const written = await persistMemoryOps(memoryDir, ops, {
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
      ttlDays: 7,
    });
    assert.equal(written[0]!.kind, "UPDATE");
    assert.equal(
      (await readSlug("old")).ttl_days,
      30,
      "UPDATE must not clobber the neighbor's ttl_days with the deps ttl"
    );

    const added = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "ADD",
          candidate: candidate({
            title: "Release cadence",
            body: "Releases ship every Tuesday.",
          }),
        },
      ],
      {
        now: () => NOW_ISO,
        randomBytes: () => Buffer.from("aabbccddeeff", "hex"),
        ttlDays: 7,
      }
    );
    assert.equal(
      (await readSlug(added[0]!.slug)).ttl_days,
      7,
      "non-UPDATE ops keep the deps ttl behavior"
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

  it("appends exactly one index line per ADD, even when the slug repeats", async () => {
    const deps = {
      now: () => NOW_ISO,
      randomBytes: () => Buffer.from("aabbccddeeff", "hex"),
    };
    await persistMemoryOps(
      memoryDir,
      [{ kind: "ADD", candidate: candidate() }],
      deps
    );
    await persistMemoryOps(
      memoryDir,
      [{ kind: "ADD", candidate: candidate() }],
      deps
    );
    assert.equal((await indexLines("aabbccddeeff")).length, 1);
  });

  // SC10: the index is the human entry point into the store. A title change
  // that leaves the old link text behind points a reader at a lie.
  it("replaces the slug's index line on UPDATE (old title gone, exactly one line)", async () => {
    await put("old");
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      `${indexLine("old", {})}\n`,
      "utf8"
    );
    const next = candidate({ title: "Use baz() for concurrency" });
    await persistMemoryOps(
      memoryDir,
      [{ kind: "UPDATE", slug: "old", candidate: next }],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    const lines = await indexLines("old");
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.equal(
      lines[0],
      indexLine("old", {
        title: next.title,
        importance: next.importance,
        updated_at: NOW_ISO,
      })
    );
  });

  it("is idempotent on a replayed UPDATE (still exactly one line)", async () => {
    await put("old");
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      `${indexLine("old", {})}\n`,
      "utf8"
    );
    const op = {
      kind: "UPDATE" as const,
      slug: "old",
      candidate: candidate({ title: "Use baz() for concurrency" }),
    };
    await persistMemoryOps(memoryDir, [op], {
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    await persistMemoryOps(memoryDir, [op], {
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.equal((await indexLines("old")).length, 1);
  });

  it("replaces the ADD-written line on a following UPDATE without growing the index", async () => {
    const written = await persistMemoryOps(
      memoryDir,
      [{ kind: "ADD", candidate: candidate() }],
      {
        now: () => NOW_ISO,
        randomBytes: () => Buffer.from("aabbccddeeff", "hex"),
      }
    );
    const slug = written[0]!.slug;
    assert.equal((await indexLines(slug)).length, 1, "ADD writes one row");
    const rowsBefore = (
      await readFile(join(memoryDir, "MEMORY.md"), "utf8")
    ).split("\n").length;

    const next = candidate({ title: "Use baz() for concurrency" });
    await persistMemoryOps(
      memoryDir,
      [{ kind: "UPDATE", slug, candidate: next }],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    const lines = await indexLines(slug);
    assert.equal(lines.length, 1, "UPDATE must not append a sibling row");
    assert.ok(lines[0]!.includes(next.title), lines[0]!);
    assert.ok(!lines[0]!.includes(candidate().title), lines[0]!);
    assert.equal(
      (await readFile(join(memoryDir, "MEMORY.md"), "utf8")).split("\n").length,
      rowsBefore,
      "the row count is stable across ADD then UPDATE"
    );
  });

  // ADD stays append-only: it never rewrites an existing row, so a slug that
  // somehow already has one gains a second rather than losing the old text.
  // Row surgery is the UPDATE path's job (refreshMemoryIndexLine).
  it("keeps ADD append-only semantics when a stale line for the slug exists", async () => {
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      `${indexLine("deadbeefcafe", { title: "Stale title" })}\n`,
      "utf8"
    );
    await persistMemoryOps(
      memoryDir,
      [{ kind: "ADD", candidate: candidate() }],
      {
        now: () => NOW_ISO,
        randomBytes: () => Buffer.from("deadbeefcafe", "hex"),
      }
    );
    const lines = await indexLines("deadbeefcafe");
    assert.equal(
      lines.length,
      2,
      "ADD appends; it does not own the stale line"
    );
    assert.ok(
      lines.some((l) => l.includes("Stale title")),
      lines.join("\n")
    );
    assert.ok(
      lines.some((l) => l.includes(candidate().title)),
      lines.join("\n")
    );
  });

  it("refreshes title, importance and updated_at together on UPDATE", async () => {
    await put("old");
    await writeFile(
      join(memoryDir, "MEMORY.md"),
      `${indexLine("old", { importance: 1 })}\n`,
      "utf8"
    );
    const next = candidate({
      title: "Use baz() for concurrency",
      importance: 5,
    });
    await persistMemoryOps(
      memoryDir,
      [{ kind: "UPDATE", slug: "old", candidate: next }],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    const lines = await indexLines("old");
    assert.equal(lines.length, 1, JSON.stringify(lines));
    const line = lines[0]!;
    assert.ok(line.includes(next.title), line);
    assert.ok(line.includes("importance=5"), line);
    assert.ok(line.includes(`updated_at=${NOW_ISO}`), line);
  });

  // Missing MEMORY.md is the same no-op the GC line remover chooses: updating
  // one row is not a reason to materialize an index that was never written.
  it("leaves a missing MEMORY.md missing on UPDATE while the entry still lands", async () => {
    await put("old");
    await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "UPDATE",
          slug: "old",
          candidate: candidate({ title: "Use baz() for concurrency" }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.ok(
      !(await readdir(memoryDir)).includes("MEMORY.md"),
      "UPDATE must not create the index"
    );
    assert.equal((await readSlug("old")).title, "Use baz() for concurrency");
  });
});

// -- runtime capability persist gate (ADR-0086 / SC6) ------------------------

describe("persistMemoryOps — runtime capability gate", () => {
  const CAPABILITY_BODY = "本环境没有真实出网，web 工具与搜索工具均不可用。";

  // Contrast with the save path: here the op is dropped, not thrown — the
  // caller is a background pass and must not fail the user turn.
  it("drops a capability ADD without throwing", async () => {
    const written = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "ADD",
          candidate: candidate({
            title: "web_search is unavailable in this sandbox",
            body: "The sandbox blocks outbound network access.",
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.deepEqual(written, []);
    assert.deepEqual(await slugsOnDisk(), []);
  });

  it("persists a sibling non-capability candidate in the same batch", async () => {
    const written = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "ADD",
          candidate: candidate({
            title: "web_search is unavailable in this sandbox",
            body: "The sandbox blocks outbound network access.",
          }),
        },
        {
          kind: "ADD",
          candidate: candidate({
            title: "Release cadence",
            body: "Releases ship every Tuesday.",
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.equal(written.length, 1, "only the usable sibling may land");
    const slugs = await slugsOnDisk();
    assert.equal(slugs.length, 1);
    assert.equal((await readSlug(slugs[0]!)).title, "Release cadence");
  });

  it("drops a capability candidate even when typed as constraint", async () => {
    const written = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "ADD",
          candidate: candidate({
            title: "本环境没有真实出网",
            body: CAPABILITY_BODY,
            type: "constraint",
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.deepEqual(written, []);
    assert.deepEqual(await slugsOnDisk(), []);
  });

  it("drops a capability SUPERSEDE without disabling the named target", async () => {
    await put("old");
    const before = await readFile(join(memoryDir, "old.md"), "utf8");
    const written = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "SUPERSEDE",
          supersedes: ["old"],
          candidate: candidate({
            title: "本环境没有真实出网",
            body: CAPABILITY_BODY,
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.deepEqual(written, []);
    assert.deepEqual(await slugsOnDisk(), ["old"]);
    assert.equal(await readFile(join(memoryDir, "old.md"), "utf8"), before);
  });

  it("drops a capability UPDATE and leaves the neighbor untouched", async () => {
    await put("old");
    const before = await readFile(join(memoryDir, "old.md"), "utf8");
    const written = await persistMemoryOps(
      memoryDir,
      [
        {
          kind: "UPDATE",
          slug: "old",
          candidate: candidate({
            title: "web_fetch cannot reach the network",
            body: "web_fetch cannot reach the internet from this environment.",
          }),
        },
      ],
      { now: () => NOW_ISO, randomBytes: seqBytes() }
    );
    assert.deepEqual(written, []);
    assert.equal(await readFile(join(memoryDir, "old.md"), "utf8"), before);
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

  // SC6: a capability candidate from the extractor never lands, while the
  // non-capability candidate in the same batch still ADDs.
  it("drops a capability candidate and keeps the sibling (SC6)", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "本环境没有真实出网",
          body: "本环境没有真实出网，web 工具与搜索工具均不可用。",
          type: "constraint",
          confidence: 0.95,
        },
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
      gc: false,
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.equal(result.written.length, 1);
    const slugs = await slugsOnDisk();
    assert.equal(slugs.length, 1, "the capability candidate must not land");
    assert.equal(
      (await readSlug(slugs[0]!)).title,
      "Use bar() for concurrency"
    );
  });

  it("writes nothing at all when every candidate is a capability observation", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "web_search is unavailable in this sandbox",
          body: "The sandbox DNS/SSRF segment blocks web_search.",
          confidence: 0.95,
        },
      ])
    );
    const result = await ingestMemory({
      memoryDir,
      transcript: TRANSCRIPT,
      llm,
      gc: false,
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.deepEqual(result.written, []);
    assert.deepEqual(await slugsOnDisk(), []);
  });

  it("does not write a candidate that overlaps the static layer", async () => {
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "Always use bun for this project's package manager",
          body: "Always use bun for this project's package manager and keep the committed lockfile.",
          confidence: 0.95,
        },
        {
          title: "Retry Anthropic adapter on 529",
          body: "The Anthropic adapter retries on HTTP 529 before failing the turn.",
          confidence: 0.95,
        },
      ])
    );
    const result = await ingestMemory({
      memoryDir,
      transcript: TRANSCRIPT,
      llm,
      staticLayer: STATIC_LAYER,
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.deepEqual(
      result.ops.map((o) => o.kind),
      ["ADD"]
    );
    assert.equal(result.written.length, 1);
    const stored = await readSlug(result.written[0]!.slug);
    assert.equal(stored.title, "Retry Anthropic adapter on 529");
  });

  it("does not drop candidates when ingest is given an empty static layer", async () => {
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
      staticLayer: "",
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.deepEqual(
      result.ops.map((o) => o.kind),
      ["ADD"]
    );
    assert.equal(result.written.length, 1);
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

  it("does not add a duplicate for an equivalent pure-Chinese fact", async () => {
    await put("old", {
      title: "线程安全入口",
      body: "调用路径保持线程安全",
    });
    const llm = llmReturning(
      JSON.stringify([
        {
          title: "线程安全入口",
          body: "调用路径保持线程安全",
          confidence: 0.95,
        },
      ])
    );
    const result = await ingestMemory({
      memoryDir,
      transcript: "user: 线程安全入口\nassistant: 调用路径保持线程安全",
      llm,
      gc: false,
      now: () => NOW_ISO,
      randomBytes: seqBytes(),
    });
    assert.deepEqual(
      result.ops.map((op) => op.kind),
      ["NOOP"]
    );
    assert.deepEqual(await slugsOnDisk(), ["old"]);
  });

  it("keeps the old entry live by UPDATEing in place and still runs GC after the write", async () => {
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
      ["UPDATE"],
      "extraction never supersedes"
    );
    assert.deepEqual(
      await slugsOnDisk(),
      ["old"],
      "UPDATE must not fork a new slug"
    );
    assert.equal(
      (await readSlug("old")).disabled,
      false,
      "the old entry stays live — no SUPERSEDE happens on extraction"
    );
    assert.ok(result.gc !== undefined, "GC still runs after the write");
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
