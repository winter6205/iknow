/**
 * ACI 原型 Layer 0：permission 单元测试。
 * 覆盖：类别默认 / byName 覆盖 / 危险命令 deny / 安全命令 allow /
 * **危险模式 + 敏感路径硬墙**（非白名单但非危险的命令落入 ask，执行期边界由 bwrap 承担）/
 * **always_allow 不能绕过 execute 安全兜底**。
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
    //   - code-allow-todo-write-list (#440 T5): todo_write list 子模式只读,
    //     bypass ask。add/check 仍走默认 write → ask。
    //   - code-ask-bash-network (#503 T10 / ADR-0022):bash network:true
    //     强制 ask（layered rule 先于 mode 解析,full_auto 不豁免 fence
    //     形状变化 = 宿主网络批准轴）。
    // Project / session layers can still escalate to ask or deny; hard-walls
    // remain un-overrideable.
    assert.equal(p.sources.code.rules.length, 3);
    const memSave = p.sources.code.rules.find(
      (r) => r.id === "code-allow-memory-save"
    )!;
    assert.equal(memSave.decision, "allow");
    assert.ok(memSave.match({ tool: "memory_save", input: {} }));
    assert.equal(memSave.match({ tool: "edit_file", input: {} }), false);
    const todoList = p.sources.code.rules.find(
      (r) => r.id === "code-allow-todo-write-list"
    )!;
    assert.equal(todoList.decision, "allow");
    assert.ok(
      todoList.match({ tool: "todo_write", input: { mode: "list" } }),
      "list mode matches"
    );
    const bashNet = p.sources.code.rules.find(
      (r) => r.id === "code-ask-bash-network"
    )!;
    assert.equal(bashNet.decision, "ask");
    assert.ok(
      bashNet.match({ tool: "bash", input: { command: "x", network: true } }),
      "network:true bash matches"
    );
    assert.equal(
      bashNet.match({ tool: "bash", input: { command: "x", network: false } }),
      false,
      "network:false does not match"
    );
    assert.equal(
      bashNet.match({ tool: "bash", input: { command: "x" } }),
      false,
      "absent network does not match"
    );
    assert.equal(
      bashNet.match({
        tool: "bash",
        input: { command: "x", network: "true" },
      }),
      false,
      "string network does not match"
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
    assert.equal(isAllowedCommand("/usr/bin/node -v"), true); // 路径前缀
    assert.equal(isAllowedCommand("C:\\bin\\node -v"), true); // Windows 路径
  });

  it("首 token 不在白名单 → false", () => {
    assert.equal(isAllowedCommand("rm -rf /"), false);
    assert.equal(isAllowedCommand("wget x"), false);
    assert.equal(isAllowedCommand("python -c 'x'"), false);
  });

  it("分段 + 重定向豁免后判定 → 白名单段 allow / 危险段 deny", () => {
    // 重定向已豁免：> / >> / < 是只读工具标准用法，不再是 isAllowed 的拒因。
    assert.equal(isAllowedCommand("echo a > b"), true); // 重定向豁免
    assert.equal(isAllowedCommand("echo a >> b"), true); // 重定向豁免
    assert.equal(isAllowedCommand("echo a | grep x"), false); // 管道（grep 段非白名单）
    assert.equal(isAllowedCommand("echo a | head -1"), true); // 管道（head 段在白名单）
    assert.equal(isAllowedCommand("echo a; echo b"), true); // 分号分段（echo 段白名单）
    assert.equal(isAllowedCommand("echo a; rm -rf /"), false); // 分段后 rm 段危险
    assert.equal(isAllowedCommand("echo a && echo b"), true); // && 分段（echo 段白名单）
    assert.equal(isAllowedCommand("echo $PATH"), true); // 纯 $VAR 读取放行（不再拒）
    assert.equal(isAllowedCommand("echo $HOME"), true); // 纯 $VAR 读取放行
    assert.equal(isAllowedCommand("echo `whoami`"), false); // 反引号
    assert.equal(isAllowedCommand("echo $(whoami)"), false); // 命令替换
    assert.equal(isAllowedCommand("echo (a)"), false); // subshell
    assert.equal(isAllowedCommand("echo a\nrm -rf /"), false); // 换行
    assert.equal(isAllowedCommand("echo a\rb"), false); // 回车
  });

  it("扩写白名单原语 → 写/工具命令 isAllowed", () => {
    assert.equal(isAllowedCommand("mkdir -p ~/.iknow/sub"), true);
    assert.equal(isAllowedCommand("cp a.ts b.ts"), true);
    assert.equal(isAllowedCommand("mv a b"), true);
    assert.equal(isAllowedCommand("touch file"), true);
    assert.equal(isAllowedCommand("tee -a log"), true);
    assert.equal(isAllowedCommand("sed -i s/x/y/g f"), true);
    assert.equal(isAllowedCommand("chmod +x run.sh"), true);
    assert.equal(isAllowedCommand("chown user file"), true); // chown 已离开危险列表
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
    "echo `whoami`",
    "echo $(whoami)",
    "echo ${PATH}",
    "echo $(rm -rf /)",
    // 段内危险子串（SC8 不回退）：换行后的段仍要命中 `rm -rf` 等。
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
    // 用户初始化脚本原 case（误伤修复的核心场景）
    'ls -la ~/.iknow 2>/dev/null; echo "---"; ls -la ~ 2>/dev/null | head -30',
    // 仅白名单段组合 + 重定向 / 管道 / 分号
    "ls -la ~ 2>/dev/null",
    "echo a > b",
    "echo a >> b",
    "git status && echo done",
    "ls; ls; ls",
    "echo a | head -1",
    // 纯 $VAR 读取放行（W4）
    "echo $HOME",
    "echo $PATH",
    "echo $X",
    "ls $PWD/src",
    // chown 已离开危险列表
    "chown user file",
    // 扩写白名单原语（mkdir/cp/mv/...）
    "mkdir -p ~/.iknow/sub",
    "cp a.ts b.ts",
    "mv a b",
    "curl -s http://x",
    // 换行只作分段符（SC1 / ADR-0068）：换行本身不是危险模式。
    // 原 dangerous 表里的 "echo a\nrm" 命中的是换行补丁（`\\n` 返回值），
    // 不是 `rm` 段（裸 `rm` 无参数不匹配任何危险子串）。换行退役后
    // 该样例按新合同归入 safe；段内真正危险子串的回归由上面
    // "echo a\nrm -rf /" 两例钉住。
    "echo a\nrm",
    "mkdir -p ./a\nls",
    "echo a\nls",
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
    // 旧实现 `/\r|\n/.test(command) → return "\\n"`；新合同换行只是分段符，
    // 不产生任何命中。此断言钉住「换行不再作为 pattern 返回」。
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
    // 段内以独立词出现 format 命令（如多行脚本第二行）也拦。
    assert.equal(isDangerousCommand("echo a\nformat c:"), true);
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
    const reason = denyReason("echo $(whoami)");
    assert.ok(reason.includes("dangerous command pattern"));
    assert.ok(reason.includes("command-substitution"), `reason=${reason}`);
  });

  it("换行后段内 rm 命中 → reason 仍带 destructive-rm id", () => {
    const reason = denyReason("echo a\nrm -rf /");
    assert.ok(reason.includes("destructive-rm"), `reason=${reason}`);
  });
});

describe("输入五类表 A — findDangerousPattern / isDangerousCommand (S2)", () => {
  // empty: `""` / 仅空白 → 既有空命令语义不变（不放行执行），且不得误标
  // 为 format 子串命中。
  it("empty: 空串 / 仅空白 → 非危险（既有空命令语义，由 handler 自验兜底）", () => {
    assert.equal(isDangerousCommand(""), false);
    assert.equal(isDangerousCommand("   "), false);
    assert.equal(isDangerousCommand("\t\n "), false);
  });

  // negative: 合法多行白名单段；含 text-transform 的 echo → 不 hard-wall。
  it("negative: 合法多行段 + text-transform echo → 不 hard-wall", () => {
    assert.equal(isDangerousCommand("mkdir -p ./a\nls"), false);
    assert.equal(isDangerousCommand("echo 'text-transform: uppercase'"), false);
  });

  // overflow: 很长命令 / 很多换行但仍为白名单段 → 不因长度/换行 deny；
  // 段内 rm -rf 仍命中。
  it("overflow: 长命令 / 多换行白名单段不 deny；末段危险仍命中", () => {
    const longEcho = `echo ${"x".repeat(8000)}`;
    assert.equal(isDangerousCommand(longEcho), false);
    const manyLines = Array.from({ length: 200 }, () => "echo ok").join("\n");
    assert.equal(isDangerousCommand(manyLines), false);
    assert.equal(isDangerousCommand(`${manyLines}\nrm -rf /`), true);
  });

  // concurrent: 纯函数，无共享状态。
  it("concurrent: N/A: pure（findDangerousPattern 为纯函数，无共享可变状态）", () => {
    // N/A: pure
  });

  // exception: 真危险（rm -rf、$(...)）→ deny 且 reason 带 pattern id。
  it("exception: 真危险 deny 且 reason 带 pattern id（见 SC3 describe）", () => {
    assert.equal(isDangerousCommand("rm -rf /"), true);
    assert.equal(isDangerousCommand("echo $(whoami)"), true);
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
    // 即便策略声明 bash 永远允许，危险命令仍必须被硬墙拦下
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
    // deny 在 normal 层短路，优先级高于类别默认
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
    // 纯 $VAR 读取放行：isAllowedCommand true 且 findDangerousPattern 不命中
    assert.equal(out.decision, "ask");
  });

  it("execute + echo $(whoami)（命令替换）→ deny (hard-wall $()", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo $(whoami)" },
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
