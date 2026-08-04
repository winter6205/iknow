/**
 * New permission module — ask-user.test.ts.
 *
 * - createTtyAskUser uses readline against supplied streams (mocked).
 * - createFailClosedAskUser always returns false.
 * - createNoAskUser always returns true.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";

import {
  createTtyAskUser,
  createFailClosedAskUser,
  createNoAskUser,
} from "../../../src/harness/permission/ask-user.js";

class MockWritable extends Writable {
  data = "";
  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void
  ): void {
    this.data += chunk.toString();
    cb();
  }
}

describe("createFailClosedAskUser", () => {
  it("always returns false (deny)", async () => {
    const a = createFailClosedAskUser();
    const r = await a({
      tool: "bash",
      input: { command: "ls" },
      summaryHint: "",
    });
    assert.equal(r, false);
  });
});

describe("createNoAskUser", () => {
  it("always returns true (approve)", async () => {
    const a = createNoAskUser();
    const r = await a({
      tool: "bash",
      input: { command: "ls" },
      summaryHint: "",
    });
    assert.equal(r, true);
  });
});

describe("createTtyAskUser", () => {
  it("returns true on 'y' input", async () => {
    const stdin = Readable.from(["y\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({
      tool: "edit_file",
      input: { path: "x.ts" },
      summaryHint: "",
    });
    assert.equal(r, true);
  });

  it("returns false on 'n' input", async () => {
    const stdin = Readable.from(["n\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({ tool: "edit_file", input: {}, summaryHint: "" });
    assert.equal(r, false);
  });

  it("returns false on EOF (fail-closed)", async () => {
    // Empty stdin → readline closes → fallback resolves false (fail-closed).
    const stdin = Readable.from([]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    const r = await a({ tool: "edit_file", input: {}, summaryHint: "" });
    assert.equal(r, false);
  });

  it("returns defaultYes=true when input is empty line", async () => {
    const stdin = Readable.from(["\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout, defaultYes: true });
    const r = await a({ tool: "edit_file", input: {}, summaryHint: "" });
    assert.equal(r, true);
  });

  it("prompt includes summaryHint when provided", async () => {
    const stdin = Readable.from(["n\n"]);
    const stdout = new MockWritable();
    const a = createTtyAskUser({ stdin, stdout });
    await a({
      tool: "edit_file",
      input: { path: "/etc/passwd" },
      summaryHint: "edit /etc/passwd",
    });
    assert.ok(stdout.data.includes("edit /etc/passwd"));
  });
});
