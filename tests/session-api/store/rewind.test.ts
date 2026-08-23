/**
 * T5 (#622 / spec session-jsonl-resume): rewind 改 head、旧链保留。
 *
 * Locked here (store level):
 *   - rewindToAnchor moves the persisted head pointer to an earlier
 *     user-message anchor — NO file truncation; the skipped chain stays in
 *     the same JSONL, across subsequent saves.
 *   - save is append-only aware: after a rewind, the next save must NOT
 *     rewrite the log from the head projection (that would wipe the skipped
 *     branch). New events append with fresh ids (maxEventIndex+1), parented
 *     by the current head.
 *   - checkpoints re-anchor by event id (spec D3): save derives
 *     anchorEventId from messagesCount against the final chain; load
 *     migrates legacy messagesCount-only checkpoints the same way.
 *   - legacy `.json`-only sessions make rewindToAnchor throw write_failed
 *     (the hub's migration-retry signal), never truncate the legacy file.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import type {
  CheckpointRecord,
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

const readLog = async (id: string) =>
  parseSessionJsonl(await readFile(jsonlPath(id), "utf8"));

/** 3-turn session: [q1,a1,q2,a2,q3,a3] → events e0..e5, head e5. */
const threeTurnMessages = (): AnthropicNativeMessage[] => [
  userMsg("q1"),
  assistantMsg("a1"),
  userMsg("q2"),
  assistantMsg("a2"),
  userMsg("q3"),
  assistantMsg("a3"),
];

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-rewind-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// -- rewindToAnchor: head move, no truncation ---------------------------------

describe("SessionStore.rewindToAnchor (T5 head move)", () => {
  it("rewind to an earlier anchor → reload: head is the anchor; skipped events stay in the same JSONL", async () => {
    const id = "rw-basic";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });

    const { file } = await store.rewindToAnchor({ id, keepTurns: 1 });

    // Returned projection: turn 0 only, metadata recomputed (rewindFile parity).
    assert.deepEqual(file.messages, [userMsg("q1"), assistantMsg("a1")]);
    assert.equal(file.turnCount, 1);
    assert.equal(file.title, "q1");

    // Reload sees the same head (cross-entry consistency, #120 Q6).
    assert.equal(await store.readHead(id), "e1");
    const loaded = await store.load(id);
    assert.deepEqual(loaded.messages, [userMsg("q1"), assistantMsg("a1")]);
    assert.equal(loaded.turnCount, 1);

    // The skipped chain stays in the SAME jsonl: all 6 events retained.
    const log = await readLog(id);
    assert.equal(log.events.length, 6);
    assert.equal(log.head, "e1");
  });

  it("keepTurns=0 → head null, empty projection, all events retained", async () => {
    const id = "rw-zero";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          messages: [userMsg("q1"), assistantMsg("a1")],
          turnCount: 1,
        },
      }),
    });
    const { file } = await store.rewindToAnchor({ id, keepTurns: 0 });
    assert.deepEqual(file.messages, []);
    assert.equal(file.turnCount, 0);
    assert.equal(await store.readHead(id), null);
    const log = await readLog(id);
    assert.equal(log.events.length, 2);
    assert.deepEqual((await store.load(id)).messages, []);
  });

  it("keepTurns >= available → no-op: head unchanged, no new event/head records", async () => {
    const id = "rw-noop";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    const before = await readFile(jsonlPath(id), "utf8");
    const { file } = await store.rewindToAnchor({ id, keepTurns: 99 });
    assert.equal(file.messages.length, 6);
    assert.equal(file.turnCount, 3);
    assert.equal(await store.readHead(id), "e5");
    const after = await readFile(jsonlPath(id), "utf8");
    assert.equal(
      after.split("\n").filter((l) => l.trim().length > 0).length,
      before.split("\n").filter((l) => l.trim().length > 0).length,
      "no-op rewind must not append event/head records"
    );
  });

  it("prunes checkpoints past the anchor and re-anchors survivors by event id", async () => {
    const id = "rw-checkpoints";
    const checkpoints: CheckpointRecord[] = [
      {
        turnIndex: 1,
        messagesCount: 2,
        interruptedAt: "2026-01-01T00:00:00.000Z",
        interruptReason: "cancelled",
      },
      {
        turnIndex: 3,
        messagesCount: 6,
        interruptedAt: "2026-01-01T00:00:02.000Z",
        interruptReason: "timeout",
      },
    ];
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3, checkpoints },
      }),
    });
    const { file } = await store.rewindToAnchor({ id, keepTurns: 2 });
    // turnIndex 3 describes a skipped turn → pruned; turnIndex 1 survives and
    // is re-anchored to the event at chain position messagesCount-1 (= e1).
    assert.deepEqual(file.checkpoints, [
      {
        turnIndex: 1,
        messagesCount: 2,
        interruptedAt: "2026-01-01T00:00:00.000Z",
        interruptReason: "cancelled",
        anchorEventId: "e1",
      },
    ]);
    // Reload derives the same anchor (header carries it; load re-validates).
    const loaded = await store.load(id);
    assert.deepEqual(loaded.checkpoints, file.checkpoints);
  });

  it("mirror reflects the rewound projection (compat mirror, not authority)", async () => {
    const id = "rw-mirror";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    await store.rewindToAnchor({ id, keepTurns: 1 });
    const mirror = JSON.parse(await readFile(jsonPath(id), "utf8"));
    assert.equal(mirror.messages.length, 2);
    assert.equal(mirror.turnCount, 1);
  });

  it("legacy .json-only session → write_failed (migration signal; legacy file untouched)", async () => {
    const id = "rw-legacy";
    await mkdir(sessionDir, { recursive: true });
    const legacy = sampleFile({
      id,
      overrides: { messages: threeTurnMessages(), turnCount: 3 },
    });
    await writeFile(jsonPath(id), JSON.stringify(legacy), "utf8");
    await assert.rejects(
      () => store.rewindToAnchor({ id, keepTurns: 1 }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return e.kind === "write_failed" && e.conversation_id === id;
      }
    );
    // Legacy file NOT truncated/rewritten by the failed rewind.
    const raw = JSON.parse(await readFile(jsonPath(id), "utf8"));
    assert.equal(raw.messages.length, 6);
  });

  it("missing session → not_found", async () => {
    await assert.rejects(
      () => store.rewindToAnchor({ id: "rw-missing", keepTurns: 1 }),
      (err: unknown) => (err as SessionStoreError).kind === "not_found"
    );
  });
});

describe("SessionStore.rewindToHead + listRewindTargets (#624)", () => {
  it("rewindToHead to a skipped-branch turn end restores that ancestor chain; events retained", async () => {
    const id = "rw-head-undo";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    await store.rewindToAnchor({ id, keepTurns: 1 });
    assert.equal(await store.readHead(id), "e1");

    const { file } = await store.rewindToHead({ id, head: "e5" });
    assert.deepEqual(file.messages, threeTurnMessages());
    assert.equal(file.turnCount, 3);
    assert.equal(await store.readHead(id), "e5");
    const log = await readLog(id);
    assert.equal(log.events.length, 6);
  });

  it("listRewindTargets after rewind lists only main-line user messages", async () => {
    const id = "rw-list-skipped";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    const before = await store.listRewindTargets(id);
    assert.deepEqual(
      before.map((t) => t.head),
      [null, "e1", "e3"],
      "each user prompt rewinds to its parent (before that prompt)"
    );
    assert.equal(
      before.every((t) => t.fillInput),
      true
    );

    await store.rewindToAnchor({ id, keepTurns: 1 });
    const targets = await store.listRewindTargets(id);
    assert.deepEqual(
      targets.map((t) => t.userMessageText),
      ["q1"]
    );
    assert.equal(
      targets.some(
        (t) => t.userMessageText === "q2" || t.userMessageText === "q3"
      ),
      false,
      "skipped-branch prompts (and their timestamps) must leave the picker"
    );
    assert.equal(targets[0]?.fillInput, true);
  });

  it("unknown head → schema_invalid", async () => {
    const id = "rw-head-unknown";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    await assert.rejects(
      () => store.rewindToHead({ id, head: "e99" }),
      (err: unknown) =>
        (err as SessionStoreError).kind === "schema_invalid" &&
        (err as SessionStoreError & { field: string }).field === "head"
    );
  });
});

// -- save: append-only awareness (fork preservation across saves) --------------

describe("SessionStore.save — append-only aware (T5 fork preservation)", () => {
  it("rewind → save(loaded projection) → skipped branch STILL in the file (no rewrite-from-projection)", async () => {
    const id = "rw-save-identical";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    await store.rewindToAnchor({ id, keepTurns: 1 });
    const loaded = await store.load(id);
    // A metadata-only save (what conditionalSave does when nothing new
    // arrived): must NOT rewrite the log from the 2-message projection.
    await store.save({ id, file: loaded });
    const log = await readLog(id);
    assert.equal(
      log.events.length,
      6,
      "skipped branch events must survive a post-rewind save"
    );
    assert.equal(log.head, "e1", "head stays at the rewound anchor");
    assert.deepEqual((await store.load(id)).messages, [
      userMsg("q1"),
      assistantMsg("a1"),
    ]);
  });

  it("rewind → save(extended projection) → new events append parented at the rewound head; skipped branch retained", async () => {
    const id = "rw-save-extension";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    await store.rewindToAnchor({ id, keepTurns: 1 });
    const loaded = await store.load(id);
    await store.save({
      id,
      file: {
        ...loaded,
        messages: [...loaded.messages, userMsg("q4"), assistantMsg("a4")],
        turnCount: 2,
      },
    });
    const log = await readLog(id);
    // 6 old + 2 new; the new chain forks from the rewound head e1 with FRESH
    // ids continuing from maxEventIndex.
    assert.equal(log.events.length, 8);
    const byId = new Map(log.events.map((e) => [e.id, e]));
    assert.equal(byId.get("e6")?.parent, "e1");
    assert.deepEqual(byId.get("e6")?.message, userMsg("q4"));
    assert.equal(byId.get("e7")?.parent, "e6");
    assert.equal(log.head, "e7");
    // Skipped branch (e2..e5) retained.
    for (const skipped of ["e2", "e3", "e4", "e5"]) {
      assert.ok(byId.has(skipped), `skipped event ${skipped} retained`);
    }
    assert.deepEqual((await store.load(id)).messages, [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q4"),
      assistantMsg("a4"),
    ]);
  });

  it("rewind → appendEvents → new events parent from the rewound head; skipped branch retained", async () => {
    const id = "rw-append";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    await store.rewindToAnchor({ id, keepTurns: 1 });
    await store.appendEvents({
      id,
      events: [userMsg("q4"), assistantMsg("a4")],
    });
    const log = await readLog(id);
    assert.equal(log.events.length, 8);
    const byId = new Map(log.events.map((e) => [e.id, e]));
    assert.equal(byId.get("e6")?.parent, "e1");
    assert.equal(byId.get("e7")?.parent, "e6");
    assert.equal(log.head, "e7");
    assert.equal(byId.has("e2") && byId.has("e5"), true);
  });

  it("divergent save forks from the longest-common-prefix boundary; abandoned suffix retained", async () => {
    const id = "rw-save-diverge";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          messages: [
            userMsg("q1"),
            assistantMsg("a1"),
            userMsg("q2"),
            assistantMsg("a2"),
          ],
          turnCount: 2,
        },
      }),
    });
    // Compact-shaped rewrite: same first turn, divergent second.
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          messages: [
            userMsg("q1"),
            assistantMsg("a1"),
            userMsg("q2b"),
            assistantMsg("a2b"),
          ],
          turnCount: 2,
        },
      }),
    });
    const log = await readLog(id);
    assert.equal(log.events.length, 6);
    const byId = new Map(log.events.map((e) => [e.id, e]));
    // New branch parents at the LCP end (e1), fresh ids, old suffix retained.
    assert.equal(byId.get("e4")?.parent, "e1");
    assert.equal(byId.get("e5")?.parent, "e4");
    assert.equal(log.head, "e5");
    assert.ok(byId.has("e2") && byId.has("e3"), "abandoned suffix retained");
    assert.deepEqual((await store.load(id)).messages, [
      userMsg("q1"),
      assistantMsg("a1"),
      userMsg("q2b"),
      assistantMsg("a2b"),
    ]);
  });

  it("strict-prefix save (reset-shaped) moves the head back without appending events", async () => {
    const id = "rw-save-prefix";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    const loaded = await store.load(id);
    await store.save({
      id,
      file: { ...loaded, messages: [], turnCount: 0, checkpoints: [] },
    });
    const log = await readLog(id);
    assert.equal(log.events.length, 6, "no events dropped, none appended");
    assert.equal(log.head, null);
    assert.deepEqual((await store.load(id)).messages, []);
  });

  it("full divergence (compact to a brand-new root) parents the new chain at null", async () => {
    const id = "rw-save-reroot";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: threeTurnMessages(), turnCount: 3 },
      }),
    });
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          messages: [userMsg("compacted summary"), assistantMsg("ok")],
          turnCount: 1,
        },
      }),
    });
    const log = await readLog(id);
    assert.equal(log.events.length, 8);
    const byId = new Map(log.events.map((e) => [e.id, e]));
    assert.equal(byId.get("e6")?.parent, null);
    assert.equal(byId.get("e7")?.parent, "e6");
    assert.equal(log.head, "e7");
    assert.deepEqual((await store.load(id)).messages, [
      userMsg("compacted summary"),
      assistantMsg("ok"),
    ]);
  });

  it("corrupt jsonl (non-trailing) → save self-heals with a full rewrite from the given file", async () => {
    const id = "rw-save-corrupt";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: [userMsg("q1"), assistantMsg("a1")] },
      }),
    });
    const raw = await readFile(jsonlPath(id), "utf8");
    const lines = raw.split("\n");
    lines[1] = "{not-json";
    await writeFile(jsonlPath(id), lines.join("\n"), "utf8");
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: { messages: [userMsg("q1"), assistantMsg("a1")] },
      }),
    });
    assert.deepEqual((await store.load(id)).messages, [
      userMsg("q1"),
      assistantMsg("a1"),
    ]);
  });
});

// -- checkpoint anchor migration (spec D3) -------------------------------------

describe("checkpoint anchor by event id (T5 D3)", () => {
  it("save derives anchorEventId from messagesCount against the final chain", async () => {
    const id = "rw-anchor-save";
    await store.save({
      id,
      file: sampleFile({
        id,
        overrides: {
          messages: threeTurnMessages(),
          turnCount: 3,
          checkpoints: [
            {
              turnIndex: 2,
              messagesCount: 4,
              interruptedAt: "2026-01-01T00:00:01.000Z",
              interruptReason: "cancelled",
            },
          ],
        },
      }),
    });
    const loaded = await store.load(id);
    assert.equal(loaded.checkpoints?.[0]?.anchorEventId, "e3");
    // The mirror carries the derived anchor too (mirror/header consistency).
    const mirror = JSON.parse(await readFile(jsonPath(id), "utf8"));
    assert.equal(mirror.checkpoints[0].anchorEventId, "e3");
  });

  it("load migrates legacy messagesCount-only checkpoints in a hand-written jsonl header", async () => {
    const id = "rw-anchor-migrate";
    await mkdir(sessionDir, { recursive: true });
    const header = {
      type: "session",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversation_id: id,
      title: "q1",
      cwd: "/tmp/test",
      sanitized_at: "2026-01-01T00:00:00.000Z",
      jsonMode: false,
      turnCount: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
      checkpoints: [
        {
          turnIndex: 1,
          messagesCount: 2,
          interruptedAt: "2026-01-01T00:00:00.000Z",
          interruptReason: "cancelled",
        },
      ],
    };
    const lines = [
      JSON.stringify(header),
      JSON.stringify({
        type: "message",
        id: "e0",
        parent: null,
        message: userMsg("q1"),
      }),
      JSON.stringify({
        type: "message",
        id: "e1",
        parent: "e0",
        message: assistantMsg("a1"),
      }),
      JSON.stringify({
        type: "message",
        id: "e2",
        parent: "e1",
        message: userMsg("q2"),
      }),
      JSON.stringify({ type: "head", id: "e2" }),
    ];
    await writeFile(jsonlPath(id), `${lines.join("\n")}\n`, "utf8");
    const loaded = await store.load(id);
    assert.equal(loaded.checkpoints?.[0]?.anchorEventId, "e1");
  });

  it("legacy .json load derives anchorEventId from the message position", async () => {
    const id = "rw-anchor-legacy";
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      jsonPath(id),
      JSON.stringify(
        sampleFile({
          id,
          overrides: {
            messages: threeTurnMessages(),
            turnCount: 3,
            checkpoints: [
              {
                turnIndex: 2,
                messagesCount: 4,
                interruptedAt: "2026-01-01T00:00:01.000Z",
                interruptReason: "timeout",
              },
            ],
          },
        })
      ),
      "utf8"
    );
    const loaded = await store.load(id);
    assert.equal(loaded.checkpoints?.[0]?.anchorEventId, "e3");
  });

  it("out-of-range messagesCount → checkpoint kept, anchorEventId absent", async () => {
    const id = "rw-anchor-dangling";
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      jsonPath(id),
      JSON.stringify(
        sampleFile({
          id,
          overrides: {
            messages: [userMsg("q1"), assistantMsg("a1")],
            turnCount: 1,
            checkpoints: [
              {
                turnIndex: 5,
                messagesCount: 99,
                interruptedAt: "2026-01-01T00:00:01.000Z",
                interruptReason: "cancelled",
              },
            ],
          },
        })
      ),
      "utf8"
    );
    const loaded = await store.load(id);
    assert.equal(loaded.checkpoints?.length, 1);
    assert.equal(loaded.checkpoints?.[0]?.anchorEventId, undefined);
  });
});
