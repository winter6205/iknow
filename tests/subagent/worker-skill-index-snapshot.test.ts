/**
 * Worker side of `specs/skill-index-increment.md` SC10 + assumption 7:
 * at spawn, the worker system's `<available_skills>` carries the **full
 * model-index snapshot of the parent session at that moment**; the worker
 * never copies the parent's incremental user messages into its prior.
 *
 * Contract (worker side):
 *   - envelope carries `skillIndexSnapshot` -> that snapshot is the sole
 *     source of the worker's index surface (including names the parent
 *     already pulled in — names absent from the worker's own scan);
 *   - rendering reuses `skillsSegment` (the single SSOT in
 *     `identity/assemble.ts`); the worker keeps no second renderer;
 *   - the snapshot has **value** semantics: two adjacent evaluations inside
 *     the worker process are byte-stable (frozen-table discipline); it is
 *     copied at the delivery point, later parent/caller mutation never flows back;
 *   - envelope **without** the field (legacy wire / direct assembly) -> falls
 *     back byte-for-byte to the worker's own independent rescan
 *     (`createSkillScanner`); both sides' system text deep-equals;
 *   - a snapshot name missing from the worker catalog -> still rendered (name +
 *     description verbatim): the spec's criterion is "complete", so entries are
 *     never dropped because the worker's scan roots are narrower — such a name
 *     becomes an entry in the worker whose description is visible but whose body
 *     cannot be loaded (same nature as a bare-name demoted index entry,
 *     ADR-0046 Decision 2); the absence behavior is **deterministic** on the
 *     worker side (visible in render / `skill()` reports not found), never
 *     silently rewritten into a narrower second listing;
 *   - prior surface: `priorMessagesFromEnvelope` gains no extra segment from a
 *     present snapshot (assumption 7 — the parent's hidden incremental user
 *     messages never enter the worker prior).
 *
 * Isolation: all tmp fixtures; model surface = stub (zero real calls).
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

/** Slice the `<available_skills>` block out of the full system text (assertion surface = what the model sees). */
function availableSkillsBlock(system: string): string {
  const start = system.indexOf("<available_skills>");
  const end = system.indexOf("</available_skills>");
  assert.ok(start >= 0 && end > start, "system 里应有 <available_skills> 段");
  return system.slice(start, end + "</available_skills>".length);
}

/**
 * Hermetic assembly seam: stub-model (zero model calls) + noop trace + injected catalog.
 *
 * `userHome` / `cwd` / `projectIdentityRoot` point at a **nonexistent tmp
 * path** (not the real HOME): identity / instruction / skill-root reads all
 * miss -> segment text is decided solely by this case's data, whatever skills
 * are installed on the run machine never affects assertions.
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
        // The worker's own scan only sees frozen-a: injected-b (pulled in mid-way by the parent) is not in it.
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
        // The worker's own scan sees one entry: with an empty snapshot present it **must not** appear (snapshot is the sole source).
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
    // Design trade-off ((a) name list + name-based resolution on the worker
    // side vs emitting entries directly): the parent snapshot crosses the
    // boundary with full descriptions, and the worker does **not** filter by
    // its own catalog — otherwise differing plugin roots would drop entries,
    // violating the "complete model index" criterion. The cost is that such a
    // name has no loadable body in the worker (skill() reports not found): a
    // known "index visible, body unavailable" degradation, never a silently
    // dropped row.
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
    // With the `skillIndexSnapshot: undefined` key (explicit absence) shaped identically to no key at all.
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
    // Discriminating power: this walks the real createWorkerDeps assembly
    // branch (plugin resolution + scanner), pinning "no snapshot given ->
    // behavior unchanged" on the production assembly path.
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
      // Under this fixture no skill roots exist at all -> empty-listing sentence (not a missing segment).
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
      // Put one on-disk skill the worker's own scan would see: it **must not** appear in the snapshot rendering.
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
