/**
 * Production wiring test: build-engine really passes the worker snapshot
 * getter into createSubAgentManager.
 *
 * Why this file exists: envelope fields, manager folding, and worker-side
 * consumption each had unit tests, but every one of them hand-built the
 * manager — a missing `skillIndexSnapshot` opt in build-engine would go
 * unnoticed, the envelope would always omit the key, and workers would
 * silently fall back to their own rescan. So pin the wiring itself.
 *
 * Method: `vi.mock` wraps (does not replace) `createSubAgentManager` — it
 * captures the opts passed by production assembly, then delegates to the
 * real implementation, so "what build-engine passed" is an observed fact.
 *
 * Coverage:
 *   - seam present (chat + todoDir) → getter present and returns the frozen
 *     model-index set;
 *   - the frozen half is identical for all conversations, the conversation
 *     history half follows the conversation anchor;
 *   - never-loaded conversation anchor → `undefined` (key omitted = worker
 *     takes its own fallback path), NOT `[]` — an empty array would claim
 *     "parent has no skills" and discard the worker's own scan results;
 *   - todoDir absent / ask surface → seam absent → getter absent
 *     (byte-stable with the old shape).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";

// Wrap, not replace: capture the opts from production assembly, then delegate to the real implementation (manager behavior untouched).
const managerOptsCapture = vi.hoisted(() => ({
  current: undefined as Record<string, unknown> | undefined,
  count: 0,
}));

vi.mock("../../src/harness/subagent/manager.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../src/harness/subagent/manager.ts")
    >();
  return {
    ...actual,
    createSubAgentManager: (
      opts: Parameters<typeof actual.createSubAgentManager>[0]
    ): ReturnType<typeof actual.createSubAgentManager> => {
      managerOptsCapture.current = opts as unknown as Record<string, unknown>;
      managerOptsCapture.count += 1;
      return actual.createSubAgentManager(opts);
    },
  };
});

import {
  buildHarnessEngine,
  type BuiltEngine,
} from "../../src/harness/build-engine.ts";
import type { SkillIndexSnapshotEntry } from "../../src/harness/subagent/envelope.ts";
import { createNoAskUser } from "../../src/harness/permission/ask-user.ts";
import type { IknowEnv } from "../../src/config/env.ts";

const roots: string[] = [];
const engines: BuiltEngine[] = [];

afterEach(async () => {
  for (const built of engines.splice(0)) await built.shutdown?.();
  managerOptsCapture.current = undefined;
  managerOptsCapture.count = 0;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function makeEnv(): IknowEnv {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:9999",
      model: "test-model",
      fallback: [],
      apiKey: "sk-t7-wiring",
      maxOutputTokens: 1024,
      timeoutMs: 60_000,
      temperature: 0,
      thinking: "off",
      thinkingEffort: "",
      stream: "on",
    },
    chat: { showThinking: false },
    web: { searchUrl: undefined, proxy: undefined },
    compress: { contextWindow: 200_000, thresholdTokens: undefined },
    mcp: { connectTimeoutMs: 60_000 },
    subagent: { taskTimeoutMs: undefined },
  };
}

async function makeRoots(): Promise<{
  root: string;
  userHome: string;
  todoDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "iknow-t7-wiring-"));
  roots.push(root);
  const userHome = join(root, "home");
  const todoDir = join(root, "todos");
  await mkdir(userHome, { recursive: true });
  await mkdir(todoDir, { recursive: true });
  return { root, userHome, todoDir };
}

/** Plant a user-level skill at `<userHome>/.iknow/skills/<name>/SKILL.md`. */
async function plantSkill(
  userHome: string,
  name: string,
  description: string
): Promise<void> {
  const dir = join(userHome, ".iknow", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nbody\n`,
    "utf8"
  );
}

/** The captured production getter (absent wiring → undefined). */
function capturedGetter():
  | ((
      conversationId: string | undefined
    ) => readonly SkillIndexSnapshotEntry[] | undefined)
  | undefined {
  return managerOptsCapture.current?.skillIndexSnapshot as
    | ((
        conversationId: string | undefined
      ) => readonly SkillIndexSnapshotEntry[] | undefined)
    | undefined;
}

describe("T7 生产接线 — build-engine 把快照 getter 接到 subagent manager（SC10）", () => {
  it("chat + todoDir → getter 在场；冻表模型索引经它可达（该会话未加载过 → 省键而非空数组）", async () => {
    const { root, userHome, todoDir } = await makeRoots();
    await plantSkill(userHome, "frozen-a", "开场冻表条目");
    // The contract under test: the snapshot must equal frozen set ∪ increments already loaded for this conversation.

    const built = await buildHarnessEngine({
      env: makeEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      todoDir,
      userHome,
      cwd: root,
      skipCountTokens: true,
    });
    engines.push(built);

    const getter = capturedGetter();
    assert.ok(
      getter !== undefined,
      "生产装配必须传 skillIndexSnapshot —— 缺席则 SC10 在生产不成立"
    );

    // "This conversation never ran a delta" = unknown, not "none".
    assert.equal(
      getter("conv-never-loaded"),
      undefined,
      "未加载过的会话必须是 undefined（省键），不能是 []（谎报父无技能）"
    );
    // Same reasoning with no conversation anchor.
    assert.equal(getter(undefined), undefined);

    // Full-conversation chain: run one delta tick (in production it runs before every model call, so the mirror is warm by spawn time)
    // → the getter must hand back the parent conversation's complete model index at that moment.
    const seam = built.deps.skillIndexDelta;
    assert.ok(seam !== undefined, "chat + todoDir → 增量缝必须在场");
    await seam.delta("conv-live");

    const snapshot = getter("conv-live");
    assert.ok(snapshot !== undefined, "已加载会话必须给条目（不是 undefined）");
    assert.deepEqual(
      snapshot.map((entry) => entry.name),
      ["frozen-a"],
      "冻表模型索引名进快照（worker 据此渲染自己的 <available_skills>）"
    );
    assert.equal(
      snapshot[0]!.description,
      "开场冻表条目",
      "描述随之过线 —— 裸名会让 worker 渲染退化成无线条清单"
    );

    // Conversation isolation: another conversation's anchor must not see conv-live's history (each stays undefined).
    assert.equal(getter("conv-other"), undefined);
  });

  it("todoDir 缺席 / ask 表面 → getter 缺席（旧形态 byte-stable）", async () => {
    const { root, userHome, todoDir } = await makeRoots();

    const chat = await buildHarnessEngine({
      env: makeEnv(),
      askUser: createNoAskUser(),
      surface: "chat",
      userHome,
      cwd: root,
      skipCountTokens: true,
    });
    engines.push(chat);
    assert.equal(
      capturedGetter(),
      undefined,
      "chat 未注入 todoDir → 无落点 → 缝与 getter 都缺席"
    );

    managerOptsCapture.current = undefined;
    const ask = await buildHarnessEngine({
      env: makeEnv(),
      askUser: createNoAskUser(),
      surface: "ask",
      todoDir,
      userHome,
      cwd: root,
      skipCountTokens: true,
    });
    engines.push(ask);
    assert.equal(capturedGetter(), undefined, "ask 表面不装缝 → 不传 getter");
  });
});
