/**
 * serve-workspace T3 — workspaces-recents module tests.
 *
 * Acceptance (plans/serve-workspace.md T3):
 *   - parse_failed on corrupt JSON / non-object JSON
 *   - io_error when path is unreadable (EISDIR probe)
 *   - concurrent_write on expectedRev mismatch (rev-based optimistic CAS)
 *   - happy upsert: append + dedupe by root + lastUsedAt update moves to head
 *   - atomic write: no .tmp leftover
 */
import { afterAll, describe, it, beforeEach } from "vitest";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asWorkspacesRecentsError,
  loadWorkspacesRecents,
  resolveWorkspacesPath,
  saveWorkspacesRecents,
  upsertWorkspaceRecent,
} from "../../src/config/workspaces-recents.ts";

const tmpRoots: string[] = [];

function freshHome(prefix: string): string {
  const p = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(p);
  return p;
}

afterAll(() => {
  while (tmpRoots.length > 0) {
    const p = tmpRoots.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("resolveWorkspacesPath", () => {
  it("joins <home>/.iknow/workspaces.json when home is provided", () => {
    const home = freshHome("iknow-wr-path-");
    assert.equal(
      resolveWorkspacesPath({ home }),
      join(home, ".iknow", "workspaces.json")
    );
  });
});

describe("loadWorkspacesRecents", () => {
  let home: string;
  beforeEach(() => {
    home = freshHome("iknow-wr-load-");
  });

  it("returns { rev: 0, recents: [] } when file is absent (fresh home)", async () => {
    const file = await loadWorkspacesRecents({ home });
    assert.equal(file.rev, 0);
    assert.deepEqual(file.recents, []);
  });

  it("parses a well-formed file preserving rev and recents", async () => {
    mkdirSync(join(home, ".iknow"), { recursive: true });
    writeFileSync(
      join(home, ".iknow", "workspaces.json"),
      JSON.stringify({
        rev: 3,
        recents: [
          { root: "/a", lastUsedAt: "2026-08-19T00:00:00.000Z" },
          { root: "/b", lastUsedAt: "2026-08-18T00:00:00.000Z" },
        ],
      })
    );
    const file = await loadWorkspacesRecents({ home });
    assert.equal(file.rev, 3);
    assert.equal(file.recents.length, 2);
    assert.equal(file.recents[0]!.root, "/a");
    assert.equal(file.recents[1]!.root, "/b");
  });

  it("throws parse_failed on corrupt JSON", async () => {
    mkdirSync(join(home, ".iknow"), { recursive: true });
    writeFileSync(join(home, ".iknow", "workspaces.json"), "{not-json");
    await assert.rejects(
      () => loadWorkspacesRecents({ home }),
      (e: unknown) => asWorkspacesRecentsError(e).kind === "parse_failed"
    );
  });

  it("throws parse_failed when root JSON is not an object", async () => {
    mkdirSync(join(home, ".iknow"), { recursive: true });
    writeFileSync(
      join(home, ".iknow", "workspaces.json"),
      JSON.stringify(["nope"])
    );
    await assert.rejects(
      () => loadWorkspacesRecents({ home }),
      (e: unknown) => asWorkspacesRecentsError(e).kind === "parse_failed"
    );
  });

  it("throws io_error when the file path is itself a directory (EISDIR)", async () => {
    mkdirSync(join(home, ".iknow"), { recursive: true });
    // Replace the expected file with a directory of the same name → readFile
    // returns EISDIR on linux; the loader must rethrow as io_error.
    mkdirSync(join(home, ".iknow", "workspaces.json"));
    await assert.rejects(
      () => loadWorkspacesRecents({ home }),
      (e: unknown) => asWorkspacesRecentsError(e).kind === "io_error"
    );
  });
});

describe("saveWorkspacesRecents", () => {
  let home: string;
  beforeEach(() => {
    home = freshHome("iknow-wr-save-");
  });

  it("writes atomically — no .tmp leftover under .iknow/", async () => {
    await saveWorkspacesRecents({
      home,
      file: { rev: 1, recents: [] },
      expectedRev: 0,
    });
    const entries = readdirSync(join(home, ".iknow"));
    assert.ok(
      !entries.some((name) => name.endsWith(".tmp")),
      `expected no .tmp files, got: ${entries.join(",")}`
    );
  });

  it("writes a JSON file with the supplied rev/recents", async () => {
    await saveWorkspacesRecents({
      home,
      file: {
        rev: 1,
        recents: [{ root: "/x", lastUsedAt: "2026-08-19T00:00:00.000Z" }],
      },
      expectedRev: 0,
    });
    const parsed = readJsonFile(join(home, ".iknow", "workspaces.json")) as {
      rev: number;
      recents: { root: string; lastUsedAt: string }[];
    };
    assert.equal(parsed.rev, 1);
    assert.equal(parsed.recents.length, 1);
    assert.equal(parsed.recents[0]!.root, "/x");
  });

  it("creates the .iknow/ directory if missing", async () => {
    await saveWorkspacesRecents({
      home,
      file: { rev: 1, recents: [] },
      expectedRev: 0,
    });
    const raw = readJsonFile(join(home, ".iknow", "workspaces.json")) as {
      rev: number;
      recents: unknown[];
    };
    assert.equal(raw.rev, 1);
  });

  it("throws concurrent_write when expectedRev mismatches file rev", async () => {
    mkdirSync(join(home, ".iknow"), { recursive: true });
    writeFileSync(
      join(home, ".iknow", "workspaces.json"),
      JSON.stringify({ rev: 5, recents: [] })
    );
    await assert.rejects(
      () =>
        saveWorkspacesRecents({
          home,
          file: { rev: 6, recents: [] },
          expectedRev: 3,
        }),
      (e: unknown) => asWorkspacesRecentsError(e).kind === "concurrent_write"
    );
  });

  it("treats missing file as expectedRev=0 (fresh home)", async () => {
    const updated = await saveWorkspacesRecents({
      home,
      file: {
        rev: 1,
        recents: [{ root: "/a", lastUsedAt: "2026-08-19T00:00:00.000Z" }],
      },
      expectedRev: 0,
    });
    assert.equal(updated.rev, 1);
    const reread = await loadWorkspacesRecents({ home });
    assert.equal(reread.recents.length, 1);
    assert.equal(reread.recents[0]!.root, "/a");
  });
});

describe("upsertWorkspaceRecent", () => {
  let home: string;
  beforeEach(() => {
    home = freshHome("iknow-wr-up-");
  });

  it("appends a new entry to an empty recents list with rev 1", async () => {
    const updated = await upsertWorkspaceRecent({
      home,
      root: "/x",
      lastUsedAt: "2026-08-19T00:00:00.000Z",
    });
    assert.equal(updated.recents.length, 1);
    assert.equal(updated.recents[0]!.root, "/x");
    assert.equal(updated.rev, 1);
  });

  it("dedupes by root: re-upserting the same root moves it to the head and refreshes lastUsedAt", async () => {
    await upsertWorkspaceRecent({
      home,
      root: "/a",
      lastUsedAt: "2026-08-19T00:00:00.000Z",
    });
    await upsertWorkspaceRecent({
      home,
      root: "/b",
      lastUsedAt: "2026-08-19T01:00:00.000Z",
    });
    const updated = await upsertWorkspaceRecent({
      home,
      root: "/a",
      lastUsedAt: "2026-08-19T02:00:00.000Z",
    });
    assert.deepEqual(
      updated.recents.map((r) => r.root),
      ["/a", "/b"]
    );
    assert.equal(updated.recents[0]!.lastUsedAt, "2026-08-19T02:00:00.000Z");
    assert.equal(updated.recents[1]!.lastUsedAt, "2026-08-19T01:00:00.000Z");
  });

  it("writes a concurrent_write-rejected upsert when rev was bumped externally between load and save", async () => {
    // First upsert establishes rev=1 on disk (the caller's "observed" rev).
    await upsertWorkspaceRecent({
      home,
      root: "/a",
      lastUsedAt: "2026-08-19T00:00:00.000Z",
    });
    // External writer bumps rev to 99. In single-threaded JS a sync
    // writeFileSync before the second upsert can't actually race the
    // helper's internal load+save (both reads would observe rev=99 and
    // pass the CAS). We exercise the same CAS rejection the helper relies
    // on by calling the underlying saveWorkspacesRecents directly with
    // the STALE expectedRev (=1) the prior prior observation established:
    // on-disk is now 99 ≠ expectedRev 1 → concurrent_write.
    mkdirSync(join(home, ".iknow"), { recursive: true });
    writeFileSync(
      join(home, ".iknow", "workspaces.json"),
      JSON.stringify({
        rev: 99,
        recents: [{ root: "/other", lastUsedAt: "ignored" }],
      })
    );
    await assert.rejects(
      () =>
        saveWorkspacesRecents({
          home,
          file: {
            rev: 2,
            recents: [{ root: "/b", lastUsedAt: "2026-08-19T03:00:00.000Z" }],
          },
          expectedRev: 1,
        }),
      (e: unknown) => asWorkspacesRecentsError(e).kind === "concurrent_write"
    );
  });
});
