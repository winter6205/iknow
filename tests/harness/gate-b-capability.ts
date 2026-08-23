/**
 * Gate B capability scanner (tests only).
 *
 * 守的是 conditional remediation 能力不进 harness 可执行面：
 * 自动重试 / checkpoint 落盘 / token-cost 护栏 / OTel 导出 / 把 session-api 拖进内核。
 * 用 TypeScript AST：标识符与字符串（含 import 路径、模板）会扫；注释 / JSDoc / 正则字面量不扫。
 *
 * 永不抛错。未闭合 `/*` EXIT：其余当作注释，不进入 AST 标识符。
 */
import ts from "typescript";

export interface GateBViolation {
  readonly line: number;
  readonly keyword: string;
  readonly snippet: string;
}

const RULES: ReadonlyArray<{
  keyword: string;
  match: (lower: string) => boolean;
}> = [
  { keyword: "retry", match: (s) => s.includes("retry") },
  { keyword: "checkpoint", match: (s) => s.includes("checkpoint") },
  {
    keyword: "costusd",
    match: (s) =>
      s.includes("costusd") ||
      s.includes("cost_usd") ||
      s.includes("costtracker"),
  },
  {
    keyword: "otel",
    match: (s) =>
      s.includes("opentelemetry") ||
      /(?:^|[^a-z0-9])otel(?:[^a-z0-9]|$)/.test(s),
  },
  { keyword: "session-api", match: (s) => s.includes("session-api") },
];

function executableTexts(
  sf: ts.SourceFile
): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  const add = (node: ts.Node, text: string): void => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ line: line + 1, text });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) add(node, node.text);
    else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      add(node, node.text);
    } else if (
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      add(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function findGateBViolations(source: string): GateBViolation[] {
  const sf = ts.createSourceFile(
    "gate-b-scan.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const sourceLines = source.split(/\r?\n/);
  const violations: GateBViolation[] = [];
  const seen = new Set<string>();
  for (const piece of executableTexts(sf)) {
    const lower = piece.text.toLowerCase();
    const snippet = sourceLines[piece.line - 1]?.trim() ?? piece.text;
    for (const rule of RULES) {
      if (!rule.match(lower)) continue;
      const key = `${piece.line}:${rule.keyword}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({
        line: piece.line,
        keyword: rule.keyword,
        snippet,
      });
    }
  }
  return violations;
}
