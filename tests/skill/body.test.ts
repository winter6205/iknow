// Unit tests for skill body assembly (src/harness/skill/body.ts).
//
// Behavioral truth (ADR-0079):
//   - body = frontmatter stripped + `Base directory: <abs dir>` line
//     + `<skill_files>` segment (glob `**/*` excluding SKILL.md, sorted,
//     sampled ≤10, absolute paths, "file list is sampled" hint).
//   - references/ is not recursed: references/* never appear in skill_files.
//   - byte-stable: same input → identical string on repeat calls (KV cache contract).
//   - ADR-0079: assembly no longer appends the write-root trailer. Write-situation
//     disclosure moved to the worker prior + chat-session rebind one-shot notice,
//     sharing the `writeRootSegment` helper (still exported, covered below).
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
    // Matches the exact concatenation form in src/tui/app.tsx:1780 and web/src/hooks/use-slash-commands.ts:251.
    const text = `[skill-load name="foo"]\n${"x".repeat(500)}`;
    expect(isSkillLoadText(text)).toBe(true);
  });

  it("matches when wrapped in surrounding whitespace (predicate trims)", () => {
    // hub.ts validateText already trims internally; this predicate trims again
    // for symmetry with the non-trimming call site in chat-session.ts.
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
    // Defensive: `[skill-load name=foo]` without quotes would pass as valid, but it
    // does not match the TUI/Web concatenation form — a form change must fail
    // loudly on both sides, not silently pass.
    expect(isSkillLoadText("[skill-load name=foo]\nbody")).toBe(false);
  });

  it("does not match a literal prefix with a space (literal-only match)", () => {
    // The internal trim only absorbs leading whitespace; a mutated prefix must
    // still be rejected. This checks the strict `[skill-load name="` prefix after
    // trimming, not the trim itself (covered by the case above).
    expect(isSkillLoadText(' [skill-load name="foo"]\nbody')).toBe(true);
    expect(isSkillLoadText('[skill-loadname="foo"]\nbody')).toBe(false);
    expect(isSkillLoadText('[Skill-load name="foo"]\nbody')).toBe(false);
  });

  // Closing-form guard: a half prefix (no closing quote after `[skill-load name="`)
  // must be rejected, so hand-typed text cannot bypass the exemption.
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
    // Byte-identical to the inline assembly in src/tui/app.tsx:1780 — two
    // constructions of the same string must be equal (KV cache contract).
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
    // A one-shot load of a 78KB SKILL.md must be exempt; 50KB here simulates a typical large skill.
    const text = `[skill-load name="big"]\n${"x".repeat(50_000)}`;
    expect(exceedsUserInputCap(text, MAX_MESSAGE_CHARS)).toBe(false);
  });

  it("uses cap parameter (caller passes the SSOT MAX_MESSAGE_CHARS)", () => {
    // Pass a smaller cap directly to prove the function honors the parameter; no reliance on an implicit 8000 default.
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
    // ADR-0079 — createSkillBody no longer takes taskRoot / writeSituation;
    // assembly reads only entry + dir + fs, and same input twice yields equal
    // strings (KV cache contract) regardless of external taskRoot-shaped inputs.
    // This pins "taskRoot-shaped arguments cannot be read by the assembly face"
    // — a regression guard after the gatekeeping helper retired.
    const root = await mkdtemp(join(tmpdir(), "iknow-body-stable-tr-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const a = await createSkillBody({ entry: entry(dir, "echo"), dir });
    const b = await createSkillBody({ entry: entry(dir, "echo"), dir });
    expect(b).toBe(a);
    // The last segment must be </skill_files>; no write-root trailer is appended.
    expect(a.trimEnd().endsWith("</skill_files>")).toBe(true);
    expect(a).not.toContain("current write root");
  });
});

// ADR-0079 — createSkillBody no longer appends the write-root trailer: a skill-load
// message body always ends at </skill_files>. Write-root disclosure now lives in the
// worker prior (subagent/worker.ts) and the chat-session rebind one-shot notice
// (chat-session.ts:503-509), sharing the exported `writeRootSegment` helper (see the
// retained tests in the `writeRootSegment — T4 按处境三态渲染` describe).
// This describe pins "assembly never attaches a write root", including legacy
// taskRoot / writeSituation inputs that may still be passed in.
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
    // Gatekeeping ADR-0079: assembly is decoupled from external write-situation
    // inputs. If consumer paths (slash / skill() / loadSkillBody) ever mis-pass
    // taskRoot / writeSituation fields, assembly must fail closed and never render them.
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-legacy-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    // `as unknown as SkillBodyOptions` bypasses types to simulate legacy callers
    // passing taskRoot / writeSituation; the assembly face must ignore these fields.
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
    // The full assembled skill-load message keeps the length exemption; trailer removal does not affect this contract.
    const loadText = buildSkillLoadText("echo", text);
    expect(isSkillLoadText(loadText)).toBe(true);
    expect(exceedsUserInputCap(loadText, MAX_MESSAGE_CHARS)).toBe(false);
  });

  it("非 tree 形根 + no_writable_root 形态入参同样被忽略（fail-closed 守门）", async () => {
    // The old assembly rendered situation-enum ③ disclosure; the new one attaches
    // no trailer and renders no disclosure at all — the authoritative path moved to
    // worker prior + chat-session rebind.
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

// writeRootSegment renders per situation: states ① and ② must stay byte-identical to
// the pre-change form (hard constraint for prefix caching and the skill-load-write-root
// gate); state ③ is a new disclosure that must not name any tree-creation tool — the
// trailer enters context at assembly time, before any write intent, and naming a tool
// would push tree creation onto every unbound session. The empty arm is typed and does
// not throw (never render a half sentence like "写根 = " — "write root = ").
describe("writeRootSegment — T4 按处境三态渲染", () => {
  const TREE_ROOT = "/repo/.iknow/worktrees/conv1234";
  const MAIN_ROOT = "/home/user/project";

  // Legacy-form helper anchor: states ①/② must equal it byte for byte (hard constraint).
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
    // The renderer branches only on the enum and must not call isTaskWorktreePath
    // internally (dependency direction: body.ts does not import isolation). Shape
    // detection happens at the caller via writeSituation(); the renderer receives a typed enum.
    expect(writeRootSegment("writable_tree", MAIN_ROOT)).toBe(
      legacy(MAIN_ROOT)
    );
  });

  it("③ no_writable_root → 不含 current write root 字面（无可写对象，指向根是错的）", () => {
    const out = writeRootSegment("no_writable_root", TREE_ROOT);
    expect(out).not.toBeNull();
    expect(out).not.toContain("current write root");
    // Also must not embed taskRoot (no writable root → cannot tell the model which root to write).
    expect(out).not.toContain(TREE_ROOT);
  });

  it("③ no_writable_root → 含「无可写根 / 主仓对文件改动只读」语义（spec SC3）", () => {
    const out = writeRootSegment("no_writable_root", MAIN_ROOT)!;
    // At least "read-only" plus "main" or an equivalent phrasing — semantic assertion
    expect(out.toLowerCase()).toMatch(/read[- ]?only/);
    // "no writable root" semantics
    expect(out.toLowerCase()).toMatch(/(no.{0,3}writable|writable.{0,3}root)/);
  });

  it("③ no_writable_root → 不点名 create-worktree（SC3：trailer 在装配时进上下文，早于写意图）", () => {
    const out = writeRootSegment("no_writable_root", TREE_ROOT)!;
    expect(out).not.toContain("create-worktree");
    // No other advisory literals either (specific "create-*" tree tools, the "run"
    // verb, "re-issue this call" re-send guidance — all left to the receipt surface)
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
    // State ③ never embeds taskRoot — empty and blank roots render identically; the disclosure still appears.
    const out1 = writeRootSegment("no_writable_root", "");
    const out2 = writeRootSegment("no_writable_root", "   ");
    expect(out1).not.toBeNull();
    expect(out2).not.toBeNull();
    expect(out1).toBe(out2); // typed stable
    expect(out1).not.toContain("current write root");
    expect(out1).not.toContain("create-worktree");
  });
});

// ADR-0079 — createSkillBody no longer takes writeSituation / taskRoot; assembly is
// fully decoupled from write-situation judgment. This describe pins: even legacy-shaped
// inputs (taskRoot + writeSituation passed together, or flipped situations) must never
// render a write-root segment or ③ disclosure. The authoritative disclosure path is the
// worker prior (src/harness/subagent/worker.ts) + the chat-session rebind one-shot
// notice (src/cli/chat-session.ts:503-509), sharing the `writeRootSegment` helper
// (covered by the previous describe).
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
    // Gatekeeping: the old assembly rendered the trailer; the new one must not
    // render it even given identical inputs.
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
    // Gatekeeping: the old assembly rendered ③ disclosure; the new one must not
    // render it even given identical inputs. ③ disclosure moved to worker prior + chat-session rebind.
    const root = await mkdtemp(join(tmpdir(), "iknow-body-t4-no-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const taskRoot = "/home/user/project"; // non-tree path = main repo root
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      ...({
        writeSituation: "no_writable_root",
        taskRoot,
      } as unknown as Record<string, never>),
    });

    expect(text).not.toContain("current write root");
    // ADR-0079: skill body assembly no longer appends a write-root segment (the trailer
    // was deleted), so no "③ disclosure at the end of the body" assertion here; this only
    // pins that no tree tool is named.
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
    // The old flip semantics (② → ③ → byte change → prompt cache miss) no longer exist
    // after ADR-0079: assembly consumes neither ② nor ③, so a flip yields identical bytes.
    // This change tightens prompt cache misses to a single source: skill content drift itself.
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
