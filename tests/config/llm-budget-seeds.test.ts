/**
 * The maintained MiniMax-M3 seed and the provider-settings examples.
 *
 * `scripts/cursor-start.sh` seeds a user-layer settings file, so its embedded
 * JSON has to survive the real settings validator, and MiniMax-M3 has to carry
 * its documented 131,072-token request output budget (its supplier maximum is
 * 524,288 tokens). `docs/examples/settings-with-providers.md` is the copy-ready
 * template operators paste from, so every JSON block there is parsed the same
 * way and every MiniMax-M3 entry is pinned to the same budget. The field table
 * is pinned too: `models[].maxTokens` is the request budget, not display-only
 * metadata, and not a claim about a supplier's hard maximum.
 */
import { describe, it, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  formatLlmBudgetConfigError,
  isLlmBudgetConfigError,
  loadIknowSettings,
} from "../../src/config/settings.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SEED_PATH = join(repoRoot, "scripts", "cursor-start.sh");
const EXAMPLES_PATH = join(
  repoRoot,
  "docs",
  "examples",
  "settings-with-providers.md"
);
const QUICKSTART_PATH = join(repoRoot, "docs", "llm-config-quickstart.md");
const ENV_EXAMPLE_PATH = join(repoRoot, ".env.example");

const M3_OUTPUT_BUDGET = 131_072;

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-llm-budget-seeds-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** The settings document `cursor-start.sh` writes into `$HOME/.iknow/settings.json`. */
function seedSettingsJson(): Record<string, unknown> {
  const script = readFileSync(SEED_PATH, "utf8");
  const start = script.indexOf("'{");
  const end = script.lastIndexOf("}'");
  assert.ok(
    start >= 0 && end > start,
    "cursor-start.sh 内嵌 settings 种子缺失"
  );
  return JSON.parse(script.slice(start + 1, end + 1)) as Record<
    string,
    unknown
  >;
}

/** Every fenced ```json block of a markdown document, parsed. */
function jsonBlocks(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, "utf8");
  const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map(
    (m) => JSON.parse(m[1]) as Record<string, unknown>
  );
  assert.ok(blocks.length > 0, `${path} 里没有可解析的 json 代码块`);
  return blocks;
}

function modelEntries(
  settings: Record<string, unknown>
): { modelId: string; maxTokens: unknown }[] {
  const providers = (settings.llm as { providers?: unknown[] })?.providers;
  if (!Array.isArray(providers)) return [];
  const out: { modelId: string; maxTokens: unknown }[] = [];
  for (const p of providers) {
    const models = (p as { models?: unknown[] }).models;
    if (!Array.isArray(models)) continue;
    for (const m of models) {
      const entry = m as { id?: unknown; maxTokens?: unknown };
      if (typeof entry.id === "string")
        out.push({ modelId: entry.id, maxTokens: entry.maxTokens });
    }
  }
  return out;
}

/** Load a candidate settings document through the real validator (temp home/cwd). */
async function loadsCleanly(
  settings: Record<string, unknown>
): Promise<{ ok: boolean; reason: string }> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const home = join(workDir, "home", stamp);
  const cwd = join(workDir, "cwd", stamp);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  await writeFile(
    join(home, ".iknow", "settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8"
  );
  try {
    loadIknowSettings({ home, cwd });
    return { ok: true, reason: "" };
  } catch (err) {
    return {
      ok: false,
      reason: isLlmBudgetConfigError(err)
        ? formatLlmBudgetConfigError(err)
        : String(err),
    };
  }
}

describe("MiniMax-M3 种子 / 示例的 maxTokens 预算", () => {
  it("cursor-start.sh 种子: M3 = 131072,且能被真实校验器装载", async () => {
    const seed = seedSettingsJson();
    const m3 = modelEntries(seed).filter((e) => e.modelId === "MiniMax-M3");
    assert.equal(m3.length, 1);
    assert.equal(m3[0].maxTokens, M3_OUTPUT_BUDGET);
    const load = await loadsCleanly(seed);
    assert.ok(load.ok, `种子应通过 settings 校验: ${load.reason}`);
  });

  it("settings-with-providers.md 每个示例都被真实校验器接受,M3 预算一致", async () => {
    const blocks = jsonBlocks(EXAMPLES_PATH);
    const m3Entries = blocks.flatMap((b) =>
      modelEntries(b).filter((e) => e.modelId === "MiniMax-M3")
    );
    assert.ok(
      m3Entries.length >= 2,
      `示例里应至少有两处 MiniMax-M3 条目,实际 ${m3Entries.length}`
    );
    for (const entry of m3Entries) {
      assert.equal(entry.maxTokens, M3_OUTPUT_BUDGET);
    }
    for (const block of blocks) {
      const load = await loadsCleanly(block);
      assert.ok(load.ok, `示例块应通过 settings 校验: ${load.reason}`);
    }
  });

  it("示例字段表把 maxTokens 说成请求输出预算,不再是展示字段", () => {
    const text = readFileSync(EXAMPLES_PATH, "utf8");
    assert.doesNotMatch(text, /display and future use only/);
    const row = text
      .split("\n")
      .find((line) => line.includes("`models[].maxTokens`"));
    assert.ok(row, "字段表缺 models[].maxTokens 行");
    assert.match(row, /max_tokens/);
    assert.match(row, /32,000/);
    assert.match(row, /output budget/);
    assert.match(row, /not a supplier hard limit/i);
    assert.match(text, /524,288/);
  });

  it("显式非法预算在装载期就抛 typed 错误,示例与种子不含非法值", () => {
    for (const block of jsonBlocks(EXAMPLES_PATH)) {
      for (const entry of modelEntries(block)) {
        if (entry.maxTokens === undefined) continue;
        assert.equal(
          typeof entry.maxTokens,
          "number",
          `${entry.modelId} 的预算应为数值`
        );
        assert.ok(
          Number.isSafeInteger(entry.maxTokens) &&
            (entry.maxTokens as number) > 0,
          `${entry.modelId} 的预算应为正安全整数`
        );
      }
    }
    for (const entry of modelEntries(seedSettingsJson())) {
      if (entry.maxTokens === undefined) continue;
      assert.ok(
        Number.isSafeInteger(entry.maxTokens) &&
          (entry.maxTokens as number) > 0,
        `种子 ${entry.modelId} 的预算应为正安全整数`
      );
    }
  });
});

describe("退役的 IKNOW_LLM_MAX_OUTPUT_TOKENS 在模板/文档里的口径", () => {
  it(".env.example 不再给出可用的旧变量赋值,并指向 models[].maxTokens", () => {
    const text = readFileSync(ENV_EXAMPLE_PATH, "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes("IKNOW_LLM_MAX_OUTPUT_TOKENS")) continue;
      assert.ok(
        line.trimStart().startsWith("#"),
        `.env.example 里旧变量只能是注释行: ${line}`
      );
      assert.doesNotMatch(line, /默认 32000/, "不应再把旧变量描述成默认旋钮");
    }
    assert.match(text, /models\[\]\.maxTokens/);
  });

  it("quickstart 不再把旧变量列为受支持设置,并写明迁移错误", () => {
    const text = readFileSync(QUICKSTART_PATH, "utf8");
    for (const line of text.split("\n")) {
      assert.ok(
        !/^\s*IKNOW_LLM_MAX_OUTPUT_TOKENS\s*=/.test(line),
        `quickstart 不应再给出旧变量赋值行: ${line}`
      );
    }
    assert.match(text, /legacy_max_output_tokens_env/);
    assert.match(text, /models\[\]\.maxTokens/);
    assert.match(text, /32,000/);
  });
});
