/**
 * rg argv construction + language type-table unit tests.
 *
 * Invariants locked:
 *   - each output mode's argv shape (paths → `-l`; count → `--count`;
 *     content → `--line-number`).
 *   - `--null` always on (NUL carries the path delimiter, see rg-output.ts).
 *   - `context` becomes `-C N` only in content mode; paths / count never
 *     carry it.
 *   - `glob` / `type` take effect alongside `path` (orthogonal narrowing).
 *   - traversal semantics aligned with the Node scan: `--no-ignore` /
 *     `--hidden` / two exclusion globs / `--max-filesize` / `--crlf`
 *     (trade-offs documented in argv.ts's comments).
 *   - **no pattern-alignment switches handed to rg** (ADR-0089): neither
 *     `--engine=auto` nor `--no-unicode` appears in argv. Both were levers
 *     for "bending rg toward JS" — their absence is a regression pin, see
 *     the matching cases.
 *   - an unknown `type` is a typed error whose **message differs from a bad
 *     regex**'s.
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { ToolExecutionError } from "../../../../src/harness/errors.ts";
import {
  buildRgArgs,
  KNOWN_TYPE_SAMPLE,
} from "../../../../src/harness/aci/search/argv.ts";
import { MAX_TEXT_FILE_BYTES } from "../../../../src/harness/aci/search/file-lines.ts";
import { NEWLINE_PATH_EXCLUDES } from "../../../../src/harness/aci/search/path-representable.ts";
import {
  MAX_MATCH_LINE_COLUMNS,
  rgTransportBudgetBytes,
} from "../../../../src/harness/aci/search/rg-output.ts";
import { resolveTypeName } from "../../../../src/harness/aci/search/type-table.ts";
import { compilePattern } from "../../../../src/harness/aci/search/pattern.ts";
import type { QuerySpec } from "../../../../src/harness/aci/search/types.ts";

function spec(overrides: Partial<QuerySpec> = {}): QuerySpec {
  return {
    pattern: "hit",
    withinLines: 5,
    ignoreCase: false,
    output: "paths",
    context: 0,
    offset: 0,
    headLimit: 50,
    ...overrides,
  };
}

/** Search paths are fed in the **relative** production shape (cwd = workspace root, see rg-engine). */
function argv(specOverrides: Partial<QuerySpec> = {}): string[] {
  return buildRgArgs(spec(specOverrides), ".", 2000);
}

describe("buildRgArgs — 出法", () => {
  it("paths → -l（每个唯一文件一条）", () => {
    const args = argv({ output: "paths" });

    assert.ok(args.includes("-l"));
    // Output modes are exclusive: content / count flags must not leak in.
    assert.equal(args.includes("--line-number"), false);
    assert.equal(args.includes("--count"), false);
    // The tail is always `-- <pattern> <path>` (path relative to workspace per production convention).
    assert.deepEqual(args.slice(-3), ["--", "hit", "."]);
  });

  it("count → --count", () => {
    const args = argv({ output: "count" });

    assert.ok(args.includes("--count"));
    assert.equal(args.includes("-l"), false);
    assert.deepEqual(args.slice(-3), ["--", "hit", "."]);
  });

  it("`--engine=auto` 不在 argv 里：引擎方言不由本工具切换（ADR-0089）", () => {
    // Regression pin. Historically `--engine=auto` was always on here so rg
    // could drop to PCRE2 when the Rust default engine failed to compile,
    // bending the accept set toward JS `RegExp`. ADR-0089 abolished that
    // "both engines same verdict" contract: with rg present, matching comes
    // only from rg, and patterns rg itself cannot compile are reported by rg
    // with rc=2 (the handler maps them to `search engine rejected the
    // query`); with rg absent, Node uses JS `RegExp` and the hit set may
    // differ. `--engine=auto` is the sole switch of that retired alignment
    // path — if it returns, the rg path silently swaps engines again and
    // whether a pattern is accepted depends on this tool rather than rg itself.
    for (const output of ["content", "paths", "count"] as const) {
      assert.equal(
        argv({ output }).includes("--engine=auto"),
        false,
        `${output} 不得带 --engine=auto`
      );
    }
    // No pattern may bring it back, including look-arounds historically
    // accepted only thanks to it.
    for (const pattern of ["(?=hit)hit", "\\Z", "\\N", "\\h"]) {
      assert.equal(
        argv({ pattern }).includes("--engine=auto"),
        false,
        `${pattern} 不得带 --engine=auto`
      );
    }
  });

  it("`--no-unicode` 不在 argv 里：不把 rg 的类语义掰成 ASCII（ADR-0089）", () => {
    // Regression pin. Historically `--no-unicode` was added here per
    // `keepsUnicodeMode()` for `\d` / `\w` / `\b`-style patterns so rg's
    // Unicode classes degenerated to JS's ASCII measure. Same species of
    // lever as `--engine=auto`: using rg's switches to fabricate
    // "consistency" between the engines, at the cost of breaking rg's
    // **correct** Unicode behavior. Measured (rg 15.1.0, vendored binary):
    // `rg '\w'` matches CJK ideographs, `rg --no-unicode '\w'` does not;
    // `rg '\d'` matches Arabic-Indic digits, with the switch it does not. After ADR-0089 narrowed the
    // contract: rg runs its default Unicode semantics, Node runs JS
    // semantics, and the hit sets are **allowed to differ**. If this switch
    // returns, the rg path is bent back into an ASCII dialect and a
    // pattern's hit set depends on this tool rather than rg itself.
    for (const output of ["content", "paths", "count"] as const) {
      assert.equal(
        argv({ output }).includes("--no-unicode"),
        false,
        `${output} 不得带 --no-unicode`
      );
    }
    // No pattern may bring it back — including the very classes historically
    // switched through it.
    for (const pattern of ["\\d", "\\w+", "\\bfoo\\b", "[\\d]+", "hit"]) {
      assert.equal(
        argv({ pattern }).includes("--no-unicode"),
        false,
        `${pattern} 不得带 --no-unicode`
      );
    }
  });

  it("rg 专有 pattern 原样透传：本层不改写、不转义、不预判 JS 合法性（ADR-0089）", () => {
    // Regression pin. Constructs rg accepts but JS rejects (PCRE2 named
    // groups / inline flags / `\p{L}`) must reach rg **byte for byte**: if
    // this layer escaped or rewrote them, rg would not receive the user's
    // pattern; if `--engine=auto` returned, these patterns would silently
    // swap engines again. Together with "the rg path pre-judges no JS
    // legality" this is the other line of defense for one contract (the
    // other sits in the handler: the shared entry no longer calls
    // `compilePattern` unconditionally). The tail is per production
    // convention `-- <pattern> <path>` — assert the pattern segment is
    // byte-identical to the input.
    for (const pattern of ["(?P<n>foo)", "(?i)abc", "\\p{L}"]) {
      const args = argv({ pattern });
      assert.equal(args.at(-3), "--", `${pattern} 应位于 -- 之后`);
      assert.equal(args.at(-2), pattern, `${pattern} 应原样透传`);
    }
  });

  it("`-H` 常开：path 指向单文件时 rg 不再省掉文件名（两种引擎同形状）", () => {
    assert.ok(argv({ output: "content" }).includes("-H"));
    assert.ok(argv({ output: "paths" }).includes("-H"));
    assert.ok(argv({ output: "count" }).includes("-H"));
  });

  it("`--no-messages` 常开：文件级告警不升成整次查询失败", () => {
    // An unreadable neighboring file makes rg exit with rc=2; without this
    // flag stderr would be read as "query rejected" and fail the whole run,
    // while the Node engine merely skips that file.
    for (const output of ["content", "paths", "count"] as const) {
      assert.ok(argv({ output }).includes("--no-messages"));
    }
  });

  it("content → --line-number --no-heading + 超长行两道闸", () => {
    const args = argv({ output: "content" });

    assert.deepEqual(args.slice(0, 2), ["--line-number", "--no-heading"]);
    // The first gate is delegated to rg (otherwise a 1 MB line returns
    // intact), but its byte budget is `MAX_MATCH_LINE_COLUMNS × 4` (max
    // UTF-8 width per character) — at a budget equal to the code-point cap,
    // `hit` + 1000 copies of one 3-byte CJK character (3003 bytes / 1003
    // code points) would be truncated by
    // rg with its own omission marker while the projection layer's
    // code-point gate sees no overflow: the two engines would emit different
    // byte counts for one line. The assertion derives from constants rather
    // than hardcoding numbers.
    assert.ok(
      args.includes(
        `--max-columns=${String(
          rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS)
        )}`
      )
    );
    assert.ok(args.includes("--max-columns-preview"));
    // The budget must be **strictly greater** than the code-point cap, else
    // rg acts before the authoritative gate.
    assert.ok(
      rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS) > MAX_MATCH_LINE_COLUMNS
    );
  });

  it("content + context>0 → -C N（对称上下文）", () => {
    const args = argv({ output: "content", context: 2 });

    assert.ok(args.includes("-C"));
    assert.equal(args[args.indexOf("-C") + 1], "2");
  });

  it("paths / count 即便 context 有值也不带 -C（出法裁剪）", () => {
    assert.equal(argv({ output: "paths", context: 3 }).includes("-C"), false);
    assert.equal(argv({ output: "count", context: 3 }).includes("-C"), false);
  });
});

describe("buildRgArgs — 收窄（D4）", () => {
  it("ignoreCase → --ignore-case", () => {
    assert.ok(argv({ ignoreCase: true }).includes("--ignore-case"));
    assert.equal(argv({ ignoreCase: false }).includes("--ignore-case"), false);
  });

  it("glob → --glob <pattern>", () => {
    const args = argv({ glob: "*.ts" });

    // The narrowing flag sits alongside engine-level globs (the latter in the
    // ignore-semantics group); the user pattern must pass through untouched,
    // never squeezed or rewritten.
    assert.ok(args.includes("--glob"));
    assert.ok(args.includes("*.ts"));
    assert.equal(args[args.indexOf("--type")], undefined);
  });

  it("type → --type <name>", () => {
    const args = argv({ type: "ts" });

    assert.equal(args[args.indexOf("--type") + 1], "ts");
    // With type only, no user glob may materialize (engine-level exclusion
    // globs are a separate matter).
    assert.equal(args.includes("*.ts"), false);
  });

  it("glob 与 type 并列时同时带上（D4 两者是并列维度）", () => {
    const args = argv({ glob: "src/**", type: "ts" });

    assert.ok(args.includes("src/**"));
    assert.equal(args[args.indexOf("--type") + 1], "ts");
  });

  it("pattern 与搜索路径始终以 `--` 收尾（pattern 以 - 开头不被当 flag）", () => {
    const args = argv({ pattern: "-weird" });

    assert.equal(args[args.length - 3], "--");
    assert.equal(args[args.length - 2], "-weird");
    assert.equal(args[args.length - 1], ".");
  });
});

/**
 * Engine-level traversal semantics.
 *
 * The contract demands the two engines share one **accept set**: the same
 * directory tree with the same query must present rg and the Node scan the
 * same batch of files. By default rg reads `.gitignore` / `.ignore`, skips
 * hidden entries and git-ignored directories; Node's `walkFiles` only skips
 * `node_modules` / `.git`. Here the differences are flattened **once and for
 * all onto the Node measure** (`--no-ignore --hidden` + two exclusion
 * globs), rather than teaching Node gitignore syntax (negation / directory
 * scoping / hierarchical scoping would be a whole other tool's scope). See
 * the comments inside `argv.ts` for decision details.
 */
describe("buildRgArgs — 遍历语义与 Node 扫对齐（D6）", () => {
  it("--no-ignore 常开：.gitignore / .ignore 不改变接受集", () => {
    for (const output of ["paths", "content", "count"] as const) {
      assert.ok(
        argv({ output }).includes("--no-ignore"),
        `${output} 缺 --no-ignore`
      );
    }
  });

  it("--hidden 常开：点文件 / 点目录与 Node 扫同见", () => {
    assert.ok(argv({}).includes("--hidden"));
  });

  it("node_modules / .git 用排除 glob 表达（Node walkFiles 的跳过集）", () => {
    const args = argv({});

    assert.ok(args.includes("!**/node_modules"));
    assert.ok(args.includes("!**/.git"));
  });

  it("--max-filesize 取共享的体积常量（与 readWorkspaceLines 同源）", () => {
    assert.ok(
      argv({}).includes(`--max-filesize=${String(MAX_TEXT_FILE_BYTES)}`)
    );
  });

  it("--crlf 常开：CRLF 行按行边界处理（Node splitLines 同口径）", () => {
    assert.ok(argv({}).includes("--crlf"));
  });

  it("含 `\\n` 路径的排除 glob 常开：行协议拆不开的记录不进遍历", () => {
    // The exclude set shares one constant with `path-representable.ts` (the
    // whole subtree of a directory containing `\n` must go too — excluding
    // by basename alone would miss `a\nb/inner.txt`).
    const args = argv({});

    for (const glob of NEWLINE_PATH_EXCLUDES) {
      assert.ok(args.includes(glob), `缺排除 glob: ${JSON.stringify(glob)}`);
    }
  });

  it("用户 glob 不能撤销工具自带的 `!**/node_modules` / `!**/.git`（D2）", () => {
    // Ordering contract: user globs are submitted first, tool exclusions
    // last, so rg's last-glob-wins makes "skip node_modules / .git" the
    // final verdict. A narrowing user glob (`*.ts`) still works; a widening
    // one (`*` / `**`) never hands repo-internal dependency or git-config
    // files back to the model (measured: the old order let rg return 5 hits
    // where Node returned only 3).
    for (const userGlob of ["*", "**", "**/*", "{*,.*}"]) {
      const args = argv({ glob: userGlob });
      const excludeNodeModules = args.lastIndexOf("!**/node_modules");
      const excludeGit = args.lastIndexOf("!**/.git");
      const userGlobIndex = args.indexOf("--glob", excludeNodeModules);
      assert.ok(excludeNodeModules > args.indexOf("--glob"));
      assert.ok(excludeGit > excludeNodeModules);
      assert.ok(userGlobIndex > 0);
    }
    // User glob still passes through verbatim (not squeezed or rewritten).
    assert.ok(argv({ glob: "*.ts" }).includes("*.ts"));
  });
});

describe("resolveTypeName — 未知 type（SC10）", () => {
  it("已知类型原样返回", () => {
    assert.equal(resolveTypeName("ts"), "ts");
    assert.equal(resolveTypeName("py"), "py");
  });

  it("未知类型 → typed 拒绝，文案点名 type 与类型名、且不含 pattern", () => {
    assert.throws(
      () => resolveTypeName("nosuchtype"),
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        /type/.test(error.message) &&
        /nosuchtype/.test(error.message) &&
        !/pattern/.test(error.message)
    );
  });

  it("坏正则与未知 type 是两种 typed 错误，文案互不包含对方关键词（SC10）", () => {
    const messageOf = (fn: () => unknown): string => {
      try {
        fn();
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    // Both are **real** compiler artifacts, not hand-copied expectation strings.
    const typeError = messageOf(() => resolveTypeName("nosuchtype"));
    const regexError = messageOf(() => compilePattern("(unclosed", false));

    assert.notEqual(typeError, "");
    assert.notEqual(regexError, "");
    // Not collapsible into one "illegal regex" kind: each keyword is absent from the other's message.
    assert.equal(
      /pattern/.test(typeError),
      false,
      `type error leaked pattern: ${typeError}`
    );
    assert.equal(
      /type/.test(regexError),
      false,
      `regex error leaked type: ${regexError}`
    );
    // And each must name its own failure domain.
    assert.ok(/type/.test(typeError));
    assert.ok(/pattern/.test(regexError));
  });

  it("KNOWN_TYPE_SAMPLE 覆盖常用语言且不含空串", () => {
    for (const name of ["ts", "js", "py", "rust", "go", "md", "json"]) {
      assert.ok(KNOWN_TYPE_SAMPLE.includes(name), `${name} missing`);
    }
    assert.equal(KNOWN_TYPE_SAMPLE.includes(""), false);
  });
});
