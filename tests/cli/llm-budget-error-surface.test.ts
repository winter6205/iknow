/**
 * CLI + TUI rendering of `LlmBudgetConfigError` (typed-error catch contract).
 *
 * The output-budget typed error is a **plain object** (`satisfies` shape, thrown
 * while parsing `models[].maxTokens` and by the env loader for the retired
 * `IKNOW_LLM_MAX_OUTPUT_TOKENS`), so all three start-up surfaces must branch on
 * `isLlmBudgetConfigError` — otherwise `String(err)` prints `[object Object]`
 * and the variable name / model entry / migration target disappear.
 *
 * Why a real child process for the two CLI surfaces: `printCliError` /
 * `printChatError` are module-private in cli.ts and cli.ts runs `main()` at
 * import time (same conclusion as tests/cli/llm-provider-error.test.ts). The
 * TUI surface is the exported `describeTuiStartError`, called directly.
 *
 * Isolation: HOME points at a scratch user settings file, cwd is an empty dir
 * (real project settings are never read), and the retired variable is set /
 * cleared per case in `process.env` before the spawn, restored in `finally`.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatLlmBudgetConfigError,
  type LlmBudgetConfigError,
} from "../../src/config/settings.ts";
import { LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY } from "../../src/config/env.ts";
import { describeTuiStartError } from "../../src/tui/run.tsx";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Same tsx lookup as tests/cli/llm-provider-error.test.ts. */
function resolveTsxCli(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep walking up
    }
    const parent = join(dir, "..");
    if (parent === dir) throw new Error("cannot locate tsx/dist/cli.mjs");
    dir = parent;
  }
}

const tsxCli = resolveTsxCli();
const PROVIDER_ID = "acme";
const API_KEY_ENV = "IKNOW_BUDGET_ERROR_TEST_KEY";
const LEGACY_VALUE = "16000";

/** The error the env loader throws for a non-empty retired variable. */
const legacyError: LlmBudgetConfigError = {
  kind: "legacy_max_output_tokens_env",
  varName: LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY,
  value: LEGACY_VALUE,
};
/** The error the settings parser throws for an explicit illegal entry value. */
const entryError: LlmBudgetConfigError = {
  kind: "model_max_tokens_invalid",
  providerId: PROVIDER_ID,
  modelId: "foo",
  field: "maxTokens",
  value: 0,
};

let scratch: string;

/** User settings with an optional explicit `models[].maxTokens` value. */
function writeHomeSettings(maxTokens?: unknown): void {
  writeFileSync(
    join(scratch, "home", ".iknow", "settings.json"),
    JSON.stringify({
      llm: {
        model: `${PROVIDER_ID}/foo`,
        providers: [
          {
            id: PROVIDER_ID,
            baseUrl: "http://127.0.0.1:41999/v1",
            apiKeyEnv: API_KEY_ENV,
            models: [
              maxTokens === undefined
                ? { id: "foo" }
                : { id: "foo", maxTokens },
            ],
          },
        ],
      },
    })
  );
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-budget-error-"));
  mkdirSync(join(scratch, "home", ".iknow"), { recursive: true });
  mkdirSync(join(scratch, "cwd"), { recursive: true });
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Run one real CLI child process on the startup path. `legacyEnv` is written to
 * `process.env` for the duration of the spawn only (deleted in `finally`), so
 * the case never depends on — and never leaks into — the ambient environment.
 */
function runCli(
  args: string[],
  opts: { readonly legacyEnv: string | undefined; readonly maxTokens?: unknown }
): Promise<{ code: number | null; err: string }> {
  writeHomeSettings(opts.maxTokens);
  if (opts.legacyEnv === undefined) {
    delete process.env[LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY];
  } else {
    process.env[LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY] = opts.legacyEnv;
  }
  try {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: join(scratch, "home"),
      [API_KEY_ENV]: "test-key",
    };
    const child = spawn(
      process.execPath,
      [tsxCli, join(repoRoot, "src", "cli.ts"), ...args],
      {
        cwd: join(scratch, "cwd"),
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let err = "";
    child.stderr.on("data", (d) => (err += String(d)));
    return new Promise((resolve) => {
      child.on("close", (code) => resolve({ code, err }));
      child.on("error", () => resolve({ code: null, err }));
    });
  } finally {
    delete process.env[LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY];
  }
}

/** The stderr line the user actually sees, parsed as the CLI JSON envelope. */
function parseEnvelope(err: string): Record<string, unknown> {
  const line = err.trim().split("\n").at(-1) ?? "";
  return JSON.parse(line) as Record<string, unknown>;
}

describe("CLI ask (printCliError) renders LlmBudgetConfigError", () => {
  it("retired env value → typed envelope with varName + value, never [object Object]", async () => {
    const { code, err } = await runCli(["ask", "hi"], {
      legacyEnv: LEGACY_VALUE,
    });
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    const payload = parseEnvelope(err);
    assert.equal(payload.error, "llm_budget_config");
    assert.equal(payload.code, legacyError.kind);
    assert.equal(payload.varName, LEGACY_MAX_OUTPUT_TOKENS_ENV_KEY);
    assert.equal(payload.value, LEGACY_VALUE);
    assert.equal(payload.message, formatLlmBudgetConfigError(legacyError));
  }, 60_000);

  it("illegal models[].maxTokens → typed envelope naming the entry, never [object Object]", async () => {
    const { code, err } = await runCli(["ask", "hi"], {
      legacyEnv: undefined,
      maxTokens: 0,
    });
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    const payload = parseEnvelope(err);
    assert.equal(payload.error, "llm_budget_config");
    assert.equal(payload.code, entryError.kind);
    assert.equal(payload.provider, PROVIDER_ID);
    assert.equal(payload.model, "foo");
    assert.equal(payload.field, "maxTokens");
    assert.equal(payload.value, 0);
    assert.equal(payload.message, formatLlmBudgetConfigError(entryError));
  }, 60_000);
});

describe("CLI chat (printChatError) renders LlmBudgetConfigError", () => {
  it("retired env value → 错误 [<kind>] with the migration target", async () => {
    const { code, err } = await runCli(["chat"], { legacyEnv: LEGACY_VALUE });
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    assert.equal(
      err.trim(),
      `错误 [${legacyError.kind}]: ${formatLlmBudgetConfigError(legacyError)}`
    );
  }, 60_000);

  it("illegal models[].maxTokens → 错误 [<kind>] with the offending entry", async () => {
    const { code, err } = await runCli(["chat"], {
      legacyEnv: undefined,
      maxTokens: "64000",
    });
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    assert.equal(
      err.trim(),
      `错误 [model_max_tokens_invalid]: ` +
        formatLlmBudgetConfigError({ ...entryError, value: "64000" })
    );
  }, 60_000);
});

describe("TUI describeTuiStartError renders LlmBudgetConfigError", () => {
  it("both kinds render through formatLlmBudgetConfigError", () => {
    for (const budget of [legacyError, entryError]) {
      const out = describeTuiStartError(budget);
      assert.equal(out, formatLlmBudgetConfigError(budget));
      assert.ok(!out.includes("[object Object]"), out);
    }
  });
});
