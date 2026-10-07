/**
 * LSP probe — end-to-end verification for spec 251-lsp-tool: walks the
 * PROBE_TARGETS fixture table against real language servers through the
 * production stack.
 *
 * Responsibility: a language-agnostic shell that goes through the ACI tool
 * factory `createLspToolSet` and the real path (production `SERVERS` picks the
 * server by serverId → `getClient` in client.ts → server.spawn launches the
 * real language server + vscode-jsonrpc client trio), running the ops +
 * lsp_diagnostics per `--lang` target.
 *
 * What counts as a pass (the T1 evidence found all of this was advisory):
 *   - a non-empty result that is not a failure sentinel;
 *   - **content**: when the target declares an expectation, the result must
 *     contain it. `lsp_definition` naming its target file is a counted check,
 *     not a printed annotation — a probe that says `no client.ts` and exits 0
 *     is exactly the false green this replaces;
 *   - **no skipped required operation**: the ops listed in the target's
 *     `requiredOps` (definition / hover / references / diagnostics for the TS
 *     and Python targets) must FAIL the run on MethodNotFound instead of being
 *     excluded from `total`. Optional capability gaps still skip;
 *   - **a run that checked nothing fails**: `passed === total` with `total === 0`
 *     is not green (see `summarizeProbeVerdict`).
 *
 * `--lang` parameterization (typescript/python/yaml/json/dockerfile;
 * typescript default): server picked from production `SERVERS` by
 * `PROBE_TARGETS[lang].serverId` (never hardcoded); fixtures are generated into
 * `.iknow/probe-lsp/<lang>/` (gitignored). The python target is a real project
 * (`pyproject.toml` + a real `.venv` + two cross-importing source files).
 *
 * Diagnostics: asserted on their own fixture file, because a server that
 * publishes diagnostics on the first didOpen of a file answers an empty set
 * for a file a previous operation already opened and closed. The probe also
 * waits longer than the 2s tool default, because a project's first analysis is
 * not bounded by it.
 *
 * No manual didOpen: the handler layer (client.ensureOpen) already does
 * per-file idempotent didOpen; the probe exercises only the tool factory and
 * real client end to end.
 *
 * Exit code: `summarizeProbeVerdict(...).exitCode` (see its own comment).
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLspToolSet,
  isLspFailureSentinel,
  isMethodNotFoundSentinel,
} from "../src/harness/aci/tools/lsp.js";
import type { AciToolDef } from "../src/harness/aci/types.js";
import { isMethodNotFoundError } from "../src/harness/lsp/client.js";
import { SERVERS } from "../src/harness/lsp/server.js";
import { PROBE_TARGETS } from "./lsp-probe-targets.js";
import type { ProbeTarget } from "./lsp-probe-targets.js";

const __filename = fileURLToPath(import.meta.url);

/** Accepted `--lang` values → PROBE_TARGETS keys. */
const LANGS = ["typescript", "python", "yaml", "json", "dockerfile"] as const;
type Lang = (typeof LANGS)[number];

function parseLang(argv: string[]): Lang {
  // Accept both `--lang=X` and `--lang X`: `npx tsx scripts/lsp-probe.ts --lang python`
  // passes them as two separate argv entries; direct calls usually use --lang=python.
  const eq = argv.find((a) => a.startsWith("--lang="));
  const raw = eq?.slice("--lang=".length);
  let resolved: string | undefined = raw;
  if (resolved === undefined) {
    const idx = argv.indexOf("--lang");
    if (idx !== -1 && idx + 1 < argv.length) resolved = argv[idx + 1];
  }
  if (resolved !== undefined) {
    if (!(LANGS as readonly string[]).includes(resolved)) {
      console.error(
        `✗ unknown --lang "${resolved}" (expected one of: ${LANGS.join(", ")})`
      );
      process.exit(1);
    }
    return resolved as Lang;
  }
  return "typescript"; // TS default preserves the pre-existing contract.
}

/** Fixture root: `.iknow/probe-lsp/<lang>/` (gitignored, never mistaken for deployment files). */
function fixtureRoot(ctxDirectory: string, lang: Lang): string {
  return path.join(ctxDirectory, ".iknow", "probe-lsp", lang);
}

/** Display base for fixture paths in the log (repo root of the probe run). */
let fixtureRootBase = process.cwd();

/** Fatal, named prerequisite failure: counted, printed, non-zero exit. */
class ProbePrerequisiteError extends Error {}

/**
 * Create a real virtualenv at `<dir>/.venv` so the server resolves a *project*
 * interpreter. `--without-pip` keeps it cheap; pyright only needs the
 * interpreter path, and the acceptance case is about the project existing and
 * being used, not about package installation.
 *
 * A missing `python3` is an explicit non-pass with its reason — never a silent
 * skip that would leave the run looking green without the project environment.
 */
function createProjectVenv(dir: string): void {
  const venv = spawnSync(
    "python3",
    ["-m", "venv", "--without-pip", path.join(dir, ".venv")],
    { encoding: "utf8" }
  );
  const python = path.join(dir, ".venv", "bin", "python");
  if (venv.status !== 0 || !existsSync(python)) {
    throw new ProbePrerequisiteError(
      `python3 -m venv failed (status ${String(venv.status)}): ${(venv.stderr ?? "").trim().slice(0, 200)}`
    );
  }
  console.log(`  venv: ${path.relative(fixtureRootBase, python)}`);
}

/**
 * Resolve the probe target and materialize its fixture project.
 *
 * Writes `fixtureFiles` into `.iknow/probe-lsp/<lang>/` when the target declares
 * them (python and yaml/dockerfile are whole fixture projects; typescript
 * declares only its diagnostics fixture while probing a real repo file), then
 * returns the absolute target path — a fixture-relative one resolved inside the
 * fixture, an already-absolute one left alone.
 */
async function resolveTargetFile(
  ctxDirectory: string,
  lang: Lang
): Promise<string> {
  const t = PROBE_TARGETS[lang];
  const dir = fixtureRoot(ctxDirectory, lang);
  // EXIT: no fixture declared and the target is a real repo file — nothing to
  // write, nothing to resolve.
  if (t.fixtureFiles === undefined && path.isAbsolute(t.targetFile)) {
    return t.targetFile;
  }
  // Stale content from an earlier probe run would silently satisfy an
  // assertion, so the fixture project is rebuilt from scratch every time.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const file of t.fixtureFiles ?? []) {
    const dest = path.join(dir, file.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.content);
  }
  for (const marker of t.rootMarkers ?? []) {
    // EXIT: a declared root marker missing from the written fixture means the
    // server would resolve a different root; fail before probing a wrong target.
    if (!existsSync(path.join(dir, marker))) {
      throw new ProbePrerequisiteError(
        `fixture root marker ${marker} was not written for lang=${lang}`
      );
    }
  }
  if (t.venv === true) createProjectVenv(dir);
  // EXIT: a fixture-relative target resolves inside the fixture project; an
  // absolute one (a real repo file probed alongside a fixture) stays as-is.
  return path.isAbsolute(t.targetFile)
    ? t.targetFile
    : path.join(dir, t.targetFile);
}

let passed = 0;
let total = 0;

/** Assert helper: a verdict classified as pass → count into passed/total and print ✓. */
function reportPass(name: string, extra?: string): void {
  total++;
  passed++;
  console.log(`✓ ${name}${extra ? ` (${extra})` : ""}`);
}

/**
 * Assert helper: a FAIL verdict → count into total, print ✗ + reason.
 *
 * The err branch's detail already carries the `ERROR: ` prefix from
 * classifyProbeResult (fix for probe false positives): previously an error
 * message wrapped by safeCall was judged as an ordinary string, so anything
 * non-empty passed ✓ and real -32602-style errors were misreported as
 * passes. RPC errors must FAIL explicitly.
 */
function reportFail(name: string, detail: string): void {
  total++;
  console.log(`✗ ${name}${detail ? ` (${detail})` : ""}`);
}

/** Normalized safeCall result: ok value / err detail + raw error (needed for capability-gap detection). */
export type ProbeCallResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | {
      readonly kind: "err";
      readonly detail: string;
      readonly error: unknown;
    };

/** Verdict for one op: pass (counts toward passed/total) / skip (capability gap) / fail. */
export type ProbeVerdict =
  | { readonly kind: "pass"; readonly value: unknown }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "fail"; readonly detail: string };

/**
 * How one operation must be judged.
 *
 * `required` turns a capability-gap skip into a counted failure naming the
 * operation; `expect` makes the content check decisive (it used to be a printed
 * annotation only). `nonEmpty` additionally rejects a structurally empty
 * payload — a diagnostics render with no items must not satisfy an expectation.
 */
export interface ProbeExpectation {
  readonly required?: boolean;
  readonly operation?: string;
  readonly expect?: {
    readonly contains: readonly string[];
    readonly nonEmpty?: boolean;
  };
}

/**
 * Core per-op verdict (pure function, unit-testable) — the two MethodNotFound
 * paths of spec 251-lsp-tool (capability advertisement + missing-method
 * sentinel) converge here:
 *
 *   - **ok + missing-method sentinel**: the tool layer turned `-32601` /
 *     explicit `false` into a sentinel string it RETURNS (no throw), so
 *     safeCall sees it as a success value → skip as well.
 *   - **err + MethodNotFound**: paths that bypassed
 *     requestOrMethodNotFoundSentinel (or errors escaping the sentinel check)
 *     still surface as RPC errors → skip.
 *
 * Everything else unchanged: ok passes only if it is a non-empty string and
 * not the no-server sentinel; err always fails. Sentinel detection is reused
 * from src (`isMethodNotFoundSentinel` / `isMethodNotFoundError`) instead of
 * copying literals — if the wording changes, the probe can't silently drift.
 */
export function classifyProbeResult(
  result: ProbeCallResult,
  expectation: ProbeExpectation = {}
): ProbeVerdict {
  const skipVerdict = (reason: string): ProbeVerdict => {
    // EXIT: required operations have no capability-gap exemption — the run fails
    // and names the operation instead of quietly shrinking `total`.
    if (expectation.required === true) {
      return {
        kind: "fail",
        detail: `required operation ${expectation.operation ?? "?"} skipped: ${reason}`,
      };
    }
    return { kind: "skip", reason };
  };
  if (result.kind === "ok") {
    if (isMethodNotFoundSentinel(result.value)) {
      return skipVerdict("MethodNotFound sentinel — server 未实现该方法");
    }
    if (typeof result.value !== "string") {
      return { kind: "fail", detail: `type=${typeof result.value}` };
    }
    if (result.value.length === 0) {
      return { kind: "fail", detail: "empty result" };
    }
    // Layered failure sentinels (no-server / no-root / spawn-failed): judged
    // via the src-side helper, not one hardcoded string — the sentinel wording
    // has evolved and a stale literal would silently misjudge as ✓.
    if (isLspFailureSentinel(result.value)) {
      return { kind: "fail", detail: "LSP server unavailable" };
    }
    return checkExpectation(result.value, expectation);
  }
  // Match both the numeric code (-32601) and the framework fallback text
  // (`Unhandled method <m>`); the detail prefix check also covers non-Error
  // throws (isMethodNotFoundError only recognizes objects).
  if (
    isMethodNotFoundError(result.error) ||
    result.detail.startsWith("Unhandled method ")
  ) {
    return skipVerdict("MethodNotFound — server 未实现该方法");
  }
  return { kind: "fail", detail: `ERROR: ${result.detail}` };
}

/**
 * Content check for an operation that declared expectations: every expected
 * substring must be present, and `nonEmpty` additionally requires more than
 * structural framing. Anything missing is a counted failure — the probe must
 * not be able to print "no <target>" and still exit 0.
 */
function checkExpectation(
  value: unknown,
  expectation: ProbeExpectation
): ProbeVerdict {
  const expect = expectation.expect;
  if (expect === undefined) return { kind: "pass", value };
  const text =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  const missing = expect.contains.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    return {
      kind: "fail",
      detail: `missing expected content: ${missing.join(", ")}`,
    };
  }
  if (expect.nonEmpty === true) {
    // Structural framing (`<diagnostics …>…</diagnostics>`) with nothing inside
    // is not a diagnostics result; a required acceptance case may not pass on it.
    const body = text
      .replace(/<diagnostics[^>]*>/, "")
      .replace(/<\/diagnostics>/, "");
    if (body.trim().length === 0) {
      return { kind: "fail", detail: "empty diagnostics payload" };
    }
  }
  return { kind: "pass", value };
}

/**
 * Exit accounting. `total === 0` means every operation was skipped: reporting
 * `0 === 0` as green is the "green run that exercised nothing" defect, so it
 * is an explicit failure with its reason.
 */
export function summarizeProbeVerdict(counts: {
  readonly passed: number;
  readonly total: number;
}): { readonly exitCode: 0 | 1; readonly summary: string } {
  const { passed, total } = counts;
  if (total === 0) {
    return {
      exitCode: 1,
      summary: `no operation was checked (${passed}/${total}) — a run that skipped everything is not green`,
    };
  }
  return passed === total
    ? { exitCode: 0, summary: `all green (${passed}/${total})` }
    : { exitCode: 1, summary: `failures (${passed}/${total})` };
}

/**
 * Unified reporting: safeCall ok/err result → pass / fail / MethodNotFound-skip.
 *
 * Every op really executes, then dispatches via classifyProbeResult; skip is
 * excluded from total: it is neither a failed check nor a reduction of what
 * should pass — ops outside the server's capability are not part of the
 * probe's assertions, and passed === total judges only ops actually checked.
 *
 * Note: the `extra` hit-assertion for lsp_definition / lsp_hover (result must
 * name the target file) applies only on the pass branch; skipped ops never
 * reach it.
 */
function maybeReport(
  name: string,
  result: ProbeCallResult,
  expectation: ProbeExpectation = {},
  extra?: (value: unknown) => string | undefined
): void {
  const verdict = classifyProbeResult(result, expectation);
  switch (verdict.kind) {
    case "pass":
      reportPass(name, extra?.(verdict.value));
      return;
    case "skip":
      console.log(`- ${name} (skipped: ${verdict.reason})`);
      return;
    case "fail":
      reportFail(name, verdict.detail);
  }
}

/** One LSP `Location` as the probe reads it: a uri and a start position. */
interface ProbeLocation {
  readonly uri?: string;
  readonly range?: {
    readonly start?: { readonly line?: number; readonly character?: number };
  };
}

/**
 * Narrow an op's answer to a location list. `undefined` means the answer
 * carried no parseable list at all (the caller reports it as a miss).
 */
function parseLocationList(value: unknown): ProbeLocation[] | undefined {
  try {
    const parsed: unknown = JSON.parse(
      typeof value === "string" ? value : (JSON.stringify(value) ?? "[]")
    );
    return Array.isArray(parsed) ? (parsed as ProbeLocation[]) : [];
  } catch {
    // EXIT: an unparseable answer carries no location to verify — treat it as a
    // miss rather than silently accepting it.
    return undefined;
  }
}

/**
 * The 1-based hover position of a resolved hit. `undefined` when the location
 * carries no usable range (the caller reports it as a miss).
 */
function hoverPositionOf(
  hit: ProbeLocation
): { readonly line: number; readonly character: number } | undefined {
  const line = hit.range?.start?.line;
  const character = hit.range?.start?.character;
  if (typeof line !== "number" || typeof character !== "number") {
    return undefined;
  }
  return { line, character };
}

/**
 * Verify that a definition / references hit really points at the expected
 * symbol, not merely at the expected file.
 *
 * An LSP `Location` carries a uri and a range, never the symbol's text, so
 * asserting the file alone cannot tell a real hit from a neighbouring symbol in
 * the same file. This hovers at the resolved position and requires the expected
 * symbol — the check that makes the assertion falsifiable.
 *
 * @returns undefined when the symbol is confirmed, otherwise a failure detail.
 */
async function verifySymbolAtHit(
  value: unknown,
  expect: { readonly file: string; readonly symbol: string },
  hover: (file: string, line: number, character: number) => unknown
): Promise<string | undefined> {
  const locations = parseLocationList(value);
  if (locations === undefined) {
    return "no parseable location list to verify the symbol against";
  }
  const hit = locations.find(
    (l) => typeof l.uri === "string" && l.uri.endsWith(expect.file)
  );
  if (hit === undefined) return `no location in ${expect.file}`;
  const position = hoverPositionOf(hit);
  if (position === undefined) {
    return `location in ${expect.file} has no usable range`;
  }
  const hovered = await safeCall(() =>
    hover(fileURLToPath(hit.uri as string), position.line + 1, position.character)
  );
  if (hovered.kind === "err")
    return `hover at the ${expect.file} hit failed: ${hovered.detail}`;
  const text =
    typeof hovered.value === "string"
      ? hovered.value
      : (JSON.stringify(hovered.value) ?? "");
  return text.includes(expect.symbol)
    ? undefined
    : `hover at the ${expect.file} hit does not name ${expect.symbol}`;
}

/**
 * Report one op whose expectation includes a symbol: the file check comes from
 * the location list, the symbol check from hovering at the resolved position.
 * A symbol mismatch is a counted failure, not an annotation.
 */
async function maybeReportWithSymbol(
  name: string,
  result: ProbeCallResult,
  expectation: ProbeExpectation,
  expect: { readonly file: string; readonly symbol: string } | undefined,
  hover: (file: string, line: number, character: number) => unknown,
  extra?: (value: unknown) => string | undefined
): Promise<void> {
  const verdict = classifyProbeResult(result, expectation);
  if (verdict.kind === "fail") {
    reportFail(name, verdict.detail);
    return;
  }
  if (verdict.kind === "skip") {
    console.log(`- ${name} (skipped: ${verdict.reason})`);
    return;
  }
  if (expect !== undefined) {
    const symbolProblem = await verifySymbolAtHit(verdict.value, expect, hover);
    if (symbolProblem !== undefined) {
      reportFail(name, symbolProblem);
      return;
    }
  }
  reportPass(name, extra?.(verdict.value));
}

/**
 * Call one operation until its expectation is met, bounded.
 *
 * A language server answers from an *inferred* project while the configured
 * project is still loading, which makes cross-file navigation look unresolved
 * (measured: hover read `import languageIdFor`, definition pointed at the import
 * statement). Each attempt re-issues the real tool call — and therefore re-opens
 * the document — so the configured project gets a chance to take over.
 *
 * Bounded on purpose: the assertion is never weakened. If the expectation is
 * still unmet after the last attempt the failing verdict is reported, so a
 * genuinely broken navigation cannot pass by waiting.
 */
async function callUntilExpected(
  operation: string,
  run: () => unknown,
  expectation: ProbeExpectation,
  attempts = 3
): Promise<ProbeCallResult> {
  let last: ProbeCallResult = await safeCall(run);
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (classifyProbeResult(last, expectation).kind === "pass") break;
    await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    last = await safeCall(run);
  }
  const kind = classifyProbeResult(last, expectation).kind;
  console.log(
    kind === "pass"
      ? `  ${operation}: satisfied (project loaded)`
      : `  ${operation}: still unmet after ${attempts} attempts`
  );
  return last;
}

/** Expectation for one op, derived from the target's declaration. */
function expectationFor(
  lang: Lang,
  operation: string,
  contains?: readonly string[]
): ProbeExpectation {
  const t = PROBE_TARGETS[lang];
  return {
    required: t.requiredOps?.includes(operation) ?? false,
    operation,
    ...(contains !== undefined
      ? {
          expect: {
            contains,
            // An empty diagnostics render is not a diagnostics result; requiring
            // real content is what makes the acceptance case unfalsifiable.
            nonEmpty: operation === "lsp_diagnostics",
          },
        }
      : {}),
  };
}

/**
 * Wrap one call in try/catch, normalizing RPC errors into `{detail, error}` so
 * later reporting can print the reason (a raw ResponseError would take down
 * the whole probe); the raw error travels with the result so capability
 * detection can read `code` (-32601).
 */
async function safeCall(call: () => unknown): Promise<ProbeCallResult> {
  try {
    const v = await call();
    return { kind: "ok", value: v };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "err",
      detail: msg.split("\n")[0].slice(0, 160),
      error: err,
    };
  }
}

/** Tool lookup by name (production factory; a missing export is a counted fail). */
type ToolGetter = (name: string) => AciToolDef;

/** Hover at an arbitrary resolved position (used to verify a located symbol). */
type HoverAt = (
  file: string,
  atLine: number,
  atCharacter: number
) => unknown;

/** Ops executed once, on the target file alone, with no content expectation. */
const PLAIN_FILE_OPS = ["lsp_document_symbol", "lsp_workspace_symbol"] as const;

/** Ops executed once at the target position, with no content expectation. */
const PLAIN_POSITION_OPS = [
  "lsp_go_to_implementation",
  "lsp_prepare_call_hierarchy",
  "lsp_incoming_calls",
  "lsp_outgoing_calls",
] as const;

/**
 * Load the files the cross-file assertions depend on before probing positions:
 * a server only searches what it has loaded, and an unprobed import makes the
 * definition / references assertions unfalsifiable in the wrong direction.
 */
async function loadWarmupFiles(
  t: ProbeTarget,
  target: string,
  get: ToolGetter
): Promise<void> {
  for (const warmup of t.warmupFiles ?? []) {
    const warmupFile = path.isAbsolute(warmup)
      ? warmup
      : path.join(path.dirname(target), warmup);
    const loaded = await safeCall(() =>
      get("lsp_document_symbol").handler({ file: warmupFile })
    );
    const verdict = classifyProbeResult(loaded, {
      required: true,
      operation: `warmup ${path.basename(warmupFile)}`,
    });
    if (verdict.kind !== "pass") {
      // EXIT: without the defining file loaded the cross-file assertions would
      // measure an unresolved import instead of real navigation — fail loudly.
      throw new ProbePrerequisiteError(
        `could not load ${path.basename(warmupFile)} into the server program (${
          verdict.kind === "skip" ? verdict.reason : verdict.detail
        })`
      );
    }
    console.log(
      `  loaded ${path.basename(warmupFile)} into the server program`
    );
  }
}

/**
 * One op with no content expectation and no retry: execute it through the tool
 * factory, then let `maybeReport` judge the verdict.
 */
async function probePlainOp(
  get: ToolGetter,
  lang: Lang,
  name: string,
  handlerArgs: Record<string, unknown>
): Promise<void> {
  const result = await safeCall(() => get(name).handler(handlerArgs));
  maybeReport(name, result, expectationFor(lang, name));
}

/**
 * 1) lsp_definition — points at the fixture position; assert the result names
 * the target file. No manual didOpen: handler-level ensureOpen opens the file
 * and builds the project.
 */
async function probeDefinition(args: {
  readonly get: ToolGetter;
  readonly hoverAt: HoverAt;
  readonly lang: Lang;
  readonly target: string;
  readonly line: number;
  readonly character: number;
  readonly expectedFile: string;
  readonly expectDefinition: ProbeTarget["expectDefinition"];
}): Promise<void> {
  const expectation = expectationFor(args.lang, "lsp_definition", [
    args.expectedFile,
  ]);
  const result = await callUntilExpected(
    "lsp_definition",
    () =>
      args.get("lsp_definition").handler({
        file: args.target,
        line: args.line,
        character: args.character,
      }),
    expectation
  );
  await maybeReportWithSymbol(
    "lsp_definition",
    result,
    expectation,
    args.expectDefinition,
    args.hoverAt,
    (value) =>
      typeof value === "string" && value.includes(args.expectedFile)
        ? `hit ${args.expectedFile} (${args.expectDefinition?.symbol ?? "symbol"})`
        : `no ${args.expectedFile}`
  );
}

/**
 * 2) lsp_references — locations referencing the target symbol. When the target
 * declares a references anchor it is used instead of the op target, so the
 * expected hit can live in a *different* file (a genuine cross-file assertion
 * rather than a self-reference).
 */
async function probeReferences(args: {
  readonly get: ToolGetter;
  readonly hoverAt: HoverAt;
  readonly lang: Lang;
  readonly target: string;
  readonly line: number;
  readonly character: number;
}): Promise<void> {
  const anchor = PROBE_TARGETS[args.lang].expectReferences;
  const refFile = anchor
    ? anchor.file.startsWith("/")
      ? anchor.file
      : path.join(path.dirname(args.target), path.basename(anchor.file))
    : args.target;
  const expectation = expectationFor(
    args.lang,
    "lsp_references",
    anchor ? [anchor.expectFile] : undefined
  );
  const result = await callUntilExpected(
    "lsp_references",
    () =>
      args.get("lsp_references").handler({
        file: refFile,
        line: anchor?.line ?? args.line,
        character: anchor?.char ?? args.character,
      }),
    expectation
  );
  await maybeReportWithSymbol(
    "lsp_references",
    result,
    expectation,
    anchor !== undefined
      ? { file: anchor.expectFile, symbol: anchor.expectSymbol }
      : undefined,
    args.hoverAt,
    (value) =>
      anchor !== undefined &&
      typeof value === "string" &&
      value.includes(anchor.expectFile)
        ? `hit ${anchor.expectFile} (${anchor.expectSymbol})`
        : anchor !== undefined
          ? `no ${anchor.expectFile}`
          : undefined
  );
}

/** 3) lsp_hover — hover at the target symbol should return a type signature. */
async function probeHover(args: {
  readonly get: ToolGetter;
  readonly lang: Lang;
  readonly target: string;
  readonly line: number;
  readonly character: number;
}): Promise<void> {
  const expectation = expectationFor(
    args.lang,
    "lsp_hover",
    PROBE_TARGETS[args.lang].expectHover?.contains
  );
  const result = await callUntilExpected(
    "lsp_hover",
    () =>
      args.get("lsp_hover").handler({
        file: args.target,
        line: args.line,
        character: args.character,
      }),
    expectation
  );
  maybeReport("lsp_hover", result, expectation);
}

/**
 * lsp_diagnostics — when the target declares a diagnostics expectation it runs
 * against its own fixture file: a server that publishes on the first didOpen of
 * a file answers an empty set for a file an earlier operation already opened
 * and closed, which would make the content assertion unfalsifiable. An empty
 * payload must not satisfy a required acceptance case.
 */
async function probeDiagnostics(args: {
  readonly get: ToolGetter;
  readonly lang: Lang;
  readonly ctxDirectory: string;
  /** Diagnostics target when the probe declares none: the op target's file. */
  readonly diagFile: string;
}): Promise<void> {
  const declared = PROBE_TARGETS[args.lang].expectDiagnostics;
  const diagTarget = declared
    ? declared.file.startsWith("/")
      ? declared.file
      : path.join(fixtureRoot(args.ctxDirectory, args.lang), declared.file)
    : args.diagFile;
  const result = await safeCall(() =>
    args.get("lsp_diagnostics").handler({ file: diagTarget })
  );
  maybeReport(
    "lsp_diagnostics",
    result,
    expectationFor(args.lang, "lsp_diagnostics", declared?.contains ?? undefined),
    (value) =>
      typeof value === "string" && value.includes("<diagnostics")
        ? "diagnostics XML"
        : "empty"
  );
}

async function run(): Promise<void> {
  const lang = parseLang(process.argv);
  const ctx = {
    directory: resolve(fileURLToPath(new URL("..", import.meta.url))),
    // A project's first analysis is not bounded by the tool default (2s):
    // typescript-language-server measured well past 2s before the inferred
    // project published diagnostics for a freshly opened file, and the probe
    // asserts real diagnostic content — so it waits for them rather than
    // accepting an "empty" result as a pass.
    diagnosticsWaitMs: 30_000,
  };
  fixtureRootBase = ctx.directory;
  const t = PROBE_TARGETS[lang];
  const server = SERVERS.find((s) => s.id === t.serverId);
  if (!server) {
    console.error(`✗ no SERVERS entry for lang=${lang} serverId=${t.serverId}`);
    process.exit(1);
  }

  console.log(`lsp-probe [--lang ${lang}] server=${t.serverId}`);

  // Fixture targets (yaml/python/dockerfile) are generated at runtime into
  // .iknow/probe-lsp/; real repo files (typescript/json) are used directly.
  const target = await resolveTargetFile(ctx.directory, lang);
  const { line, char } = t;

  // Production handshake: spawnClient (client.ts) already sends the
  // `initialized` notification after the initialize response (pyright requires
  // it). The probe must not send it again — on a cached client (root+id reuse)
  // that would double-init.
  const tools = createLspToolSet(ctx);
  const byName = new Map(tools.map((x) => [x.name, x]));
  const get: ToolGetter = (n: string): AciToolDef => {
    const tool = byName.get(n);
    if (!tool) {
      total++;
      console.log(`✗ ${n} (tool not exported)`);
    }
    return tool as AciToolDef;
  };
  const hoverAt: HoverAt = (file, atLine, atCharacter) =>
    get("lsp_hover").handler({
      file,
      line: atLine,
      character: atCharacter,
    });

  await loadWarmupFiles(t, target, get);
  await probeDefinition({
    get,
    hoverAt,
    lang,
    target,
    line,
    character: char,
    expectedFile: t.expectDefinition ? t.expectDefinition.file : path.basename(target),
    expectDefinition: t.expectDefinition,
  });
  await probeReferences({ get, hoverAt, lang, target, line, character: char });
  await probeHover({ get, lang, target, line, character: char });
  for (const name of PLAIN_FILE_OPS) {
    await probePlainOp(get, lang, name, { file: target });
  }
  for (const name of PLAIN_POSITION_OPS) {
    await probePlainOp(get, lang, name, {
      file: target,
      line,
      character: char,
    });
  }
  await probeDiagnostics({
    get,
    lang,
    ctxDirectory: ctx.directory,
    diagFile: target,
  });

  const verdict = summarizeProbeVerdict({ passed, total });
  console.log(`\n${verdict.summary}`);
  process.exit(verdict.exitCode);
}

// Run the probe only as an entry point — unit tests import this module for the
// pure functions (classifyProbeResult) and must not spawn real language servers.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  run().catch((err) => {
    // EXIT: a missing prerequisite (python3 / venv / unwritten root marker) is
    // an explicit non-pass with its reason — never a green run or a hidden skip.
    if (err instanceof ProbePrerequisiteError) {
      console.error(`\n✗ probe prerequisite failed: ${err.message}`);
      console.error(
        "✗ not green (0/0) — the acceptance case was not exercised"
      );
      process.exit(1);
    }
    console.error("lsp-probe crashed:", err);
    process.exit(1);
  });
}
