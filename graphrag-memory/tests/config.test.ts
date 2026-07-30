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
  it("returns the stage 1 field set with no transport field", () => {
    const env = loadEnv();
    expect(Object.keys(env).sort()).toEqual([
      "dbUrl",
      "embedApiKey",
      "embedBaseUrl",
      "embedModel",
      "logLevel",
      "storage",
    ]);
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

/**
 * Stage 1 (T7) config contract — storage mode + embedding provider.
 *
 * Why these live in their own describe: they mutate a different env-var
 * family than the stage 0 block, and every case must restore the prior
 * value so tests stay order-independent (vitest shares one process per
 * file).
 */
const STAGE1_KEYS = [
  "GRAPHRAG_MEMORY_STORAGE",
  "GRAPHRAG_MEMORY_DB_URL",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "NINE_ROUTER_KEY",
] as const;

/** Run `fn` with STAGE1_KEYS cleared, then patched by `patch`. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const k of STAGE1_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(patch)) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("loadEnv — stage 1 storage + embedding contract", () => {
  it("defaults storage to 'memory' with no dbUrl", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.storage).toBe("memory");
      expect(env.dbUrl).toBeUndefined();
    });
  });

  it("defaults embedBaseUrl and embedModel", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.embedBaseUrl).toBe("https://api.9router.ai");
      expect(env.embedModel).toBe("text-embedding-3-small");
    });
  });

  it("overrides embedBaseUrl and embedModel from env", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid",
        GRAPHRAG_MEMORY_EMBED_MODEL: "custom-embed-model",
      },
      () => {
        const env = loadEnv();
        expect(env.embedBaseUrl).toBe("https://example.invalid");
        expect(env.embedModel).toBe("custom-embed-model");
      }
    );
  });

  it("reads embedApiKey from NINE_ROUTER_KEY by name", () => {
    withEnv({ NINE_ROUTER_KEY: "test-key-not-a-real-secret" }, () => {
      expect(loadEnv().embedApiKey).toBe("test-key-not-a-real-secret");
    });
  });

  it("leaves embedApiKey undefined when NINE_ROUTER_KEY is unset", () => {
    withEnv({}, () => {
      expect(loadEnv().embedApiKey).toBeUndefined();
    });
  });

  it("accepts storage=pgvector when dbUrl is present", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_STORAGE: "pgvector",
        GRAPHRAG_MEMORY_DB_URL: "postgres://localhost:5432/graphrag",
      },
      () => {
        const env = loadEnv();
        expect(env.storage).toBe("pgvector");
        expect(env.dbUrl).toBe("postgres://localhost:5432/graphrag");
      }
    );
  });

  it("throws when storage=pgvector but dbUrl is missing", () => {
    withEnv({ GRAPHRAG_MEMORY_STORAGE: "pgvector" }, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_DB_URL/);
    });
  });

  it("throws on an unknown storage mode (no silent coercion)", () => {
    // Regression guard against the stage 0 dead-branch class of bug: an
    // unrecognized value must fail loudly, not fall back to "memory".
    withEnv({ GRAPHRAG_MEMORY_STORAGE: "sqlite" }, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_STORAGE/);
    });
  });
});
