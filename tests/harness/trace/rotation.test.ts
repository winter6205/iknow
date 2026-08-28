import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJsonlTraceService } from "../../../src/harness/trace/jsonl.ts";

let scratch: string;

beforeEach(() => {
  scratch = join(tmpdir(), `iknow-trace-rotation-${Date.now()}-${Math.random()}`);
  mkdirSync(scratch, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function makeOldFile(
  name: string,
  size: number,
  ageMinutes = 10
): string {
  const path = join(scratch, name);
  writeFileSync(path, "x".repeat(size));
  const old = new Date(Date.now() - ageMinutes * 60 * 1000);
  utimesSync(path, old, old);
  return path;
}

function makeOldSession(
  name: string,
  content: string,
  ageMinutes = 10
): string {
  const path = join(scratch, name);
  writeFileSync(path, content);
  const old = new Date(Date.now() - ageMinutes * 60 * 1000);
  utimesSync(path, old, old);
  return path;
}

describe("trace rotation", () => {
  it("deletes a small no-error session before an older larger error session", () => {
    const errorSession = makeOldSession(
      "error.jsonl",
      '{"status":"error","message":"' + "x".repeat(30) + '"}\n',
      30
    );
    const noErrorSession = makeOldSession(
      "no-error.jsonl",
      '{"status":"ok"}\n',
      10
    );

    createJsonlTraceService({
      filePath: scratch,
      conversationId: "new-session",
      rotation: { maxFiles: 1, maxTotalBytes: 100 },
      writer: () => {},
    });

    assert.equal(existsSync(noErrorSession), false);
    assert.equal(existsSync(errorSession), true);
  });

  it("preserves subagent.jsonl and stderr logs when rotation is over cap", () => {
    mkdirSync(join(scratch, "stderr"));
    const subagent = makeOldFile("subagent.jsonl", 2, 30);
    const stderr = makeOldFile("stderr/crash.log", 2, 20);
    const session = makeOldSession("session.jsonl", '{"status":"ok"}\n', 10);

    createJsonlTraceService({
      filePath: scratch,
      conversationId: "new-session",
      rotation: { maxFiles: 1, maxTotalBytes: 100 },
      writer: () => {},
    });

    assert.equal(existsSync(subagent), true);
    assert.equal(existsSync(stderr), true);
    assert.equal(existsSync(session), false);
  });

  it("deletes the older no-error file when same-size sessions compete", () => {
    const older = makeOldSession("older.jsonl", '{"status":"ok"}\n', 20);
    const newer = makeOldSession("newer.jsonl", '{"status":"ok"}\n', 10);

    createJsonlTraceService({
      filePath: scratch,
      conversationId: "new-session",
      rotation: { maxFiles: 1, maxTotalBytes: 100 },
      writer: () => {},
    });

    assert.equal(existsSync(older), false);
    assert.equal(existsSync(newer), true);
  });

  it("does not delete files when rotation is disabled by environment", () => {
    const oldest = makeOldFile("old.jsonl", 2);
    makeOldFile("new.jsonl", 2);
    const previous = process.env.IKNOW_TRACE_ROTATION;
    process.env.IKNOW_TRACE_ROTATION = "off";
    try {
      createJsonlTraceService({
        filePath: scratch,
        conversationId: "new-session",
        rotation: { maxFiles: 1, maxTotalBytes: 1 },
        writer: () => {},
      });
    } finally {
      if (previous === undefined) delete process.env.IKNOW_TRACE_ROTATION;
      else process.env.IKNOW_TRACE_ROTATION = previous;
    }

    assert.equal(existsSync(oldest), true);
    assert.equal(existsSync(join(scratch, "new.jsonl")), true);
  });

  it("protects files modified within the active window", () => {
    const active = join(scratch, "active.jsonl");
    writeFileSync(active, "active");
    utimesSync(active, new Date(), new Date());
    const oldest = makeOldFile("old.jsonl", 2);

    createJsonlTraceService({
      filePath: scratch,
      conversationId: "new-session",
      rotation: { maxFiles: 1, maxTotalBytes: 1 },
      writer: () => {},
    });

    assert.equal(existsSync(active), true);
    assert.equal(existsSync(oldest), false);
  });

});
