// #337 T6: skill 正文装配 (src/harness/skill/body.ts) 单测。
//
// 行为真值 (spec 337-skill-mcp-extension.md § Code Style + SC6)：
//   - 正文 = frontmatter 剥离 + `Base directory: <abs dir>` 提示行
//     + `<skill_files>` 段（glob `**/*` 排除 SKILL.md、排序、采样 ≤10、
//     绝对路径、"file list is sampled" 提示）。
//   - references/ 不递归：references/* 不出现在 skill_files 段里。
//   - 字节级稳定：同输入二次调用字符串相等（KV 缓存契约）。
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

  it("is byte-stable across repeat calls with the same non-empty taskRoot", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-stable-tr-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const a = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      taskRoot: "/tmp/task-wt",
    });
    const b = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      taskRoot: "/tmp/task-wt",
    });
    expect(b).toBe(a);
  });
});

// 写根 trailer（specs/skill-load-write-root.md）：文案 SSOT =
// writeRootSegment（与 worker prior 同一 helper）；追加位置 =
// </skill_files> 之后；空/缺 taskRoot → 与 337 SC6 现形态逐字节一致。
describe("createSkillBody write-root trailer", () => {
  it("omits the trailer entirely when taskRoot is undefined (byte-compat with pre-trailer SC6 shape)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-miss-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const text = await createSkillBody({ entry: entry(dir, "echo"), dir });

    expect(text).not.toContain("current write root");
    expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
  });

  it("omits the trailer for empty / whitespace taskRoot", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-blank-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    for (const taskRoot of ["", "   ", "\n"]) {
      const text = await createSkillBody({
        entry: entry(dir, "echo"),
        dir,
        taskRoot,
      });
      expect(text).not.toContain("current write root");
      expect(text.trimEnd().endsWith("</skill_files>")).toBe(true);
    }
  });

  it("appends the write-root segment after </skill_files> with the helper copy when taskRoot is non-empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-nonempty-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);
    await fixtureFile(dir, "helper.md", "x");

    const taskRoot = "/tmp/task-wt";
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      taskRoot,
    });

    const closing = text.lastIndexOf("</skill_files>");
    const tail = text.slice(closing + "</skill_files>".length);
    expect(tail).toContain("current write root");
    const segment = writeRootSegment(taskRoot)!;
    expect(tail).toContain(
      segment.slice(
        0,
        `current write root (for write_file / edit_file / bash cwd): ${taskRoot}`
          .length
      )
    );
    // trailer 永远是正文末段
    expect(text.trimEnd().endsWith(writeRootSegment(taskRoot)!.trimEnd())).toBe(
      true
    );
  });

  it("uses the same segment copy as the subagent worker prior (shared helper)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-helper-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\nbody`);

    const taskRoot = "/tmp/task-wt";
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      taskRoot,
    });

    // 同一 helper 的字节契约：trailer 内必须含与 worker prior 完全一致的
    // 两句（写根句 + 身份根只读句），顺序一致。
    expect(text).toContain(
      `current write root (for write_file / edit_file / bash cwd): ${taskRoot}\n`
    );
    expect(text).toContain(
      `System ## Project path is still the project identity root and is read-only; the write root above is where file mutations should land. Use relative paths from this root.`
    );
  });

  it("keeps the trailer at the end when SKILL.md is huge (skill-load length-cap exemption semantics unchanged)", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-body-wrt-overflow-"));
    roots.push(root);
    const dir = await fixtureDir(root, "echo");
    const huge = "x".repeat(90_000);
    await fixtureFile(dir, "SKILL.md", `---\nname: echo\n---\n${huge}`);
    await fixtureFile(dir, "helper.md", "x");

    const taskRoot = "/tmp/task-wt";
    const text = await createSkillBody({
      entry: entry(dir, "echo"),
      dir,
      taskRoot,
    });

    expect(text.length).toBeGreaterThan(90_000);
    expect(text.trimEnd().endsWith(writeRootSegment(taskRoot)!.trimEnd())).toBe(
      true
    );
    // 装配出的完整 skill-load 消息仍享受长度豁免
    const loadText = buildSkillLoadText("echo", text);
    expect(isSkillLoadText(loadText)).toBe(true);
    expect(exceedsUserInputCap(loadText, MAX_MESSAGE_CHARS)).toBe(false);
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
