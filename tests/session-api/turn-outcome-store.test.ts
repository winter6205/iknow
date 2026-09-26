/**
 * T4 (SC7 / SC14 persistence half): durable terminal turn outcome.
 *
 * One append-only `{type:"outcome"}` record per settled host turn, linked to a
 * stable turn identity (the terminal message event id on the active head chain),
 * kept OFF the message chain like the ADR-0113 title event so abandoned fork
 * branches never leak into projection.
 *
 * Exercises the REAL SessionStore in isolated temp dirs (fresh conversationId
 * per case) — asserts the persisted JSONL shape and the loaded/derived outcome
 * projection, not mocks.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  parseSessionJsonl,
  projectSessionLog,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { SessionStoreError } from "../../src/session-api/store/index.ts";
import type { SessionOutcomeRecord } from "../../src/session-api/store/index.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";

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

const headerLine = (id: string, title: string): string =>
  JSON.stringify({
    type: "session",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title,
    cwd: "/tmp/test",
    sanitized_at: "2026-01-01T00:00:00.000Z",
    jsonMode: false,
    turnCount: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    checkpoints: [],
    workspaceRoot: process.cwd(),
  });
const eventLine = (
  id: string,
  parent: string | null,
  message: AnthropicNativeMessage
): string => JSON.stringify({ type: "message", id, parent, message });
const headLine = (id: string | null): string =>
  JSON.stringify({ type: "head", id });
const outcomeLine = (turnId: string, stopReason: string): string =>
  JSON.stringify({ type: "outcome", turnId, stopReason });

const conversationDir = (id: string): string =>
  resolveConversationDir({ projectDir: sessionDir, conversationId: id });
const jsonlPath = (id: string): string =>
  join(conversationDir(id), `${id}${SESSION_JSONL_EXT}`);
const readJsonlLines = async (id: string): Promise<unknown[]> => {
  const raw = await readFile(jsonlPath(id), "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
};
/** Write a crafted JSONL transcript straight to the conversation dir, then
 *  hand the id back to the store so the REAL read/projection path runs. */
async function seedJsonl(id: string, raw: string): Promise<void> {
  const dir = conversationDir(id);
  await mkdir(dir, { recursive: true });
  await writeFile(jsonlPath(id), `${raw}\n`, "utf8");
}

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-turn-outcome-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

// -- pure codec (jsonl.ts) ---------------------------------------------------

describe("parseSessionJsonl accepts an outcome record (ADR-0126)", () => {
  it("keeps the outcome record off the head chain (like a title event)", () => {
    const raw = [
      headerLine("outcome-pure", "placeholder"),
      eventLine("e0", null, userMsg("q")),
      eventLine("e1", "e0", assistantMsg("a")),
      headLine("e1"),
      outcomeLine("e1", "completed"),
    ].join("\n");
    const log = parseSessionJsonl(`${raw}\n`);
    assert.equal(log.head, "e1");
    // Outcome is NOT a message event: the chain length is unchanged.
    assert.equal(log.events.length, 2);
    // It rides in records verbatim, in file order.
    const kinds = log.records.map((r) => r.type);
    assert.deepEqual(kinds, ["message", "message", "head", "outcome"]);
    const outcome = log.records[3] as SessionOutcomeRecord;
    assert.equal(outcome.type, "outcome");
    assert.equal(outcome.turnId, "e1");
    assert.equal(outcome.stopReason, "completed");
  });

  it("rejects a malformed outcome (non-string turnId / unknown stopReason / missing field) as schema_invalid type", () => {
    for (const bad of [
      JSON.stringify({ type: "outcome", turnId: 5, stopReason: "completed" }),
      JSON.stringify({ type: "outcome", turnId: "e1", stopReason: "nope" }),
      JSON.stringify({ type: "outcome", turnId: "e1" }),
    ]) {
      assert.throws(
        () =>
          parseSessionJsonl(
            [
              headerLine("bad", "x"),
              eventLine("e0", null, userMsg("q")),
              headLine("e0"),
              bad,
            ].join("\n") + "\n"
          ),
        (err: unknown) => {
          const e = err as { kind: string; field: string };
          return e.kind === "schema_invalid" && e.field === "type";
        }
      );
    }
  });

  it("legacy files without any outcome record still parse and project unchanged", () => {
    const raw = [
      headerLine("legacy", "legacy"),
      eventLine("e0", null, userMsg("q")),
      eventLine("e1", "e0", assistantMsg("a")),
      headLine("e1"),
    ].join("\n");
    const file = projectSessionLog(parseSessionJsonl(`${raw}\n`));
    assert.equal(file.messages.length, 2);
    assert.deepEqual(file.messages, [userMsg("q"), assistantMsg("a")]);
  });
});

// -- outcome resolution against the active head chain (real store) ------------

describe("SessionStore.projectTurnOutcomes resolves outcomes against the active head chain", () => {
  it("maps each active-chain anchor to its stopReason and ignores abandoned anchors", async () => {
    const id = "outcome-fork";
    // Turn 1 active terminal e1; a rewound-away branch e2/e3; the active branch
    // continues from e1 to e4/e5 (head e5). An outcome on abandoned e3 must not
    // surface, while active e1/e5 outcomes do.
    await seedJsonl(
      id,
      [
        headerLine(id, "fork"),
        eventLine("e0", null, userMsg("q1")),
        eventLine("e1", "e0", assistantMsg("a1")),
        eventLine("e2", "e1", userMsg("q2-abandoned")),
        eventLine("e3", "e2", assistantMsg("a2-abandoned")),
        eventLine("e4", "e1", userMsg("q2-active")),
        eventLine("e5", "e4", assistantMsg("a2-active")),
        headLine("e5"),
        outcomeLine("e1", "completed"),
        outcomeLine("e5", "cancelled"),
        outcomeLine("e3", "completed"),
      ].join("\n")
    );
    const { messageEventIds, outcomes } = await store.projectTurnOutcomes(id);
    // Active chain from head e5: e0 -> e1 -> e4 -> e5 (abandoned e2/e3 excluded).
    assert.deepEqual([...messageEventIds], ["e0", "e1", "e4", "e5"]);
    assert.equal(outcomes.get("e1")?.stopReason, "completed");
    assert.equal(outcomes.get("e5")?.stopReason, "cancelled");
    assert.equal(
      outcomes.has("e3"),
      false,
      "abandoned-branch outcome must not leak into projection"
    );
  });

  it("latest record for the same anchor wins (append-only re-record)", async () => {
    const id = "outcome-dup";
    await seedJsonl(
      id,
      [
        headerLine(id, "dup"),
        eventLine("e0", null, userMsg("q")),
        eventLine("e1", "e0", assistantMsg("a")),
        headLine("e1"),
        outcomeLine("e1", "cancelled"),
        outcomeLine("e1", "completed"),
      ].join("\n")
    );
    const { outcomes } = await store.projectTurnOutcomes(id);
    assert.equal(outcomes.get("e1")?.stopReason, "completed");
  });

  it("a legacy transcript with no outcome resolves to an empty map (projects unknown downstream)", async () => {
    const id = "outcome-none";
    await seedJsonl(
      id,
      [
        headerLine(id, "none"),
        eventLine("e0", null, userMsg("q")),
        eventLine("e1", "e0", assistantMsg("a")),
        headLine("e1"),
      ].join("\n")
    );
    const { outcomes, messageEventIds } = await store.projectTurnOutcomes(id);
    assert.equal(outcomes.size, 0);
    assert.deepEqual([...messageEventIds], ["e0", "e1"]);
  });
});

// -- store append primitive ---------------------------------------------------

describe("SessionStore.appendOutcome (real store)", () => {
  it("appends exactly one append-only outcome line and preserves all prior records", async () => {
    const id = "outcome-append-1";
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [userMsg("q"), assistantMsg("a")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        title: "q",
        cwd: "/tmp/test",
        sanitized_at: "2026-01-01T00:00:00.000Z",
        checkpoints: [],
        workspaceRoot: process.cwd(),
      },
    });
    await store.appendOutcome({ id, turnId: "e1", stopReason: "completed" });

    const lines = await readJsonlLines(id);
    const outcomes = lines.filter(
      (l) => (l as { type?: string }).type === "outcome"
    );
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0], {
      type: "outcome",
      turnId: "e1",
      stopReason: "completed",
    });
    // Loading still projects the two messages (outcome never enters messages).
    const loaded = await store.load(id);
    assert.equal(loaded.messages.length, 2);
    // projectTurnOutcomes surfaces the recorded anchor.
    const { outcomes: resolved } = await store.projectTurnOutcomes(id);
    assert.equal(resolved.get("e1")?.stopReason, "completed");
  });

  it("rejects an invalid stopReason with a typed schema_invalid (no magic string)", async () => {
    const id = "outcome-append-bad";
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [userMsg("q")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        title: "q",
        cwd: "/tmp/test",
        sanitized_at: "2026-01-01T00:00:00.000Z",
        checkpoints: [],
        workspaceRoot: process.cwd(),
      },
    });
    await assert.rejects(
      () =>
        store.appendOutcome({
          id,
          turnId: "e0",
          stopReason: "not-a-reason" as never,
        }),
      (err: unknown) => {
        const e = err as SessionStoreError;
        return e.kind === "schema_invalid" && e.field === "outcome";
      }
    );
  });

  it("appendOutcome surfaces a typed write_failed on a real filesystem refusal (SC14, no mock)", async () => {
    const id = "outcome-append-eacces";
    await store.save({
      id,
      file: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [userMsg("q"), assistantMsg("a")],
        jsonMode: false,
        turnCount: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        title: "q",
        cwd: "/tmp/test",
        sanitized_at: "2026-01-01T00:00:00.000Z",
        checkpoints: [],
        workspaceRoot: process.cwd(),
      },
    });
    const path = jsonlPath(id);
    await chmod(path, 0o444);
    try {
      // tmpfs mounts that ignore mode bits for uid 1000 cannot produce the
      // refusal; the case reports itself skipped there instead of passing
      // vacuously on an append that would have succeeded.
      const refused = await appendFile(path, "").then(
        () => false,
        () => true
      );
      if (!refused) return;
      await assert.rejects(
        () =>
          store.appendOutcome({
            id,
            turnId: "e1",
            stopReason: "completed",
          }),
        (err: unknown) => (err as SessionStoreError).kind === "write_failed"
      );
      // The transcript itself is untouched: no partial outcome line landed.
      assert.equal(
        (await readJsonlLines(id)).filter(
          (l) => (l as { type?: string }).type === "outcome"
        ).length,
        0
      );
    } finally {
      await chmod(path, 0o644);
    }
  });

  it("appendOutcome on a legacy JSON-only session fails with a typed migration error", async () => {
    const id = "outcome-legacy";
    const dir = conversationDir(id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${id}.json`),
      JSON.stringify({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversation_id: id,
        messages: [],
        jsonMode: false,
        turnCount: 0,
        updatedAt: "2026-01-01T00:00:00.000Z",
        title: "",
        cwd: "/tmp/test",
        sanitized_at: "2026-01-01T00:00:00.000Z",
        checkpoints: [],
      }),
      "utf8"
    );
    // readJsonlLog on a legacy-only session (legacyIsWriteFailed:true) → write_failed.
    await assert.rejects(
      () => store.appendOutcome({ id, turnId: "e0", stopReason: "completed" }),
      (err: unknown) => (err as SessionStoreError).kind === "write_failed"
    );
  });
});
