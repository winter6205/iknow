/**
 * auto-memory T4: `settings.memory.autoExtract` opt-in.
 *
 * Spec: specs/auto-memory.md D1/SC1; ADR-0031 Decision 5 — default OFF, and
 * "absent" must be indistinguishable from "off" so today's behavior is
 * byte-identical for anyone who never touches the flag.
 *
 * Follows the settings-layer discipline the rest of the file already keeps:
 * drop-not-throw on an illegal value, and a dropped field does not overwrite
 * the layer below it. ADR-0084: `memory` is a user-layer key — the project
 * file's memory section is dropped by the allowlist and never overrides user.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadIknowSettings } from "../../src/config/settings.ts";

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-auto-memory-settings-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown>
): Promise<{ home: string; cwd: string }> {
  const seed = Math.random().toString(36).slice(2);
  const home = join(workDir, "home", seed);
  const cwd = join(workDir, "cwd", seed);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(user)
    );
  }
  if (Object.keys(project).length > 0) {
    await writeFile(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(project)
    );
  }
  return { home, cwd };
}

describe("settings.memory.autoExtract", () => {
  it("is absent when no settings file mentions it", async () => {
    const { home, cwd } = await makeSettings({}, {});
    assert.equal(loadIknowSettings({ home, cwd }).memory, undefined);
  });

  it("is absent when the memory section exists but carries nothing legal", async () => {
    const { home, cwd } = await makeSettings({}, { memory: { nope: 1 } });
    assert.equal(loadIknowSettings({ home, cwd }).memory, undefined);
  });

  it("reads an explicit true", async () => {
    const { home, cwd } = await makeSettings(
      { memory: { autoExtract: true } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).memory, {
      autoExtract: true,
    });
  });

  it("reads an explicit false", async () => {
    const { home, cwd } = await makeSettings(
      { memory: { autoExtract: false } },
      {}
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).memory, {
      autoExtract: false,
    });
  });

  it("ADR-0084：project 的 memory 被丢弃并告警 → user 值胜出（不再被 project 覆盖）", async () => {
    const { home, cwd } = await makeSettings(
      { memory: { autoExtract: true } },
      { memory: { autoExtract: false } }
    );
    const warnings: string[] = [];
    assert.deepEqual(
      loadIknowSettings({ home, cwd, onWarn: (m) => warnings.push(m) }).memory,
      { autoExtract: true }
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"memory"/);
  });

  it("keeps the user value when project has no memory section", async () => {
    const { home, cwd } = await makeSettings(
      { memory: { autoExtract: true } },
      { llm: { model: "m" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).memory, {
      autoExtract: true,
    });
  });

  it("drops a non-boolean value without overwriting the user layer", async () => {
    const { home, cwd } = await makeSettings(
      { memory: { autoExtract: true } },
      { memory: { autoExtract: "yes" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).memory, {
      autoExtract: true,
    });
  });

  it("drops a non-object memory section", async () => {
    const { home, cwd } = await makeSettings({}, { memory: "on" });
    assert.equal(loadIknowSettings({ home, cwd }).memory, undefined);
  });

  it("freezes the parsed section", async () => {
    const { home, cwd } = await makeSettings(
      {},
      { memory: { autoExtract: true } }
    );
    assert.ok(Object.isFrozen(loadIknowSettings({ home, cwd }).memory));
  });
});

describe("settings.memory.dream", () => {
  it("reads dream independently when autoExtract is absent", async () => {
    const { home, cwd } = await makeSettings({ memory: { dream: true } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }).memory, { dream: true });
  });

  it("preserves an explicit false as the default-off value", async () => {
    const { home, cwd } = await makeSettings({ memory: { dream: false } }, {});
    assert.deepEqual(loadIknowSettings({ home, cwd }).memory, { dream: false });
  });

  it("drops a non-boolean dream without overwriting the user layer", async () => {
    const { home, cwd } = await makeSettings(
      { memory: { dream: true } },
      { memory: { dream: "yes" } }
    );
    assert.deepEqual(loadIknowSettings({ home, cwd }).memory, { dream: true });
  });
});
