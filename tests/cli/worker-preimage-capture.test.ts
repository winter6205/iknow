/**
 * ADR-0119 T3, host seam (cli): the worker's capture → drain → stamp chain,
 * assembled entirely OUTSIDE the harness (Gate B: the harness only declares
 * the `PreimageCapture` port; this host constructs the implementation the
 * `__subagent_worker__` dispatch injects into `runSubagentWorker`).
 *
 * Locked here (real fs, fresh ids):
 *   - the factory's capture lands pre/post blobs in the PARENT session folder
 *     (`resolveConversationDir` over the envelope's todoLedger anchor) while
 *     keying its ledger under the worker taskId — the deliberate asymmetry
 *     against the parent's `createPreimageCapture` (a worker has no
 *     project-pool leaf, ADR-0102);
 *   - `storeWorkerTranscriptIo.appendMessages` drains exactly the committed
 *     batch's tool_result ids and stamps the matching event;
 *   - a capture without toolUseId stores nothing and stamps nothing (the
 *     never-a-wrong-stamp posture);
 *   - blobs are content-addressed `wx`, so worker and parent captures of the
 *     same bytes dedupe into one blob.
 */
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";

import {
  createWorkerPreimageCaptureFactory,
  storeWorkerTranscriptIo,
} from "../../src/cli/worker-transcript.ts";
import {
  resolveConversationDir,
  resolveProjectSessionDir,
} from "../../src/session-api/store/index.ts";
import {
  codeSnapshotDir,
  codeSnapshotSha,
} from "../../src/session-api/store/code-snapshot-store.ts";
import type { PreimageCaptureInput } from "../../src/harness/aci/preimage-port.ts";

let root: string; // worker sandbox root
let baseDir: string; // session pool base
let home: string; // settings seam (no real user dir)
const parentId = "host-parent-conv-t3";
const taskId = "host-task-t3";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "iknow-host-wp-root-"));
  baseDir = await mkdtemp(join(tmpdir(), "iknow-host-wp-pool-"));
  home = await mkdtemp(join(tmpdir(), "iknow-host-wp-home-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(baseDir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

function captureInput(
  over?: Partial<PreimageCaptureInput>
): PreimageCaptureInput {
  return {
    toolUseId: "tu-1",
    conversationId: taskId, // worker ctx: conversationId ≡ taskId
    relPath: "worker-file.ts",
    rootIdentity: root,
    preBytes: Buffer.from("old content\n", "utf8"),
    postBytes: Buffer.from("new content\n", "utf8"),
    ...over,
  };
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false
  );

async function readEventRecords(path: string) {
  const { readFile } = await import("node:fs/promises");
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  return lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((r) => r.type === "message");
}

describe("worker preimage host chain (capture → drain → stamp)", () => {
  it("blobs land in the parent folder, ledger keys on taskId, commit batch stamps the ref onto the tool_result event", async () => {
    const projectDir = resolveProjectSessionDir(baseDir, root);
    const capture = createWorkerPreimageCaptureFactory({
      userHome: home,
    })({ taskId, parentLedger: { projectDir, conversationId: parentId } });
    assert.ok(
      capture,
      "factory must yield a port when the todoLedger anchor exists"
    );

    const input = captureInput();
    await capture!(input);

    const sessionDir = resolveConversationDir({
      projectDir,
      conversationId: parentId,
    });
    const preSha = codeSnapshotSha("old content\n");
    const postSha = codeSnapshotSha("new content\n");
    assert.ok(
      await exists(join(codeSnapshotDir(sessionDir), preSha)),
      "preimage blob lands in the parent session folder (T2 applyCodeRestore's read point)"
    );
    assert.ok(await exists(join(codeSnapshotDir(sessionDir), postSha)));
    // no blob in the worker's own folder (no addressable leaf → dead storage)
    assert.equal(
      await exists(
        join(codeSnapshotDir(join(sessionDir, "subagents", taskId)), preSha)
      ),
      false
    );

    const transcriptPath = join(
      sessionDir,
      "subagents",
      taskId,
      `${taskId}.jsonl`
    );
    const io = storeWorkerTranscriptIo({ transcriptPath, taskId, cwd: root });
    await io.appendMessages([
      { role: "user", content: [{ type: "text", text: "task" }] },
    ]);
    await io.appendMessages([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
      },
    ]);
    const events = await readEventRecords(transcriptPath);
    assert.deepEqual(events[1]!.codePreimage, {
      relPath: "worker-file.ts",
      rootIdentity: root,
      preimageSha: preSha,
      postimageSha: postSha,
    });
  });

  it("no toolUseId: no blob, no ledger entry, commit stays unstamped (never-a-wrong-stamp)", async () => {
    const projectDir = resolveProjectSessionDir(baseDir, root);
    const capture = createWorkerPreimageCaptureFactory({ userHome: home })({
      taskId,
      parentLedger: { projectDir, conversationId: parentId },
    });
    assert.ok(capture);
    const { toolUseId: _drop, ...noId } = captureInput();
    await capture!(noId);
    const sessionDir = resolveConversationDir({
      projectDir,
      conversationId: parentId,
    });
    assert.equal(
      await exists(
        join(codeSnapshotDir(sessionDir), codeSnapshotSha("old content\n"))
      ),
      false
    );
    const transcriptPath = join(
      sessionDir,
      "subagents",
      taskId,
      `${taskId}.jsonl`
    );
    const io = storeWorkerTranscriptIo({ transcriptPath, taskId, cwd: root });
    await io.appendMessages([
      { role: "user", content: [{ type: "text", text: "task" }] },
    ]);
    await io.appendMessages([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
      },
    ]);
    const events = await readEventRecords(transcriptPath);
    assert.equal(events[1]!.codePreimage, undefined);
  });

  it("same bytes captured twice: wx dedupes without throwing (worker + parent share the blob pool)", async () => {
    const projectDir = resolveProjectSessionDir(baseDir, root);
    const capture = createWorkerPreimageCaptureFactory({ userHome: home })({
      taskId,
      parentLedger: { projectDir, conversationId: parentId },
    });
    assert.ok(capture);
    await capture!(captureInput());
    await capture!(captureInput({ toolUseId: "tu-2" }));
    const sessionDir = resolveConversationDir({
      projectDir,
      conversationId: parentId,
    });
    assert.ok(
      await exists(
        join(codeSnapshotDir(sessionDir), codeSnapshotSha("old content\n"))
      )
    );
  });

  it("factory 的 userHome 设置 seam: 空 home = 默认启用; codeRestore.enabled=false 停捕获", async () => {
    const projectDir = resolveProjectSessionDir(baseDir, root);
    const loc = {
      taskId,
      parentLedger: { projectDir, conversationId: parentId },
    };
    const enabled = createWorkerPreimageCaptureFactory({ userHome: home })(loc);
    assert.ok(enabled, "absent settings = enabled");
    await mkdir(join(home, ".iknow"), { recursive: true });
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify({ codeRestore: { enabled: false } }),
      "utf8"
    );
    const off = createWorkerPreimageCaptureFactory({ userHome: home })(loc);
    assert.ok(off);
    await off!(captureInput());
    const sessionDir = resolveConversationDir({
      projectDir,
      conversationId: parentId,
    });
    assert.equal(
      await exists(
        join(codeSnapshotDir(sessionDir), codeSnapshotSha("old content\n"))
      ),
      false,
      "enabled=false: the port exists but is a no-op"
    );
  });
});
