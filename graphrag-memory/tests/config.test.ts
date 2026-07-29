import { describe, it, expect } from "vitest";
import { loadEnv } from "../src/config.ts";

/**
 * Config contract — stage 0 is stdio-only.
 *
 * Why these tests exist: prior to this commit, `loadEnv()` returned a
 * `transport` field backed by a single-member type and a no-op ternary
 * (`rawTransport === "stdio" ? "stdio" : "stdio"`). The dead code
 * pretended the server honored a non-stdio value while silently coercing
 * every input to "stdio". The host wiring (`.mcp.json`) and the
 * `main()` guard (`index.ts:111-116`) both relied on the lie. This test
 * locks the post-fix shape: `loadEnv` returns ONLY `{ logLevel }`;
 * `GRAPHRAG_MEMORY_TRANSPORT` is ignored, and the server's transport
 * choice is hard-coded to stdio at the call site.
 *
 * What is NOT covered here (deferred to #36 alongside typed errors and
 * IO-throwing handlers per
 * `docs/handoff/2026-07-29-graphrag-mcp-host-acceptance.md`):
 *   - concurrent `loadEnv()` under env mutation (no shared cache, but
 *     also no current use case)
 *   - parseEnvFile read-throw paths (only used when
 *     GRAPHRAG_MEMORY_FROM_FILE=1; stage 0 has no .env shipped)
 */
describe("loadEnv — stage 0 stdio-only contract", () => {
  it("returns { logLevel } with no transport field", () => {
    const env = loadEnv();
    expect(Object.keys(env).sort()).toEqual(["logLevel"]);
    expect(env).not.toHaveProperty("transport");
  });

  it("defaults logLevel to 'info' when no env var is set", () => {
    const prev = process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
    delete process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
    try {
      expect(loadEnv().logLevel).toBe("info");
    } finally {
      if (prev !== undefined) process.env["GRAPHRAG_MEMORY_LOG_LEVEL"] = prev;
    }
  });

  it("accepts each valid logLevel verbatim", () => {
    const prev = process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
    for (const lvl of ["debug", "info", "warn", "error"] as const) {
      process.env["GRAPHRAG_MEMORY_LOG_LEVEL"] = lvl;
      expect(loadEnv().logLevel).toBe(lvl);
    }
    if (prev !== undefined) process.env["GRAPHRAG_MEMORY_LOG_LEVEL"] = prev;
    else delete process.env["GRAPHRAG_MEMORY_LOG_LEVEL"];
  });

  it("ignores GRAPHRAG_MEMORY_TRANSPORT (stage 0 is stdio-only)", () => {
    // Regression guard for the dead-branch bug: even when an operator
    // (or a stray .mcp.json) sets GRAPHRAG_MEMORY_TRANSPORT=http, the
    // server's behavior must not depend on the value.
    const prev = process.env["GRAPHRAG_MEMORY_TRANSPORT"];
    process.env["GRAPHRAG_MEMORY_TRANSPORT"] = "http";
    try {
      const env = loadEnv();
      expect(env).not.toHaveProperty("transport");
      expect(env.logLevel).toBeDefined();
    } finally {
      if (prev !== undefined) process.env["GRAPHRAG_MEMORY_TRANSPORT"] = prev;
      else delete process.env["GRAPHRAG_MEMORY_TRANSPORT"];
    }
  });
});
