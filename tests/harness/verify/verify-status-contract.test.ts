/**
 * Offline half of the verify-status-contract golden set (spec SC12).
 *
 * Locks the three-value outcome surface — passed / not_run(insufficient) /
 * not_run(contradicted) / the failed family unchanged — end to end across
 * its four seams, with the independent witness strings in
 * verify-status-contract.fixtures.ts:
 *   1. loop terminal shape (real runVerifyLoop, stubbed runFn) → outcome +
 *      terminal record (named skip EXIT ∧ evidenceVerdict);
 *   2. projectVerifyHumanView → the locked wire view (never a hidden
 *      undefined for the skip shapes, never a passed lie);
 *   3. verifyFromWire → round-trip of honest views + the both-directions
 *      discriminator validation (malformed table);
 *   4. presentation — TUI banner (projectVerifyBanner) and CLI
 *      (formatVerifyReport / formatChatVerifyReport) render the locked copy,
 *      the two not_run strings stay distinct, and the color roles hold
 *      (not_run amber, not green, not red).
 *
 * This is NOT the real-model half — the roster rule requires
 * real-llm/verify-status-contract.test.ts run via `npm run test:real-llm`;
 * a green here alone never makes the set green.
 */
import { describe, it, expect } from "vitest";
import {
  runVerifyLoop,
  type RunClassifierFn,
  type RunOutcome,
  type VerifyLoopOptions,
} from "../../../src/harness/verify/verify-loop.js";
import {
  REASON_HITL_SKIP_COMPLETION_JUDGE,
  type EvidenceVerdict,
} from "../../../src/harness/verify/types.js";
import {
  buildNotRunEnvelope,
  isVerifyInjectedText,
  NOT_RUN_FIXED_INSTRUCTION,
  NOT_RUN_PREFIX,
} from "../../../src/harness/verify/inject.js";
import { projectVerifyHumanView } from "../../../src/session-api/verify-human-view.js";
import {
  projectVerifyBanner,
  verifyFromWire,
  type VerifySlot,
} from "../../../src/tui/verify-banner.js";
import {
  formatChatVerifyReport,
  formatVerifyReport,
} from "../../../src/cli/format.js";
import { tuiPalette } from "../../../src/tui/theme.js";
import type { LoopTrace } from "../../../src/harness/loop-trace.js";
import type { RunResult } from "../../../src/harness/model-adapter/types.js";
import {
  CLI_NOT_JUDGED_SUFFIX,
  DIRECT_PROJECTION_CASES,
  FAILED_PRESENTATION,
  LOCKED_HITL_SKIP_REASON,
  MALFORMED_WIRE_CASES,
  NOT_RUN_ENVELOPE_MEANING,
  NOT_RUN_ENVELOPE_NO_COMMAND,
  NOT_RUN_ENVELOPE_PREFIX,
  NOT_RUN_LABELS_MUST_DIFFER,
  PASSED_PRESENTATION,
  TRAJECTORY_CASES,
  UNSTABLE_PRESENTATION,
  expectedBannerText,
  expectedCliLine,
  type LockedPresentation,
  type TrajectoryCase,
} from "./verify-status-contract.fixtures.ts";

/* ------------------------ witness ↔ src constant binding ------------------------ */

// The fixtures deliberately do not import the src constants (independent
// witness). This binding test closes the loop: if src renames or re-spells
// the reason / verdict vocabulary, the witness tables above would otherwise
// describe a shape nothing produces.
it("witness literals are bound to the src vocabulary constants", () => {
  expect(LOCKED_HITL_SKIP_REASON).toBe(REASON_HITL_SKIP_COMPLETION_JUDGE);
});

// The injection prefix is model-visible copy, so it rides the same independent
// witness discipline: the fixture spells it, src owns it, and drift fails here.
it("witness injection prefix is bound to the src prefix constant", () => {
  expect(NOT_RUN_ENVELOPE_PREFIX).toBe(NOT_RUN_PREFIX);
});

/* ------------------------ loop seam helpers (stub runFn, real loop) ------------------------ */

const EMPTY_TRACE: LoopTrace = Object.freeze({
  turns: Object.freeze([]),
  totals: Object.freeze({
    totalDurationMs: 0,
    cancelKindCounts: Object.freeze({
      none: 0,
      callerAbort: 0,
      timerTimeout: 0,
      hostCancel: 0,
    }),
    toolErrorTotals: Object.freeze({
      ok: 0,
      validation_failed: 0,
      tool_not_found: 0,
      execution_failed: 0,
    }),
  }),
});

function completedOutcome(c: TrajectoryCase): RunOutcome {
  const finalText = "implemented";
  return {
    result: {
      finalText,
      messages: c.messages.map((m) => ({
        role: m.role,
        content: [...m.content],
      })),
      turnCount: 1,
      stopReason: "completed" as RunResult["stopReason"],
      lastUsage: null,
    },
    trace: EMPTY_TRACE,
  };
}

/** HITL classifier-loop options (command empty → classifier branch; the
 *  judge must never spawn under HITL, so the stub throws if called). */
function hitlOptions(c: TrajectoryCase): VerifyLoopOptions {
  const runFn: VerifyLoopOptions["runFn"] = async () => completedOutcome(c);
  const runClassifier: RunClassifierFn = async () => {
    throw new Error(
      `${c.id}: completion-facing judge must not spawn under HITL`
    );
  };
  return {
    runFn,
    userText: "task",
    config: { command: "" },
    sessionId: c.id,
    runClassifier,
    completionMode: "hitl",
    cwd: process.cwd(),
  };
}

function project(out: Awaited<ReturnType<typeof runVerifyLoop>>) {
  return projectVerifyHumanView({
    outcome: out.outcome,
    rounds: out.rounds,
    records: out.records,
  });
}

function wireOf(p: LockedPresentation, rounds: number) {
  return p.outcome === "not_run"
    ? { outcome: p.outcome, rounds, notRunReason: p.notRunReason }
    : { outcome: p.outcome, rounds };
}

/* ------------------------ 1 + 2: loop terminal shape → wire ------------------------ */

describe("offline half: loop seam → projection (trajectory cases)", () => {
  for (const c of TRAJECTORY_CASES) {
    it(`${c.id}: ${c.title}`, async () => {
      const out = await runVerifyLoop(hitlOptions(c));
      // Every trajectory case here ends in a completed turn with ≥ 1 round.
      expect(out.result.stopReason).toBe("completed");
      expect(c.terminal.allowedLoopOutcomes).toContain(out.outcome);
      const terminal = out.records[out.records.length - 1];
      expect(terminal).toBeDefined();
      expect(terminal?.reason).toBe(c.terminal.reason ?? undefined);
      if (c.terminal.evidenceVerdict === null) {
        expect(terminal?.evidenceVerdict).toBeUndefined();
        expect("evidenceVerdict" in (terminal ?? {})).toBe(false);
      } else {
        expect(terminal?.evidenceVerdict).toBe(
          c.terminal.evidenceVerdict as EvidenceVerdict
        );
      }
      const view = project(out);
      expect(view).toBeDefined();
      expect(view).toEqual(wireOf(c.wire, out.rounds));
      if (c.wire.outcome !== "not_run") {
        expect("notRunReason" in (view ?? {})).toBe(false);
      }
    });
  }
});

/* ------------------------ 2: direct projection-table shapes ------------------------ */

describe("offline half: projection seam (direct shapes, incl. legacy)", () => {
  for (const c of DIRECT_PROJECTION_CASES) {
    it(`${c.id}: ${c.title}`, () => {
      const view = projectVerifyHumanView({
        outcome: c.input.outcome,
        rounds: c.input.rounds,
        records: c.input.records.map((r) => ({
          reason: r.reason,
          evidenceVerdict: r.evidenceVerdict as EvidenceVerdict | undefined,
        })),
      });
      if (c.wire === null) {
        expect(view).toBeUndefined();
        return;
      }
      expect(view).toEqual(wireOf(c.wire, c.input.rounds));
      if (c.wireWithoutReason) {
        expect("notRunReason" in (view ?? {})).toBe(false);
      }
    });
  }
});

/* ------------------------ 3: wire round-trip + malformed table ------------------------ */

describe("offline half: verifyFromWire round-trip on every honest wire", () => {
  const honest: readonly LockedPresentation[] = [
    PASSED_PRESENTATION,
    FAILED_PRESENTATION,
    UNSTABLE_PRESENTATION,
    DIRECT_PROJECTION_CASES.find((c) => c.id === "vsc-direct-terminal-not-run")!
      .wire!,
    DIRECT_PROJECTION_CASES.find(
      (c) => c.id === "vsc-direct-terminal-not-run-no-record"
    )!.wire!,
  ];
  for (const p of honest) {
    it(`${p.outcome}${p.notRunReason ? `(${p.notRunReason})` : ""} round-trips as ok`, () => {
      const slot = verifyFromWire(wireOf(p, 2));
      expect(slot.kind).toBe("ok");
      expect((slot as { verify?: unknown }).verify).toEqual(wireOf(p, 2));
    });
  }
});

describe("offline half: verifyFromWire malformed-wire table", () => {
  for (const c of MALFORMED_WIRE_CASES) {
    it(`${c.id}: ${c.title}`, () => {
      const slot = verifyFromWire(c.raw);
      expect(slot.kind).toBe("unavailable");
      expect((slot as { reason?: { kind?: string } }).reason?.kind).toBe(
        "malformed_view"
      );
    });
  }
  it("absent verify stays kind none (silent, no fake hint)", () => {
    expect(verifyFromWire(undefined).kind).toBe("none");
  });
});

/* ------------------------ 4: presentation seams ------------------------ */

function bannerLine(slot: VerifySlot): string {
  const lines = projectVerifyBanner(slot, "interactive", 120);
  expect(lines.length).toBe(1);
  return lines[0]!.text;
}

describe("offline half: TUI banner renders the locked copy", () => {
  const all: readonly LockedPresentation[] = [
    ...TRAJECTORY_CASES.map((c) => c.wire),
    ...DIRECT_PROJECTION_CASES.filter((c) => c.wire !== null).map(
      (c) => c.wire!
    ),
  ];
  const seen = new Set<string>();
  for (const p of all) {
    const key = `${p.outcome}:${p.notRunReason ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    it(`${key} → 「${p.bannerLabel}」 one amber/green/red-correct line`, () => {
      const slot = verifyFromWire(wireOf(p, 3));
      expect(slot.kind).toBe("ok");
      const lines = projectVerifyBanner(slot, "interactive", 120);
      expect(lines.length).toBe(1);
      expect(lines[0]!.text).toBe(expectedBannerText(p, 3));
      // Auto mode carries the same terminal line with the [auto] prefix.
      expect(
        projectVerifyBanner(slot, "full_auto", 120)[0]!.text.startsWith(
          "[auto] "
        )
      ).toBe(true);
    });
  }

  it("the two not_run copies render distinctly (never collapsed)", () => {
    const [insufficient, contradicted] = NOT_RUN_LABELS_MUST_DIFFER;
    expect(insufficient).not.toBe(contradicted);
    const slotA = verifyFromWire({
      outcome: "not_run",
      rounds: 1,
      notRunReason: "insufficient",
    });
    const slotB = verifyFromWire({
      outcome: "not_run",
      rounds: 1,
      notRunReason: "contradicted",
    });
    expect(bannerLine(slotA)).toBe("⚠ 未验证（证据不足）（1 轮）");
    expect(bannerLine(slotB)).toBe("⚠ 未验证（证据冲突）（1 轮）");
    expect(bannerLine(slotA)).not.toBe(bannerLine(slotB));
    // And neither ever reads as a pass.
    expect(bannerLine(slotA)).not.toContain(PASSED_PRESENTATION.bannerLabel);
  });

  it("not_run color role: amber (unstable anchor), not passed green, not failed red", () => {
    const slot = verifyFromWire({
      outcome: "not_run",
      rounds: 1,
      notRunReason: "insufficient",
    });
    const fg = projectVerifyBanner(slot, "interactive", 120)[0]!.fg;
    expect(fg).toBe(tuiPalette.running);
    expect(fg).not.toBe(tuiPalette.add);
    expect(fg).not.toBe(tuiPalette.error);
    // passed stays green, failed stays red (family unchanged).
    expect(
      projectVerifyBanner(
        verifyFromWire({ outcome: "passed", rounds: 1 }),
        "interactive",
        120
      )[0]!.fg
    ).toBe(tuiPalette.add);
    expect(
      projectVerifyBanner(
        verifyFromWire({ outcome: "failed", rounds: 1 }),
        "interactive",
        120
      )[0]!.fg
    ).toBe(tuiPalette.error);
  });
});

describe("offline half: CLI report renders the locked copy", () => {
  const cases: readonly [LockedPresentation, boolean][] = [
    [PASSED_PRESENTATION, false],
    [FAILED_PRESENTATION, true],
    [UNSTABLE_PRESENTATION, true],
    [
      DIRECT_PROJECTION_CASES.find((c) => c.id === "vsc-direct-escalated")!
        .wire!,
      true,
    ],
    [
      DIRECT_PROJECTION_CASES.find(
        (c) => c.id === "vsc-direct-terminal-not-run"
      )!.wire!,
      true,
    ],
    [
      DIRECT_PROJECTION_CASES.find(
        (c) => c.id === "vsc-direct-terminal-not-run-no-record"
      )!.wire!,
      true,
    ],
  ];
  for (const [p, chatVisible] of cases) {
    it(`${p.outcome}${p.notRunReason ? `(${p.notRunReason})` : ""} → 「${p.cliLabel}」`, () => {
      const view = wireOf(p, 2) as Parameters<typeof formatVerifyReport>[0];
      expect(formatVerifyReport(view)).toBe(expectedCliLine(p, 2));
      const chat = formatChatVerifyReport(view);
      if (chatVisible) {
        expect(chat).toBe(expectedCliLine(p, 2));
      } else {
        expect(chat).toBeUndefined();
      }
    });
  }

  it("the two not_run CLI labels differ and carry no failed-family suffix", () => {
    const a = formatVerifyReport({
      outcome: "not_run",
      rounds: 1,
      notRunReason: "insufficient",
    });
    const b = formatVerifyReport({
      outcome: "not_run",
      rounds: 1,
      notRunReason: "contradicted",
    });
    expect(a).not.toBe(b);
    expect(a).toContain("未验证（证据不足）");
    expect(b).toContain("未验证（证据冲突）");
    expect(a).not.toContain(CLI_NOT_JUDGED_SUFFIX);
    expect(b).not.toContain(CLI_NOT_JUDGED_SUFFIX);
    // not_run IS chat-visible (the not-verified case must surface).
    expect(
      formatChatVerifyReport({
        outcome: "not_run",
        rounds: 1,
        notRunReason: "insufficient",
      })
    ).toContain("未验证");
  });
});

/* ------------------------ 5: model-facing injection seam ------------------------ */

// The spec locks THAT the not-run case is returned to the model and the success
// case is not, and leaves the shape open. This half locks the shape:
//   - a dedicated envelope, not an extension of the evidence-rerun one (the
//     rerun envelope's obligation is "re-run this exact command"; a terminal
//     not_run has no command and must not imply a plain retry is enough);
//   - the honest meaning (not verified — neither passed nor failed);
//   - the success path injects nothing.
//
// Delivery-seam coverage (the model actually reading it, plus the
// round-2/non-trigger negatives) lives in tests/harness/verify/verify-loop
// .test.ts, which owns the loop-level seams.

describe("offline half: model-facing not_run injection", () => {
  it("信封前缀与固定结尾按锁定文案渲染 (attempt=N/M + 固定指令收尾)", () => {
    const env = buildNotRunEnvelope({ round: 2, maxRounds: 12 });
    expect(env.startsWith(`${NOT_RUN_PREFIX} attempt=2/12`)).toBe(true);
    expect(env.endsWith(`${NOT_RUN_FIXED_INSTRUCTION}\n`)).toBe(true);
    // The honest meaning, verbatim from the witness.
    for (const line of NOT_RUN_ENVELOPE_MEANING) {
      expect(env).toContain(line);
    }
  });

  it("固定指令独立于另两个信封 (不是 fix-the-failure, 也不是 re-run-this-command)", () => {
    // Neither sibling's obligation may leak in: nothing failed (so not
    // VALIDATION_FIXED_INSTRUCTION), and no command is named here (so not
    // EVIDENCE_RERUN_FIXED_INSTRUCTION).
    expect(NOT_RUN_FIXED_INSTRUCTION).not.toBe(
      "Fix the failures above. Do not claim completion until validation passes."
    );
    expect(NOT_RUN_FIXED_INSTRUCTION).not.toContain("Run the command and show");
    expect(NOT_RUN_FIXED_INSTRUCTION).not.toContain("Fix the failures above.");
    // It names the honest state, not a verdict the model cannot make.
    expect(NOT_RUN_FIXED_INSTRUCTION).toContain("not verified");
  });

  it("配置了 command 时逐字嵌入命令; 未配置时不编造命令", () => {
    const withCommand = buildNotRunEnvelope({
      round: 1,
      maxRounds: 12,
      command: "npm test",
    });
    expect(withCommand).toContain("\n  npm test");
    expect(withCommand).not.toContain(NOT_RUN_ENVELOPE_NO_COMMAND);

    // The classifier branch reaches not_run with an empty command; naming an
    // unrunnable command there would be a second, subtler lie.
    const noCommand = buildNotRunEnvelope({ round: 1, maxRounds: 12 });
    expect(noCommand).toContain(NOT_RUN_ENVELOPE_NO_COMMAND);
    expect(noCommand).not.toContain("\n  npm test");
    // Whitespace-only command is the same shape as absent (Postel).
    const blank = buildNotRunEnvelope({
      round: 1,
      maxRounds: 12,
      command: "   ",
    });
    expect(blank).toEqual(noCommand);
  });

  it("文案被识别为注入信封, 且不误伤普通用户提问", () => {
    expect(
      isVerifyInjectedText(buildNotRunEnvelope({ round: 1, maxRounds: 12 }))
    ).toBe(true);
    expect(isVerifyInjectedText("帮我跑一下测试")).toBe(false);
    // Distinct from the two sibling prefixes — the whole reason this is a
    // dedicated envelope rather than a rerun-envelope variant.
    expect(buildNotRunEnvelope({ round: 1, maxRounds: 12 })).not.toContain(
      "[VERIFY: rerun needed]"
    );
    expect(buildNotRunEnvelope({ round: 1, maxRounds: 12 })).not.toContain(
      "[VALIDATION FAILED]"
    );
  });

  it("not_run 终态经真实 loop 注入恰好一条; passed 终态零注入", async () => {
    // Drive the real loop for both terminals off the existing fixtures.
    const notRunCase = TRAJECTORY_CASES.find(
      (c) => c.id === "vsc-notrun-insufficient-01"
    )!;
    const notRunOut = await runVerifyLoop(hitlOptions(notRunCase));
    expect(notRunOut.outcome).toBe("not_run");
    const injected = notRunOut.result.messages.filter(
      (m) =>
        m.role === "user" &&
        m.content.some(
          (b) => b.type === "text" && b.text.startsWith(NOT_RUN_PREFIX)
        )
    );
    expect(injected.length).toBe(1);
    // Host-injected stamp, so the outbound projection keeps the prefix.
    expect((injected[0] as { hostInjected?: boolean }).hostInjected).toBe(true);

    const passedCase = TRAJECTORY_CASES.find((c) => c.id === "vsc-pass-01")!;
    const passedOut = await runVerifyLoop(hitlOptions(passedCase));
    expect(passedOut.outcome).toBe("passed");
    // The success case is NOT returned to the model — the model already knows
    // its own command exited 0.
    expect(
      passedOut.result.messages.some(
        (m) =>
          m.role === "user" &&
          m.content.some(
            (b) => b.type === "text" && b.text.startsWith(NOT_RUN_PREFIX)
          )
      )
    ).toBe(false);
  });
});
