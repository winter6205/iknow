#!/usr/bin/env node
/**
 * Offline dual-run divergence report for the shell parse foundation.
 *
 * Modes:
 *   --corpus <file-or-dir>  load the JSONL corpus, dual-run every record,
 *                           print one TAB row `command / old-verdict /
 *                           new-verdict / class` per record; exit non-zero
 *                           on a malformed corpus line (before any row is
 *                           printed) or on any UNEXPECTED row. The node-type
 *                           histogram goes to stderr so stdout stays pure.
 *   --extract <session-dir> read `bash` tool-call command strings out of a
 *                           session directory, apply the redaction roster to
 *                           each DECODED candidate (a hit drops the candidate
 *                           whole, never masked), and print the survivors as
 *                           single-key `{"command": "..."}` JSONL on stdout.
 *
 * The dual run is parse-only: corpus commands are inert text and are never
 * executed. The independent syntax oracle for the `malformed`-over-allow cell
 * runs `bash -n -c "$command"` (exit 0 = bash accepts, exit 2 = bash reports a
 * syntax error), which never executes the input either.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { legacyFindDangerousPattern } from "../src/harness/permission/hard-walls.js";
import {
  parseForSecurity,
  type FactSpan,
  type SecurityParseResult,
} from "../src/harness/permission/shell-parse.js";
import { DEFAULT_SECRET_PATTERNS } from "../src/harness/secret-roundtrip/patterns.js";

export interface ReportRow {
  readonly command: string;
  readonly oldVerdict: string | null;
  readonly newVerdict: string;
  readonly class: "EXPECTED" | "UNEXPECTED";
  readonly clause?: "a" | "b" | "c" | "d" | "e";
}

export interface ClassifyInput {
  readonly command: string;
  readonly oldVerdict: string | null;
  readonly newVerdict: string;
}

export interface Classification {
  readonly class: "EXPECTED" | "UNEXPECTED";
  readonly clause?: "a" | "b" | "c" | "d" | "e";
}

export interface DualPassResult {
  readonly rows: ReportRow[];
  readonly histogram: Record<string, number>;
}

/** The deferral class's pinned report tag. */
const CLASS_E_TAG = "not-yet-migrated";

/** The written membership list of the deferral class; order-insensitive. */
const CLASS_E_IDS: readonly string[] = [
  "destructive-rm",
  "destructive-disk",
  "bare-metachar",
  "root-find-walk",
];

/**
 * The per-id needles of the legacy substring scan, mirroring
 * `DANGEROUS_COMMAND_PATTERNS` in `hard-walls.ts` (the lexical `format` branch
 * has no substring needle by design and never reads as an inert-text hit).
 */
const SCAN_NEEDLES: Readonly<Record<string, readonly string[]>> = {
  "destructive-rm": [
    "rm -rf",
    "rm -fr",
    "rm -r ",
    "rm -f ",
    "rm --recursive",
    "rmdir",
    "remove-item",
    " -delete",
    "chmod -r",
  ],
  "destructive-disk": [
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",
    "shutdown",
    "reboot",
    "del /f",
    "rd /s",
  ],
  "root-find-walk": ["find /"],
  "bare-metachar": [],
};

/** The substitution-site glyphs the legacy scan fires `command-substitution` on. */
const SUBSTITUTION_NEEDLES: readonly string[] = ["$(", "${", "`", "<("];

/** The same normalization the legacy per-segment scan applies to its input. */
function scanNormalized(text: string): string {
  return text.toLowerCase().replace(/\\/g, "").replace(/\s+/g, " ");
}

function containsNeedle(needles: readonly string[], text: string): boolean {
  return needles.some((needle) => text.includes(needle));
}

/** `text` with every span replaced by blanks: what survives is live text. */
function blankOutside(text: string, spans: readonly FactSpan[]): string {
  if (spans.length === 0) {
    return text;
  }
  const chars = text.split("");
  for (const span of spans) {
    const start = Math.max(0, span.start);
    const end = Math.min(chars.length, span.end);
    for (let index = start; index < end; index += 1) {
      chars[index] = " ";
    }
  }
  return chars.join("");
}

/** Regions bash never evaluates: inert spans plus every quoted word. */
function inertRegionSpans(
  parse: Extract<SecurityParseResult, { kind: "ok" }>
): FactSpan[] {
  const spans: FactSpan[] = [];
  for (const inertFact of parse.inert) {
    spans.push(inertFact.span);
  }
  for (const word of parse.words) {
    if (word.quoteKind !== "none") {
      spans.push(word.span);
    }
  }
  return spans;
}

/**
 * `bash -n` as the independent syntax oracle: exit 2 means bash itself calls
 * the input a syntax error. Nothing is executed — `-n` is parse-only. A spawn
 * failure is reported as "not a syntax error" so the row lands UNEXPECTED and
 * raises a ticket instead of silently classifying.
 */
function bashReportsSyntaxError(command: string): boolean {
  try {
    execFileSync("bash", ["-n", "-c", command], { stdio: "ignore" });
    return false;
  } catch (error) {
    return (error as { status?: number }).status === 2;
  }
}

/** The verdict tag out of a `verdict=<tag>` + facts column value. */
function verdictTag(newVerdict: string): string {
  const body = newVerdict.startsWith("verdict=")
    ? newVerdict.slice("verdict=".length)
    : newVerdict;
  return body.split(/[\s,;]+/)[0] ?? body;
}

/** A legacy-allow row: EXPECTED only via the ask-parity or hard-deny clauses. */
function classifyLegacyAllow(command: string, verdict: string): Classification {
  switch (verdict) {
    case "ok":
      return { class: "EXPECTED" };
    case "unknown-syntax":
      return { class: "EXPECTED", clause: "c" };
    case "malformed":
      return bashReportsSyntaxError(command)
        ? { class: "EXPECTED", clause: "d" }
        : { class: "UNEXPECTED" };
    case "over-cap":
    case "vetoed":
      return { class: "EXPECTED", clause: "d" };
    default:
      return { class: "UNEXPECTED" };
  }
}

/**
 * A legacy-deny row. B1: only an `ok` parse verdict can be EXPECTED here.
 * B2 precedence: the quote-blind (a) and real-substitution (b) checks run
 * before the residual (e) membership, so a deferral can only shrink.
 */
function classifyLegacyDeny(
  command: string,
  oldVerdict: string,
  parse: SecurityParseResult
): Classification {
  if (parse.kind !== "ok") {
    return { class: "UNEXPECTED" };
  }
  const spans = inertRegionSpans(parse);
  if (oldVerdict === "command-substitution") {
    if (parse.substitutions.length + parse.expansions.length > 0) {
      return { class: "EXPECTED", clause: "b" };
    }
    const liveGlyph = containsNeedle(
      SUBSTITUTION_NEEDLES,
      scanNormalized(blankOutside(command, spans))
    );
    return liveGlyph
      ? { class: "UNEXPECTED" }
      : { class: "EXPECTED", clause: "a" };
  }
  const needles = SCAN_NEEDLES[oldVerdict] ?? [];
  const inertRegionHit = spans.some((span) =>
    containsNeedle(needles, scanNormalized(command.slice(span.start, span.end)))
  );
  const liveHit = containsNeedle(
    needles,
    scanNormalized(blankOutside(command, spans))
  );
  if (inertRegionHit && !liveHit) {
    return { class: "EXPECTED", clause: "a" };
  }
  return CLASS_E_IDS.includes(oldVerdict)
    ? { class: "EXPECTED", clause: "e" }
    : { class: "UNEXPECTED" };
}

/** The SC11 rule: total, binary, over the two verdict columns plus the command. */
export function classifyRow(row: ClassifyInput): Classification {
  const verdict = verdictTag(row.newVerdict);
  if (row.oldVerdict === null) {
    return classifyLegacyAllow(row.command, verdict);
  }
  if (verdict !== "ok") {
    return { class: "UNEXPECTED" };
  }
  return classifyLegacyDeny(
    row.command,
    row.oldVerdict,
    parseForSecurity(row.command)
  );
}

/** The new-verdict column: the parse verdict tag plus the `ok` payload facts. */
function encodeNewVerdict(parse: SecurityParseResult): string {
  if (parse.kind !== "ok") {
    return `verdict=${parse.kind}`;
  }
  return `verdict=ok words=${parse.words.length} commands=${parse.commands.length} substitutions=${parse.substitutions.length} expansions=${parse.expansions.length} redirects=${parse.redirects.length} heredocs=${parse.heredocs.length} inert=${parse.inert.length}`;
}

/** One dual run: legacy scan verdict + parse verdict + classification. */
export function dualRunCommand(command: string): ReportRow {
  const base: ClassifyInput = {
    command,
    oldVerdict: legacyFindDangerousPattern(command)?.id ?? null,
    newVerdict: encodeNewVerdict(parseForSecurity(command)),
  };
  return { ...base, ...classifyRow(base) };
}

/** Report encoding: no raw newline, CR or TAB survives into a field. */
function encodeReportField(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** The report line: four TAB fields, class last; (e) carries its own tag. */
export function formatReportRow(row: ReportRow): string {
  const classTag =
    row.class === "UNEXPECTED"
      ? "UNEXPECTED"
      : row.clause === "e"
        ? CLASS_E_TAG
        : row.clause === undefined
          ? "expected-agree"
          : `expected-${row.clause}`;
  return [
    encodeReportField(row.command),
    row.oldVerdict ?? "null",
    encodeReportField(row.newVerdict),
    classTag,
  ].join("\t");
}

/** SC10's decidable format: exactly one key `command`, value a string. */
export function checkCorpusLine(raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "line is not valid JSON";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "line is not a JSON object";
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "command") {
    return `keys must be exactly ["command"], got ${JSON.stringify(keys)}`;
  }
  if (typeof (value as { command: unknown }).command !== "string") {
    return "`command` value is not a string";
  }
  return null;
}

function corpusFiles(pathOrDir: string): string[] {
  if (statSync(pathOrDir).isFile()) {
    return [pathOrDir];
  }
  return readdirSync(pathOrDir)
    .filter((name) => statSync(join(pathOrDir, name)).isFile())
    .sort()
    .map((name) => join(pathOrDir, name));
}

/**
 * Decode a corpus (one file, as `--corpus` takes, or every file of a
 * directory sweep). A violating line fails the load; nothing is skipped.
 */
export function loadCorpus(pathOrDir: string): string[] {
  const commands: string[] = [];
  for (const file of corpusFiles(pathOrDir)) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.length === 0 && index === lines.length - 1) {
        return; // the file's trailing newline
      }
      const violation = checkCorpusLine(line);
      if (violation !== null) {
        throw new Error(`${name}:${index + 1} ${violation}`);
      }
      commands.push((JSON.parse(line) as { command: string }).command);
    });
  }
  return commands;
}

/**
 * The admission roster: the secret-pattern floor plus exactly the OQ1 extras
 * (auth header literals, JWT three-segment shapes, token/key query shapes,
 * *_TOKEN= assignment shapes). Matched against DECODED text by the caller.
 */
const OQ1_EXTRA_PATTERNS: readonly string[] = [
  "Bearer\\s+[A-Za-z0-9._-]{10,}",
  "Basic\\s+[A-Za-z0-9+/=]{10,}",
  "[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
  "[?&](token|key)=[^&\\s]+",
  "[A-Za-z0-9_]*_TOKEN=[^\\s]+",
];

const REDACTION_ROSTER: readonly string[] = [
  ...DEFAULT_SECRET_PATTERNS,
  ...OQ1_EXTRA_PATTERNS,
];

/** The roster sources that hit this decoded candidate; non-empty ⇒ drop whole. */
export function redactionHits(decoded: string): string[] {
  return REDACTION_ROSTER.filter((source) => new RegExp(source).test(decoded));
}

function parseJsonLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((record): record is Record<string, unknown> => record !== null);
}

/** The `command` string of a bash tool_use block, if this record carries one. */
function transcriptCommand(record: Record<string, unknown>): string | null {
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const block of content) {
    const entry = block as {
      type?: unknown;
      name?: unknown;
      input?: { command?: unknown } | undefined;
    };
    if (entry.type === "tool_use" && entry.name === "bash") {
      const command = entry.input?.command;
      if (typeof command === "string") {
        return command;
      }
    }
  }
  return null;
}

function collectTranscriptCommands(sessionDir: string): string[] {
  const commands: string[] = [];
  const names = readdirSync(sessionDir)
    .filter(
      (name) =>
        name.endsWith(".jsonl") &&
        name !== "trace.jsonl" &&
        statSync(join(sessionDir, name)).isFile()
    )
    .sort();
  for (const name of names) {
    for (const record of parseJsonLines(join(sessionDir, name))) {
      const command = transcriptCommand(record);
      if (command !== null) {
        commands.push(command);
      }
    }
  }
  return commands;
}

/**
 * Trace records are a source only through the captured-arguments contract: a
 * record without `arguments_captured` true is SKIPPED — the extractor never
 * guesses a command for an uncaptured call. Captured records duplicate the
 * transcript instead of adding a command (deduplicated against it), and never
 * contribute message bodies, other tools' arguments, paths or env.
 */
function collectTraceCommands(sessionDir: string): string[] {
  const traceFile = join(sessionDir, "trace.jsonl");
  if (!existsSync(traceFile)) {
    return [];
  }
  const commands: string[] = [];
  for (const record of parseJsonLines(traceFile)) {
    if (record.record_type !== "tool_call") {
      continue;
    }
    const tool = record.tool_name ?? record.toolName;
    if (tool !== "bash") {
      continue;
    }
    const captured = record.arguments_captured ?? record.argumentsCaptured;
    if (captured !== true) {
      continue;
    }
    const args = record.arguments as { command?: unknown } | undefined;
    const command = args?.command;
    if (typeof command === "string") {
      commands.push(command);
    }
  }
  return commands;
}

/**
 * Extract the admitted command strings from a session directory, in fixture
 * order, dropping whole every roster hit and every uncaptured trace call.
 */
export function extractCommands(sessionDir: string): string[] {
  const transcript = collectTranscriptCommands(sessionDir);
  const seen = new Set(transcript);
  const candidates = [...transcript];
  for (const command of collectTraceCommands(sessionDir)) {
    if (!seen.has(command)) {
      seen.add(command);
      candidates.push(command);
    }
  }
  return candidates.filter((command) => redactionHits(command).length === 0);
}

/** The dual pass over an ordered command list, plus the OQ3 node-type histogram. */
export function runDualPass(commands: readonly string[]): DualPassResult {
  const histogram: Record<string, number> = {};
  const rows = commands.map((command) => {
    const parse = parseForSecurity(command);
    if (parse.kind === "ok" || parse.kind === "unknown-syntax") {
      for (const [type, count] of Object.entries(parse.nodeTypes)) {
        histogram[type] = (histogram[type] ?? 0) + count;
      }
    }
    return dualRunCommand(command);
  });
  return { histogram, rows };
}

function runCorpus(pathOrDir: string): void {
  const pass = runDualPass(loadCorpus(pathOrDir));
  for (const row of pass.rows) {
    process.stdout.write(`${formatReportRow(row)}\n`);
  }
  process.stderr.write(
    `node-type histogram: ${JSON.stringify(pass.histogram)}\n`
  );
  if (pass.rows.some((row) => row.class === "UNEXPECTED")) {
    process.exitCode = 1;
  }
}

function runExtract(sessionDir: string): void {
  for (const command of extractCommands(sessionDir)) {
    process.stdout.write(`${JSON.stringify({ command })}\n`);
  }
}

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  if (index < 0) {
    return null;
  }
  return args[index + 1] ?? null;
}

function main(): void {
  const args = process.argv.slice(2);
  const extractDir = flagValue(args, "--extract");
  const corpusPath = flagValue(args, "--corpus");
  if (extractDir === null && corpusPath === null) {
    process.stderr.write(
      "usage: shell-parse-divergence.ts (--corpus <file|dir> | --extract <session-dir>)\n"
    );
    process.exitCode = 2;
    return;
  }
  try {
    if (extractDir !== null) {
      runExtract(extractDir);
    } else if (corpusPath !== null) {
      runCorpus(corpusPath);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

/**
 * Run CLI main only on direct execution (`npx tsx scripts/shell-parse-divergence.ts …`);
 * importing this module from tests must not trigger it.
 */
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]));

if (isDirectRun) {
  main();
}
