/**
 * tests/harness/permission/project-settings.test.ts
 *
 * Loader tests for the `permissions` section of `<cwd>/.iknow/settings.json`
 * (T6 / #122 Q2b; ADR-0084 moved the section out of `.iknow/permissions.toml`;
 * ADR-0090 replaced the predicate DSL with the declarative string lists).
 *
 * Boundary classes covered:
 *  - normal: missing settings file / missing `permissions` section /
 *    declarative section → policy source.
 *  - negative: schema violation (unknown key, wrong value type, bad
 *    `defaultMode`) → throws with descriptive message.
 *  - legacy: `schema_version` + `rule[]` → typed fail-loud naming the new form.
 *  - exception: retired toml + JSON section both present → typed fail-loud.
 *  - forbidden: `defaultMode: "full_auto"` → typed fail-loud.
 *  - concurrent: re-loading same file twice yields independent but
 *    structurally-equal sources (no shared state).
 *  - malformed input: non-string rule entries never produce false positives.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  loadProjectSettings,
  resolveProjectPermissionSource,
  readProjectDefaultMode,
  ProjectSettingsError,
} from "../../../src/harness/permission/project-settings.js";
import {
  createPermissionPolicy,
  checkPermission,
} from "../../../src/harness/permission/policy.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "iknow-proj-settings-"));
}

/** Write a settings.json carrying a `permissions` section; returns its path. */
function writePermissions(dir: string, section: unknown): string {
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ permissions: section }), "utf8");
  return path;
}

/** The `.iknow` layout the cwd-form loader expects (ADR-0084). */
function writeProjectDir(
  base: string,
  section: unknown
): { cwd: string; file: string } {
  const cwd = join(base, ".iknow");
  mkdirSync(cwd, { recursive: true });
  const file = join(cwd, "settings.json");
  writeFileSync(file, JSON.stringify({ permissions: section }), "utf8");
  return { cwd: base, file };
}

/** Legacy toml fixture (the retired source) — only the fail-loud test. */
function writeLegacyToml(dir: string): string {
  const path = join(dir, ".iknow", "permissions.toml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "schema_version = 1\n", "utf8");
  return path;
}

/** Minimal AciToolDef builder for the checkPermission integration test. */
function makeTool(
  name: string,
  category: AciToolDef["aci"]["category"]
): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    }),
  });
}

/** Declarative section in the shape the loader consumes. */
const VALID_SECTION = {
  allow: ["Bash(echo:*)"],
  deny: ["Read(**/*.pem)"],
};

describe("loadProjectSettings — declarative section", () => {
  it("returns undefined when the settings file is absent", () => {
    const dir = scratchDir();
    try {
      assert.equal(loadProjectSettings({ cwd: dir }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when explicit filePath is ENOENT", () => {
    const dir = scratchDir();
    try {
      assert.equal(
        loadProjectSettings({ filePath: join(dir, "no-such-file.json") }),
        undefined
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the JSON has no permissions section", () => {
    const dir = scratchDir();
    try {
      const path = join(dir, "settings.json");
      writeFileSync(
        path,
        JSON.stringify({ verify: { command: "npm test" } }),
        "utf8"
      );
      assert.equal(loadProjectSettings({ filePath: path }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses a declarative section into project-layer rules (deny → allow order)", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, VALID_SECTION);
      const src = loadProjectSettings({ filePath: path, workRoot: "/w" });
      assert.ok(src);
      assert.equal(src.kind, "project");
      assert.equal(src.filePath, path);
      assert.equal(src.rules.length, 2);
      assert.equal(src.rules[0]?.id, "project-deny-1");
      assert.equal(src.rules[0]?.decision, "deny");
      assert.equal(src.rules[1]?.id, "project-allow-1");
      assert.equal(src.rules[1]?.decision, "allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("compiles rules that actually match through the policy layer", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, VALID_SECTION);
      const src = loadProjectSettings({ filePath: path, workRoot: "/w" });
      assert.ok(src);
      const allowRule = src.rules.find((r) => r.decision === "allow");
      assert.ok(allowRule);
      assert.equal(
        allowRule.match({ tool: "bash", input: { command: "echo hi" } }),
        true
      );
      assert.equal(
        allowRule.match({ tool: "bash", input: { command: "rm -rf /" } }),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generated id does not embed the operator's rule string", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, {
        deny: ["Read(/very/long/../path/with/slashes/**)"],
      });
      const src = loadProjectSettings({ filePath: path, workRoot: "/w" });
      assert.ok(src);
      assert.equal(src.rules[0]?.id, "project-deny-1");
      assert.ok(src.rules[0]?.reason.includes("project settings: deny"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("empty allow / deny arrays are legal and produce no rules", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { allow: [], deny: [] });
      const src = loadProjectSettings({ filePath: path, workRoot: "/w" });
      assert.ok(src);
      assert.equal(src.rules.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a section with only defaultMode is a legal source with no rules", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { defaultMode: "plan" });
      const src = loadProjectSettings({ filePath: path, workRoot: "/w" });
      assert.ok(src);
      assert.equal(src.rules.length, 0);
      assert.equal(src.defaultMode, "plan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaultMode 'default' / 'plan' survive; absence leaves the key off", () => {
    const dir = scratchDir();
    try {
      for (const mode of ["default", "plan"] as const) {
        const path = writePermissions(dir, { defaultMode: mode });
        const src = loadProjectSettings({ filePath: path });
        assert.ok(src);
        assert.equal(src.defaultMode, mode);
      }
      const path = writePermissions(dir, { allow: ["Bash"] });
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      assert.equal("defaultMode" in src, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("malformed settings JSON → undefined (mirrors config readSettingsFile tolerance)", () => {
    const dir = scratchDir();
    try {
      const path = join(dir, "settings.json");
      writeFileSync(path, "{ not-json", "utf8");
      assert.equal(loadProjectSettings({ filePath: path }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returned source is frozen", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, VALID_SECTION);
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      assert.equal(Object.isFrozen(src), true);
      assert.equal(Object.isFrozen(src.rules), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-loading the same file yields structurally-equal but independent sources", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, VALID_SECTION);
      const a = loadProjectSettings({ filePath: path });
      const b = loadProjectSettings({ filePath: path });
      assert.ok(a && b);
      assert.equal(a.rules.length, b.rules.length);
      assert.equal(a.rules[0]?.id, b.rules[0]?.id);
      assert.notEqual(a, b);
      assert.notEqual(a.rules, b.rules);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-string / malformed rule entries never produce false positives", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { deny: ["((("] });
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      // The malformed entry is dropped with a warning, so no rule matches.
      assert.equal(src.rules.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -----------------------------------------------------------------------------
 * Schema violations / fail-loud
 * -------------------------------------------------------------------------- */

describe("loadProjectSettings — schema violations", () => {
  it("unknown key inside the section → schema_violation (additionalProperties:false)", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, {
        allow: ["Bash"],
        unexpected: true,
      });
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof ProjectSettingsError && err.kind === "schema_violation"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-string entry in a rule array → schema_violation", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { deny: [42] });
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof ProjectSettingsError &&
          err.kind === "schema_violation" &&
          err.message.includes("/deny/0")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("illegal defaultMode ('yolo') → schema_violation (ajv enum)", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { defaultMode: "yolo" });
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof ProjectSettingsError && err.kind === "schema_violation"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaultMode 'full_auto' → forbidden_default_mode (not schema_violation)", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { defaultMode: "full_auto" });
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) => {
          if (!(err instanceof ProjectSettingsError)) return false;
          return (
            err.kind === "forbidden_default_mode" &&
            err.message.includes("full_auto")
          );
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("section is a non-object → schema_violation", () => {
    for (const bad of ["x", 1, []]) {
      const dir = scratchDir();
      try {
        const path = writePermissions(dir, bad);
        assert.throws(
          () => loadProjectSettings({ filePath: path }),
          (err: unknown) =>
            err instanceof ProjectSettingsError &&
            err.kind === "schema_violation",
          `section=${JSON.stringify(bad)}`
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

/* -----------------------------------------------------------------------------
 * Legacy predicate DSL → typed fail-loud
 * -------------------------------------------------------------------------- */

describe("loadProjectSettings — legacy predicate DSL fail-loud", () => {
  it("schema_version + rule → legacy_predicate_form with a new-form example", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, {
        schema_version: 1,
        rule: [
          {
            id: "allow-bash-echo",
            match_tool: "bash",
            match_input: { command_starts_with: "echo " },
            decision: "allow",
            reason: "explicit allow: bash echo",
          },
        ],
      });
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) => {
          if (!(err instanceof ProjectSettingsError)) return false;
          return (
            err.kind === "legacy_predicate_form" &&
            err.message.includes("allow") &&
            err.message.includes("deny")
          );
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy shape without rules present (schema_version only) still fails loud", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { schema_version: 1 });
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof ProjectSettingsError &&
          err.kind === "legacy_predicate_form"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readProjectDefaultMode shares the legacy-shape fail-loud", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { schema_version: 1, rule: [] });
      assert.throws(
        () => readProjectDefaultMode({ filePath: path }),
        (err: unknown) =>
          err instanceof ProjectSettingsError &&
          err.kind === "legacy_predicate_form"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -----------------------------------------------------------------------------
 * readProjectDefaultMode — light read for the startup-mode seed
 * -------------------------------------------------------------------------- */

describe("readProjectDefaultMode", () => {
  it("returns the declared mode", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { defaultMode: "plan" });
      assert.equal(readProjectDefaultMode({ filePath: path }), "plan");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the file / section / field is absent", () => {
    const dir = scratchDir();
    try {
      assert.equal(
        readProjectDefaultMode({ filePath: join(dir, "nope.json") }),
        undefined
      );
      const path = writePermissions(dir, { allow: ["Bash"] });
      assert.equal(readProjectDefaultMode({ filePath: path }), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'full_auto' fails loud here too", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { defaultMode: "full_auto" });
      assert.throws(
        () => readProjectDefaultMode({ filePath: path }),
        (err: unknown) =>
          err instanceof ProjectSettingsError &&
          err.kind === "forbidden_default_mode"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -----------------------------------------------------------------------------
 * cwd form + legacy toml fail-loud (ADR-0084)
 * -------------------------------------------------------------------------- */

describe("loadProjectSettings — cwd form + legacy toml fail-loud", () => {
  it("cwd form resolves <cwd>/.iknow/settings.json and loads its section", () => {
    const base = scratchDir();
    try {
      const { cwd, file } = writeProjectDir(base, VALID_SECTION);
      const src = loadProjectSettings({ cwd });
      assert.ok(src);
      assert.equal(src.filePath, file);
      assert.equal(src.rules.length, 2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("cwd form with settings.json present but no permissions section → undefined", () => {
    const base = scratchDir();
    try {
      const cwd = join(base, ".iknow");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd, "settings.json"),
        JSON.stringify({ secrets: { enabled: true } }),
        "utf8"
      );
      assert.equal(loadProjectSettings({ cwd: base }), undefined);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("legacy toml + JSON section both present → fail-loud typed error naming both paths", () => {
    const base = scratchDir();
    try {
      const { file } = writeProjectDir(base, VALID_SECTION);
      const toml = writeLegacyToml(base);
      assert.throws(
        () => loadProjectSettings({ cwd: base }),
        (err: unknown) => {
          if (!(err instanceof ProjectSettingsError)) return false;
          return (
            err.kind === "toml_and_json_present" &&
            err.message.includes(toml) &&
            err.message.includes(file)
          );
        }
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("legacy toml alone (no settings permission section) → loads fine (single SSOT)", () => {
    const base = scratchDir();
    try {
      const cwd = join(base, ".iknow");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(
        join(cwd, "settings.json"),
        JSON.stringify({ verify: { command: "npm test" } }),
        "utf8"
      );
      writeLegacyToml(base);
      assert.equal(loadProjectSettings({ cwd: base }), undefined);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/* -----------------------------------------------------------------------------
 * resolveProjectPermissionSource — shared assembly read path
 * -------------------------------------------------------------------------- */

describe("resolveProjectPermissionSource — 装配共用读路径", () => {
  it("reads <projectIdentityRoot>/.iknow/settings.json and returns the source", () => {
    const base = scratchDir();
    try {
      const { file } = writeProjectDir(base, VALID_SECTION);
      const src = resolveProjectPermissionSource({
        projectIdentityRoot: base,
      });
      assert.ok(src);
      assert.equal(src.kind, "project");
      assert.equal(src.filePath, file);
      assert.equal(src.rules.length, 2);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("forwards workRoot / knownToolNames / onWarn to the loader", () => {
    const base = scratchDir();
    try {
      writeProjectDir(base, { deny: ["Future_Tool"] });
      const warnings: string[] = [];
      const src = resolveProjectPermissionSource({
        projectIdentityRoot: base,
        workRoot: "/w",
        knownToolNames: new Set(["bash"]),
        onWarn: (m) => warnings.push(m),
      });
      assert.ok(src);
      assert.equal(src.rules.length, 1);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /Future_Tool/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("absent settings file → undefined (built-in defaults stand)", () => {
    const base = scratchDir();
    try {
      assert.equal(
        resolveProjectPermissionSource({ projectIdentityRoot: base }),
        undefined
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("propagates the typed fail-loud instead of swallowing it", () => {
    const base = scratchDir();
    try {
      writeProjectDir(base, VALID_SECTION);
      writeLegacyToml(base);
      assert.throws(
        () => resolveProjectPermissionSource({ projectIdentityRoot: base }),
        (err: unknown) =>
          err instanceof ProjectSettingsError &&
          err.kind === "toml_and_json_present"
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

/* -----------------------------------------------------------------------------
 * Integration through the policy layer
 * -------------------------------------------------------------------------- */

describe("policy integration", () => {
  it("project deny fires ahead of a project allow on the same command", () => {
    const dir = scratchDir();
    try {
      const project = loadProjectSettings({
        filePath: writePermissions(dir, {
          deny: ["Bash(git status:*)"],
          allow: ["Bash(git status:*)"],
        }),
        workRoot: "/w",
      });
      assert.ok(project);
      const policy = createPermissionPolicy({ project });
      const out = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "git status" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(out.decision, "deny");
      assert.match(out.reason, /project settings: deny/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("project allow lets a matched bash echo through; unmatched still asks", () => {
    const dir = scratchDir();
    try {
      const project = loadProjectSettings({
        filePath: writePermissions(dir, VALID_SECTION),
        workRoot: "/w",
      });
      assert.ok(project);
      const policy = createPermissionPolicy({ project });

      const allowOut = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "echo hello" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(allowOut.decision, "allow");

      const askOut = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "npm install" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(askOut.decision, "ask");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hard-wall still outranks a project allow (dangerous command)", () => {
    const dir = scratchDir();
    try {
      const project = loadProjectSettings({
        filePath: writePermissions(dir, VALID_SECTION),
        workRoot: "/w",
      });
      assert.ok(project);
      const policy = createPermissionPolicy({ project });
      const out = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "rm -rf /" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(out.decision, "deny");
      assert.match(out.reason, /\[hard_wall\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* -----------------------------------------------------------------------------
 * #952 network opt-in — retired by ADR-0097
 * -------------------------------------------------------------------------- */

/**
 * The per-call network opt-in axis is gone: `bash(network:true)` is no longer
 * a `param:value` gate, so the same specifier now compiles through the
 * ordinary command-glob path (`Bash` family specifiers that are not the
 * primary content field). Invariant pinned here: the specifier still loads
 * and still yields exactly one project rule — a project that wrote it keeps a
 * structurally valid source rather than a loader error — while its match
 * semantics are command-text, not the retired `input.network` field.
 *
 * The ask/deny outcome for bash calls is unaffected: bash is `execute` →
 * category default ask (see `policy integration` above).
 */
describe("bash network specifier compiles as a command glob (opt-in axis retired)", () => {
  it("loads one rule and matches command text, not an input field", () => {
    const dir = scratchDir();
    try {
      const path = writePermissions(dir, { deny: ["bash(network:true)"] });
      const src = loadProjectSettings({ filePath: path, workRoot: "/w" });
      assert.ok(src);
      assert.equal(src.rules.length, 1);
      const rule = src.rules[0]!;
      assert.equal(
        rule.match({ tool: "bash", input: { command: "network:true" } }),
        true,
        "command glob matches the literal command text"
      );
      assert.equal(
        rule.match({
          tool: "bash",
          input: { command: "curl", network: true },
        }),
        false,
        "the retired input field no longer drives the rule"
      );
      assert.equal(
        rule.match({ tool: "read_file", input: { command: "network:true" } }),
        false,
        "rule stays bash-scoped"
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without any project rule, bash still asks via the category default", () => {
    const dir = scratchDir();
    try {
      const project = loadProjectSettings({
        filePath: writePermissions(dir, VALID_SECTION),
        workRoot: "/w",
      });
      assert.ok(project);
      const policy = createPermissionPolicy({ project });
      const out = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "curl https://example.com" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(out.decision, "ask");
      assert.match(out.reason, /category default/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
