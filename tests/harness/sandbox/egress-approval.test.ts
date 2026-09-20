/**
 * Tests for `egress/approval.ts` — the session-level gate of the first-seen
 * domain approval flow (specs/network-egress-allowlist.md, ADR-0097 approval
 * persistence granularity).
 *
 * Pinned invariants (from the spec's Boundaries / Failure paths /
 * Input-contract classes entries for the first-seen approval flow):
 *   - a host seen for the first time → askApproval is called once;
 *   - approved → the host joins the session-level allowed set: no further
 *     asks this session and requests pass;
 *   - denied → the host joins the session-level denied set: no further asks
 *     this session and later requests are denied directly;
 *   - concurrent same-host requests while pending → merged into one result
 *     (latecomers await the same Promise); askApproval is called once;
 *   - concurrent different hosts → independent calls, no merging;
 *   - askApproval absent → any first-seen host is denied directly
 *     (fail-closed);
 *   - askApproval throws → denied directly (fail-closed), with no leftover
 *     in-flight entry blocking later requests;
 *   - observable state: allowedThisSession / deniedThisSession contain
 *     decided entries (not while pending; entries join the sets only once
 *     the pending decision resolves).
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
    // both concurrent calls pending → askApproval invoked only once
    expect(askApproval).toHaveBeenCalledTimes(1);
    // resolve
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
    const gate = createEgressApprovalGate({}); // no askApproval
    const r = await gate.askIfUnknown("github.com");
    expect(r).toBe(false);
    expect(gate.deniedThisSession()).toContain("github.com");
    // a repeat call denies the same way (deniedThisSession hit), attempting no ask
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
    // a second call (concurrent or sequential) never retries askApproval, it denies directly
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
    // while pending: in neither allowed nor denied (the decision is undecided)
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
    // second call uses lowercase — should hit the allowed set directly, no re-ask
    const r = await gate.askIfUnknown("example.com");
    expect(r).toBe(true);
    expect(askApproval).toHaveBeenCalledTimes(1);
  });
});
