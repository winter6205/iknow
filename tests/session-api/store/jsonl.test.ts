/**
 * T1 (#618): JSONL 形态与旧 JSON 并存可读。
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
 *   - save() writes `<id>.jsonl` (authority: header record, one message event
 *     per message with id/parent chain, trailing head record) AND keeps
 *     writing the legacy `<id>.json` mirror (expand-phase compat for direct
 *     `.json` readers; T2 owns migration-on-save).
 *   - load() detects shape by EXTENSION: prefers `<id>.jsonl`, falls back to
 *     legacy `<id>.json`.
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
  messageEventId,
  parseSessionJsonl,
  projectSessionLog,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
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

const jsonlPath = (id: string): string =>
  join(sessionDir, `${id}${SESSION_JSONL_EXT}`);
const jsonPath = (id: string): string => join(sessionDir, `${id}.json`);

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
  store = new SessionStore(baseDir);
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

// -- save: JSONL authority + legacy mirror ------------------------------------

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

  it("still writes the legacy <id>.json mirror (expand-phase compat)", async () => {
    const file = sampleFile({
      id: "jl-mirror",
      overrides: { messages: [userMsg("q"), assistantMsg("a")] },
    });
    await store.save({ id: "jl-mirror", file });
    const raw = JSON.parse(await readFile(jsonPath("jl-mirror"), "utf8"));
    assert.deepEqual(raw, JSON.parse(JSON.stringify(file)));
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
    // Overwrite the legacy mirror with divergent content; load must still
    // return the JSONL projection (authority wins).
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
    await mkdir(sessionDir, { recursive: true });
    const legacy = sampleFile({
      id: "jl-legacy",
      overrides: { title: "legacy", messages: [userMsg("old")] },
    });
    await writeFile(jsonPath("jl-legacy"), JSON.stringify(legacy), "utf8");
    const loaded = await store.load("jl-legacy");
    assert.equal(loaded.title, "legacy");
    assert.deepEqual(loaded.messages, [userMsg("old")]);
  });

  it("loads from .jsonl alone when the .json mirror is deleted", async () => {
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
          },
        ],
      },
    });
    await store.save({ id: "jl-no-mirror", file });
    await rm(jsonPath("jl-no-mirror"));
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
    await mkdir(sessionDir, { recursive: true });
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
    assert.deepEqual(appended, [
      { type: "message", id: "e1", parent: "e0", message: assistantMsg("a") },
      { type: "head", id: "e1" },
    ]);
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
    await mkdir(sessionDir, { recursive: true });
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
    await mkdir(sessionDir, { recursive: true });
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

  it("delete() removes both .jsonl and .json; load → not_found", async () => {
    await store.save({
      id: "jl-del",
      file: sampleFile({
        id: "jl-del",
        overrides: { messages: [userMsg("q")] },
      }),
    });
    await stat(jsonlPath("jl-del"));
    await stat(jsonPath("jl-del"));
    await store.delete("jl-del");
    await assert.rejects(stat(jsonlPath("jl-del")));
    await assert.rejects(stat(jsonPath("jl-del")));
    await assert.rejects(
      () => store.load("jl-del"),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });

  it("delete() on a legacy-only session still works", async () => {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      jsonPath("jl-del-legacy"),
      JSON.stringify(sampleFile({ id: "jl-del-legacy" })),
      "utf8"
    );
    await store.delete("jl-del-legacy");
    await assert.rejects(stat(jsonPath("jl-del-legacy")));
  });
});
