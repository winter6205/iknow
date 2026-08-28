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

describe("trace rotation", () => {
  it("deletes oldest managed files when either cap is exceeded at factory creation", () => {
    const oldest = makeOldFile("old.jsonl", 2, 30);
    makeOldFile("middle.jsonl", 2, 20);
    makeOldFile("newest.jsonl", 2, 10);

    createJsonlTraceService({
      filePath: scratch,
      conversationId: "new-session",
      rotation: { maxFiles: 2, maxTotalBytes: 100 },
      writer: () => {},
    });

    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(join(scratch, "middle.jsonl")), true);
    assert.equal(existsSync(join(scratch, "newest.jsonl")), true);
  });

  it("deletes oldest files until the total byte cap is satisfied", () => {
    const oldest = makeOldFile("old.jsonl", 5, 20);
    makeOldFile("new.jsonl", 5, 10);

    createJsonlTraceService({
      filePath: scratch,
      conversationId: "new-session",
      rotation: { maxFiles: 100, maxTotalBytes: 6 },
      writer: () => {},
    });

    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(join(scratch, "new.jsonl")), true);
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

  it("rotates subagent and stderr files with the session files", () => {
    mkdirSync(join(scratch, "stderr"));
    const oldest = makeOldFile("subagent.jsonl", 2);
    const stderr = makeOldFile("stderr/old.log", 2);
    const older = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(oldest, older, older);

    createJsonlTraceService({
      filePath: scratch,
      conversationId: "new-session",
      rotation: { maxFiles: 1, maxTotalBytes: 100 },
      writer: () => {},
    });

    assert.equal(existsSync(oldest), false);
    assert.equal(existsSync(stderr), true);
  });
});
