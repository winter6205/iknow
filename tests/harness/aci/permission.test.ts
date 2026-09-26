/**
 * ACI prototype Layer 0: permission unit tests.
 * Covers: category defaults / byName overrides / dangerous-command deny /
 * safe-command allow / **dangerous pattern + sensitive-path hard walls**
 * (commands neither on the allowlist nor dangerous fall to ask; runtime
 * boundaries are carried by bwrap) / **always_allow cannot bypass the
 * execute safety backstop**.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createPermissionPolicy,
  isAllowedCommand,
  isDangerousCommand,
  commandContainsSensitivePath,
  checkPermission,
} from "../../../src/harness/aci/permission.ts";
import type {
  AciToolDef,
  AciCategory,
} from "../../../src/harness/aci/types.ts";

interface MakeToolOpts {
  readonly name: string;
  readonly category: AciCategory;
}

function makeTool(opts: MakeToolOpts): AciToolDef {
  const { name, category } = opts;
  const meta = {
    category,
    isConcurrencySafe: category === "read-only",
    interruptBehavior:
      category === "write" ? ("block" as const) : ("cancel" as const),
    timeoutTier: "default" as const,
  };
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: meta,
  });
}

describe("createPermissionPolicy", () => {
  it("default: PermissionPolicy with hard-walls + defaultByCategory + sources", () => {
    // v0 graduated: createPermissionPolicy returns a PermissionPolicy (the
    // three-layer shape). defaults: read-only → allow, write/execute/collaborate → ask.
    const p = createPermissionPolicy();
    assert.equal(p.sources.code.kind, "code");
    // The code layer ships with built-in allow rules:
    //   - code-allow-memory-save: agent self-write to its own memory library
    //     (unblocks non-interactive inlets — ask/serve/chat TTY without prompt)
    //   - code-allow-todo-write-read (ADR-0085): the todo_write read
    //     sub-mode is read-only and bypasses ask. add/update still take the
    //     default write → ask.
    // Project / session layers can still escalate to ask or deny; hard-walls
    // remain un-overrideable.
    assert.equal(p.sources.code.rules.length, 2);
    const memSave = p.sources.code.rules.find(
      (r) => r.id === "code-allow-memory-save"
    )!;
    assert.equal(memSave.decision, "allow");
    assert.ok(memSave.match({ tool: "memory_save", input: {} }));
    assert.equal(memSave.match({ tool: "edit_file", input: {} }), false);
    const todoList = p.sources.code.rules.find(
      (r) => r.id === "code-allow-todo-write-read"
    )!;
    assert.equal(todoList.decision, "allow");
    assert.ok(
      todoList.match({ tool: "todo_write", input: { mode: "read" } }),
      "read mode matches"
    );
    assert.equal(
      todoList.match({ tool: "todo_write", input: { mode: "add", item: "x" } }),
      false,
      "add mode does not match"
    );
    assert.equal(
      todoList.match({ tool: "todo_write", input: {} }),
      false,
      "missing mode does not match"
    );
    assert.equal(Object.isFrozen(p), true);
    assert.equal(p.defaultByCategory["read-only"], "allow");
    assert.equal(p.defaultByCategory.write, "ask");
    assert.equal(p.defaultByCategory.execute, "ask");
    assert.equal(p.defaultByCategory.collaborate, "ask");
    // hard-walls present
    assert.ok(p.hardWalls.length >= 2);
    assert.equal(p.hardWalls[0]!.tier, "hard-wall");
    assert.equal(p.hardWalls[0]!.decision, "deny");
  });

  it("proto byName overrides apply (allow / deny / ask)", () => {
    const p = createPermissionPolicy({
      defaultRule: "allow",
      byName: { bash: "deny" },
    });
    // prototype wrapper injects into the session layer
    assert.equal(p.sources.session?.rules().length ?? 0, 1);
    assert.equal(p.sources.session?.rules()[0]!.decision, "deny");
    // defaultRule overrides all categories to "allow"
    assert.equal(p.defaultByCategory.write, "allow");
    assert.equal(p.defaultByCategory.execute, "allow");
  });
});

describe("isAllowedCommand (allowlist-first 主门)", () => {
  it("首 token 在白名单 + 无元字符 → true", () => {
    assert.equal(isAllowedCommand("echo hello"), true);
    assert.equal(isAllowedCommand("node -v"), true);
    assert.equal(isAllowedCommand("git status"), true);
    assert.equal(isAllowedCommand("/usr/bin/node -v"), true); // path prefix
    assert.equal(isAllowedCommand("C:\\bin\\node -v"), true); // Windows path
  });

  it("首 token 不在白名单 → false", () => {
    assert.equal(isAllowedCommand("rm -rf /"), false);
    assert.equal(isAllowedCommand("wget x"), false);
    assert.equal(isAllowedCommand("python -c 'x'"), false);
  });

  it("分段 + 重定向豁免后判定 → 白名单段 allow / 危险段 deny", () => {
    // Redirects are now exempt: > / >> / < are standard read-only tool usage
    // and no longer a reject reason in isAllowed.
    assert.equal(isAllowedCommand("echo a > b"), true); // redirect exempt
    assert.equal(isAllowedCommand("echo a >> b"), true); // redirect exempt
    assert.equal(isAllowedCommand("echo a | grep x"), false); // pipe (grep segment not on allowlist)
    assert.equal(isAllowedCommand("echo a | head -1"), true); // pipe (head segment on allowlist)
    assert.equal(isAllowedCommand("echo a; echo b"), true); // semicolon split (echo segments allowlisted)
    assert.equal(isAllowedCommand("echo a; rm -rf /"), false); // rm segment dangerous after split
    assert.equal(isAllowedCommand("echo a && echo b"), true); // && split (echo segments allowlisted)
    assert.equal(isAllowedCommand("echo $PATH"), true); // bare $VAR reads allowed (no longer rejected)
    assert.equal(isAllowedCommand("echo $HOME"), true); // bare $VAR reads allowed
    assert.equal(isAllowedCommand("echo `whoami`"), false); // backticks
    assert.equal(isAllowedCommand("echo $(whoami)"), false); // command substitution
    assert.equal(isAllowedCommand("echo (a)"), false); // subshell
    assert.equal(isAllowedCommand("echo a\nrm -rf /"), false); // newline
    assert.equal(isAllowedCommand("echo a\rb"), false); // carriage return
  });

  it("扩写白名单原语 → 写/工具命令 isAllowed", () => {
    assert.equal(isAllowedCommand("mkdir -p ~/.iknow/sub"), true);
    assert.equal(isAllowedCommand("cp a.ts b.ts"), true);
    assert.equal(isAllowedCommand("mv a b"), true);
    assert.equal(isAllowedCommand("touch file"), true);
    assert.equal(isAllowedCommand("tee -a log"), true);
    assert.equal(isAllowedCommand("sed -i s/x/y/g f"), true);
    assert.equal(isAllowedCommand("chmod +x run.sh"), true);
    assert.equal(isAllowedCommand("chown user file"), true); // chown has left the dangerous list
    assert.equal(isAllowedCommand("diff a b"), true);
    assert.equal(isAllowedCommand("file x"), true);
    assert.equal(isAllowedCommand("base64 -d x"), true);
    assert.equal(isAllowedCommand("jq . file"), true);
    assert.equal(isAllowedCommand("curl -s http://x"), true);
    assert.equal(isAllowedCommand("env | head"), true);
    assert.equal(isAllowedCommand("export FOO=1"), true);
    assert.equal(isAllowedCommand("true"), true);
    assert.equal(isAllowedCommand("false"), true);
    assert.equal(isAllowedCommand("printf 'x'"), true);
  });
});

describe("isDangerousCommand (黑名单双保险层)", () => {
  const dangerous = [
    "rm -rf /",
    "sudo rm -rf /home",
    "rm -r /tmp",
    "rm -f /tmp/x",
    "rm --recursive /tmp",
    "rmdir /tmp",
    "Remove-Item C:\\x", // Windows
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
    "shutdown -h now",
    "reboot",
    "format C:",
    "del /f important.txt",
    "rd /s /q C:\\",
    "find / -delete",
    "chmod -R 777 /",
    "echo a && rm -rf /",
    "echo a; rm -rf /",
    "echo $(rm -rf /)",
    // In-segment dangerous substrings must not regress: a segment after a
    // newline still has to hit `rm -rf` etc.
    "echo a\nrm -rf /",
    "mkdir -p ./a\nrm -fr /tmp/x",
  ];
  for (const cmd of dangerous) {
    it(`detects dangerous: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isDangerousCommand(cmd), true);
    });
  }

  const safe = [
    "ls -la",
    "echo hello",
    "cat README.md",
    "node --version",
    "git status",
    // User init-script original case (the core scenario of the false-positive fix)
    'ls -la ~/.iknow 2>/dev/null; echo "---"; ls -la ~ 2>/dev/null | head -30',
    // Allowlist-only segment combinations + redirect / pipe / semicolon
    "ls -la ~ 2>/dev/null",
    "echo a > b",
    "echo a >> b",
    "git status && echo done",
    "ls; ls; ls",
    "echo a | head -1",
    // Bare $VAR reads allowed
    "echo $HOME",
    "echo $PATH",
    "echo $X",
    "ls $PWD/src",
    // chown has left the dangerous list
    "chown user file",
    // Extended allowlist primitives (mkdir/cp/mv/...)
    "mkdir -p ~/.iknow/sub",
    "cp a.ts b.ts",
    "mv a b",
    "curl -s http://x",
    // Newline acts only as a segment separator (ADR-0068): the newline
    // itself is not a dangerous pattern. The old "echo a\nrm" entry in the
    // dangerous table hit the newline patch (`\\n` as return value), not the
    // `rm` segment (bare `rm` without args matches no dangerous substring).
    // With the newline patch retired, that sample belongs in safe under the
    // new contract; genuine in-segment dangerous substrings are still pinned
    // by the "echo a\nrm -rf /" cases above.
    "echo a\nrm",
    "mkdir -p ./a\nls",
    "echo a\nls",
    // ADR-0125: a substitution glyph is no longer a deny on its own — each of
    // these recurses through a benign inner / plain name read.
    "echo `whoami`",
    "echo $(whoami)",
    "echo ${PATH}",
  ];
  for (const cmd of safe) {
    it(`allows safe: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isDangerousCommand(cmd), false);
    });
  }
});

describe("hard-wall 按段扫描 — 换行只作分段符 (SC1 / ADR-0068)", () => {
  it("多行白名单段命令不因换行本身 deny（\\n / \\r\\n / \\r 三种分隔）", () => {
    assert.equal(isDangerousCommand("mkdir -p ./a\nls"), false);
    assert.equal(isDangerousCommand("echo a\nls"), false);
    assert.equal(isDangerousCommand("mkdir -p ./a\r\nls"), false);
    assert.equal(isDangerousCommand("mkdir -p ./a\rls"), false);
    assert.equal(isDangerousCommand("echo a\r\nls\r\ncat x"), false);
  });

  it("含换行但某段带危险子串 → 仍 deny（SC8 回归不回退）", () => {
    assert.equal(isDangerousCommand("echo a\nrm -rf /"), true);
    assert.equal(isDangerousCommand("mkdir -p ./a\nrm -fr /tmp/x"), true);
    assert.equal(isDangerousCommand("echo a\r\nrm -rf /tmp"), true);
    assert.equal(isDangerousCommand("echo a\nrm --recursive /tmp"), true);
    assert.equal(isDangerousCommand("echo a\nshutdown -h now"), true);
  });

  it("末段危险（长命令 / 多换行 overflow 形态）→ 仍 deny", () => {
    const manyLines = Array.from({ length: 50 }, () => "echo ok").join("\n");
    assert.equal(isDangerousCommand(manyLines), false);
    assert.equal(isDangerousCommand(`${manyLines}\nrm -rf /`), true);
  });

  it("换行不返回字面 `\\n` 命中值（旧换行补丁已退役）", () => {
    // Old implementation: `/\r|\n/.test(command) → return "\\n"`. Under the
    // new contract a newline is only a segment separator and produces no hit.
    // This assertion pins "newline is no longer returned as a pattern match".
    assert.equal(isDangerousCommand("echo a\nls"), false);
    assert.equal(isDangerousCommand("\n"), false);
    assert.equal(isDangerousCommand("\r\n"), false);
  });
});

describe("hard-wall format 子串退役 (SC2 / ADR-0068: format 不得子串匹配)", () => {
  it("含 format 子串的合法内容不 hard-wall deny", () => {
    assert.equal(isDangerousCommand("echo 'text-transform: uppercase'"), false);
    assert.equal(isDangerousCommand("echo 'git format-patch -1'"), false);
    assert.equal(isDangerousCommand("printf '%s format %s' a b"), false);
    assert.equal(isDangerousCommand("cat format-notes.md"), false);
    assert.equal(isDangerousCommand("echo transform"), false);
  });

  it("整段就是一个 format 命令形态 → 仍 deny（词法 token 匹配，非子串）", () => {
    assert.equal(isDangerousCommand("format C:"), true);
    assert.equal(isDangerousCommand("format c:"), true);
    assert.equal(isDangerousCommand("format"), true);
    // `format` as a standalone word inside a segment (e.g. line 2 of a
    // multi-line script) is also blocked.
    assert.equal(isDangerousCommand("echo a\nformat c:"), true);
  });

  it("反斜杠逃逸 fo\\rmat → 词法闸仍命中（backslash strip 与子串扫描同源）", () => {
    // Review-High regression: the lexical gate must consume the same
    // normalized form as the substring scan — bash strips backslashes, so
    // `fo\rmat` becomes `format`; an escape must not slip through due to
    // normalize asymmetry between gates (`format` has left the substring
    // table, making the lexical gate the only interception surface).
    assert.equal(isDangerousCommand("fo\\rmat C:"), true);
    assert.equal(isDangerousCommand("fo\\rmat"), true);
    assert.equal(isDangerousCommand("echo a\nfo\\rmat c:"), true);
  });
});

describe("hard-wall deny reason 带 pattern id (SC3)", () => {
  const policy = createPermissionPolicy();

  function denyReason(command: string): string {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command },
      policy,
    });
    assert.equal(out.decision, "deny");
    return out.reason;
  }

  it("rm 类命中 → reason 含 destructive-rm id 与命中子串", () => {
    const reason = denyReason("rm -rf /");
    assert.ok(reason.includes("dangerous command pattern"));
    assert.ok(reason.includes("destructive-rm"), `reason=${reason}`);
    assert.ok(reason.includes("rm -rf"), `reason=${reason}`);
  });

  it("命令替换命中 → reason 含 command-substitution id", () => {
    const reason = denyReason("echo $(rm -rf /)");
    assert.ok(reason.includes("dangerous command pattern"));
    assert.ok(reason.includes("command-substitution"), `reason=${reason}`);
    assert.ok(reason.includes("destructive-rm"), `reason=${reason}`);
    // The glyph-only deny is retired: a benign inner no longer reaches here.
    assert.equal(isDangerousCommand("echo $(whoami)"), false);
  });

  it("换行后段内 rm 命中 → reason 仍带 destructive-rm id", () => {
    const reason = denyReason("echo a\nrm -rf /");
    assert.ok(reason.includes("destructive-rm"), `reason=${reason}`);
  });
});

describe("输入五类表 A — findDangerousPattern / isDangerousCommand (S2)", () => {
  // empty: `""` / whitespace-only → existing empty-command semantics unchanged
  // (execution is not allowed through), and must not be mislabeled as a
  // format-substring hit.
  it("empty: 空串 / 仅空白 → 非危险（既有空命令语义，由 handler 自验兜底）", () => {
    assert.equal(isDangerousCommand(""), false);
    assert.equal(isDangerousCommand("   "), false);
    assert.equal(isDangerousCommand("\t\n "), false);
  });

  // negative: legal multi-line allowlisted segments; echo containing
  // text-transform → no hard-wall.
  it("negative: 合法多行段 + text-transform echo → 不 hard-wall", () => {
    assert.equal(isDangerousCommand("mkdir -p ./a\nls"), false);
    assert.equal(isDangerousCommand("echo 'text-transform: uppercase'"), false);
  });

  // overflow: very long command / many newlines but still allowlisted
  // segments → no deny for length/newlines; in-segment rm -rf still hits.
  it("overflow: 长命令 / 多换行白名单段不 deny；末段危险仍命中", () => {
    const longEcho = `echo ${"x".repeat(8000)}`;
    assert.equal(isDangerousCommand(longEcho), false);
    const manyLines = Array.from({ length: 200 }, () => "echo ok").join("\n");
    assert.equal(isDangerousCommand(manyLines), false);
    assert.equal(isDangerousCommand(`${manyLines}\nrm -rf /`), true);
  });

  // concurrent: pure function, no shared state.
  it("concurrent: N/A: pure（findDangerousPattern 为纯函数，无共享可变状态）", () => {
    // N/A: pure
  });

  // exception: genuinely dangerous (rm -rf, a substitution with a dangerous
  // inner) → deny and reason carries the pattern id.
  it("exception: 真危险 deny 且 reason 带 pattern id（见 SC3 describe）", () => {
    assert.equal(isDangerousCommand("rm -rf /"), true);
    assert.equal(isDangerousCommand("echo $(whoami)"), false);
  });
});

describe("axis2 skeptic findings — regression guards", () => {
  it("bare metachars are still dangerous (no command body)", () => {
    assert.equal(isDangerousCommand(";"), true);
    assert.equal(isDangerousCommand(">"), true);
    assert.equal(isDangerousCommand("|"), true);
    assert.equal(isDangerousCommand("&"), true);
    assert.equal(isDangerousCommand("&&"), true);
    assert.equal(isDangerousCommand("||"), true);
  });

  it("backslash-escaped dangerous pattern still detected", () => {
    assert.equal(isDangerousCommand("r\\m -rf /tmp/x"), true);
    assert.equal(isDangerousCommand("r\\m\\ -rf /tmp/x"), true);
    assert.equal(isDangerousCommand("echo r\\m -rf /tmp/x"), true);
  });

  it("redirect to sensitive path is still denied (command-level scan)", () => {
    // commandContainsSensitivePath mirrors matchSensitivePath for command strings
    assert.equal(commandContainsSensitivePath("echo a > ~/.ssh/x"), true);
    assert.equal(commandContainsSensitivePath("echo a > /etc/passwd"), true);
    assert.equal(commandContainsSensitivePath("echo a; cat /etc/passwd"), true);
    assert.equal(commandContainsSensitivePath("echo a >> /etc/shadow"), true);
    assert.equal(commandContainsSensitivePath("echo a > /tmp/ok.txt"), false);
  });

  it("here-string is read-only stdin feed — allowed", () => {
    assert.equal(isAllowedCommand("echo <<< hello"), true);
    assert.equal(isDangerousCommand("echo <<< hello"), false);
  });

  it("bash tool rejects sensitive-path command at handler", async () => {
    const { createBashTool } =
      await import("../../../src/harness/aci/tools/bash.js");
    const { ToolExecutionError } =
      await import("../../../src/harness/errors.js");
    const cwd = "/tmp";
    const tool = createBashTool(cwd);
    await assert.rejects(
      tool.handler({ command: "echo a >> /etc/shadow" }),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("sensitive path")
    );
  });
});

describe("checkPermission — 类别默认", () => {
  const policy = createPermissionPolicy();

  it("read-only → allow", () => {
    const out = checkPermission({
      def: makeTool({ name: "grep", category: "read-only" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("read-only"));
  });

  it("write → ask (v0: no automatic ask-allow in graduated policy)", () => {
    const out = checkPermission({
      def: makeTool({ name: "edit_file", category: "write" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("ask user"));
  });

  it("collaborate → ask", () => {
    const out = checkPermission({
      def: makeTool({ name: "notify", category: "collaborate" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("ask user"));
  });

  it("execute + 安全 allowlist 命令 → ask (category default; hard-wall fires first when applicable)", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "ls -la" },
      policy,
    });
    // v0 execute category default is ask (per Q4); prototype gave allow here.
    assert.equal(out.decision, "ask");
  });

  it("execute + 危险命令 → deny (hard-wall fires before category default)", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("dangerous command pattern"));
  });
});

describe("checkPermission — byName 覆盖", () => {
  it("byName always_allow **不能**绕过 execute 硬墙（Security CRITICAL）", () => {
    // Even when the policy declares bash always-allowed, dangerous commands
    // must still be stopped by the hard wall
    const policy = createPermissionPolicy({
      byName: { bash: "allow" },
    });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      policy,
    });
    assert.equal(
      out.decision,
      "deny",
      "session/project/code allow must not bypass hard-wall"
    );
    assert.ok(out.reason.includes("dangerous command pattern"));
  });

  it("byName allow 工具级覆盖（execute 不传命令）→ allow", () => {
    const policy = createPermissionPolicy({
      byName: { bash: "allow" },
    });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    // bash here is execute + safe; byName=allow resolves before category default
    assert.equal(out.decision, "allow");
  });

  it("byName deny 覆盖 read-only 默认 allow", () => {
    const policy = createPermissionPolicy({
      byName: { grep: "deny" },
    });
    const out = checkPermission({
      def: makeTool({ name: "grep", category: "read-only" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "deny");
  });

  it("byName deny 覆盖 execute 即便命令安全", () => {
    // deny short-circuits at the normal layer, above category defaults
    const policy = createPermissionPolicy({
      byName: { bash: "deny" },
    });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "deny");
  });

  it("byName ask 透传（落回类别默认 ask）", () => {
    const policy = createPermissionPolicy({
      byName: { edit_file: "ask" },
    });
    const out = checkPermission({
      def: makeTool({ name: "edit_file", category: "write" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "ask");
  });
});

describe("checkPermission — execute 安全兜底细节", () => {
  const policy = createPermissionPolicy();

  it("execute + 非字符串 command → 落到 category default（bash.ts 自验字符串）", () => {
    // v0 graduate: hard-walls only fire on strings. The non-string validation
    // moved into bash.ts handler — policy layer leaves it as ask. (bash.ts
    // throws ToolExecutionError before reaching inner.)
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: undefined },
      policy,
    });
    assert.equal(out.decision, "ask");
  });

  it("execute + 数字 command → ask（bash.ts 自验）", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: 42 },
      policy,
    });
    assert.equal(out.decision, "ask");
  });

  it("execute + 对象 command → ask（bash.ts 自验）", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: { evil: true } },
      policy,
    });
    assert.equal(out.decision, "ask");
  });

  it("execute + echo 放行：hard-wall 没命中 → ask（允许 askUser 决定）", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "ask");
  });

  it("execute + echo a > b（重定向已豁免）→ ask（hard-wall 不命中，category default）", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo a > b" },
      policy,
    });
    assert.equal(out.decision, "ask");
  });

  it("execute + echo $HOME（纯 $VAR 读取）→ ask（hard-wall 不命中，category default）", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo $HOME" },
      policy,
    });
    // Bare $VAR reads allowed: isAllowedCommand true and findDangerousPattern does not hit
    assert.equal(out.decision, "ask");
  });

  it("execute + echo $(rm -rf /)（命令替换内危险内层）→ deny (inner propagates)", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo $(rm -rf /)" },
      policy,
    });
    assert.equal(out.decision, "deny");
  });
});

describe("checkPermission — hard-wall is unconditional (no override possible)", () => {
  it("execute + rm -rf / + default policy → deny（hard-wall 拦截,无法被策略关闭）", () => {
    // The dangerous-command hard-wall fires unconditionally under the
    // default policy. The test pins that there is no override knob.
    const policy = createPermissionPolicy();
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("dangerous command pattern"));
  });

  it("execute + 已知安全命令 + default policy → ask（v0 default）", () => {
    // v0 default for execute is "ask"; this case asserts default behavior is
    // unchanged (no flag, no override).
    const policy = createPermissionPolicy();
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "ask");
  });
});
