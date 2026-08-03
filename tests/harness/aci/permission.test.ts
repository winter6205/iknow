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
    isReadOnly: category === "read-only",
    isDestructive: category === "execute",
    isConcurrencySafe: category === "read-only",
    interruptBehavior:
      category === "write" ? ("block" as const) : ("cancel" as const),
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
  it("defaults: defaultRule=ask, denyDangerousExecute=true", () => {
    const p = createPermissionPolicy();
    assert.equal(p.defaultRule, "ask");
    assert.equal(p.denyDangerousExecute, true);
    assert.equal(p.byName, undefined);
  });

  it("overrides are applied and frozen", () => {
    const p = createPermissionPolicy({
      defaultRule: "always_allow",
      byName: { bash: "always_deny" },
      denyDangerousExecute: false,
    });
    assert.equal(p.defaultRule, "always_allow");
    assert.equal(p.byName?.["bash"], "always_deny");
    assert.equal(p.denyDangerousExecute, false);
    assert.ok(Object.isFrozen(p));
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

  it("write → allow，reason 注明 ask→auto-allow in prototype", () => {
    const out = checkPermission({
      def: makeTool({ name: "edit_file", category: "write" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("ask→auto-allow in prototype"));
  });

  it("collaborate → allow，reason 注明 ask→auto-allow in prototype", () => {
    const out = checkPermission({
      def: makeTool({ name: "notify", category: "collaborate" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("ask→auto-allow in prototype"));
  });

  it("execute + 安全 allowlist 命令 → allow", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "ls -la" },
      policy,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("execute: safe command allowed"));
  });

  it("execute + 危险命令 → deny，reason 指出 not in allowlist", () => {
    // allowlist-first：rm 不在白名单，reason 应包含 "command not in allowlist"
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("command not in allowlist"));
  });
});

describe("checkPermission — byName 覆盖", () => {
  it("byName always_allow **不能**绕过 execute 安全兜底（Security CRITICAL）", () => {
    // 即便策略声明 bash 永远允许，危险命令仍必须被 allowlist 拦下
    const policy = createPermissionPolicy({
      byName: { bash: "always_allow" },
    });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      policy,
    });
    assert.equal(
      out.decision,
      "deny",
      "always_allow must not bypass allowlist"
    );
    assert.ok(out.reason.includes("command not in allowlist"));
  });

  it("byName always_allow 可豁免 ask 门（非 execute 类别）", () => {
    const policy = createPermissionPolicy({
      byName: { bash: "always_allow" },
    });
    // 不传 execute 命令 → 不走安全兜底 → always_allow 短路放行
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("byName always_allow"));
  });

  it("byName always_deny 覆盖 read-only 默认 allow", () => {
    const policy = createPermissionPolicy({
      byName: { grep: "always_deny" },
    });
    const out = checkPermission({
      def: makeTool({ name: "grep", category: "read-only" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("always_deny"));
  });

  it("byName always_deny 覆盖 execute 即便命令安全", () => {
    // always_deny 在层 1 短路，优先级高于安全兜底
    const policy = createPermissionPolicy({
      byName: { bash: "always_deny" },
    });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("always_deny"));
  });

  it("byName ask 不短路，落回类别默认", () => {
    const policy = createPermissionPolicy({
      byName: { edit_file: "ask" },
    });
    const out = checkPermission({
      def: makeTool({ name: "edit_file", category: "write" }),
      input: {},
      policy,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("ask→auto-allow in prototype"));
  });
});

describe("checkPermission — execute 安全兜底细节", () => {
  const policy = createPermissionPolicy();

  it("execute + 非字符串 command → deny（不是 allow）", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: undefined },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("command must be a string"));
  });

  it("execute + 数字 command → deny", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: 42 },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("command must be a string"));
  });

  it("execute + 对象 command → deny", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: { evil: true } },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("command must be a string"));
  });

  it("execute + echo 放行", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "allow");
  });

  it("execute + echo a > b（元字符） → deny，reason 含 allowlist", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo a > b" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("command not in allowlist"));
  });

  it("execute + echo $PATH（元字符） → deny", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo $PATH" },
      policy,
    });
    assert.equal(out.decision, "deny");
  });
});

describe("checkPermission — denyDangerousExecute=false 仅关黑名单双保险，不影响 allowlist", () => {
  it("execute + rm -rf / + denyDangerousExecute=false → 仍 deny（allowlist 拦截）", () => {
    const policy = createPermissionPolicy({ denyDangerousExecute: false });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /" },
      policy,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("command not in allowlist"));
  });

  it("execute + 已知安全命令 + denyDangerousExecute=false → allow", () => {
    const policy = createPermissionPolicy({ denyDangerousExecute: false });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hello" },
      policy,
    });
    assert.equal(out.decision, "allow");
  });
});
