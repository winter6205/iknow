/**
 * 白名单只读 bash 的单文件 path 提取器（ADR-0084 / D1）。
 *
 * `write_file` 的 last-read 账本要从「成功的 bash 读」入账，但 `bash.ts`
 * 只把命令当不透明字符串交给沙箱 —— 没有任何现成组件返回被读的 path。
 * `validateReadonlyCommand` 是只读**模式**的准入闸（只回答「准不准跑」），
 * `classifyCall` 的 bash 分支自 issue 1059 起只回答 read/mutate（物理
 * ro-bind 围栏接管写判定），二者都不返回 path，故不复用（spec D1 明说）。
 * 本模块是专用的小提取器。
 *
 * 判定（全部满足才返回 path，否则 `undefined`）：
 *   1. 恰好一个顶层段（`;` / `&&` / `||` / `|` 都算分段）—— 排除管道与串联；
 *   2. 段内无输出/输入重定向（`>` `<`）、无命令替换（`` ` `` `$`）；
 *   3. 首 token 属于白名单：`cat` / `nl` / `bat` / `batcat` / `head` /
 *      `tail` / `sed -n 'X,Yp'` / `grep` / `egrep` / `fgrep` / `rg`；
 *   4. 命令不带「打印完就退出、根本不碰操作数」的旗标（`--help` / `--version`
 *      一族，见 `NON_READ_FLAGS`）—— 这类命令 exit 0 但文件没被打开；
 *   5. 参数解析后恰好剩**一个**文件操作数（`grep` / `rg` 的首操作数是
 *      pattern，`sed` 的 `-n` 后首个操作数是脚本，都不算文件）；
 *   6. 该操作数不含 glob 元字符 —— `cat *.txt` 展开的是 shell 的词，不是
 *      「一个文件的 path」，记进账本会变成恒不命中的噪声条目。
 *
 * 方向是 fail-closed：抽不出唯一 path 一律不入账。漏记只让模型多读一次，
 * 错记会让未读的非空文件被放行 —— 两个方向的代价不对称。
 *
 * 判据是**形状**（白名单命令 + 恰好一个具体文件操作数 + 无短路旗标 + 无抑制
 * 旗标），不是
 * 观察到的输出：`head -n 0` / `head -c 0` / `tail -n 0` 一族 exit 0 却不打印
 * 任何内容，按形状仍会入账。这里不解析零窗口数值 —— `-n` / `-c` 的值在
 * head / tail 的带符号语义上分叉（`head -n -0` 打印整份文件、`tail -n -0`
 * 什么都不打印），跨命令统一拒会误伤真读到内容的形态（`head -n 0 -c 5`
 * 打印 5 字节）。
 */

import { firstToken, splitShellSegments } from "../../permission/hard-walls.js";

/** 白名单只读命令（spec D1 逐字）。 */
const READ_COMMANDS: ReadonlySet<string> = Object.freeze(
  new Set([
    "cat",
    "nl",
    "bat",
    "batcat",
    "head",
    "tail",
    "sed",
    "grep",
    "egrep",
    "fgrep",
    "rg",
  ])
);

/**
 * 每个命令里「吞掉下一个 token 当值」的旗标。只影响操作数归位：值 token
 * 不再被误当文件。表不全时方向是漏记（值被当第二个操作数 → 多于一个 →
 * 不入账），不会错记。
 */
const NL_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-b",
    "-d",
    "-f",
    "-h",
    "-i",
    "-l",
    "-n",
    "-s",
    "-v",
    "-w",
    "--body-numbering",
    "--section-delimiter",
    "--footer-numbering",
    "--header-numbering",
    "--page-increment",
    "--line-number-format",
    "--number-separator",
    "--starting-line-number",
    "--number-width",
  ])
);

/** bat / batcat 是同一工具的别名，旗标表逐字相同。 */
const BAT_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-l",
    "-m",
    "-r",
    "--language",
    "--theme",
    "--style",
    "--tabs",
    "--line-range",
    "--terminal-width",
    "--wrap",
    "--file-name",
    "--diff-context",
    "--map-syntax",
    "--pager",
    "--config-file",
    "--config",
    "--cache-dir",
  ])
);

/** head / tail 的旗标表逐字相同。 */
const HEAD_TAIL_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set(["-n", "-c", "--lines", "--bytes"])
);

/** egrep / fgrep 是 grep 的模式别名（-E / -F），旗标表按 grep 取超集。 */
const GREP_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-e",
    "-f",
    "-m",
    "-A",
    "-B",
    "-C",
    "-d",
    "-D",
    "--regexp",
    "--file",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--directories",
    "--devices",
    "--exclude-from",
    "--label",
  ])
);

const RG_ARG_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-e",
    "-f",
    "-m",
    "-A",
    "-B",
    "-C",
    "-g",
    "-t",
    "-T",
    "-j",
    "-M",
    "-r",
    // `-d` / `-E` 是既有表漏掉的吞值短旗标（实测 vendored rg 15.1.0：
    // `rg -d 1 a.txt` rc=1 把 a.txt 当 pattern 去遍历 cwd、cwd 中无匹配行
    // → 无输出；`rg -d 1 .` rc=0 走递归。值不被吞时提取器会把 pattern
    // 位上的 a.txt 记成「读过」 —— rc 与匹配数相关，这里仅钉吞值事实）。
    "-d",
    "-E",
    "--regexp",
    "--file",
    "--max-count",
    "--after-context",
    "--before-context",
    "--context",
    "--glob",
    "--type",
    "--type-not",
    "--threads",
    "--max-columns",
    "--context-separator",
    "--field-context-separator",
    "--field-match-separator",
    "--max-depth",
    "--max-filesize",
    "--encoding",
    "--engine",
    "--sort",
    "--colors",
    "--color",
    "--replace",
    "--pre",
    // `--pre-glob <GLOB>` 是吞值旗标（实测 vendored rg 15.1.0：
    // `rg --pre-glob X PRECIOUS a.txt` rc=0 打印 a.txt 原文，`--debug` 日志
    // `number of paths given to search: 1` —— X 是 glob 值、a.txt 才是文件）。
    // 表里漏了它时值 token 落进 operands，提取器把 pattern 位上的
    // `PRECIOUS` 当文件 → 计数错位后整条被拒（漏记方向的假阴性）。
    // 它与 `--pre` 的语义关系：`--pre-glob` 只筛选「哪些文件该经过 `--pre`
    // 的 COMMAND」，本身不产生伪造视图，故只进吞值表、不进抑制表。
    "--pre-glob",
    "--hostname-bin",
  ])
);

const ARG_TAKING_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    cat: Object.freeze(new Set<string>()),
    nl: NL_ARG_FLAGS,
    bat: BAT_ARG_FLAGS,
    batcat: BAT_ARG_FLAGS,
    head: HEAD_TAIL_ARG_FLAGS,
    tail: HEAD_TAIL_ARG_FLAGS,
    sed: Object.freeze(
      new Set(["-e", "-f", "-i", "--expression", "--file", "--in-place"])
    ),
    grep: GREP_ARG_FLAGS,
    egrep: GREP_ARG_FLAGS,
    fgrep: GREP_ARG_FLAGS,
    rg: RG_ARG_FLAGS,
  });

/**
 * 「一出即抑制文件内容输出」或「原地改文件」的旗标黑名单。命中即整条命令
 * 不入账 —— 这类命令 exit 0 也不代表模型看到了现态：
 *   - grep 系：`-q/--quiet/--silent`（静默）、`-c/--count`（只给条数）、
 *     `-l/--files-with-matches`（只给文件名）、`--files-without-match`、
 *     `-o/--only-matching`（只给匹配片段）；
 *   - rg 在 grep 系之上再加 `--count-matches` / `--files`；
 *   - sed：任何 `-i` / `--in-place` 形态 —— 原地改写让文件内容不再是读到的
 *     那份（`sed -n -i.bak -e 1,2p f` 会真的改盘）。
 * 方向仍是 fail-closed：漏记只让模型多读一次，错记会让未读的非空文件被
 * 放行 —— 两个方向的代价不对称。
 */
const GREP_CONTENT_SUPPRESSING_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([
    "-q",
    "--quiet",
    "--silent",
    "-c",
    "--count",
    "-l",
    "--files-with-matches",
    "--files-without-match",
    "-o",
    "--only-matching",
  ])
);

/**
 * `-L` 的语义按命令分叉，不能进共享集：grep 系是 `--files-without-match`
 * （只给文件名，抑制内容），rg 是 `--follow`（跟随 symlink，照常打印内容）。
 * 混在一起会让 `rg -L needle f.ts` 被误判成「没看到内容」而漏记。
 */
const GREP_ONLY_CONTENT_SUPPRESSING_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set([...GREP_CONTENT_SUPPRESSING_FLAGS, "-L"])
);

const CONTENT_SUPPRESSING_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    grep: GREP_ONLY_CONTENT_SUPPRESSING_FLAGS,
    egrep: GREP_ONLY_CONTENT_SUPPRESSING_FLAGS,
    fgrep: GREP_ONLY_CONTENT_SUPPRESSING_FLAGS,
    rg: Object.freeze(
      new Set([
        ...GREP_CONTENT_SUPPRESSING_FLAGS,
        "--count-matches",
        "--files",
        // `-r` / `--replace` 打印的是**被替换后的行**，不是磁盘原文：实测
        // vendored rg 15.1.0，文件内容 `ZZMARK_ONLY_HERE` 时
        // `rg -r INVENTED ZZMARK z.txt` 打印 `INVENTED_ONLY_HERE` —— 文件里
        // 不含这个字符串，模型看到的是伪造视图（比看不到更危险）。与 `-o`
        // （只给片段）、`sed -i`（改写）同属「读了但不是现态」。
        // 注意 `-r` 只在 rg 是 replace：grep 系的 `-r` 是递归，按命令分表
        // 正是为了不让两者互相污染。
        "-r",
        "--replace",
        // `--pre COMMAND` 让 rg 跑 `COMMAND <a.txt`，**搜索 COMMAND 的输出**
        // 而不是文件原文：实测 vendored rg 15.1.0，a.txt 磁盘内容为
        // `PRECIOUS_DISK_CONTENT`
        //   `rg --pre rev TNETNOC_KSID_SUOICERP a.txt`         rc=0 stdout=反转后的假文
        //   `rg --pre=rev TNETNOC_KSID_SUOICERP a.txt`         rc=0 同上（`=` 拼写同形）
        //   `rg --pre cat PRECIOUS_DISK_CONTENT a.txt`         rc=0 stdout 走 cat 转发
        // `cat` 是恒等预处理所以这条恰好等同磁盘原文；但同一槽位换成 `rev` /
        // `sed s/x/y/` / 任意脚本就得到「伪造视图」，与 `-r` 同一类 —— 提取器
        // 按**形状**拒，不依赖某次运行时恰好相等。端到端可利用：先用 `--pre`
        // 看到模型自造文本 → 文件入账 → 随后 `write_file` 放行覆盖一个从未
        // 真正读过的非空文件。
        // `--pre-glob` 是 `--pre` 的配套过滤器（只筛选哪些文件该被预处理），
        // 单独出现不产生伪造视图 → **不进本表**，只按吞值旗标处理（见
        // RG_ARG_FLAGS）。实测 `rg --pre-glob '*.txt' PRECIOUS a.txt` rc=0
        // 打印磁盘原文 `PRECIOUS_DISK_CONTENT`，是真读形态。
        "--pre",
      ])
    ),
    sed: Object.freeze(new Set(["-i", "--in-place"])),
  });

/**
 * 「打印完就退出、**根本不碰操作数**」的旗标（帮助 / 版本 / 自省输出）。
 *
 * 这是与 `CONTENT_SUPPRESSING_FLAGS` **不同的拒因**，注释与实现都分开写：
 *   - 本表 = 「没读」：文件没被打开，stdout 里只有工具自己的文本；
 *   - 抑制表 = 「读了但看不到」：文件真被读了，输出被 `-q` / `-c` / `-l` 之类
 *     的形态砍掉。
 * 合成一张表会让人按错的理由增删条目（例如「既然 `-c` 拒了，`-h` 也该拒」）。
 *
 * **按命令分表，不能共享**：同一个拼写在不同命令里语义不同 ——
 * `grep -h` 是 `--no-filename`（**正常读**）、`rg -h` 是 `--help`、
 * `nl -h` 是 `--header-numbering`（吞值）、uutils 的 `cat/head/tail -h` 是
 * `--help`。共享一张表必然误伤其中之一。
 *
 * 各条目的真机实测见下方逐命令注释；实测环境：uutils coreutils 0.8.0
 * （cat / nl / head / tail）、GNU grep 3.12、GNU sed 4.9、vendored ripgrep
 * 15.1.0（linux-x64）。
 */
const NON_READ_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    // 实测 uutils 0.8.0：`cat --help a.txt` / `-h` / `--version` / `-V` 全部
    // rc=0，stdout 只有帮助或版本文本（`cat -h a.txt` 打印 "Concatenate
    // FILE(s), or standard input, to standard output"），不含 a.txt 内容。
    // 长旗标无歧义前缀同样成立（`cat --he a.txt` / `cat --hel a.txt` rc=0
    // 打印帮助），由 `isDeniedLongPrefix` 覆盖。
    cat: Object.freeze(new Set(["--help", "-h", "--version", "-V"])),
    // 实测 uutils 0.8.0：`nl --help` / `--version` / `-V` rc=0 且 stdout 为
    // 帮助或版本。**不含 `-h`**：`nl -h` 是 `--header-numbering`（吞值），
    // `nl -h n a.txt` rc=0 打印带行号的文件内容 —— 列进来会误伤这条真读。
    nl: Object.freeze(new Set(["--help", "--version", "-V"])),
    // 实测 uutils 0.8.0：`head -h` / `--help` / `-V` / `--version` 均 rc=0 且
    // stdout 无文件内容。**不含 `-v`**：`head -v` / `head --verbose` rc=0
    // 打印 "==> a.txt <==" 与全文，是 verbose 不是 help。
    head: Object.freeze(new Set(["--help", "-h", "--version", "-V"])),
    // tail 与 head 逐字同表。实测 `tail -v a.txt` rc=0 同样打印 header 与全文
    // → `-v` 不列；`tail -h` / `-V` / `--help` / `--version` rc=0 无内容 → 列。
    tail: Object.freeze(new Set(["--help", "-h", "--version", "-V"])),
    // bat / batcat：本机**未安装**（`which bat` 无输出），故下列条目**未实测**，
    // 按 CLI 契约列出自省输出旗标。方向 fail-closed：判错只是漏记（模型多读
    // 一次），不会放行未读文件的覆写。
    bat: Object.freeze(
      new Set([
        "--help",
        "-h",
        "--version",
        "-V",
        "--list-languages",
        "--list-themes",
      ])
    ),
    batcat: Object.freeze(
      new Set([
        "--help",
        "-h",
        "--version",
        "-V",
        "--list-languages",
        "--list-themes",
      ])
    ),
    // 实测 GNU grep 3.12：`grep --help` / `--version` / `-V` rc=0 且 stdout
    // 无匹配行（`grep -V PAT a.txt` 打印 "grep (GNU grep) 3.12"）。
    // **不含 `-h`**：GNU grep 的 `-h` 是 `--no-filename` —— 实测
    // `grep -h PAT a.txt` 与 `grep --no-filename PAT a.txt` 逐字节同输出、
    // 都打印匹配行。把 `-h` 列进来会把真读判成没读（评审给的草表在此处是
    // 矛盾的，以实测为准）。`grep --h PAT a.txt` 是 `--help` 的合法前缀
    // （rc=0 打印 usage），由 `isDeniedLongPrefix` 覆盖。
    grep: Object.freeze(new Set(["--help", "--version", "-V"])),
    egrep: Object.freeze(new Set(["--help", "--version", "-V"])),
    fgrep: Object.freeze(new Set(["--help", "--version", "-V"])),
    // 实测 GNU sed 4.9：`sed --help` / `--version` rc=0 且 stdout 无文件内容，
    // 且**与位置无关**（`sed -n 1,2p --help a.txt` rc=0 打印 usage）。
    // 不含 `-h` / `-V`：真机 `sed -h` / `sed -V` 均 rc=1（exit 闸在先）。
    sed: Object.freeze(new Set(["--help", "--version"])),
    // 实测 vendored ripgrep 15.1.0：`rg --help`（详细）/ `rg -h`（简版）/
    // `--version` / `-V` / `--type-list` / `--generate man PAT a.txt` 均 rc=0
    // 且 stdout 不含文件内容。**不含 `-v`**：rg 的 `-v` 是 `--invert-match`，
    // 实测照常打印匹配行。
    rg: Object.freeze(
      new Set(["--help", "-h", "--version", "-V", "--type-list", "--generate"])
    ),
  });

/**
 * 每个命令的「已知旗标」全集（吞值表 ∪ 抑制表 ∪ 非读表的并集）。
 *
 * **只用于消歧，本身不是拒集**：GNU getopt 的规则是「精确匹配优先，无精确
 * 匹配才做无歧义前缀展开」。少了这一层，`--type-list`（非读表）会让 `--type`
 * （rg 的合法吞值旗标）被判成「命中前缀」而整条拒绝 —— 实测 `rg --type ts
 * PAT a.txt` rc=0 打印 a.txt 内容是真读形态，误拒它等于凭空造出「同一语义、
 * 两种拼写两种裁决」的第二张脸，正是本簇要消灭的形态。
 *
 * 表比真实 option 表窄 → 前缀展开更容易触发 → 偏严的一侧是漏记，不是错记。
 */
const KNOWN_FLAGS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze(buildKnownFlags());

function buildKnownFlags(): Record<string, ReadonlySet<string>> {
  const out: Record<string, ReadonlySet<string>> = {};
  for (const command of READ_COMMANDS) {
    out[command] = Object.freeze(
      new Set<string>([
        ...(ARG_TAKING_FLAGS[command] ?? []),
        ...(CONTENT_SUPPRESSING_FLAGS[command] ?? []),
        ...(NON_READ_FLAGS[command] ?? []),
      ])
    );
  }
  return out;
}

/** 递归读不是「读了某一个文件」，其操作数可能是目录 —— 不入账。 */
const RECURSIVE_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set(["-r", "-R", "--recursive", "--dereference-recursive"])
);

/** `sed -n 'X,Yp'` 的脚本形态（行范围打印）。 */
const SED_RANGE_SCRIPT = /^\d+(,\d+)?p$/;

/** 旗标里出现即认定 `sed` 走「安静 + 显式脚本」形态。 */
const SED_QUIET_FLAGS: ReadonlySet<string> = Object.freeze(
  new Set(["-n", "--quiet", "--silent"])
);

/** glob 元字符 —— 操作数不是单一具体 path。 */
const GLOB_METACHARS = /[*?[{]/;

interface OperandWalk {
  readonly operands: ReadonlyArray<string>;
  readonly flags: ReadonlySet<string>;
  /**
   * 「吞掉下一个 token 当值」的旗标及其值（`-e 1,2p` → `{-e, 1,2p}`），按
   * 出现顺序保留**每一条**。值不在 `operands` 里，故按语义审查值的调用方
   * （`sed` 的脚本形态）得从这里取。用列表不用 map：重复旗标（`sed -e d
   * -e 1,2p`）是多个脚本源，折叠成一条会把「先 d 后 p」误判成单个 `1,2p`。
   */
  readonly flagValues: ReadonlyArray<{
    readonly flag: string;
    readonly value: string;
  }>;
}

/** walkOperands 的累积器：归位过程中逐 token 长大。 */
interface OperandAccumulator {
  readonly command: string;
  readonly argFlags: ReadonlySet<string>;
  readonly flags: Set<string>;
  readonly flagValues: Array<{ flag: string; value: string }>;
  readonly operands: string[];
}

/**
 * 消费一个 token（`i` 指向它），返回下一个下标。`--` 之后的全部 token 都是
 * 操作数（GNU 惯例：选项终止符）。
 *
 * **归一后再查表**：`--g`（rg 的单字母双横线别名）与 `-g` 是同一个旗标，
 * 归位必须同裁决。原实现用**归一前**的原始 token 查 `ARG_TAKING_FLAGS`，
 * 于是 `rg --g '*.ts' PAT f` 的值 token 不被吞进 `flagValues` 而是落进
 * `operands` —— 计数错位后恰好凑成「一个」，把 pattern 位上的 token 记成
 * 读过（见文件头「簇 B」注释）。归一放在**唯一一处**，不再有第二张脸。
 */
function consumeOperandToken(
  tokens: ReadonlyArray<string>,
  i: number,
  acc: OperandAccumulator
): number {
  const token = tokens[i]!;
  if (token === "--") {
    acc.operands.push(...tokens.slice(i + 1));
    return tokens.length;
  }
  if (token.startsWith("-") && token.length > 1) {
    const norm = normalizeFlagToken(token, acc.command);
    acc.flags.add(norm.token);
    // `--flag=value` 自带值，不吞下一个 token。
    if (acc.argFlags.has(norm.base) && norm.value === undefined) {
      const value = tokens[i + 1];
      if (value !== undefined) acc.flagValues.push({ flag: norm.token, value });
      return i + 2;
    }
    return i + 1;
  }
  acc.operands.push(token);
  return i + 1;
}

/**
 * 把段切成 token（尊重引号与反斜杠转义），并按命令的旗标表把操作数归位。
 * 引号不闭合 → `undefined`（无法可靠归位，漏记）。
 */
function walkOperands(
  segment: string,
  command: string
): OperandWalk | undefined {
  const tokens = tokenize(segment);
  if (tokens === undefined || tokens.length === 0) return undefined;
  const acc: OperandAccumulator = {
    command,
    argFlags: ARG_TAKING_FLAGS[command] ?? new Set<string>(),
    flags: new Set<string>(),
    flagValues: [],
    operands: [],
  };
  for (let i = 1; i < tokens.length;) {
    i = consumeOperandToken(tokens, i, acc);
  }
  return {
    operands: acc.operands,
    flags: acc.flags,
    flagValues: acc.flagValues,
  };
}

/** 切分状态机的一步：读到 `segment[i]` 后更新状态，返回下一个下标。 */
interface TokenizeState {
  readonly tokens: string[];
  current: string;
  started: boolean;
  quote: "'" | '"' | null;
}

/**
 * 组合短旗标（`grep -rn` / `sed -ni`）的字母序列；非组合形态 → `undefined`。
 * 组合旗标逐个字母都是独立旗标，判定要按字母展开而不是整串匹配。
 */
function shortFlagCluster(flag: string): string | undefined {
  const match = /^-([a-zA-Z]{2,})$/.exec(flag);
  return match?.[1];
}

/**
 * GNU getopt 接受长旗标的**无歧义前缀**：`grep --qui` 就是 `--quiet`（实测
 * GNU grep 3.12 / GNU sed 4.9）。只做全等比较会让 `--qui` / `--cou` /
 * `--files-with-match` / `--in-pla` 全部漏网，把「没看到内容」记成读过，
 * 或把原地改写记成读。
 *
 * 只在**恰有一个**黑名单项以 `base` 为前缀时判拒，与 GNU 的「无歧义」同构：
 * `--files-with-m` 唯一指向 `--files-with-matches` → 拒；`--files-with` 同时
 * 前缀 matches / without-match → GNU 报歧义、exit != 0（本就不入账），这里
 * 也不拒；`--file`（pattern 文件旗标，合法读）只因前缀命中会被误拒，故同样
 * 靠「无歧义」放行。判据只在本命令的黑名单内计算，比 GNU 的全 option 表窄，
 * 偏严的一侧是漏记（模型多读一次），不会错记。
 */
function isDeniedLongPrefix(base: string, deny: ReadonlySet<string>): boolean {
  if (!base.startsWith("--")) return false;
  let found = false;
  for (const entry of deny) {
    if (!entry.startsWith("--") || !entry.startsWith(base)) continue;
    if (found) return false;
    found = true;
  }
  return found;
}

/**
 * 旗标 token 的语法归一 —— 全模块**唯一**一处做这件事。
 *
 * 两种形态：
 *   1. ripgrep（clap）的**单字母双横线别名**：`--c` 就是 `-c`、`--g` 就是
 *      `-g`、`--q` 就是 `-q`。实测 vendored rg 15.1.0：`rg --c` 只打印条数、
 *      `--l` 只打印文件名、`--q` stdout 为空（三者 exit 0）；`rg --X VALUE PAT f`
 *      与 `rg -X VALUE PAT f` 对 X ∈ {g,t,m,j,M,r,f,e,A,B,C,d,E,T} **逐字节
 *      同输出**。
 *   2. 所有命令的 `--flag=value` → 拆出 `{base: "--flag", value: "value"}`。
 *
 * 规则 1 **只对 ripgrep 成立**：GNU grep 3.12 对 `--c` / `--l` 报 ambiguous、
 * GNU sed 4.9 对 `--c` 报 unrecognized（真机均 exit != 0，bash 的 exit 0 闸
 * 本就不入账）—— 把短旗标语义挂到语法不同的 GNU 工具上会误伤。
 *
 * 归一后的形态（而非原始 token）是**归位表与拒集共用的唯一比较口径**：原实现
 * 只在黑名单侧归一，`consumeOperandToken` 查的是原始 token，于是 `rg --g
 * '*.ts' PAT f` 的值不被吞、计数错位后把 pattern 记成文件（簇 B）。两侧共用
 * 一个函数后，「黑名单归一、arity 不归一」这种第二张脸无法再出现。
 *
 * 规则 1 是**逐字母统一**的，不为个别字母开例外：实测 vendored rg 15.1.0 里
 * `rg --h PAT a.txt` rc=0 且**打印了匹配行**（不等价于 `-h` 的简版帮助），
 * 按统一规则它会被归一到 `-h` 而拒 —— 这是漏记方向（模型多读一次），
 * 不是错记。逐字母开例外表会让规则退化成枚举，漏一个就是错记（危险方向）。
 */
function normalizeFlagToken(
  token: string,
  command: string
): { readonly token: string; readonly base: string; readonly value?: string } {
  const eq = token.startsWith("--") ? token.indexOf("=") : -1;
  const raw = eq > 0 ? token.slice(0, eq) : token;
  const value = eq > 0 ? token.slice(eq + 1) : undefined;
  const base = canonicalShortAlias(raw, command);
  return {
    token: value === undefined ? base : `${base}=${value}`,
    base,
    ...(value === undefined ? {} : { value }),
  };
}

/**
 * ripgrep 的单字母双横线别名 → 对应的短旗标（`--g` → `-g`）。
 * 非单字母形态（`--co` 在 rg 报 unrecognized flag）原样返回，不推广。
 */
function canonicalShortAlias(flag: string, command: string): string {
  if (command !== "rg") return flag;
  const match = /^--([a-zA-Z])$/.exec(flag);
  return match === null ? flag : `-${match[1]}`;
}

/**
 * 该旗标是否命中拒集（含别名归一、组合短旗标展开、`--flag=value` 去尾与
 * 长旗标无歧义前缀）。
 *
 * `known`（本命令的已知旗标全集）只用于消歧：GNU getopt 是「精确匹配优先，
 * 无精确匹配才做无歧义前缀展开」。少了它，`--type`（rg 的合法吞值旗标）会因
 * 命中 `--type-list` 的前缀而被误拒 —— `rg --type ts PAT a.txt` 实测 rc=0
 * 打印文件内容，是真读形态。
 */
function matchesDeniedFlag(
  flag: string,
  deny: ReadonlySet<string>,
  command: string
): boolean {
  const norm = normalizeFlagToken(flag, command);
  if (deny.has(norm.base)) return true;
  // 精确命中本命令的其它已知旗标 → 不做前缀展开（GNU getopt 的优先序）。
  if (KNOWN_FLAGS[command]?.has(norm.base) === true) return false;
  // `--flag=value` 与 `--flag` 同走前缀展开：`sed --in-pla=.bak` 真会改盘。
  if (isDeniedLongPrefix(norm.base, deny)) return true;
  const cluster = shortFlagCluster(norm.base);
  if (cluster !== undefined) {
    return [...cluster].some((letter) => deny.has(`-${letter}`));
  }
  // 单字母旗标带贴连值（`sed -i.bak`）：首字母即旗标本身。
  return (
    !norm.base.startsWith("--") &&
    norm.base.length > 2 &&
    deny.has(norm.base.slice(0, 2))
  );
}

/** 命令是否带「抑制内容输出 / 原地改文件」旗标 → 读了也不等于看到现态。 */
function hasContentSuppressingFlag(
  command: string,
  flags: ReadonlySet<string>
): boolean {
  const deny = CONTENT_SUPPRESSING_FLAGS[command];
  if (deny === undefined) return false;
  for (const flag of flags) {
    if (matchesDeniedFlag(flag, deny, command)) return true;
  }
  return false;
}

/**
 * 命令是否带「打印完就退出、根本没打开操作数」的旗标（帮助 / 版本 / 自省）。
 *
 * 与 `hasContentSuppressingFlag` 是**两个独立的拒因**：本函数回答「没读」，
 * 那个回答「读了但看不到」。放在 `selectFileOperand` 里内容抑制判据**之前**，
 * 两者的注释与理由各自独立，不合并。
 */
function hasNonReadFlag(command: string, flags: ReadonlySet<string>): boolean {
  const deny = NON_READ_FLAGS[command];
  if (deny === undefined) return false;
  for (const flag of flags) {
    if (matchesDeniedFlag(flag, deny, command)) return true;
  }
  return false;
}

function stepQuoted(state: TokenizeState, segment: string, i: number): number {
  const ch = segment[i]!;
  if (ch === state.quote) {
    state.quote = null;
  } else {
    state.current += ch;
  }
  return i + 1;
}

function stepEscape(state: TokenizeState, segment: string, i: number): number {
  const next = segment[i + 1];
  if (next === undefined) return -1;
  state.current += next;
  state.started = true;
  return i + 2;
}

function stepSpace(state: TokenizeState): void {
  if (!state.started) return;
  state.tokens.push(state.current);
  state.current = "";
  state.started = false;
}

/**
 * 引号感知的空白切分。`sed -n '1,10p' f` 里带空格的脚本是一个 token。
 * 不闭合的引号 / 结尾悬空反斜杠 → `undefined`。
 */
function tokenize(segment: string): string[] | undefined {
  const state: TokenizeState = {
    tokens: [],
    current: "",
    started: false,
    quote: null,
  };
  for (let i = 0; i < segment.length;) {
    const ch = segment[i]!;
    if (state.quote !== null) {
      i = stepQuoted(state, segment, i);
      continue;
    }
    if (ch === "'" || ch === '"') {
      state.quote = ch;
      state.started = true;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i = stepEscape(state, segment, i);
      if (i < 0) return undefined;
      continue;
    }
    if (/\s/.test(ch)) {
      stepSpace(state);
      i += 1;
      continue;
    }
    state.current += ch;
    state.started = true;
    i += 1;
  }
  if (state.quote !== null) return undefined;
  if (state.started) state.tokens.push(state.current);
  return state.tokens;
}

/**
 * 段里是否有重定向 / 命令替换。`<` `>` 一律拒（spec：无重定向），`` ` `` 与
 * `$` 拒（命令替换 / 变量展开，path 不再是字面量）。
 */
function hasRedirectOrSubstitution(segment: string): boolean {
  return /[<>`$]/.test(segment);
}

/**
 * 从一条 bash 命令里抽出「被读的那一个文件 path」的字面量。
 * 抽不出 → `undefined`（调用方据此不入账）。
 */
export function extractSingleReadPath(command: string): string | undefined {
  const segments = splitShellSegments(command);
  if (segments.length !== 1) return undefined;
  const segment = segments[0]!;
  if (hasRedirectOrSubstitution(segment)) return undefined;
  const commandName = firstToken(segment);
  if (!READ_COMMANDS.has(commandName)) return undefined;
  const walk = walkOperands(segment, commandName);
  if (walk === undefined) return undefined;
  const operand = selectFileOperand(commandName, walk);
  if (operand === undefined) return undefined;
  if (GLOB_METACHARS.test(operand)) return undefined;
  return operand;
}

/**
 * 按命令形态把「文件」操作数从余下操作数里选出来。选中恰一个才返回。
 *
 *   - `sed`：`-n` 在场；脚本要么来自 `-e`（则余下恰一个操作数 = 文件），
 *     要么是首个操作数且匹配 `X,Yp`（则第二个操作数 = 文件）。
 *   - `grep` / `rg` 系：首个操作数是 pattern（除非 `-e` 已给），余下恰一个
 *     才是文件；递归旗标在场一律不认。
 *   - 其余：余下恰一个操作数即文件。
 */
function selectFileOperand(
  command: string,
  walk: OperandWalk
): string | undefined {
  const { operands, flags } = walk;
  // 两个独立拒因，按「先否掉根本没读的、再否掉读了看不到的」排序：
  //   1. 非读短路（`cat --help f`）：文件没被打开，stdout 只有工具自己的文本；
  //   2. 内容抑制 / 原地改（`grep -q` / `sed -i`）：文件读了，但输出被砍掉或
  //      文件已被改写，都不等于「看到了现态」。
  if (hasNonReadFlag(command, flags)) return undefined;
  if (hasContentSuppressingFlag(command, flags)) return undefined;
  if (command === "sed") return selectSedFile(walk);
  if (isRecursiveRead(command, flags)) return undefined;
  if (isGrepFamily(command)) {
    const files = hasPatternSourceFlag(flags) ? operands : operands.slice(1);
    return files.length === 1 ? files[0] : undefined;
  }
  return operands.length === 1 ? operands[0] : undefined;
}

/** grep / egrep / fgrep / rg —— 首个操作数是 pattern 的同一族形态。 */
function isGrepFamily(command: string): boolean {
  return (
    command === "grep" ||
    command === "egrep" ||
    command === "fgrep" ||
    command === "rg"
  );
}

/**
 * `sed -n` 的脚本源审查：`-e` / `--expression`（含 `=` 形态）与位置脚本
 * （`sed -n 1,2p f`）是同一个判据的几条入口 —— 共用本函数，避免两份正则
 * 漂移出一处漏网。
 *
 * `rangeOnly`：**每一个**脚本源都是 `X,Yp` 行范围打印。任何一处不是
 * （实测 GNU sed 4.9：`-n -e d` 与 `-n -e 's/e/E/'` 都 exit 0 且 stdout 为空，
 * 无 `p` 的替换在安静模式下不打印任何行）→ 都不是「看到了磁盘现态」，
 * 只是「exit 0 的空读」而已。`-f` / `--file`（脚本文件）同样判否：脚本内容
 * 在盘上别处，本提取器不追 —— 真机 `sed -n -f delete.sed -e 1,2p f` exit 0
 * 且 stdout 为空（`d` 让 `p` 无行可打印），只看 `-e` 的值会把它误记成读过。
 *
 * `fromFlag`：脚本由旗标给出 → 值不在操作数里，余下恰一个操作数即文件。
 */
interface SedScriptReview {
  readonly fromFlag: boolean;
  readonly rangeOnly: boolean;
}

/** 脚本来自旗标（`-e`）或来自脚本文件（`-f`）—— 值都不在操作数里。 */
function isScriptSourceFlag(flag: string): boolean {
  return (
    flag === "-e" ||
    flag === "--expression" ||
    flag.startsWith("--expression=") ||
    flag === "-f" ||
    flag === "--file" ||
    flag.startsWith("--file=")
  );
}

/**
 * 一个「吞值」旗标是否证明脚本不是行范围打印。
 *
 *   - `-f` / `--file`（脚本文件）：内容在盘上别处，本提取器看不到 → 判否；
 *   - `-e` / `--expression`：值就是脚本本身 → 按 `SED_RANGE_SCRIPT` 判；
 *   - 其余吞值旗标（`-i` 等）：不是脚本源，不参与本判据。
 */
function scriptValueFailsRange(flag: string, value: string): boolean {
  if (flag === "-f" || flag === "--file") return true;
  if (flag !== "-e" && flag !== "--expression") return false;
  return !SED_RANGE_SCRIPT.test(value);
}

/** `--flag=value` 形态的脚本源是否证明脚本不是行范围打印。 */
function inlineScriptFailsRange(flag: string): boolean {
  if (flag.startsWith("--file=")) return true;
  if (!flag.startsWith("--expression=")) return false;
  return !SED_RANGE_SCRIPT.test(flag.slice("--expression=".length));
}

function reviewSedScripts(walk: OperandWalk): SedScriptReview {
  let rangeOnly = true;
  for (const { flag, value } of walk.flagValues) {
    if (scriptValueFailsRange(flag, value)) rangeOnly = false;
  }
  for (const flag of walk.flags) {
    if (inlineScriptFailsRange(flag)) rangeOnly = false;
  }
  const fromFlag = [...walk.flags].some(isScriptSourceFlag);
  // 脚本不在旗标上 → 位置操作数[0] 就是脚本，同一个形态判据。
  if (!fromFlag) {
    const script = walk.operands[0];
    if (script === undefined || !SED_RANGE_SCRIPT.test(script)) {
      rangeOnly = false;
    }
  }
  return { fromFlag, rangeOnly };
}

function selectSedFile(walk: OperandWalk): string | undefined {
  const { operands, flags } = walk;
  const quiet = [...flags].some((flag) => SED_QUIET_FLAGS.has(flag));
  if (!quiet) return undefined;
  const scripts = reviewSedScripts(walk);
  if (!scripts.rangeOnly) return undefined;
  // 脚本来自旗标 → 值不在 operands，余下恰一个操作数即文件；脚本来自位置
  // 操作数 → 第二个操作数才是文件。
  const expected = scripts.fromFlag ? 1 : 2;
  if (operands.length !== expected) return undefined;
  return operands[operands.length - 1];
}

/**
 * pattern 已由旗标给出（`-e` / `--regexp` / rg 的 `-f` / `--file`）→ 首个
 * 位置操作数不再是 pattern，而是路径。
 *
 * `-f` / `--file`（从文件读 pattern）必须一并算入：实测 vendored rg 15.1.0，
 * `rg -f pats.txt PAT a.txt` rc=2 且报 `rg: PAT: No such file or directory`
 * —— `-f` 之后的位置参数**全部**按路径解析；`rg -f pats.txt a.txt` rc=0
 * 打印 a.txt 内容（单文件读）。旧实现只认 `-e`，于是把 `-f` 场景下的首个
 * 位置操作数当 pattern 丢掉、把第二个当文件，恰好凑成「一个」而错记。
 */
function hasPatternSourceFlag(flags: ReadonlySet<string>): boolean {
  for (const flag of flags) {
    if (
      flag === "-e" ||
      flag === "-f" ||
      flag === "--regexp" ||
      flag === "--file" ||
      flag.startsWith("--regexp=") ||
      flag.startsWith("--file=")
    ) {
      return true;
    }
  }
  return false;
}

/** grep / rg 的递归读跨越多个文件 → 不是「读了某一个文件」。 */
function isRecursiveRead(command: string, flags: ReadonlySet<string>): boolean {
  if (!isGrepFamily(command)) return false;
  for (const flag of flags) {
    if (RECURSIVE_FLAGS.has(flag)) return true;
    // 组合短旗标（`grep -rn`）里含 r 也算递归。
    if (/^-[a-zA-Z]{2,}$/.test(flag) && flag.includes("r")) return true;
  }
  return false;
}

/**
 * 三张拒表 + 派生的 `KNOWN_FLAGS`，**仅供测试**做结构不变式断言（漂移锁）。
 *
 * 不变式：每张拒表的每一项都必须在 `KNOWN_FLAGS[command]` 里。`KNOWN_FLAGS`
 * 按 `[...ARG_TAKING_FLAGS, ...CONTENT_SUPPRESSING_FLAGS, ...NON_READ_FLAGS]`
 * 派生，故当前恒成立 —— 这条锁防的是**构造漂移**：将来新增第四张表、或
 * 把某张拒集从派生里摘出去时，`matchesDeniedFlag` 的「精确匹配优先于无歧义
 * 前缀展开」判据会失去该旗标的消歧信息，`--type` 会被 `--type-list` 的
 * 前缀判据误拒（或反之漏拒）。测试遍历三张表逐项断言，让这层联动在改动
 * 时立刻响。
 *
 * 生产代码只走 `extractSingleReadPath`，不要依赖这里的常量 —— 命名前缀
 * `__forTest` 即为此意。
 */
export const __forTestStructuralInvariant = Object.freeze({
  ARG_TAKING_FLAGS,
  CONTENT_SUPPRESSING_FLAGS,
  NON_READ_FLAGS,
  KNOWN_FLAGS,
});
