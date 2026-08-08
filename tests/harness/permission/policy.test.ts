/**
 * New permission module — policy.test.ts.
 *
 * SC1 — sensitive paths + dangerous commands deny even with permissive session grants.
 * SC2 — category defaults (read-only → allow, write → ask, execute → ask, collaborate → ask).
 * SC3 — override order: session > project > code; hard-wall un-overrideable.
 * SC4 — ask-inlet / hook_blocked prefix (placeholder; full askUser check in executor test).
 * SC5 — deny zero side effect (verified in permission-executor.test.ts spy).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createPermissionPolicy,
  checkPermission,
} from "../../../src/harness/permission/policy.js";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import type {
  AciToolDef,
  AciCategory,
} from "../../../src/harness/aci/types.js";

interface MakeToolOpts {
  readonly name: string;
  readonly category: AciCategory;
}

function makeTool(opts: MakeToolOpts): AciToolDef {
  const { name, category } = opts;
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior:
        category === "write" ? ("block" as const) : ("cancel" as const),
      timeoutTier: "default" as const,
    }),
  });
}

/* -----------------------------------------------------------------------------
 * SC1 — Hard-walls un-overrideable (sensitive paths + dangerous commands)
 * -------------------------------------------------------------------------- */

describe("SC1: hard-walls un-overrideable", () => {
  const session = createSessionGrants();
  // Permissive session: would allow any tool, but hard-walls still fire first.
  session.add({
    id: "session-allow-bash",
    match: () => true,
    decision: "allow",
    reason: "session allows everything",
  });
  session.add({
    id: "session-allow-read_file",
    match: () => true,
    decision: "allow",
    reason: "session allows everything",
  });

  const policy = createPermissionPolicy({ session });

  it("dangerous command (rm -rf) still denies despite session allow", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("[hard_wall]"));
  });

  it("sensitive path (.ssh) still denies read_file even with session allow", () => {
    const out = checkPermission({
      def: makeTool({ name: "read_file", category: "read-only" }),
      input: { path: "/home/user/.ssh/id_rsa" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("[hard_wall]"));
    assert.ok(out.reason.includes("sensitive"));
  });

  it("'echo ${ANTHROPIC_AUTH_TOKEN}' indirect-expansion bypass attempt → hard-wall deny", () => {
    // W4: 纯 $VAR 读取放行，但 ${...} 间接引用仍是危险模式 → hard-wall deny
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo ${ANTHROPIC_AUTH_TOKEN}" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("[hard_wall]"));
  });

  it("execute with non-allowlist command (printenv) falls through to ask", () => {
    // 非白名单但非危险的命令不再 hard-wall：落入 execute 类别默认 ask，
    // 由用户决定是否放行（bwrap 沙箱是执行期边界）。
    // 注意：SC1 的 policy 带 allow-all session 规则会直接放行，这里用默认 policy。
    const plain = createPermissionPolicy();
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "printenv" },
      sources: plain.sources,
      hardWalls: plain.hardWalls,
      defaultByCategory: plain.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("ask user"));
  });
});

/* -----------------------------------------------------------------------------
 * SC2 — Category defaults
 * -------------------------------------------------------------------------- */

describe("SC2: category defaults", () => {
  const policy = createPermissionPolicy();

  it("read-only → allow", () => {
    const out = checkPermission({
      def: makeTool({ name: "grep", category: "read-only" }),
      input: { pattern: "*.ts" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "allow");
  });

  it("write → ask", () => {
    const out = checkPermission({
      def: makeTool({ name: "edit_file", category: "write" }),
      input: { path: "x.ts" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
  });

  it("execute (safe command) → ask (hard-wall fires first when applicable)", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
  });

  it("collaborate → ask", () => {
    const out = checkPermission({
      def: makeTool({ name: "notify", category: "collaborate" }),
      input: {},
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
  });
});

/* -----------------------------------------------------------------------------
 * SC2.5 — code-layer allow for memory_save (self-write to agent memory lib)
 *
 * Why: `memory_save` writes into `~/.iknow/memory/<id>.md` — the agent's own
 * memory library, not the user's workspace. Treating it like `edit_file` /
 * `write_file` (write → ask) caused the agent to be fail-closed at every
 * non-interactive inlet (ask / serve, or chat TTY with no prompt available),
 * producing `[user_denied] user declined tool call: memory_save` even when
 * the user never saw a prompt. Hard-walls remain un-overrideable, and the
 * project / session layers can still escalate to ask or deny.
 * -------------------------------------------------------------------------- */

describe("SC2.5: code-layer allow for memory_save (agent self-write)", () => {
  const policy = createPermissionPolicy();

  it("memory_save → allow (default policy, no project/session overrides)", () => {
    const out = checkPermission({
      def: makeTool({ name: "memory_save", category: "write" }),
      input: { title: "t", body: "b" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("memory_save"));
  });

  it("memory_recall is unaffected (still read-only → allow)", () => {
    const out = checkPermission({
      def: makeTool({ name: "memory_recall", category: "read-only" }),
      input: { query: "x" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "allow");
  });

  it("project layer can still escalate memory_save to ask", () => {
    const project = {
      kind: "project" as const,
      filePath: "/tmp/perm.toml",
      rules: [
        {
          id: "project-ask-memory-save",
          match: ({ tool }: { tool: string }) => tool === "memory_save",
          decision: "ask" as const,
          reason: "project says ask for memory_save",
        },
      ],
    };
    const out = checkPermission({
      def: makeTool({ name: "memory_save", category: "write" }),
      input: { title: "t", body: "b" },
      sources: { code: policy.sources.code, project },
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
  });

  it("session layer can still deny memory_save (upper overrides lower)", () => {
    const session = createSessionGrants();
    session.add({
      id: "session-deny-memory-save",
      match: ({ tool }) => tool === "memory_save",
      decision: "deny",
      reason: "session says deny",
    });
    const out = checkPermission({
      def: makeTool({ name: "memory_save", category: "write" }),
      input: { title: "t", body: "b" },
      sources: { code: policy.sources.code, session },
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
  });
});

/* -----------------------------------------------------------------------------
 * SC3 — Override order + hard-wall un-overrideable
 * -------------------------------------------------------------------------- */

describe("SC3: override order", () => {
  it("session rule wins over project rule over code rule (upper overrides lower)", () => {
    const session = createSessionGrants();
    session.add({
      id: "session-allow-bash",
      match: ({ tool }) => tool === "bash",
      decision: "allow",
      reason: "session says allow",
    });
    const project = {
      kind: "project" as const,
      filePath: "/tmp/perm.toml",
      rules: [
        {
          id: "project-deny-bash",
          match: ({ tool }: { tool: string }) => tool === "bash",
          decision: "deny" as const,
          reason: "project says deny",
        },
      ],
    };
    const code = {
      kind: "code" as const,
      rules: [
        {
          id: "code-allow-bash",
          match: ({ tool }: { tool: string }) => tool === "bash",
          decision: "allow" as const,
          reason: "code says allow",
        },
      ],
    };
    const sourcesOverride = { session, project, code };
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "ls -la" },
      sources: sourcesOverride,
      hardWalls: [],
      defaultByCategory: {
        "read-only": "allow",
        write: "ask",
        execute: "ask",
        collaborate: "ask",
      },
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("session"));
  });

  it("hard-wall fires BEFORE any normal rule (upper overrides lower cannot relax hard-wall)", () => {
    const session = createSessionGrants();
    // Session says "allow bash" for everything, including dangerous commands.
    session.add({
      id: "session-allow-all-bash",
      match: ({ tool }) => tool === "bash",
      decision: "allow",
      reason: "session allow",
    });
    const policy = createPermissionPolicy({ session });

    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    // Even with session=allow, the hard-wall denies — Q5 acceptance test.
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("[hard_wall]"));
  });
});

/* -----------------------------------------------------------------------------
 * SC4 — hard-wall reason prefix is distinct
 * -------------------------------------------------------------------------- */

describe("SC4: reason prefixes are distinct", () => {
  const policy = createPermissionPolicy();
  it("hard-wall reason starts with [hard_wall]", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.ok(out.reason.startsWith("[hard_wall] "));
    assert.notEqual(out.reason.startsWith("[permission_denied]"), true);
    assert.notEqual(out.reason.startsWith("[hook_blocked]"), true);
    assert.notEqual(out.reason.startsWith("[user_denied]"), true);
  });
});

/* -----------------------------------------------------------------------------
 * SC5 — deny path produces structured outcome, executor applies prefix
 *
 * Executor level SC5 (zero-side-effect) is exercised in permission-executor.test.ts.
 * -------------------------------------------------------------------------- */

describe("SC5: deny returns structured PermissionOutcome", () => {
  const policy = createPermissionPolicy();
  it("checkPermission returns frozen shape; reason is non-empty", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(typeof out.decision, "string");
    assert.equal(typeof out.reason, "string");
    assert.ok(out.reason.length > 0);
  });
});

/* -----------------------------------------------------------------------------
 * ask_inlet_missing check (full failure surface lives in permission-executor.test.ts)
 * -------------------------------------------------------------------------- */

describe("policy.ts is sync (askUser is the executor's job)", () => {
  it("checkPermission returns synchronously, never throws on benign inputs", () => {
    const policy = createPermissionPolicy();
    const d = makeTool({ name: "x", category: "read-only" });
    const r = checkPermission({
      def: d,
      input: { anything: 42 },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.ok(r);
    assert.equal(typeof r.decision, "string");
  });
});
