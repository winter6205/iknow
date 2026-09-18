/**
 * T7 / SC10 — **生产装配**真的把 worker 快照 getter 接到 subagent manager 上。
 *
 * 本文件存在的理由（code-review 双轴对 `da74f29e..c9cb1c6b` 独立命中的 High）：
 * envelope 字段、manager 折叠、worker 消费面与两侧单测都齐了，但
 * `build-engine` 的 `createSubAgentManager({...})` 从不传 `skillIndexSnapshot`
 * —— getter 缺失 → envelope 永远省略该键 → worker 恒走自有 rescan 退路，
 * SC10「spawn 的 worker system 含父会话当时模型索引全集」在生产不成立。
 * 原有测试全部**手造 manager**，测的是接线以外的两半，故这里钉接线本身。
 *
 * 手法：`vi.mock` 包装（不是替换）`createSubAgentManager` —— 捕获生产装配传
 * 去的 opts 后仍委托真实现，故「build-engine 传了什么」是被观测的事实，不是
 * 重造的替身。
 *
 * 覆盖：
 *   - 缝在场（chat + todoDir）→ getter 在场，且**当时**返回冻表模型索引全集;
 *   - 冻表名一半与会话无关（所有会话相同），进场史一半随对话锚走;
 *   - 未加载过的会话锚 → `undefined`（省键 = worker 走自有退路），不是 `[]`
 *     —— 空数组意味着「父确定无技能」，会让 worker 丢掉自扫结果;
 *   - todoDir 缺席 / ask 表面 → 缝缺席 → getter 缺席（旧形态 byte-stable）。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import assert from "node:assert/strict";

// 包装而非替换：捕获生产装配传去的 opts，再委托真实现（manager 行为不受影响）。
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

/** 落一个 user 级 skill（`<userHome>/.iknow/skills/<name>/SKILL.md`）。 */
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

/** 捕获到的生产 getter（缺席 → undefined）。 */
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
    // 验收：SC10 的判据是「父会话当时全集」= 冻表 ∪ 已进场增量。

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

    // 「该会话还没跑过 delta」= 不知道，不是「没有」。
    assert.equal(
      getter("conv-never-loaded"),
      undefined,
      "未加载过的会话必须是 undefined（省键），不能是 []（谎报父无技能）"
    );
    // 无会话锚同理。
    assert.equal(getter(undefined), undefined);

    // 全会话链：跑一拍 delta（生产里每次调模型前都会跑，故 spawn 时镜像已热）
    // → getter 必须交出**父会话当时的模型索引全集**（SC10 的机制本体）。
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

    // 会话隔离：另一个会话的锚不得看见 conv-live 的史（各自 undefined）。
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
