import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import { createServer } from "../src/index.ts";

describe("createServer", () => {
  it("returns a constructed McpServer with a connect() method", () => {
    const server = createServer();
    expect(server).toBeDefined();
    assert.equal(
      typeof (server as unknown as { connect: unknown }).connect,
      "function"
    );
  });

  it("returns a fresh server on each call (no shared mutable state)", () => {
    const a = createServer();
    const b = createServer();
    assert.notEqual(a, b);
  });
});
