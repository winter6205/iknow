/**
 * tests/tui/verify-banner.test.ts
 *
 * T3 (#458 包2) — TUI verify 终态人读 banner:
 *
 *  - HITL + auto 双模式都显示 passed / failed / unstable / escalated 4 终态;
 *  - 缺 verify → 静默(0 行,组件 render null,无虚假提示);
 *  - wire 形状非法(runtime boundary)→ degraded「验证结果不可用」+ 渲染
 *    typed-error 详情(code-quality.md typed-error 渲染契约:识别 `kind`,
 *    `${kind}: ${conversation_id}`,禁用 err.message 回退);
 *  - 行账联动 chromeReserveRows.verifyRows(baseline 7 不变);
 *  - bridge postMessage 在 TuiPostResult 上透传 verify DTO(bwrap-guard);
 *  - app.tsx 接线守卫(grep):import + chromeReserveRows 调用传入 verifyRows。
 *
 * 注:全 TUI 真实 mount(端到端渲染)交给后续 plan 任务处理(verifyConfig +
 * bwrap + OpenTUI testRender 链路已较重);本套件钉住投影 + 行账 + bridge
 * 透传 + 接线 source 守卫四项 T3 契约。
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

/** bwrap 可用性守卫(无 bwrap → e2e 用例 skip,与 hub-verify.test.ts 同纪律)。 */
function hasBwrap(): boolean {
  return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
}

// =============================================================================
// 投影矩阵:HITL × 4 终态
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
// 投影:auto 模式视觉标记("[auto] " 前缀,文案照旧)
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
// 合法态:缺 verify → 静默(0 行,不渲染)
// =============================================================================
describe("projectVerifyBanner — 缺 verify 静默合法态", () => {
  test('slot.kind === "none" → 0 行', () => {
    const slot: VerifySlot = { kind: "none" };
    expect(projectVerifyBanner(slot, "hitl", 80)).toEqual([]);
    expect(projectVerifyBanner(slot, "auto", 80)).toEqual([]);
  });
});

// =============================================================================
// 投影失败 → degraded「验证结果不可用」(typed-error 渲染契约)
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
// 截断:cols 视觉宽度不外溢
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
// wire 校验入口(runtime boundary):verifyFromWire
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
// typed-error 渲染契约(code-quality.md):describeVerifyErrorDetail
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
    // 必须识别 kind 字段 → 没有 kind → 视为 plain error → null。
    // 上层不允许用 err.message / String(err) 渲染 (code-quality 契约)。
    expect(describeVerifyErrorDetail(new Error("secret stack"))).toBeNull();
  });
});

// =============================================================================
// chromeReserveRows 行账联动(baseline 7 不变 + verifyRows=1 +1)
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
// 端到端:createTuiBridge.postMessage 透传 verify DTO
// (T2 把"passed"挂上 wire;bridge 必须把它透到 TuiPostResult 上)
//
// 时序纪律(与 tests/session-api/hub-verify.test.ts 同款):process.chdir /
// tmpdir 建拆必须在 beforeAll / afterAll —— describe collection 阶段执行
// chdir 会先于 test 执行被 finally 还原,导致闭环沙箱 cwd 落错目录。
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
    // 脚本 + marker 必须落在 dataDir（= bridge workspaceRoot = verify 沙箱
    // cwd）内：fence `--tmpfs /tmp` 后只重绑 cwd/home，兄弟 tmp 目录在沙箱
    // 内不可见，脚本放 workDir 会被 ENOENT 收敛成 exit 127 → failed。
    marker = join(dataDir, "verify-ran.marker");
    passScript = join(dataDir, "verify-pass.sh");
    writeFileSync(passScript, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`, {
      mode: 0o755,
    });
    // 闭环沙箱 cwd = process.cwd() → 切到隔离工作目录 (不碰真实工作区)。
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
      const bridge = createTuiBridge({
        dataDir,
        workspaceRoot: dataDir,
        deps: makeDeps([assistantResult({ texts: ["fixed"] })]),
        inflight: createInflightRegistry(),
        verifyConfig: { command: passScript },
      });
      const id = await bridge.ensureSession(undefined);
      const res = await bridge.postMessage({
        conversationId: id,
        text: "fix it",
      });
      expect(res.verify).toEqual({ outcome: "passed", rounds: 1 });
      // 验证命令实跑铁证:闭环沙箱执行了脚本。
      expect(existsSync(marker)).toBe(true);
    }
  );
});

// =============================================================================
// 接线守卫(grep):app.tsx 必须 import verify-banner + 把 verifyRows 入账
// =============================================================================
describe("接线守卫:app.tsx 接入 verify-banner", () => {
  const appPath = join(import.meta.dir, "..", "..", "src", "tui", "app.tsx");

  test("app.tsx 从 ./verify-banner.js 导入投影 + 渲染壳", () => {
    const src = readFileSync(appPath, "utf8");
    expect(src).toMatch(/from\s+["']\.\/verify-banner\.js["']/);
  });

  test("app.tsx 在 chromeReserveRows 调用中传入 verifyRows", () => {
    const src = readFileSync(appPath, "utf8");
    // 字面量出现 verifyRows: 行键,证明已并在 chromeReserveRows 入账。
    expect(src).toMatch(/verifyRows\s*:/);
  });
});
