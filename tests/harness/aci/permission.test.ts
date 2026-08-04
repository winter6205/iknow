/**
 * ACI 原型 Layer 0：permission 单元测试。
 * 覆盖：类别默认 / byName 覆盖 / 危险命令 deny / 安全命令 allow /
 * **allowlist-first 模型**（execute 必须 isAllowedCommand 放行才走黑名单双保险）/
 * **always_allow 不能绕过 execute 安全兜底**。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  createPermissionPolicy,
  isAllowedCommand,
  isDangerousCommand,
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
    assert.deepEqual(p.sources.code.rules, []);
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
      denyDangerousExecute: false,
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
    assert.equal(isAllowedCommand("curl http://x"), false);
    assert.equal(isAllowedCommand("wget x"), false);
    assert.equal(isAllowedCommand("python -c 'x'"), false);
  });

  it("含 shell 元字符 → false（即便首 token 在白名单）", () => {
    assert.equal(isAllowedCommand("echo a > b"), false); // 重定向
    assert.equal(isAllowedCommand("echo a | grep x"), false); // 管道
    assert.equal(isAllowedCommand("echo a; rm"), false); // 链
    assert.equal(isAllowedCommand("echo a && b"), false); // &&
    assert.equal(isAllowedCommand("echo $PATH"), false); // 变量展开
    assert.equal(isAllowedCommand("echo `whoami`"), false); // 反引号
    assert.equal(isAllowedCommand("echo $(whoami)"), false); // 命令替换
    assert.equal(isAllowedCommand("echo (a)"), false); // subshell
    assert.equal(isAllowedCommand("echo a\nrm -rf /"), false); // 换行
    assert.equal(isAllowedCommand("echo a\rb"), false); // 回车
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
    "chown root /tmp",
    "echo a && rm -rf /",
    "echo a; rm -rf /",
    "echo `whoami`",
    "echo $(whoami)",
    "echo a > b",
    "echo a >> b",
    "echo a\nrm",
    "echo $X",
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
  ];
  for (const cmd of safe) {
    it(`allows safe: ${JSON.stringify(cmd)}`, () => {
      assert.equal(isDangerousCommand(cmd), false);
    });
  }
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

  it("execute + echo a > b（元字符） → deny (hard-wall)", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo a > b" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("dangerous command pattern"));
  });

  it("execute + echo $PATH（元字符） → deny (hard-wall)", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo $PATH" },
      policy,
    });
    assert.equal(out.decision, "deny");
  });
});

describe("checkPermission — denyDangerousExecute=false is now a no-op (hard-wall is unconditional)", () => {
  it("execute + rm -rf / + denyDangerousExecute=false → 仍 deny（hard-wall 拦截）", () => {
    const policy = createPermissionPolicy({ denyDangerousExecute: false });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("dangerous command pattern"));
  });

  it("execute + 已知安全命令 + denyDangerousExecute=false → ask（v0 default; test seam）", () => {
    // v0 default for execute is "ask", so this test ensures the override
    // doesn't accidentally turn safety off. The behavior is "ask" rather than
    // prototype "allow" because the graduated category defaults differ.
    const policy = createPermissionPolicy({ denyDangerousExecute: false });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "ask");
  });
});
