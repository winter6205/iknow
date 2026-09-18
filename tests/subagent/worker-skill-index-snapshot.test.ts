/**
 * T7 (`specs/skill-index-increment.md` / SC10 + assumption 7) — worker 侧：
 * spawn 时 worker system 的 `<available_skills>` 含**父会话当时的完整模型索引
 * 快照**；worker **不**往 prior 抄父的增量 user 消息。
 *
 * 契约（worker 侧）：
 *   - envelope 带 `skillIndexSnapshot` → 该快照是 worker 索引面的唯一来源
 *     （含父已追加进场的名 —— 这些名不在 worker 自己的扫描里）；
 *   - 渲染复用 `skillsSegment`（`identity/assemble.ts` 的唯一 SSOT），worker
 *     不留第二套渲染；
 *   - 快照是**值**语义：worker 进程内相邻两次求值 byte-stable（冻表纪律）；
 *     交付点拷贝，父侧 / 调用方后续改写不回流；
 *   - envelope **无**该字段（旧 wire / 直连装配）→ 逐字节退回 worker 自己的
 *     独立 rescan（`createSkillScanner`），两侧 system 文本 deep-equal；
 *   - 快照里的名在 worker catalog 缺席 → 仍渲染（按名 + description 直出）：
 *     spec 的判据是「完整」，不因 worker 自己的扫描根较窄而丢条目 —— 该名
 *     在 worker 里变成一个 description 可见、正文不可加载的条目（与索引降档
 *     的裸名条目同一性质，ADR-0046 Decision 2）；缺席行为在 worker 侧是
 *     **确定**的（渲染可见 / `skill()` 报 not found），不静默改写成第二条
 *     更窄的清单；
 *   - prior 面：`priorMessagesFromEnvelope` 不因快照在场而多出任何段
 *     （assumption 7 —— 父的隐藏增量 user 消息不进 worker prior）。
 *
 * Isolation: 全部 tmp fixture；模型面 = stub（零真实调用）。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStubModel } from "../../src/harness/stubs/stub-model.ts";
import {
  createWorkerDeps,
  priorMessagesFromEnvelope,
} from "../../src/harness/subagent/worker.ts";
import type { CreateWorkerDepsOptions } from "../../src/harness/subagent/worker.ts";
import { createSkillCatalog } from "../../src/harness/skill/catalog.ts";
import type { SkillEntry } from "../../src/harness/skill/catalog.ts";
import { createNoopTraceService } from "../../src/harness/trace/noop.ts";
import { skillsSegment } from "../../src/harness/identity/assemble.ts";
import type { WorkerEnvelope } from "../../src/harness/subagent/envelope.ts";
import type { IknowEnv } from "../../src/config/env.ts";

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

function entry(
  name: string,
  description: string | undefined,
  dir: string
): SkillEntry {
  return { name, description, dir, disabled: false };
}

/** `<available_skills>` 段从整份 system 文本里切出来（断言面 = 模型看到的那段）。 */
function availableSkillsBlock(system: string): string {
  const start = system.indexOf("<available_skills>");
  const end = system.indexOf("</available_skills>");
  assert.ok(start >= 0 && end > start, "system 里应有 <available_skills> 段");
  return system.slice(start, end + "</available_skills>".length);
}

/**
 * hermetic 装配缝：stub-model（零模型调用）+ noop trace + 注入 catalog。
 *
 * `userHome` / `cwd` / `projectIdentityRoot` 指到一个**不存在的 tmp 路径**
 * （不是真实 HOME）：身份 / 说明书 / 技能根的读取全部落空 → 段文本只由本
 * 用例给的数据决定，运行机器上装了什么技能都不影响断言。
 */
function hermeticOpts(
  extra: Partial<CreateWorkerDepsOptions> & {
    readonly skillCatalog: ReturnType<typeof createSkillCatalog>;
  }
): CreateWorkerDepsOptions {
  return {
    env: TEST_ENV,
    sandboxRoot: "/tmp/sb",
    cwd: "/tmp/iknow-t7-nonexistent",
    userHome: "/tmp/iknow-t7-nonexistent",
    projectIdentityRoot: "/tmp/iknow-t7-nonexistent",
    model: createStubModel({ responses: [] }),
    trace: createNoopTraceService(),
    role: "general-purpose",
    ...extra,
  };
}

describe("worker system — 父会话模型索引快照（SC10）", () => {
  it("envelope.skillIndexSnapshot 在场 → 段含快照条目（父已追加进场的名 + 冻表名）", async () => {
    const frozen = entry("frozen-a", "开场冻表条目", "/no/such/dir/frozen-a");
    const deps = await createWorkerDeps(
      hermeticOpts({
        // worker 自己的扫描只看得见 frozen-a：父中途进场的 injected-b 不在其中。
        skillCatalog: createSkillCatalog([frozen]),
        skillIndexSnapshot: [
          { name: "frozen-a", description: "开场冻表条目" },
          { name: "injected-b", description: "父会话中途进场" },
        ],
      })
    );

    const system = (await deps.system?.()) ?? "";
    const block = availableSkillsBlock(system);
    assert.ok(block.includes("frozen-a: 开场冻表条目"), block);
    assert.ok(
      block.includes("injected-b: 父会话中途进场"),
      `父已进场的名必须进 worker 冻表：${block}`
    );
  });

  it("快照名按 name 升序渲染且与 skillsSegment SSOT 逐字节一致（不留第二套渲染）", async () => {
    const snapshot = [
      { name: "zeta", description: "z 描述" },
      { name: "alpha", description: "a 描述" },
    ] as const;
    const deps = await createWorkerDeps(
      hermeticOpts({
        skillCatalog: createSkillCatalog([]),
        skillIndexSnapshot: [...snapshot],
      })
    );

    const system = (await deps.system?.()) ?? "";
    assert.equal(
      availableSkillsBlock(system),
      skillsSegment([...snapshot]),
      "段文本 = skillsSegment 对同一数据的渲染（单一 SSOT）"
    );
  });

  it("快照描述缺席 → 裸名行（降档形态原样保留，渲染层不补占位）", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        skillCatalog: createSkillCatalog([]),
        skillIndexSnapshot: [{ name: "bare-name" }],
      })
    );

    const system = (await deps.system?.()) ?? "";
    assert.equal(
      availableSkillsBlock(system),
      "<available_skills>\nbare-name\n</available_skills>"
    );
  });

  it("空快照 → 空清单句（「父无模型索引」不退回 worker 自扫结果）", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        // worker 自扫看得见一条：空快照在场时它**不得**出现（快照是唯一来源）。
        skillCatalog: createSkillCatalog([
          entry("worker-only", "worker 自扫条目", "/no/such/dir/w"),
        ]),
        skillIndexSnapshot: [],
      })
    );

    const system = (await deps.system?.()) ?? "";
    assert.equal(
      availableSkillsBlock(system),
      "<available_skills>\nNo skills installed\n</available_skills>"
    );
  });

  it("快照名在 worker catalog 缺席 → 仍按快照渲染（「完整」优先于 worker 扫描根）", async () => {
    // 设计取舍（(a) 名单 + worker 侧按名解析 vs 直出条目）：父快照带着完整
    // description 过界，worker **不**按自己的 catalog 过滤 —— 否则插件根不同
    // 的场景会丢条目，与「完整模型索引」判据相悖。代价是此名在 worker 里
    // 无正文可加载（skill() 报 not found），这是「索引可见、正文取不到」的
    // 已知退化，不是静默丢行。
    const deps = await createWorkerDeps(
      hermeticOpts({
        skillCatalog: createSkillCatalog([]),
        skillIndexSnapshot: [
          { name: "parent-only", description: "只在父扫描根里的技能" },
        ],
      })
    );

    const system = (await deps.system?.()) ?? "";
    assert.equal(
      availableSkillsBlock(system),
      "<available_skills>\nparent-only: 只在父扫描根里的技能\n</available_skills>"
    );
  });

  it("相邻两次求值 byte-stable（worker 进程内冻表纪律，含快照路径）", async () => {
    const deps = await createWorkerDeps(
      hermeticOpts({
        skillCatalog: createSkillCatalog([]),
        skillIndexSnapshot: [{ name: "a", description: "甲" }, { name: "b" }],
      })
    );

    const first = (await deps.system?.()) ?? "";
    const second = (await deps.system?.()) ?? "";
    assert.equal(first, second);
  });

  it("交付点拷贝：父侧数组后续改写不回流 worker 冻表", async () => {
    const mutable: Array<{ name: string; description?: string }> = [
      { name: "kept", description: "原样" },
    ];
    const deps = await createWorkerDeps(
      hermeticOpts({
        skillCatalog: createSkillCatalog([]),
        skillIndexSnapshot: mutable,
      })
    );

    const before = (await deps.system?.()) ?? "";
    mutable.push({ name: "late-arrival", description: "spawn 之后才进场" });
    const after = (await deps.system?.()) ?? "";

    assert.equal(before, after, "spawn 快照是值，不是父侧数组的别名");
    assert.ok(!after.includes("late-arrival"));
  });
});

describe("worker system — 无父快照时退回独立 rescan（byte-stable）", () => {
  it("envelope 无 skillIndexSnapshot（旧 wire）→ worker 自扫结果逐字节不变", async () => {
    const workerOnly = entry(
      "worker-only",
      "worker 自扫条目",
      "/no/such/dir/w"
    );
    const skillCatalog = createSkillCatalog([workerOnly]);
    const baseline = await createWorkerDeps(hermeticOpts({ skillCatalog }));
    // 带 `skillIndexSnapshot: undefined` 键（显式缺席）与完全无键同形。
    const explicitUndefined = await createWorkerDeps(
      hermeticOpts({ skillCatalog, skillIndexSnapshot: undefined })
    );

    const baselineSystem = (await baseline.system?.()) ?? "";
    const explicitSystem = (await explicitUndefined.system?.()) ?? "";
    assert.equal(explicitSystem, baselineSystem);
    assert.equal(
      availableSkillsBlock(baselineSystem),
      skillsSegment([{ name: "worker-only", description: "worker 自扫条目" }])
    );
  });

  it("worker 自扫的 disabled 条目不进段（catalog 模型索引面既有语义不变）", async () => {
    const disabled: SkillEntry = {
      name: "off",
      description: "被 disable",
      dir: "/no/such/dir/off",
      disabled: true,
    };
    const deps = await createWorkerDeps(
      hermeticOpts({
        skillCatalog: createSkillCatalog([
          disabled,
          entry("on", "在", "/no/such/dir/on"),
        ]),
      })
    );

    const system = (await deps.system?.()) ?? "";
    assert.ok(!system.includes("被 disable"));
    assert.ok(availableSkillsBlock(system).includes("on: 在"));
  });

  it("真装配（未注入 skillCatalog / system）时 snapshot 缺席仍走到 worker 自扫路径", async () => {
    // 判别力：这条走 createWorkerDeps 的真装配分支（plugin 解析 + scanner），
    // 直接钉「无人给快照 → 行为不变」在生产装配路径上成立。
    const sandboxRoot = await mkdtemp(join(tmpdir(), "iknow-worker-snap-"));
    try {
      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot,
        userHome: sandboxRoot,
        cwd: sandboxRoot,
        projectIdentityRoot: sandboxRoot,
        model: createStubModel({ responses: [] }),
        trace: createNoopTraceService(),
        role: "general-purpose",
      });
      const system = (await deps.system?.()) ?? "";
      // 该 fixture 下没有任何技能根 → 空清单句（而不是段缺席）。
      assert.equal(
        availableSkillsBlock(system),
        "<available_skills>\nNo skills installed\n</available_skills>"
      );
    } finally {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("真装配 + snapshot 在场 → 段 = 快照（不经 worker 自扫）", async () => {
    const sandboxRoot = await mkdtemp(join(tmpdir(), "iknow-worker-snap-"));
    try {
      // 磁盘上放一条 worker 自扫能看见的技能：它**不得**出现在快照渲染里。
      const skillDir = join(sandboxRoot, ".iknow", "skills", "on-disk");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: on-disk\ndescription: 磁盘上的技能\n---\nbody",
        "utf8"
      );

      const deps = await createWorkerDeps({
        env: TEST_ENV,
        sandboxRoot,
        userHome: sandboxRoot,
        cwd: sandboxRoot,
        projectIdentityRoot: sandboxRoot,
        model: createStubModel({ responses: [] }),
        trace: createNoopTraceService(),
        role: "general-purpose",
        skillIndexSnapshot: [{ name: "from-parent", description: "父快照" }],
      });
      const system = (await deps.system?.()) ?? "";
      assert.equal(
        availableSkillsBlock(system),
        "<available_skills>\nfrom-parent: 父快照\n</available_skills>"
      );
      assert.ok(!system.includes("on-disk"));
    } finally {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  });
});

describe("worker prior — 不抄父的增量 user 消息（assumption 7）", () => {
  const encodeUserText = (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  });

  it("快照在场不新增任何 prior 段（父的隐藏 listing 消息不进 worker prior）", () => {
    const bare: WorkerEnvelope = {
      task: "do work",
      sandboxRoot: "/tmp/sb",
      writeSituation: "writable_main",
    };
    const withSnapshot: WorkerEnvelope = {
      ...bare,
      skillIndexSnapshot: [{ name: "injected-b", description: "父中途进场" }],
    };

    const a = priorMessagesFromEnvelope(bare, encodeUserText);
    const b = priorMessagesFromEnvelope(withSnapshot, encodeUserText);
    assert.deepEqual(b, a, "快照只喂 system 冻表，绝不进 prior");
  });

  it("快照里的名与描述不出现在 prior 文本里", () => {
    const prior = priorMessagesFromEnvelope(
      {
        task: "do work",
        sandboxRoot: "/tmp/sb",
        skillIndexSnapshot: [
          { name: "injected-b", description: "父中途进场的描述" },
        ],
      },
      encodeUserText
    );
    const text = JSON.stringify(prior ?? []);
    assert.ok(!text.includes("injected-b"));
    assert.ok(!text.includes("父中途进场的描述"));
    assert.ok(!text.includes("<available_skills>"));
  });
});
