/**
 * T1 regression: SessionStore.list() must surface the optional
 * `workspaceRoot` field from each session file (Postel: absent on
 * legacy v3/v4 files → absent on the list entry too).
 *
 * Why a dedicated test:
 *  - The wire shape is `{ sessions: SessionListEntry[] }` — no separate
 *    DTO exists. Whatever SessionStore.list() returns IS the wire payload.
 *  - field-shaping bugs here would silently regress the picker (workspace-
 *    folder-browse T2-T4 read workspaceRoot from this list).
 *
 * Acceptance mapping:
 *  #1 list() returns `workspaceRoot` when present in the file
 *  #2 list() omits `workspaceRoot` for legacy files lacking the field
 *     (`'workspaceRoot' in entry === false`, NOT null — schema sanitize
 *     collapses absent to missing).
 *  #3 sanitize never rejects a legacy v3/v4 file that simply lacks the
 *     additive `workspaceRoot` field.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  resolveProjectSessionDir,
  SessionStore,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";

let store: SessionStore;
let baseDir: string;
let sessionDir: string;

const sampleFile = (opts: {
  readonly id: string;
  readonly overrides?: Partial<SessionFileV1>;
}): SessionFileV1 => {
  const { id, overrides = {} } = opts;
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "",
    cwd: "/tmp/test",
    sanitized_at: new Date().toISOString(),
    messages: [],
    jsonMode: false,
    turnCount: 0,
    updatedAt: new Date().toISOString(),
    checkpoints: [],
    ...overrides,
  };
};

// A session needs an assistant reply — list() skips sessions whose last
// assistant text is empty (issue #96). The shape is otherwise minimal.
const withReply = (id: string): SessionFileV1 =>
  sampleFile({
    id,
    overrides: {
      messages: [
        { role: "user", content: [{ type: "text", text: "q" }] },
        { role: "assistant", content: [{ type: "text", text: "reply" }] },
      ],
    },
  });

beforeAll(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-list-wsr-"));
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir);
});

afterAll(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

describe("SessionStore.list — workspaceRoot exposure", () => {
  it("surfaces workspaceRoot when the file carries it", async () => {
    const root = "/srv/projects/iknow";
    // #618 T1: save writes the JSONL authority (`<id>.jsonl`) plus the legacy
    // `.json` mirror; load/list prefer the JSONL. Saving with the field set
    // exercises the header-record round-trip through the authority shape.
    await store.save({
      id: "list-wsr-present",
      file: sampleFile({
        id: "list-wsr-present",
        overrides: {
          workspaceRoot: root,
          messages: [
            { role: "user", content: [{ type: "text", text: "q" }] },
            { role: "assistant", content: [{ type: "text", text: "reply" }] },
          ],
        },
      }),
    });

    const entries = await store.list();
    const entry = entries.find((e) => e.conversation_id === "list-wsr-present");
    assert.ok(entry, "entry must be listed");
    assert.equal(entry.workspaceRoot, root);
  });

  it("surfaces workspaceRoot from a legacy-only .json file (no .jsonl)", async () => {
    const root = "/srv/projects/iknow";
    await store.save({
      id: "list-wsr-legacy-only",
      file: withReply("list-wsr-legacy-only"),
    });
    // Inject workspaceRoot into the raw legacy file directly and remove the
    // JSONL authority, so the legacy load path is the one under test.
    const path = join(sessionDir, "list-wsr-legacy-only.json");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    raw["workspaceRoot"] = root;
    await writeFile(path, JSON.stringify(raw, null, 2), "utf8");
    await rm(join(sessionDir, "list-wsr-legacy-only.jsonl"));

    const entries = await store.list();
    const entry = entries.find(
      (e) => e.conversation_id === "list-wsr-legacy-only"
    );
    assert.ok(entry, "entry must be listed");
    assert.equal(entry.workspaceRoot, root);
  });

  it("omits workspaceRoot (absent, not null) when the file does not carry it (Postel)", async () => {
    await store.save({
      id: "list-wsr-absent",
      file: withReply("list-wsr-absent"),
    });
    const entries = await store.list();
    const entry = entries.find((e) => e.conversation_id === "list-wsr-absent");
    assert.ok(entry, "entry must be listed");
    assert.equal(
      entry.workspaceRoot,
      undefined,
      "workspaceRoot must be undefined when file lacks it"
    );
    assert.equal(
      "workspaceRoot" in entry,
      false,
      "workspaceRoot must be ABSENT from the entry shape, not serialized as null"
    );
  });

  it("does not reject legacy v3/v4 raw files that lack workspaceRoot (#3 sanitize Postel)", async () => {
    await mkdir(sessionDir, { recursive: true });
    // schemaVersion 3 with no workspaceRoot — must still list without
    // schema_invalid. Sanitize must backfill it to v5 and the additive
    // optional field is omitted from sanitize output (spread-discipline:
    // never emit `field: undefined`).
    const raw = {
      schemaVersion: 3,
      conversation_id: "list-wsr-legacy",
      messages: [
        { role: "user", content: [{ type: "text", text: "old" }] },
        { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      ],
      jsonMode: false,
      turnCount: 1,
      updatedAt: "2026-02-01T00:00:00.000Z",
    };
    await writeFile(
      join(sessionDir, "list-wsr-legacy.json"),
      JSON.stringify(raw),
      "utf8"
    );
    const entries = await store.list();
    const entry = entries.find((e) => e.conversation_id === "list-wsr-legacy");
    assert.ok(
      entry,
      "legacy file without workspaceRoot must list successfully (no schema_invalid)"
    );
    assert.equal(entry.workspaceRoot, undefined);
    assert.equal("workspaceRoot" in entry, false);
  });
});
