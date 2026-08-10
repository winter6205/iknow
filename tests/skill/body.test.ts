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
  createSkillBody,
  stripFrontmatter,
} from "../../src/harness/skill/body.js";
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
