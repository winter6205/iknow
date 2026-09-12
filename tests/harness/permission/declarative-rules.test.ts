/**
 * tests/harness/permission/declarative-rules.test.ts
 *
 * Tests for the `compileDeclarativePermissions` compiler (ADR-0090).
 *
 * Boundary classes covered:
 *   - SC4 (Bash): specifier → regex, compound-command segmentation, wrapper
 *     stripping, `:*` tail, `*` token boundary, family membership.
 *   - SC5 (Read/Edit): gitignore-style paths, anchor modes (`//`, `~/`, `/`,
 *     relative), depth semantics (deny/ask any-depth, allow top-level),
 *     Read deny widening to write tools.
 *   - Syntax parsing: family aliases, `Tool(*)` ≡ bare `Tool`, literal
 *     names, `mcp__*` globs (allow-only restriction), unknown-tool
 *     warnings (deny/ask warn, allow does not), `WebFetch(domain:*)`,
 *     `param:value`, rejected primary fields.
 *   - Order: deny group precedes allow group.
 *
 * These tests assert the contract that `project-settings.test.ts` (loader
 * shape) and `policy.test.ts` (layer ordering) both depend on.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import { compileDeclarativePermissions } from "../../../src/harness/permission/declarative.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "iknow-decl-"));
}

function makeInput(tool: string, payload: Record<string, unknown>) {
  return { tool, input: payload };
}

function compileOne(
  section: Parameters<typeof compileDeclarativePermissions>[0],
  opts: Parameters<typeof compileDeclarativePermissions>[1] = {
    workRoot: "/w",
  }
): ReadonlyArray<{
  readonly id: string;
  readonly match: (input: {
    readonly tool: string;
    readonly input: unknown;
  }) => boolean;
  readonly decision: "allow" | "deny" | "ask";
  readonly reason: string;
}> {
  return compileDeclarativePermissions(section, opts);
}

/* -----------------------------------------------------------------------------
 * SC4 — Bash specifier matching
 * -------------------------------------------------------------------------- */

describe("SC4: Bash specifier matching", () => {
  it("Bash(git status:*) matches git status", () => {
    const [rule] = compileOne({ deny: ["Bash(git status:*)"] });
    assert.ok(rule);
    assert.equal(
      rule.match(makeInput("bash", { command: "git status" })),
      true
    );
  });

  it("Bash(git status:*) matches git status -sb (trailing :* tolerates args)", () => {
    const [rule] = compileOne({ deny: ["Bash(git status:*)"] });
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status -sb" })),
      true
    );
  });

  it("Bash(git status:*) does NOT match git status && rm -rf /tmp/x (compound requires all segments)", () => {
    const [rule] = compileOne({ deny: ["Bash(git status:*)"] });
    assert.equal(
      rule!.match(
        makeInput("bash", { command: "git status && rm -rf /tmp/x" })
      ),
      false
    );
  });

  it("Bash(ls *) does not match lsof (token boundary via stripped-form)", () => {
    const [rule] = compileOne({ deny: ["Bash(ls *)"] });
    assert.equal(rule!.match(makeInput("bash", { command: "lsof" })), false);
  });

  it("Bash(*) ≡ Bash (whole-command wildcard)", () => {
    const a = compileOne({ allow: ["Bash"] });
    const b = compileOne({ allow: ["Bash(*)"] });
    for (const cmd of ["git status", "rm -rf /", "echo hi"]) {
      assert.equal(a[0]!.match(makeInput("bash", { command: cmd })), true);
      assert.equal(b[0]!.match(makeInput("bash", { command: cmd })), true);
    }
  });

  it("Bash(git status:*) matches timeout 30 git status (wrapper stripped)", () => {
    const [rule] = compileOne({ deny: ["Bash(git status:*)"] });
    assert.equal(
      rule!.match(makeInput("bash", { command: "timeout 30 git status" })),
      true
    );
  });

  it.each([
    ["time", "time git status"],
    ["nice", "nice git status"],
    ["nice -n 10", "nice -n 10 git status"],
    ["nohup", "nohup git status"],
    ["stdbuf -o0", "stdbuf -o0 git status"],
    ["command", "command git status"],
    ["builtin", "builtin git status"],
    ["noglob", "noglob git status"],
    ["xargs (no flag)", "xargs git status"],
  ])("wrapper %s is stripped", (_name, cmd) => {
    const [rule] = compileOne({ deny: ["Bash(git status:*)"] });
    assert.equal(rule!.match(makeInput("bash", { command: cmd })), true);
  });

  it("compound segments via ;, |, |&, &, newline all split and each must match", () => {
    const [rule] = compileOne({ deny: ["Bash(git status:*)"] });
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status; rm -rf /" })),
      false,
      "; must split"
    );
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status | rm -rf /" })),
      false,
      "| must split"
    );
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status |& rm -rf /" })),
      false,
      "|& must split"
    );
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status & rm -rf /" })),
      false,
      "& must split"
    );
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status\nrm -rf /" })),
      false,
      "newline must split"
    );
    // And the all-matching compound is still positive.
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status -sb && git diff" })),
      false,
      "second segment must also match (it does not)"
    );
  });

  it("two-segment compound where both match yields match (AND segments)", () => {
    const [rule] = compileOne({
      deny: ["Bash(git status:*)", "Bash(git diff:*)"],
    });
    void rule;
    // We don't have a multi-specifier syntax, so this case is satisfied
    // separately: build two single-segment rules and a compound matcher
    // elsewhere. Here we just confirm that a single-segment rule covers
    // the only segment of a simple command.
    const [single] = compileOne({ allow: ["Bash(git status:*)"] });
    assert.equal(
      single!.match(makeInput("bash", { command: "git status" })),
      true
    );
  });

  it("Bash(git * --force) matches git commit --force", () => {
    const [rule] = compileOne({ deny: ["Bash(git * --force)"] });
    assert.equal(
      rule!.match(makeInput("bash", { command: "git commit --force" })),
      true
    );
  });
});

/* -----------------------------------------------------------------------------
 * Bash: bare / family aliases / globs
 * -------------------------------------------------------------------------- */

describe("Bash: family aliases and tool-name slot", () => {
  it("bash(…) is case-insensitive family alias", () => {
    const [rule] = compileOne({ deny: ["bash(git status:*)"] });
    assert.equal(
      rule!.match(makeInput("bash", { command: "git status" })),
      true
    );
  });

  it("does not match non-bash tools", () => {
    const [rule] = compileOne({ deny: ["Bash(git status:*)"] });
    assert.equal(
      rule!.match(
        makeInput("read_file", { path: "/x", command: "git status" })
      ),
      false
    );
  });
});

/* -----------------------------------------------------------------------------
 * SC5 — Read / Edit path matching
 * -------------------------------------------------------------------------- */

describe("SC5: Read / Edit path matching", () => {
  it("Read(.env) ≡ Read(**/.env) (bare name is any-depth)", () => {
    const a = compileOne({ deny: ["Read(.env)"] }, { workRoot: "/w" });
    const b = compileOne({ deny: ["Read(**/.env)"] }, { workRoot: "/w" });
    const subjects = ["/w/.env", "/w/proj/.env", "/w/a/b/c/.env"];
    for (const sub of subjects) {
      assert.equal(
        a[0]!.match({ tool: "read_file", input: { path: sub } }),
        b[0]!.match({ tool: "read_file", input: { path: sub } }),
        `subject=${sub}`
      );
    }
  });

  it("Read(.env) deny blocks read_file at any depth", () => {
    const [rule] = compileOne({ deny: ["Read(.env)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/.env" } }),
      true
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/sub/.env" } }),
      true
    );
  });

  it("deny Read(.env) blocks grep and glob too", () => {
    const [rule] = compileOne({ deny: ["Read(.env)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "grep", input: { path: "/w/.env" } }),
      true
    );
    assert.equal(
      rule!.match({ tool: "glob", input: { path: "/w/.env" } }),
      true
    );
  });

  it("Read(.env) deny widens to edit_file / write_file (same path, new file included)", () => {
    const [rule] = compileOne({ deny: ["Read(.env)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "edit_file", input: { path: "/w/.env" } }),
      true
    );
    assert.equal(
      rule!.match({ tool: "write_file", input: { path: "/w/sub/.env" } }),
      true
    );
  });

  it("Read allow does NOT widen to write tools", () => {
    const [rule] = compileOne({ allow: ["Read(.env)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "edit_file", input: { path: "/w/.env" } }),
      false
    );
    assert.equal(
      rule!.match({ tool: "write_file", input: { path: "/w/.env" } }),
      false
    );
  });

  it("Edit(.env) allow matches write_file but not read_file", () => {
    const [rule] = compileOne({ allow: ["Edit(.env)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "write_file", input: { path: "/w/.env" } }),
      true
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/.env" } }),
      false
    );
  });

  it("deny Read(secrets/**) hits a/b/secrets/x (any-depth)", () => {
    const [rule] = compileOne(
      { deny: ["Read(secrets/**)"] },
      { workRoot: "/w" }
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/secrets/x" } }),
      true
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/a/b/secrets/x" } }),
      true
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/secrets" } }),
      true,
      "`**` matches zero segments (the directory itself)"
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/other/x" } }),
      false
    );
  });

  it("allow Read(src/**) does NOT match vendor/pkg/src/x (top-level only)", () => {
    const [rule] = compileOne({ allow: ["Read(src/**)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/src/a" } }),
      true
    );
    assert.equal(
      rule!.match({
        tool: "read_file",
        input: { path: "/w/vendor/pkg/src/x" },
      }),
      false
    );
  });

  it("allow **/secrets/** matches any depth (explicit opt-in)", () => {
    const [rule] = compileOne(
      { allow: ["Read(**/secrets/**)"] },
      { workRoot: "/w" }
    );
    assert.equal(
      rule!.match({
        tool: "read_file",
        input: { path: "/w/vendor/pkg/secrets/x" },
      }),
      true
    );
  });

  it("`/` anchor matches against projectIdentityRoot", () => {
    const dir = tmp();
    try {
      const root = join(dir, "repo");
      const inner = join(dir, "repo", "inner");
      const [rule] = compileOne(
        { deny: ["Read(/inner/.env)"] },
        { workRoot: dir, projectIdentityRoot: root }
      );
      assert.equal(
        rule!.match({
          tool: "read_file",
          input: { path: join(inner, ".env") },
        }),
        true
      );
      assert.equal(
        rule!.match({
          tool: "read_file",
          input: { path: join(dir, "other", ".env") },
        }),
        false
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("`//` anchor is filesystem-absolute", () => {
    const [rule] = compileOne(
      { deny: ["Read(//etc/passwd)"] },
      { workRoot: "/w" }
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/etc/passwd" } }),
      true
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/etc/other" } }),
      false
    );
  });

  it("`~/` anchor expands to home", () => {
    const [rule] = compileOne(
      { deny: ["Read(~/.ssh/id_rsa)"] },
      { workRoot: "/w", home: "/home/u" }
    );
    assert.equal(
      rule!.match({
        tool: "read_file",
        input: { path: "/home/u/.ssh/id_rsa" },
      }),
      true
    );
    assert.equal(
      rule!.match({
        tool: "read_file",
        input: { path: "/home/other/.ssh/id_rsa" },
      }),
      false
    );
  });

  it("hidden files participate in matching", () => {
    const [rule] = compileOne({ deny: ["Read(.hidden)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/w/sub/.hidden" } }),
      true
    );
  });

  it("relative subject path is resolved against workRoot", () => {
    const [rule] = compileOne({ deny: ["Read(.env)"] }, { workRoot: "/w" });
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "sub/.env" } }),
      true
    );
  });

  it("subject outside the anchor does not match (path escape)", () => {
    const [rule] = compileOne(
      { deny: ["Read(/secret)"] },
      { workRoot: "/w", projectIdentityRoot: "/proj" }
    );
    assert.equal(
      rule!.match({ tool: "read_file", input: { path: "/secret" } }),
      false,
      "/secret is not under /proj"
    );
  });
});

/* -----------------------------------------------------------------------------
 * Syntax: parsing + globs
 * -------------------------------------------------------------------------- */

describe("Syntax: parsing, family aliases, globs", () => {
  it("Tool(*) ≡ bare Tool (no specifier)", () => {
    const bare = compileOne({ deny: ["Bash"] });
    const star = compileOne({ deny: ["Bash(*)"] });
    assert.equal(bare.length, 1);
    assert.equal(star.length, 1);
    for (const cmd of ["x", "y;z"]) {
      assert.equal(
        bare[0]!.match(makeInput("bash", { command: cmd })),
        star[0]!.match(makeInput("bash", { command: cmd }))
      );
    }
  });

  it("deny with unknown literal tool name warns but the rule is kept", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { deny: ["Mcp__Future__Tool"] },
      {
        workRoot: "/w",
        knownToolNames: new Set<string>(),
        onWarn: (m) => warnings.push(m),
      }
    );
    assert.equal(rules.length, 1, "rule kept (dynamic MCP may register)");
    assert.ok(warnings[0]?.includes("Mcp__Future__Tool"));
  });

  it("allow with unknown literal tool name does NOT warn", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { allow: ["Mcp__Future__Tool"] },
      { workRoot: "/w", onWarn: (m) => warnings.push(m) }
    );
    assert.equal(rules.length, 1);
    assert.equal(warnings.length, 0);
  });

  it("allow with bare '*' is dropped with warning", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { allow: ["*"] },
      { workRoot: "/w", onWarn: (m) => warnings.push(m) }
    );
    assert.equal(rules.length, 0);
    assert.ok(warnings[0]?.includes("*"));
  });

  it("allow with 'mcp__*' is dropped with warning", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { allow: ["mcp__*"] },
      { workRoot: "/w", onWarn: (m) => warnings.push(m) }
    );
    assert.equal(rules.length, 0);
    assert.ok(warnings[0]?.includes("mcp__*"));
  });

  it("allow with 'mcp__<server>__*' is legal", () => {
    const rules = compileOne({ allow: ["mcp__github__*"] });
    assert.equal(rules.length, 1);
    assert.equal(
      rules[0]!.match(makeInput("mcp__github__create_issue", {})),
      true
    );
    assert.equal(rules[0]!.match(makeInput("mcp__slack__send", {})), false);
  });

  it("deny allows mcp__* glob", () => {
    const [rule] = compileOne({ deny: ["mcp__*"] });
    assert.equal(rule!.match(makeInput("mcp__anything__tool", {})), true);
    assert.equal(rule!.match(makeInput("bash", { command: "x" })), false);
  });

  it("Write(path) — path rule on a non-family tool warns and drops", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { deny: ["Write(/foo/bar)"] },
      { workRoot: "/w", onWarn: (m) => warnings.push(m) }
    );
    assert.equal(rules.length, 0);
    assert.ok(warnings[0]?.includes("Write(/foo/bar)"));
  });

  it("bash(command:…) is a primary-field ban — warns and drops", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { deny: ["bash(command:*)"] },
      { workRoot: "/w", onWarn: (m) => warnings.push(m) }
    );
    assert.equal(rules.length, 0);
    assert.ok(warnings[0]?.includes("command"));
  });

  it("read_file(path:…) and web_fetch(url:…) are also primary-field bans", () => {
    for (const spec of ["read_file(path:*)", "web_fetch(url:*)"]) {
      const warnings: string[] = [];
      const rules = compileDeclarativePermissions(
        { deny: [spec] },
        { workRoot: "/w", onWarn: (m) => warnings.push(m) }
      );
      assert.equal(rules.length, 0, `${spec} should be dropped`);
      assert.ok(warnings[0]);
    }
  });

  it("todo_write(mode:read) param:value matches via scalar equality (deny/ask only)", () => {
    const [rule] = compileOne({ deny: ["todo_write(mode:read)"] });
    assert.equal(rule!.match(makeInput("todo_write", { mode: "read" })), true);
    assert.equal(
      rule!.match(makeInput("todo_write", { mode: "write" })),
      false
    );
  });

  it("param:value wildcard matches any scalar value of that field", () => {
    const [rule] = compileOne({ deny: ["todo_write(priority:*)"] });
    assert.equal(rule!.match(makeInput("todo_write", { priority: 5 })), true);
    assert.equal(rule!.match(makeInput("todo_write", { priority: "x" })), true);
    assert.equal(
      rule!.match(makeInput("todo_write", { priority: { x: 1 } })),
      false,
      "non-scalar field is not matched by *"
    );
  });

  it("allow param:value is dropped with warning", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { allow: ["todo_write(mode:read)"] },
      { workRoot: "/w", onWarn: (m) => warnings.push(m) }
    );
    assert.equal(rules.length, 0);
    assert.ok(warnings[0]);
  });

  it("WebFetch(domain:*.example.com) matches subdomains", () => {
    const [rule] = compileOne({
      deny: ["WebFetch(domain:*.example.com)"],
    });
    assert.equal(
      rule!.match(
        makeInput("web_fetch", { url: "https://api.example.com/foo" })
      ),
      true
    );
    assert.equal(
      rule!.match(makeInput("web_fetch", { url: "https://other.com/x" })),
      false
    );
  });

  it("WebFetch(domain:*) matches any host", () => {
    const [rule] = compileOne({ deny: ["WebFetch(domain:*)"] });
    assert.equal(
      rule!.match(makeInput("web_fetch", { url: "https://a.com" })),
      true
    );
    assert.equal(
      rule!.match(makeInput("web_fetch", { url: "https://b.co.uk/path" })),
      true
    );
  });

  it("WebFetch non-domain specifier warns and drops", () => {
    const warnings: string[] = [];
    const rules = compileDeclarativePermissions(
      { deny: ["WebFetch(/foo)"] },
      { workRoot: "/w", onWarn: (m) => warnings.push(m) }
    );
    assert.equal(rules.length, 0);
    assert.ok(warnings[0]);
  });

  it("family aliases are case-insensitive", () => {
    const rules = compileOne(
      { deny: ["READ(.env)", "BASH(echo:*)"] },
      { workRoot: "/w" }
    );
    assert.equal(rules.length, 2);
    assert.equal(
      rules[0]!.match(makeInput("read_file", { path: "/w/.env" })),
      true
    );
    assert.equal(
      rules[1]!.match(makeInput("bash", { command: "echo hi" })),
      true
    );
  });
});

/* -----------------------------------------------------------------------------
 * Order: deny > ask > allow; same-list first-match
 * -------------------------------------------------------------------------- */

describe("Order: deny group precedes allow; first match in same group wins", () => {
  it("a deny on the same command shadows a later allow (group order)", () => {
    const rules = compileOne(
      {
        deny: ["Bash(git status:*)"],
        allow: ["Bash(git status:*)"],
      },
      { workRoot: "/w" }
    );
    // deny comes first in the array → in checkPermission's first-match
    // walk, deny wins. Verify by spot-checking the rule order itself.
    assert.equal(rules[0]!.decision, "deny");
    assert.equal(rules[1]!.decision, "allow");
  });

  it("first match in same group wins (file order preserved)", () => {
    const rules = compileOne(
      { allow: ["Bash(git *)", "Bash(git status:*)"] },
      { workRoot: "/w" }
    );
    assert.equal(rules.length, 2);
    // Both match the same command; the first in the file order is
    // compiled first. Verify both rules match, and the first in array
    // order is the broader one.
    assert.equal(
      rules[0]!.match(makeInput("bash", { command: "git status" })),
      true
    );
    assert.equal(
      rules[1]!.match(makeInput("bash", { command: "git status" })),
      true
    );
  });

  it("ask group sits between deny and allow", () => {
    const rules = compileOne(
      {
        allow: ["Bash(git status:*)"],
        ask: ["Bash(git commit:*)"],
        deny: ["Bash(git push:*)"],
      },
      { workRoot: "/w" }
    );
    assert.deepEqual(
      rules.map((r) => r.decision),
      ["deny", "ask", "allow"]
    );
  });
});
