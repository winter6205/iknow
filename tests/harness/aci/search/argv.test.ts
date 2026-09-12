/**
 * rg argv 构造 + 语言类型词表单测（SC12「argv 构造」；契约 D4；SC10）。
 *
 * 锁的不变式：
 *   - 三种出法各自的 argv 形状（paths → `-l`；count → `--count`；
 *     content → `--line-number`）。
 *   - `--null` 常开（路径分隔符由 NUL 承担，见 rg-output.ts）。
 *   - `context` 只在 content 出法转成 `-C N`；`paths` / `count` 不带。
 *   - `glob` / `type` 与 `path` 并列生效（D4）。
 *   - 遍历语义与 Node 扫对齐：`--no-ignore` / `--hidden` / 两条排除 glob /
 *     `--max-filesize` / `--crlf`（D6 / SC9；取舍见 argv.ts 注释）。
 *   - **不给 rg 任何模式对齐开关**（ADR-0089）：`--engine=auto` 与
 *     `--no-unicode` 都不在 argv 里。两者都是「把 rg 掰向 JS」的杠杆 ——
 *     禁用是回归钉子，见对应用例。
 *   - 未知 `type` 是 typed 错误，且**文案与坏正则不同**（SC10）。
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

/** 搜索路径按生产口径喂**相对**形态（cwd = workspace 根，见 rg-engine）。 */
function argv(specOverrides: Partial<QuerySpec> = {}): string[] {
  return buildRgArgs(spec(specOverrides), ".", 2000);
}

describe("buildRgArgs — 出法", () => {
  it("paths → -l（每个唯一文件一条）", () => {
    const args = argv({ output: "paths" });

    assert.ok(args.includes("-l"));
    // 出法互斥：content / count 的旗标不得混入。
    assert.equal(args.includes("--line-number"), false);
    assert.equal(args.includes("--count"), false);
    // 尾部始终是 `-- <pattern> <path>`（路径按生产口径相对 workspace）。
    assert.deepEqual(args.slice(-3), ["--", "hit", "."]);
  });

  it("count → --count", () => {
    const args = argv({ output: "count" });

    assert.ok(args.includes("--count"));
    assert.equal(args.includes("-l"), false);
    assert.deepEqual(args.slice(-3), ["--", "hit", "."]);
  });

  it("`--engine=auto` 不在 argv 里：引擎方言不由本工具切换（ADR-0089）", () => {
    // 回归钉子。历史上这里常开 `--engine=auto`，好让 rg 在 Rust 默认引擎
    // 编不过时退到 PCRE2、把接受集凑近 JS `RegExp`。ADR-0089 废掉了那条
    // 「两条引擎同判」合同：rg 在场时匹配只出 rg，rg 自己编不过的 pattern
    // 由 rg 以 rc=2 报出（handler 转 `search engine rejected the query`）；
    // rg 缺席时 Node 用 JS `RegExp` 出结果，命中集允许与 rg 不同。
    // `--engine=auto` 是那条已废对齐路的唯一开关 —— 它若回来，rg 路径会
    // 重新悄悄换引擎，令同一 pattern 的接受与否取决于本工具而非 rg 自己。
    for (const output of ["content", "paths", "count"] as const) {
      assert.equal(
        argv({ output }).includes("--engine=auto"),
        false,
        `${output} 不得带 --engine=auto`
      );
    }
    // 任何 pattern 都不行，包括历史上靠它才收下的 look-around。
    for (const pattern of ["(?=hit)hit", "\\Z", "\\N", "\\h"]) {
      assert.equal(
        argv({ pattern }).includes("--engine=auto"),
        false,
        `${pattern} 不得带 --engine=auto`
      );
    }
  });

  it("`--no-unicode` 不在 argv 里：不把 rg 的类语义掰成 ASCII（ADR-0089）", () => {
    // 回归钉子。历史上这里按 `keepsUnicodeMode()` 给 `\d` / `\w` / `\b`
    // 一类 pattern 加 `--no-unicode`，好让 rg 的 Unicode 词类退到 JS 的
    // ASCII 口径。那是与 `--engine=auto` 同一种杠杆：拿 rg 的开关去凑两条
    // 引擎的「一致」，代价是 rg 侧**正确的** Unicode 行为被改坏。
    // 实测（rg 15.1.0，vendor 二进制）：`rg '\w'` 命中 `漢字`，
    // `rg --no-unicode '\w'` 不命中；`rg '\d'` 命中 `٣٤`，加了开关不命中。
    // ADR-0089 收窄合同后：rg 按自己的默认 Unicode 语义跑，Node 按 JS 语义
    // 跑，命中集**允许不同**。这条开关若回来，rg 路径会重新被掰成 ASCII 方言，
    // 同一 pattern 的命中集取决于本工具而非 rg 自己。
    for (const output of ["content", "paths", "count"] as const) {
      assert.equal(
        argv({ output }).includes("--no-unicode"),
        false,
        `${output} 不得带 --no-unicode`
      );
    }
    // 任何 pattern 都不行 —— 包括历史上正是靠它才切过去的那些类。
    for (const pattern of ["\\d", "\\w+", "\\bfoo\\b", "[\\d]+", "hit"]) {
      assert.equal(
        argv({ pattern }).includes("--no-unicode"),
        false,
        `${pattern} 不得带 --no-unicode`
      );
    }
  });

  it("`-H` 常开：path 指向单文件时 rg 不再省掉文件名（两种引擎同形状）", () => {
    assert.ok(argv({ output: "content" }).includes("-H"));
    assert.ok(argv({ output: "paths" }).includes("-H"));
    assert.ok(argv({ output: "count" }).includes("-H"));
  });

  it("`--no-messages` 常开：文件级告警不升成整次查询失败", () => {
    // 不可读的邻居文件让 rg 以 rc=2 收尾；没有这道开关，stderr 会被当成
    // 「查询被拒」而整次抛错，而 Node 引擎只是跳过该文件（SC9）。
    for (const output of ["content", "paths", "count"] as const) {
      assert.ok(argv({ output }).includes("--no-messages"));
    }
  });

  it("content → --line-number --no-heading + 超长行两道闸", () => {
    const args = argv({ output: "content" });

    assert.deepEqual(args.slice(0, 2), ["--line-number", "--no-heading"]);
    // 第一道闸交给 rg（否则整行 1MB 原样回传），但它的字节预算取
    // `MAX_MATCH_LINE_COLUMNS × 4`（UTF-8 单字符最大宽度）—— 预算若等于
    // code point 上限，`hit + 漢×1000`（3003 字节 / 1003 code point）会被 rg
    // 截断并塞进它自己的省略标记，而投影层的 code point 闸认为没超限：两条
    // 引擎对同一行给出不同字节数（D6/SC9）。断言从常量派生，不写死数字。
    assert.ok(
      args.includes(
        `--max-columns=${String(
          rgTransportBudgetBytes(MAX_MATCH_LINE_COLUMNS)
        )}`
      )
    );
    assert.ok(args.includes("--max-columns-preview"));
    // 预算必须**严大于** code point 上限，否则 rg 会抢在权威闸之前动手。
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

    // 收窄旗标与引擎级 glob 并列出现（后者见 ignore 语义那组），
    // 用户模式必须原样传递、不被挤压/改写。
    assert.ok(args.includes("--glob"));
    assert.ok(args.includes("*.ts"));
    assert.equal(args[args.indexOf("--type")], undefined);
  });

  it("type → --type <name>", () => {
    const args = argv({ type: "ts" });

    assert.equal(args[args.indexOf("--type") + 1], "ts");
    // 只给 type 时不得凭空长出用户 glob（引擎级排除 glob 是另一回事）。
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
 * 引擎级遍历语义（D6 / SC9）。
 *
 * 契约要求两条引擎**接受集一致**：同一个目录树喂同一个查询，rg 与 Node 扫
 * 必须看见同一批文件。rg 默认会读 `.gitignore` / `.ignore`、跳过隐藏项、
 * 跳过 git 忽略目录；Node 侧的 `walkFiles` 只跳过 `node_modules` / `.git`。
 * 这里把差异**一次性抹平到 Node 口径**（`--no-ignore --hidden` + 两条排除
 * glob），而不是教 Node 读 gitignore 语法（negation / 目录作用域 / 层级作用
 * 域是另一件工具的体量）。判定细节见 `argv.ts` 内的中文注释。
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
    // 排除集与 `path-representable.ts` 共用同一份常量（含 `\n` 目录的整棵
    // 子树也要剔 —— 只按基名剔会漏掉 `a\nb/inner.txt`）。
    const args = argv({});

    for (const glob of NEWLINE_PATH_EXCLUDES) {
      assert.ok(args.includes(glob), `缺排除 glob: ${JSON.stringify(glob)}`);
    }
  });

  it("用户 glob 不能撤销工具自带的 `!**/node_modules` / `!**/.git`（D2）", () => {
    // 顺序契约：用户 glob 先投递，工具排除后投递，rg 的 last-glob-wins 让
    // 「跳过 node_modules / .git」成为最终胜负。用户 glob 是收窄（`*.ts`）
    // 时仍生效，是宽放（`*` / `**`）时也不会把仓库内部的依赖目录、git 配置
    // 吐回给模型（实测：原顺序会让 rg 把 5 条命中吐回，Node 只 3 条）。
    for (const userGlob of ["*", "**", "**/*", "{*,.*}"]) {
      const args = argv({ glob: userGlob });
      const excludeNodeModules = args.lastIndexOf("!**/node_modules");
      const excludeGit = args.lastIndexOf("!**/.git");
      const userGlobIndex = args.indexOf("--glob", excludeNodeModules);
      assert.ok(excludeNodeModules > args.indexOf("--glob"));
      assert.ok(excludeGit > excludeNodeModules);
      assert.ok(userGlobIndex > 0);
    }
    // 用户 glob 仍原样投递（不被挤压/改写）。
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
    // 两条都是**真实**编译器产物，不是手抄的期望串。
    const typeError = messageOf(() => resolveTypeName("nosuchtype"));
    const regexError = messageOf(() => compilePattern("(unclosed", false));

    assert.notEqual(typeError, "");
    assert.notEqual(regexError, "");
    // 不可混为「illegal regex」一种：各自关键词互不出现。
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
    // 且各自都必须点名自己的失败域。
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
