/**
 * tests/harness/permission/project-settings.test.ts
 *
 * Loader tests for `.iknow/permissions.toml` (T6 / #122 Q2b).
 *
 * Boundary classes covered:
 *  - normal: missing file → undefined; valid TOML → policy source
 *  - negative: schema violation (unknown predicate, missing required field,
 *    bad decision) → throws with descriptive message
 *  - overflow: empty rule array (minItems=1 violation)
 *  - exception: malformed TOML → throws
 *  - concurrent: re-loading same file twice yields independent but
 *    structurally-equal sources (no shared state)
 *  - malformed: predicate string type mismatch silently doesn't match (no
 *    false positives — predicates are narrow and total)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { loadProjectSettings } from "../../../src/harness/permission/project-settings.js";
import {
  createPermissionPolicy,
  checkPermission,
} from "../../../src/harness/permission/policy.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "iknow-proj-settings-"));
}

function writeToml(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
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

const VALID_TOML = `schema_version = 1

[[rule]]
id = "allow-bash-echo"
match_tool = "bash"
match_input = { command_starts_with = "echo " }
decision = "allow"
reason = "explicit allow: bash echo"

[[rule]]
id = "deny-read-ssh"
match_tool = "read_file"
match_input = { path_contains = ".ssh/" }
decision = "deny"
reason = "explicit deny: read_file under .ssh"
`;

describe("loadProjectSettings", () => {
  it("returns undefined when the settings file is absent", () => {
    const dir = scratchDir();
    try {
      const result = loadProjectSettings({ cwd: dir });
      assert.equal(result, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when explicit filePath is ENOENT", () => {
    const dir = scratchDir();
    try {
      const result = loadProjectSettings({
        filePath: join(dir, "no-such-file.toml"),
      });
      assert.equal(result, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses a TOML with two rules and exposes a ProjectSettingsPolicySource", () => {
    const dir = scratchDir();
    try {
      const path = writeToml(dir, "permissions.toml", VALID_TOML);
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      assert.equal(src.kind, "project");
      assert.equal(src.filePath, path);
      assert.equal(src.rules.length, 2);
      assert.equal(src.rules[0]?.id, "allow-bash-echo");
      assert.equal(src.rules[1]?.id, "deny-read-ssh");
      assert.equal(src.rules[0]?.decision, "allow");
      assert.equal(src.rules[1]?.decision, "deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when an unknown predicate is used", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule]]
id = "bad-predicate"
match_tool = "bash"
match_input = { command_regex = "^echo" }
decision = "allow"
reason = "explicit allow"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          return (
            err.message.includes("schema violation") &&
            err.message.includes("match_input")
          );
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when required fields are missing (id)", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule]]
match_tool = "bash"
match_input = { command_starts_with = "echo " }
decision = "allow"
reason = "explicit allow"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          return (
            err.message.includes("schema violation") &&
            err.message.includes("id")
          );
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when required fields are missing (match_tool)", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule]]
id = "r1"
match_input = { command_starts_with = "echo " }
decision = "allow"
reason = "explicit allow"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("match_tool")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when decision is not in {allow, deny, ask}", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule]]
id = "r1"
match_tool = "bash"
match_input = { command_starts_with = "echo " }
decision = "pass_through"
reason = "explicit allow"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("schema violation")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when schema_version is missing or wrong value", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 2

[[rule]]
id = "r1"
match_tool = "bash"
match_input = { command_starts_with = "echo " }
decision = "allow"
reason = "explicit allow"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("schema violation")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when rule array is empty (minItems=1)", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1
rule = []
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("schema violation")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when TOML is malformed", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule
id = "r1"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) =>
          err instanceof Error && err.message.includes("TOML parse failed")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rule match: command_starts_with evaluates correctly (positive + negative)", () => {
    const dir = scratchDir();
    try {
      const path = writeToml(dir, "permissions.toml", VALID_TOML);
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      const echoRule = src.rules[0]!;
      assert.equal(
        echoRule.match({ tool: "bash", input: { command: "echo hi" } }),
        true
      );
      assert.equal(
        echoRule.match({ tool: "bash", input: { command: "ls" } }),
        false
      );
      // tool name mismatch also negative
      assert.equal(
        echoRule.match({ tool: "read_file", input: { command: "echo hi" } }),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rule match: path_contains checks .ssh/ anywhere in the path", () => {
    const dir = scratchDir();
    try {
      const path = writeToml(dir, "permissions.toml", VALID_TOML);
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      const denyRule = src.rules[1]!;
      assert.equal(
        denyRule.match({
          tool: "read_file",
          input: { path: "/home/user/.ssh/id_rsa" },
        }),
        true
      );
      assert.equal(
        denyRule.match({
          tool: "read_file",
          input: { path: "/home/user/.config/something" },
        }),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returned source is frozen (Object.isFrozen on rules array)", () => {
    const dir = scratchDir();
    try {
      const path = writeToml(dir, "permissions.toml", VALID_TOML);
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
      const path = writeToml(dir, "permissions.toml", VALID_TOML);
      const a = loadProjectSettings({ filePath: path });
      const b = loadProjectSettings({ filePath: path });
      assert.ok(a && b);
      assert.equal(a.rules.length, b.rules.length);
      assert.equal(a.rules[0]?.id, b.rules[0]?.id);
      // Different objects: closing-over new state each call.
      assert.notEqual(a, b);
      assert.notEqual(a.rules, b.rules);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("predicates with non-string command don't match (no false positives)", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule]]
id = "needs-string-command"
match_tool = "bash"
match_input = { command_starts_with = "echo " }
decision = "allow"
reason = "needs string command"
`;
      const path = writeToml(dir, "permissions.toml", body);
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      const rule = src.rules[0]!;
      // input without `command` field → no match
      assert.equal(rule.match({ tool: "bash", input: {} }), false);
      // input where command is not a string → no match
      assert.equal(rule.match({ tool: "bash", input: { command: 42 } }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("integration: loaded project source flows through createPermissionPolicy + checkPermission", () => {
    // SC3 覆盖语义：project 层 allow 规则放行匹配的 bash echo，
    // 未匹配的 bash 命令仍走 category default（execute → ask）。
    const dir = scratchDir();
    try {
      const path = writeToml(dir, "permissions.toml", VALID_TOML);
      const project = loadProjectSettings({ filePath: path });
      assert.ok(project);
      const policy = createPermissionPolicy({ project });

      // allow rule 命中 → allow（绕过 execute category 的默认 ask）
      const allowOut = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "echo hello" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(allowOut.decision, "allow");
      assert.match(allowOut.reason, /explicit allow: bash echo/);

      // 未命中 project 规则的 bash → category default ask
      const askOut = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "npm install" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(askOut.decision, "ask");

      // 硬墙优先于 project 层：危险命令仍 deny（project 无法放宽硬墙）
      const denyOut = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "rm -rf /" },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(denyOut.decision, "deny");
      assert.match(denyOut.reason, /\[hard_wall\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
