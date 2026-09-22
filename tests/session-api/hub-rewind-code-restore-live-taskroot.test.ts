/**
 * ADR-0121 / specs/code-restore.md: rewind-with-restore applies every write
 * (and delete) on the LIVE taskRoot — never on the session file's
 * `workspaceRoot`. Locked here for the diverged state (a provisioned rebind
 * whose new root is recorded in the hub's dirty-root protocol but not yet
 * persisted to the session file — the exact window the ADR names):
 *   - restoreCode:true puts the preimage under the live taskRoot and leaves
 *     the other tree byte-for-byte untouched;
 *   - a captured rootIdentity that does not match the live root is a receipt
 *     skip (workspace bytes stay put) while the head still moves.
 *
 * Real git: the tree is created through the same hub seam the model drives
 * (`hub.provisionWorktree`), so the live root is produced by the production
 * rebind path, not hand-picked by the test.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import { SessionHub } from "../../src/session-api/hub.ts";
import { captureCodeSnapshot } from "../../src/session-api/store/code-snapshot-store.ts";
import {
  CURRENT_SCHEMA_VERSION,
  resolveConversationDir,
  resolveProjectSessionDir,
  SESSION_JSONL_EXT,
  SessionStore,
} from "../../src/session-api/store/index.ts";
import type { PreimageRef } from "../../src/session-api/store/jsonl.ts";
import type { AnthropicNativeMessage } from "../../src/harness/index.ts";
import { makeDeps } from "../cli/_fixtures.ts";
import { gitIn } from "../_helpers/git-env.ts";

const GIT_TIMEOUT_MS = 30_000;

const text = (t: string): AnthropicNativeMessage => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

let baseDir: string;
let sessionDir: string;
let store: SessionStore;
let repo: string;
const extraRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return gitIn(cwd, args);
}

/** Main checkout with one committed file `a.ts` = "B" (the segment's
 *  post-image bytes, so drift never masks the root-target assertion). */
async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iknow-live-root-repo-"));
  extraRoots.push(dir);
  git(dir, "init", "-q");
  await writeFile(join(dir, ".gitignore"), ".iknow/\n", "utf8");
  await writeFile(join(dir, "a.ts"), "B", "utf8");
  git(dir, "add", ".gitignore", "a.ts");
  git(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-qm",
    "init"
  );
  return dir;
}

/** Seed e0..e3 (head e3) with one stamped preimage ref on e1; the session
 *  file pins `workspaceRoot` to the STALE root (the rebind is not persisted). */
async function seed(
  id: string,
  persistedRoot: string,
  ref: PreimageRef
): Promise<void> {
  const dir = resolveConversationDir({
    projectDir: sessionDir,
    conversationId: id,
  });
  await mkdir(dir, { recursive: true });
  const parentByEvent: Record<string, string | null> = {
    e0: null,
    e1: "e0",
    e2: "e1",
    e3: "e2",
  };
  const header = {
    type: "session",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversation_id: id,
    title: "q1",
    cwd: "/tmp",
    sanitized_at: "2026-01-01T00:00:00.000Z",
    jsonMode: false,
    turnCount: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    workspaceRoot: persistedRoot,
  };
  const lines = [JSON.stringify(header)];
  for (const eid of ["e0", "e1", "e2", "e3"]) {
    lines.push(
      JSON.stringify({
        type: "message",
        id: eid,
        parent: parentByEvent[eid],
        message: text(eid),
        ...(eid === "e1" ? { codePreimage: ref } : {}),
      })
    );
  }
  lines.push(JSON.stringify({ type: "head", id: "e3" }));
  await writeFile(
    join(dir, `${id}${SESSION_JSONL_EXT}`),
    `${lines.join("\n")}\n`,
    "utf8"
  );
}

async function captureRef(
  id: string,
  rootIdentity: string
): Promise<PreimageRef> {
  const dir = resolveConversationDir({
    projectDir: sessionDir,
    conversationId: id,
  });
  return {
    relPath: "a.ts",
    rootIdentity,
    preimageSha: await captureCodeSnapshot(dir, "A"),
    postimageSha: await captureCodeSnapshot(dir, "B"),
  };
}

function hub(): SessionHub {
  return new SessionHub({
    store,
    deps: makeDeps([]),
    workspaceRoot: repo,
    // Tests never shell out to a package installer.
    projectDepProvisioner: async () => ({
      status: "skipped",
      line: "deps skipped (test)",
      reason: "no_lockfile",
    }),
  });
}

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), "iknow-live-root-store-"));
  extraRoots.push(baseDir);
  sessionDir = resolveProjectSessionDir(baseDir, process.cwd());
  store = new SessionStore(baseDir, process.cwd());
  repo = await makeGitRepo();
});

afterEach(async () => {
  for (const r of extraRoots.splice(0)) {
    await rm(r, { recursive: true, force: true });
  }
});

describe("rewindSession restoreCode on the live taskRoot (diverged roots)", () => {
  it(
    "restoreCode:true writes the preimage under the live taskRoot; the stale tree is untouched",
    async () => {
      const id = "live-root-write";
      await seed(id, repo, await captureRef(id, repo));
      const h = hub();
      // Production rebind seam: creates the tree AND records the changed root
      // as dirty (persisted only by the next conditional save — none runs here),
      // so the live taskRoot and the session file workspaceRoot diverge.
      const liveRoot = await h.provisionWorktree({
        conversationId: id,
        root: repo,
        name: "restore",
      });
      assert.notEqual(liveRoot, repo, "precondition: roots diverged");

      const res = await h.rewindSession(id, "e0", true);

      assert.equal(res.head, "e0");
      assert.deepEqual(res.codeRestore?.restored, ["a.ts"]);
      assert.deepEqual(res.codeRestore?.skipped, []);
      assert.equal(await readFile(join(liveRoot, "a.ts"), "utf8"), "A");
      assert.equal(await readFile(join(repo, "a.ts"), "utf8"), "B");
    },
    GIT_TIMEOUT_MS
  );

  it(
    "captured rootIdentity differs from the live root: receipt skip, both trees untouched, head still moves",
    async () => {
      const id = "live-root-identity";
      await seed(id, repo, await captureRef(id, "/a-different-project-root"));
      const h = hub();
      const liveRoot = await h.provisionWorktree({
        conversationId: id,
        root: repo,
        name: "restore",
      });

      const res = await h.rewindSession(id, "e0", true);

      assert.equal(res.head, "e0");
      assert.deepEqual(res.codeRestore?.restored, []);
      assert.deepEqual(res.codeRestore?.skipped, [
        { relPath: "a.ts", reason: "root_identity" },
      ]);
      assert.equal(await readFile(join(liveRoot, "a.ts"), "utf8"), "B");
      assert.equal(await readFile(join(repo, "a.ts"), "utf8"), "B");
    },
    GIT_TIMEOUT_MS
  );
});
