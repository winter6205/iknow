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
  isBashNetworkTrue,
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

// ---------------------------------------------------------------------------
// #503 T10 / ADR-0022 D2: bash network:true → 强制 ask，full_auto 不豁免。
// 规则在 code 层，命中后直接 return（先于 mode 解析），所以 full_auto 分支
//（policy.ts:155）对这条调用永远到不了。fence 形状变化（去 --unshare-net）
// 是新批准轴，与动作批准轴正交；硬墙仍先于 code 规则（hard-wall 优先）。
// ---------------------------------------------------------------------------

describe("SC8: #503 T10 bash network:true 强制 ask（layered rule 先于 mode，full_auto 不豁免）", () => {
  const policy = createPermissionPolicy();

  it("isBashNetworkTrue SSOT 与 code-ask-bash-network 决策同源（review-repair 跨引用一致性）", () => {
    // 决策规则（policy.ts）与 hint 判定（permission-executor.ts isNetworkBash）
    // 共用同一谓词。直接引用 SSOT 函数，验证 predicate 对决策结果逐例对应：
    // 规则命中 ⟺ isBashNetworkTrue(tool, input) 为 true。permission-executor
    // 侧 import 同一函数，命题自动成立（编译期强类型 + 此处行为锁定）。
    const cases: ReadonlyArray<{
      tool: string;
      input: unknown;
      expectNetworkTrue: boolean;
    }> = [
      {
        tool: "bash",
        input: { command: "curl x", network: true },
        expectNetworkTrue: true,
      },
      { tool: "bash", input: { command: "ls" }, expectNetworkTrue: false },
      {
        tool: "bash",
        input: { command: "ls", network: false },
        expectNetworkTrue: false,
      },
      {
        tool: "bash",
        input: { command: "ls", network: "true" },
        expectNetworkTrue: false,
      },
      {
        tool: "web_fetch",
        input: { url: "x", network: true },
        expectNetworkTrue: false,
      },
    ];
    for (const c of cases) {
      assert.equal(isBashNetworkTrue(c.tool, c.input), c.expectNetworkTrue);
      const out = checkPermission({
        def: makeTool({ name: c.tool, category: "execute" }),
        input: c.input,
        sources: policy.sources,
        hardWalls: policy.hardWalls,
        defaultByCategory: policy.defaultByCategory,
      });
      if (c.expectNetworkTrue) {
        assert.equal(out.decision, "ask");
        assert.ok(out.reason.includes("network"));
      }
    }
  });

  it("network:true + default mode → ask（rule reason 含 host-network 语义）", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "curl http://127.0.0.1:3000", network: true },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("network"));
    assert.ok(out.reason.includes("host"));
    // #951:reason 与 ask hint 同口径 —— 钉住 network-guard 绕过事实
    assert.ok(
      out.reason.includes("不经 network-guard"),
      `reason must disclose network-guard bypass: ${out.reason}`
    );
  });

  it("network:true + full_auto → ask（layered rule 先于 mode 解析，full_auto 永远到不了）", () => {
    const fullAuto = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "curl http://127.0.0.1:3000", network: true },
      sources: fullAuto.sources,
      hardWalls: fullAuto.hardWalls,
      defaultByCategory: fullAuto.defaultByCategory,
      mode: fullAuto.mode,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("network"));
  });

  it("network 缺省 + full_auto → 既有 full_auto allow 决策不变（零回归）", () => {
    const fullAuto = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hi" },
      sources: fullAuto.sources,
      hardWalls: fullAuto.hardWalls,
      defaultByCategory: fullAuto.defaultByCategory,
      mode: fullAuto.mode,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("full_auto"));
  });

  it("network:false + full_auto → 既有 full_auto allow 决策不变（network:false 不命中规则）", () => {
    const fullAuto = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "echo hi", network: false },
      sources: fullAuto.sources,
      hardWalls: fullAuto.hardWalls,
      defaultByCategory: fullAuto.defaultByCategory,
      mode: fullAuto.mode,
    });
    assert.equal(out.decision, "allow");
  });

  it('network 非布尔（字符串 "true"）input 校验边界 → 不命中规则，走既有路径', () => {
    // 字符串 "true" !== true → 规则不命中。
    //  default mode 下 execute → category default ask；但 reason 是 category
    //  default，不是 rule reason（reason 区分即可锁定）。
    const outDefault = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "ls", network: "true" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(outDefault.decision, "ask");
    assert.ok(outDefault.reason.includes("category default"));
    // full_auto 下规则不命中 → mode 解析直接放行。
    const fullAuto = createPermissionPolicy({ mode: "full_auto" });
    const outFullAuto = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "ls", network: "true" },
      sources: fullAuto.sources,
      hardWalls: fullAuto.hardWalls,
      defaultByCategory: fullAuto.defaultByCategory,
      mode: fullAuto.mode,
    });
    assert.equal(outFullAuto.decision, "allow");
  });

  it("network:true + 危险命令 → hard-wall 仍先于 code 规则触发 deny", () => {
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "rm -rf /", network: true },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
    assert.ok(out.reason.includes("[hard_wall]"));
  });

  it('非 bash 工具 network 字段存在 → 规则不命中（规则 tool==="bash" 卡口）', () => {
    const out = checkPermission({
      def: makeTool({ name: "web_fetch", category: "read-only" }),
      input: { url: "https://x.example", network: true },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    // read-only category default → allow。规则不命中 → 走 category default。
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("category default"));
  });

  it("project 层仍可对 network:true escalate（如改成 deny）", () => {
    const project = {
      kind: "project" as const,
      filePath: "/tmp/perm-network.toml",
      rules: [
        {
          id: "project-deny-bash-network",
          match: ({ tool }: { tool: string }) => tool === "bash",
          decision: "deny" as const,
          reason: "project denies bash (network applies too)",
        },
      ],
    };
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "curl x", network: true },
      sources: { code: policy.sources.code, project },
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "deny");
  });

  it("network:true 在 plan mode → ask（layered rule 仍先于 mode）", () => {
    const plan = createPermissionPolicy({ mode: "plan" });
    const out = checkPermission({
      def: makeTool({ name: "bash", category: "execute" }),
      input: { command: "curl x", network: true },
      sources: plan.sources,
      hardWalls: plan.hardWalls,
      defaultByCategory: plan.defaultByCategory,
      mode: plan.mode,
    });
    assert.equal(out.decision, "ask");
  });
});

// ---------------------------------------------------------------------------
// #440 T5: todo_write D7 权限规则 — list 子模式 bypass ask (read-only),
//         add / check 走 category default ask (write)。
// ---------------------------------------------------------------------------

describe("SC7: #440 T5 todo_write list 子模式 bypass ask (read-only), add/check 走默认 ask", () => {
  const policy = createPermissionPolicy();

  it("todo_write list mode → allow (bypass ask, read-only 子模式)", () => {
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: { mode: "list" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("todo_write"));
    assert.ok(out.reason.includes("list"));
  });

  it("todo_write add mode → ask (write category 默认, list 子模式豁免不适用)", () => {
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: { mode: "add", item: "ship T5" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("write"));
  });

  it("todo_write check mode → ask (write category 默认, list 子模式豁免不适用)", () => {
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: { mode: "check", item: "ship T5" },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("write"));
  });

  // #903 SC5:replace 是 write 默认 ask;list 子模式豁免不适用(仅 list bypass)。
  it("todo_write replace mode → ask (write category 默认;list 子模式豁免不适用)", () => {
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: { mode: "replace", items: ["A", "B"] },
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("write"));
    // 不应命中 list bypass(decision=allow / reason 含 list)
    assert.ok(!out.reason.includes("todo_write list mode"));
  });

  it("todo_write replace mode 在 full_auto mode → ask(layered rule 先于 mode, write ask 路径仍生效)", () => {
    // 验证 code-layer 没有给 replace 写专属 ask rule,所以 full_auto 仍
    // 走 mode 路径放行。spec 决议:replace 默认 ask;full_auto 下 model 显式
    // 同意可执行。
    const fullAuto = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: { mode: "replace", items: ["A"] },
      sources: fullAuto.sources,
      hardWalls: fullAuto.hardWalls,
      defaultByCategory: fullAuto.defaultByCategory,
      mode: fullAuto.mode,
    });
    assert.equal(out.decision, "allow");
    assert.ok(out.reason.includes("full_auto"));
  });

  it("todo_write 缺 mode → ask (defense in depth, list 子模式豁免不适用)", () => {
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: {},
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("write"));
  });

  it("todo_write input 非对象 → ask (defense in depth, mode 字段无法读取)", () => {
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: null,
      sources: policy.sources,
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
    });
    assert.equal(out.decision, "ask");
    assert.ok(out.reason.includes("write"));
  });

  it("todo_write list mode 在 full_auto mode → allow (mode 优先级高于 code-rule, 但结果同 allow)", () => {
    const fullAuto = createPermissionPolicy({ mode: "full_auto" });
    const out = checkPermission({
      def: makeTool({ name: "todo_write", category: "write" }),
      input: { mode: "list" },
      sources: fullAuto.sources,
      hardWalls: fullAuto.hardWalls,
      defaultByCategory: fullAuto.defaultByCategory,
      mode: fullAuto.mode,
    });
    assert.equal(out.decision, "allow");
  });
});
