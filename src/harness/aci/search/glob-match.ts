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
 * `unclosed character class`。`{` 同理必须闭合（`{a,b` 报 unclosed alternate
 * group），独立的 `}` 报 unopened alternate group；`\{` / `\}` 是字面。
 *
 * 校验与展开共用同一个扫描器（`expandGlob`）—— 否则「校验放行的语法」与
 * 「匹配认得的语法」会各长一套，SC9 的等价性就没人守了。
 */
export function assertValidGlob(glob: string): void {
  expandGlob(glob);
}

/**
 * 判定一条相对路径是否被 glob 集合收下。
 *
 * 裸 `!`（剥掉否定记号后什么都不剩）是**不选中任何文件**，不是「全收」：
 * 实测 rg 15.1.0 单条 `--glob '!'` rc=1，与 `--glob '!*'`（否定一切）同结果。
 * 空模式只能匹配空路径，而候选路径都非空 —— 所以它作为否定不剔任何文件、
 * 作为肯定不选任何文件。旧实现把 `!` 剥成空串当肯定模式，`matchOne` 拿空
 * 段的模式去比真实路径恰好全不中，却在**集合语义**上退化成「没有肯定模式
 * → 全收」，于是 `glob: "!"` 在 Node 路径列出全仓、rg 路径回空（Finding 3）。
 */
export function matchesGlobSet(
  relPath: string,
  globs: ReadonlyArray<string>
): boolean {
  // 裸 `!` 让整组不再收下任何路径：它是**空模式**，rg 实测单条 `--glob '!'`
  // rc=1（同树的 `--glob '!*'` 也是 rc=1）。不能靠「空模式匹配空串」在
  // `matchOne` 里自然落到 false —— 集合语义下没有肯定模式会默认全收，裸 `!`
  // 因此反转成「列全仓」（Finding 3）。
  // 可达性：工具面只暴露单个 `glob` 参数，喂进来的就是这**一条**模式，
  // 「裸 `!` 与其它 glob 并列」的形状从工具表面走不到；留在这里是因为
  // `matchesGlobSet` 是集合语义的通用实现（`node-scan` 也按集合喂）。
  if (globs.some((g) => g === "!")) return false;
  const positives = globs.filter((g) => !isNegation(g));
  const negatives = globs.filter((g) => isNegation(g)).map((g) => g.slice(1));
  if (positives.length > 0 && !positives.some((g) => matchOne(relPath, g))) {
    return false;
  }
  return !negatives.some((g) => matchesNegation(relPath, g));
}

/**
 * 否定模式的匹配（**与正模式不同**，别复用 `matchOne`）。
 *
 * 差别只在尾随 `/`：正模式 `sub/` 一个文件都不选（空段只能匹配空名字），
 * 而否定模式 `!sub/` 会把 `sub` 这个**目录整棵子树**剔掉（实测 15.1.0：
 * `--glob '!sub/'` 剔掉 `sub/c.ts` 与 `sub/deep/d.ts`）。这与 gitignore 的
 * 「目录限定」同源 —— rg 对否定 glob 走的是目录剪枝，不是逐文件匹配。
 *
 * 祖先前缀（不含最后一段 = 文件本身）逐个过匹配器，因此
 *   - 单星尾斜杠只剔「有一层以上目录」的路径（根级文件留下），
 *   - 双星尾斜杠剔掉所有非根级路径，
 *   - `!a.ts/` 不剔任何东西（没有叫 `a.ts/` 的祖先目录）。
 * 三条都与 rg 实测一致。
 */
function matchesNegation(relPath: string, glob: string): boolean {
  if (!glob.endsWith("/")) return matchOne(relPath, glob);
  const dirGlob = glob.slice(0, -1);
  // `!/` → 目录模式为空，剔不掉任何东西（rg 实测：结果与无 glob 相同）。
  if (dirGlob.length === 0) return false;
  const segments = relPath.split("/").filter((s) => s.length > 0);
  for (let depth = 1; depth < segments.length; depth += 1) {
    if (matchOne(segments.slice(0, depth).join("/"), dirGlob)) return true;
  }
  return false;
}

/**
 * `!` 开头的否定形态；`\!` 是转义后的字面 `!`，仍是肯定模式。
 *
 * 实测 rg 15.1.0：`--glob '!bang.ts'` 不剔 `!bang.ts`（回全仓），
 * `--glob '\!bang.ts'` 只回 `!bang.ts` —— 转义的 `!` 是字面字符。
 */
function isNegation(glob: string): boolean {
  return glob.startsWith("!") && !glob.startsWith("\\!");
}

/** 单条 glob 匹配（`!` 由 `matchesGlobSet` 剥掉，这里只收正模式）。 */
export function matchOne(relPath: string, glob: string): boolean {
  const segments = relPath.split("/").filter((s) => s.length > 0);
  const base = segments[segments.length - 1];
  if (base === undefined) return false;
  // 锚定是**整条模式**的性质：只要原文里有 `/`（哪怕它在某个 brace 备选里、
  // 或是单个前导 `/`）就锚定搜索根，否则按基名匹配任意深度。实测：
  //   `zz.ts` 命中 sub/zz.ts；`{sub/nope,zz}.ts` 不命中（整体锚定）；
  //   `{a,sub/only}.ts` 同时命中根下 a.ts 与 sub/only.ts（「/」在备选里，
  //   备选本身按「整条锚定」的段序列解释）。
  const anchored = glob.includes("/");
  // 单个前导 `/` 是「从搜索根起」的记法，且**只认整条模式的第一个字符**：
  // `/*.ts` 命中根下 .ts，`//a.ts` 不命中（第二个 `/` 是空段，不匹配任何
  // 真实名字）；`{sub,/}z.ts` 里的 `/` 不是首字符，只是字面分隔符，所以
  // `/z.ts` 那条备选要求路径里真的有个空段 —— 实测 rc=1。
  const normalized = glob.startsWith("/") ? glob.slice(1) : glob;
  for (const expanded of expandGlob(normalized)) {
    // 空段一律保留为「不可匹配」：尾随 `/`（`sub/`、`*/`、`a.ts/`）在 rg 里
    // **一个文件都不选**（实测 15.1.0，单条 glob 与否定形态都一样），与中间
    // 空段（`a//b`）同因 —— 空段只能匹配空名字。旧实现把尾随空段 pop 掉，
    // 于是 `sub/` 退化成 `sub`、`*/` 退化成 `*`，在 Node 路径收下一整个仓库，
    // 而 rg 路径回空（Finding 3）。
    const pattern = expanded.split("/");
    const matched = anchored
      ? matchSegments(pattern, 0)(segments, 0)
      : matchSegments(pattern, 0)([base], 0);
    if (matched) return true;
  }
  return false;
}

/**
 * brace 展开：`{a,b}` 产出一条备选，可嵌套、可多组（笛卡尔积）。
 *
 * 语义按 rg 15.1.0 实测钉死，扫描与校验共用本函数（`assertValidGlob` 调它，
 * 形态坏即 typed 拒绝）：
 *   - `{a,b}` 交替；`{ts}` 单元素也展开（等价于 `ts`）；`{}` 展开为空串，
 *     即匹配空模式、不产文件（实测 `{}` rc=1、`a{}b` 命中 `ab`）。
 *   - 空备选被丢弃：`{a,}` ≡ `{a}`，`{,}` ≡ 无备选（整条不匹配）。
 *   - **不是** shell 的区间展开：`{1..3}` / `{a..c}` 当字面量（实测不命中
 *     任何文件、rc=1）。
 *   - 嵌套：`{a,{b,c}}` → a / b / c。
 *   - `\` 转义：`\{` / `\}` / `\,` 是字面字符（`a\{b` 命中 `a{b`）。
 *   - 字符类里的花括号是**字面成员**：`[{]` 不是交替组。
 *   - `{` 缺 `}` → unclosed alternate group；`}` 无 `{` → unopened。
 *
 * 返回**未做段切分**的候选原文（可能仍含 `/`）；空数组 = 该模式匹配空集。
 */
export function expandGlob(glob: string): string[] {
  const out: string[] = [];
  expandInto(glob, 0, "", out);
  return out;
}

/** 扫描一步的产物：要么吃进一段字面量，要么撞上一个交替组。 */
type ScanStep =
  | { readonly kind: "literal"; readonly text: string; readonly next: number }
  | {
      readonly kind: "group";
      readonly alternatives: ReadonlyArray<string>;
      readonly tailFrom: number;
    };

/**
 * 单层扫描：把 `glob[from..]` 的展开结果接到 `prefix` 上。
 *
 * 每个字符只做一次判定（判定本身在 `scanStep`），本函数只负责把「字面量」
 * 累积、把「交替组」展开成笛卡尔积。语法错误在 `scanStep` 抛出。
 */
function expandInto(
  glob: string,
  from: number,
  prefix: string,
  out: string[]
): void {
  let literal = prefix;
  let i = from;
  while (i < glob.length) {
    const step = scanStep(glob, i);
    if (step.kind === "literal") {
      literal += step.text;
      i = step.next;
      continue;
    }
    for (const alt of step.alternatives) {
      // 备选内部**递归**展开（嵌套 brace），尾串在同一层继续（多组笛卡尔积）。
      const heads: string[] = [];
      expandInto(literal + alt, 0, "", heads);
      for (const head of heads) expandInto(glob, step.tailFrom, head, out);
    }
    return;
  }
  out.push(literal);
}

/** 扫描一步：转义 / 字符类 / 交替组 / 单字符字面量（`{` 未闭合与裸 `}` 在此拒绝）。 */
function scanStep(glob: string, i: number): ScanStep {
  const ch = glob[i]!;
  if (ch === "\\") return escapeStep(glob, i);
  if (ch === "[") return classStep(glob, i);
  if (ch === "}") {
    throw new ToolExecutionError(
      `grep: invalid glob: ${glob} (unopened alternate group; missing '{')`
    );
  }
  if (ch === "{") return groupStep(glob, i);
  return { kind: "literal", text: ch, next: i + 1 };
}

/**
 * 转义**原样保留**（`\{` 留作 `\{`）：段内匹配器要能区分「字面 `*`」与
 * 「通配 `*`」——`star\*` 命中名为 `star*` 的文件，`star*` 不是。展开层只
 * 负责不把被转义的字符误判为分组 / 类边界。
 */
function escapeStep(glob: string, i: number): ScanStep {
  const next = glob[i + 1];
  return next === undefined
    ? { kind: "literal", text: "\\", next: i + 1 }
    : { kind: "literal", text: `\\${next}`, next: i + 2 };
}

function classStep(glob: string, i: number): ScanStep {
  const cls = classAt(glob, i);
  if (cls === undefined) {
    throw new ToolExecutionError(
      `grep: invalid glob: ${glob} (unclosed character class; missing ']')`
    );
  }
  return { kind: "literal", text: glob.slice(i, cls.next), next: cls.next };
}

function groupStep(glob: string, i: number): ScanStep {
  const close = matchingBrace(glob, i);
  if (close === -1) {
    throw new ToolExecutionError(
      `grep: invalid glob: ${glob} (unclosed alternate group; missing '}')`
    );
  }
  // 空备选**保留**（代表空串，不是「丢弃」）：`a{}b` 命中 `ab`、
  // `a{,}b` 也命中 `ab`；`{}` 展开成空模式，因此不命中任何真实文件名。
  return {
    kind: "group",
    alternatives: splitAlternatives(glob.slice(i + 1, close)),
    tailFrom: close + 1,
  };
}

/**
 * `{` 的配对 `}` 下标（跳过 `\` 转义与字符类）；无配对 → -1。
 * 嵌套按深度计数，所以 `{a,{b,c}}` 的外层拿到最后一个 `}`。
 */
function matchingBrace(glob: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      const cls = classAt(glob, i);
      i = cls === undefined ? i + 1 : cls.next;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** 顶层 `,` 切分（跳过转义 / 字符类 / 嵌套 brace）。 */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") {
      const cls = classAt(body, i);
      i = cls === undefined ? i + 1 : cls.next;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(body.slice(start));
  return parts;
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
  if (ch === "\\") return escapeTokenStep(token, ti, segment, si);
  if (ch === "?") return consumeOne(ti + 1, si, segment);
  if (ch === "[") {
    const cls = classAt(token, ti);
    // 缺 `]` 的 `[` 不是字符类，落到下面的字面比较。
    if (cls !== undefined) {
      const hit = si < segment.length && inClass(segment[si]!, cls.body);
      return hit ? { ti: cls.next, si: si + 1 } : null;
    }
  }
  const hit = si < segment.length && segment[si] === ch;
  return hit ? { ti: ti + 1, si: si + 1 } : null;
}

/** 转义：下一字符按字面比（`\*` 只吃字面 `*`，`\[` 只吃字面 `[`）。 */
function escapeTokenStep(
  token: string,
  ti: number,
  segment: string,
  si: number
): { readonly ti: number; readonly si: number } | null {
  const next = token[ti + 1];
  if (next === undefined) {
    const hit = si < segment.length && segment[si] === "\\";
    return hit ? { ti: ti + 1, si: si + 1 } : null;
  }
  const hit = si < segment.length && segment[si] === next;
  return hit ? { ti: ti + 2, si: si + 1 } : null;
}

/** 前进一格；越界（segment 已耗尽）→ `null`。 */
function consumeOne(
  ti: number,
  si: number,
  segment: string
): { readonly ti: number; readonly si: number } | null {
  return si < segment.length ? { ti, si: si + 1 } : null;
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
