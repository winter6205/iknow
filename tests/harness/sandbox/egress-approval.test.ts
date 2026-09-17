/**
 * Tests for `egress/approval.ts` — T6 首次域名批准流的会话级门件
 * (specs/network-egress-allowlist.md §首次域名批准流 + SC10 + ADR-0097 §批准
 * 持久化粒度)。
 *
 * 钉住的不变式（来自 spec §Boundaries 「首次域名批准流」 + §Failure paths
 * 三行 + §Input-contract classes「首次域名批准」行）：
 *   - 首次见到新 host → askApproval 被调一次;
 *   - 批准 → 该 host 加入会话级 allowed 集,本会话内不再 ask 且放行;
 *   - 拒绝 → 该 host 加入会话级 denied 集,本会话内不再 ask 且再次请求直接 deny;
 *   - pending 期间同 host 并发 → 合并为同一次结果(后到者等待同一 Promise);
 *     askApproval 只被调一次;
 *   - 不同 host 并发 → 各自独立调用,不合并;
 *   - askApproval 缺席 → 任何首次见到的新 host 都直接 deny(fail-closed);
 *   - askApproval 抛异常 → 直接 deny(fail-closed),不残留 in-flight 条目
 *     阻塞后续请求;
 *   - 状态可观察:allowedThisSession / deniedThisSession 含已决条目(in-flight
 *     pending 期间不含;pending 解决后才入集)。
 */

import { describe, expect, it, vi } from "vitest";
import {
  createEgressApprovalGate,
  type EgressApprovalGate,
} from "../../../src/harness/sandbox/egress/approval.js";

describe("createEgressApprovalGate — 首次域名批准流 (SC10)", () => {
  it("首次见到 host → askApproval 被调一次", async () => {
    const askApproval = vi.fn(async (_host: string) => true);
    const gate = createEgressApprovalGate({ askApproval });
    const result = await gate.askIfUnknown("example.com");
    expect(result).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(askApproval).toHaveBeenCalledWith("example.com");
  });

  it("批准 → 本会话内同 host 第二次不再 ask 且放行", async () => {
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    const first = await gate.askIfUnknown("github.com");
    expect(first).toBe(true);
    const second = await gate.askIfUnknown("github.com");
    expect(second).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(gate.allowedThisSession()).toContain("github.com");
    expect(gate.deniedThisSession()).not.toContain("github.com");
  });

  it("拒绝 → 本会话内同 host 第二次直接 deny 且不再 ask", async () => {
    const askApproval = vi.fn(async () => false);
    const gate = createEgressApprovalGate({ askApproval });
    const first = await gate.askIfUnknown("evil.example");
    expect(first).toBe(false);
    const second = await gate.askIfUnknown("evil.example");
    expect(second).toBe(false);
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(gate.deniedThisSession()).toContain("evil.example");
    expect(gate.allowedThisSession()).not.toContain("evil.example");
  });

  it("同 host 并发请求 → 合并为一次 ask,两个调用都等同一结果(批准)", async () => {
    let resolveAsk: ((v: boolean) => void) | undefined;
    const askApproval = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAsk = resolve;
        })
    );
    const gate = createEgressApprovalGate({ askApproval });
    const p1 = gate.askIfUnknown("github.com");
    const p2 = gate.askIfUnknown("github.com");
    // 两次并发都 pending → askApproval 只调一次
    expect(askApproval).toHaveBeenCalledTimes(1);
    // 解决
    resolveAsk?.(true);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
    expect(gate.allowedThisSession()).toContain("github.com");
  });

  it("同 host 并发请求 → 合并为一次 ask(拒绝)", async () => {
    let resolveAsk: ((v: boolean) => void) | undefined;
    const askApproval = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAsk = resolve;
        })
    );
    const gate = createEgressApprovalGate({ askApproval });
    const p1 = gate.askIfUnknown("evil.example");
    const p2 = gate.askIfUnknown("evil.example");
    expect(askApproval).toHaveBeenCalledTimes(1);
    resolveAsk?.(false);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(false);
    expect(r2).toBe(false);
    expect(gate.deniedThisSession()).toContain("evil.example");
  });

  it("不同 host 并发 → 各自独立 ask,不合并", async () => {
    const askApproval = vi.fn(async (host: string) => host === "a.example");
    const gate = createEgressApprovalGate({ askApproval });
    const [ra, rb] = await Promise.all([
      gate.askIfUnknown("a.example"),
      gate.askIfUnknown("b.example"),
    ]);
    expect(askApproval).toHaveBeenCalledTimes(2);
    expect(ra).toBe(true);
    expect(rb).toBe(false);
    expect(gate.allowedThisSession()).toContain("a.example");
    expect(gate.deniedThisSession()).toContain("b.example");
  });

  it("askApproval 缺席 → 任何首次见到的新 host 直接 deny(fail-closed)", async () => {
    const gate = createEgressApprovalGate({}); // 无 askApproval
    const r = await gate.askIfUnknown("github.com");
    expect(r).toBe(false);
    expect(gate.deniedThisSession()).toContain("github.com");
    // 再次调用同样 deny(deniedThisSession 命中),不再尝试任何 ask
    const r2 = await gate.askIfUnknown("github.com");
    expect(r2).toBe(false);
  });

  it("askApproval 抛异常 → 直接 deny(fail-closed),in-flight 条目被清除", async () => {
    const askApproval = vi.fn(async () => {
      throw new Error("ask surface broken");
    });
    const gate = createEgressApprovalGate({ askApproval });
    const r = await gate.askIfUnknown("github.com");
    expect(r).toBe(false);
    expect(gate.deniedThisSession()).toContain("github.com");
    // 第二次调用(并发或顺序)不会再尝试 askApproval,直接 deny
    const askApprovalCallsAfter = askApproval.mock.calls.length;
    const r2 = await gate.askIfUnknown("github.com");
    expect(r2).toBe(false);
    expect(askApproval.mock.calls.length).toBe(askApprovalCallsAfter);
  });

  it("pending 期间 host 不在 allowed/denied 集合中(inFlight Pending Map 内,集外)", async () => {
    let resolveAsk: ((v: boolean) => void) | undefined;
    const askApproval = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveAsk = resolve;
        })
    );
    const gate: EgressApprovalGate = createEgressApprovalGate({ askApproval });
    const pending = gate.askIfUnknown("github.com");
    // pending 期间:既不在 allowed 也不在 denied(决策未决)
    expect(gate.allowedThisSession()).not.toContain("github.com");
    expect(gate.deniedThisSession()).not.toContain("github.com");
    resolveAsk?.(true);
    await pending;
    expect(gate.allowedThisSession()).toContain("github.com");
  });

  it("host 大小写归一(trim + lowercase)→ 'Example.COM' 与 'example.com' 同集", async () => {
    const askApproval = vi.fn(async () => true);
    const gate = createEgressApprovalGate({ askApproval });
    await gate.askIfUnknown("Example.COM");
    // 第二次用小写 — 应直接命中 allowed 集,不再次问
    const r = await gate.askIfUnknown("example.com");
    expect(r).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
  });
});
