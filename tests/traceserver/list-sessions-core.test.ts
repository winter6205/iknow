import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "vitest";

import {
  createListSessionsCore,
  LIST_SESSIONS_DEFAULT_LIMIT,
  LIST_SESSIONS_MAX_LIMIT,
  LIST_SESSIONS_DESCRIPTION,
  type ListSessionsCoreHandler,
} from "../../src/traceserver/list-sessions-core.ts";
import { TraceQueryValidationError } from "../../src/traceserver/query-trace-errors.ts";
import { TraceReadError } from "../../src/traceserver/types.ts";

/**
 * Shared core behind `list_sessions` (plan `trace-mcp-read-side-split` T5b,
 * spec SC6 / SC16 / the 目录轴 column of the 边界类 × 三面 table).
 *
 * Why this tool exists at all: `query_trace` reads exactly one file
 * (`conversation_id ?? newestConversationId`), so it structurally cannot see the
 * rest of a trace directory, and a session's root record is only written at run
 * end (src/harness/trace/jsonl.ts + loop-engine.ts), so crashed or in-progress
 * sessions have no root record to find. `listSessions` builds the index from
 * readdir + stat and touches a file body only inside the first-64-KiB window to
 * locate that root record (record contents never enter the response), so it
 * discovers both classes. Every assertion below is pinned to that mechanism —
 * never to a session count.
 *
 * Contract, file-wide: no expected message carries a tool-name prefix. The core
 * backs several tools on each thin face, so naming one would misreport the
 * others; prefixing is the faces' job (T5a moved it there).
 */

const traceDirs: string[] = [];
const SECOND_MS = 1_000;
const BASE_EPOCH = 1_600_000_000;

afterEach(() => {
  for (const traceDir of traceDirs.splice(0)) {
    rmSync(traceDir, { recursive: true, force: true });
  }
});

function makeTraceDir(): string {
  const traceDir = mkdtempSync(join(tmpdir(), "iknow-list-sessions-core-"));
  traceDirs.push(traceDir);
  return traceDir;
}

/** A session file with a root record, like a finished run leaves behind. */
function rootedSession(
  traceDir: string,
  conversationId: string,
  ageSeconds = 0
): void {
  writeSession(
    traceDir,
    conversationId,
    [
      {
        record_type: "llm_call",
        conversation_id: conversationId,
        llm_call_id: "llm-1",
      },
      {
        record_type: "session",
        conversation_id: conversationId,
        agent_version: "9.9.9",
      },
    ],
    ageSeconds
  );
}

/**
 * A session file with **no** root record — the shape a crash or an in-progress
 * run leaves. `query_trace` cannot surface the session behind it at all;
 * `list_sessions` must list it with `agent_version` absent.
 */
function rootlessSession(
  traceDir: string,
  conversationId: string,
  ageSeconds = 0
): void {
  writeSession(
    traceDir,
    conversationId,
    [
      {
        record_type: "llm_call",
        conversation_id: conversationId,
        llm_call_id: "llm-1",
      },
    ],
    ageSeconds
  );
}

function writeSession(
  traceDir: string,
  conversationId: string,
  rows: ReadonlyArray<Record<string, unknown>>,
  ageSeconds: number
): void {
  const path = join(traceDir, `${conversationId}.jsonl`);
  writeFileSync(
    path,
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    "utf8"
  );
  const at = new Date((BASE_EPOCH - ageSeconds) * SECOND_MS);
  utimesSync(path, at, at);
}

interface Page {
  sessions: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

async function pageOf(
  core: ListSessionsCoreHandler,
  input: unknown
): Promise<Page> {
  return JSON.parse(await core(input)) as Page;
}

function conversationIds(page: Page): string[] {
  return page.sessions.map((s) => s["conversation_id"] as string);
}

describe("list_sessions core — what it answers", () => {
  it("lists a session whose file has no root record, with agent_version absent", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "finished");
    rootlessSession(traceDir, "crashed");

    const page = await pageOf(createListSessionsCore({ traceDir }), {});
    const crashed = page.sessions.find(
      (s) => s["conversation_id"] === "crashed"
    );

    assert.ok(crashed, "a session with no root record must still be listed");
    assert.ok(
      !("agent_version" in crashed),
      "an unknown agent_version must be absent from the entry, not null"
    );
    assert.equal(
      page.sessions.find((s) => s["conversation_id"] === "finished")?.[
        "agent_version"
      ],
      "9.9.9"
    );
  });

  it("leaves agent_version absent for a finished session whose root record falls outside the 64 KiB read window", async () => {
    // The evidence behind LIST_SESSIONS_DESCRIPTION's wording: sessions.ts
    // readBounded preads the first 64 KiB only, while the writer appends the
    // root record at run end, so size — not the presence of agent_version —
    // decides whether a completed session reports its version. This test goes
    // red the day the reader learns to scan the tail; that is the moment to
    // update the description and the cost paragraph in sessions.ts, not to
    // relax the assertion.
    const traceDir = makeTraceDir();
    const path = join(traceDir, "long-run.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({
          record_type: "llm_call",
          conversation_id: "long-run",
          llm_call_id: "llm-1",
          padding: "x".repeat(70 * 1024),
        }),
        JSON.stringify({
          record_type: "session",
          conversation_id: "long-run",
          agent_version: "9.9.9",
        }),
      ].join("\n") + "\n",
      "utf8"
    );
    // Pin the preconditions, so a fixture that quietly stopped being large
    // could not pass the assertion below for the wrong reason.
    assert.ok(
      statSync(path).size > 65536,
      "fixture must exceed the read window"
    );
    assert.match(readFileSync(path, "utf8"), /"record_type":"session"/);

    const page = await pageOf(createListSessionsCore({ traceDir }), {});
    const entry = page.sessions.find(
      (s) => s["conversation_id"] === "long-run"
    );

    assert.ok(entry, "the session must still be listed");
    assert.ok(
      !("agent_version" in entry),
      "a root record past the read window must be absent, not guessed"
    );
    assert.equal(typeof entry["size"], "number");
  });

  it("emits sessions plus the echoed coordinates and no truncation metadata", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "a");
    rootedSession(traceDir, "b", 100);

    const text = await createListSessionsCore({ traceDir })({ limit: 1 });
    const page = JSON.parse(text) as Page;

    assert.deepEqual(Object.keys(page), ["sessions", "limit", "offset"]);
    // plan §序列化 defines the tool face as "array + the coordinates the caller
    // gave"; the table's overflow cell reads "drop the tail + hand back the
    // continuation coordinate". Echoing the effective values (default included)
    // is what lets a caller test `sessions.length < limit` without remembering
    // what it sent, and `offset + sessions.length` is the next page's start.
    assert.deepEqual(
      { limit: page.limit, offset: page.offset },
      { limit: 1, offset: 0 }
    );
    // 契约 X still forbids the tool reporting truncation of its own accord:
    // offset/limit are read-unit coordinates, not truncation signals.
    for (const banned of ["total", "truncated", "response_truncated"]) {
      assert.ok(!text.includes(banned), `"${banned}" leaked into the response`);
    }
    assert.deepEqual(Object.keys(page.sessions[0]!).sort(), [
      "agent_version",
      "conversation_id",
      "mtime",
      "size",
    ]);
  });

  it("keeps the four SessionSummary keys and passes mtime/size through from stat", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "only-one");
    const stats = statSync(join(traceDir, "only-one.jsonl"));

    const page = await pageOf(createListSessionsCore({ traceDir }), {});

    assert.deepEqual(Object.keys(page.sessions[0]!).sort(), [
      "agent_version",
      "conversation_id",
      "mtime",
      "size",
    ]);
    // The numbers are stat's own, not a re-derivation: compare against the
    // filesystem rather than a hand-transcribed byte count.
    assert.equal(page.sessions[0]!["size"], stats.size);
    assert.equal(page.sessions[0]!["mtime"], stats.mtimeMs);
  });

  it("describes itself once, and says what paging means", () => {
    // One text for both faces (spec SC7: the description carries no character cap).
    assert.match(LIST_SESSIONS_DESCRIPTION, /list_sessions|sessions/);
    assert.match(LIST_SESSIONS_DESCRIPTION, /limit/);
    assert.match(LIST_SESSIONS_DESCRIPTION, /offset/);
    assert.match(LIST_SESSIONS_DESCRIPTION, /agent_version/);
    // Absence has two causes; the description must name the reader's window,
    // or a caller reads "no agent_version" as "this run is still going". These
    // are phrase-level locks: rewording the description is allowed but must move
    // these expectations with it (intended friction, not an accident), and the
    // negative arm only bans the specific `absent … means … crash/running`
    // construction — it cannot catch every way of implying that.
    assert.match(LIST_SESSIONS_DESCRIPTION, /first 64 KiB/);
    assert.match(LIST_SESSIONS_DESCRIPTION, /absent in two cases/);
    assert.match(
      LIST_SESSIONS_DESCRIPTION,
      /says nothing about whether the session finished/
    );
    assert.ok(
      !/absent[^.]{0,60}\bmeans\b[^.]{0,40}(crash|running|unfinished|in-progress)/i.test(
        LIST_SESSIONS_DESCRIPTION
      ),
      "absence must not be described as meaning the run is unfinished"
    );
    assert.ok(!/capped|[0-9]+ ?characters/i.test(LIST_SESSIONS_DESCRIPTION));
  });
});

describe("list_sessions core — paging", () => {
  it("answers newest first and pages with caller limit/offset", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "oldest", 300);
    rootedSession(traceDir, "middle", 200);
    rootlessSession(traceDir, "newest", 100);
    const core = createListSessionsCore({ traceDir });

    const head = await pageOf(core, { limit: 2 });
    assert.deepEqual(conversationIds(head), ["newest", "middle"]);
    // overflow class, per the table's cell "drop the tail + hand back the
    // continuation coordinate": page 1's echoed coordinates alone must be enough
    // to start page 2, with no total to consult. Deriving `resume` from the echo
    // (not from a literal 2) is what makes that assertion mean something.
    const resume = head.offset + head.sessions.length;
    const tail = await pageOf(core, { limit: head.limit, offset: resume });
    assert.deepEqual(conversationIds(tail), ["oldest"]);
    assert.ok(
      tail.sessions.length < tail.limit!,
      "a page shorter than the echoed limit is the end-of-data signal"
    );
  });

  it("defaults the page size to LIST_SESSIONS_DEFAULT_LIMIT", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "a");
    rootedSession(traceDir, "b");
    const core = createListSessionsCore({ traceDir });

    const omitted = await core({});
    const explicit = await core({ limit: LIST_SESSIONS_DEFAULT_LIMIT });

    assert.equal(omitted, explicit);
  });

  it("accepts both declared page-size bounds", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "a");
    rootedSession(traceDir, "b");
    const core = createListSessionsCore({ traceDir });

    assert.equal((await pageOf(core, { limit: 1 })).sessions.length, 1);
    assert.equal(
      (await pageOf(core, { limit: LIST_SESSIONS_MAX_LIMIT })).sessions.length,
      2
    );
  });

  it("answers an empty page for an offset past the end of the index", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "only");
    const core = createListSessionsCore({ traceDir });

    assert.deepEqual(await pageOf(core, { offset: 50 }), {
      sessions: [],
      limit: LIST_SESSIONS_DEFAULT_LIMIT,
      offset: 50,
    });
  });

  it("returns the same page for the same request, so back-to-back calls are stable", async () => {
    // Repeatability half of the concurrent class — four calls with the same
    // paging must agree byte for byte. It does NOT falsify the conversation_id
    // tie-break: on this ext4 readdirSync already hands back name-ascending
    // order (measured here, and on the real 81-file trace dir), so a fixture
    // whose expected order is also name-ascending passes with or without that
    // branch. The tie-break stands on the documented total order in
    // sessions.ts, not on this probe. The append half is the next test.
    const traceDir = makeTraceDir();
    for (const name of ["aaa", "bbb", "ccc", "ddd", "eee", "fff"]) {
      rootedSession(traceDir, name, 0);
    }
    const core = createListSessionsCore({ traceDir });

    const pages = await Promise.all([1, 2, 3, 4].map(() => core({ limit: 3 })));
    assert.equal(new Set(pages).size, 1);
    assert.deepEqual(conversationIds(JSON.parse(pages[0]!) as Page), [
      "aaa",
      "bbb",
      "ccc",
    ]);
  });

  it("picks up a session the writer appends between two page reads", async () => {
    // Concurrent class, append half (the table's "写侧 append 期间取索引"): the
    // index exists to be read while runs are still landing on disk, so a cached
    // snapshot would hide exactly the sessions a caller is waiting for.
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "older", 300);
    rootedSession(traceDir, "middle", 200);
    const core = createListSessionsCore({ traceDir });

    assert.deepEqual(conversationIds(await pageOf(core, { limit: 2 })), [
      "middle",
      "older",
    ]);
    // A run finishes while the caller is paging: newest mtime in the directory.
    rootedSession(traceDir, "just-landed", -100);

    const second = await pageOf(core, { limit: 2 });
    assert.deepEqual(conversationIds(second), ["just-landed", "middle"]);
    assert.equal(
      second.offset,
      0,
      "the echo still reports the caller's own page"
    );
  });
});

describe("list_sessions core — empty and broken inputs", () => {
  it("empty directory and missing directory both answer an empty page", async () => {
    const emptyDir = makeTraceDir();
    const missingDir = join(emptyDir, "not-created");

    for (const dir of [emptyDir, missingDir]) {
      // A missing directory is semantics, not a failure: listSessions maps
      // readdir ENOENT to an empty index (src/traceserver/sessions.ts).
      assert.deepEqual(
        await pageOf(createListSessionsCore({ traceDir: dir }), {}),
        {
          sessions: [],
          limit: LIST_SESSIONS_DEFAULT_LIMIT,
          offset: 0,
        }
      );
    }
  });

  it("rejects a non-object input before touching the filesystem", async () => {
    const core = createListSessionsCore({ traceDir: makeTraceDir() });

    for (const input of [null, undefined, [], "a", 42]) {
      await assert.rejects(
        () => core(input),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.kind === "validation" &&
          error.field === "input" &&
          error.message === "input must be an object",
        `input ${JSON.stringify(input)} must be rejected`
      );
    }
  });

  it("re-validates the bounds the faces already declare", async () => {
    // Both faces declare these bounds on their own schema (ajv on the ACI face,
    // zod on the MCP face), so a caller normally cannot reach this check. It
    // stays because the core is the shared owner of the read unit: the day a face
    // forgets to enforce, the core still answers honestly.
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "a");
    const core = createListSessionsCore({ traceDir });

    for (const limit of [
      0,
      -1,
      LIST_SESSIONS_MAX_LIMIT + 1,
      1.5,
      Number.NaN,
      "5",
    ]) {
      await assert.rejects(
        () => core({ limit }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.kind === "validation" &&
          error.field === "limit" &&
          error.message ===
            `limit must be an integer in 1..${LIST_SESSIONS_MAX_LIMIT}`,
        `limit ${String(limit)} must be rejected`
      );
    }
  });

  it("rejects a negative or fractional offset", async () => {
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "a");
    const core = createListSessionsCore({ traceDir });

    for (const offset of [-1, -1000, 0.5, "0"]) {
      await assert.rejects(
        () => core({ offset }),
        (error: unknown) =>
          error instanceof TraceQueryValidationError &&
          error.field === "offset" &&
          error.message ===
            `offset must be an integer in 0..${Number.MAX_SAFE_INTEGER}`,
        `offset ${String(offset)} must be rejected`
      );
    }
    assert.equal((await pageOf(core, { offset: 0 })).sessions.length, 1);
  });

  it("ignores keys this axis has no meaning for", async () => {
    // Mirror of query-trace-core's parseInput: strictness is the faces' job
    // (additionalProperties:false / .strict()); the core reads what it knows.
    const traceDir = makeTraceDir();
    rootedSession(traceDir, "a");

    assert.deepEqual(
      await pageOf(createListSessionsCore({ traceDir }), {
        record_type: "llm_call",
      }),
      await pageOf(createListSessionsCore({ traceDir }), {})
    );
  });
});

describe("list_sessions core — read failures", () => {
  it("lets TraceReadError through unprefixed, with no fs detail", async () => {
    // A regular file where a directory should be is the one deterministic IO
    // failure reachable without root privileges or chmod, so it is what the two
    // thin faces' error-mapping tests are built on.
    const traceDir = makeTraceDir();
    const asFile = join(traceDir, "not-a-dir.jsonl");
    writeFileSync(asFile, '{"record_type":"session"}\n', "utf8");

    await assert.rejects(
      () => createListSessionsCore({ traceDir: asFile })({}),
      (error: unknown) =>
        error instanceof TraceReadError &&
        error.kind === "io_error" &&
        error.message === "trace file read failed: ENOTDIR",
      "expected a TraceReadError naming no tool"
    );
  });
});
