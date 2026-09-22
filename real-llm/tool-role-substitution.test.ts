// REAL_LLM: soul/usage 轨迹集 half (ADR-0117). Runs the golden
// set against the real model over the worktree repo root and judges routing:
// verdict (a) the deciding dispatch for a structure question is one of the
// ten query-side symbol names; verdict (b) no bash dispatch carrying a
// grep-family command may succeed — substitution is blocked fail-closed.
// Which gate blocks (the [role_substitution] handler gate, or the upstream
// permission hard-wall on dangerous metachars, ADR-0068) is recorded in the
// trace; the role tag itself is locked deterministically by the offline
// contract tests, because the permission layer legitimately preempts the
// handler gate and ADR-0117 forbids the role gate from becoming a hard-wall.
// Routing-based per ADR-0117 Decision 2 — never prose quality.
// No key → Not run (skip), never a hidden pass.
import { expect, describe, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";

import { buildHarnessEngine } from "../src/harness/build-engine.ts";
import { run, type LoopEngineDeps } from "../src/harness/loop-engine.ts";
import { MaxTurnsExceeded } from "../src/harness/errors.ts";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
} from "../src/harness/tools/types.ts";
import { createNoAskUser } from "../src/harness/permission/ask-user.ts";
import { loadIknowEnv, type IknowEnv } from "../src/config/env.ts";
import {
  ROLE_SUBSTITUTION_PREFIX,
  SOUL_USAGE_CASES,
  SYMBOL_QUERY_SURFACE,
  soulUsageDecidingToolIndex,
  type SoulUsageDispatch,
} from "../tests/harness/identity/soul-usage-symbol-first.fixtures.ts";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

let realEnv: IknowEnv | undefined;
try {
  realEnv = loadIknowEnv(REPO_ROOT);
} catch {
  realEnv = undefined;
}
const HAS_KEY = realEnv !== undefined && !!realEnv.llm.apiKey;
if (!HAS_KEY) console.log("[SKIP] LLM key not set; Not run");

type DispatchRecord = {
  name: string;
  input: unknown;
  result: ToolExecutionResult | undefined;
};

// The refusal-tag pattern the contract covers: shell text-search invocations.
function isGrepFamilyCommand(command: string): boolean {
  return /(^|[;&|(>\s])(?:[a]?grep|rg|ag|fgrep|egrep)(\s|$)/.test(command);
}

function commandOf(dispatch: DispatchRecord): string {
  const input = dispatch.input;
  if (typeof input !== "object" || input === null) return "";
  const raw = (input as Record<string, unknown>).command;
  return typeof raw === "string" ? raw : "";
}

function refusalReceipt(result: ToolExecutionResult | undefined): boolean {
  return (
    result !== undefined &&
    result.kind === "execution_failed" &&
    result.message.startsWith(ROLE_SUBSTITUTION_PREFIX)
  );
}

// Three-state dispatch classification: only the pinned role refusal is a
// refusal; any other failure (execution_failed without the tag, validation
// or not-found) counts as effective for verdict (a) — a failed substitution
// attempt did not legitimately decide the case.
type DispatchState = "effective" | "refused-by-role" | "failed-other";

function dispatchState(result: ToolExecutionResult | undefined): DispatchState {
  if (result === undefined || result.kind === "ok") return "effective";
  return refusalReceipt(result) ? "refused-by-role" : "failed-other";
}

function resultKind(result: ToolExecutionResult | undefined): string {
  return result?.kind ?? "unset";
}

function resultMessageHead(result: ToolExecutionResult | undefined): string {
  if (result === undefined) return "";
  if (result.kind === "ok") {
    const text = result.payload
      .map((block) => (block.type === "text" ? block.text : ""))
      .join(" ");
    return text.replace(/\s+/g, " ").slice(0, 100);
  }
  if ("message" in result) {
    return result.message.replace(/\s+/g, " ").slice(0, 100);
  }
  return "";
}

function inputDetail(dispatch: DispatchRecord): string {
  const input = dispatch.input;
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  // Full command/pattern, untruncated: the 120-char excerpt hid the exact
  // shape of the tempt-1078-t01 #0 dispatch and stalled its diagnosis.
  for (const key of ["command", "pattern"]) {
    const raw = record[key];
    if (typeof raw === "string") return `${key}=${raw}`;
  }
  return "";
}

function formatTrace(dispatches: DispatchRecord[]): string {
  return dispatches
    .map(
      (d, i) =>
        `#${i} ${d.name} ${dispatchState(d.result)} kind=${resultKind(d.result)}` +
        ` :: ${inputDetail(d)} :: result_head=${resultMessageHead(d.result)}`
    )
    .join("\n");
}

function assertCase(caseId: string, dispatches: DispatchRecord[]) {
  const tc = SOUL_USAGE_CASES.find((c) => c.id === caseId);
  if (!tc) throw new Error(`unknown golden case: ${caseId}`);
  const records: SoulUsageDispatch[] = dispatches.map((d) => ({
    name: d.name,
    refused: refusalReceipt(d.result),
  }));
  const trace = formatTrace(dispatches);
  console.log(`[${tc.id}] dispatch trace:\n${trace}`);
  const index = soulUsageDecidingToolIndex(records, tc.toleratedPreludeTools);
  if (index === undefined) {
    throw new Error(
      `Fixture ${tc.id} not decided: a non-refused, untolerated dispatch hit ` +
        `outside the symbol query surface (${SYMBOL_QUERY_SURFACE.join(", ")}) ` +
        `before any surface name. Trace:\n${trace}`
    );
  }
  // Verdict (a): the deciding dispatch must sit on the symbol query surface
  // (membership, not the documented canonical route tc.expectedFirstTool).
  const deciding =
    index >= 0 ? (records[index] as SoulUsageDispatch).name : undefined;
  expect(
    deciding !== undefined &&
      (SYMBOL_QUERY_SURFACE as readonly string[]).includes(deciding),
    `Fixture ${tc.id} verdict (a): deciding dispatch must be a query-side ` +
      `symbol name (canonical route documented as ${tc.expectedFirstTool}). ` +
      `Trace:\n${trace}`
  ).toBe(true);
  // Verdict (b): no grep-family bash substitution attempt may succeed. A
  // hard-wall block ([permission_denied]) and a role block
  // ([role_substitution]) are both fail-closed enforcement; an ok result
  // means bash answered a text/structure question — the leak this locks.
  for (const dispatch of dispatches) {
    if (dispatch.name !== "bash" || !isGrepFamilyCommand(commandOf(dispatch)))
      continue;
    expect(
      dispatch.result !== undefined && dispatch.result.kind !== "ok",
      `Fixture ${tc.id} verdict (b): bash grep-family dispatch must not ` +
        `succeed (role gate or hard-wall must block it); got ` +
        `kind=${dispatch.result?.kind ?? "unset"}; trace:\n${trace}`
    ).toBe(true);
  }
}

(HAS_KEY ? describe : describe.skip)(
  "soul/usage golden set — real model (test:real-llm)",
  () => {
    for (const c of SOUL_USAGE_CASES) {
      it(
        `routes ${c.id} to the symbol surface and refuses bash substitution`,
        { timeout: 360_000 },
        async () => {
          if (!HAS_KEY) {
            console.log("[SKIP] LLM key not set; Not run");
            return;
          }
          const home = await mkdtemp(join(tmpdir(), "iknow-soul-usage-"));
          const dispatches: DispatchRecord[] = [];
          const built = await buildHarnessEngine({
            env: realEnv as IknowEnv,
            askUser: createNoAskUser(),
            surface: "chat",
            cwd: REPO_ROOT,
            userHome: home,
          });
          // The structure questions are answered about this repo, so the engine
          // runs over the worktree root itself (reference templates' temp-seed
          // path cannot answer roster-targeted questions). The real ACI executor
          // stays in charge — the recording layer only wraps and delegates, so
          // verdict (b) observes the actual gate receipt.
          const inner: Executor = built.deps.executor;
          const recording: Executor = {
            executeAll: async (
              calls,
              signal,
              timeoutMs,
              conversationId,
              onSettled,
              turnId,
              onStream,
              messages
            ) => {
              const pending: DispatchRecord[] = calls.map((call: ToolCall) => ({
                name: call.name,
                input: call.input,
                result: undefined,
              }));
              dispatches.push(...pending);
              const results = await inner.executeAll(
                calls,
                signal,
                timeoutMs,
                conversationId,
                onSettled,
                turnId,
                onStream,
                messages
              );
              for (let i = 0; i < pending.length; i += 1) {
                (pending[i] as DispatchRecord).result = results[i];
              }
              return results;
            },
          };
          const deps: LoopEngineDeps = {
            ...built.deps,
            executor: recording,
            conversationId: c.id,
            maxTurns: 6,
          };
          try {
            const userPrompt =
              `${c.userPrompt}\n\nYou must inspect real files in the repository ` +
              "before answering. Use only the query side (read/lookup); do not modify files.";
            try {
              const { result } = await run(userPrompt, deps);
              expect(
                result.apiError === undefined,
                `turn hit an API error for ${c.id}: ${result.apiError?.message ?? "unknown"}`
              ).toBe(true);
            } catch (err) {
              // ADR-0117 Decision 2: the golden set decides on routing, and the
              // first dispatch is recorded before budget exhaustion, so routing
              // verdicts stay decidable.
              if (err instanceof MaxTurnsExceeded) {
                assertCase(c.id, dispatches);
                return;
              }
              throw err;
            }
            assertCase(c.id, dispatches);
          } finally {
            await built.shutdown?.();
          }
        }
      );
    }
  }
);
