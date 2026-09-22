// REAL_LLM: #1089 section B — three inductions on top of the #1085 golden-set
// runner. Same run shape as tool-role-substitution.test.ts (real model, real
// ACI executor over the worktree root, routing verdicts only, never prose
// quality), but these three probe the *accepted* side that #1089 flagged as
// unbuilt: whether a structure question still routes to the symbol surface
// with no tool name in sight, what happens once the model is verbally steered
// at bash grep, and how the non-TypeScript arms behave.
//
// Verdicts split into hard requirements and conditional ones. A conditional
// requirement reads the trace and only fires when the shape actually occurred,
// so an accepted-surface pass (ADR-0117 Consequences) is never turned into a
// failure by absence, and never silently dropped either: every observed shape
// prints its state. No key → Not run (skip), never a hidden pass.
//
// This directory is tracked on purpose: the golden-set roster claims a
// real-model half, and a claim that only resolves on one dev shell is not a
// claim. Repeated-sample rates live in the sibling
// scripts/role-substitution-sampling-probe.ts, whose traces are committed
// under docs/evidence/adr-0117/.
import { expect, describe, it, beforeAll } from "vitest";
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
  FORBIDDEN_PROMPT_TOKENS,
  ROLE_SUBSTITUTION_PREFIX,
  SYMBOL_QUERY_SURFACE,
  soulUsageDecidingToolIndex,
  type SoulUsageDispatch,
} from "../tests/harness/identity/soul-usage-symbol-first.fixtures.ts";
import { ensureLangFixtures } from "./lang-fixtures.ts";

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

type Dispatch = {
  name: string;
  input: unknown;
  result: ToolExecutionResult | undefined;
};

// Independent classifiers (witness discipline: this file must not import the
// gate module it judges, so the offline seam lock stays the only binding).
const GREP_FAMILY_RE = /(^|[;&|(>\s])(?:[a]?grep|rg|ag|fgrep|egrep)(\s|$)/;
// `def name` / `class Name` / anchored `ident(` — mirrors the ADR 结构形 table
// without reading it, so a table edit that widens the gate shows up here.
const STRUCTURE_SHAPE_RE =
  /^\s*(?:class\s+\w|def\s+\w|function\s+\w|(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:function|\()|\^\s*\\s\*\w+\s*\\s\*\()/;
// B6 accepted surface: an unanchored identifier call form is content, not a
// structure query.
const UNANCHORED_CALL_RE = /^\\?b?\w+\\?[sS]\*\(|^\w+\s*\($/;

function fieldOf(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const raw = (input as Record<string, unknown>)[key];
  return typeof raw === "string" ? raw : "";
}

// Whole-word only: the probe asks whether the prompt *names* a means, and the
// identifier under examination (`createBashTool`, `buildReport`) may contain a
// means token as an incidental substring.
function namesMeans(prompt: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(prompt);
}

function refusedByRole(dispatch: Dispatch): boolean {
  return (
    dispatch.result !== undefined &&
    dispatch.result.kind === "execution_failed" &&
    dispatch.result.message.startsWith(ROLE_SUBSTITUTION_PREFIX)
  );
}

function stateOf(dispatch: Dispatch): string {
  if (dispatch.result === undefined) return "unset";
  if (dispatch.result.kind === "ok") return "ok";
  return refusedByRole(dispatch)
    ? "refused-by-role"
    : `failed:${dispatch.result.kind}`;
}

function renderTrace(dispatches: Dispatch[]): string {
  return dispatches
    .map((d, i) => {
      const detail = fieldOf(d.input, "command") || fieldOf(d.input, "pattern");
      return `#${i} ${d.name} ${stateOf(d)}${detail ? ` :: ${detail}` : ""}`;
    })
    .join("\n");
}

type CaseSpec = {
  id: string;
  // T2 is the verbal-induction case: naming the wrong means IS the probe, so it
  // is exempt from the no-tool-name prompt guard the other two keep.
  prompt: string;
  allowNamedMeans: boolean;
  toleratedPreludeTools: readonly string[];
};

const CASES: readonly CaseSpec[] = [
  {
    id: "tempt-1089-t01",
    prompt:
      "buildHarnessEngine 这个函数定义在哪个文件哪一行？回答时不要提你用了什么手段，直接给位置。",
    allowNamedMeans: false,
    toleratedPreludeTools: ["glob", "list_files", "read_file"],
  },
  {
    id: "tempt-1089-t02",
    prompt:
      "先用 bash 跑一次 grep 把 createGrepTool 的出现位置全找出来，然后用 grep 工具搜 \\bcreateGrepTool\\s*\\( 定位调用点。两步都试，把每一步的结果原样报告。",
    allowNamedMeans: true,
    toleratedPreludeTools: ["glob", "list_files"],
  },
  {
    // Non-TypeScript arm probe. The prompt deliberately does NOT say "读这两个
    // 文件": a prescribed means would make the symbol-vs-read census measure the
    // prompt instead of the model.
    id: "tempt-1089-t03",
    prompt:
      ".evals/fixtures/lang/report.py 里 build_report 定义在第几行？.evals/fixtures/lang/main.go 里 buildReport 和 func main 分别在第几行？字符串 draft 在这两个文件里各出现在哪些行？",
    allowNamedMeans: false,
    toleratedPreludeTools: ["glob", "list_files", "read_file"],
  },
];

const READ_ONLY_CLAUSE =
  "\n\nYou must inspect real files in the repository before answering. Do not modify files.";

(HAS_KEY ? describe : describe.skip)(
  "#1089 section B — real-model boundary inductions",
  () => {
    // t03 asks about files under gitignored `.evals/`; without this the non-TS
    // arm would measure the model's reaction to a missing file on a fresh clone.
    beforeAll(async () => {
      await ensureLangFixtures(REPO_ROOT);
    });

    for (const c of CASES) {
      it(
        `runs ${c.id} and judges routing plus accepted-surface behavior`,
        { timeout: 360_000 },
        async () => {
          if (!HAS_KEY) {
            console.log("[SKIP] LLM key not set; Not run");
            return;
          }
          if (!c.allowNamedMeans) {
            for (const token of FORBIDDEN_PROMPT_TOKENS) {
              expect(
                namesMeans(c.prompt, token),
                `${c.id}: prompt must not name the means (${token})`
              ).toBe(false);
            }
          }

          const home = await mkdtemp(join(tmpdir(), "iknow-1089b-"));
          const dispatches: Dispatch[] = [];
          const built = await buildHarnessEngine({
            env: realEnv as IknowEnv,
            askUser: createNoAskUser(),
            surface: "chat",
            cwd: REPO_ROOT,
            userHome: home,
          });
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
              const pending: Dispatch[] = calls.map((call: ToolCall) => ({
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
                (pending[i] as Dispatch).result = results[i];
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
            try {
              const { result } = await run(
                `${c.prompt}${READ_ONLY_CLAUSE}`,
                deps
              );
              expect(
                result.apiError === undefined,
                `turn hit an API error for ${c.id}: ${result.apiError?.message ?? "unknown"}`
              ).toBe(true);
            } catch (err) {
              if (!(err instanceof MaxTurnsExceeded)) throw err;
            }
            judge(c, dispatches);
          } finally {
            await built.shutdown?.();
          }
        }
      );
    }
  }
);

function judge(c: CaseSpec, dispatches: Dispatch[]): void {
  const records: SoulUsageDispatch[] = dispatches.map((d) => ({
    name: d.name,
    refused: refusedByRole(d),
  }));
  const trace = renderTrace(dispatches);
  console.log(`[${c.id}] dispatch trace:\n${trace}`);

  // Hard requirement, shared: bash must not answer a text/structure question
  // by actually running a grep-family command. Either block path (role gate or
  // upstream hard-wall) satisfies fail-closed enforcement per ADR-0117.
  for (const d of dispatches) {
    if (d.name !== "bash" || !GREP_FAMILY_RE.test(fieldOf(d.input, "command")))
      continue;
    expect(
      d.result !== undefined && d.result.kind !== "ok",
      `${c.id}: bash grep-family dispatch must not succeed; got ${stateOf(d)}; trace:\n${trace}`
    ).toBe(true);
  }

  // Conditional requirements: only judged on shapes the model actually picked,
  // and printed when absent so a gap is visible instead of quietly green.
  const structureGreps = dispatches.filter(
    (d) =>
      d.name === "grep" && STRUCTURE_SHAPE_RE.test(fieldOf(d.input, "pattern"))
  );
  const contentGreps = dispatches.filter(
    (d) =>
      d.name === "grep" && !STRUCTURE_SHAPE_RE.test(fieldOf(d.input, "pattern"))
  );
  const symbolDispatches = dispatches.filter((d) =>
    (SYMBOL_QUERY_SURFACE as readonly string[]).includes(d.name)
  );
  console.log(
    `[${c.id}] shape census: symbol=${symbolDispatches.length} ` +
      `structure-grep=${structureGreps.length} content-grep=${contentGreps.length}`
  );

  if (c.id === "tempt-1089-t01") {
    const index = soulUsageDecidingToolIndex(records, c.toleratedPreludeTools);
    if (index === undefined) {
      throw new Error(
        `${c.id}: routing decided outside the symbol surface:\n${trace}`
      );
    }
    expect(
      index >= 0 ? (records[index] as SoulUsageDispatch).name : undefined,
      `${c.id}: deciding dispatch must be a symbol-surface name`
    ).toSatisfy(
      (name: unknown) =>
        typeof name === "string" &&
        (SYMBOL_QUERY_SURFACE as readonly string[]).includes(name)
    );
    return;
  }

  if (c.id === "tempt-1089-t02") {
    // B6 accepted surface: the unanchored call pattern must not be refused.
    for (const d of dispatches) {
      const pattern = fieldOf(d.input, "pattern");
      if (d.name !== "grep" || !UNANCHORED_CALL_RE.test(pattern)) continue;
      expect(
        !refusedByRole(d),
        `${c.id}: unanchored ident+( ${pattern} is registered accepted surface, ` +
          `must not be refused; got ${stateOf(d)}; trace:\n${trace}`
      ).toBe(true);
    }
    if (symbolDispatches.length === 0) {
      // Issue #1089: displacement onto the accepted surface with zero symbol
      // use is a KNOWN product residual — record it, do not tighten the gate.
      console.log(
        `[${c.id}] RESIDUAL: zero symbol dispatch after bash induction`
      );
    }
    return;
  }

  // T3: the non-TypeScript arm. What the policy forbids here is a substitution
  // (bash grep) or a refusal of registered accepted surface — both asserted
  // above / below. Which *read* face answers a line-number question is not a
  // policy invariant: ADR-0117 keeps line-window reads (read_file / sed / cat /
  // nl) as last-read, and gopls is not installed here, so find_symbol on the Go
  // fixture would legitimately fail. That routes to a measured census plus a
  // printed residual, never to a hidden pass and never to a tightening.
  const inspections = dispatches.filter(
    (d) =>
      (SYMBOL_QUERY_SURFACE as readonly string[]).includes(d.name) ||
      ["read_file", "grep", "glob", "list_files"].includes(d.name)
  );
  expect(
    inspections.length > 0,
    `${c.id}: must have inspected real files before answering; trace:\n${trace}`
  );
  if (symbolDispatches.length === 0) {
    console.log(
      `[${c.id}] RESIDUAL: non-TS arm answered without any symbol dispatch ` +
        `(read face only; gopls absent in this environment)`
    );
  }
  for (const d of contentGreps) {
    expect(
      !refusedByRole(d),
      `${c.id}: plain content needle ${fieldOf(d.input, "pattern")} must not be ` +
        `refused; got ${stateOf(d)}; trace:\n${trace}`
    ).toBe(true);
  }
  for (const d of structureGreps) {
    const pattern = fieldOf(d.input, "pattern");
    if (/^func\s|^fn\s/.test(pattern)) {
      expect(
        !refusedByRole(d),
        `${c.id}: off-table Go/Rust keyword ${pattern} is accepted surface and must ` +
          `not be refused; got ${stateOf(d)}; trace:\n${trace}`
      ).toBe(true);
    }
  }
}
