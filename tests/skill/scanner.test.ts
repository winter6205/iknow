import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkillScanner } from "../../src/harness/skill/scanner.js";

const roots: string[] = [];

async function fixture(
  root: string,
  relativeDir: string,
  content: string,
  file = "SKILL.md"
) {
  const dir = join(root, relativeDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), content, "utf8");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("createSkillScanner", () => {
  it("scans user, project, then env directories with later duplicate names winning", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    const extra = join(root, "extra");
    await fixture(
      join(home, ".iknow", "skills"),
      "shared",
      "---\nname: shared\ndescription: user\n---\nuser"
    );
    await fixture(
      join(cwd, ".iknow", "skills"),
      "shared",
      "---\nname: shared\ndescription: project\n---\nproject"
    );
    await fixture(
      extra,
      "shared",
      "---\nname: shared\ndescription: env\n---\nenv"
    );

    const entries = await createSkillScanner({
      userHome: home,
      cwd,
      env: { IKNOW_SKILL_DIRS: extra },
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "shared",
      description: "env",
      dir: join(extra, "shared"),
    });
  });

  it("never scans .claude/skills and only recognizes SKILL.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const cwd = join(root, "project");
    await fixture(
      join(cwd, ".claude", "skills"),
      "forbidden",
      "---\nname: forbidden\ndescription: no\n---\nbody"
    );
    await fixture(
      join(cwd, ".iknow", "skills"),
      "wrong",
      "---\nname: wrong\ndescription: no\n---\nbody",
      "skill.md"
    );

    await expect(
      createSkillScanner({ userHome: join(root, "home"), cwd, env: {} }).scan()
    ).resolves.toEqual([]);
  });

  it("parses effective and archived fields, falls back to the parent name, and truncates descriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "fallback",
      `---\ndescription: ${"x".repeat(1540)}\ndisable-model-invocation: true\nsource: bundled\nversion: 2\ntags: test\nauthor: team\nlicense: MIT\nmetadata: stable\n---\nbody`
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      cwd: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries[0]).toMatchObject({
      name: "fallback",
      disabled: true,
      source: "bundled",
      version: 2,
      tags: "test",
      author: "team",
      license: "MIT",
      metadata: "stable",
    });
    expect(entries[0].description).toHaveLength(1536);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("keeps missing-description entries out of availability and skips malformed siblings with a warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(skills, "hidden", "---\nname: hidden\n---\nbody");
    await fixture(skills, "broken", "not frontmatter");

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      cwd: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "hidden",
      description: undefined,
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns an empty index when all scan directories are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    await expect(
      createSkillScanner({
        userHome: join(root, "home"),
        cwd: join(root, "cwd"),
        env: {},
      }).scan()
    ).resolves.toEqual([]);
  });
});
