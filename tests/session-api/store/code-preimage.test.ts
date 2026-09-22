/**
 * ADR-0121: the code-restore plan + apply.
 *
 * Locked here:
 *   - plan folds a path's segment writes into one op: EARLIEST preimage = the
 *     restore target, LATEST postimage = the drift expectation; ordering is by
 *     first appearance (never a directory scan).
 *   - every transcript-supplied locator is gated: a ref whose path is absolute
 *     or climbs out of the root, or whose blob name is not sha256 hex, is
 *     dropped — a transcript is not a licence to reach outside the workspace
 *     and its own blob store.
 *   - apply writes a path back only when the live root identity matches AND the
 *     file's current bytes equal the expected postimage; otherwise it is a
 *     reported skip (drift / root_identity).
 *   - the op's delete directive comes from the EARLIEST ref's capture-time
 *     absence evidence (absentBefore); a legacy ref without the field always
 *     writes bytes back — an empty preimage alone never deletes (ADR-0121).
 *   - every restore blob is read before any write, so one unreadable blob
 *     aborts the whole pass with ZERO workspace changes.
 */
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  applyCodeRestore,
  buildCodeRestorePlan,
  type CodeRestoreOp,
} from "../../../src/session-api/store/code-preimage.ts";
import {
  captureCodeSnapshot,
  codeSnapshotSha,
} from "../../../src/session-api/store/code-snapshot-store.ts";
import type {
  PreimageRef,
  SessionEventRecord,
} from "../../../src/session-api/store/jsonl.ts";
import type { AnthropicNativeMessage } from "../../../src/harness/index.ts";

const text = (t: string): AnthropicNativeMessage => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
});

/** One event carrying a preimage ref for `relPath` (bytes are captured into
 *  `folder`, mirroring the real write path). */
async function writeEvent(
  folder: string,
  rootIdentity: string,
  id: string,
  parent: string | null,
  relPath: string,
  pre: string,
  post: string,
  absentBefore?: boolean
): Promise<SessionEventRecord> {
  const ref: PreimageRef = {
    relPath,
    rootIdentity,
    preimageSha: await captureCodeSnapshot(folder, pre),
    postimageSha: await captureCodeSnapshot(folder, post),
    // Conditional spread mirrors the real capture: false leaves no key, so
    // new and legacy lines share one schema.
    ...(absentBefore === true ? { absentBefore: true } : {}),
  };
  return { type: "message", id, parent, message: text(id), codePreimage: ref };
}

let sessionFolder: string;
let taskRoot: string;

beforeEach(async () => {
  sessionFolder = await mkdtemp(join(tmpdir(), "iknow-restore-snap-"));
  taskRoot = await mkdtemp(join(tmpdir(), "iknow-restore-root-"));
});

afterEach(async () => {
  await rm(sessionFolder, { recursive: true, force: true });
  await rm(taskRoot, { recursive: true, force: true });
});

// -- plan --------------------------------------------------------------------

describe("buildCodeRestorePlan", () => {
  it("one op per path: earliest preimage restores, latest postimage is the expectation", async () => {
    const events = [
      await writeEvent(sessionFolder, taskRoot, "e1", "e0", "a.ts", "A", "B"),
      await writeEvent(sessionFolder, taskRoot, "e2", "e1", "a.ts", "B", "C"),
    ];
    const ops = buildCodeRestorePlan(events);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.relPath, "a.ts");
    assert.equal(ops[0]!.restoreSha, codeSnapshotSha("A"));
    assert.equal(ops[0]!.expectedPostimageSha, codeSnapshotSha("C"));
  });

  it("preserves first-appearance order across distinct paths", async () => {
    const events = [
      await writeEvent(sessionFolder, taskRoot, "e1", null, "z.ts", "z", "Z"),
      await writeEvent(sessionFolder, taskRoot, "e2", "e1", "a.ts", "a", "A"),
    ];
    assert.deepEqual(
      buildCodeRestorePlan(events).map((o) => o.relPath),
      ["z.ts", "a.ts"]
    );
  });

  /** A hand-written ref carrying whatever sha the case needs — the plan's
   *  locator gate is fed forged transcript data here, never a real capture. */
  function refEvent(
    id: string,
    over: Partial<PreimageRef>
  ): SessionEventRecord {
    return {
      type: "message",
      id,
      parent: null,
      message: text(id),
      codePreimage: {
        relPath: "a.ts",
        rootIdentity: taskRoot,
        preimageSha: codeSnapshotSha("A"),
        postimageSha: codeSnapshotSha("B"),
        ...over,
      },
    };
  }

  it("drops absolute and `..`-climbing refs", async () => {
    const ops = buildCodeRestorePlan([
      refEvent("e1", { relPath: "/etc/passwd" }),
      refEvent("e2", { relPath: "../outside.ts" }),
    ]);
    assert.deepEqual(ops, []);
  });

  it("drops a ref whose blob name is not sha256 hex, leaving the workspace alone", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    const events = [
      refEvent("e1", { preimageSha: "../outside-target" }),
      refEvent("e2", { postimageSha: "deadbeef" }),
      refEvent("e3", { preimageSha: codeSnapshotSha("A").toUpperCase() }),
    ];
    // The gate is the plan; the report and the bytes show it has no effect.
    assert.deepEqual(buildCodeRestorePlan(events), []);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops: buildCodeRestorePlan(events),
    });
    assert.deepEqual(report, { restored: [], skipped: [] });
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "B");
  });

  it("keeps the same path under two different roots as two ops", async () => {
    const events = [
      await writeEvent(sessionFolder, "/root-a", "e1", null, "a.ts", "A", "B"),
      await writeEvent(sessionFolder, "/root-b", "e2", "e1", "a.ts", "A", "C"),
    ];
    assert.equal(buildCodeRestorePlan(events).length, 2);
  });

  it("the EARLIEST ref's absence evidence becomes the op's delete directive", async () => {
    // Segment created a.ts (capture-time ENOENT) then edited it: the restore
    // state is "absent before the segment", so the op deletes, keyed on the
    // earliest (empty) preimage.
    const events = [
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e1",
        null,
        "a.ts",
        "",
        "A",
        true
      ),
      await writeEvent(sessionFolder, taskRoot, "e2", "e1", "a.ts", "A", "B"),
    ];
    const ops = buildCodeRestorePlan(events);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.absentBefore, true);
    assert.equal(ops[0]!.restoreSha, codeSnapshotSha(""));
    assert.equal(ops[0]!.expectedPostimageSha, codeSnapshotSha("B"));
  });

  it("absence evidence on a LATER ref never turns an existing file into a delete", async () => {
    // File existed before the segment (first touch is a plain edit); a later
    // ref claims absence (e.g. an external rm then recreate). The pre-segment
    // state is still "existed" → write bytes back, never delete.
    const events = [
      await writeEvent(sessionFolder, taskRoot, "e1", null, "a.ts", "A", "B"),
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e2",
        "e1",
        "a.ts",
        "",
        "C",
        true
      ),
    ];
    const ops = buildCodeRestorePlan(events);
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.absentBefore, false);
  });

  it("a legacy ref without the field plans a byte write-back, never a delete", async () => {
    const events = [
      await writeEvent(sessionFolder, taskRoot, "e1", null, "a.ts", "", "B"),
    ];
    assert.equal(buildCodeRestorePlan(events)[0]!.absentBefore, false);
  });
});

// -- apply -------------------------------------------------------------------

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false
  );

async function expectPlan(
  events: SessionEventRecord[]
): Promise<CodeRestoreOp[]> {
  return [...buildCodeRestorePlan(events)];
}

describe("applyCodeRestore", () => {
  it("restores a single edit back to its preimage", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    const ops = await expectPlan([
      await writeEvent(sessionFolder, taskRoot, "e1", null, "a.ts", "A", "B"),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.deepEqual(report.restored, ["a.ts"]);
    assert.deepEqual(report.skipped, []);
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "A");
  });

  it("restores the original bytes across repeated writes to one path", async () => {
    await writeFile(join(taskRoot, "a.ts"), "C");
    const ops = await expectPlan([
      await writeEvent(sessionFolder, taskRoot, "e1", null, "a.ts", "A", "B"),
      await writeEvent(sessionFolder, taskRoot, "e2", "e1", "a.ts", "B", "C"),
    ]);
    await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "A");
  });

  it("skips (drift) when the current bytes differ from the last postimage", async () => {
    await writeFile(join(taskRoot, "a.ts"), "someone else edited me");
    const ops = await expectPlan([
      await writeEvent(sessionFolder, taskRoot, "e1", null, "a.ts", "A", "B"),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.deepEqual(report.restored, []);
    assert.deepEqual(report.skipped, [{ relPath: "a.ts", reason: "drift" }]);
    assert.equal(
      await readFile(join(taskRoot, "a.ts"), "utf8"),
      "someone else edited me"
    );
  });

  it("skips (root_identity) when the live root identity differs", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    const ops = await expectPlan([
      await writeEvent(
        sessionFolder,
        "/old-root",
        "e1",
        null,
        "a.ts",
        "A",
        "B"
      ),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: "/new-root",
      ops,
    });
    assert.deepEqual(report.restored, []);
    assert.deepEqual(report.skipped, [
      { relPath: "a.ts", reason: "root_identity" },
    ]);
    // The op's path never resolved under the live root, so nothing changed.
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "B");
  });

  it("reads blobs first: an unreadable preimage aborts with zero writes", async () => {
    await writeFile(join(taskRoot, "a.ts"), "B");
    await writeFile(join(taskRoot, "b.ts"), "Y");
    const good = await writeEvent(
      sessionFolder,
      taskRoot,
      "e1",
      null,
      "a.ts",
      "A",
      "B"
    );
    const missingBlobOp: CodeRestoreOp = {
      relPath: "b.ts",
      rootIdentity: taskRoot,
      restoreSha: codeSnapshotSha("NEVER-CAPTURED"),
      expectedPostimageSha: codeSnapshotSha("Y"),
      absentBefore: false,
    };
    const ops = [...(await expectPlan([good])), missingBlobOp];
    await assert.rejects(
      () =>
        applyCodeRestore({
          sessionFolder,
          taskRoot,
          rootIdentity: taskRoot,
          ops,
        }),
      (err: unknown) =>
        (err as { kind: string }).kind === "code_snapshot_missing"
    );
    // Zero writes: even the fully-restorable a.ts is untouched.
    assert.equal(await readFile(join(taskRoot, "a.ts"), "utf8"), "B");
    assert.equal(await readFile(join(taskRoot, "b.ts"), "utf8"), "Y");
  });

  it("restores a nested path, creating parent directories when the file is gone", async () => {
    // The tool created pkg/deep/f.ts then it was removed: the live read is
    // ENOENT-empty, which equals an empty postimage, so the drift guard lets
    // the restore fire and apply must mkdir the parent chain back.
    const ops = await expectPlan([
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e1",
        null,
        join("pkg", "deep", "f.ts"),
        "OLD",
        ""
      ),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.deepEqual(report.restored, [join("pkg", "deep", "f.ts")]);
    assert.equal(
      await readFile(join(taskRoot, "pkg", "deep", "f.ts"), "utf8"),
      "OLD"
    );
  });

  it("a legacy line whose preimage was empty restores empty bytes, file stays", async () => {
    // No capture-time absence evidence (old transcripts never carry the
    // field) → the path is treated as existing, even at empty bytes:
    // deleting here would remove a file the segment did not create.
    await writeFile(join(taskRoot, "new.ts"), "CONTENT");
    const ops = await expectPlan([
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e1",
        null,
        "new.ts",
        "",
        "CONTENT"
      ),
    ]);
    await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.equal(await readFile(join(taskRoot, "new.ts"), "utf8"), "");
  });

  it("a path the segment created is deleted when live bytes still equal the postimage", async () => {
    await writeFile(join(taskRoot, "created.ts"), "CONTENT");
    const ops = await expectPlan([
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e1",
        null,
        "created.ts",
        "",
        "CONTENT",
        true
      ),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.deepEqual(report.restored, ["created.ts"]);
    assert.deepEqual(report.skipped, []);
    assert.equal(await exists(join(taskRoot, "created.ts")), false);
  });

  it("a created path whose bytes drifted is kept and reported as drift", async () => {
    await writeFile(join(taskRoot, "created.ts"), "someone else's bytes");
    const ops = await expectPlan([
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e1",
        null,
        "created.ts",
        "",
        "CONTENT",
        true
      ),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.deepEqual(report.restored, []);
    assert.deepEqual(report.skipped, [
      { relPath: "created.ts", reason: "drift" },
    ]);
    assert.equal(
      await readFile(join(taskRoot, "created.ts"), "utf8"),
      "someone else's bytes"
    );
  });

  it("a created path already gone is still reported restored (ENOENT = achieved)", async () => {
    // The segment created an empty file; the user then removed it. The live
    // read is ENOENT-empty, which equals the empty postimage, so the guard
    // hits and the delete is already satisfied — not a failure.
    const ops = await expectPlan([
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e1",
        null,
        "gone.ts",
        "",
        "",
        true
      ),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.deepEqual(report.restored, ["gone.ts"]);
    assert.equal(await exists(join(taskRoot, "gone.ts")), false);
  });

  it("an edit of an already-empty file writes empty bytes back and keeps the file", async () => {
    // The capture said the path EXISTED (absentBefore false) with empty
    // bytes; restore must put empty bytes at a live file, never delete it.
    await writeFile(join(taskRoot, "empty.ts"), "X");
    const ops = await expectPlan([
      await writeEvent(
        sessionFolder,
        taskRoot,
        "e1",
        null,
        "empty.ts",
        "",
        "X",
        false
      ),
    ]);
    const report = await applyCodeRestore({
      sessionFolder,
      taskRoot,
      rootIdentity: taskRoot,
      ops,
    });
    assert.deepEqual(report.restored, ["empty.ts"]);
    assert.equal(await readFile(join(taskRoot, "empty.ts"), "utf8"), "");
  });
});
