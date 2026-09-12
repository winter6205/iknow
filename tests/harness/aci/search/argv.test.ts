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

  it("`--engine=auto` 常开：rg 的接受集与 Node 引擎的 JS RegExp 对齐", () => {
    // 默认的 Rust 引擎不支持 look-around / backreference，JS RegExp 支持；
    // 不带 auto，`(?=hit)` 会在 rg 路径 rc=2 失败、在 Node 路径正常命中 ——
    // 同一 pattern 的含义取决于哪条引擎在跑（D6 禁止）。auto 只在模式需要
    // 时才切 PCRE2，普通模式仍走默认引擎（零开销）。
    for (const output of ["content", "paths", "count"] as const) {
      assert.ok(argv({ output }).includes("--engine=auto"));
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

describe("buildRgArgs — `--no-unicode` 模式选择（D6/SC9）", () => {
  it("`\\d` / `\\w` / `\\b` 一类 pattern → 带上 `--no-unicode`", () => {
    // JS RegExp（无 `u`）的 `\d` / `\w` / `\b` 只认 ASCII，Rust regex 默认
    // Unicode 类 —— 这两个构造实测就分歧（rg 的 `\d` 吃 ٣٤、`\b` 把 `é` 当
    // 词字符）。切了才对齐。
    for (const pattern of ["\\d", "\\w+", "\\bfoo\\b", "[\\d]+"]) {
      assert.ok(
        argv({ pattern }).includes("--no-unicode"),
        `${pattern} 应切 --no-unicode`
      );
    }
  });

  it("`.` / `\\s` / 非 ASCII 字面量 → **不**带 `--no-unicode`（切了会打坏）", () => {
    // 字节语义下 `.` 只吃一个字节（`a.c` 不匹配 `aéc`）、`\s` 不认 NBSP；
    // 非 ASCII 字面量同理。这些构造必须留在 Unicode 模式。
    for (const pattern of ["a.c", "\\s", "\\S", "café", "漢字", "[^x]{2}"]) {
      assert.equal(
        argv({ pattern }).includes("--no-unicode"),
        false,
        `${pattern} 不应切 --no-unicode`
      );
    }
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
