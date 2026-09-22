/**
 * Offline contract for loadRealLlmEnv (real-llm/real-llm-env.ts):
 * a genuine empty-key success load is the Not-run signal; a load that
 * throws must surface with its original error, never as "key not set".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LLM_MODEL_MISSING_MESSAGE } from "../../src/config/messages.ts";
import { llmSettingsJson } from "../_helpers/test-llm-settings.ts";
import { TEST_LLM_PROVIDER_API_KEY_ENV } from "../_helpers/test-llm-settings.ts";
import type { IknowEnv } from "../../src/config/env.ts";

vi.mock("../../src/config/env.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/config/env.ts")>();
  return { ...actual, loadIknowEnv: vi.fn(actual.loadIknowEnv) };
});

import { loadRealLlmEnv } from "../../real-llm/real-llm-env.ts";
import { loadIknowEnv } from "../../src/config/env.ts";

function withTempHome(
  settings: unknown,
  envVars: Record<string, string | undefined>,
  fn: (root: string) => void
): void {
  const home = mkdtempSync(join(tmpdir(), "iknow-real-llm-env-home-"));
  const root = mkdtempSync(join(tmpdir(), "iknow-real-llm-env-cwd-"));
  mkdirSync(join(home, ".iknow"), { recursive: true });
  writeFileSync(
    join(home, ".iknow", "settings.json"),
    JSON.stringify(settings) + "\n",
    "utf8"
  );
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envVars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn(root);
  } finally {
    process.env.HOME = prevHome;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

afterEach(() => {
  vi.mocked(loadIknowEnv).mockReset();
});

describe("loadRealLlmEnv", () => {
  it("成功加载且 apiKey 非空 → 返回该 env（真实 settings 链）", () => {
    withTempHome(
      llmSettingsJson({ model: "test/model" }),
      { [TEST_LLM_PROVIDER_API_KEY_ENV]: "scratch-key" },
      (root) => {
        const env = loadRealLlmEnv(root);
        expect(env).toBeDefined();
        expect(env?.llm.apiKey).toBe("scratch-key");
      }
    );
  });

  it("apiKey 为空 → undefined（Not run 信号），不抛", () => {
    // loadIknowEnv types llm.apiKey as string | undefined (consumer guards);
    // an empty-key success load can only be produced here at the seam.
    const successNoKey = {
      llm: { apiKey: undefined },
    } as unknown as IknowEnv;
    vi.mocked(loadIknowEnv).mockReturnValueOnce(successNoKey);
    expect(loadRealLlmEnv("/nonexistent-root")).toBeUndefined();
    vi.mocked(loadIknowEnv).mockReturnValueOnce({
      llm: { apiKey: "" },
    } as unknown as IknowEnv);
    expect(loadRealLlmEnv("/nonexistent-root")).toBeUndefined();
  });

  it("加载抛错（model missing）→ 原样传播，不渲染成 key-not-set", () => {
    withTempHome(
      { llm: {} },
      { [TEST_LLM_PROVIDER_API_KEY_ENV]: undefined },
      (root) => {
        expect(() => loadRealLlmEnv(root)).toThrow(LLM_MODEL_MISSING_MESSAGE);
        expect(() => loadRealLlmEnv(root)).not.toThrow(/needs API key/);
      }
    );
  });
});
