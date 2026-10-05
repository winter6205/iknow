// REAL_LLM: verify-status-contract golden set — real-model half (spec SC12).
//
// Locks the three-value verify outcome (passed / not_run(insufficient) /
// not_run(contradicted) / failed family) on REAL model trajectories, end to
// end through the seams the human actually reads: runVerifyLoop (real run,
// HITL, judge stub that must never spawn) → projectVerifyHumanView →
// verifyFromWire → projectVerifyBanner. The expected copy comes from the
// offline-half fixture file (tests/harness/verify/verify-status-contract
// .fixtures.ts) — the same independent witness both halves bind to, per the
// soul-usage / role-substitution precedent.
//
// Two arms, decided on the observed trajectory shape (hard requirements vs
// conditional ones, same discipline as real-llm/role-substitution-boundaries
// -real.test.ts: an absent shape prints a RESIDUAL, it never becomes a hidden
// pass and never fails by absence alone):
//   A insufficient: edit a source file, run nothing → when the turn completed
//     with no test-run evidence (the shape the prompt asks for), the wire is
//     EXACTLY not_run(insufficient) and the banner reads 「未验证（证据不足）」,
//     never 「验证通过」 and never a hidden absence.
//   B green-run: run the project's real `npx vitest run` to a genuine green
//     summary → when that shape was observed, the wire is passed with no
//     notRunReason key and the banner reads 「验证通过」.
// Shared hard invariant on both arms: projection never claims passed unless
// the evidence checker itself returns EVIDENCE_SUFFICIENT on the same real
// messages, and every projected view round-trips verifyFromWire as ok.
//
// The model-facing INJECTION is the third surface this set locks (the spec
// leaves its shape open; this set fixes it): a not_run terminal carries
// EXACTLY ONE [VERIFY: not verified] envelope, its copy is recognized as
// host-injected, and a passed terminal carries NONE. Both are asserted on
// real trajectories below, so the copy cannot drift silently with the model.
//
// No key → Not run (explicit, never a hidden pass). Tracked in
// TRACKED_INCLUDE of vitest.real-llm.config.ts; run via `npm run
// test:real-llm`. Offline green does not count as this half.
import { expect, describe, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildHarnessEngine } from "../src/harness/build-engine.ts";
import { run, type LoopEngineDeps } from "../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../src/harness/errors.ts";
import { createNoAskUser } from "../src/harness/permission/ask-user.ts";
import { deriveClaimIndex } from "../src/harness/last-nonempty-assistant.js";
import { checkEvidence } from "../src/harness/verify/evidence-checker.ts";
import { REASON_HITL_SKIP_COMPLETION_JUDGE } from "../src/harness/verify/types.ts";
import { isVerifyInjectedText } from "../src/harness/verify/inject.ts";
import {
  runVerifyLoop,
  type RunClassifierFn,
  type VerifyLoopOptions,
  type VerifyLoopResult,
} from "../src/harness/verify/verify-loop.ts";
import { projectVerifyHumanView } from "../src/session-api/verify-human-view.ts";
import {
  projectVerifyBanner,
  verifyFromWire,
} from "../src/tui/verify-banner.tsx";
import { type IknowEnv } from "../src/config/env.ts";
import { loadRealLlmEnv } from "./real-llm-env.ts";
import {
  NOT_RUN_CONTRADICTED_PRESENTATION,
  NOT_RUN_INSUFFICIENT_PRESENTATION,
  NOT_RUN_ENVELOPE_PREFIX,
  PASSED_PRESENTATION,
  expectedBannerText,
} from "../tests/harness/verify/verify-status-contract.fixtures.ts";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

// A throwing load must surface at collection, not masquerade as a skip.
const realEnv = loadRealLlmEnv(REPO_ROOT);
const HAS_KEY = realEnv !== undefined;
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

// Scratch workspace lives under the repo so npx resolves the checked-out
// vitest (no registry fetch, no network dependency); .evals/ is gitignored,
// so real model writes here can never dirty the shared checkout.
const SCRATCH_FILES: Readonly<Record<string, string>> = {
  "sample.ts": 'export const greeting = "hello";\n',
  "sample.test.ts": [
    'import { expect, test } from "vitest";',
    'import { greeting } from "./sample.ts";',
    'test("greeting is a string", () => {',
    '  expect(typeof greeting).toBe("string");',
    "});",
    "",
  ].join("\n"),
  "vitest.config.ts": [
    'import { defineConfig } from "vitest/config";',
    "export default defineConfig({});",
    "",
  ].join("\n"),
};

let scratchRoot = "";

const CASES = [
  {
    id: "vsc-real-insufficient-01",
    kind: "insufficient" as const,
    prompt:
      '把目录 <DIR> 里的 sample.ts 中的常量 greeting 从 "hello" 改成 ' +
      '"hi"。只用文件编辑工具完成这一处修改，绝对不要运行任何命令或测试。' +
      "改完直接报告完成即可。",
  },
  {
    // Second insufficient witness that does NOT depend on the gate's edit
    // signal: the turn carries a test-command signal by construction, so it
    // enters the verify subsystem on either vocabulary vintage, and a
    // no-match vitest run can never read green (no summary line → checker
    // INSUFFICIENT). This is the arm that locks not_run(insufficient) on a
    // real model trajectory end to end.
    id: "vsc-real-insufficient-02",
    kind: "insufficient" as const,
    prompt:
      "在 <DIR> 目录里真实运行这条命令：cd <DIR> && npx vitest run " +
      "suite-that-does-not-exist。把退出码和输出原样报告。不要修改任何文件。",
  },
  {
    id: "vsc-real-green-run-01",
    kind: "passed" as const,
    prompt:
      "在 <DIR> 目录里真实运行测试：cd <DIR> && npx vitest run。" +
      "把退出码和测试摘要行原样报告给我。不要修改任何文件。",
  },
];

(HAS_KEY ? describe : describe.skip)(
  "verify-status-contract — real-model three-value outcome",
  () => {
    beforeAll(async () => {
      const base = join(REPO_ROOT, ".evals", "real-llm");
      await mkdir(base, { recursive: true });
      scratchRoot = await mkdtemp(join(base, "verify-status-"));
    });

    afterAll(async () => {
      if (scratchRoot !== "")
        await rm(scratchRoot, { recursive: true, force: true });
    });

    for (const c of CASES) {
      it(
        `${c.id}: real turn projects honestly through wire + banner`,
        { timeout: 360_000 },
        async () => {
          if (!HAS_KEY) {
            console.log("[SKIP] LLM key not set; Not run");
            return;
          }
          const dir = join(scratchRoot, c.id);
          await mkdir(dir, { recursive: true });
          for (const [name, body] of Object.entries(SCRATCH_FILES)) {
            await writeFile(join(dir, name), body, "utf8");
          }

          const home = join(scratchRoot, `${c.id}-home`);
          await mkdir(home, { recursive: true });
          const built = await buildHarnessEngine({
            env: realEnv as IknowEnv,
            askUser: createNoAskUser(),
            surface: "chat",
            cwd: dir,
            userHome: home,
          });
          const deps: LoopEngineDeps = {
            ...built.deps,
            conversationId: c.id,
            maxTurns: 4,
          };
          const userText = c.prompt.replaceAll("<DIR>", dir);
          const runFn: VerifyLoopOptions["runFn"] = async (text, opts) =>
            await run(text, deps, opts?.signal, {
              priorMessages: opts?.priorMessages,
            });
          // HITL must never spawn the completion-facing judge — on any arm,
          // for any real trajectory. A spawn attempt is a hard failure.
          const runClassifier: RunClassifierFn = async () => {
            throw new Error(
              `${c.id}: completion-facing judge spawned under HITL`
            );
          };

          try {
            let out: VerifyLoopResult | undefined;
            try {
              out = await runVerifyLoop({
                runFn,
                userText,
                config: { command: "" },
                sessionId: c.id,
                runClassifier,
                completionMode: "hitl",
                cwd: dir,
              });
            } catch (err) {
              if (err instanceof MaxTurnsExceeded) {
                console.log(
                  `[${c.id}] RESIDUAL: MaxTurnsExceeded before a completed ` +
                    `claim — no verify terminal to judge; Not run for this arm`
                );
                return;
              }
              throw err;
            }
            if (out === undefined) {
              // Defensive: the catch above either returned or rethrew, so
              // this line is unreachable — a loud throw beats a silent skip.
              throw new Error(`${c.id}: no loop result after runVerifyLoop`);
            }

            const messages = out.result.messages;
            const report = checkEvidence({
              messages,
              claimIndex: deriveClaimIndex(messages),
            });
            const view = projectVerifyHumanView({
              outcome: out.outcome,
              rounds: out.rounds,
              records: out.records,
            });
            console.log(
              `[${c.id}] census: stop=${out.result.stopReason} ` +
                `loopOutcome=${out.outcome} rounds=${out.rounds} ` +
                `verdict=${report.verdict} runs=${report.runs.length} ` +
                `stale=${report.stale} wire=${JSON.stringify(view)}`
            );

            if (out.result.stopReason !== "completed") {
              console.log(
                `[${c.id}] RESIDUAL: turn did not end completed ` +
                  `(stop=${out.result.stopReason}) — no completion claim was ` +
                  `verified; the per-arm shapes below are not judged`
              );
            }

            // ---- shared hard invariants (every observed shape) ----
            if (view !== undefined) {
              const slot = verifyFromWire(view);
              expect(
                slot.kind,
                `${c.id}: honest projection must round-trip the wire boundary`
              ).toBe("ok");
              if (view.outcome === "passed") {
                expect(
                  report.verdict,
                  `${c.id}: passed may only ride real SUFFICIENT evidence`
                ).toBe("EVIDENCE_SUFFICIENT");
              }
              const lines = projectVerifyBanner(slot, "interactive", 160);
              expect(lines.length).toBe(1);
              if (view.outcome === "not_run") {
                const [insufficient, contradicted] = [
                  expectedBannerText(
                    NOT_RUN_INSUFFICIENT_PRESENTATION,
                    out.rounds
                  ),
                  expectedBannerText(
                    NOT_RUN_CONTRADICTED_PRESENTATION,
                    out.rounds
                  ),
                ];
                expect(
                  [insufficient, contradicted],
                  `${c.id}: not_run banner must render one of the two locked copies`
                ).toContain(lines[0]!.text);
                expect(lines[0]!.text).not.toContain(
                  PASSED_PRESENTATION.bannerLabel
                );
              }
            }

            // ---- model-facing injection (the spec's open shape, now locked) ----
            // Decided on the loop's OWN terminal outcome, not on a modelled
            // preference: not_run → exactly one honest not-verified envelope;
            // passed (and every other terminal) → none at all.
            const notRunEnvelopes = messages.filter(
              (m) =>
                m.role === "user" &&
                m.content.some(
                  (b) =>
                    b.type === "text" &&
                    b.text.startsWith(NOT_RUN_ENVELOPE_PREFIX)
                )
            );
            if (out.outcome === "not_run") {
              expect(
                notRunEnvelopes.length,
                `${c.id}: not_run terminal injects exactly one honest envelope`
              ).toBe(1);
              const text = (
                notRunEnvelopes[0]!.content[0] as { type: "text"; text: string }
              ).text;
              // The honest meaning survives on the real trajectory, and the
              // envelope is recognized as host-injected (not model-authored).
              // The locked copy is deliberately "not verified — not passed and
              // not failed", so the pass/fail words appear only inside a
              // negation; that whole phrase is what must be present.
              expect(text).toContain("not verified");
              expect(text).toContain("not passed and not failed");
              expect(
                isVerifyInjectedText(text),
                `${c.id}: not_run copy must be recognized as injected`
              ).toBe(true);
            } else {
              expect(
                notRunEnvelopes.length,
                `${c.id}: only a not_run terminal may inject the envelope ` +
                  `(outcome=${out.outcome})`
              ).toBe(0);
            }

            if (c.kind === "insufficient") {
              const observed =
                report.verdict === "EVIDENCE_INSUFFICIENT" &&
                (out.outcome === "passed" || out.outcome === "not_run") &&
                out.records[out.records.length - 1]?.reason ===
                  REASON_HITL_SKIP_COMPLETION_JUDGE;
              if (!observed) {
                console.log(
                  `[${c.id}] RESIDUAL: model did not take the ` +
                    `edit-without-tests shape (verdict=${report.verdict}); ` +
                    `hard invariants above still enforced`
                );
                return;
              }
              expect(view).toEqual({
                outcome: "not_run",
                rounds: out.rounds,
                notRunReason: "insufficient",
              });
              expect(
                projectVerifyBanner(
                  verifyFromWire(view),
                  "interactive",
                  160
                )[0]!.text
              ).toBe(
                expectedBannerText(
                  NOT_RUN_INSUFFICIENT_PRESENTATION,
                  out.rounds
                )
              );
              return;
            }

            const greenObserved =
              report.verdict === "EVIDENCE_SUFFICIENT" &&
              report.runs.some((r) => r.greenSummary && r.exitCode === 0);
            if (!greenObserved) {
              console.log(
                `[${c.id}] RESIDUAL: real green-run shape not observed ` +
                  `(verdict=${report.verdict}, runs=${JSON.stringify(
                    report.runs.map((r) => ({
                      command: r.command,
                      exitCode: r.exitCode,
                      green: r.greenSummary,
                    }))
                  )}); hard invariants above still enforced`
              );
              // A missing real green can never read as passed: that exact
              // lie is caught by the shared hard invariant above (passed ⇒
              // checker SUFFICIENT on the same messages), so no extra
              // assertion is stacked here.
              return;
            }
            expect(view).toEqual({ outcome: "passed", rounds: out.rounds });
            expect("notRunReason" in (view ?? {})).toBe(false);
            expect(
              projectVerifyBanner(verifyFromWire(view), "interactive", 160)[0]!
                .text
            ).toBe(expectedBannerText(PASSED_PRESENTATION, out.rounds));
          } finally {
            await built.shutdown?.();
          }
        }
      );
    }
  }
);
