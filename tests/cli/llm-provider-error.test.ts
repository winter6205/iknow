/**
 * ADR-0093 — CLI-side rendering of `LlmProviderConfigError` (typed-error catch
 * contract, `.claude/rules/code-quality.md`).
 *
 * When a provider matches but its `apiKeyEnv` is unset, `loadIknowEnv` throws a
 * **plain object** (a discriminated union, not an Error instance). Both CLI
 * catch points must route through the `isLlmProviderConfigError` guard +
 * `formatLlmProviderConfigError`; otherwise `String(err)` prints
 * `[object Object]` and providerId / env name become invisible — aligned with
 * the shape already fixed in `src/tui/run.tsx` in the same PR.
 *
 * Why a real child process: `printCliError` / `printChatError` are module-private
 * in cli.ts, and cli.ts runs `main()` at import time (unit-import impossible,
 * same conclusion as tests/cli/trace-default-mode.test.ts). Spawning the real
 * CLI end-to-end is the black-box proof of the load-bearing surface — "the
 * stderr the user actually sees": oneshot goes `main().catch` →
 * `printCliError`; a chat `prepareRuntime` throw goes → `printChatError`.
 *
 * Isolation: HOME points at scratch (settings.llm.model matches the `acme`
 * provider whose apiKeyEnv is explicitly deleted from the child env) →
 * `loadIknowEnv` must throw; cwd is an empty dir so real project settings are
 * never read.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Same tsx lookup as tests/cli/trace-default-mode.test.ts (worktree node_modules). */
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
const API_KEY_ENV = "IKNOW_PROVIDER_REVIEW_TEST_KEY";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "iknow-cli-provider-error-"));
  const home = join(scratch, "home");
  mkdirSync(join(home, ".iknow"), { recursive: true });
  mkdirSync(join(scratch, "cwd"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify({
      llm: {
        // provider/model shape matches the registry → baseUrl/apiKey come from the provider triple.
        model: `${PROVIDER_ID}/foo`,
        providers: [
          {
            id: PROVIDER_ID,
            baseUrl: "http://127.0.0.1:41999/v1",
            apiKeyEnv: API_KEY_ENV,
            models: [{ id: "foo" }],
          },
        ],
      },
    })
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Run one real CLI child process; return exit code + stderr. */
function runCli(args: string[]): Promise<{ code: number | null; err: string }> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(scratch, "home"),
  };
  // Explicitly delete the provider env var — the asserted state IS "unset".
  delete childEnv[API_KEY_ENV];
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
}

describe("CLI 渲染 LlmProviderConfigError（SC4 / typed-error catch 契约）", () => {
  it("ask（printCliError 路径）→ stderr 含 providerId + env 名，不含 [object Object]", async () => {
    const { code, err } = await runCli(["ask", "hi"]);
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    // Before the fix: String(plain object) → "[object Object]"; provider/env invisible.
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    assert.match(err, new RegExp(PROVIDER_ID));
    assert.match(err, new RegExp(API_KEY_ENV));
  });

  it("chat（printChatError 路径）→ stderr 含 providerId + env 名，不含 [object Object]", async () => {
    const { code, err } = await runCli(["chat"]);
    assert.equal(code, 1, `expected exit 1, stderr=${err}`);
    assert.equal(
      err.includes("[object Object]"),
      false,
      `must not render [object Object]; stderr=${err}`
    );
    assert.match(err, new RegExp(PROVIDER_ID));
    assert.match(err, new RegExp(API_KEY_ENV));
  });
});
