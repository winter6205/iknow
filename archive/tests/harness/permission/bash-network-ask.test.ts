/**
 * archived: per-call network:true 轴退役（ADR-0097 accepted）——原断言钉住的旧语义已由 tests/harness/aci/bash-egress-typed-failure.test.ts / egress-domain-matcher.test.ts 承接
 *
 * ── original header ──────────────────────────────────────────────────────
 * #503 T10 / ADR-0022 — bash network:true ask hint + 字段透传。
 *
 * 覆盖：
 *   1. permission-executor 在 network bash 上把 askUser ctx 的 summaryHint
 *      改为 `[请求宿主网络] <命令摘要>`（命令过长时沿用 summarizeInput 的
 *      截断风格），并把 `network: true` 透传到 ctx。
 *   2. 命令含 `<<<SECRET_N>>>` 占位符（#406 roundtrip 产物）→ hint 追加
 *      `[secret 警告] 命令含 secret 占位符，批准后真值可能随命令出站`。
 *   3. 非 network bash / 其他工具走原 summarizeInput JSON 路径（零变化），
 *      且 ctx.network 缺省（executor 不传）。
 *
 * 集成驱动：通过 createPermissionExecutor + askUser spy 捕获 ctx —— 同时
 * 锁定 hint 文案 + 字段透传，不导出内部 helper。
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  createPermissionExecutor,
  type HookErrorEvent,
} from "../../../src/harness/permission/permission-executor.js";
import { createPermissionPolicy } from "../../../src/harness/permission/policy.js";
import type { AskUser } from "../../../src/harness/permission/types.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import type {
  Executor,
  Registry,
  ToolCall,
  ToolExecutionResult,
  ToolDef,
} from "../../../src/harness/tools/types.js";

function makeBashTool(): AciToolDef {
  return Object.freeze({
    name: "bash",
    description: "test bash",
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => ({ code: 0, stdout: "", stderr: "" }),
    aci: Object.freeze({
      category: "execute",
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    }),
  });
}

function makeRegistry(def: AciToolDef): Registry {
  const all: ToolDef[] = [def];
  return Object.freeze({
    list: () => all,
    get: (name: string) => all.find((t) => t.name === name),
  });
}

function makeInnerOk(): Executor {
  return Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> =>
      batch.map((c) => ({
        kind: "ok" as const,
        toolUseId: c.id,
        payload: [{ type: "text" as const, text: "ok" }],
      })),
  });
}

interface AskCapture {
  ctx: Parameters<AskUser>[0];
  calls: number;
}

function makeCapturingAsk(capture: AskCapture): AskUser {
  return async (ctx) => {
    capture.calls += 1;
    capture.ctx = ctx;
    return true;
  };
}

describe("#503 T10 — bash network hint + askUser ctx.network 透传", () => {
  // #951:hint 形态是产品契约 —— 测试持有期望文案（pin，非 import），
  // 锁定「不经 network-guard」与「link-local 元数据」两项事实 + 长度算术。
  const MARKER = "[请求宿主网络·不经 network-guard] ";
  const TAIL =
    "（宿主 netns 全量可见：localhost 服务 / 局域网 / link-local 元数据 169.254.169.254；无 IP 过滤、无域名过滤）";
  const SECRET_WARNING =
    " [secret 警告] 命令含 secret 占位符，批准后真值可能随命令出站";
  // 80 字符封顶（marker + 截断命令 + "..." 都算在内），tail/secret 警告叠加在外。
  const NETWORK_HINT_HEAD_CAP = 80;

  it("network bash → askUser ctx.summaryHint 含 [请求宿主网络·不经 network-guard] 标记 + 命令摘要 + 常驻 tail", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      {
        id: "u1",
        name: "bash",
        input: {
          command: "curl http://127.0.0.1:3000/api",
          network: true,
        },
      },
    ]);
    assert.equal(capture.calls, 1, "askUser should have been called once");
    assert.ok(capture.ctx.summaryHint.includes(MARKER));
    assert.ok(
      capture.ctx.summaryHint.includes("curl http://127.0.0.1:3000/api")
    );
    // #951 事实一：该批准路径绕过 network-guard SSRF 防线
    assert.ok(
      capture.ctx.summaryHint.includes("不经 network-guard"),
      `hint must disclose network-guard bypass: ${capture.ctx.summaryHint}`
    );
    // #951 事实二：host netns 下 link-local 元数据端点可达
    assert.ok(
      capture.ctx.summaryHint.includes("link-local 元数据 169.254.169.254"),
      `hint must disclose link-local metadata reachability: ${capture.ctx.summaryHint}`
    );
    assert.ok(
      capture.ctx.summaryHint.includes("无 IP 过滤"),
      "hint must disclose no IP filter"
    );
    assert.ok(
      capture.ctx.summaryHint.includes("无域名过滤"),
      "hint must disclose no domain filter"
    );
    assert.equal(capture.ctx.summaryHint.endsWith(TAIL), true);
    assert.equal(capture.ctx.network, true);
  });

  it("network bash 命令含 <<<SECRET_1>>> → hint 追加 [secret 警告] + 占位符保留", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    const command =
      'curl -H "Authorization: Bearer <<<SECRET_1>>>" http://api.example.com';
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command, network: true } },
    ]);
    assert.ok(capture.ctx.summaryHint.includes("[secret 警告]"));
    assert.ok(capture.ctx.summaryHint.includes("<<<SECRET_1>>>"));
    assert.ok(capture.ctx.summaryHint.includes("命令含 secret 占位符"));
    // #951:secret 警告叠加在 80 封顶之外，marker 变长也必须保持完整
    assert.ok(capture.ctx.summaryHint.includes(SECRET_WARNING));
    assert.ok(capture.ctx.summaryHint.includes(TAIL), "tail 在警告前保持常驻");
    // tail 始终在末尾（即使叠加 secret 警告）
    assert.ok(capture.ctx.summaryHint.endsWith(TAIL));
    assert.equal(capture.ctx.network, true);
  });

  it("network bash 无占位符 → hint 不含 [secret 警告]", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      {
        id: "u1",
        name: "bash",
        input: { command: "curl http://localhost:8080", network: true },
      },
    ]);
    assert.equal(capture.ctx.summaryHint.includes("[secret 警告]"), false);
    assert.equal(capture.ctx.summaryHint.includes("secret"), false);
  });

  it("长命令沿用 summarizeInput 截断风格（80 字符封顶带省略号）", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    const longCmd = "curl " + "x".repeat(120);
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: longCmd, network: true } },
    ]);
    // 截断的 "..." 落在 head 中（80 封顶内），TAIL 追加在末尾（80 封顶之外）
    const head = capture.ctx.summaryHint.slice(
      0,
      capture.ctx.summaryHint.length - TAIL.length
    );
    assert.ok(head.endsWith("..."));
    // #951 长度算术：marker(26) + 截断命令(80-26-3=51) + "..."(3) = 80 封顶，
    // 之后追加常驻 tail（在 80 封顶之外，与 secret 警告同栈）。退化检查：
    // markerLen + 3 = 29 ≤ 80，slice 不为负，摘要不会塌缩成 "marker..."。
    assert.ok(
      capture.ctx.summaryHint.length > 0 &&
        capture.ctx.summaryHint.startsWith(MARKER) &&
        !capture.ctx.summaryHint.startsWith(`${MARKER}...`),
      "marker + slice must not collapse to bare 'marker...' (markerLen+3 ≤ 80)"
    );
    const headLen = capture.ctx.summaryHint.length - TAIL.length;
    assert.ok(
      headLen <= NETWORK_HINT_HEAD_CAP,
      `hint head (marker+summary) too long: ${headLen} > ${NETWORK_HINT_HEAD_CAP}`
    );
    // 全长 = head(≤80) + tail 常驻；无 secret 时 tail 是唯一叠加项
    assert.equal(capture.ctx.summaryHint.endsWith(TAIL), true);
  });

  it("secret 警告与 tail 叠加时总长有界（head ≤ 80 + tail + warning）", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    const longSecretCmd = "curl " + "x".repeat(120) + " <<<SECRET_1>>>";
    await executor.executeAll([
      {
        id: "u1",
        name: "bash",
        input: { command: longSecretCmd, network: true },
      },
    ]);
    const hint = capture.ctx.summaryHint;
    assert.ok(hint.startsWith(MARKER));
    // TAIL 始终在末尾 —— 即使叠加 secret 警告，常驻披露也不能被挤掉
    assert.ok(hint.endsWith(TAIL));
    assert.ok(hint.includes(SECRET_WARNING));
    const expectedMax =
      NETWORK_HINT_HEAD_CAP + TAIL.length + SECRET_WARNING.length;
    assert.ok(
      hint.length <= expectedMax,
      `stacked hint too long: ${hint.length} > ${expectedMax}`
    );
  });

  it("非 network bash（network 缺省）→ 走原 summarizeInput JSON 路径，ctx.network 缺省", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: "ls" } },
    ]);
    assert.equal(capture.ctx.summaryHint, '{"command":"ls"}');
    assert.equal(capture.ctx.network, undefined);
  });

  it("network:false bash → 走原 summarizeInput JSON 路径，ctx.network 缺省", async () => {
    const capture: AskCapture = { ctx: undefined as never, calls: 0 };
    const executor = createPermissionExecutor({
      inner: makeInnerOk(),
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: makeCapturingAsk(capture),
    });
    await executor.executeAll([
      { id: "u1", name: "bash", input: { command: "ls", network: false } },
    ]);
    assert.equal(capture.ctx.summaryHint, '{"command":"ls","network":false}');
    assert.equal(capture.ctx.network, undefined);
  });

  it("network:true bash + askUser 拒绝 → execution_failed [user_denied]，inner 零调用", async () => {
    let innerCalls = 0;
    const inner: Executor = Object.freeze({
      executeAll: async (batch: ReadonlyArray<ToolCall>) => {
        innerCalls += batch.length;
        return batch.map((c) => ({
          kind: "ok" as const,
          toolUseId: c.id,
          payload: [{ type: "text" as const, text: "x" }],
        }));
      },
    });
    const executor = createPermissionExecutor({
      inner,
      registry: makeRegistry(makeBashTool()),
      policy: createPermissionPolicy(),
      askUser: async () => false,
    });
    const result = await executor.executeAll([
      {
        id: "u1",
        name: "bash",
        input: { command: "curl x", network: true },
      },
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.kind, "execution_failed");
    if (result[0]!.kind === "execution_failed") {
      assert.ok(result[0]!.message.startsWith("[user_denied]"));
    }
    assert.equal(innerCalls, 0);
  });
});

// HookErrorEvent 仅用于锁定 export（在 T10 没有显式钩子测试，但导出符号
// 不应变性感；TS 编译期即验证）。此处留空以避免 unused import 警告。
const _typeAssert: HookErrorEvent = { phase: "pre", message: "" };
void _typeAssert;
