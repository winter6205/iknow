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
 *   - every restore blob is read before any write, so one unreadable blob
 *     aborts the whole pass with ZERO workspace changes.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  post: string
): Promise<SessionEventRecord> {
  const ref: PreimageRef = {
    relPath,
    rootIdentity,
    preimageSha: await captureCodeSnapshot(folder, pre),
    postimageSha: await captureCodeSnapshot(folder, post),
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
});

// -- apply -------------------------------------------------------------------

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

  it("a create whose preimage was empty writes back empty bytes", async () => {
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
});
