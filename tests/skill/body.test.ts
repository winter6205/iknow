// #337 T6: skill 正文装配 (src/harness/skill/body.ts) 单测。
//
// 行为真值 (spec 337-skill-mcp-extension.md § Code Style + SC6 + ADR-0079)：
//   - 正文 = frontmatter 剥离 + `Base directory: <abs dir>` 提示行
//     + `<skill_files>` 段（glob `**/*` 排除 SKILL.md、排序、采样 ≤10、
//     绝对路径、"file list is sampled" 提示）。
//   - references/ 不递归：references/* 不出现在 skill_files 段里。
//   - 字节级稳定：同输入二次调用字符串相等（KV 缓存契约）。
//   - ADR-0079：装配结果不再追加写根 trailer（与 337 SC6 形态逐字节一致）。
//     写处境披露的权威路径迁到 worker prior + chat-session rebind 一次性通
//     知，共用同一 helper `writeRootSegment`（仍 export，本文件继续覆盖）。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SKILL_LOAD_PREFIX,
  buildSkillLoadText,
  createSkillBody,
  exceedsUserInputCap,
  isSkillLoadText,
  stripFrontmatter,
  writeRootSegment,
} from "../../src/harness/skill/body.js";
import { MAX_MESSAGE_CHARS } from "../../src/session-api/contract.ts";
import type { SkillEntry } from "../../src/harness/skill/catalog.js";

const roots: string[] = [];

async function fixtureDir(root: string, name: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function fixtureFile(
  dir: string,
  name: string,
  contents: string
): Promise<void> {
  await writeFile(join(dir, name), contents, "utf8");
}

function entry(dir: string, name: string): SkillEntry {
  return {
    name,
    description: "test",
    dir,
    disabled: false,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("isSkillLoadText", () => {
  it("matches the canonical skill-load prefix used by TUI and Web senders", () => {
    // 与 src/tui/app.tsx:1780、web/src/hooks/use-slash-commands.ts:251 拼接形态一致。
    const text = `[skill-load name="foo"]\n${"x".repeat(500)}`;
    expect(isSkillLoadText(text)).toBe(true);
  });

  it("matches when wrapped in surrounding whitespace (predicate trims)", () => {
    // 真实路径里 hub.ts validateText 已在内部 trim 一次；本谓词再做 trim
    // 是为对称 chat-session.ts 的非 trim 调用点。
    expect(isSkillLoadText(`   [skill-load name="foo"]\nbody`)).toBe(true);
    expect(isSkillLoadText(`\n[skill-load name="foo"]`)).toBe(true);
  });

  it("does not match plain user text or empty input", () => {
    expect(isSkillLoadText("hello world")).toBe(false);
    expect(isSkillLoadText("")).toBe(false);
    expect(isSkillLoadText("   ")).toBe(false);
    expect(isSkillLoadText('skill-load name="foo"')).toBe(false);
  });

  it("does not match a prefix that is missing the opening quote", () => {
    // 防御性：无引号的 `[skill-load name=foo]` 会被误判为合法，但与 TUI/Web
    // 拼接形态不一致 —— 形态变更时应让两侧显式失败，而不是静默通过。
    expect(isSkillLoadText("[skill-load name=foo]\nbody")).toBe(false);
  });

  it("does not match a literal prefix with a space (literal-only match)", () => {
    // 谓词内部 trim 是为对称 chat-session.ts 未 trim 的调用点；
    // 故首字符前的空格会被吃掉，但「前缀内容变形」仍应被拒。
    // 这里验证的不是 trim 行为（见同行 case），而是 trim 后是否仍含
    // 严格 `[skill-load name="` 前缀。
    expect(isSkillLoadText(' [skill-load name="foo"]\nbody')).toBe(true);
    expect(isSkillLoadText('[skill-loadname="foo"]\nbody')).toBe(false);
    expect(isSkillLoadText('[Skill-load name="foo"]\nbody')).toBe(false);
  });

  // Review Medium 3：闭合形态断言。半截前缀（仅 `[skill-load name="` 后无闭合
  // 双引号）必须被拒，避免手打恶意文本绕过豁免。
  it("rejects a half-prefix with no closing quote (review Medium 3)", () => {
    expect(isSkillLoadText('[skill-load name="' + "x".repeat(50_000))).toBe(
      false
    );
    expect(isSkillLoadText('[skill-load name="]')).toBe(false);
    expect(isSkillLoadText(`[skill-load name="${"a".repeat(10)}`)).toBe(false);
  });

  it("accepts a closed prefix regardless of the body size", () => {
    expect(
      isSkillLoadText(`[skill-load name="foo"]\n${"x".repeat(50_000)}`)
    ).toBe(true);
  });
});

describe("buildSkillLoadText (SSOT)", () => {
  it("matches byte-level the inline assembly in TUI app.tsx:1780-1782", () => {
    // 与 src/tui/app.tsx:1780 拼接形态 byte 级一致 —— 同一字符串的两次构造
    // 应完全相等（KV 缓存契约）。
    const name = "echo";
    const body = "skill body content";
    const remainder = "user follow-up";
    const expected = `[skill-load name="${name}"]\n${body}\n\n${remainder}`;
    expect(buildSkillLoadText(name, body, remainder)).toBe(expected);
  });

  it("omits the trailing separator when remainder is undefined or empty", () => {
    expect(buildSkillLoadText("echo", "body")).toBe(
      `[skill-load name="echo"]\nbody`
    );
    expect(buildSkillLoadText("echo", "body", "")).toBe(
      `[skill-load name="echo"]\nbody`
    );
  });

  it("uses SKILL_LOAD_PREFIX as the prefix constant (single source of truth)", () => {
    expect(buildSkillLoadText("x", "y").startsWith(SKILL_LOAD_PREFIX)).toBe(
      true
    );
  });
});

describe("exceedsUserInputCap (shared guard)", () => {
  it("returns false for empty / whitespace input (non-empty check is upstream)", () => {
    expect(exceedsUserInputCap("", MAX_MESSAGE_CHARS)).toBe(false);
    expect(exceedsUserInputCap("   ", MAX_MESSAGE_CHARS)).toBe(false);
  });

  it("returns true for plain text exceeding MAX_MESSAGE_CHARS", () => {
    expect(
      exceedsUserInputCap("x".repeat(MAX_MESSAGE_CHARS + 1), MAX_MESSAGE_CHARS)
    ).toBe(true);
    expect(
      exceedsUserInputCap(
        `normal text ${"x".repeat(MAX_MESSAGE_CHARS - "normal text ".length + 1)}`,
        MAX_MESSAGE_CHARS
      )
    ).toBe(true);
  });

  it("returns false for plain text at or below MAX_MESSAGE_CHARS", () => {
    expect(
      exceedsUserInputCap("x".repeat(MAX_MESSAGE_CHARS), MAX_MESSAGE_CHARS)
    ).toBe(false);
    expect(exceedsUserInputCap("hi", MAX_MESSAGE_CHARS)).toBe(false);
  });

  it("returns false for skill-load messages even when extremely long (exempt)", () => {
    // 78KB SKILL.md 一次性加载必须豁免；这里用 50KB 模拟典型大 skill。
    const text = `[skill-load name="big"]\n${"x".repeat(50_000)}`;
    expect(exceedsUserInputCap(text, MAX_MESSAGE_CHARS)).toBe(false);
  });

  it("uses cap parameter (caller passes the SSOT MAX_MESSAGE_CHARS)", () => {
    // 直接传更小的 cap 验证函数尊重参数；不依赖隐式默认 8000。
    expect(exceedsUserInputCap("x".repeat(11), 10)).toBe(true);
    expect(exceedsUserInputCap("x".repeat(10), 10)).toBe(false);
  });
});

describe("stripFrontmatter", () => {
  it("strips a YAML frontmatter block delimited by ---", () => {
    const raw = `---\nname: foo\ndescription: bar\n---\nbody line 1\nbody line 2`;
    expect(stripFrontmatter(raw)).toBe("body line 1\nbody line 2");
  });

  it("strips a frontmatter block with trailing newline", () => {
    const raw = `---\nname: foo\n---\nbody`;
    expect(stripFrontmatter(raw)).toBe("body");
  });

  it("returns raw body unchanged when no frontmatter block exists", () => {
    const raw = "no frontmatter here\njust body";
    expect(stripFrontmatter(raw)).toBe(raw);
  });
});

describe("createSkillBody", () => {
  it("strips frontmatter, appends Base directory line, renders empty skill_files for an empty skill dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-empty-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(
      dir,
      "SKILL.md",
      `---\nname: echo\ndescription: repeat input\n---\nhello world`
    );

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });

    expect(text).toContain("hello world");
    expect(text).not.toContain("---");
    expect(text).not.toContain("name: echo");
    expect(text).toContain(`Base directory: ${dir}`);
    expect(text).toContain("<skill_files>");
    expect(text).toContain("</skill_files>");
  });

  it("lists auxiliary files with absolute paths, sorted, excluding SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-list-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);
    await fixtureFile(dir, "z-last.md", "z");
    await fixtureFile(dir, "a-first.md", "a");
    await fixtureFile(dir, "m-mid.md", "m");

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });

    const segment = extractSegment(text, "skill_files");
    const lines = segment
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    expect(lines).toEqual([
      `${dir}${sep}a-first.md`,
      `${dir}${sep}m-mid.md`,
      `${dir}${sep}z-last.md`,
    ]);
  });

  it("samples to at most 10 files and emits a 'file list is sampled' hint when more exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-sample-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);
    // Create 15 auxiliary files so the sampler must truncate.
    for (let i = 0; i < 15; i += 1) {
      const name = `file-${String(i).padStart(2, "0")}.md`;
      await fixtureFile(dir, name, "x");
    }

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });

    const segment = extractSegment(text, "skill_files");
    const lines = segment
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.includes("file list is sampled"));
    expect(lines).toHaveLength(10);
    expect(text).toContain("file list is sampled");
  });

  it("does not list files under a references/ directory (SC6)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-refs-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);
    const refs = join(dir, "references");
    await mkdir(refs, { recursive: true });
    await fixtureFile(refs, "secret.md", "x");
    await fixtureFile(refs, "deep.md", "x");
    // Top-level helper is still listed.
    await fixtureFile(dir, "helper.md", "x");

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });
    const segment = extractSegment(text, "skill_files");

    expect(segment).toContain("helper.md");
    expect(segment).not.toContain("references");
    expect(segment).not.toContain("secret.md");
    expect(segment).not.toContain("deep.md");
  });

  it("is byte-stable across repeat calls with the same input", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-stable-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);
    await fixtureFile(dir, "helper.md", "x");

    const a = await createSkillBody({ entry: entry(dir, "echo"), dir });
    const b = await createSkillBody({ entry: entry(dir, "echo"), dir });
    expect(b).toBe(a);
  });

  it("is byte-stable across repeat calls regardless of any external taskRoot-shaped inputs", async () => {
    // ADR-0079 — createSkillBody 不再吃 taskRoot / writeSituation 字段；
    // 装配面只读 entry + dir + fs。同输入两次调用字符串相等（KV 缓存契约），
    // 与外部 taskRoot 形态无关。本用例锁住「外部即便试图塞入 taskRoot 形
    // 状的入参也不会被装配面读走」这条不变式 —— 守门 helper 退场后的回归。
    const root = await mkdtemp(join(tmpdir(), "iknow-body-stable-tr-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const a = await createSkillBody({ entry: entry(dir, "echo"), dir });
    const b = await createSkillBody({ entry: entry(dir, "echo"), dir });
    expect(b).toBe(a);
    // 末段必须是 </skill_files>，不再追加写根段。
    expect(a.trimEnd().endsWith("</skill_files>")).toBe(true);
    expect(a).not.toContain("current write root");
  });
});

// ADR-0079 — createSkillBody 不再追加写根 trailer。skill-load 消息正文末段
// 始终是 </skill_files>（与 337 SC6 形态逐字节一致）；写根披露的权威路径
// 迁到 worker prior（subagent/worker.ts）+ chat-session rebind 一次性通知
// （chat-session.ts:503-509），共用同一 helper `writeRootSegment`（仍 export
// 在 body.ts —— 见 `writeRootSegment — T4 按处境三态渲染` describe 的保留
// 测试）。本 describe 钉住「装配面不挂写根」这条不变式，并覆盖历史 taskRoot
// / writeSituation 形态的入参即便仍被传入也不会出现在正文里。
describe("createSkillBody 写根不挂正文（ADR-0079）", () => {
  it("无 taskRoot / writeSituation 入参 → 末段是 </skill_files>，与 337 SC6 形态逐字节一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-miss-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });

    expect(text).not.toContain("current write root");
    expect(text).not.toContain("no writable root");
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("即便传入 taskRoot 形态入参 → 装配面只读 entry + dir，正文仍无写根段", async () => {
    // 守门 ADR-0079：装配面与外部写处境输入解耦。即便消费方路径（slash /
    // skill() / loadSkillBody）未来若误传 taskRoot / writeSituation 形态入参
    // —— 装配面必须 fail-closed，不允许它们出现在正文里。
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-legacy-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    // 用 `as unknown as SkillBodyOptions` 绕过类型——模拟旧调用方传入
    // taskRoot / writeSituation 形态的兜底；装配面必须忽略这些字段。
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        taskRoot: "/tmp/task-wt",
        writeSituation: "writable_tree",
      } as unknown as Record<string, never>),
    });

    expect(text).not.toContain("current write root");
    expect(text).not.toContain("/tmp/task-wt");
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("SKILL.md 大到 90KB → 末段仍是 </skill_files>，装配文本仍享受 skill-load 长度豁免", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-overflow-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    const huge = "x".repeat(90_000);
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\n${huge}`);
    await fixtureFile(dir, "helper.md", "x");

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });

    expect(text.length).toBeGreaterThan(90_000);
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
    expect(text).not.toContain("current write root");
    // 装配出的完整 skill-load 消息仍享受长度豁免（trailer 退场不影响此契约）
    const loadText = buildSkillLoadText("echo", text);
    expect(isSkillLoadText(loadText)).toBe(true);
    expect(exceedsUserInputCap(loadText, MAX_MESSAGE_CHARS)).toBe(false);
  });

  it("非 tree 形根 + no_writable_root 形态入参同样被忽略（fail-closed 守门）", async () => {
    // 旧装配面会按处境枚举渲染 ③ 态披露；新装配面已不挂 trailer，连披露
    // 也不渲染 —— 披露的权威路径迁到 worker prior + chat-session rebind。
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-no-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        taskRoot: "/home/user/project",
        writeSituation: "no_writable_root",
      } as unknown as Record<string, never>),
    });

    expect(text).not.toContain("current write root");
    expect(text).not.toContain("no writable root");
    expect(text).not.toContain("/home/user/project");
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });
});

// T4 (plans/write-situation-disclosure.md) — writeRootSegment 改为按处境
// 渲染；①② 两态与改造前逐字节相等（SC2 硬约束，前缀缓存与
// skill-load-write-root SC2 守门）；③ 态是新披露，不点名建树工具（SC3 /
// ADR-0069 Decision 3「trailer 在 skill 装配时进上下文，早于任何写意图；
// 点名工具 = 对每个未绑会话推一次建树」）。empty 臂 typed 不 throw
//（A 表 empty 臂：不渲染出「写根 = 」这种半句）。
describe("writeRootSegment — T4 按处境三态渲染", () => {
  const TREE_ROOT = "/repo/.iknow/worktrees/conv1234";
  const MAIN_ROOT = "/home/user/project";

  // 旧形态 helper 锚（= ①/② 在新版里必须逐字节等于它）。SC2 硬约束。
  const legacy = (root: string): string | null => {
    const trimmed = root.trim();
    if (trimmed.length === 0) return null;
    return (
      `current write root (for write_file / edit_file / bash cwd): ${trimmed}\n` +
      `System ## Project path is still the project identity root and is read-only; the write root above is where file mutations should land. Use relative paths from this root.`
    );
  };

  it("① writable_main + 非空根 → 与旧 writeRootSegment(root) 逐字节相等（SC2 硬约束）", () => {
    for (const root of [MAIN_ROOT, TREE_ROOT, "/tmp/any-abs"]) {
      expect(writeRootSegment("writable_main", root)).toBe(legacy(root));
    }
  });

  it("② writable_tree + 树形根 → 与旧 writeRootSegment(root) 逐字节相等（SC2 硬约束）", () => {
    expect(writeRootSegment("writable_tree", TREE_ROOT)).toBe(
      legacy(TREE_ROOT)
    );
  });

  it("② writable_tree + 非树形根 → 仍按 (situation, root) 渲染；与旧形态逐字节相等（形状判定归 writeSituation，不在渲染面重复）", () => {
    // 渲染面只按枚举分支，不在内部再调 isTaskWorktreePath（spec SC4 钉死
    // 依赖方向：body.ts 不 import isolation）。形状判定由 writeSituation()
    // 在调用方做；渲染面拿到的就是 typed enum。
    expect(writeRootSegment("writable_tree", MAIN_ROOT)).toBe(
      legacy(MAIN_ROOT)
    );
  });

  it("③ no_writable_root → 不含 current write root 字面（无可写对象，指向根是错的）", () => {
    const out = writeRootSegment("no_writable_root", TREE_ROOT);
    expect(out).not.toBeNull();
    expect(out).not.toContain("current write root");
    // 也不嵌入 taskRoot（无可写根 → 不能告诉模型去写哪个根）
    expect(out).not.toContain(TREE_ROOT);
  });

  it("③ no_writable_root → 含「无可写根 / 主仓对文件改动只读」语义（spec SC3）", () => {
    const out = writeRootSegment("no_writable_root", MAIN_ROOT)!;
    // 至少含「read-only」与「main」或「主仓」等价表述 —— 语义断言
    expect(out.toLowerCase()).toMatch(/read[- ]?only/);
    // 「no writable root」语义（spec SC3 明文）
    expect(out.toLowerCase()).toMatch(/(no.{0,3}writable|writable.{0,3}root)/);
  });

  it("③ no_writable_root → 不点名 create-worktree（SC3 / ADR-0069 D3：trailer 在装配时进上下文，早于写意图）", () => {
    const out = writeRootSegment("no_writable_root", TREE_ROOT)!;
    expect(out).not.toContain("create-worktree");
    // 也不含其他可能的推销字面（具体的「create-*」建树工具 + 「run」动词 +
    // 「re-issue this call」重发引导 —— 全部留给回执面）
    expect(out).not.toMatch(/create-\w+/);
    expect(out).not.toMatch(/\bre-issue\b/i);
    expect(out).not.toMatch(/\bcall\b/i);
  });

  it("empty 臂（typed，不 throw）：writable_main + 空 / 空白根 → null（不渲染「写根 = 」半句）", () => {
    expect(writeRootSegment("writable_main", "")).toBeNull();
    expect(writeRootSegment("writable_main", "   ")).toBeNull();
    expect(writeRootSegment("writable_main", "\t\n")).toBeNull();
    expect(() => writeRootSegment("writable_main", "")).not.toThrow();
  });

  it("empty 臂：writable_tree + 空 / 空白根 → null", () => {
    expect(writeRootSegment("writable_tree", "")).toBeNull();
    expect(writeRootSegment("writable_tree", "   ")).toBeNull();
  });

  it("empty 臂：no_writable_root + 空 / 空白根 → 仍返回③ 态披露（typed，不抛；披露与根无关）", () => {
    // ③ 态本身就不嵌入 taskRoot —— 空根与空根同形态；披露照样给出。
    const out1 = writeRootSegment("no_writable_root", "");
    const out2 = writeRootSegment("no_writable_root", "   ");
    expect(out1).not.toBeNull();
    expect(out2).not.toBeNull();
    expect(out1).toBe(out2); // typed stable
    expect(out1).not.toContain("current write root");
    expect(out1).not.toContain("create-worktree");
  });
});

// ADR-0079 — createSkillBody 不再吃 writeSituation / taskRoot，装配面彻底与
// 写处境判定解耦。本 describe 锁住「即便历史形态的入参（taskRoot + write-
// Situation 同进同出 / 处境翻转）被传入，也绝不渲染任何写根段或 ③ 态披露」
// 这条不变式 —— 写处境的权威路径迁到 worker prior（src/harness/subagent/
// worker.ts）+ chat-session rebind 一次性通知（src/cli/chat-session.ts:
// 503-509），共用同一 helper `writeRootSegment`（覆盖见上一个 describe）。
describe("createSkillBody 装配面与写处境解耦（ADR-0079）", () => {
  it("无 taskRoot / writeSituation 入参 → 末段是 </skill_files>，与 337 SC6 形态逐字节一致", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-miss-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });
    expect(text).not.toContain("current write root");
    expect(text).not.toContain("no writable root");
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("writable_tree 形态入参 + 树形根 → 正文不出现 'current write root'", async () => {
    // 守门：旧 T4 装配口会渲染 trailer；新装配面即便被传入同形态入参也
    // 不渲染。
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-tree-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const taskRoot = "/repo/.iknow/worktrees/conv1234";
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        writeSituation: "writable_tree",
        taskRoot,
      } as unknown as Record<string, never>),
    });

    expect(text).not.toContain("current write root");
    expect(text).not.toContain(taskRoot);
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("writable_main 形态入参 + 任意根 → 正文不出现 'current write root'", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-main-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const taskRoot = "/home/user/project";
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        writeSituation: "writable_main",
        taskRoot,
      } as unknown as Record<string, never>),
    });

    expect(text).not.toContain("current write root");
    expect(text).not.toContain(
      `current write root (for write_file / edit_file / bash cwd): ${taskRoot}`
    );
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("no_writable_root 形态入参（隔离 ON 未绑树典型）→ 正文不出现 ③ 态披露", async () => {
    // 守门：旧 T4 装配口会渲染 ③ 态披露；新装配面即便被传入同形态入参也
    // 不渲染。③ 态披露的权威路径迁到 worker prior + chat-session rebind。
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-no-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const taskRoot = "/home/user/project"; // 非树形 = 主仓根
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        writeSituation: "no_writable_root",
        taskRoot,
      } as unknown as Record<string, never>),
    });

    expect(text).not.toContain("current write root");
    // #981 / ADR-0079：skill 正文装配不再追加写根段（trailer 已删除），
    // 故不再断言「③ 态披露在正文末段」；此处只钉死不点名建树工具。
    expect(text).not.toContain("no writable root");
    expect(text).not.toContain("create-worktree");
    expect(text).not.toContain(taskRoot);
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("只传 taskRoot 不传 writeSituation → fail-closed 无写根段（与改造前 SC6 一致）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-fc-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({ taskRoot: "/tmp/legacy-call" } as unknown as Record<string, never>),
    });

    expect(text).not.toContain("current write root");
    expect(text).not.toContain("/tmp/legacy-call");
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("只传 writeSituation 不传 taskRoot → fail-closed 无写根段", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-empty-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({ writeSituation: "writable_tree" } as unknown as Record<
        string,
        never
      >),
    });

    expect(text).not.toContain("current write root");
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("同输入两次调用字符串相等（KV 缓存契约；trailer 退场后由 entry + dir + fs 唯一驱动）", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-stable-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const a = await createSkillBody({ entry: entry(dir, "echo"), dir });
    const b = await createSkillBody({ entry: entry(dir, "echo"), dir });
    expect(b).toBe(a);
  });

  it("处境翻转（② → ③）不再改变装配字节 —— 写处境彻底不再流入装配面", async () => {
    // ADR-0069 Consequences 的旧翻转语义（② → ③ → 字节变化 → prompt cache
    // miss）在 ADR-0079 后不存在：装配面既不吃 ② 也不吃 ③ → 翻转 = 同字节。
    // 这条变更把 prompt cache miss 收紧到「只来自 skill 自身内容漂移」一处。
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-flip-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const treeBody = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        writeSituation: "writable_tree",
        taskRoot: "/repo/.iknow/worktrees/conv1234",
      } as unknown as Record<string, never>),
    });
    const noRootBody = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        writeSituation: "no_writable_root",
        taskRoot: "/repo/.iknow/worktrees/conv1234",
      } as unknown as Record<string, never>),
    });
    expect(treeBody).toBe(noRootBody);
    expect(treeBody).not.toContain("current write root");
    expect(treeBody).not.toContain("no writable root");
  });
});

function extractSegment(text: string, name: string): string {
  const open = `<${name}>`;
  const close = `</${name}>`;
  const start = text.indexOf(open);
  const end = text.indexOf(close);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start + open.length, end);
}
