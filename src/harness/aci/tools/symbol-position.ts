/**
 * Identifier position recovery for flat `textDocument/documentSymbol`
 * responses.
 *
 * **Why it exists**: a server may answer the symbol query with the flat
 * `SymbolInformation[]` form (no `children`, no `selectionRange`), whose
 * `location.range.start` is the declaration line start — the `export` / `def`
 * keyword, column 0 — not the identifier. Feeding that column to a
 * position-based request (`hover`, `definition`, `rename`) lands nowhere
 * useful, so the identifier column has to be recovered from the document text
 * itself.
 *
 * This module owns exactly that recovery: given a name, a reported range, and
 * the document text, return the identifier's position, or `undefined` when no
 * single trustworthy position exists. It performs no I/O and knows no LSP
 * client — the caller reads and caches the text — so the policy stays a pure,
 * testable function.
 *
 * The policy is deliberately conservative: the reported range is searched for
 * the name as a whole token (never a substring of a longer identifier) that is
 * real code (not inside a comment or a string literal), and only an
 * unambiguous hit is accepted. Guessing the first match would aim a rename or
 * a hover at the wrong symbol — worse than reporting no position at all.
 */

/** LSP 0-based position (line/character both 0-based, per protocol). */
export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

/** A node's reported source range. Both `DocumentSymbol.range` and
 *  `SymbolInformation.location.range` carry `start` + `end`; `selectionRange`
 *  covers only the identifier itself. */
export interface IdentifierRange {
  readonly start?: LspPosition;
  readonly end?: LspPosition;
}

/** Refuse to scan a flat range wider than this many lines: a malformed server
 *  range must never turn into an unbounded line walk. */
const MAX_SCAN_LINES = 200;

/** Identifier characters, matching the token set of the languages these
 *  servers answer for. A name bounded by these on both sides is a whole token,
 *  not a fragment of a longer identifier. */
function isTokenChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

/** `undefined` is not a position; only a finite, non-negative integer on both
 *  axes is. NaN / Infinity / fractions / negatives are how a malformed server
 *  payload announces itself. */
export function isWellFormedPosition(
  position: LspPosition | undefined
): position is LspPosition {
  return (
    position !== undefined &&
    Number.isInteger(position.line) &&
    position.line >= 0 &&
    Number.isInteger(position.character) &&
    position.character >= 0
  );
}

interface ScanState {
  mode: "code" | "line" | "block" | "string";
  quote: string;
  line: number;
  readonly name: string;
  readonly hits: LspPosition[];
}

function setMode(state: ScanState, mode: ScanState["mode"]): void {
  state.mode = mode;
  state.quote = "";
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

function startsLineComment(source: string, i: number): boolean {
  return source[i] === "#" || (source[i] === "/" && source[i + 1] === "/");
}

function startsBlockComment(source: string, i: number): boolean {
  return source[i] === "/" && source[i + 1] === "*";
}

function endsBlockComment(source: string, i: number): boolean {
  return source[i] === "*" && source[i + 1] === "/";
}

function isTokenBounded(source: string, name: string, i: number): boolean {
  return !isTokenChar(source[i - 1]) && !isTokenChar(source[i + name.length]);
}

/** Per-mode branches keep each transition rule inspectable in isolation. */
function advanceCode(source: string, i: number, state: ScanState): number {
  const ch = source[i]!;
  if (startsLineComment(source, i)) {
    setMode(state, "line");
    return i + 1;
  }
  if (startsBlockComment(source, i)) {
    setMode(state, "block");
    return i + 2;
  }
  if (isQuote(ch)) {
    state.mode = "string";
    state.quote = ch;
    return i + 1;
  }
  if (
    source.startsWith(state.name, i) &&
    isTokenBounded(source, state.name, i)
  ) {
    state.hits.push({ line: state.line, character: i });
  }
  return i + 1;
}


function advanceBlock(source: string, i: number, state: ScanState): number {
  if (endsBlockComment(source, i)) {
    setMode(state, "code");
    return i + 2;
  }
  return i + 1;
}


function advanceString(source: string, i: number, state: ScanState): number {
  const ch = source[i]!;
  if (ch === "\\") return i + 2;
  if (ch === state.quote) setMode(state, "code");
  return i + 1;
}

/** One character step of the comment/string state machine, returning the next
 *  index. */
function advance(source: string, i: number, state: ScanState): number {
  switch (state.mode) {
    case "code":
      return advanceCode(source, i, state);
    case "block":
      return advanceBlock(source, i, state);
    case "string":
      return advanceString(source, i, state);
    case "line":
      return source.length;
  }
}

/** Scan one line, carrying the comment/string mode in `state`; a line comment
 *  never survives past the newline. */
function scanLine(source: string, state: ScanState): void {
  let i = 0;
  while (i < source.length) i = advance(source, i, state);
  if (state.mode === "line") setMode(state, "code");
}

/** End line of the reported range, or `undefined` when `end` is malformed or
 *  ordered before `start` (reversed bounds). */
function endLine(end: LspPosition, start: LspPosition): number | undefined {
  if (!isWellFormedPosition(end)) return undefined;
  if (end.line < start.line) return undefined;
  if (end.line === start.line && end.character < start.character)
    return undefined;
  return end.line;
}

/** The line span to scan: the reported range's lines, or `undefined` when the
 *  range is malformed (not an object, bad `start`, reversed, out of bounds on
 *  the start line, or wider than the scan cap). */
function scanSpan(
  range: IdentifierRange | undefined,
  lines: ReadonlyArray<string>
): { from: number; to: number } | undefined {
  if (!range || typeof range !== "object") return undefined;
  const start = range.start;
  if (!isWellFormedPosition(start)) return undefined;
  const startLine = lines[start.line];
  if (startLine === undefined || start.character > startLine.length)
    return undefined;
  const to = range.end === undefined ? start.line : endLine(range.end, start);
  if (to === undefined) return undefined;
  if (to - start.line + 1 > MAX_SCAN_LINES) return undefined;
  return { from: start.line, to };
}

/**
 * Recover the identifier's position inside the reported range of a flat node.
 * `undefined` unless exactly one whole-token occurrence of `name` lies in real
 * code within those lines — zero matches, several matches, comments, strings,
 * an in-range substring of a longer identifier, a malformed or over-wide
 * range, and a line beyond the document all yield no usable position.
 */
export function locateIdentifierInRange(
  name: string,
  range: IdentifierRange | undefined,
  text: string
): LspPosition | undefined {
  if (name.length === 0) return undefined;
  const lines = text.split("\n");
  const span = scanSpan(range, lines);
  if (!span) return undefined;
  const state: ScanState = {
    mode: "code",
    quote: "",
    line: span.from,
    name,
    hits: [],
  };
  for (let line = span.from; line <= span.to && state.hits.length < 2; line++) {
    state.line = line;
    scanLine(lines[line] ?? "", state);
  }
  if (state.hits.length !== 1) return undefined;
  const hit = state.hits[0]!;
  const lineText = lines[hit.line];
  if (lineText === undefined || hit.character > lineText.length)
    return undefined;
  return hit;
}
