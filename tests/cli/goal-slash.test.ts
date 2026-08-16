/**
 * #458 T6: /goal 三面解析单测（status / clear / <text> pin）。
 *
 * - status → { type: "goal", action: "status" }（空 args / ["status"]）
 * - clear → { type: "goal", action: "clear" }
 * - 其它 → { type: "goal", action: "pin", text: <join+trim> }
 * - 大小写敏感（CLEAR ≠ clear → pin）
 *
 * mirrors worktree-408-not-yet-specified-impl/tests/cli/goal-slash.test.ts，
 * 但裁剪掉 T6-only 弃用形态（goal_status / goal_clear 独立 effect 不落地，
 * 统一收口到 SlashEffect { type: "goal"; action: ... } 三态）。
 *
 * 覆盖五类边界（defensive-contract-validator）:
 *  - empty / negative / overflow / concurrent / exception
 */
import { describe, expect, test } from "vitest";
import {
  applySlashCommand,
  HELP_TEXT,
  type SlashEffect,
  type SlashContext,
} from "../../src/cli/slash.ts";
import { makeState } from "./_fixtures.ts";

function mockCtx(overrides: Partial<SlashContext> = {}): SlashContext {
  return {
    state: makeState(),
    ...overrides,
  };
}

function goalOf(
  opts: { command?: string; args?: string[]; ctx?: SlashContext } = {}
): SlashEffect {
  return applySlashCommand({
    command: opts.command ?? "goal",
    args: opts.args ?? [],
    ctx: opts.ctx ?? mockCtx(),
  });
}

describe("/goal 三面 (T6)", () => {
  // === status ===
  test("goal 空 args → { type: goal, action: status, text: '' }", () => {
    const eff = goalOf({ args: [] });
    expect(eff).toEqual({ type: "goal", action: "status", text: "" });
  });

  test("goal ['status'] → { type: goal, action: status, text: '' }", () => {
    const eff = goalOf({ args: ["status"] });
    expect(eff).toEqual({ type: "goal", action: "status", text: "" });
  });

  test("goal ['status', 'extra'] → 仍按 status 处理（多余 arg 忽略）", () => {
    const eff = goalOf({ args: ["status", "extra"] });
    expect(eff).toEqual({ type: "goal", action: "status", text: "" });
  });

  // === clear ===
  test("goal ['clear'] → { type: goal, action: clear, text: '' }", () => {
    const eff = goalOf({ args: ["clear"] });
    expect(eff).toEqual({ type: "goal", action: "clear", text: "" });
  });

  // === <text> pin ===
  test("goal ['refactor', 'auth'] → { type: goal, action: pin, text: 'refactor auth' }", () => {
    const eff = goalOf({ args: ["refactor", "auth"] });
    expect(eff).toEqual({ type: "goal", action: "pin", text: "refactor auth" });
  });

  // === 非法子命令 ===
  test("goal ['foo']（非 status/clear）→ 按 <text> pin 处理", () => {
    const eff = goalOf({ args: ["foo"] });
    expect(eff).toEqual({ type: "goal", action: "pin", text: "foo" });
  });

  // === 大小写 ===
  test("goal ['CLEAR']（大写）→ 不识别为命令，按 <text> pin 处理", () => {
    const eff = goalOf({ args: ["CLEAR"] });
    expect(eff).toEqual({ type: "goal", action: "pin", text: "CLEAR" });
  });

  // === HELP_TEXT ===
  test("HELP_TEXT 含 /goal status、/goal clear 与 <status|clear|text> 提示", () => {
    expect(HELP_TEXT).toMatch(/\/goal\s+status/);
    expect(HELP_TEXT).toMatch(/\/goal\s+clear/);
    expect(HELP_TEXT).toMatch(/<status\|clear\|text>/);
  });

  // === 五类边界 (defensive-contract-validator) ===
  test("empty: 空 args → status effect（合法态，host 端显示未设置 goal）", () => {
    const eff = goalOf({ args: [] });
    expect(eff).toEqual({ type: "goal", action: "status", text: "" });
  });

  test("negative: 非法子命令 bar → 按 <text> pin", () => {
    const eff = goalOf({ args: ["bar"] });
    expect(eff).toEqual({ type: "goal", action: "pin", text: "bar" });
  });

  test("concurrent: N 次 /goal status 不冲突（纯函数无副作用）", () => {
    for (let i = 0; i < 100; i++) {
      const eff = goalOf({ args: ["status"] });
      expect(eff).toEqual({ type: "goal", action: "status", text: "" });
    }
  });

  test("exception: 解析不抛（无 store / 无 conversationId 不挂）", () => {
    const ctx = mockCtx();
    expect(() => goalOf({ args: ["status"], ctx })).not.toThrow();
    expect(() => goalOf({ args: [], ctx })).not.toThrow();
  });

  test("overflow: <text> 超长 10k chars 不挂，action=pin 原样透传", () => {
    const longText = "x".repeat(10_000);
    const eff = goalOf({ args: [longText] });
    expect(eff).toEqual({ type: "goal", action: "pin", text: longText });
  });
});
