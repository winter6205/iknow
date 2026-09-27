/**
 * scripts/measure-frontmatter-corpus.ts — SC-Corpus re-measurement of the landed
 * memory writer (spec `memory-frontmatter-write-signals`, issue #1137).
 *
 * `docs/evidence/frontmatter-serialize-migration.md` §9 measured the writer against
 * 19 real on-disk entries. Those bytes are unrecoverable on this machine: every
 * legacy file is zero-filled (its `stat` size survives, its content does not), the
 * projects-layout pair is gone with its directory, and git never tracked them
 * (`.iknow/` is ignored). This script rebuilds a shape-faithful stand-in corpus to
 * §2's census and §4's pinned title lengths and reruns §9's procedure verbatim:
 * read bytes → `parseMemoryEntry` → `serializeMemoryEntry` → byte-compare → re-read
 * the produced form field-by-field → `computeSignature` stability.
 *
 * It measures; it does not assert §9's outcome. The only expectations it carries are
 * construction targets (§2's shape census, §1's byte sizes, §4's 101/89/84 long-fold
 * titles), and it fails loudly if the emitted bytes miss one — a silent fidelity gap
 * would make every number below meaningless.
 *
 * Privacy: every value is a synthetic stand-in; no real title, body, identifier or
 * memory text is read or printed.
 *
 * Run: npx tsx scripts/measure-frontmatter-corpus.ts [--keep]
 *      (--keep leaves the temp corpus on disk for inspection)
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSignature,
  parseMemoryEntry,
  serializeMemoryEntry,
} from "../src/harness/memory/frontmatter.js";

// -- construction targets (quoted from the evidence doc, not measured here) ----

/** §2: per-key shape classes over the 169 frontmatter lines, as label → count. */
const TARGET_KEY_SHAPES: Readonly<
  Record<string, Readonly<Record<string, number>>>
> = {
  id: { blank: 2, "unquoted/ascii len 9-24": 17 },
  type: { "unquoted/ascii len 1-8": 9, "unquoted/ascii len 9-24": 10 },
  importance: { integer: 19 },
  ttl_days: { integer: 19 },
  disabled: { boolean: 19 },
  supersedes: { "null-literal": 19 },
  title: {
    "unquoted/ascii len 9-24": 1,
    "unquoted/ascii len 25-40": 4,
    "unquoted/ascii len 40+": 5,
    "unquoted/cjk len 9-24": 4,
    "unquoted/cjk len 25-40": 1,
    "unquoted/cjk len 40+": 4,
  },
  updated_at: { "iso-datetime": 19 },
  source: { "unquoted/ascii len 1-8": 17 },
};

/** §2: value-length buckets over all 169 lines (a blank counts in the shortest). */
const TARGET_BUCKETS: Readonly<Record<string, number>> = {
  "1-8": 104,
  "9-24": 51,
  "25-40": 5,
  "40+": 9,
};

/** §1: 19 files, 169 frontmatter lines, 11 494 B = legacy 8 784 + projects 2 710. */
const TARGET_FILE_COUNT = 19;
const TARGET_LINE_COUNT = 169;
const TARGET_BYTES_LEGACY = 8784;
const TARGET_BYTES_PROJECTS = 2710;

/** §2 "absent from the whole corpus" row: each of these must measure 0. */
const TARGET_ABSENT_SHAPES = [
  "quoted values",
  'values containing ": "',
  "values containing #",
  "block scalars",
  "YAML lists",
  "CRLF",
];

/**
 * §4 shape 10: the three real long ascii titles are single-line plain scalars of
 * exactly 101 / 89 / 84 chars with break opportunities — the class `lineWidth: -1`
 * exists to stop folding. Kept at these exact lengths so a fold regression would
 * show up as a byte delta here rather than only in a unit test.
 */
const LONG_ASCII_TITLES: ReadonlyArray<readonly [string, number]> = [
  [
    "Shared yaml frontmatter module keeps skill index user catalog and memory reader on one parse path now",
    101,
  ],
  [
    "Quarantine a frontmatter block the strict reader cannot parse and keep the original bytes",
    89,
  ],
  [
    "Writer refuses a non-scalar unknown extra instead of dropping it from a stored entry",
    84,
  ],
];

/**
 * §4's other folding class: a long value with no break opportunity. One of the
 * four 40+ CJK titles carries no space at all, so even a default line width could
 * not have folded it.
 */
const NO_SPACE_CJK_TITLES: ReadonlyArray<string> = [
  "写入端拒绝非标量附加字段并保留磁盘上的原始字节以免静默丢失已经写入的记忆数据内容条目",
];

// -- corpus plan ---------------------------------------------------------------

type Layout = "legacy" | "projects";

/** The authored half of a stand-in entry: shapes and the size it must land on. */
interface PlanRow {
  readonly layout: Layout;
  /** §1's per-file whole-document byte size (survived the zero-fill). */
  readonly size: number;
  /** The two blank-`id` entries — §9's only known divergence class. */
  readonly blankId: boolean;
  readonly type: string;
  readonly importance: number;
  readonly ttlDays: number;
  readonly disabled: boolean;
  readonly title: string;
  readonly updatedAt: string;
  /** The unknown extra, present on exactly 17 files. */
  readonly source: string | null;
}

/** A plan row resolved onto the `id` string it writes. */
type Row = Omit<PlanRow, "blankId"> & { readonly id: string };

const ASCII_SHORT = "Prefer bar over foo";
const ASCII_25 = [
  "Use one tsconfig per package",
  "Gate bash writes with a ro bind",
  "Quarantine unreadable blocks",
  "Keep warnings content free",
];
const ASCII_40_REST = [
  "Atomic block rejection is louder than the old per-line parse",
  "A blank frontmatter value now reads back as a quoted empty scalar",
];
const CJK_9_24 = [
  "统一前置元数据解析",
  "写入端拒绝非标量附加字段",
  "隔离不可解析的前置块",
  "长标题保持单行不折叠写法",
];
const CJK_25_40 = "共享前置解析器让四种读取端在降级路径上保持一致的行为";
const CJK_40 = [
  ...NO_SPACE_CJK_TITLES,
  "memory frontmatter 的未知附加字段 现在会让写入被拒绝并留下一条告警记录",
  "统一四种读取端的 yaml 解析之后 写入端必须与读取端一致 否则文件会被隔离处理",
  "写入端与读取端共用同一份 yaml 解析之后 长标题不再被折行拆成两条记录 读取更稳",
];

/** `iso-datetime`, 24 chars — §2 puts every `updated_at` in the 9-24 bucket. */
function updatedAt(i: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `2026-${p(8 + (i % 2))}-${p(1 + (i % 27))}T${p(i % 24)}:${p((i * 7) % 60)}:${p((i * 13) % 60)}.000Z`;
}

/**
 * Synthetic 12-hex stem, also the entry's `id`. §2's `unquoted/ascii` class means
 * "reads back as a string", and a hex run can be a YAML number before it is a
 * name: `1e5850667870` resolves as a float exponent, so the reader handed back
 * `Infinity` and the round trip lost 4 bytes on a file §9 counts as identical.
 * Rejection-sample the stem so it can never be number-, bool- or null-shaped.
 */
const YAML_NON_STRING =
  /^([-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?|true|false|null|~|\.inf|\.nan|nan|0x[0-9a-fA-F]+|0o[0-7]+)$/;

function stem(i: number): string {
  for (let salt = 0; ; salt++) {
    const candidate = createHash("sha1")
      .update(`1137-standin-${i}-${salt}`)
      .digest("hex")
      .slice(0, 12);
    if (!YAML_NON_STRING.test(candidate)) return candidate;
  }
}

/**
 * The §2 census laid over §1's per-file sizes: the costliest titles go to the
 * largest files, so every body still has room. The two blank-`id` entries are also
 * the two entries without the `source` extra (§2 counts 17 of each; the damaged
 * corpus's pairing is unrecoverable, and no measured number depends on it).
 */
const PLAN: readonly PlanRow[] = [
  {
    layout: "legacy",
    size: 332,
    blankId: true,
    type: "note",
    importance: 2,
    ttlDays: 0,
    disabled: false,
    title: ASCII_SHORT,
    updatedAt: updatedAt(0),
    source: null,
  },
  {
    layout: "legacy",
    size: 409,
    blankId: true,
    type: "gotcha",
    importance: 3,
    ttlDays: 30,
    disabled: false,
    title: CJK_9_24[0],
    updatedAt: updatedAt(1),
    source: null,
  },
  {
    layout: "legacy",
    size: 411,
    blankId: false,
    type: "decision",
    importance: 1,
    ttlDays: 90,
    disabled: false,
    title: ASCII_25[0],
    updatedAt: updatedAt(2),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 421,
    blankId: false,
    type: "note",
    importance: 4,
    ttlDays: 365,
    disabled: false,
    title: CJK_9_24[1],
    updatedAt: updatedAt(3),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 426,
    blankId: false,
    type: "gotcha",
    importance: 2,
    ttlDays: 30,
    disabled: true,
    title: CJK_9_24[2],
    updatedAt: updatedAt(4),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 443,
    blankId: false,
    type: "decision",
    importance: 3,
    ttlDays: 0,
    disabled: false,
    title: ASCII_25[1],
    updatedAt: updatedAt(5),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 482,
    blankId: false,
    type: "note",
    importance: 5,
    ttlDays: 90,
    disabled: false,
    title: ASCII_25[2],
    updatedAt: updatedAt(6),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 489,
    blankId: false,
    type: "gotcha",
    importance: 1,
    ttlDays: 30,
    disabled: false,
    title: CJK_9_24[3],
    updatedAt: updatedAt(7),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 505,
    blankId: false,
    type: "decision",
    importance: 3,
    ttlDays: 365,
    disabled: false,
    title: ASCII_40_REST[0],
    updatedAt: updatedAt(8),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 521,
    blankId: false,
    type: "convention",
    importance: 4,
    ttlDays: 90,
    disabled: false,
    title: CJK_25_40,
    updatedAt: updatedAt(9),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 554,
    blankId: false,
    type: "constraint",
    importance: 2,
    ttlDays: 30,
    disabled: false,
    title: ASCII_40_REST[1],
    updatedAt: updatedAt(10),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 578,
    blankId: false,
    type: "convention",
    importance: 5,
    ttlDays: 0,
    disabled: false,
    title: LONG_ASCII_TITLES[2][0],
    updatedAt: updatedAt(11),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 578,
    blankId: false,
    type: "constraint",
    importance: 1,
    ttlDays: 90,
    disabled: true,
    title: CJK_40[2],
    updatedAt: updatedAt(12),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 592,
    blankId: false,
    type: "convention",
    importance: 3,
    ttlDays: 30,
    disabled: false,
    title: LONG_ASCII_TITLES[1][0],
    updatedAt: updatedAt(13),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 608,
    blankId: false,
    type: "constraint",
    importance: 4,
    ttlDays: 365,
    disabled: false,
    title: CJK_40[3],
    updatedAt: updatedAt(14),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 663,
    blankId: false,
    type: "convention",
    importance: 2,
    ttlDays: 90,
    disabled: false,
    title: CJK_40[1],
    updatedAt: updatedAt(15),
    source: "auto",
  },
  {
    layout: "legacy",
    size: 772,
    blankId: false,
    type: "constraint",
    importance: 5,
    ttlDays: 30,
    disabled: false,
    title: LONG_ASCII_TITLES[0][0],
    updatedAt: updatedAt(16),
    source: "auto",
  },
  {
    layout: "projects",
    size: 1455,
    blankId: false,
    type: "convention",
    importance: 3,
    ttlDays: 365,
    disabled: false,
    title: CJK_40[0],
    updatedAt: updatedAt(17),
    source: "auto",
  },
  {
    layout: "projects",
    size: 1255,
    blankId: false,
    type: "constraint",
    importance: 1,
    ttlDays: 0,
    disabled: true,
    title: ASCII_25[3],
    updatedAt: updatedAt(18),
    source: "auto",
  },
];

const ROWS: readonly Row[] = PLAN.map(({ blankId, ...rest }, i): Row => ({
  ...rest,
  id: blankId ? "" : stem(i),
}));

/** Body prose: plain ASCII markdown, so a byte budget and a char count agree. */
const BODY_LINES: readonly string[] = [
  "## Context",
  "",
  "Synthetic stand-in body written by the re-measurement harness. The entry it",
  "belongs to reproduces one shape class of the damaged corpus, and this text",
  "carries no meaning beyond filling the recorded byte size of that file.",
  "",
  "## Notes",
  "",
  "Read back through the shared fence strip, the body slice is taken verbatim,",
  "so nothing here is parsed, quoted or reordered by either side of the round",
  "trip. The last line is deterministic filler that absorbs the size remainder.",
];

// -- emitting the corpus -------------------------------------------------------

/** §2's length buckets; a blank value falls in the shortest one, per §2's header. */
function bucketOf(chars: number): string {
  if (chars <= 8) return "1-8";
  if (chars <= 24) return "9-24";
  if (chars <= 40) return "25-40";
  return "40+";
}

function charLen(value: string): number {
  return [...value].length;
}

/**
 * The legacy on-disk line form: `key: ` + value, and for a blank value the writer
 * of that era left the padding space behind (`"id: \n"`). No quotes, no folding.
 */
function frontmatterLine(key: string, value: string): string {
  return `${key}: ${value}\n`;
}

/** Key order pinned by ADR-0123's amendment: known fields, then the extra. */
function frontmatterOf(row: Row): string {
  const lines = [
    frontmatterLine("id", row.id),
    frontmatterLine("type", row.type),
    frontmatterLine("importance", String(row.importance)),
    frontmatterLine("ttl_days", String(row.ttlDays)),
    frontmatterLine("disabled", String(row.disabled)),
    frontmatterLine("supersedes", "null"),
    frontmatterLine("title", row.title),
    frontmatterLine("updated_at", row.updatedAt),
  ];
  if (row.source !== null) lines.push(frontmatterLine("source", row.source));
  return `---\n${lines.join("")}---\n`;
}

/** Body text of exactly `bytes` UTF-8 bytes (ASCII-only, no trailing newline). */
function bodyOfBytes(bytes: number): string {
  /** `"- "` plus one filler char; a pad line also costs its separating newline. */
  const MIN_PAD_LINE = 3;
  if (bytes < MIN_PAD_LINE)
    throw new Error(
      `no room for a ${bytes}-byte body — shape and size collide`
    );
  const lines: string[] = [];
  let used = 0;
  for (const line of BODY_LINES) {
    const cost = used === 0 ? line.length : line.length + 1;
    if (used + cost > bytes) break;
    lines.push(line);
    used += cost;
  }
  let rest = bytes - used;
  while (rest > 0 && rest < MIN_PAD_LINE + 1 && lines.length > 1) {
    used -= lines.pop()!.length + 1;
    rest = bytes - used;
  }
  if (rest > 0) {
    const filler = "0123456789abcdef"
      .repeat(Math.ceil((rest - 3) / 16))
      .slice(0, rest - 3);
    lines.push(`- ${filler}`);
  }
  return lines.join("\n");
}

interface WrittenFile {
  readonly path: string;
  readonly layout: Layout;
  readonly stem: string;
  readonly row: Row;
}

function writeCorpus(root: string): WrittenFile[] {
  const dirs: Record<Layout, string> = {
    // Pre-ADR-0099 workspace-root layout: <repo>/.iknow/memory/<project-slug>/
    legacy: join(root, ".iknow", "memory", "iknow-1137standin0"),
    // ADR-0099 layout: <dataDir>/projects/<project-slug>/memory/
    projects: join(root, ".iknow", "projects", "iknow-1137standin0", "memory"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });

  return ROWS.map((row, i) => {
    // A blank `id` still needs a filename, so the stem is generated for it too —
    // the mismatch between the file's name and its empty `id` is the §2 shape.
    const name = `${row.id === "" ? stem(i) : row.id}.md`;
    const head = frontmatterOf(row);
    const body = bodyOfBytes(row.size - Buffer.byteLength(head, "utf8"));
    const text = `${head}${body}`;
    if (Buffer.byteLength(text, "utf8") !== row.size) {
      throw new Error(
        `${row.layout} file ${i}: emitted ${Buffer.byteLength(text, "utf8")} B, target ${row.size} B`
      );
    }
    const path = join(dirs[row.layout], name);
    writeFileSync(path, text, "utf8");
    return { path, layout: row.layout, stem: name.slice(0, -3), row };
  });
}

// -- census of the emitted bytes ----------------------------------------------

/** One frontmatter line as written: key, raw value text, and the shape label. */
interface ObservedLine {
  readonly key: string;
  readonly value: string;
  readonly shape: string;
  readonly bucket: string;
}

const LINE_RE = /^([A-Za-z][A-Za-z0-9_-]*):\s?(.*)$/;

/** Everything measured off the emitted bytes, before a single line is parsed. */
interface Census {
  readonly lines: ObservedLine[];
  readonly absent: Record<string, number>;
  readonly trailingNewline: number;
}

function classify(value: string): { shape: string; bucket: string } {
  const bucket = bucketOf(charLen(value));
  if (value === "") return { shape: "blank", bucket };
  if (/^-?\d+$/.test(value)) return { shape: "integer", bucket };
  if (value === "true" || value === "false")
    return { shape: "boolean", bucket };
  if (value === "null") return { shape: "null-literal", bucket };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return { shape: "iso-datetime", bucket };
  const charset = /^[\x20-\x7E]*$/.test(value) ? "ascii" : "cjk";
  const quoted = /^["']/.test(value) ? "quoted" : "unquoted";
  return { shape: `${quoted}/${charset} len ${bucket}`, bucket };
}

/** One emitted value that §2 records as absent from the real corpus. */
function absentHits(value: string): string[] {
  const hits: string[] = [];
  if (/^["']/.test(value)) hits.push("quoted values");
  if (value.includes(": ")) hits.push('values containing ": "');
  if (value.includes("#")) hits.push("values containing #");
  if (/[|>]$/.test(value)) hits.push("block scalars");
  if (value.startsWith("- ") || value.startsWith("[")) hits.push("YAML lists");
  return hits;
}

function censusOf(files: WrittenFile[]): Census {
  const lines: ObservedLine[] = [];
  const absent: Record<string, number> = Object.fromEntries(
    TARGET_ABSENT_SHAPES.map((name) => [name, 0])
  );
  let trailingNewline = 0;
  let crlf = 0;
  for (const file of files) {
    const raw = readFileSync(file.path, "utf8");
    if (raw.endsWith("\n")) trailingNewline++;
    if (raw.includes("\r")) crlf++;
    for (const line of frontmatterLinesOf(raw, file.stem)) {
      const observed = observedLine(line);
      if (!observed)
        throw new Error(
          `${file.stem}: unpinnable line ${JSON.stringify(line)}`
        );
      lines.push(observed);
      for (const hit of absentHits(observed.value))
        absent[hit] = (absent[hit] ?? 0) + 1;
    }
  }
  absent["CRLF"] += crlf;
  return { lines, absent, trailingNewline };
}

function frontmatterLinesOf(raw: string, stem: string): string[] {
  const fence = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (!fence) throw new Error(`${stem}: emitted no fence`);
  return fence[1].split("\n");
}

function observedLine(line: string): ObservedLine | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const value = m[2];
  const { shape, bucket } = classify(value);
  return { key: m[1], value, shape, bucket };
}

function shapeCounts(
  lines: ObservedLine[]
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const line of lines) {
    out[line.key] ??= {};
    out[line.key][line.shape] = (out[line.key][line.shape] ?? 0) + 1;
  }
  return out;
}

function bucketCounts(lines: ObservedLine[]): Readonly<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const line of lines) out[line.bucket] = (out[line.bucket] ?? 0) + 1;
  return out;
}

// -- measurement (the §9 procedure) -------------------------------------------

interface FileResult {
  readonly layout: Layout;
  readonly stem: string;
  readonly idShape: string;
  readonly titleShape: string;
  readonly bytes: number;
  readonly rejected: boolean;
  readonly identical: boolean;
  readonly delta: number;
  readonly firstDiff: number;
  readonly changedNonBodyFields: number;
  readonly bodyChanged: boolean;
  readonly signatureStable: boolean;
  readonly warnings: number;
}

function firstDiffOffset(a: Buffer, b: Buffer): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) if (a[i] !== b[i]) return i;
  return shared;
}

function measure(files: WrittenFile[]): FileResult[] {
  return files.map(measureOne);
}

/** One file through §9's procedure: raw bytes → parse → serialize → re-parse. */
interface RoundTrip {
  readonly rejected: boolean;
  readonly outBytes: Buffer;
  readonly original: Record<string, unknown> | null;
  readonly reread: Record<string, unknown> | null;
  readonly captured: string[];
}

function roundTrip(raw: string): RoundTrip {
  const captured: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => {
    captured.push(String(message));
  };
  let rejected = false;
  let original: Record<string, unknown> | null = null;
  let reread: Record<string, unknown> | null = null;
  let outBytes = Buffer.alloc(0);
  try {
    const entry = parseMemoryEntry(raw);
    original = entry as unknown as Record<string, unknown>;
    outBytes = Buffer.from(serializeMemoryEntry(entry), "utf8");
    reread = parseMemoryEntry(outBytes.toString("utf8")) as unknown as Record<
      string,
      unknown
    >;
  } catch (error) {
    rejected = true;
    captured.push(`THROWN ${String(error)}`);
  } finally {
    console.warn = warn;
  }
  return { rejected, outBytes, original, reread, captured };
}

function fieldValue(raw: string, key: string): string {
  return new RegExp(`^${key}:\\s?(.*)$`, "m").exec(raw)?.[1] ?? "";
}

function countChangedFields(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null
): number {
  if (!a || !b) return -1;
  return Object.keys({ ...a, ...b }).filter(
    (key) => key !== "body" && JSON.stringify(a[key]) !== JSON.stringify(b[key])
  ).length;
}

function measureOne(file: WrittenFile): FileResult {
  const rawBytes = readFileSync(file.path);
  const raw = rawBytes.toString("utf8");
  const rt = roundTrip(raw);
  const identical = !rt.rejected && rawBytes.equals(rt.outBytes);
  return {
    layout: file.layout,
    stem: file.stem,
    idShape: classify(fieldValue(raw, "id")).shape,
    titleShape: classify(fieldValue(raw, "title")).shape,
    bytes: rawBytes.length,
    rejected: rt.rejected,
    identical,
    delta: rt.rejected ? 0 : rt.outBytes.length - rawBytes.length,
    firstDiff: rt.rejected ? -1 : firstDiffOffset(rawBytes, rt.outBytes),
    changedNonBodyFields: countChangedFields(rt.original, rt.reread),
    bodyChanged:
      rt.original !== null &&
      rt.reread !== null &&
      rt.original.body !== rt.reread.body,
    signatureStable:
      rt.original !== null &&
      rt.reread !== null &&
      computeSignature(rt.original as never) ===
        computeSignature(rt.reread as never),
    warnings: rt.captured.filter((line) => !line.startsWith("THROWN")).length,
  };
}

// -- printing ------------------------------------------------------------------

function table(
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[]
): string {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c)));
  const widths = headers.map((_, i) =>
    Math.max(...all.map((r) => (r[i] ?? "").length))
  );
  const line = (cells: readonly (string | number)[]) =>
    cells
      .map((cell, i) => String(cell).padEnd(widths[i] ?? 0))
      .join(" | ")
      .trimEnd();
  return [
    line(headers),
    widths.map((w) => "-".repeat(w)).join("-+-"),
    ...rows.map(line),
  ].join("\n");
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([shape, n]) => `${shape}=${n}`)
    .join(" ");
}

/** The corpus as written and measured, before any of it is printed. */
interface Corpus {
  readonly root: string;
  readonly files: WrittenFile[];
  readonly legacy: WrittenFile[];
  readonly projects: WrittenFile[];
  readonly census: Census;
  readonly perKey: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly perBucket: Readonly<Record<string, number>>;
  readonly results: FileResult[];
}

function bytesOf(set: WrittenFile[]): number {
  return set.reduce((sum, f) => sum + readFileSync(f.path).length, 0);
}

function buildCorpus(root: string): Corpus {
  const files = writeCorpus(root);
  const census = censusOf(files);
  return {
    root,
    files,
    legacy: files.filter((f) => f.layout === "legacy"),
    projects: files.filter((f) => f.layout === "projects"),
    census,
    perKey: shapeCounts(census.lines),
    perBucket: bucketCounts(census.lines),
    results: measure(files),
  };
}

function printCorpus(corpus: Corpus): void {
  console.log(
    `corpus  ${corpus.root}` +
      `\n        ${corpus.files.length} files (${corpus.legacy.length} legacy + ${corpus.projects.length} projects)` +
      `, ${corpus.census.lines.length} frontmatter lines` +
      `, ${bytesOf(corpus.files)} B total (${bytesOf(corpus.legacy)} legacy + ${bytesOf(corpus.projects)} projects)` +
      `, trailing-newline files=${corpus.census.trailingNewline}`
  );
}

function keyShapeRows(
  corpus: Corpus
): readonly (readonly (string | number)[])[] {
  return Object.keys(TARGET_KEY_SHAPES).map((key) => {
    const target = formatCounts(TARGET_KEY_SHAPES[key]!);
    const emitted = formatCounts(corpus.perKey[key] ?? {});
    return [key, target, emitted, target === emitted ? "yes" : "NO"];
  });
}

function keyShapesMatch(corpus: Corpus): boolean {
  return keyShapeRows(corpus).every((row) => row[3] === "yes");
}

function absentShapesClear(corpus: Corpus): boolean {
  return TARGET_ABSENT_SHAPES.every((name) => corpus.census.absent[name] === 0);
}

function bucketsMatch(corpus: Corpus): boolean {
  return (
    formatCounts(TARGET_BUCKETS) === formatCounts(corpus.perBucket) &&
    corpus.census.lines.length === TARGET_LINE_COUNT &&
    corpus.files.length === TARGET_FILE_COUNT &&
    bytesOf(corpus.legacy) === TARGET_BYTES_LEGACY &&
    bytesOf(corpus.projects) === TARGET_BYTES_PROJECTS
  );
}

function printFidelity(corpus: Corpus): void {
  console.log("\nreconstruction fidelity — emitted bytes vs evidence §1/§2\n");
  console.log(
    table(["key", "target (§2)", "emitted", "match"], keyShapeRows(corpus))
  );
  console.log(
    `\nlength buckets  target ${formatCounts(TARGET_BUCKETS)}  ` +
      `emitted ${formatCounts(corpus.perBucket)}  ${bucketsMatch(corpus) ? "match" : "MISMATCH"}`
  );
  console.log(
    `absent shapes   ${TARGET_ABSENT_SHAPES.map(
      (name) => `${name}=${corpus.census.absent[name]}`
    ).join("  ")}` + `  (target all 0)`
  );
}

function signed(delta: number): string {
  return delta >= 0 ? `+${delta}` : String(delta);
}

function resultLabel(r: FileResult): string {
  if (r.rejected) return "REJECTED";
  return r.identical ? "identical" : "rewritten";
}

function firstDiffLabel(r: FileResult): string | number {
  if (r.rejected || r.identical) return "-";
  return r.firstDiff;
}

function signatureLabel(r: FileResult): string {
  if (r.rejected) return "-";
  return r.signatureStable ? "stable" : "CHANGED";
}

function printPerFile(corpus: Corpus): void {
  console.log(
    "\nper-file round trip — read → parse → serialize → byte-compare\n"
  );
  console.log(
    table(
      [
        "layout",
        "file",
        "B",
        "id shape",
        "title shape",
        "result",
        "delta",
        "first diff",
        "sig",
        "warns",
      ],
      corpus.results.map((r) => [
        r.layout,
        r.stem,
        r.bytes,
        r.idShape,
        r.titleShape,
        resultLabel(r),
        r.rejected ? "-" : signed(r.delta),
        firstDiffLabel(r),
        signatureLabel(r),
        r.warnings,
      ])
    )
  );
}

function measuredRows(
  corpus: Corpus
): readonly (readonly (string | number)[])[] {
  const results = corpus.results;
  const n = (pred: (r: FileResult) => boolean) => results.filter(pred).length;
  const divergent = results.filter((r) => !r.rejected && !r.identical);
  return [
    [
      "files read back byte-identical",
      `${n((r) => r.identical)} / ${results.length}`,
    ],
    ["files a next save rewrites", `${divergent.length} / ${results.length}`],
    [
      "first differing byte offset in those",
      divergent.map((r) => r.firstDiff).join(", ") || "none",
    ],
    [
      "byte delta per rewritten file",
      [...new Set(divergent.map((r) => signed(r.delta)))].join(", ") || "none",
    ],
    [
      "blocks the reader rejects (parseMemoryEntry throws)",
      n((r) => r.rejected),
    ],
    [
      "non-body fields that change on re-read",
      n((r) => r.changedNonBodyFields > 0),
    ],
    ["body values that change on re-read", n((r) => r.bodyChanged)],
    [
      "computeSignature stability",
      `${n((r) => r.signatureStable)} / ${results.length}`,
    ],
    ["warnings emitted by the shared parse", n((r) => r.warnings > 0)],
  ];
}

function printMeasured(corpus: Corpus): void {
  console.log("\nmeasured (§9 procedure, this corpus)\n");
  console.log(table(["metric", "value"], measuredRows(corpus)));
}

function main(): number {
  checkConstruction();
  const root = mkdtempSync(join(tmpdir(), "iknow-frontmatter-corpus-"));
  try {
    const corpus = buildCorpus(root);
    printCorpus(corpus);
    printFidelity(corpus);
    printPerFile(corpus);
    printMeasured(corpus);
    if (process.argv.includes("--keep")) console.log(`\nkept corpus: ${root}`);
    const faithful =
      bucketsMatch(corpus) &&
      absentShapesClear(corpus) &&
      keyShapesMatch(corpus);
    return faithful ? 0 : 1;
  } finally {
    if (!process.argv.includes("--keep"))
      rmSync(root, { recursive: true, force: true });
  }
}

/** Guard the literals a §4/§2-faithful corpus depends on, before anything is written. */
function checkConstruction(): void {
  checkPlanTotals();
  checkPinnedTitles();
}

function checkPlanTotals(): void {
  const total = (layout: Layout) =>
    ROWS.filter((r) => r.layout === layout).reduce((sum, r) => sum + r.size, 0);
  if (ROWS.length !== TARGET_FILE_COUNT)
    throw new Error(
      `plan has ${ROWS.length} files, §1 has ${TARGET_FILE_COUNT}`
    );
  if (total("legacy") !== TARGET_BYTES_LEGACY)
    throw new Error(
      `legacy sizes total ${total("legacy")} B, §1 has ${TARGET_BYTES_LEGACY} B`
    );
  if (total("projects") !== TARGET_BYTES_PROJECTS)
    throw new Error(
      `projects sizes total ${total("projects")} B, §1 has ${TARGET_BYTES_PROJECTS} B`
    );
  if (ROWS.filter((r) => r.id === "").length !== 2)
    throw new Error("§2 has exactly two blank-id entries");
  if (ROWS.filter((r) => r.source !== null).length !== 17)
    throw new Error("§2 has the extra key on exactly 17 files");
}

function checkPinnedTitles(): void {
  for (const [title, chars] of LONG_ASCII_TITLES) {
    if (charLen(title) !== chars)
      throw new Error(
        `long ascii title is ${charLen(title)} chars, §4 pins ${chars}`
      );
    if (!/^[\x20-\x7E]+$/.test(title) || !title.includes(" "))
      throw new Error(
        `title ${JSON.stringify(title)} is not a spaced plain ascii run`
      );
  }
  for (const title of NO_SPACE_CJK_TITLES) {
    if (/\s/.test(title))
      throw new Error("the no-space CJK title must carry no break opportunity");
    if (charLen(title) <= 40)
      throw new Error("the no-space CJK title must sit in the 40+ bucket");
  }
  const titles = ROWS.map((r) => r.title);
  if (titles.some((t) => t.includes(": ") || t.includes("#")))
    throw new Error("a title carries a shape the real corpus never had");
}

process.exitCode = main();
