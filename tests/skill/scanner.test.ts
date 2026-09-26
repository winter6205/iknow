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
    const projectRoot = join(root, "project");
    const extra = join(root, "extra");
    await fixture(
      join(home, ".iknow", "skills"),
      "shared",
      "---\nname: shared\ndescription: user\n---\nuser"
    );
    await fixture(
      join(projectRoot, ".iknow", "skills"),
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
      projectIdentityRoot: projectRoot,
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
    const projectRoot = join(root, "project");
    await fixture(
      join(projectRoot, ".claude", "skills"),
      "forbidden",
      "---\nname: forbidden\ndescription: no\n---\nbody"
    );
    await fixture(
      join(projectRoot, ".iknow", "skills"),
      "wrong",
      "---\nname: wrong\ndescription: no\n---\nbody",
      "skill.md"
    );

    await expect(
      createSkillScanner({
        userHome: join(root, "home"),
        projectIdentityRoot: projectRoot,
        env: {},
      }).scan()
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
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    // The coerce boundary flattens every scalar to a string, so `version: 2`
    // arrives as "2" rather than the number 2.
    expect(entries[0]).toMatchObject({
      name: "fallback",
      disabled: true,
      source: "bundled",
      version: "2",
      tags: "test",
      author: "team",
      license: "MIT",
      metadata: "stable",
    });
    expect(entries[0].description).toHaveLength(1536);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("gives when_to_use its own 1536 budget and warn, independent of description", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "both-long",
      `---\nname: both-long\ndescription: ${"d".repeat(1540)}\nwhen_to_use: ${"w".repeat(1540)}\n---\nbody`
    );
    await fixture(
      skills,
      "hint-long",
      `---\nname: hint-long\ndescription: short one\nwhen_to_use: ${"w".repeat(2000)}\n---\nbody`
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    const both = byName.get("both-long")!;
    expect(both.description).toHaveLength(1536);
    expect(both.whenToUse).toHaveLength(1536);
    const hint = byName.get("hint-long")!;
    // Neither field's length can shorten the other's budget.
    expect(hint.description).toBe("short one");
    expect(hint.whenToUse).toHaveLength(1536);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skill description truncated")
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skill when_to_use truncated")
    );
  });

  it("keeps real newlines in a block-scalar when_to_use", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    await fixture(
      skills,
      "multiline",
      "---\nname: multiline\ndescription: one line\nwhen_to_use: |\n  pick this skill\n  for that job\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
    }).scan();

    expect(entries[0].whenToUse).toBe("pick this skill\nfor that job\n");
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
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "hidden",
      description: undefined,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skill skipped malformed frontmatter")
    );
  });

  it("folds a flow sequence into the key it follows, inline and on continuation lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "session-handoff",
      "---\nname: session-handoff\ndescription: Use when a session ends with unfinished work another agent must continue.\ntags: [productivity, handoff]\nrelated_skills:\n  [using-agent-skills, domain-modeling, verification-before-completion]\nversion: 1.1.0\ndisable-model-invocation: true\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "session-handoff",
      description:
        "Use when a session ends with unfinished work another agent must continue.",
      disabled: true,
      version: "1.1.0",
      tags: "productivity, handoff",
    });
    // A scalar sequence is a value shape the coerce boundary folds, so nothing
    // about this file is degraded — a warning here would be a false alarm.
    expect(warn).not.toHaveBeenCalled();
  });

  it("folds a block sequence into the key it follows", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "seq-skill",
      "---\nname: seq-skill\ndescription: indexes a block sequence\ntags:\n  - writing\n  - handoff\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "seq-skill",
      description: "indexes a block sequence",
      tags: "writing, handoff",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("loads a block-scalar description as the folded text the author wrote", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "scalar-skill",
      "---\nname: scalar-skill\ndescription: >\n  Reviews a finished session.\n  Writes the handoff file.\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    // `>` folds the lines and keeps the clip chomping newline — the coerce
    // boundary is a string of the block's content, not a re-cut of it.
    expect(entries[0]).toMatchObject({
      name: "scalar-skill",
      description: "Reviews a finished session. Writes the handoff file.\n",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips a nested mapping with a warning and never registers its child keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "mapping-skill",
      "---\nname: clean\ndescription: keeps working\nmetadata:\n  name: inner-name\n  version: 9\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "clean",
      description: "keeps working",
    });
    // The skipped key stays absent instead of carrying a stringified map, and
    // no child of it reaches the entry (`inner-name` / `version: 9`).
    expect(entries[0]).not.toHaveProperty("metadata");
    expect(entries[0]).not.toHaveProperty("version");
    expect(JSON.stringify(entries[0])).not.toContain("inner-name");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('key "metadata" is a mapping')
    );
  });

  it("never lets a mapping under `name` pollute the identity field", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "mapping-name",
      "---\nname:\n  clean: inner\ndescription: keeps working\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "mapping-name",
      description: "keeps working",
    });
    expect(JSON.stringify(entries[0])).not.toContain("inner");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("drops the whole block once, keeps the skill indexed under its directory name", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    // A plain scalar value carrying `: ` is a block-level syntax error, so the
    // fields are dropped together (block-atomic) rather than partly surviving
    // as unparseable lines.
    await fixture(
      skills,
      "degraded-skill",
      '---\nname: not-the-name\ndescription: Use when the reviewer emits "GATE: BLOCKED" or High\n---\nbody'
    );
    await fixture(
      skills,
      "healthy-skill",
      "---\nname: healthy-skill\ndescription: still scanned\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(2);
    const degraded = entries.find(
      (entry) => entry.dir === join(skills, "degraded-skill")
    );
    expect(degraded).toMatchObject({
      name: "degraded-skill",
      description: undefined,
      disabled: false,
    });
    expect(JSON.stringify(degraded)).not.toContain("not-the-name");
    expect(
      entries.find((e) => e.dir === join(skills, "healthy-skill"))
    ).toMatchObject({ name: "healthy-skill", description: "still scanned" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `skill frontmatter degraded: ${join(skills, "degraded-skill", "SKILL.md")}`
      )
    );
  });

  it("keeps the fields a keyless entry only spoils for itself and warns once for it", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "noisy",
      "---\nname: noisy\n  first stray line\ndescription: still indexed\n  second stray line\n: leading separator\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    // Indented continuation lines are YAML plain-scalar folding, not stray
    // lines; only the keyless entry is dropped, and it warns alone.
    expect(entries[0]).toMatchObject({
      name: "noisy first stray line",
      description: "still indexed second stray line",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("falls back to the parent name when the block is not a key/value mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(
      skills,
      "unreadable-fields",
      "---\nstray\nlines only\n---\nbody"
    );

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "unreadable-fields",
      description: undefined,
      disabled: false,
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("not a key/value mapping")
    );
  });

  it("indexes an empty frontmatter block without warning", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    const skills = join(root, "skills");
    const warn = vi.fn();
    await fixture(skills, "blank", "---\n\n---\nbody");

    const entries = await createSkillScanner({
      userHome: join(root, "home"),
      projectIdentityRoot: root,
      env: { IKNOW_SKILL_DIRS: skills },
      warn,
    }).scan();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "blank", disabled: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns an empty index when all scan directories are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "iknow-skill-"));
    roots.push(root);
    await expect(
      createSkillScanner({
        userHome: join(root, "home"),
        projectIdentityRoot: join(root, "cwd"),
        env: {},
      }).scan()
    ).resolves.toEqual([]);
  });
});
