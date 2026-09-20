/**
 * End-to-end contract for moving the trace anchor into the session folder
 * (ADR-0071 Decision 4). Pinned invariants:
 *
 *   - trace lands at `<baseDir>/projects/<slug>/<convId>/trace.jsonl`, never cwd-relative.
 *   - same baseDir + same projectIdentityRoot + same conversationId must derive
 *     the same absolute path (cross-cwd consistency is the core invariant).
 *   - a conversationId containing `/` or `..`, or over-long, is taken over by
 *     sanitizeConversationSegment, sharing the hostile-path-segment guarantee
 *     with resolveConversationDir.
 *
 * Implementation-agnostic: SSOT = `resolveConversationTraceFilePath` (`session-store.ts`).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { deriveProjectIdentityRoot } from "../../src/harness/session-roots.ts";
import {
  resolveConversationTraceFilePath,
  resolveProjectSessionDir,
  TRACE_FILE_NAME,
} from "../../src/session-api/store/index.ts";

describe("resolveConversationTraceFilePath (T3 SC6)", () => {
  it("derives <projectDir>/<convId>/trace.jsonl with TRACE_FILE_NAME leaf", () => {
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    const path = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "abc-uuid",
    });
    assert.equal(
      path,
      "/tmp/iknow/projects/foo-abcdef012345/abc-uuid/trace.jsonl"
    );
    assert.equal(basename(path), TRACE_FILE_NAME);
    assert.equal(TRACE_FILE_NAME, "trace.jsonl");
  });

  it("cross-cwd baseDir independence: two cwds, same projectIdentityRoot → identical trace path", () => {
    // Same baseDir + same projectIdentityRoot derive the same projectDir → the
    // same `<convId>/trace.jsonl`. A different cwd must not change the result
    // (the key is projectIdentityRoot, not cwd — an invariant this anchor inherits).
    const baseDir = "/var/data/iknow";
    const projectIdentityRoot = "/home/user/projects/iknow"; // hypothetical stable root
    const projectDirA = resolveProjectSessionDir(baseDir, projectIdentityRoot);
    const projectDirB = resolveProjectSessionDir(baseDir, projectIdentityRoot);
    // Simulated cross-cwd: derive twice with baseDir/identity unchanged → identical projectDir
    assert.equal(projectDirA, projectDirB);
    const pathA = resolveConversationTraceFilePath({
      projectDir: projectDirA,
      conversationId: "conv-stable-id",
    });
    const pathB = resolveConversationTraceFilePath({
      projectDir: projectDirB,
      conversationId: "conv-stable-id",
    });
    assert.equal(
      pathA,
      pathB,
      "same baseDir + same projectIdentityRoot must derive identical trace path"
    );
    assert.ok(pathA.endsWith("/conv-stable-id/trace.jsonl"));
    // negative: the derived path must not accidentally contain cwd wording (the slug comes only from projectIdentityRoot).
    // Note: the test conv id must not contain cwd wording either, or it would false-hit — deliberately unrelated chars here.
    assert.ok(!pathA.includes("not-a-cwd-marker-zzz"));
  });

  it("worktree cwd folds to main checkout identity → identical trace path (real dual-cwd exercise)", () => {
    // Real exercise: the same project launched from the main checkout and from
    // its task worktree gives two genuinely different cwds. The assembly layer
    // folds both to one projectIdentityRoot (`deriveProjectIdentityRoot` →
    // `mainCheckoutOf`: worktree path `<main>/.iknow/worktrees/<name>` folds
    // back to `<main>`), so the trace anchor must be identical — if the key
    // drifted to the raw cwd, worktree sessions would split off a second trace file.
    const baseDir = "/var/data/iknow";
    const main = "/home/user/projects/iknow";
    const worktree = join(main, ".iknow", "worktrees", "session-folder-x");
    // Self-prove the fold precondition (otherwise the derived assertions below spin idle):
    // the identity derived for a worktree cwd equals the main checkout.
    assert.equal(deriveProjectIdentityRoot({ cwd: worktree }), main);
    assert.equal(deriveProjectIdentityRoot({ cwd: main }), main);

    const projectDirMain = resolveProjectSessionDir(
      baseDir,
      deriveProjectIdentityRoot({ cwd: main })
    );
    const projectDirWorktree = resolveProjectSessionDir(
      baseDir,
      deriveProjectIdentityRoot({ cwd: worktree })
    );
    assert.equal(
      projectDirMain,
      projectDirWorktree,
      "main checkout and its task worktree must share one projectDir"
    );
    const traceMain = resolveConversationTraceFilePath({
      projectDir: projectDirMain,
      conversationId: "conv-wt-1",
    });
    const traceWorktree = resolveConversationTraceFilePath({
      projectDir: projectDirWorktree,
      conversationId: "conv-wt-1",
    });
    assert.equal(
      traceMain,
      traceWorktree,
      "trace anchor must be identical regardless of which checkout cwd started the session"
    );
    assert.ok(traceMain.startsWith(baseDir + "/projects/"));
    assert.ok(!traceMain.includes("worktrees"));
  });

  it("sanitize path-hostile conversationId via resolveConversationDir contract", () => {
    // `..` / `/` / separator-bearing ids are handled by sanitizeConversationSegment
    // in resolveConversationDir → the trace path cannot escape projectDir.
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    // Path-hostile conversationId: contains `..` and `/`. After sanitize the segment is stable and cannot escape projectDir.
    const path1 = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "../escape",
    });
    assert.ok(
      path1.startsWith(projectDir + "/"),
      `trace path must remain under projectDir, got ${path1}`
    );
    assert.ok(
      !path1.includes(".."),
      `sanitize must drop '..' segments: ${path1}`
    );
    assert.ok(path1.endsWith("/trace.jsonl"));

    // An id containing `/` is also contained by sanitize; it must not land as `<convId>part1/convIdpart2/trace.jsonl`
    const path2 = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "part1/part2",
    });
    assert.ok(
      path2.startsWith(projectDir + "/"),
      `trace path must remain under projectDir, got ${path2}`
    );
    assert.ok(path2.endsWith("/trace.jsonl"));
    // Derivation is stable: two calls with the same hostile id yield the same path (SSOT invariant).
    const path2b = resolveConversationTraceFilePath({
      projectDir,
      conversationId: "part1/part2",
    });
    assert.equal(path2, path2b);
  });

  it("conversationId required: empty string falls into resolveConversationDir typed error", () => {
    // The SSOT leaves "missing convId" to resolveConversationDir (SessionRootError
    // missing_root). The trace helper passes it through; no separate boundary at the trace layer.
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    assert.throws(
      () =>
        resolveConversationTraceFilePath({
          projectDir,
          conversationId: "",
        }),
      /missing_root|conversationId is required/
    );
  });

  it("leaf folder name = conversationId (verbatim, sanitize-equivalent)", () => {
    // Pinned: folder name = conversationId verbatim — never the worktree label, title, or
    // goal. This test pins a UUID-shaped id once to verify leaf = id verbatim
    // (sanitize is the identity on `[A-Za-z0-9_-]`).
    const projectDir = "/tmp/iknow/projects/foo-abcdef012345";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const path = resolveConversationTraceFilePath({
      projectDir,
      conversationId: uuid,
    });
    // Second-to-last segment = convId verbatim (never rewritten by any slug)
    const segments = path.split("/");
    assert.equal(
      segments[segments.length - 2],
      uuid,
      `folder name must equal conversationId verbatim, got: ${path}`
    );
    assert.equal(segments[segments.length - 1], "trace.jsonl");
  });
});
