import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  // GRAPHRAG_MEMORY_EMBED_DIMENSIONS is now always required; scrub
  // NINE_ROUTER_KEY (and the now-coupled BASE_URL/MODEL fields) for the
  // whole block so a developer machine with a real key doesn't trip the
  // key-coupled required-fields check. Set a default dimensions so the
  // always-required check passes.
  const SCRUBBED: readonly string[] = [
    "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
    "GRAPHRAG_MEMORY_EMBED_BASE_URL",
    "GRAPHRAG_MEMORY_EMBED_MODEL",
    "GRAPHRAG_MEMORY_EMBED_API_KEY",
    "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
    "NINE_ROUTER_KEY",
  ];
  const saved = new Map<string, string | undefined>();
  beforeAll(() => {
    for (const k of SCRUBBED) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    process.env["GRAPHRAG_MEMORY_EMBED_DIMENSIONS"] = "1536";
  });
  afterAll(() => {
    for (const k of SCRUBBED) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("returns the stage 1 field set with no transport field", () => {
    const env = loadEnv();
    expect(Object.keys(env).sort()).toEqual([
      "dbUrl",
      "embedApiKey",
      "embedBaseUrl",
      "embedDimensions",
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
  "GRAPHRAG_MEMORY_EMBED_DIMENSIONS",
  "GRAPHRAG_MEMORY_EMBED_BASE_URL",
  "GRAPHRAG_MEMORY_EMBED_MODEL",
  "GRAPHRAG_MEMORY_EMBED_API_KEY",
  "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
  "NINE_ROUTER_KEY",
] as const;

/**
 * Run `fn` with STAGE1_KEYS cleared, then patched by `patch`.
 * GRAPHRAG_MEMORY_EMBED_DIMENSIONS defaults to "1536" so existing tests
 * that don't care about dimensions don't need to set it explicitly.
 */
function withEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const k of STAGE1_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  const effectivePatch = {
    GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
    ...patch,
  };
  for (const [k, v] of Object.entries(effectivePatch)) {
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

  it("leaves embedBaseUrl and embedModel undefined when no apiKey is set", () => {
    withEnv({}, () => {
      const env = loadEnv();
      expect(env.embedBaseUrl).toBeUndefined();
      expect(env.embedModel).toBeUndefined();
    });
  });

  it("overrides embedBaseUrl and embedModel from env", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
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

  it("strips a trailing slash from embedBaseUrl", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1/",
        GRAPHRAG_MEMORY_EMBED_MODEL: "test-model",
      },
      () => {
        expect(loadEnv().embedBaseUrl).toBe("https://example.invalid/v1");
      }
    );
  });

  it("reads embedDimensions from GRAPHRAG_MEMORY_EMBED_DIMENSIONS as an integer", () => {
    withEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "2048" }, () => {
      expect(loadEnv().embedDimensions).toBe(2048);
    });
  });

  it("reads embedApiKey from the var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV", () => {
    withEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key-not-a-real-secret",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "test-model",
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("test-key-not-a-real-secret");
      }
    );
  });

  it("leaves embedApiKey undefined when no key source is declared", () => {
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

/**
 * Boundary tests for the embedding-config drift fix: every failure mode on
 * `GRAPHRAG_MEMORY_EMBED_DIMENSIONS` and the apiKey-coupled BASE_URL/MODEL
 * fields must throw ConfigError with a message naming the offending env var.
 *
 * Why these live in their own describe: they intentionally omit
 * GRAPHRAG_MEMORY_EMBED_DIMENSIONS so the default "1536" must NOT leak from
 * withEnv — the boundary is "dimensions missing" specifically. The targeted
 * patch in each test re-asserts the field so the only thing under test is
 * the input value.
 */
describe("loadEnv — embed config boundary cases", () => {
  // For these tests we want dimensions to be EXACTLY what the test sets
  // (including undefined), so we override withEnv with one that doesn't
  // inject a default.
  function withRawEnv(
    patch: Record<string, string | undefined>,
    fn: () => void
  ) {
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

  const DIM_BAD_VALUES: Array<readonly [string, string]> = [
    ["empty string", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["decimal", "3.14"],
    ["non-numeric", "abc"],
  ];

  for (const [label, value] of DIM_BAD_VALUES) {
    it(`throws on GRAPHRAG_MEMORY_EMBED_DIMENSIONS = "${value}" (${label})`, () => {
      withRawEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: value }, () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
      });
    });
  }

  it("throws when GRAPHRAG_MEMORY_EMBED_DIMENSIONS is unset", () => {
    withRawEnv({}, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
    });
  });

  it("throws when GRAPHRAG_MEMORY_EMBED_DIMENSIONS is whitespace-only", () => {
    withRawEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "   " }, () => {
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
    });
  });

  it("throws when a key is declared but BASE_URL is unset", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });

  it("throws when a key is declared but MODEL is unset", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "http://localhost:20128/v1",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_MODEL/);
      }
    );
  });

  // Blank-string normalization: an empty / whitespace-only value must behave
  // exactly like an unset var, so a blank key cannot drag an operator into
  // the real-embedder path and a blank BASE_URL/MODEL cannot slip past the
  // key-coupled required check to fail later at request time.
  it("throws when BASE_URL is an empty string but a key is declared", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });

  it("throws when BASE_URL is whitespace-only but a key is declared", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "   ",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });

  it("throws when MODEL is an empty string but a key is declared", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "test-key",
        GRAPHRAG_MEMORY_EMBED_BASE_URL: "http://localhost:20128/v1",
        GRAPHRAG_MEMORY_EMBED_MODEL: "",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_MODEL/);
      }
    );
  });

  it("treats an empty declared key var as unset (FakeEmbedder path, no baseUrl/model required)", () => {
    withRawEnv(
      {
        GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "",
      },
      () => {
        const env = loadEnv();
        expect(env.embedApiKey).toBeUndefined();
        expect(env.embedBaseUrl).toBeUndefined();
        expect(env.embedModel).toBeUndefined();
      }
    );
  });

  it("still requires dimensions even when NINE_ROUTER_KEY is unset", () => {
    withRawEnv({}, () => {
      // FakeEmbedder needs dimensions (which are NOT in the patch, so
      // withRawEnv leaves them absent — this should still throw because
      // dimensions is the always-required field). Combined with the next
      // test, this asserts that the FakeEmbedder path only enforces
      // dimensions, not baseUrl/model.
      expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_DIMENSIONS/);
    });
  });

  it("FakeEmbedder path: dimensions alone is enough (no baseUrl, no model, no key)", () => {
    withRawEnv({ GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "512" }, () => {
      const env = loadEnv();
      expect(env.embedDimensions).toBe(512);
      expect(env.embedApiKey).toBeUndefined();
      expect(env.embedBaseUrl).toBeUndefined();
      expect(env.embedModel).toBeUndefined();
    });
  });
});

/**
 * API key resolution — host-agnostic indirection (removes the hardcoded
 * NINE_ROUTER_KEY).
 *
 * Resolution order: GRAPHRAG_MEMORY_EMBED_API_KEY (direct value) >
 * process.env[GRAPHRAG_MEMORY_EMBED_API_KEY_ENV] (indirect by the var name
 * the operator declared) > undefined (FakeEmbedder). There is NO default
 * var name: if neither knob is set, the key is undefined even when
 * NINE_ROUTER_KEY happens to exist in the environment — the choice of key
 * is declared in the MCP layer, never decided by config. Every case scrubs
 * all key-related vars first so a developer machine's real key can't leak
 * into the assertion.
 */
describe("loadEnv — embedding API key resolution", () => {
  const KEY_VARS = [
    "GRAPHRAG_MEMORY_EMBED_API_KEY",
    "GRAPHRAG_MEMORY_EMBED_API_KEY_ENV",
    "NINE_ROUTER_KEY",
    "CUSTOM_KEY_VAR",
  ] as const;

  function withKeyEnv(
    patch: Record<string, string | undefined>,
    fn: () => void
  ) {
    const saved = new Map<string, string | undefined>();
    for (const k of [...STAGE1_KEYS, ...KEY_VARS]) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    const effectivePatch = {
      GRAPHRAG_MEMORY_EMBED_DIMENSIONS: "1536",
      ...patch,
    };
    for (const [k, v] of Object.entries(effectivePatch)) {
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

  // When a key resolves, loadEnv enforces BASE_URL + MODEL, so every
  // resolution test below supplies them — the only thing under test is
  // which source the key value came from.
  const ENDPOINT = {
    GRAPHRAG_MEMORY_EMBED_BASE_URL: "https://example.invalid/v1",
    GRAPHRAG_MEMORY_EMBED_MODEL: "test-model",
  };

  it("reads a direct value from GRAPHRAG_MEMORY_EMBED_API_KEY", () => {
    withKeyEnv(
      { GRAPHRAG_MEMORY_EMBED_API_KEY: "direct-secret", ...ENDPOINT },
      () => {
        expect(loadEnv().embedApiKey).toBe("direct-secret");
      }
    );
  });

  it("direct value wins over the var-name path", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "direct-secret",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "env-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("direct-secret");
      }
    );
  });

  it("reads NINE_ROUTER_KEY only when the operator declares it via _API_KEY_ENV (no implicit default)", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "env-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("env-secret");
      }
    );
  });

  it("ignores NINE_ROUTER_KEY when no key source is declared (no default)", () => {
    withKeyEnv({ NINE_ROUTER_KEY: "env-secret" }, () => {
      expect(loadEnv().embedApiKey).toBeUndefined();
    });
  });

  it("reads from a custom var named by GRAPHRAG_MEMORY_EMBED_API_KEY_ENV", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "CUSTOM_KEY_VAR",
        CUSTOM_KEY_VAR: "custom-secret",
        NINE_ROUTER_KEY: "should-be-ignored",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("custom-secret");
      }
    );
  });

  it("treats a blank direct value as unset and falls back to the declared var-name", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "   ",
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "NINE_ROUTER_KEY",
        NINE_ROUTER_KEY: "env-secret",
        ...ENDPOINT,
      },
      () => {
        expect(loadEnv().embedApiKey).toBe("env-secret");
      }
    );
  });

  it("treats a blank var-name as unset (no default, so key is undefined)", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY_ENV: "  ",
        NINE_ROUTER_KEY: "env-secret",
      },
      () => {
        expect(loadEnv().embedApiKey).toBeUndefined();
      }
    );
  });

  it("leaves embedApiKey undefined when neither source resolves", () => {
    withKeyEnv({}, () => {
      expect(loadEnv().embedApiKey).toBeUndefined();
    });
  });

  it("requires BASE_URL when a direct-value key is set", () => {
    withKeyEnv(
      {
        GRAPHRAG_MEMORY_EMBED_API_KEY: "direct-secret",
        GRAPHRAG_MEMORY_EMBED_MODEL: "model-x",
      },
      () => {
        expect(() => loadEnv()).toThrow(/GRAPHRAG_MEMORY_EMBED_BASE_URL/);
      }
    );
  });
});
