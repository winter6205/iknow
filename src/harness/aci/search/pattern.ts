/**
 * 主 pattern 编译（ADR-0089）。
 *
 * 合同收窄后的职责只有两条：
 *   - 把 `pattern` + `ignoreCase` 编译成 JS `RegExp`，坏正则 → typed 拒绝；
 *   - 给出「Node 侧要不要加 `u` flag」的判据（`keepsUnicodeMode`）。
 *
 * 本模块**只管 Node 路径**。rg 路径不读这里的任何判据：rg 按自己的默认
 * Unicode 语义跑，不加 `--no-unicode` 那类模式开关去凑与 JS 的一致 ——
 * 那是 ADR-0089 禁止的对齐杠杆。两条引擎因此可能对同一个 pattern 给出不同
 * 命中集，这是已接受的合同而非漏测。
 *
 * 两条引擎不再试图同判：rg 在场时匹配只出 rg，rg 自身的 pattern 错误由 rg
 * 子进程以 rc=2 报；rg 缺席时 Node 走 `RegExp` 扫文件，调用仍成功，命中集
 * 允许与 rg 不同 —— Node **不**模仿 rg 的默认引擎拒绝集。发布门是生产
 * handler `createGrepTool`，不是任何「两引擎同判」对齐 fuzz。
 *
 * `u` flag 的判据之所以仍留着：JS 无 `u` 时按 code unit 匹配，`.` / 计数
 * quantifier / 字符类在含多字节字符的行上会读错（实测 `a.c` 不匹配 `aéc`、
 * `^.{3}$` 不匹配 `e`+combining+`x`）。判据为 true 时先试加 `u`，这是
 * Node 侧的**语义修正**，不是跨引擎对齐。
 */

import { ToolExecutionError } from "../../errors.js";

/**
 * 编译主 pattern；坏正则 → typed 拒绝（消息含 pattern 原文）。
 *
 * `u` flag 只在 pattern 含多字节敏感构造时加（`keepsUnicodeMode`）——此时
 * JS 的 `.` / 计数 quantifier / 字符类才按 code point 匹配。这是 Node 路径
 * 自己的语义修正；rg 路径不读本判据，也不做任何对应开关（ADR-0089）。
 *
 * 加得上才加：`u` 会收紧语法，`{` / `]` / `\A` / `\q` / `\u` 一类在它下面
 * 编不过，所以**先试带 `u`，编不过退回不带 `u`** —— 接受集只增不减，
 * 不存在「今天能编、改完被拒」的 pattern。
 */
export function compilePattern(pattern: string, ignoreCase: boolean): RegExp {
  const base = ignoreCase ? "i" : "";
  if (keepsUnicodeMode(pattern)) {
    const unicode = tryCompile(pattern, `${base}u`);
    if (unicode !== null) return unicode;
  }
  const plain = tryCompile(pattern, base);
  if (plain !== null) return plain;
  throw new ToolExecutionError(`grep: invalid pattern: ${pattern}`);
}

/** 编得过就返回；编不过返回 null（由调用方决定退到哪一档）。 */
function tryCompile(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Node 侧编译要不要加 `u` flag —— 本模块**唯一**的模式判据，只作用于
 * `compilePattern`。
 *
 * `true`（含多字节敏感构造：`.` / `\s` / `\S` / `\u` / `\x` / 非 ASCII /
 * 否定类）→ Node 编译**加** `u`，否则 `.` / 计数 quantifier 停在 code unit 上
 * （实测 `a.c` 不匹配 `aéc`）。
 * `false` → Node 不加 `u`（加了反而把 KELVIN / LONG S 折进来，见下）。
 *
 * rg 侧**没有对应开关**：本判据不再投影到 rg argv。rg 一律按自己的默认
 * Unicode 语义跑（`\w` / `\d` / `\b` 认非 ASCII 词字符），Node 按 JS 语义
 * 跑 —— 同一个 pattern 的命中集因此可能不同，那是 ADR-0089 的合同。
 *
 * 取保守方向：**宁可不加，也不加坏**（`u` 会收紧语法，见 `compilePattern`
 * 的退回规则）。
 *
 * ignoreCase 的边界（实测，纯 Node 侧）：
 *   - `i` × `u` 会把 U+212A KELVIN / U+017F LONG S 折进 `k` / `s`（实测
 *     `new RegExp("k","iu").test("\\u212A")` 为 true）—— rg 默认的 simple
 *     case folding 也折（实测 `rg -i k` 命中 `Kx`），所以判据为 true 时加
 *     `u` 在 ignoreCase 下与 rg 同向。
 *     判据为 false 时 Node 不加 `u`，`-i k` 不折 KELVIN —— 这里 Node 比 rg
 *     窄，是已接受的命中集差异。
 *
 * 本判据**只**作用于 Node 侧编译的 `u` flag；rg 路径不读它，由 rg 子进程按
 * 自己的默认 Unicode 语义处理自己的 pattern 错误（rc=2）。两条引擎因此可能
 * 对同一个 pattern 给出不同命中集 —— 这是 ADR-0089 已接受的合同。
 */
export function keepsUnicodeMode(pattern: string): boolean {
  return hasMultiByteSensitiveConstruct(pattern);
}

/**
 * 扫描 pattern 里的「匹配单位可能是多字节字符」的构造 —— 命中即给 Node
 * 编译加 `u`。
 *
 * 两条**互不相干**的判据：
 *   - 转义类（`hasSensitiveEscape`）：`\s` / `\S` / `\u` / `\x` 在无 `u` 时
 *     含义会变；`\d` / `\w` / `\b` 一类**不算**（JS 在无 `u` 下已按 ASCII
 *     走，加 `u` 反而会折 KELVIN / LONG S）。转义与方括号无关（`[\s]` 同样
 *     敏感），故单独一趟扫；
 *   - 字面类（`hasSensitiveLiteral`）：`.` 与非 ASCII 字面量（无 `u` 时 `.`
 *     只吃一个 code unit）、`[^...]` / `[!...]`（否定类无 `u` 时按 code unit
 *     判）、`[...]` 内的非 ASCII 成员。
 */
function hasMultiByteSensitiveConstruct(pattern: string): boolean {
  return hasSensitiveEscape(pattern) || hasSensitiveLiteral(pattern);
}

/** `\s` / `\S` / `\u` / `\x` 出现即敏感（含类内）。先剥掉成对反斜杠，`\\s` 不算。 */
function hasSensitiveEscape(pattern: string): boolean {
  return /\\[sSux]/.test(pattern.replace(/\\\\/g, ""));
}

/** 逐字符走 `.` / 非 ASCII / 否定类 / 类内非 ASCII；`[...]` 状态由本趟维护。 */
function hasSensitiveLiteral(pattern: string): boolean {
  const chars = [...pattern];
  let inClass = false;
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === "\\") {
      i += 1; // 转义对整对跳过，`\.` 不算「点」
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      else if (isMultiByte(ch)) return true;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      const opened = openClass(chars, i);
      if (opened.sensitive) return true;
      i += opened.skip;
      continue;
    }
    if (isSensitiveLiteral(ch)) return true;
  }
  return false;
}

/**
 * `[...]` 起始处：否定类（`[^` / `[!`）无 `u` 时按 code unit 匹配 → 敏感；
 * `[]]` 的首个 `]` 是字面成员（rg 语法，见 glob-match 同源说明），要跳过。
 */
function openClass(
  chars: ReadonlyArray<string>,
  i: number
): { sensitive: boolean; skip: number } {
  if (chars[i + 1] === "^" || chars[i + 1] === "!") {
    return { sensitive: true, skip: 0 };
  }
  return { sensitive: false, skip: chars[i + 1] === "]" ? 1 : 0 };
}

function isSensitiveLiteral(ch: string): boolean {
  return ch === "." || isMultiByte(ch);
}

function isMultiByte(ch: string): boolean {
  return (ch.codePointAt(0) ?? 0) > 0x7f;
}
