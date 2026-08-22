/**
 * T2 (#619 / spec session-jsonl-resume D7): 旧 JSON 在下一次 save 迁成 JSONL。
 *
 * Migration trigger point: SessionStore.save(). T1's expand-phase save writes
 * the `<id>.jsonl` authority unconditionally, so a legacy-only `.json` session
 * migrates on its next save: load (legacy path, must not crash) → save →
 * `<id>.jsonl` exists and is authoritative (load prefers it by extension).
 *
 * Locked here:
 *   - v5 / v1 legacy fixtures → load → save → JSONL authority; the re-loaded
 *     current-head transcript is equivalent to the pre-migration messages as
 *     an API-legal prefix (well-formed fixture: deep-equal; orphan-tool_use
 *     tail fixture: pre-migration messages stay a PREFIX — T4's process
 *     closeout may append synthetic pairing tool_results on reload).
 *   - The legacy `.json` mirror is STILL written on save (expand-phase compat:
 *     out-of-scope hub/serve/tui tests read `.json` directly). Mirror removal
 *     is a later cleanup ticket — explicitly NOT this one.
 *   - Migration unblocks the JSONL-only primitives (appendEvents/readHead) —
 *     the documented remedy for appendEvents' legacy write_failed (T3's
 *     commit hooks save once before appending).
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
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
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";

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

const toolUseMsg = (
  calls: ReadonlyArray<{ readonly id: string; readonly name: string }>
): AnthropicNativeMessage => ({
  role: "assistant",
  content: calls.map((c) => ({
    type: "tool_use" as const,
    id: c.id,
    name: c.name,
    input: {},
  })),
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

/** Write a legacy-only `.json` session directly to disk (no `.jsonl`). */
const writeLegacyJson = async (id: string, value: unknown): Promise<void> => {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(jsonPath(id), JSON.stringify(value), "utf8");
};

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-jsonl-migration-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("T2: legacy .json migrates to JSONL on next save", () => {
  it("v5 fixture → load → save → <id>.jsonl exists and is authoritative; mirror kept", async () => {
    const legacy = sampleFile({
      id: "t2-v5",
      overrides: {
        title: "legacy v5",
        turnCount: 1,
        messages: [
          userMsg("q"),
          toolUseMsg([{ id: "tu1", name: "grep" }]),
          toolResultMsg("tu1", "hit"),
          assistantMsg("a"),
        ],
        checkpoints: [
          {
            turnIndex: 0,
            messagesCount: 4,
            interruptedAt: "2026-01-01T00:00:00.000Z",
            interruptReason: "timeout" as const,
          },
        ],
        goal: {
          text: "migrate me",
          source: "user_pin" as const,
          status: "active" as const,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        workspaceRoot: "/tmp/test",
      },
    });
    await writeLegacyJson("t2-v5", legacy);

    // load must not crash (spec D7) and returns the sanitized legacy content.
    const pre = await store.load("t2-v5");
    assert.deepEqual(pre.messages, legacy.messages);

    // The migration trigger: a plain save().
    await store.save({ id: "t2-v5", file: pre });

    // `<id>.jsonl` now exists with a persisted head at the last event.
    await stat(jsonlPath("t2-v5"));
    assert.equal(await store.readHead("t2-v5"), "e3");

    // KEEP the dual-write `.json` mirror (expand-phase compat; removal is a
    // later cleanup ticket) — and it reflects the migrated content.
    const mirror = JSON.parse(await readFile(jsonPath("t2-v5"), "utf8"));
    assert.deepEqual(mirror, JSON.parse(JSON.stringify(pre)));

    // Authority proof: remove the mirror; reload must come from the JSONL and
    // deep-equal the pre-migration load (metadata + messages).
    await rm(jsonPath("t2-v5"));
    const reloaded = await store.load("t2-v5");
    assert.deepEqual(reloaded, pre);
  });

  it("re-loaded current-head transcript equals pre-migration messages (well-formed fixture)", async () => {
    const legacy = sampleFile({
      id: "t2-equiv",
      overrides: {
        title: "equiv",
        messages: [userMsg("q1"), assistantMsg("a1"), userMsg("q2")],
      },
    });
    await writeLegacyJson("t2-equiv", legacy);
    const pre = await store.load("t2-equiv");
    await store.save({ id: "t2-equiv", file: pre });
    const reloaded = await store.load("t2-equiv");
    assert.deepEqual(reloaded.messages, pre.messages);
  });

  it("orphan tool_use tail: pre-migration messages stay an API-legal prefix after migration", async () => {
    // Crash-shaped legacy session: assistant tool_use with no tool_result.
    const legacy = sampleFile({
      id: "t2-orphan",
      overrides: {
        title: "orphan",
        messages: [userMsg("q"), toolUseMsg([{ id: "tu1", name: "bash" }])],
      },
    });
    await writeLegacyJson("t2-orphan", legacy);
    const pre = await store.load("t2-orphan");
    await store.save({ id: "t2-orphan", file: pre });
    const reloaded = await store.load("t2-orphan");
    // Prefix equivalence (forward-compatible with T4's closeout backfill,
    // which may append synthetic pairing tool_results): nothing is reordered,
    // altered, or dropped — only pairing results may be appended.
    assert.ok(reloaded.messages.length >= pre.messages.length);
    assert.deepEqual(
      reloaded.messages.slice(0, pre.messages.length),
      pre.messages
    );
  });

  it("v1 legacy fixture (missing v2 fields) sanitizes, migrates, and round-trips", async () => {
    const v1 = {
      schemaVersion: 1,
      conversation_id: "t2-v1",
      messages: [userMsg("old q"), assistantMsg("old a")],
      jsonMode: false,
      turnCount: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeLegacyJson("t2-v1", v1);
    const pre = await store.load("t2-v1");
    assert.equal(pre.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(pre.title, "old q"); // backfilled from first user text
    await store.save({ id: "t2-v1", file: pre });
    await stat(jsonlPath("t2-v1"));
    await rm(jsonPath("t2-v1"));
    const reloaded = await store.load("t2-v1");
    assert.deepEqual(reloaded, pre);
  });

  it("unknown top-level fields survive migration (spread-preserve discipline)", async () => {
    const legacy = {
      ...sampleFile({
        id: "t2-future",
        overrides: { messages: [userMsg("q"), assistantMsg("a")] },
      }),
      futureField: { nested: [1, 2, 3] },
    };
    await writeLegacyJson("t2-future", legacy);
    const pre = await store.load("t2-future");
    await store.save({ id: "t2-future", file: pre });
    await rm(jsonPath("t2-future"));
    const reloaded = (await store.load("t2-future")) as unknown as Record<
      string,
      unknown
    >;
    assert.deepEqual(reloaded["futureField"], { nested: [1, 2, 3] });
  });

  it("migration unblocks JSONL-only primitives: appendEvents chains from the migrated head", async () => {
    const legacy = sampleFile({
      id: "t2-append",
      overrides: { messages: [userMsg("q")] },
    });
    await writeLegacyJson("t2-append", legacy);
    const pre = await store.load("t2-append");
    await store.save({ id: "t2-append", file: pre });
    await store.appendEvents({ id: "t2-append", events: [assistantMsg("a")] });
    assert.equal(await store.readHead("t2-append"), "e1");
    const reloaded = await store.load("t2-append");
    assert.deepEqual(reloaded.messages, [userMsg("q"), assistantMsg("a")]);
  });
});
