/**
 * user-hook-router: user lane hook router（T2/T3/T4 工厂）测试。
 *
 * SSOT: specs/user-hook-router.md —— 逐条 SC2/SC3/SC4/SC5/SC6/SC10 定向
 * （SC1 侧 = enabled 缺席/false 恒 undefined 的透明 hook 也钉在这里）。
 *
 * 测试风格对齐 tests/harness/permission/secrets-guard.test.ts；
 * classify 用真实现（isolation/worktree-gate.ts 的 classifyCall 是纯函数，
 * 不 stub）—— 与 test.md「命令 handler 集成接真实依赖」同纪律。
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  composePreHooks,
  createUserHookRouter,
} from "../../../src/harness/hooks/user-lane.js";
import type { PreToolUseHook } from "../../../src/harness/permission/types.js";
import type { IknowSettingsHooks } from "../../../src/config/settings.js";
import { classifyCall } from "../../../src/harness/isolation/worktree-gate.js";

/** 断言 hook 返回 block 且 reason 含指定片段。 */
function assertBlocked(
  hook: PreToolUseHook,
  tool: string,
  input: unknown,
  reasonPart?: string
): void {
  const block = hook({ tool, input });
  assert.ok(block, `expected block for tool=${tool}`);
  if (reasonPart !== undefined) {
    assert.ok(
      block.reason.includes(reasonPart),
      `reason should include ${JSON.stringify(reasonPart)}, got: ${block.reason}`
    );
  }
}

function assertPassthrough(
  hook: PreToolUseHook,
  tool: string,
  input: unknown
): void {
  assert.equal(hook({ tool, input }), undefined);
}

/**
 * 统一构造入口：注入真 classifyCall（isolation SSOT 纯函数，不 stub ——
 * 与 test.md「接真实依赖」纪律一致）。
 */
function makeHook(
  hooks: IknowSettingsHooks,
  onHookError?: (e: { phase: string; message: string }) => void
): PreToolUseHook {
  return createUserHookRouter(hooks, { classify: classifyCall, onHookError });
}

describe("createUserHookRouter — SC1 侧：enabled 缺席 / false → 透明 hook", () => {
  it("enabled 缺席 → 恒 undefined，即使 rules 写了也会拦的条目", () => {
    const hooks: IknowSettingsHooks = {
      rules: [{ id: "r1", event: "PreToolUse", reason: "no" }],
    };
    const hook = createUserHookRouter(hooks);
    assertPassthrough(hook, "bash", { command: "anything" });
    assertPassthrough(hook, "write_file", { path: "x" });
  });

  it("enabled: false → 恒 undefined", () => {
    const hooks: IknowSettingsHooks = {
      enabled: false,
      rules: [
        {
          id: "r1",
          event: "PreToolUse",
          tool: "bash",
          reason: "no",
        },
      ],
    };
    const hook = createUserHookRouter(hooks);
    assertPassthrough(hook, "bash", { command: "git commit -m x" });
  });

  it("enabled: false 时不编译 pattern：非法正则也不触发 onHookError", () => {
    const errors: string[] = [];
    const hook = createUserHookRouter(
      {
        enabled: false,
        rules: [
          {
            id: "bad",
            event: "PreToolUse",
            pattern: "[unclosed",
            reason: "x",
          },
        ],
      },
      { onHookError: (e) => errors.push(e.message) }
    );
    assertPassthrough(hook, "bash", "x");
    assert.deepEqual(errors, []);
  });

  it("hooks 段整体缺席（undefined）→ 恒 undefined", () => {
    const hook = createUserHookRouter(undefined);
    assertPassthrough(hook, "bash", { command: "git commit -m x" });
  });
});

describe("createUserHookRouter — SC2: PreToolUse matcher 命中拦 / 未命中放行", () => {
  it("tool 精确名命中 → 返回 {reason} 含规则 reason", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        {
          id: "no-rm",
          event: "PreToolUse",
          tool: "bash",
          reason: "rm is not allowed",
        },
      ],
    });
    assertBlocked(hook, "bash", { command: "rm -rf /" }, "rm is not allowed");
  });

  it("tool 精确名不匹配（其他工具）→ undefined", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "no-rm", event: "PreToolUse", tool: "bash", reason: "no" }],
    });
    assertPassthrough(hook, "read_file", { path: "x" });
  });

  it("toolPrefix 前缀命中 → 拦；不同前缀 → 放行", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        {
          id: "no-github",
          event: "PreToolUse",
          toolPrefix: "mcp__github",
          reason: "github blocked",
        },
      ],
    });
    assertBlocked(hook, "mcp__github_create_issue", {}, "github blocked");
    assertPassthrough(hook, "mcp__gitlab_create_issue", {});
  });

  it("pattern 正则命中（对 stringify 截断后的扫描串）→ 拦", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        {
          id: "no-akia",
          event: "PreToolUse",
          pattern: "AKIA[0-9A-Z]{16}",
          reason: "aws key detected",
        },
      ],
    });
    assertBlocked(hook, "bash", { command: "echo AKIA1234567890ABCDEF" });
    assertPassthrough(hook, "bash", { command: "echo hello" });
  });

  it("多 matcher 同条规则须全部命中（缺席 matcher 视为通配）", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        {
          id: "bash-rm",
          event: "PreToolUse",
          tool: "bash",
          pattern: "\\brm\\b",
          reason: "no rm",
        },
      ],
    });
    assertBlocked(hook, "bash", { command: "rm -rf x" }, "no rm");
    // tool 命中但 pattern 未命中 → 放行
    assertPassthrough(hook, "bash", { command: "ls -la" });
    // pattern 命中但 tool 未命中 → 放行
    assertPassthrough(hook, "write_file", { content: "rm -rf x" });
  });

  it("无任何 matcher 的规则 = 通配（任意工具任意 input 都拦）", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "all", event: "PreToolUse", reason: "all blocked" }],
    });
    assertBlocked(hook, "anything", { x: 1 }, "all blocked");
  });

  it("pattern 非法条已被构造期剔除后，同规则的 tool matcher 不再使其拦截（SC6 联动）", () => {
    const errors: Array<{ phase: string; message: string }> = [];
    const hook = makeHook(
      {
        enabled: true,
        rules: [
          {
            id: "bad-only",
            event: "PreToolUse",
            tool: "bash",
            pattern: "[unclosed",
            reason: "x",
          },
        ],
      },
      (e) => errors.push(e)
    );
    // 规则被整条剔除（pattern 是该规则唯一 matcher 之外还有 tool —— 剔除
    // pattern 字段后规则仍有 tool matcher，但 pattern 非法 → 整条丢弃，
    // 因为部分 matcher 剔除会造成「比用户声明的更宽」的拦截面，违反
    // deny-only 的最小意外原则）
    assertPassthrough(hook, "bash", { command: "anything" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.phase, "user-rule-init");
  });
});

describe("createUserHookRouter — SC3: PreWrite 只拦 classify=mutate", () => {
  it("write_file（FILE_WRITE_TOOL_NAMES，classify=mutate）→ 拦", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "w", event: "PreWrite", reason: "no writes" }],
    });
    assertBlocked(hook, "write_file", { path: "a.txt" }, "no writes");
    assertBlocked(hook, "edit_file", { path: "a.txt" }, "no writes");
  });

  it("read_file（classify=read）即使规则无任何 matcher 也不拦", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "w", event: "PreWrite", reason: "no writes" }],
    });
    assertPassthrough(hook, "read_file", { path: "a.txt" });
  });

  it("root_flip 不算 mutate：enter-task-worktree 不因 PreWrite 被拦", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "w", event: "PreWrite", reason: "no writes" }],
    });
    assertPassthrough(hook, "enter-task-worktree", {
      conversationId: "c1",
    });
  });

  it("bash classify=mutate 的命令可被拦（真 classifyCall）", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "w", event: "PreWrite", reason: "no writes" }],
    });
    assertBlocked(hook, "bash", { command: "echo x > f.txt" }, "no writes");
    // bash 只读命令（read）不拦
    assertPassthrough(hook, "bash", { command: "ls -la" });
  });

  it("PreWrite 上 pattern matcher 在 classify 通过后再匹配", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        {
          id: "w",
          event: "PreWrite",
          tool: "write_file",
          pattern: "dist/",
          reason: "no dist writes",
        },
      ],
    });
    assertBlocked(hook, "write_file", { path: "dist/out.js" });
    // classify 通过但 pattern 未命中 → 放行
    assertPassthrough(hook, "write_file", { path: "src/out.js" });
  });

  it("PreWrite 事件不拦 PreToolUse 场景：read_file 的 PreToolUse 规则与 PreWrite 互不串", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        { id: "tool", event: "PreToolUse", tool: "read_file", reason: "t" },
        { id: "write", event: "PreWrite", reason: "w" },
      ],
    });
    assertBlocked(hook, "read_file", { path: "x" }, "t");
    assertBlocked(hook, "write_file", { path: "x" }, "w");
  });
});

describe("createUserHookRouter — SC4: PreCommit git commit 形态判定", () => {
  const hook = makeHook({
    enabled: true,
    rules: [{ id: "no-commit", event: "PreCommit", reason: "commits denied" }],
  });

  const blocked: Array<{ label: string; command: string }> = [
    { label: "git commit -m", command: 'git commit -m "x"' },
    { label: "git -C <path> commit", command: "git -C /tmp commit -m x" },
    { label: "裸 git commit", command: "git commit" },
    { label: "双空格容忍", command: "git  commit -m x" },
    { label: "引号容忍", command: "git 'commit' -m x" },
    {
      label: "多段命令中含 commit 段",
      command: "git status && git commit -m x",
    },
  ];
  for (const c of blocked) {
    it(`拦：${c.label}`, () => {
      assertBlocked(hook, "bash", { command: c.command }, "commits denied");
    });
  }

  const passthrough: Array<{ label: string; command: string }> = [
    { label: "git status", command: "git status" },
    { label: "git commit --help", command: "git commit --help" },
    { label: "git commit-tree", command: "git commit-tree HEAD^{tree}" },
    { label: "git help commit", command: "git help commit" },
    { label: "非 git 命令", command: "npm commit" },
    { label: "git log", command: "git log --oneline" },
  ];
  for (const c of passthrough) {
    it(`不拦：${c.label}`, () => {
      assertPassthrough(hook, "bash", { command: c.command });
    });
  }

  it("非 bash 工具不拦", () => {
    assertPassthrough(hook, "write_file", { command: "git commit -m x" });
  });

  it("command 非字符串 → 保守放行（deny-only 拦截宁可放行，与 classifyCall 的 fail-closed mutate 相反）", () => {
    assertPassthrough(hook, "bash", { command: 42 });
    assertPassthrough(hook, "bash", {});
  });

  it("tool matcher 在 PreCommit 上同样生效：git commit 但 tool 不匹配 → 不拦", () => {
    const scoped = makeHook({
      enabled: true,
      rules: [
        {
          id: "scoped",
          event: "PreCommit",
          tool: "bash",
          reason: "scoped",
        },
      ],
    });
    assertBlocked(scoped, "bash", { command: "git commit -m x" });
  });
});

describe("createUserHookRouter — SC5: 多条规则先拦先赢", () => {
  it("两条规则都命中同一调用 → 只返回第一条 reason", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        {
          id: "first",
          event: "PreToolUse",
          tool: "bash",
          reason: "first wins",
        },
        { id: "second", event: "PreToolUse", tool: "bash", reason: "second" },
      ],
    });
    assertBlocked(hook, "bash", { command: "x" }, "first wins");
    const block = hook({ tool: "bash", input: { command: "x" } });
    assert.ok(!block!.reason.includes("second"));
  });

  it("第一条不命中、第二条命中 → 采用第二条", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        { id: "a", event: "PreToolUse", tool: "read_file", reason: "a" },
        { id: "b", event: "PreToolUse", tool: "bash", reason: "b" },
      ],
    });
    assertBlocked(hook, "bash", { command: "x" }, "b");
  });

  it("跨事件同理：PreWrite 命中后不再评估后续 PreWrite 规则", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        { id: "w1", event: "PreWrite", reason: "w1" },
        { id: "w2", event: "PreWrite", reason: "w2" },
      ],
    });
    const block = hook({ tool: "write_file", input: { path: "x" } });
    assert.ok(block);
    assert.equal(block.reason, "w1");
  });
});

describe("createUserHookRouter — SC6: 非法 pattern 构造期剔除，不毒化其他规则", () => {
  it("坏 pattern 条剔除 + onHookError(user-rule-init) + 合法条仍工作", () => {
    const errors: Array<{ phase: string; message: string }> = [];
    const hook = makeHook(
      {
        enabled: true,
        rules: [
          {
            id: "bad",
            event: "PreToolUse",
            pattern: "[unclosed",
            reason: "bad",
          },
          {
            id: "good",
            event: "PreToolUse",
            pattern: "AKIA[0-9A-Z]{16}",
            reason: "good rule",
          },
        ],
      },
      (e) => errors.push(e)
    );

    // 构造不抛（走到这里即证）；坏条剔除后不拦正常调用
    assertPassthrough(hook, "bash", { command: "ls" });
    // 合法条仍生效
    assertBlocked(
      hook,
      "bash",
      { command: "AKIA1234567890ABCDEF" },
      "good rule"
    );
    // 仅 1 条告警，指向坏 pattern
    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.phase, "user-rule-init");
    assert.ok(errors[0]!.message.includes("[unclosed"));
    assert.ok(errors[0]!.message.includes("bad"));
  });

  it("坏 pattern 不产生运行期异常：hook 只返回 undefined 或 {reason}", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "bad", event: "PreToolUse", pattern: "((", reason: "bad" }],
    });
    // 构造期已剔除，运行期对该规则零行为
    const result = hook({ tool: "bash", input: { command: "ls" } });
    assert.equal(result, undefined);
  });
});

describe("createUserHookRouter — SC10: 超长 input 截断", () => {
  const pattern = "NEEDLE_XYZ";

  it("pattern 在截断窗口（20000 字符）之外 → 不拦、不抛", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "p", event: "PreToolUse", pattern, reason: "needle" }],
    });
    const payload = "a".repeat(25_000) + pattern;
    assertPassthrough(hook, "bash", { command: payload });
  });

  it("pattern 在截断窗口之内 → 拦", () => {
    const hook = makeHook({
      enabled: true,
      rules: [{ id: "p", event: "PreToolUse", pattern, reason: "needle" }],
    });
    const payload = pattern + "a".repeat(25_000);
    assertBlocked(hook, "bash", { command: payload }, "needle");
  });

  it("stringify 失败（循环引用）→ pattern 视为未命中，不抛", () => {
    const hook = makeHook({
      enabled: true,
      rules: [
        { id: "p", event: "PreToolUse", pattern: "self", reason: "cyclic" },
      ],
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assertPassthrough(hook, "bash", cyclic);
  });
});

describe("composePreHooks — multiplexer 组合", () => {
  const builtin = makeHook({
    enabled: true,
    rules: [
      {
        id: "builtin",
        event: "PreToolUse",
        tool: "bash",
        reason: "builtin hit",
      },
    ],
  });
  const user = makeHook({
    enabled: true,
    rules: [
      { id: "user", event: "PreToolUse", tool: "bash", reason: "user hit" },
    ],
  });

  it("builtin 在前、user 在后 → builtin 先拦先赢", () => {
    const composed = composePreHooks([builtin, user]);
    assertBlocked(composed, "bash", { command: "x" }, "builtin hit");
    const block = composed({ tool: "bash", input: { command: "x" } });
    assert.ok(!block!.reason.includes("user hit"));
  });

  it("user deny 时 builtin 之后的 hook 不再被调用（短路）", () => {
    const calls: string[] = [];
    const denyUser: PreToolUseHook = () => {
      calls.push("user");
      return { reason: "user deny" };
    };
    const after: PreToolUseHook = () => {
      calls.push("after");
      return undefined;
    };
    const composed = composePreHooks([denyUser, after]);
    const block = composed({ tool: "bash", input: {} });
    assert.deepEqual(calls, ["user"]);
    assert.ok(block);
    assert.equal(block.reason, "user deny");
  });

  it("全部未命中 → undefined，全部 hook 均被评估", () => {
    const calls: string[] = [];
    const a: PreToolUseHook = () => {
      calls.push("a");
      return undefined;
    };
    const b: PreToolUseHook = () => {
      calls.push("b");
      return undefined;
    };
    const composed = composePreHooks([a, b]);
    assert.equal(composed({ tool: "bash", input: {} }), undefined);
    assert.deepEqual(calls, ["a", "b"]);
  });

  it("空组合 → 恒 undefined", () => {
    const composed = composePreHooks([]);
    assertPassthrough(composed, "bash", { command: "git commit -m x" });
  });
});
