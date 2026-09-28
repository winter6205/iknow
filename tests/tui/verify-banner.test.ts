/**
 * tests/tui/verify-banner.test.ts
 *
 * TUI verify final-state human-readable banner:
 *
 *  - both HITL and auto modes show the passed / failed / unstable / escalated
 *    final states;
 *  - verify missing → silent (0 lines, component renders null, no fake hint);
 *  - illegal wire shape (runtime boundary) → degraded `验证结果不可用`
 *    ("verification result unavailable") + typed-error detail rendering
 *    (code-quality.md typed-error rendering contract: recognize `kind`,
 *    `${kind}: ${conversation_id}`, err.message fallback forbidden);
 *  - row accounting wired into chromeReserveRows.verifyRows (baseline 7 unchanged);
 *  - bridge postMessage passes the verify DTO through on TuiPostResult (bwrap-guarded);
 *  - app.tsx wiring guard (grep): import + chromeReserveRows call passes verifyRows.
 *
 * Note: the full-TUI real mount (end-to-end rendering) is deferred to a later
 * task (the verifyConfig + bwrap + OpenTUI testRender chain is already heavy);
 * this suite pins the four contracts: projection + row accounting + bridge
 * passthrough + wiring source guard.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { VerifyAnswerView } from "../../src/session-api/contract.js";
import { projectVerifyHumanView } from "../../src/session-api/verify-human-view.js";
import {
  describeVerifyErrorDetail,
  projectVerifyBanner,
  verifyFromWire,
  type VerifySlot,
} from "../../src/tui/verify-banner.js";
import { chromeReserveRows } from "../../src/tui/app.js";
import { tuiPalette } from "../../src/tui/theme.js";
import { visualWidth } from "../../src/tui/tool-summary.js";
import {
  createInflightRegistry,
  createTuiBridge,
} from "../../src/tui/hub-bridge.js";
import { assistantResult, makeDeps } from "../cli/_fixtures.ts";

/** bwrap availability guard (no bwrap → e2e case skips, same discipline as hub-verify.test.ts). */
function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

// =============================================================================
// Projection matrix: HITL × 4 final states
// =============================================================================
describe("projectVerifyBanner — HITL 模式 × 4 终态文案 + glyph + 颜色", () => {
  test("passed → 「✓ 验证通过（N 轮）」fg=palette.add", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "passed", rounds: 2 } },
      "hitl",
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("✓ 验证通过（2 轮）");
    expect(lines[0]!.fg).toBe(tuiPalette.add);
  });

  test("failed → 「✗ 验证未通过（N 轮）」fg=palette.error", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "failed", rounds: 3 } },
      "hitl",
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("✗ 验证未通过（3 轮）");
    expect(lines[0]!.fg).toBe(tuiPalette.error);
  });

  test("unstable → 含 ⚠ / 验证不稳定 / N 轮,fg=palette.running", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "unstable", rounds: 4 } },
      "hitl",
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("⚠");
    expect(lines[0]!.text).toContain("验证不稳定");
    expect(lines[0]!.text).toContain("4 轮");
    expect(lines[0]!.fg).toBe(tuiPalette.running);
  });

  test("escalated → 含 ⤴ / 验证耗尽 / N 轮,fg=palette.error", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "escalated", rounds: 5 } },
      "hitl",
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toContain("⤴");
    expect(lines[0]!.text).toContain("验证耗尽");
    expect(lines[0]!.text).toContain("5 轮");
    expect(lines[0]!.fg).toBe(tuiPalette.error);
  });

  test("exhaustiveness:slot.ok 投影覆盖全部 4 outcome(穷尽)", () => {
    const outcomes: ReadonlyArray<VerifyAnswerView["outcome"]> = [
      "passed",
      "failed",
      "unstable",
      "escalated",
    ];
    for (const o of outcomes) {
      expect(
        projectVerifyBanner(
          { kind: "ok", verify: { outcome: o, rounds: 1 } },
          "hitl",
          80
        ).length
      ).toBe(1);
    }
  });
});

// =============================================================================
// Projection: auto mode visual marker ("[auto] " prefix, wording unchanged)
// =============================================================================
describe("projectVerifyBanner — auto 模式视觉标记", () => {
  test("passed + auto → 「[auto] 」前缀 + 验证通过", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "passed", rounds: 1 } },
      "auto",
      80
    );
    expect(lines[0]!.text).toBe("[auto] ✓ 验证通过（1 轮）");
  });

  test("failed + auto → 「[auto] 」前缀 + 验证未通过", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "failed", rounds: 1 } },
      "auto",
      80
    );
    expect(lines[0]!.text).toBe("[auto] ✗ 验证未通过（1 轮）");
  });

  test("degraded + auto 同样加 [auto] 前缀(标记与 hitl/auto 无差)", () => {
    const lines = projectVerifyBanner(
      {
        kind: "unavailable",
        reason: { kind: "malformed_view" },
      },
      "auto",
      80
    );
    expect(lines[0]!.text).toBe("[auto] ⚠ 验证结果不可用（malformed_view）");
  });

  test("HITL 不含 [auto] 前缀", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "passed", rounds: 1 } },
      "hitl",
      80
    );
    expect(lines[0]!.text).not.toMatch(/^\[auto\]/);
  });
});

// =============================================================================
// Legal state: verify missing → silent (0 lines, not rendered)
// =============================================================================
describe("projectVerifyBanner — 缺 verify 静默合法态", () => {
  test('slot.kind === "none" → 0 行', () => {
    const slot: VerifySlot = { kind: "none" };
    expect(projectVerifyBanner(slot, "hitl", 80)).toEqual([]);
    expect(projectVerifyBanner(slot, "auto", 80)).toEqual([]);
  });
});

// =============================================================================
// Projection failure → degraded `验证结果不可用` ("verification result unavailable"; typed-error rendering contract)
// =============================================================================
describe("projectVerifyBanner — 投影失败 degraded (typed-error 契约)", () => {
  test("kind + conversation_id → 「⚠ 验证结果不可用（kind: conv_id）」", () => {
    const lines = projectVerifyBanner(
      {
        kind: "unavailable",
        reason: { kind: "malformed_view", conversation_id: "abc-123" },
      },
      "hitl",
      80
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("⚠ 验证结果不可用（malformed_view: abc-123）");
    expect(lines[0]!.fg).toBe(tuiPalette.error);
  });

  test("仅有 kind,缺 conversation_id → 不伪造 conv_id", () => {
    const lines = projectVerifyBanner(
      { kind: "unavailable", reason: { kind: "session_not_found" } },
      "hitl",
      80
    );
    expect(lines[0]!.text).toBe("⚠ 验证结果不可用（session_not_found）");
  });
});

// =============================================================================
// Truncation: cols visual width never overflows
// =============================================================================
describe("projectVerifyBanner — 视觉宽度截断", () => {
  test("cols=10 极窄 → 文本宽度 ≤ cols(CJK-safe)", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "failed", rounds: 99 } },
      "hitl",
      10
    );
    expect(lines).toHaveLength(1);
    expect(visualWidth(lines[0]!.text)).toBeLessThanOrEqual(10);
  });

  test("cols=3 → 仍 1 行(截断到列宽),不抛", () => {
    const lines = projectVerifyBanner(
      { kind: "ok", verify: { outcome: "passed", rounds: 1 } },
      "hitl",
      3
    );
    expect(lines).toHaveLength(1);
    expect(visualWidth(lines[0]!.text)).toBeLessThanOrEqual(3);
  });
});

// =============================================================================
// Wire validation entry (runtime boundary): verifyFromWire
// =============================================================================
describe("verifyFromWire — wire 形状 runtime 校验", () => {
  test("undefined / null → none(合法态,字节缺席)", () => {
    expect(verifyFromWire(undefined)).toEqual({ kind: "none" });
    expect(verifyFromWire(null)).toEqual({ kind: "none" });
  });

  test("合法 shape → ok(原值透传)", () => {
    const v: VerifyAnswerView = { outcome: "passed", rounds: 1 };
    expect(verifyFromWire(v)).toEqual({ kind: "ok", verify: v });
  });

  test("合法 4 outcome 全分支(projection chain)", () => {
    const outcomes: ReadonlyArray<VerifyAnswerView["outcome"]> = [
      "passed",
      "failed",
      "unstable",
      "escalated",
    ];
    for (const o of outcomes) {
      expect(verifyFromWire({ outcome: o, rounds: 0 })).toEqual({
        kind: "ok",
        verify: { outcome: o, rounds: 0 },
      });
    }
  });

  test("not_run + 合法 notRunReason → ok(判别字段透传,字节仅 not_run 携带)", () => {
    expect(
      verifyFromWire({
        outcome: "not_run",
        rounds: 2,
        notRunReason: "insufficient",
      })
    ).toEqual({
      kind: "ok",
      verify: { outcome: "not_run", rounds: 2, notRunReason: "insufficient" },
    });
    expect(
      verifyFromWire({
        outcome: "not_run",
        rounds: 1,
        notRunReason: "contradicted",
      })
    ).toEqual({
      kind: "ok",
      verify: { outcome: "not_run", rounds: 1, notRunReason: "contradicted" },
    });
  });

  test("not_run 缺 notRunReason → unavailable(malformed_view)", () => {
    expect(verifyFromWire({ outcome: "not_run", rounds: 1 })).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
  });

  test("not_run + 未知 notRunReason → unavailable(malformed_view)", () => {
    expect(
      verifyFromWire({ outcome: "not_run", rounds: 1, notRunReason: "garbage" })
    ).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
  });

  test("非 not_run 却带 notRunReason → unavailable(双向耦合)", () => {
    expect(
      verifyFromWire({
        outcome: "passed",
        rounds: 1,
        notRunReason: "insufficient",
      })
    ).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
    expect(
      verifyFromWire({
        outcome: "failed",
        rounds: 1,
        notRunReason: "contradicted",
      })
    ).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
  });

  test("unknown outcome → unavailable(malformed_view)", () => {
    expect(verifyFromWire({ outcome: "bogus", rounds: 1 })).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
  });

  test("rounds 非有限数 / 负数 / 缺失 → unavailable", () => {
    expect(verifyFromWire({ outcome: "passed", rounds: -1 })).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
    expect(verifyFromWire({ outcome: "passed", rounds: Number.NaN })).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
    expect(
      verifyFromWire({ outcome: "passed", rounds: Number.POSITIVE_INFINITY })
    ).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
    expect(verifyFromWire({ outcome: "passed" })).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
  });

  test("非对象(string/number/boolean) → unavailable", () => {
    expect(verifyFromWire("string-garbage")).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
    expect(verifyFromWire(42)).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
    expect(verifyFromWire(true)).toEqual({
      kind: "unavailable",
      reason: { kind: "malformed_view" },
    });
  });
});

// =============================================================================
// typed-error rendering contract (code-quality.md): describeVerifyErrorDetail
// =============================================================================
describe("describeVerifyErrorDetail — typed-error 渲染契约 (code-quality.md)", () => {
  test("kind + conversation_id → 「kind: conv_id」", () => {
    expect(
      describeVerifyErrorDetail({
        kind: "store_error",
        conversation_id: "conv-abc",
      })
    ).toBe("store_error: conv-abc");
  });

  test("仅有 kind,缺 conversation_id → 不伪造,仅返回 kind", () => {
    expect(describeVerifyErrorDetail({ kind: "store_error" })).toBe(
      "store_error"
    );
  });

  test("非对象 / 非异常对象 → null(上层安全降级,无详情)", () => {
    expect(describeVerifyErrorDetail(null)).toBeNull();
    expect(describeVerifyErrorDetail(undefined)).toBeNull();
    expect(describeVerifyErrorDetail("error string")).toBeNull();
    expect(describeVerifyErrorDetail(42)).toBeNull();
    expect(describeVerifyErrorDetail({})).toBeNull();
  });

  test("kind 非字符串 → null", () => {
    expect(describeVerifyErrorDetail({ kind: 42 })).toBeNull();
    expect(describeVerifyErrorDetail({ kind: null })).toBeNull();
  });

  test("plain Error → null(契约禁止 err.message 回退)", () => {
    // Must recognize the kind field → no kind → treated as plain error → null.
    // Upper layers must not render via err.message / String(err) (code-quality contract).
    expect(describeVerifyErrorDetail(new Error("secret stack"))).toBeNull();
  });
});

// =============================================================================
// chromeReserveRows row accounting (baseline 7 unchanged + verifyRows=1 → +1)
// =============================================================================
describe("chromeReserveRows — verifyRows 行账联动", () => {
  const base = {
    noticeRows: 0,
    inputHintRows: 0,
    bgLine: false,
    inputRows: 1,
  } as const;

  test("verifyRows 缺省 / undefined / 0 → baseline 7 不变", () => {
    expect(chromeReserveRows(base)).toBe(7);
    expect(chromeReserveRows({ ...base, verifyRows: undefined })).toBe(7);
    expect(chromeReserveRows({ ...base, verifyRows: 0 })).toBe(7);
  });

  test("verifyRows=1 → 预算 +1(8 行)", () => {
    expect(chromeReserveRows({ ...base, verifyRows: 1 })).toBe(8);
  });

  test("verifyRows 与其它 chrome 项正交叠加", () => {
    const stacked = chromeReserveRows({
      ...base,
      noticeRows: 2,
      bgLine: true,
      panelRows: 4,
      verifyRows: 1,
    });
    // baseline 7 + notice(2+1) + bg(1) + panel(4) + verify(1)
    expect(stacked).toBe(7 + 3 + 1 + 4 + 1);
  });
});

// =============================================================================
// End-to-end: createTuiBridge.postMessage passes the verify DTO through
// (the upstream change hooked "passed" onto the wire; the bridge must carry
// it onto TuiPostResult)
//
// Timing discipline (same as tests/session-api/hub-verify.test.ts): process.chdir
// / tmpdir setup-teardown must live in beforeAll / afterAll — running chdir
// during describe collection executes before the tests and gets restored in
// finally, so the closed-loop sandbox cwd lands in the wrong directory.
// =============================================================================
describe("端到端:createTuiBridge.postMessage 透传 verify DTO", () => {
  let dataDir: string;
  let workDir: string;
  let passScript: string;
  let marker: string;
  let prevCwd = "";

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "iknow-verify-bridge-data-"));
    workDir = mkdtempSync(join(tmpdir(), "iknow-verify-bridge-work-"));
    // The script + marker must live inside dataDir (= bridge workspaceRoot =
    // verify sandbox cwd): after the fence's `--tmpfs /tmp` only cwd/home are
    // re-bound, sibling tmp dirs are invisible inside the sandbox, and a script
    // in workDir would ENOENT-converge to exit 127 → failed.
    marker = join(dataDir, "verify-ran.marker");
    passScript = join(dataDir, "verify-pass.sh");
    writeFileSync(passScript, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, {
      mode: 0o755,
    });
    // Closed-loop sandbox cwd = process.cwd() → switch to an isolated working dir (don't touch the real workspace).
    prevCwd = process.cwd();
    process.chdir(workDir);
  });

  afterAll(() => {
    process.chdir(prevCwd);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  test("verifyConfig 缺席 → TuiPostResult.verify 字段缺席 (SC7)", async () => {
    const bridge = createTuiBridge({
      dataDir,
      workspaceRoot: dataDir,
      deps: makeDeps([assistantResult({ texts: ["ok"] })]),
      inflight: createInflightRegistry(),
    });
    const id = await bridge.ensureSession(undefined);
    const res = await bridge.postMessage({
      conversationId: id,
      text: "hi",
    });
    expect(res.verify).toBeUndefined();
  });

  (hasBwrap() ? test : test.skip)(
    "verifyConfig 配置 + 验证 exit 0 → TuiPostResult.verify === {outcome:'passed', rounds:1}",
    async () => {
      rmSync(marker, { force: true });
      // The upstream content gate (spec SC6) closes on a text-only turn, so
      // the passthrough case must carry a real gate signal: a bash test
      // command tool_use (tool unregistered here → tool_not_found, but the
      // transcript proves a test attempt). The turn then runs the REAL
      // verify path — command round exits 0 → the DTO carries the passed view.
      const gate = assistantResult({
        texts: ["running the suite"],
        toolCalls: [
          { id: "gv1", name: "bash", input: { command: "npm test" } },
        ],
      });
      const bridge = createTuiBridge({
        dataDir,
        workspaceRoot: dataDir,
        deps: makeDeps([gate, assistantResult({ texts: ["fixed"] })]),
        inflight: createInflightRegistry(),
        verifyConfig: { command: passScript },
      });
      const id = await bridge.ensureSession(undefined);
      const res = await bridge.postMessage({
        conversationId: id,
        text: "fix it",
      });
      expect(res.verify).toEqual({ outcome: "passed", rounds: 1 });
      // Hard evidence the verify command really ran: the closed-loop sandbox executed the script.
      expect(existsSync(marker)).toBe(true);
    }
  );
});

// =============================================================================
// Wiring guard (grep): app.tsx must import verify-banner + book verifyRows
// =============================================================================
describe("接线守卫:app.tsx 接入 verify-banner", () => {
  const appPath = join(import.meta.dir, "..", "..", "src", "tui", "app.tsx");

  test("app.tsx 从 ./verify-banner.js 导入投影 + 渲染壳", () => {
    const src = readFileSync(appPath, "utf8");
    expect(src).toMatch(/from\s+["']\.\/verify-banner\.js["']/);
  });

  test("app.tsx 在 chromeReserveRows 调用中传入 verifyRows", () => {
    const src = readFileSync(appPath, "utf8");
    // The literal `verifyRows:` key appears, proving it is booked into chromeReserveRows.
    expect(src).toMatch(/verifyRows\s*:/);
  });
});

// =============================================================================
// HITL chit-chat / no claimed completion → the human reads an honest not_run
// line (amber), never `验证通过`, never a hidden absence.
// =============================================================================
describe("projectVerifyHumanView + banner — HITL skip 投影 not_run (SC1-SC3)", () => {
  test("HITL skip + INSUFFICIENT → not_run + 「未验证（证据不足）」1 行 amber", () => {
    const view = projectVerifyHumanView({
      outcome: "passed",
      rounds: 1,
      records: [
        {
          reason: "hitl_skip_completion_judge",
          evidenceVerdict: "EVIDENCE_INSUFFICIENT",
        },
      ],
    });
    expect(view).toEqual({
      outcome: "not_run",
      rounds: 1,
      notRunReason: "insufficient",
    });
    const slot = verifyFromWire(view);
    expect(slot.kind).toBe("ok");
    const lines = projectVerifyBanner(slot, "hitl", 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("⚠ 未验证（证据不足）（1 轮）");
    expect(lines[0]!.fg).toBe(tuiPalette.running);
    expect(lines[0]!.text).not.toContain("验证通过");
  });

  test("HITL skip + CONTRADICTED → not_run + 「未验证（证据冲突）」1 行 amber", () => {
    const view = projectVerifyHumanView({
      outcome: "passed",
      rounds: 1,
      records: [
        {
          reason: "hitl_skip_completion_judge",
          evidenceVerdict: "EVIDENCE_CONTRADICTED",
        },
      ],
    });
    expect(view).toEqual({
      outcome: "not_run",
      rounds: 1,
      notRunReason: "contradicted",
    });
    const slot = verifyFromWire(view);
    expect(slot.kind).toBe("ok");
    const lines = projectVerifyBanner(slot, "hitl", 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("⚠ 未验证（证据冲突）（1 轮）");
    expect(lines[0]!.fg).toBe(tuiPalette.running);
    expect(lines[0]!.text).not.toContain("验证通过");
  });

  test("两个 not_run 变体渲染字符串互不相同(禁止坍缩为一条)", () => {
    const insufficient = projectVerifyBanner(
      {
        kind: "ok",
        verify: { outcome: "not_run", rounds: 1, notRunReason: "insufficient" },
      },
      "hitl",
      80
    );
    const contradicted = projectVerifyBanner(
      {
        kind: "ok",
        verify: { outcome: "not_run", rounds: 1, notRunReason: "contradicted" },
      },
      "hitl",
      80
    );
    expect(insufficient).toHaveLength(1);
    expect(contradicted).toHaveLength(1);
    expect(insufficient[0]!.text).not.toBe(contradicted[0]!.text);
  });

  test("loop 直出 not_run(outcome 词表)→ 同 legacy 形状渲染", () => {
    const view = projectVerifyHumanView({
      outcome: "not_run",
      rounds: 2,
      records: [
        {
          reason: "hitl_skip_completion_judge",
          evidenceVerdict: "EVIDENCE_INSUFFICIENT",
        },
      ],
    });
    expect(view).toEqual({
      outcome: "not_run",
      rounds: 2,
      notRunReason: "insufficient",
    });
    expect(verifyFromWire(view).kind).toBe("ok");
  });

  test("HITL SUFFICIENT 短路 passed → 仍显示验证通过", () => {
    const view = projectVerifyHumanView({
      outcome: "passed",
      rounds: 2,
      records: [{}],
    });
    const slot = verifyFromWire(view);
    const lines = projectVerifyBanner(slot, "hitl", 80);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("✓ 验证通过（2 轮）");
  });
});
