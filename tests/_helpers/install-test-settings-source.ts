/**
 * Isolated settings.json source for serve-path tests.
 *
 * Background (ADR-0093): `IKNOW_LLM_MODEL` is retired; the only model source
 * is `settings.llm.model` (a `provider/model` route ID). The serve composition
 * root, when no settings are injected, resolves the settings file — and a
 * worktree `.iknow/` without settings.json triggers fail-fast.
 *
 * This helper redirects HOME to a fork-local tmp dir, writes a user-level
 * `llm.providers` registry + `process.env[apiKeyEnv] = "test-key"`, so
 * serve-path tests never pollute the real `~/.iknow`.
 *
 * Each vitest fork process builds its own tmp home (pool: forks, one fork per file).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmSettingsJson } from "./test-llm-settings.ts";

export interface TestSettingsSource {
  readonly home: string;
  /** The variable named by provider.apiKeyEnv (already set to "test-key"). */
  readonly apiKeyVar: string;
  readonly model: string;
  /** Restores process.env.HOME / apiKeyVar and deletes the tmp dir. */
  restore(): void;
}

export interface InstallTestSettingsOpts {
  /** settings.llm.model route ID (default "test/model"). */
  model?: string;
  /** provider.apiKeyEnv variable name (default "IKNOW_TEST_API_KEY"). */
  apiKeyVar?: string;
  /** Value injected into apiKeyVar (default "test-key"). */
  apiKeyValue?: string;
}

export function installTestSettingsSource(
  opts: InstallTestSettingsOpts = {}
): TestSettingsSource {
  const apiKeyVar = opts.apiKeyVar ?? "IKNOW_TEST_API_KEY";
  const apiKeyValue = opts.apiKeyValue ?? "test-key";
  const model = opts.model ?? "test/model";

  const prevHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "iknow-settings-source-"));
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify(llmSettingsJson({ model })) + "\n",
    "utf8"
  );
  const prevKey = process.env[apiKeyVar];
  process.env[apiKeyVar] = apiKeyValue;
  process.env.HOME = home;
  return {
    home,
    apiKeyVar,
    model,
    restore() {
      if (prevKey === undefined) delete process.env[apiKeyVar];
      else process.env[apiKeyVar] = prevKey;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
