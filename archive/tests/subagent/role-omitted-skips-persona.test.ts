/**
 * Archived 2026-08-30: omitted envelope.role used to skip catalog persona
 * (V1 byte-stable). Retired — missing role now defaults to general-purpose,
 * matching spawn_subagent.
 *
 * Default vitest exclude: archive/**. Do not re-enable without restoring
 * the omit-role-skip-persona contract.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { createWorkerDeps } from "../../../src/harness/subagent/worker.ts";
import { createStubModel } from "../../../src/harness/stubs/stub-model.ts";
import { createSkillCatalog } from "../../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../../src/harness/trace/noop.ts";
import { getAgentEntry } from "../../../src/harness/subagent/catalog.ts";
import type { IknowEnv } from "../../../src/config/env.ts";
import type { CreateWorkerDepsOptions } from "../../../src/harness/subagent/worker.ts";

const TEST_ENV: IknowEnv = {
  llm: {
    apiKey: "test-key",
    baseUrl: "https://example.test",
    model: "test-model",
    fallback: [],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: "off",
    thinking: { type: "disabled" },
    maxTurns: undefined,
    timeoutMs: undefined,
  },
  web: { proxy: undefined, searchUrl: undefined },
  compress: { contextWindow: 200000, thresholdTokens: undefined },
  chat: { showThinking: false, quiet: false },
};

function hermeticOpts(
  extra?: Partial<CreateWorkerDepsOptions>
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    model: createStubModel({ responses: [] }),
    skillCatalog: createSkillCatalog([]),
    system: () => undefined,
    trace: createNoopTraceService(),
    ...extra,
  };
}

describe("archived: omitted role skips persona", () => {
  it("role 缺省 → deps.system() 不注入 persona (V1 baseline, byte-stable)", async () => {
    const deps = await createWorkerDeps(hermeticOpts());
    const out = (await deps.system?.()) ?? "";
    assert.ok(!out.includes(getAgentEntry("explore").body));
    assert.ok(!out.includes(getAgentEntry("general-purpose").body));
  });
});
