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

/**
 * #952 — network_equals 谓词（资格门禁，不是安全边界）。
 *
 * 不变式（SSOT = policy.ts isBashNetworkInput 的严格 === true 语义）：
 *  - 命中 ⇔ tool === "bash"（由 match_tool gate 承担）且 input.network 严格
 *    === true。非布尔 "true" / 缺省 / false / 非 bash 工具同名字段都不命中。
 *  - 工具名 gate 的 wrinkle：matchPredicate 收不到 tool 名，但 buildRuleMatcher
 *    在谓词匹配前已检查 `ctx.tool === toolName`（project-settings.ts:149），
 *    因此对 match_tool = "bash" 的规则，进入 matchPredicate 的 inputObj
 *    必然来自 bash 调用 —— 此处做 `isBashNetworkInput(inputObj)` shape
 *    check 与 isBashNetworkTrue(tool, input) 等价；非 bash 工具的同名字段
 *    在 buildRuleMatcher 就已短路为 false。
 *  - 定位诚实性：这是「模型有没有资格提这个请求」的资格门禁，不是 SSRF
 *    防线 —— 规则未命中（或批准后）的出站内容仍零过滤；未设规则时默认
 *    行为不变，仍走 code-ask-bash-network 的 ask。
 *  - fail-loud：ajv schema 把 network_equals 钉死为 boolean const true，
 *    TOML 里写成字符串 "true" 在 load 时即抛错并带 JSON path，而不是
 *    落地成一条永不命中的静默死规则。
 */
describe("network_equals predicate (#952)", () => {
  const NETWORK_TOML = `schema_version = 1

[[rule]]
id = "deny-bash-host-network"
match_tool = "bash"
match_input = { network_equals = true }
decision = "deny"
reason = "explicit deny: bash host-network opt-in"
`;

  function loadNetworkRule(dir: string) {
    const path = writeToml(dir, "permissions.toml", NETWORK_TOML);
    const src = loadProjectSettings({ filePath: path });
    assert.ok(src);
    assert.equal(src.rules.length, 1);
    return src.rules[0]!;
  }

  it("network_equals = true matches {command, network: true} on bash", () => {
    const dir = scratchDir();
    try {
      const rule = loadNetworkRule(dir);
      assert.equal(
        rule.match({
          tool: "bash",
          input: { command: "curl https://example.com", network: true },
        }),
        true
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not match network: false / missing / string 'true' (strict === true)", () => {
    const dir = scratchDir();
    try {
      const rule = loadNetworkRule(dir);
      assert.equal(
        rule.match({
          tool: "bash",
          input: { command: "curl https://example.com", network: false },
        }),
        false
      );
      assert.equal(
        rule.match({ tool: "bash", input: { command: "curl" } }),
        false
      );
      // isBashNetworkInput SSOT 语义：字符串 "true" 不命中（不是布尔 true）。
      assert.equal(
        rule.match({
          tool: "bash",
          input: { command: "curl", network: "true" },
        }),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-bash tool with a same-named network:true field does not match (tool gate)", () => {
    const dir = scratchDir();
    try {
      const rule = loadNetworkRule(dir);
      // match_tool = "bash" 的规则对 web_fetch 的同名字段不生效：
      // buildRuleMatcher 先检查 ctx.tool === "bash"，非 bash 直接 false。
      assert.equal(
        rule.match({
          tool: "web_fetch",
          input: { url: "https://example.com", network: true },
        }),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AND-joins with command predicates (network:true + command shape both required)", () => {
    const dir = scratchDir();
    try {
      const path = writeToml(
        dir,
        "permissions.toml",
        `schema_version = 1

[[rule]]
id = "deny-curl-network"
match_tool = "bash"
match_input = { command_starts_with = "curl ", network_equals = true }
decision = "deny"
reason = "deny curl with host network"
`
      );
      const src = loadProjectSettings({ filePath: path });
      assert.ok(src);
      const rule = src.rules[0]!;
      assert.equal(
        rule.match({
          tool: "bash",
          input: { command: "curl https://example.com", network: true },
        }),
        true
      );
      // network 缺省 → 整个 AND 不成立
      assert.equal(
        rule.match({
          tool: "bash",
          input: { command: "curl https://example.com" },
        }),
        false
      );
      // command 不匹配 → 整个 AND 不成立
      assert.equal(
        rule.match({
          tool: "bash",
          input: { command: "wget https://example.com", network: true },
        }),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('network_equals = "true" (TOML string) fails at schema load with JSON path (fail-loud, not silent dead rule)', () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule]]
id = "string-true"
match_tool = "bash"
match_input = { network_equals = "true" }
decision = "deny"
reason = "should never load"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          return (
            err.message.includes("schema violation") &&
            err.message.includes("network_equals")
          );
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unknown predicate still fails loud with the failing JSON path", () => {
    const dir = scratchDir();
    try {
      const body = `schema_version = 1

[[rule]]
id = "typo-predicate"
match_tool = "bash"
match_input = { command_regex = "^curl" }
decision = "deny"
reason = "typo"
`;
      const path = writeToml(dir, "permissions.toml", body);
      assert.throws(
        () => loadProjectSettings({ filePath: path }),
        (err: unknown) => {
          if (!(err instanceof Error)) return false;
          // ajv additionalProperties 错误的 JSON path 定位到 match_input，
          // 消息不含属性名（与既有 unknown-predicate 测试口径一致）
          return (
            err.message.includes("schema violation") &&
            err.message.includes("/rule/0/match_input")
          );
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("integration: project-layer deny fires BEFORE code-layer ask in checkPermission layer order", () => {
    // checkPermission 分层顺序 session > project > code，first match wins。
    // 没有 #952 时 bash network:true 落到 code 层的 code-ask-bash-network
    // ask；项目层 deny 规则命中时必须在 code 层之前截住。
    const dir = scratchDir();
    try {
      const project = loadProjectSettings({
        filePath: writeToml(dir, "permissions.toml", NETWORK_TOML),
      });
      assert.ok(project);
      const policy = createPermissionPolicy({ project });
      const out = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "curl https://example.com", network: true },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(out.decision, "deny");
      assert.match(out.reason, /explicit deny: bash host-network opt-in/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("default behavior unchanged: without a network rule, bash network:true still asks via code-ask-bash-network", () => {
    // 资格门禁是 opt-in 的：未设 network 规则时绝不偷偷改 deny，
    // 仍走 code 层 code-ask-bash-network 的 ask（默认行为零变化）。
    const dir = scratchDir();
    try {
      const project = loadProjectSettings({
        filePath: writeToml(dir, "permissions.toml", VALID_TOML),
      });
      assert.ok(project);
      const policy = createPermissionPolicy({ project });
      const out = checkPermission({
        def: makeTool("bash", "execute"),
        input: { command: "curl https://example.com", network: true },
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      assert.equal(out.decision, "ask");
      assert.match(out.reason, /code-ask-bash-network|network/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
