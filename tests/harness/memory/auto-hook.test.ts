/**
 * auto-memory T4: auto-hook.ts tests (host-side trigger gate).
 *
 * Spec: specs/auto-memory.md D1/D4; ADR-0031 Decision 1/5. The hook is the
 * seam a host calls after every turn. It must:
 *   - do nothing at all unless explicitly enabled (default OFF)
 *   - fire only after StopReason=completed, and only on the N>=2 turn gate
 *   - run ingest off the caller's critical path (fire-and-forget)
 *   - never throw and never reject, whatever ingest does
 *
 * `drain()` exists so fire-and-forget stays testable: without it the only way
 * to assert on an async side effect is a sleep, which is the flake this suite
 * is not going to introduce.
 */
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createAutoMemoryHook,
  parseMemoryEntry,
  serializeMemoryEntry,
} from "../../../src/harness/memory/index.ts";
import type { MemoryExtractLlm } from "../../../src/harness/memory/index.ts";
import type { MemoryEntryV1 } from "../../../src/harness/memory/index.ts";

let memoryDir: string;

beforeEach(async () => {
  memoryDir = await mkdtemp(join(tmpdir(), "memory-auto-hook-"));
});

afterEach(async () => {
  await rm(memoryDir, { recursive: true, force: true });
});

const NOW_ISO = "2026-08-26T00:00:00.000Z";

const FACT = JSON.stringify([
  {
    title: "Use bar() for concurrency",
    body: "bar() is the thread-safe entry point in this repo.",
    confidence: 0.95,
  },
]);

/** LLM fake that also records how many times it was asked. */
const countingLlm = (
  raw: string
): MemoryExtractLlm & { readonly calls: () => number } => {
  let calls = 0;
  return {
    complete: async () => {
      calls++;
      return raw;
    },
    calls: () => calls,
  };
};

const entryCount = async (): Promise<number> =>
  (await readdir(memoryDir)).filter(
    (n) => n.endsWith(".md") && n !== "MEMORY.md"
  ).length;

const hookOpts = (llm: MemoryExtractLlm, over?: Record<string, unknown>) => ({
  memoryDir,
  llm,
  enabled: true,
  minCompletedTurns: 1,
  now: () => NOW_ISO,
  nowMs: Date.parse(NOW_ISO),
  ...over,
});

// -- the OFF default ---------------------------------------------------------

describe("createAutoMemoryHook — default OFF", () => {
  it("spends no LLM call and writes nothing when disabled", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(hookOpts(llm, { enabled: false }));
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
    assert.equal(await entryCount(), 0);
  });

  it("treats a missing enabled flag as off", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
    });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
  });

  it("reads live flags on each turn so TUI can flip autoExtract after wiring", async () => {
    const llm = countingLlm(FACT);
    const flags = { autoExtract: false, dream: false };
    const hook = createAutoMemoryHook(hookOpts(llm, { enabled: false, flags }));
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which entry point is thread-safe?",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0);
    flags.autoExtract = true;
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which entry point is thread-safe?",
    });
    await hook.drain();
    assert.equal(llm.calls(), 1);
  });
});

// -- the completed gate ------------------------------------------------------

describe("createAutoMemoryHook — completed gate", () => {
  it("ingests after a completed turn", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(hookOpts(llm));
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which entry point is thread-safe?",
    });
    await hook.drain();
    assert.equal(llm.calls(), 1);
    assert.equal(await entryCount(), 1);
  });

  for (const stopReason of [
    "maxTurns",
    "cancelled",
    "protocolError",
    "nonSuccessStop",
    "emptyFinalResponse",
    "timeout",
    "fused",
  ]) {
    it(`ignores a turn that stopped with ${stopReason}`, async () => {
      const llm = countingLlm(FACT);
      const hook = createAutoMemoryHook(hookOpts(llm));
      hook.onTurnComplete({ stopReason, transcript: "user: hi" });
      await hook.drain();
      assert.equal(llm.calls(), 0);
      assert.equal(await entryCount(), 0);
    });
  }

  // empty boundary
  it("ignores a turn with a blank transcript", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(hookOpts(llm));
    hook.onTurnComplete({ stopReason: "completed", transcript: "   " });
    await hook.drain();
    assert.equal(llm.calls(), 0);
  });
});

// -- the N>=2 turn gate ------------------------------------------------------

describe("createAutoMemoryHook — static layer on extract", () => {
  it("forwards a loaded static layer into the extract prompt", async () => {
    const layer = "Always use bun for this project's package manager.";
    const prompts: string[] = [];
    const llm: MemoryExtractLlm = {
      complete: async (prompt) => {
        prompts.push(prompt);
        return FACT;
      },
    };
    const hook = createAutoMemoryHook(
      hookOpts(llm, { staticLayer: async () => layer })
    );
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: which package manager?",
    });
    await hook.drain();
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0]?.includes(layer));
  });

  it("still extracts when the static-layer loader throws", async () => {
    const llm = countingLlm(FACT);
    const errors: unknown[] = [];
    const hook = createAutoMemoryHook(
      hookOpts(llm, {
        staticLayer: async () => {
          throw new Error("lstat failed");
        },
        onError: (error: unknown) => {
          errors.push(error);
        },
      })
    );
    assert.doesNotThrow(() => {
      hook.onTurnComplete({
        stopReason: "completed",
        transcript: "user: which package manager?",
      });
    });
    await hook.drain();
    assert.equal(llm.calls(), 1, "extract still runs after static-layer IO failure");
    assert.equal(errors.length, 1);
  });
});

describe("createAutoMemoryHook — completed-turn gate", () => {
  it("waits for the second completed turn at the default gate", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: turn one",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0, "one completed turn is below the gate");

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: turn two",
    });
    await hook.drain();
    assert.equal(llm.calls(), 1);
  });

  it("does not count non-completed turns toward the gate", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: true,
      now: () => NOW_ISO,
    });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    hook.onTurnComplete({ stopReason: "cancelled", transcript: "user: two" });
    hook.onTurnComplete({ stopReason: "maxTurns", transcript: "user: three" });
    await hook.drain();
    assert.equal(llm.calls(), 0);
  });

  it("rejects a non-positive gate with a typed MemoryError", () => {
    assert.throws(() =>
      createAutoMemoryHook({
        memoryDir,
        llm: countingLlm(FACT),
        enabled: true,
        minCompletedTurns: 0,
      })
    );
  });
});

// -- failure never fails the turn --------------------------------------------

describe("createAutoMemoryHook — failure containment", () => {
  it("swallows an LLM failure and reports it to onError", async () => {
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook(
      hookOpts(
        {
          complete: async () => {
            throw new Error("model unavailable");
          },
        },
        { onError: (e: unknown) => seen.push(e) }
      )
    );
    // The call itself must be synchronous and total — a throwing hook would
    // take the user's turn down with it.
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(seen.length, 1);
    assert.match(String(seen[0]), /model unavailable|extraction call failed/);
  });

  it("swallows an unusable memory dir without rejecting", async () => {
    // A regular file where a directory has to be: mkdir fails with ENOTDIR.
    const blocker = join(memoryDir, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const seen: unknown[] = [];
    const hook = createAutoMemoryHook({
      memoryDir: join(blocker, "memory"),
      llm: countingLlm(FACT),
      enabled: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      onError: (e) => seen.push(e),
    });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: hi" });
    await hook.drain();
    assert.equal(seen.length, 1, "the IO failure is reported, not thrown");
  });

  it("keeps working after a failed pass", async () => {
    let fail = true;
    const hook = createAutoMemoryHook(
      hookOpts({
        complete: async () => {
          if (fail) {
            fail = false;
            throw new Error("transient");
          }
          return FACT;
        },
      })
    );
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    await hook.drain();
    assert.equal(await entryCount(), 0);
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: two" });
    await hook.drain();
    assert.equal(
      await entryCount(),
      1,
      "a failed pass must not poison the hook"
    );
  });

  // concurrent boundary
  it("serializes overlapping turns so two passes cannot interleave a write", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const hook = createAutoMemoryHook(
      hookOpts({
        complete: async () => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return FACT;
        },
      })
    );
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: two" });
    await hook.drain();
    assert.equal(maxInFlight, 1, "ingest passes must not overlap on one store");
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;
const DREAM_CURSOR_FILE = "dream-cursor.json";

const seedDreamGate = async (
  dir: string,
  nowMs: number,
  sessionIds: readonly string[] = ["s1", "s2", "s3", "s4"]
): Promise<void> => {
  await writeFile(
    join(dir, DREAM_CURSOR_FILE),
    JSON.stringify({
      lastSuccessAtMs: nowMs - DAY_MS,
      sessionIds,
    }),
    "utf8"
  );
};

const twoLiveEntries = async (): Promise<void> => {
  const a: MemoryEntryV1 = {
    id: "old",
    type: "note",
    importance: 1,
    ttl_days: 0,
    disabled: false,
    supersedes: null,
    title: "Use bar() for concurrency",
    body: "bar() is the thread-safe entry point in this repo.",
    updated_at: NOW_ISO,
  };
  const b: MemoryEntryV1 = {
    ...a,
    id: "sib",
    title: "Use bar() for parallel work",
  };
  await writeFile(join(memoryDir, "old.md"), serializeMemoryEntry(a), "utf8");
  await writeFile(join(memoryDir, "sib.md"), serializeMemoryEntry(b), "utf8");
};

describe("createAutoMemoryHook — dream pass", () => {
  it("does not run dream on the extract N>=2 gate alone", async () => {
    await twoLiveEntries();
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: one",
      sessionKey: "sess-a",
    });
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: two",
      sessionKey: "sess-b",
    });
    await hook.drain();

    assert.equal(llm.calls(), 0, "two completed turns are not the dream gate");
  });

  it("does not run dream when 24h has not elapsed even with five sessions", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await writeFile(
      join(memoryDir, DREAM_CURSOR_FILE),
      JSON.stringify({
        lastSuccessAtMs: nowMs - DAY_MS + 1,
        sessionIds: ["s1", "s2", "s3", "s4"],
      }),
      "utf8"
    );
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(llm.calls(), 0);
  });

  it("does not run dream when fewer than five distinct sessions have completed", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs, ["s1", "s2", "s3"]);
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: a",
      sessionKey: "s4",
    });
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: b",
      sessionKey: "s4",
    });
    await hook.drain();

    assert.equal(
      llm.calls(),
      0,
      "the same sessionKey must not count as a second session"
    );
  });

  it("runs dream after 24h and five distinct sessions, including blank transcripts", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "   ",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(llm.calls(), 1, "dream does not require a transcript");
  });

  it("does not add a merge call when dream is explicitly off", async () => {
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(
      hookOpts(llm, { dream: false, minCompletedTurns: 2 })
    );

    hook.onTurnComplete({ stopReason: "completed", transcript: "user: one" });
    hook.onTurnComplete({ stopReason: "completed", transcript: "user: two" });
    await hook.drain();

    assert.equal(llm.calls(), 1, "extract-only remains one LLM call");
  });

  it("runs extract without a merge call when dream is on but the dual gate is unmet", async () => {
    await twoLiveEntries();
    const llm = countingLlm(FACT);
    const hook = createAutoMemoryHook(
      hookOpts(llm, { dream: true, minCompletedTurns: 1 })
    );

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
      sessionKey: "only-one",
    });
    await hook.drain();

    assert.equal(llm.calls(), 1, "extract still fires; dream gate is unmet");
  });

  it("runs extract, dream, then one mechanical GC pass when both are on and the dual gate is met", async () => {
    await twoLiveEntries();
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const responses = [
      FACT,
      JSON.stringify([
        {
          title: "Use bar() for concurrency",
          body: "Concurrency now routes through the scheduler queue; direct calls were removed in v3.",
          confidence: 0.95,
        },
      ]),
    ];
    let calls = 0;
    const hook = createAutoMemoryHook(
      hookOpts(
        {
          complete: async () => responses[calls++] ?? "[]",
        },
        { dream: true, nowMs }
      )
    );

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "user: hi",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(calls, 2, "one extract call followed by one dream call");
    const files = await readdir(memoryDir);
    const stored = await Promise.all(
      files
        .filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
        .map(async (name) =>
          parseMemoryEntry(await readFile(join(memoryDir, name), "utf8"))
        )
    );
    assert.ok(
      stored.some(
        (entry) =>
          (entry as unknown as Record<string, unknown>).source === "dream"
      )
    );
    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "old.md"), "utf8"))
        .disabled,
      true
    );
  });

  it("still runs mechanical GC when the dream merge throws", async () => {
    const stale: MemoryEntryV1 = {
      id: "stale",
      type: "note",
      importance: 1,
      ttl_days: 1,
      disabled: false,
      supersedes: null,
      title: "Stale fact",
      body: "This fact expired yesterday.",
      updated_at: "2026-08-20T00:00:00.000Z",
    };
    await writeFile(
      join(memoryDir, "stale.md"),
      serializeMemoryEntry(stale),
      "utf8"
    );
    await writeFile(
      join(memoryDir, "live.md"),
      serializeMemoryEntry({
        ...stale,
        id: "live",
        ttl_days: 0,
        updated_at: NOW_ISO,
        title: "Live fact",
        body: "This fact is still current.",
      }),
      "utf8"
    );
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const hook = createAutoMemoryHook({
      memoryDir,
      llm: {
        complete: async () => {
          throw new Error("merge exploded");
        },
      },
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(
      parseMemoryEntry(await readFile(join(memoryDir, "stale.md"), "utf8"))
        .disabled,
      true,
      "TTL GC must still run after a dream failure"
    );
  });

  it("advances the time gate when a met dual gate skips because live entries < 2", async () => {
    const stored: MemoryEntryV1 = {
      id: "old",
      type: "note",
      importance: 1,
      ttl_days: 0,
      disabled: false,
      supersedes: null,
      title: "Existing fact",
      body: "The existing fact remains useful.",
      updated_at: NOW_ISO,
    };
    await writeFile(
      join(memoryDir, "old.md"),
      serializeMemoryEntry(stored),
      "utf8"
    );
    const nowMs = Date.parse(NOW_ISO);
    await seedDreamGate(memoryDir, nowMs);
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      now: () => NOW_ISO,
      nowMs,
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();
    assert.equal(llm.calls(), 0, "skip must not spend a dream LLM call");

    await twoLiveEntries();
    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s6",
    });
    await hook.drain();
    assert.equal(
      llm.calls(),
      0,
      "a skip advances lastSuccessAtMs so the next turn cannot immediately re-fire"
    );
  });

  it("keeps dream cursors isolated across memoryDir roots", async () => {
    const otherDir = await mkdtemp(join(tmpdir(), "memory-auto-hook-b-"));
    try {
      const nowMs = Date.parse(NOW_ISO);
      await seedDreamGate(memoryDir, nowMs);
      await writeFile(
        join(otherDir, DREAM_CURSOR_FILE),
        JSON.stringify({
          lastSuccessAtMs: nowMs,
          sessionIds: ["s1", "s2", "s3", "s4"],
        }),
        "utf8"
      );
      const writePair = async (dir: string): Promise<void> => {
        const a: MemoryEntryV1 = {
          id: "old",
          type: "note",
          importance: 1,
          ttl_days: 0,
          disabled: false,
          supersedes: null,
          title: "Use bar() for concurrency",
          body: "bar() is the thread-safe entry point in this repo.",
          updated_at: NOW_ISO,
        };
        await writeFile(join(dir, "old.md"), serializeMemoryEntry(a), "utf8");
        await writeFile(
          join(dir, "sib.md"),
          serializeMemoryEntry({
            ...a,
            id: "sib",
            title: "Use bar() elsewhere",
          }),
          "utf8"
        );
      };
      await writePair(memoryDir);
      await writePair(otherDir);

      const llmA = countingLlm("[]");
      const llmB = countingLlm("[]");
      const hookA = createAutoMemoryHook({
        memoryDir,
        llm: llmA,
        enabled: false,
        dream: true,
        now: () => NOW_ISO,
        nowMs,
      });
      const hookB = createAutoMemoryHook({
        memoryDir: otherDir,
        llm: llmB,
        enabled: false,
        dream: true,
        now: () => NOW_ISO,
        nowMs,
      });

      hookA.onTurnComplete({
        stopReason: "completed",
        transcript: "",
        sessionKey: "s5",
      });
      hookB.onTurnComplete({
        stopReason: "completed",
        transcript: "",
        sessionKey: "s5",
      });
      await hookA.drain();
      await hookB.drain();

      assert.equal(llmA.calls(), 1, "root A dual gate is met");
      assert.equal(llmB.calls(), 0, "root B still inside 24h");
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  it("does not overwrite a corrupt dream cursor with an empty window", async () => {
    await twoLiveEntries();
    const corrupt = "{not-json";
    await writeFile(join(memoryDir, DREAM_CURSOR_FILE), corrupt, "utf8");
    const seen: unknown[] = [];
    const llm = countingLlm("[]");
    const hook = createAutoMemoryHook({
      memoryDir,
      llm,
      enabled: false,
      dream: true,
      minCompletedTurns: 1,
      now: () => NOW_ISO,
      nowMs: Date.parse(NOW_ISO),
      onError: (error) => seen.push(error),
    });

    hook.onTurnComplete({
      stopReason: "completed",
      transcript: "",
      sessionKey: "s5",
    });
    await hook.drain();

    assert.equal(llm.calls(), 0);
    assert.equal(seen.length, 1);
    assert.equal(
      await readFile(join(memoryDir, DREAM_CURSOR_FILE), "utf8"),
      corrupt
    );
  });
});
