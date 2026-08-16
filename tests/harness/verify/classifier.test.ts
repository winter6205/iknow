/**
 * #128 verify 分类器 (子代理 LLM 判官) 纯函数模块单测。
 *
 * Spec: specs/128-verify-classifier.md §Code Style (ClassifierResult 三态联合)
 *      + §Boundaries (pass→abort 降级; schema 错→abort; 宿主侧截断)。
 *
 * 覆盖：解析合法三态 / pass 空 evidence 降级 / missing 仅 fail / schema 残缺→abort /
 *       非对象→abort / truncateClassifierOutput 2000 chars 边界（4-byte emoji 边界
 *       与 surrogate-pair 安全）。
 */
import { describe, it, expect } from "vitest";
import {
  parseClassifierResult,
  truncateClassifierOutput,
  type ClassifierResult,
} from "../../../src/harness/verify/classifier.ts";

const VALID_PASS: ClassifierResult = {
  kind: "pass",
  reason: "evidence shows build green",
  evidence: [{ command: "npm test", output: "10 passed", result: "pass" }],
};

const VALID_FAIL: ClassifierResult = {
  kind: "fail",
  reason: "missing deploy step",
  missing: ["deploy to staging"],
  evidence: [{ command: "npm test", output: "10 passed", result: "pass" }],
};

const VALID_ABORT: ClassifierResult = {
  kind: "abort",
  reason: "judge could not decide",
};

describe("parseClassifierResult — 合法三态解析 (#128 A4 schema)", () => {
  it("pass：含 reason + 非空 evidence", () => {
    const out = parseClassifierResult(JSON.stringify(VALID_PASS));
    expect(out).toEqual(VALID_PASS);
  });

  it("fail：含 reason + missing[] + evidence[]", () => {
    const out = parseClassifierResult(JSON.stringify(VALID_FAIL));
    expect(out).toEqual(VALID_FAIL);
  });

  it("abort：仅 reason（无 evidence / missing）", () => {
    const out = parseClassifierResult(JSON.stringify(VALID_ABORT));
    expect(out).toEqual(VALID_ABORT);
  });
});

describe("parseClassifierResult — 降级规则 (#128 A4 末尾 + SC4)", () => {
  it("pass + 空 evidence → 静默降级为 abort，reason 补'证据缺失'", () => {
    const raw = { kind: "pass", reason: "looks done", evidence: [] };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort");
    if (out.kind === "abort") {
      expect(out.reason).toContain("证据缺失");
    }
  });

  it("fail：missing 缺省 → 视为空数组", () => {
    const raw = { kind: "fail", reason: "stuff missing", evidence: [] };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort"); // fail 空 evidence 也视为 abort（与 pass 同一规则）
  });

  it("missing 仅在 fail 出现 → pass/missing 组合拒收（kind=abort）", () => {
    const raw = { kind: "pass", reason: "ok", missing: ["x"] };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort");
  });
});

describe("parseClassifierResult — schema 错 → transport/schema error envelope (#128 SC5)", () => {
  it("JSON 残缺 → abort，reason 标记 schema 错误", () => {
    const out = parseClassifierResult('{ kind: "pass", reason:');
    expect(out.kind).toBe("abort");
    if (out.kind === "abort") {
      expect(out.reason).toMatch(/schema|JSON|解析/i);
    }
  });

  it("kind 非字面量 → abort", () => {
    for (const bad of ["PASS", "ok", "false", "", null, 0, [], {}]) {
      const out = parseClassifierResult(
        JSON.stringify({ kind: bad, reason: "x" })
      );
      expect(out.kind).toBe("abort");
    }
  });

  it("顶层非对象（字符串 / 数字 / 数组 / null）→ abort", () => {
    for (const bad of ["string", 42, [1, 2], null]) {
      const out = parseClassifierResult(JSON.stringify(bad));
      expect(out.kind).toBe("abort");
    }
  });

  it("空对象 → abort", () => {
    const out = parseClassifierResult("{}");
    expect(out.kind).toBe("abort");
  });

  it("fail 但缺 reason → abort", () => {
    const raw = { kind: "fail", missing: ["x"], evidence: [] };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort");
  });

  it("pass 但缺 reason → abort", () => {
    const raw = { kind: "pass", evidence: [{ command: "x", result: "pass" }] };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort");
  });

  it("evidence 项缺 command/result → abort（子代理 prompt 显式禁止，宿主再防御）", () => {
    const raw = { kind: "pass", reason: "ok", evidence: [{ output: "x" }] };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort");
  });

  it("evidence.result 非 'pass'|'fail' → abort", () => {
    const raw = {
      kind: "pass",
      reason: "ok",
      evidence: [{ command: "x", result: "unknown" }],
    };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort");
  });

  it("missing 项非字符串 → abort", () => {
    const raw = {
      kind: "fail",
      reason: "x",
      missing: [1, 2, 3],
      evidence: [{ command: "x", result: "fail" }],
    };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out.kind).toBe("abort");
  });
});

describe("truncateClassifierOutput — 宿主侧 2000 chars 截断 (#128 A8 + SC8)", () => {
  it("短字符串原样返回", () => {
    expect(truncateClassifierOutput("hello")).toBe("hello");
  });

  it("空字符串原样返回", () => {
    expect(truncateClassifierOutput("")).toBe("");
  });

  it("恰好 2000 chars → 原样返回（边界）", () => {
    const s = "a".repeat(2000);
    expect(truncateClassifierOutput(s)).toBe(s);
  });

  it("2001 chars → 截到 2000 chars", () => {
    const s = "a".repeat(2001);
    expect(truncateClassifierOutput(s).length).toBe(2000);
  });

  it("中文字符按代码点计（CJK 不会切半）", () => {
    const s = "中".repeat(2500);
    const out = truncateClassifierOutput(s);
    expect([...out].length).toBe(2000);
    expect(out).toBe("中".repeat(2000));
  });

  it("4-byte emoji 不切 surrogate pair", () => {
    // U+1F600 (😀) 在 UTF-16 是 surrogate pair（2 code units）但 1 code point。
    const s = "😀".repeat(2500);
    const out = truncateClassifierOutput(s);
    expect([...out].length).toBe(2000);
    // 不应出现孤立 high surrogate
    for (let i = 0; i < out.length; i++) {
      const cp = out.codePointAt(i)!;
      if (cp >= 0xd800 && cp <= 0xdbff) {
        // high surrogate 必须有跟随 low surrogate
        const next = out.codePointAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i++; // 跳过 low surrogate
      }
    }
  });
});

/* ------------------------------ #449b B7: unverified 第 4 态 ------------------------------ */

describe("parseClassifierResult — unverified 第 4 态 (#449b B7 SC7)", () => {
  const VALID_UNVERIFIED: ClassifierResult = {
    kind: "unverified",
    reason: "evidence insufficient to decide PASS or FAIL",
  };

  it("合法 unverified: reason 非空 + evidence 缺省 → 原样返回", () => {
    const out = parseClassifierResult(JSON.stringify(VALID_UNVERIFIED));
    expect(out).toEqual(VALID_UNVERIFIED);
  });

  it("unverified 带 evidence 也接受 (evidence 可选, 不强制——判官读完证据仍不足)", () => {
    const raw = {
      kind: "unverified",
      reason: "ran one test but still unsure",
      evidence: [{ command: "npm test", output: "3 passed", result: "pass" }],
    };
    const out = parseClassifierResult(JSON.stringify(raw));
    expect(out).toEqual({ kind: "unverified", reason: raw.reason });
  });

  it("unverified 缺 reason → abort 降级 (reason 必填纪律对齐 pass/fail)", () => {
    const out = parseClassifierResult(JSON.stringify({ kind: "unverified" }));
    expect(out.kind).toBe("abort");
  });

  it("unverified reason 为空字符串 → abort 降级", () => {
    const out = parseClassifierResult(
      JSON.stringify({ kind: "unverified", reason: "" })
    );
    expect(out.kind).toBe("abort");
  });

  it("unverified 是独立态: 不与 abort 混淆 (reason 原样保留, 非降级文案)", () => {
    const out = parseClassifierResult(
      JSON.stringify({ kind: "unverified", reason: "cannot decide" })
    );
    expect(out).toEqual({ kind: "unverified", reason: "cannot decide" });
  });
});
