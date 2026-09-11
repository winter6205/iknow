/**
 * `--glob` 的 Node 引擎实现（D4；SC9 要求 Node 全语义）。
 *
 * 语义按 ripgrep 实测钉死（不是自创）：
 *   - **含 `/` 的模式锚定搜索根**：`src/*.ts` 只匹配根下 `src/` 里的一层。
 *   - **不含 `/` 的模式按基名匹配任意深度**：`*.ts` 匹配 `a.ts` 与 `x/y/a.ts`。
 *   - **`!` 前缀是否定**，与正模式并列时先收后剔。
 *   - `**` 跨段；`*` / `?` 段内通配。
 *
 * 这一层与 `argv.ts` 的 `--glob` 是同一契约的两条实现：rg 引擎交给 rg 自己
 * 判，Node 引擎走这里。两边判定不等价即 SC9 失败。
 */

import { ToolExecutionError } from "../../errors.js";

/**
 * glob 语法校验（**两条引擎共用**，故在解析层调用，见 `options.ts`）。
 *
 * 存在的理由与 SC9 同源：rg 对语法坏的 glob 是 rc=2 整次失败，不是「无匹配」。
 * 若只在 Node 引擎里把坏 glob 当字面量处理，同一个 `glob` 参数的成败就取决于
 * 哪条引擎在跑 —— 自带引擎在场时报错、起不来时静默回空。
 *
 * 实测钉死的规则（rg 15.1.0）：`[` 必须闭合；且**紧跟 `[`（或 `[!` / `[^`）
 * 的那个 `]` 是字面成员**，不算闭合 —— 所以 `[]]` 合法、`[]` 与 `[!]` 报
 * `unclosed character class`。
 */
export function assertValidGlob(glob: string): void {
  for (let i = 0; i < glob.length; i += 1) {
    if (glob[i] !== "[") continue;
    if (classAt(glob, i) === undefined) {
      throw new ToolExecutionError(
        `grep: invalid glob: ${glob} (unclosed character class; missing ']')`
      );
    }
  }
}

/** 判定一条相对路径是否被 glob 集合收下。 */
export function matchesGlobSet(
  relPath: string,
  globs: ReadonlyArray<string>
): boolean {
  const positives = globs.filter((g) => !g.startsWith("!"));
  const negatives = globs
    .filter((g) => g.startsWith("!"))
    .map((g) => g.slice(1));
  if (positives.length > 0 && !positives.some((g) => matchOne(relPath, g))) {
    return false;
  }
  return !negatives.some((g) => matchOne(relPath, g));
}

/** 单条 glob 匹配（`!` 由 `matchesGlobSet` 剥掉，这里只收正模式）。 */
export function matchOne(relPath: string, glob: string): boolean {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  const anchored = glob.includes("/");
  const pattern = glob.split("/").filter((s) => s.length > 0);
  if (!anchored) {
    const base = segments[segments.length - 1];
    if (base === undefined) return false;
    return matchSegments(pattern, 0)([base], 0);
  }
  return matchSegments(pattern, 0)(segments, 0);
}

/** `**` 跨段、其余段内匹配。返回「从 pattern[p] 起能否吃掉 segs[s..]」。 */
function matchSegments(
  pattern: ReadonlyArray<string>,
  p: number
): (segs: ReadonlyArray<string>, s: number) => boolean {
  return (segs, s) => {
    let pi = p;
    let si = s;
    while (pi < pattern.length) {
      const tok = pattern[pi]!;
      if (tok === "**") {
        while (pattern[pi] === "**") pi += 1;
        if (pi === pattern.length) return true;
        const rest = matchSegments(pattern, pi);
        for (let at = si; at <= segs.length; at += 1) {
          if (rest(segs, at)) return true;
        }
        return false;
      }
      if (si >= segs.length) return false;
      if (!matchToken(tok, segs[si]!)) return false;
      pi += 1;
      si += 1;
    }
    return si === segs.length;
  };
}

/** 段内 `*` / `?` / `[...]`。字符类区分大小写（与 rg 同口径）。 */
function matchToken(token: string, segment: string): boolean {
  let ti = 0;
  let si = 0;
  while (ti < token.length) {
    if (token[ti] === "*") return matchStar(token, ti, segment, si);
    const next = stepToken(token, ti, segment, si);
    if (next === null) return false;
    ti = next.ti;
    si = next.si;
  }
  return si === segment.length;
}

/** 消费一个非 `*` 的 token 单位；返回新下标，`null` = 该处不匹配。 */
function stepToken(
  token: string,
  ti: number,
  segment: string,
  si: number
): { readonly ti: number; readonly si: number } | null {
  const ch = token[ti]!;
  if (ch === "?") {
    return si < segment.length ? { ti: ti + 1, si: si + 1 } : null;
  }
  if (ch === "[") {
    const cls = classAt(token, ti);
    // 缺 `]` 的 `[` 不是字符类，落到下面的字面比较。
    if (cls !== undefined) {
      return si < segment.length && inClass(segment[si]!, cls.body)
        ? { ti: cls.next, si: si + 1 }
        : null;
    }
  }
  return si < segment.length && segment[si] === ch
    ? { ti: ti + 1, si: si + 1 }
    : null;
}

/** `*`：折叠连续 `*`，再用后缀去啃剩余 segment。 */
function matchStar(
  token: string,
  ti: number,
  segment: string,
  si: number
): boolean {
  let at = ti;
  while (token[at] === "*") at += 1;
  if (at === token.length) return true;
  for (let from = si; from <= segment.length; from += 1) {
    if (matchToken(token.slice(at), segment.slice(from))) return true;
  }
  return false;
}

/**
 * `[` 处读一段字符类；缺终止 `]` → `undefined`。
 *
 * 紧跟 `[`（或 `[!` / `[^`）的那个 `]` 是**字面成员**而不是终止符 ——
 * rg 的语法如此：`[]]` 合法（类里只有 `]`），`[]` 与 `[!]` 报 unclosed。
 */
function classAt(
  token: string,
  ti: number
): { readonly body: string; readonly next: number } | undefined {
  let i = ti + 1;
  if (token[i] === "!" || token[i] === "^") i += 1;
  if (token[i] === "]") i += 1;
  while (i < token.length && token[i] !== "]") i += 1;
  if (i === token.length) return undefined;
  // body 含 `!` / `^` 前缀：否定由 `inClass` 解读。
  return { body: token.slice(ti + 1, i), next: i + 1 };
}

/** 字符类：`[abc]` / `[a-z]` / `[!a-z]`。 */
function inClass(ch: string, cls: string): boolean {
  const negated = cls.startsWith("!") || cls.startsWith("^");
  const body = negated ? cls.slice(1) : cls;
  let hit = false;
  let i = 0;
  while (i < body.length) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (ch >= body[i]! && ch <= body[i + 2]!) hit = true;
      i += 3;
      continue;
    }
    if (body[i] === ch) hit = true;
    i += 1;
  }
  return negated ? !hit : hit;
}
