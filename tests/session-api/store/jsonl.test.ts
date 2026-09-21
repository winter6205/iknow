/**
 * JSONL-as-authority store format.
 *
 * Covers spec session-jsonl-resume Testing Decisions classes that apply to T1:
 *   - empty: new empty session → header + head:null, loads back empty.
 *   - exception: corrupt LAST JSONL line on disk → named EXIT
 *     `drop-trailing-corrupt-line` (drop the bad tail line, still load);
 *     a corrupt NON-trailing line → parse_failed.
 *   - concurrent: the store stays stateless — appendEvents is a primitive that
 *     MUST be called under the hub serialize queue (spec D4); no in-store
 *     locking is added (same posture as save()).
 *
 * On-disk contract locked here:
 *   - save() writes ONLY `<id>.jsonl` (authority: header record, one message
 *     event per message with id/parent chain, trailing head record). The
 *     legacy `<id>.json` mirror is NOT written — #629 closed the
 *     expand-phase compat window.
 *   - load() detects shape by EXTENSION: prefers `<id>.jsonl`, falls back to
 *     legacy `<id>.json` (migration window — #619 T2).
 *   - appendEvents/readHead/writeHead are JSONL-only primitives.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  latestTitleText,
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  serializeSessionLog,
  SessionStore,
  sessionFileToJsonl,
} from "../../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import type {
  SessionFileV1,
  SessionStoreError,
} from "../../../src/session-api/store/index.ts";

let store: SessionStore;
let baseDir: string;
let sessionDir: string;

const userMsg = (text: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const assistantMsg = (text: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const toolResultMsg = (
  toolUseId: string,
  text: string
): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
});

const sampleFile = (opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 => ({
  schemaVersion: CURRENT_SCHEMA_VERSION,
  conversation_id: opts.id,
  title: "",
  cwd: "/tmp/test",
  sanitized_at: "2026-01-01T00:00:00.000Z",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
  checkpoints: [],
  ...opts.overrides,
});

const conversationDir = (id: string): string =>
  resolveConversationDir({ projectDir: sessionDir, conversationId: id });
const jsonlPath = (id: string): string =>
  join(conversationDir(id), `${id}${SESSION_JSONL_EXT}`);
const jsonPath = (id: string): string =>
  join(conversationDir(id), `${id}.json`);

const readJsonlLines = async (id: string): Promise<unknown[]> => {
  const raw = await readFile(jsonlPath(id), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
};

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-jsonl-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// -- pure codec (jsonl.ts) ---------------------------------------------------

describe("sessionFileToJsonl / parseSessionJsonl (pure codec)", () => {
  it("serializes header first, chained message events, head record last", () => {
    const file = sampleFile({
      id: "codec-1",
      overrides: {
        title: "t",
        turnCount: 1,
        messages: [userMsg("q"), assistantMsg("a")],
      },
    });
    const lines = sessionFileToJsonl(file)
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 4);
    assert.equal(lines[0]?.["type"], "session");
    assert.equal(lines[0]?.["conversation_id"], "codec-1");
    assert.equal(lines[0]?.["schemaVersion"], CURRENT_SCHEMA_VERSION);
    assert.equal(lines[0]?.["title"], "t");
    assert.equal(lines[0]?.["cwd"], "/tmp/test");
    assert.equal(lines[0]?.["jsonMode"], false);
    assert.equal(lines[0]?.["turnCount"], 1);
    assert.deepEqual(lines[1], {
      type: "message",
      id: "e0",
      parent: null,
      message: userMsg("q"),
    });
    assert.deepEqual(lines[2], {
      type: "message",
      id: "e1",
      parent: "e0",
      message: assistantMsg("a"),
    });
    assert.deepEqual(lines[3], { type: "head", id: "e1" });
  });

  it("empty session → header + head:null, no message events", () => {
    const file = sampleFile({ id: "codec-empty" });
    const log = parseSessionJsonl(sessionFileToJsonl(file));
    assert.equal(log.events.length, 0);
    assert.equal(log.head, null);
    assert.equal(log.maxEventIndex, -1);
    const projected = projectSessionLog(log);
    assert.deepEqual(projected.messages, []);
    assert.equal(projected.conversation_id, "codec-empty");
  });

  it("round-trips a full SessionFileV1 (messages/checkpoints/goal/workspaceRoot)", () => {
    const file = sampleFile({
      id: "codec-rt",
      overrides: {
        title: "goal title",
        turnCount: 2,
        messages: [userMsg("q"), assistantMsg("a"), userMsg("q2")],
        checkpoints: [
          {
            turnIndex: 0,
            messagesCount: 2,
            interruptedAt: "2026-01-01T00:00:00.000Z",
            interruptReason: "cancelled" as const,
          },
        ],
        goal: {
          text: "ship it",
          source: "user_pin" as const,
          status: "active" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        workspaceRoot: "/tmp/test",
      },
    });
    const projected = projectSessionLog(
      parseSessionJsonl(sessionFileToJsonl(file))
    );
    assert.deepEqual(projected, file);
  });

  it("messageEventId produces the e<index> scheme", () => {
    assert.equal(messageEventId(0), "e0");
    assert.equal(messageEventId(12), "e12");
  });
});

// -- createdAt / messageCreatedAt (rewind prompt timestamps) ------------------

describe("createdAt / messageCreatedAt (prompt timestamps)", () => {
  /** Hand-build a JSONL text with a fixed id space; bypasses sessionFileToJsonl
   *  to let us inject arbitrary createdAt on individual events (appendEvents
   *  stamps per-event in a loop; here we construct the exact ISO strings for
   *  deterministic order assertions). */
  function buildJsonl(
    header: Record<string, unknown>,
    events: ReadonlyArray<Record<string, unknown>>,
    head: string | null
  ): string {
    const lines: string[] = [JSON.stringify({ type: "session", ...header })];
    for (const e of events) {
      lines.push(JSON.stringify({ type: "message", ...e }));
    }
    lines.push(JSON.stringify({ type: "head", id: head }));
    return `${lines.join("\n")}\n`;
  }

  const baseHeader = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: "ts-proj",
    title: "",
    cwd: "/tmp/test",
    sanitized_at: "2026-08-20T00:00:00.000Z",
    jsonMode: false,
    turnCount: 1,
    updatedAt: "2026-08-20T00:00:00.000Z",
    checkpoints: [],
  };

  it("parseSessionJsonl tolerates legacy events without createdAt", () => {
    // Old JSONL written before stamping: no `createdAt` on any event record.
    const raw = buildJsonl(
      baseHeader,
      [
        { id: "e0", parent: null, message: userMsg("q") },
        { id: "e1", parent: "e0", message: assistantMsg("a") },
      ],
      "e1"
    );
    const log = parseSessionJsonl(raw);
    assert.equal(log.events.length, 2);
    assert.equal(log.events[0]!.createdAt, undefined);
    assert.equal(log.events[1]!.createdAt, undefined);
  });

  it("projectSessionLog projects messageCreatedAt absent for fully legacy chains (spread-discipline)", () => {
    // Old chain with zero timestamps → no messageCreatedAt key in projection,
    // preserving byte-identical round-trip with the pre-stamping schema.
    const raw = buildJsonl(
      baseHeader,
      [
        { id: "e0", parent: null, message: userMsg("q") },
        { id: "e1", parent: "e0", message: assistantMsg("a") },
      ],
      "e1"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    assert.equal(
      "messageCreatedAt" in projected,
      false,
      "fully legacy chain must not grow the messageCreatedAt key"
    );
    // Optional-chaining access yields undefined either way (picker contract).
    assert.equal(projected.messageCreatedAt?.[0], undefined);
  });

  it("projectSessionLog collects messageCreatedAt aligned with messages, root → head order", () => {
    // Mixed chain: e0 old (no createdAt), e1..e2 stamped. Conditional emit
    // fires (≥1 defined); the e0 hole surfaces as undefined in the array.
    const raw = buildJsonl(
      baseHeader,
      [
        { id: "e0", parent: null, message: userMsg("q") },
        {
          id: "e1",
          parent: "e0",
          message: assistantMsg("a"),
          createdAt: "2026-08-20T00:00:01.000Z",
        },
        {
          id: "e2",
          parent: "e1",
          message: userMsg("q2"),
          createdAt: "2026-08-20T00:00:05.000Z",
        },
      ],
      "e2"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    assert.deepEqual(projected.messages.length, 3);
    assert.deepEqual(projected.messageCreatedAt, [
      null,
      "2026-08-20T00:00:01.000Z",
      "2026-08-20T00:00:05.000Z",
    ]);
  });

  it("projectSessionLog preserves messageCreatedAt ordering when head chain is non-trivial (forked parent walk)", () => {
    // Hand-built head chain with a missing middle event (e1 is a fork branch
    // not on head; head = e2 → e0). headChainEvents returns [e0, e2].
    const raw = buildJsonl(
      baseHeader,
      [
        {
          id: "e0",
          parent: null,
          message: userMsg("q"),
          createdAt: "2026-08-20T00:00:00.000Z",
        },
        {
          id: "e1",
          parent: "e0",
          message: assistantMsg("orphan"),
          createdAt: "2026-08-20T00:00:01.000Z",
        },
        {
          id: "e2",
          parent: "e0",
          message: assistantMsg("on-head"),
          createdAt: "2026-08-20T00:00:02.000Z",
        },
      ],
      "e2"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    // Head chain root→head = [e0, e2]; e1 is an orphan branch (not on head)
    // and must not surface in the projection — same as messages-only behavior.
    assert.equal(projected.messages.length, 2);
    const texts = projected.messages.map(
      (m) =>
        (
          m.content.find(
            (b): b is Extract<typeof b, { type: "text" }> => b.type === "text"
          ) as { text: string } | undefined
        )?.text ?? ""
    );
    assert.deepEqual(texts, ["q", "on-head"]);
    assert.deepEqual(projected.messageCreatedAt, [
      "2026-08-20T00:00:00.000Z",
      "2026-08-20T00:00:02.000Z",
    ]);
  });

  it("projectSessionLog strips a stale header messageCreatedAt when the head chain has no createdAt (stale-header guard)", () => {
    // Stale-header guard: a stamped save leaves messageCreatedAt in the
    // session header line; a later rewind back into a pre-stamping fork
    // branch walks a chain whose events carry no createdAt. The projection
    // must DROP the stale header array — otherwise the picker joins
    // index-by-index on a misaligned array and reads wrong timestamps.
    const raw = buildJsonl(
      {
        ...baseHeader,
        messageCreatedAt: [
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:00:01.000Z",
          "2020-01-01T00:00:02.000Z",
        ],
      },
      [
        // Chain events all unstamped: the pre-stamping branch rewind landed on.
        { id: "e0", parent: null, message: userMsg("q") },
        { id: "e1", parent: "e0", message: assistantMsg("a") },
      ],
      "e1"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    assert.equal(
      "messageCreatedAt" in projected,
      false,
      "stale header messageCreatedAt must be dropped when no chain event carries createdAt"
    );
    assert.equal(projected.messageCreatedAt?.[0], undefined);
    assert.equal(projected.messageCreatedAt?.[1], undefined);
  });

  it("codec round-trip preserves per-event createdAt → projected messageCreatedAt (verbatim deep-equal)", () => {
    // Pin the Open-Q #2 invariant at the pure-codec layer: parse → project
    // must NOT mutate event records' createdAt — the strings on disk equal
    // the strings the projection exposes via messageCreatedAt. Build a JSONL
    // with every event stamped; the projection's array must deep-equal the
    // disk values. This complements the store-level test that pins the same
    // invariant through save()'s header-refresh path.
    const stamps = [
      "2026-08-20T00:00:00.000Z",
      "2026-08-20T00:00:01.500Z",
      "2026-08-20T00:00:02.250Z",
    ];
    const raw = buildJsonl(
      baseHeader,
      [
        {
          id: "e0",
          parent: null,
          message: userMsg("q"),
          createdAt: stamps[0],
        },
        {
          id: "e1",
          parent: "e0",
          message: assistantMsg("a"),
          createdAt: stamps[1],
        },
        {
          id: "e2",
          parent: "e1",
          message: userMsg("q2"),
          createdAt: stamps[2],
        },
      ],
      "e2"
    );
    const log = parseSessionJsonl(raw);
    // Event records carry the same ISO strings the JSONL bytes declared.
    assert.deepEqual(
      log.events.map((e) => e.createdAt),
      stamps
    );
    const projected = projectSessionLog(log);
    // Projection's messageCreatedAt deep-equals the per-event stamps,
    // aligned root→head with messages.
    assert.deepEqual(projected.messageCreatedAt, stamps);
    assert.equal(projected.messages.length, stamps.length);
  });
});

// -- D2 (tui-display-consistency): thinkingMs parallel array (assistant duration) --

describe("thinkingMs / thinkingMs parallel array (assistant duration)", () => {
  function buildJsonl(
    header: Record<string, unknown>,
    events: ReadonlyArray<Record<string, unknown>>,
    head: string | null
  ): string {
    const lines: string[] = [JSON.stringify({ type: "session", ...header })];
    for (const e of events) {
      lines.push(JSON.stringify({ type: "message", ...e }));
    }
    lines.push(JSON.stringify({ type: "head", id: head }));
    return `${lines.join("\n")}\n`;
  }

  const baseHeader = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: "tm-proj",
    title: "",
    cwd: "/tmp/test",
    sanitized_at: "2026-08-20T00:00:00.000Z",
    jsonMode: false,
    turnCount: 1,
    updatedAt: "2026-08-20T00:00:00.000Z",
    checkpoints: [],
  };

  it("parseSessionJsonl tolerates legacy events without thinkingMs", () => {
    // Legacy JSONL written before D2: no `thinkingMs` on any event record.
    const raw = buildJsonl(
      baseHeader,
      [
        { id: "e0", parent: null, message: userMsg("q") },
        { id: "e1", parent: "e0", message: assistantMsg("a") },
      ],
      "e1"
    );
    const log = parseSessionJsonl(raw);
    assert.equal(log.events.length, 2);
    assert.equal(log.events[0]!.thinkingMs, undefined);
    assert.equal(log.events[1]!.thinkingMs, undefined);
  });

  it("projectSessionLog projects thinkingMs absent for fully legacy chains (spread-discipline)", () => {
    // All-chain without thinkingMs → no `thinkingMs` key in projection,
    // mirroring the messageCreatedAt spread-discipline.
    const raw = buildJsonl(
      baseHeader,
      [
        { id: "e0", parent: null, message: userMsg("q") },
        { id: "e1", parent: "e0", message: assistantMsg("a") },
      ],
      "e1"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    assert.equal(
      "thinkingMs" in projected,
      false,
      "fully legacy chain must not grow the thinkingMs key"
    );
    assert.equal(projected.thinkingMs?.[0], undefined);
    assert.equal(projected.thinkingMs?.[1], undefined);
  });

  it("projectSessionLog collects thinkingMs aligned with messages, root → head order", () => {
    // Mixed chain: e0 user (no thinkingMs), e1 assistant with thinkingMs,
    // e2 user (no thinkingMs). Conditional emit fires; the user holes
    // surface as null in the array (the consumer falls back via ?? undefined).
    const raw = buildJsonl(
      baseHeader,
      [
        { id: "e0", parent: null, message: userMsg("q") },
        {
          id: "e1",
          parent: "e0",
          message: assistantMsg("a"),
          thinkingMs: 1234,
        },
        { id: "e2", parent: "e1", message: userMsg("q2") },
      ],
      "e2"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    assert.equal(projected.messages.length, 3);
    assert.deepEqual(projected.thinkingMs, [null, 1234, null]);
  });

  it("projectSessionLog preserves thinkingMs ordering when head chain is non-trivial (forked parent walk)", () => {
    // Hand-built head chain with a missing middle event (e1 is a fork
    // branch not on head; head = e2 → e0). Head chain root→head = [e0, e2];
    // e1 (orphan assistant with thinkingMs) must NOT surface.
    const raw = buildJsonl(
      baseHeader,
      [
        {
          id: "e0",
          parent: null,
          message: userMsg("q"),
          thinkingMs: 100,
        },
        {
          id: "e1",
          parent: "e0",
          message: assistantMsg("orphan"),
          thinkingMs: 200,
        },
        {
          id: "e2",
          parent: "e0",
          message: assistantMsg("on-head"),
          thinkingMs: 300,
        },
      ],
      "e2"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    assert.equal(projected.messages.length, 2);
    const texts = projected.messages.map(
      (m) =>
        (
          m.content.find(
            (b): b is Extract<typeof b, { type: "text" }> => b.type === "text"
          ) as { text: string } | undefined
        )?.text ?? ""
    );
    assert.deepEqual(texts, ["q", "on-head"]);
    assert.deepEqual(projected.thinkingMs, [100, 300]);
  });

  it("projectSessionLog strips a stale header thinkingMs when the head chain has no thinkingMs (stale-header guard)", () => {
    // Mirror messageCreatedAt stale-header guard: a stamped save leaves
    // thinkingMs in the session header line; a later rewind back into a
    // pre-D2 fork branch walks a chain whose events carry no thinkingMs.
    // The projection must DROP the stale header array — picker joins
    // index-by-index on a misaligned array and would read wrong durations.
    const raw = buildJsonl(
      {
        ...baseHeader,
        thinkingMs: [10, 20, 30],
      },
      [
        { id: "e0", parent: null, message: userMsg("q") },
        { id: "e1", parent: "e0", message: assistantMsg("a") },
      ],
      "e1"
    );
    const projected = projectSessionLog(parseSessionJsonl(raw));
    assert.equal(
      "thinkingMs" in projected,
      false,
      "stale header thinkingMs must be dropped when no chain event carries it"
    );
    assert.equal(projected.thinkingMs?.[0], undefined);
  });

  it("codec round-trip preserves per-event thinkingMs → projected thinkingMs (verbatim deep-equal)", () => {
    // Pin the D2 invariant at the pure-codec layer: parse → project must NOT
    // mutate event records' thinkingMs — the numbers on disk equal the
    // numbers the projection exposes via thinkingMs. Build a JSONL with
    // assistant events stamped; user events carry no thinkingMs (hole, not
    // stored). Projection's array deep-equals the per-event durations,
    // aligned root→head with messages (nulls for user positions).
    const assistantDurations = [100, 250];
    const raw = buildJsonl(
      baseHeader,
      [
        {
          id: "e0",
          parent: null,
          message: userMsg("q"),
        },
        {
          id: "e1",
          parent: "e0",
          message: assistantMsg("a1"),
          thinkingMs: assistantDurations[0],
        },
        {
          id: "e2",
          parent: "e1",
          message: assistantMsg("a2"),
          thinkingMs: assistantDurations[1],
        },
        {
          id: "e3",
          parent: "e2",
          message: userMsg("q2"),
        },
      ],
      "e3"
    );
    const log = parseSessionJsonl(raw);
    // Event records carry the same numbers the JSONL bytes declared on
    // assistant positions; user positions are holes (undefined).
    assert.deepEqual(
      log.events.map((e) => e.thinkingMs),
      [undefined, ...assistantDurations, undefined]
    );
    const projected = projectSessionLog(log);
    // Projection's thinkingMs deep-equals assistant durations at assistant
    // positions, null at user positions, aligned root→head with messages.
    assert.deepEqual(projected.thinkingMs, [null, ...assistantDurations, null]);
    assert.equal(projected.messages.length, 4);
  });

  it("sessionFileToJsonl round-trips SessionFileV1 with thinkingMs parallel array (deep-equal)", () => {
    // Mirror the messageCreatedAt round-trip pin: a file with thinkingMs
    // array → sessionFileToJsonl → parseSessionJsonl → projectSessionLog
    // must produce a byte-equal projection.
    const file = sampleFile({
      id: "tm-rt",
      overrides: {
        messages: [
          userMsg("q"),
          assistantMsg("a"),
          userMsg("q2"),
          assistantMsg("a2"),
        ],
        thinkingMs: [null, 1500, null, 2300],
      },
    });
    const projected = projectSessionLog(
      parseSessionJsonl(sessionFileToJsonl(file))
    );
    assert.deepEqual(projected, file);
  });

  it("sessionFileToJsonl omits thinkingMs key on per-event when value is null or invalid", () => {
    // Boundary filter at sessionFileToJsonl level: events with thinkingMs =
    // null (user / no-think) must NOT carry the key on the event record; same
    // for invalid boundary values (0 / negative / NaN / Infinity).
    const file = sampleFile({
      id: "tm-filter",
      overrides: {
        messages: [userMsg("q"), assistantMsg("a")],
        thinkingMs: [null, NaN],
      },
    });
    const lines = sessionFileToJsonl(file)
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const e1 = lines[1];
    assert.equal(
      "thinkingMs" in (e1 ?? {}),
      false,
      "per-event thinkingMs key must be omitted when null or invalid"
    );
  });
});

// -- save: JSONL authority only ----------------------------------------------

describe("SessionStore.save → JSONL 形态", () => {
  it("writes <id>.jsonl with header/events/head records", async () => {
    const file = sampleFile({
      id: "jl-save",
      overrides: { messages: [userMsg("q"), assistantMsg("a")] },
    });
    await store.save({ id: "jl-save", file });
    const lines = await readJsonlLines("jl-save");
    assert.equal((lines[0] as { type: string }).type, "session");
    assert.equal((lines[1] as { id: string }).id, "e0");
    assert.equal((lines[2] as { parent: string }).parent, "e0");
    assert.deepEqual(lines[3], { type: "head", id: "e1" });
  });

  it("empty session (boundary: empty) writes header + head:null and loads back empty", async () => {
    await store.save({ id: "jl-empty", file: sampleFile({ id: "jl-empty" }) });
    const lines = await readJsonlLines("jl-empty");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[1], { type: "head", id: null });
    const loaded = await store.load("jl-empty");
    assert.deepEqual(loaded.messages, []);
    assert.equal(await store.readHead("jl-empty"), null);
  });
});

// -- load: detection + projection ---------------------------------------------

describe("SessionStore.load — dual-shape detection", () => {
  it("detects shape by extension: prefers <id>.jsonl over <id>.json", async () => {
    const file = sampleFile({
      id: "jl-prefer",
      overrides: { title: "jsonl-title", messages: [userMsg("from-jsonl")] },
    });
    await store.save({ id: "jl-prefer", file });
    // Hand-write a divergent legacy `.json` next to the JSONL authority; load
    // must still return the JSONL projection (authority wins, mirror ignored).
    await writeFile(
      jsonPath("jl-prefer"),
      JSON.stringify(
        sampleFile({
          id: "jl-prefer",
          overrides: { title: "json-title", messages: [userMsg("from-json")] },
        })
      ),
      "utf8"
    );
    const loaded = await store.load("jl-prefer");
    assert.equal(loaded.title, "jsonl-title");
    assert.deepEqual(loaded.messages, [userMsg("from-jsonl")]);
  });

  it("legacy-only <id>.json still loads (no .jsonl present)", async () => {
    await mkdir(conversationDir("jl-legacy"), { recursive: true });
    const legacy = sampleFile({
      id: "jl-legacy",
      overrides: { title: "legacy", messages: [userMsg("old")] },
    });
    await writeFile(jsonPath("jl-legacy"), JSON.stringify(legacy), "utf8");
    const loaded = await store.load("jl-legacy");
    assert.equal(loaded.title, "legacy");
    assert.deepEqual(loaded.messages, [userMsg("old")]);
  });

  it("save writes only JSONL; load returns from the JSONL authority", async () => {
    const file = sampleFile({
      id: "jl-no-mirror",
      overrides: {
        messages: [userMsg("q"), assistantMsg("a")],
        checkpoints: [
          {
            turnIndex: 0,
            messagesCount: 2,
            interruptedAt: "2026-01-01T00:00:00.000Z",
            interruptReason: "timeout" as const,
            // T5 (D3): save derives the event-id anchor from messagesCount
            // (position 2 → e1); load round-trips it.
            anchorEventId: "e1",
          },
        ],
      },
    });
    await store.save({ id: "jl-no-mirror", file });
    // #629: save does not write a `.json` mirror — verify by asserting the
    // file is absent. load returns from the JSONL authority.
    await assert.rejects(stat(jsonPath("jl-no-mirror")));
    const loaded = await store.load("jl-no-mirror");
    assert.deepEqual(loaded, file);
  });
});

// -- exception: corrupt tail (named EXIT: drop-trailing-corrupt-line) ---------

describe("corrupt JSONL (exception EXIT: drop-trailing-corrupt-line)", () => {
  it("drops a corrupt trailing line and still loads the full transcript", async () => {
    const file = sampleFile({
      id: "jl-corrupt-tail",
      overrides: { messages: [userMsg("q"), assistantMsg("a")] },
    });
    await store.save({ id: "jl-corrupt-tail", file });
    await appendFile(
      jsonlPath("jl-corrupt-tail"),
      "{corrupt-partial\n",
      "utf8"
    );
    const loaded = await store.load("jl-corrupt-tail");
    assert.deepEqual(loaded.messages, file.messages);
    assert.equal(await store.readHead("jl-corrupt-tail"), "e1");
  });

  it("a corrupt trailing HEAD record falls back to the previous head", async () => {
    const file = sampleFile({
      id: "jl-corrupt-head",
      overrides: { messages: [userMsg("q"), assistantMsg("a")] },
    });
    await store.save({ id: "jl-corrupt-head", file });
    // Simulate: rewind head landed (e0), then a crash left a partial line.
    await appendFile(
      jsonlPath("jl-corrupt-head"),
      `${JSON.stringify({ type: "head", id: "e0" })}\n{"type":"head","id":`,
      "utf8"
    );
    const loaded = await store.load("jl-corrupt-head");
    assert.deepEqual(loaded.messages, [userMsg("q")]);
    assert.equal(await store.readHead("jl-corrupt-head"), "e0");
  });

  it("throws parse_failed when a NON-trailing line is corrupt", async () => {
    const file = sampleFile({
      id: "jl-corrupt-mid",
      overrides: { messages: [userMsg("q"), assistantMsg("a")] },
    });
    await store.save({ id: "jl-corrupt-mid", file });
    const raw = await readFile(jsonlPath("jl-corrupt-mid"), "utf8");
    const lines = raw.split("\n");
    lines[1] = "{not-json";
    await writeFile(jsonlPath("jl-corrupt-mid"), lines.join("\n"), "utf8");
    await assert.rejects(
      () => store.load("jl-corrupt-mid"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "parse_failed" && e.conversation_id === "jl-corrupt-mid"
        );
      }
    );
  });

  it("throws schema_invalid when the head references an unknown event id", async () => {
    await mkdir(conversationDir("jl-bad-head"), { recursive: true });
    const file = sampleFile({
      id: "jl-bad-head",
      overrides: { messages: [userMsg("q")] },
    });
    const raw = sessionFileToJsonl(file).replace(
      /"id":"e0"\}\n$/,
      '"id":"e99"}\n'
    );
    await writeFile(jsonlPath("jl-bad-head"), raw, "utf8");
    await assert.rejects(
      () => store.load("jl-bad-head"),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "schema_invalid" &&
          e.conversation_id === "jl-bad-head" &&
          e.field === "head"
        );
      }
    );
  });
});

// -- appendEvents (T3 commit-hook primitive) ----------------------------------

describe("SessionStore.appendEvents", () => {
  it("appends events chained from the persisted head WITHOUT rewriting existing bytes", async () => {
    const file = sampleFile({
      id: "jl-append",
      overrides: { messages: [userMsg("q")] },
    });
    await store.save({ id: "jl-append", file });
    const before = await readFile(jsonlPath("jl-append"), "utf8");
    await store.appendEvents({ id: "jl-append", events: [assistantMsg("a")] });
    const after = await readFile(jsonlPath("jl-append"), "utf8");
    assert.ok(
      after.startsWith(before),
      "appendEvents must be append-only (no rewrite)"
    );
    const appended = after
      .slice(before.length)
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    // appendEvents stamps createdAt on each event it writes (prompt
    // timestamps for the rewind picker); the exact instant is nondeterministic
    // so assert shape + validity instead of an exact value.
    const eventRecord = appended[0] as {
      type: string;
      id: string;
      parent: string;
      message: unknown;
      createdAt?: unknown;
    };
    assert.equal(eventRecord.type, "message");
    assert.equal(eventRecord.id, "e1");
    assert.equal(eventRecord.parent, "e0");
    assert.deepEqual(eventRecord.message, assistantMsg("a"));
    assert.equal(typeof eventRecord.createdAt, "string");
    assert.ok(
      !Number.isNaN(new Date(eventRecord.createdAt as string).getTime())
    );
    assert.deepEqual(appended[1], { type: "head", id: "e1" });
    const loaded = await store.load("jl-append");
    assert.deepEqual(loaded.messages, [userMsg("q"), assistantMsg("a")]);
    assert.equal(await store.readHead("jl-append"), "e1");
  });

  it("chains repeatedly: each append parents to the previous head", async () => {
    const file = sampleFile({
      id: "jl-append-chain",
      overrides: { messages: [userMsg("q")] },
    });
    await store.save({ id: "jl-append-chain", file });
    await store.appendEvents({
      id: "jl-append-chain",
      events: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu1", name: "bash", input: { cmd: "ls" } },
          ],
        },
      ],
    });
    await store.appendEvents({
      id: "jl-append-chain",
      events: [toolResultMsg("tu1", "ok")],
    });
    const lines = await readJsonlLines("jl-append-chain");
    const events = lines.filter(
      (l): l is { type: "message"; id: string; parent: string | null } =>
        (l as { type: string }).type === "message"
    );
    assert.deepEqual(
      events.map((e) => [e.id, e.parent]),
      [
        ["e0", null],
        ["e1", "e0"],
        ["e2", "e1"],
      ]
    );
    const loaded = await store.load("jl-append-chain");
    assert.equal(loaded.messages.length, 3);
    assert.equal(loaded.messages[2], loaded.messages[2]); // tool_result present
    assert.deepEqual(loaded.messages[2], toolResultMsg("tu1", "ok"));
  });

  it("is a no-op for an empty events array (bytes unchanged)", async () => {
    const file = sampleFile({
      id: "jl-append-noop",
      overrides: { messages: [userMsg("q")] },
    });
    await store.save({ id: "jl-append-noop", file });
    const before = await readFile(jsonlPath("jl-append-noop"), "utf8");
    await store.appendEvents({ id: "jl-append-noop", events: [] });
    const after = await readFile(jsonlPath("jl-append-noop"), "utf8");
    assert.equal(after, before);
  });

  it("throws not_found when no session file exists", async () => {
    await assert.rejects(
      () =>
        store.appendEvents({ id: "jl-append-missing", events: [userMsg("x")] }),
      (err: unknown) =>
        (err as SessionStoreError).kind === "not_found" &&
        (err as SessionStoreError).conversation_id === "jl-append-missing"
    );
  });

  it("throws write_failed when only a legacy .json exists (save once to migrate)", async () => {
    await mkdir(conversationDir("jl-append-legacy"), { recursive: true });
    await writeFile(
      jsonPath("jl-append-legacy"),
      JSON.stringify(sampleFile({ id: "jl-append-legacy" })),
      "utf8"
    );
    await assert.rejects(
      () =>
        store.appendEvents({ id: "jl-append-legacy", events: [userMsg("x")] }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "write_failed" &&
          e.conversation_id === "jl-append-legacy" &&
          /legacy JSON/.test(e.cause)
        );
      }
    );
  });

  it("after a backward writeHead, appended events fork from the head (old chain retained)", async () => {
    const file = sampleFile({
      id: "jl-fork",
      overrides: {
        messages: [userMsg("q1"), assistantMsg("a1"), userMsg("q2")],
      },
    });
    await store.save({ id: "jl-fork", file });
    await store.writeHead({ id: "jl-fork", head: "e0" });
    await store.appendEvents({
      id: "jl-fork",
      events: [assistantMsg("a1-alt")],
    });
    const loaded = await store.load("jl-fork");
    assert.deepEqual(loaded.messages, [userMsg("q1"), assistantMsg("a1-alt")]);
    // Old chain events are retained on disk (append-only, fork preserved).
    const lines = await readJsonlLines("jl-fork");
    const eventIds = lines
      .filter((l) => (l as { type: string }).type === "message")
      .map((l) => (l as { id: string }).id);
    assert.deepEqual(eventIds, ["e0", "e1", "e2", "e3"]);
    // The fork event gets a FRESH id (max index + 1), parented at the head.
    const fork = lines[lines.length - 2] as {
      type: string;
      id: string;
      parent: string;
    };
    assert.equal(fork.id, "e3");
    assert.equal(fork.parent, "e0");
  });
});

// -- readHead / writeHead (T5 primitives) -------------------------------------

describe("SessionStore.readHead / writeHead", () => {
  it("writeHead appends a head record; load projects the transcript at that head", async () => {
    const file = sampleFile({
      id: "jl-head",
      overrides: {
        messages: [userMsg("q1"), assistantMsg("a1"), userMsg("q2")],
      },
    });
    await store.save({ id: "jl-head", file });
    await store.writeHead({ id: "jl-head", head: "e0" });
    assert.equal(await store.readHead("jl-head"), "e0");
    const loaded = await store.load("jl-head");
    assert.deepEqual(loaded.messages, [userMsg("q1")]);
    // Skipped events stay in the same JSONL (append-only, no truncation).
    const lines = await readJsonlLines("jl-head");
    assert.equal(
      lines.filter((l) => (l as { type: string }).type === "message").length,
      3
    );
  });

  it("writeHead null → load projects an empty transcript", async () => {
    const file = sampleFile({
      id: "jl-head-null",
      overrides: { messages: [userMsg("q1")] },
    });
    await store.save({ id: "jl-head-null", file });
    await store.writeHead({ id: "jl-head-null", head: null });
    assert.equal(await store.readHead("jl-head-null"), null);
    const loaded = await store.load("jl-head-null");
    assert.deepEqual(loaded.messages, []);
  });

  it("writeHead to an unknown event id → schema_invalid field 'head'", async () => {
    const file = sampleFile({
      id: "jl-head-unknown",
      overrides: { messages: [userMsg("q1")] },
    });
    await store.save({ id: "jl-head-unknown", file });
    await assert.rejects(
      () => store.writeHead({ id: "jl-head-unknown", head: "e42" }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return (
          e.kind === "schema_invalid" &&
          e.conversation_id === "jl-head-unknown" &&
          e.field === "head"
        );
      }
    );
  });

  it("readHead/writeHead on a missing session → not_found", async () => {
    await assert.rejects(
      () => store.readHead("jl-head-missing"),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
    await assert.rejects(
      () => store.writeHead({ id: "jl-head-missing", head: null }),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });
});

// -- list / delete across both shapes -----------------------------------------

describe("SessionStore.list/delete with both on-disk shapes", () => {
  it("list() returns JSONL and legacy sessions, deduping ids present in both", async () => {
    const withReply = (id: string) =>
      sampleFile({
        id,
        overrides: { messages: [userMsg("q"), assistantMsg(`reply-${id}`)] },
      });
    await store.save({ id: "jl-list-dual", file: withReply("jl-list-dual") });
    await mkdir(conversationDir("jl-list-legacy"), { recursive: true });
    await writeFile(
      jsonPath("jl-list-legacy"),
      JSON.stringify(withReply("jl-list-legacy")),
      "utf8"
    );
    const entries = await store.list();
    const dual = entries.filter((e) => e.conversation_id === "jl-list-dual");
    assert.equal(dual.length, 1);
    assert.equal(dual[0]?.lastFinalText, "reply-jl-list-dual");
    assert.ok(
      entries.some((e) => e.conversation_id === "jl-list-legacy"),
      "legacy-only session must be listed"
    );
  });

  it("list() skips a middle-corrupt JSONL session but keeps tail-corrupt ones", async () => {
    const withReply = (id: string) =>
      sampleFile({
        id,
        overrides: { messages: [userMsg("q"), assistantMsg("reply")] },
      });
    await store.save({
      id: "jl-list-midcorrupt",
      file: withReply("jl-list-midcorrupt"),
    });
    const raw = await readFile(jsonlPath("jl-list-midcorrupt"), "utf8");
    const lines = raw.split("\n");
    lines[1] = "{bad";
    await writeFile(jsonlPath("jl-list-midcorrupt"), lines.join("\n"), "utf8");
    await store.save({
      id: "jl-list-tailcorrupt",
      file: withReply("jl-list-tailcorrupt"),
    });
    await appendFile(jsonlPath("jl-list-tailcorrupt"), "{bad\n", "utf8");
    const entries = await store.list();
    assert.ok(!entries.some((e) => e.conversation_id === "jl-list-midcorrupt"));
    assert.ok(entries.some((e) => e.conversation_id === "jl-list-tailcorrupt"));
  });

  it("delete() removes the JSONL authority; load → not_found", async () => {
    await store.save({
      id: "jl-del",
      file: sampleFile({
        id: "jl-del",
        overrides: { messages: [userMsg("q")] },
      }),
    });
    await stat(jsonlPath("jl-del"));
    await store.delete("jl-del");
    await assert.rejects(stat(jsonlPath("jl-del")));
    await assert.rejects(
      () => store.load("jl-del"),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });

  it("delete() on a legacy-only session still works", async () => {
    await mkdir(conversationDir("jl-del-legacy"), { recursive: true });
    await writeFile(
      jsonPath("jl-del-legacy"),
      JSON.stringify(sampleFile({ id: "jl-del-legacy" })),
      "utf8"
    );
    await store.delete("jl-del-legacy");
    await assert.rejects(stat(jsonPath("jl-del-legacy")));
  });
});

// -- title events (session-list-title T3 / ADR-0113) --------------------------

describe("title event records (ADR-0113: 标题事件权威, header title 缓存)", () => {
  const headerLine = (title: string): string =>
    JSON.stringify({
      type: "session",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: "t3-pure",
      title,
      cwd: "/tmp/test",
      sanitized_at: "2026-01-01T00:00:00.000Z",
      jsonMode: false,
      turnCount: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      checkpoints: [],
    });
  const eventLine = (
    id: string,
    parent: string | null,
    message: AnthropicNativeMessage
  ): string => JSON.stringify({ type: "message", id, parent, message });
  const headLine = (id: string | null): string =>
    JSON.stringify({ type: "head", id });
  const titleLine = (text: string): string =>
    JSON.stringify({ type: "title", text });

  it("parseSessionJsonl 接受 title 记录并进 records 尾部（不影响 head 链）", () => {
    const raw = [
      headerLine("占位"),
      eventLine("e0", null, userMsg("q")),
      headLine("e0"),
      titleLine("事件标题"),
      headLine("e0"),
    ].join("\n");
    const log = parseSessionJsonl(`${raw}\n`);
    assert.equal(log.head, "e0");
    assert.equal(log.events.length, 1);
    assert.equal(latestTitleText(log), "事件标题");
    // records keep the title record verbatim (serializeSessionLog round-trip relies on it).
    const kinds = log.records.map((r) => r.type);
    assert.deepEqual(kinds, ["message", "head", "title", "head"]);
  });

  it("latestTitleText: 无 title 事件 → null; 多事件取文件序最后一条", () => {
    const noTitle = parseSessionJsonl(
      [
        headerLine("占位"),
        eventLine("e0", null, userMsg("q")),
        headLine("e0"),
      ].join("\n") + "\n"
    );
    assert.equal(latestTitleText(noTitle), null);
    const twoTitles = parseSessionJsonl(
      [
        headerLine("占位"),
        eventLine("e0", null, userMsg("q")),
        headLine("e0"),
        titleLine("第一版"),
        titleLine("第二版"),
      ].join("\n") + "\n"
    );
    assert.equal(latestTitleText(twoTitles), "第二版");
  });

  it("title 记录 text 非 string → schema_invalid field type（未知形状拒绝纪律）", () => {
    assert.throws(
      () =>
        parseSessionJsonl(
          [
            headerLine("占位"),
            eventLine("e0", null, userMsg("q")),
            headLine("e0"),
            JSON.stringify({ type: "title", text: 42 }),
          ].join("\n") + "\n"
        ),
      (err: unknown) => {
        const e = err as { kind: string; field: string };
        return e.kind === "schema_invalid" && e.field === "type";
      }
    );
  });

  it("projectSessionLog: title 事件覆盖 header title 且不进 messages", () => {
    const log = parseSessionJsonl(
      [
        headerLine("旧缓存"),
        eventLine("e0", null, userMsg("q")),
        eventLine("e1", "e0", assistantMsg("a")),
        headLine("e1"),
        titleLine("事件标题"),
      ].join("\n") + "\n"
    );
    const file = projectSessionLog(log);
    assert.equal(file.title, "事件标题");
    assert.equal(file.messages.length, 2);
    // title-event bodies must never leak into transcript messages.
    assert.ok(
      !JSON.stringify(file.messages).includes("事件标题"),
      "title 事件不得投影进 messages"
    );
  });

  it("projectSessionLog: 无 title 事件 → header title 原样（旧文件行为不变）", () => {
    const file = sampleFile({
      id: "codec-empty",
      overrides: { title: "占位标题", messages: [userMsg("q")] },
    });
    const projected = projectSessionLog(
      parseSessionJsonl(sessionFileToJsonl(file))
    );
    assert.equal(projected.title, "占位标题");
    assert.deepEqual(projected, file);
  });

  it("serializeSessionLog 原样透传 title 记录（字节稳定）", () => {
    const records = [
      {
        type: "message",
        id: "e0",
        parent: null,
        message: userMsg("q"),
      },
      { type: "head", id: "e0" },
      { type: "title", text: "事件标题" },
    ] as const;
    const text = serializeSessionLog(
      {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: "t3-ser",
        title: "缓存",
        cwd: "/tmp/test",
        sanitized_at: "2026-01-01T00:00:00.000Z",
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        checkpoints: [],
      },
      records as unknown as Parameters<typeof serializeSessionLog>[1]
    );
    assert.equal(
      text.split("\n")[3],
      JSON.stringify({ type: "title", text: "事件标题" })
    );
  });

  it("title 行作为损坏前一行时 drop-trailing-corrupt-line 仍生效", () => {
    const raw = [
      headerLine("占位"),
      eventLine("e0", null, userMsg("q")),
      headLine("e0"),
      titleLine("事件标题"),
      "{bad",
    ].join("\n");
    const log = parseSessionJsonl(`${raw}\n`);
    assert.equal(latestTitleText(log), "事件标题");
  });
});
