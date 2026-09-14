/**
 * 白名单只读 bash 的单文件 path 提取器（ADR-0084 / spec D1）。
 *
 * 不变式：**抽不出唯一 path 一律 undefined**（fail-closed）。漏记只让模型多
 * 读一次；错记会让未读的非空文件被放行 —— 测试两侧都钉：白名单 + 单文件
 * 必须抽出，管道 / 重定向 / 多文件 / 递归 / 非白名单必须不抽。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  __forTestStructuralInvariant,
  extractSingleReadPath,
} from "../../../../src/harness/aci/tools/bash-read-extract.ts";

describe("extractSingleReadPath — 入账形态（抽出唯一文件）", () => {
  it("cat 单文件", () => {
    assert.equal(extractSingleReadPath("cat src/a.ts"), "src/a.ts");
  });

  it("绝对路径原样抽出（解析由调用方做）", () => {
    assert.equal(extractSingleReadPath("cat /ws/a.ts"), "/ws/a.ts");
  });

  it("head / tail 带数量旗标（值不误当操作数）", () => {
    assert.equal(extractSingleReadPath("head -n 20 src/a.ts"), "src/a.ts");
    assert.equal(extractSingleReadPath("tail -n 5 src/a.ts"), "src/a.ts");
    assert.equal(extractSingleReadPath("head --lines=20 src/a.ts"), "src/a.ts");
  });

  it("nl / bat / batcat 单文件", () => {
    assert.equal(extractSingleReadPath("nl src/a.ts"), "src/a.ts");
    assert.equal(extractSingleReadPath("bat src/a.ts"), "src/a.ts");
    assert.equal(extractSingleReadPath("batcat src/a.ts"), "src/a.ts");
  });

  it("sed -n 'X,Yp' 文件（脚本不是文件）", () => {
    assert.equal(extractSingleReadPath("sed -n '1,20p' src/a.ts"), "src/a.ts");
    assert.equal(extractSingleReadPath("sed -n '5p' src/a.ts"), "src/a.ts");
  });

  it("grep / egrep / fgrep：首个操作数是 pattern，第二个才是文件", () => {
    assert.equal(extractSingleReadPath("grep foo src/a.ts"), "src/a.ts");
    assert.equal(extractSingleReadPath("egrep 'f.o' src/a.ts"), "src/a.ts");
    assert.equal(extractSingleReadPath("fgrep foo src/a.ts"), "src/a.ts");
  });

  it("grep -e pattern 时余下唯一操作数即文件", () => {
    assert.equal(extractSingleReadPath("grep -e foo src/a.ts"), "src/a.ts");
  });

  it("rg 单文件", () => {
    assert.equal(extractSingleReadPath("rg foo src/a.ts"), "src/a.ts");
  });

  it("带引号的 path 去掉引号后抽出", () => {
    assert.equal(extractSingleReadPath("cat 'src/a b.ts'"), "src/a b.ts");
    assert.equal(extractSingleReadPath('cat "src/a b.ts"'), "src/a b.ts");
  });

  it("命令前的首尾空白不影响", () => {
    assert.equal(extractSingleReadPath("  cat   src/a.ts  "), "src/a.ts");
  });

  it("绝对命令路径按 basename 判定（/bin/cat 仍是 cat）", () => {
    assert.equal(extractSingleReadPath("/bin/cat src/a.ts"), "src/a.ts");
  });
});

describe("extractSingleReadPath — 不入账形态（fail-closed）", () => {
  it("空串 / 空白", () => {
    assert.equal(extractSingleReadPath(""), undefined);
    assert.equal(extractSingleReadPath("   "), undefined);
  });

  it("非白名单命令：ls / stat / find / 未知命令", () => {
    assert.equal(extractSingleReadPath("ls src"), undefined);
    assert.equal(extractSingleReadPath("stat src/a.ts"), undefined);
    assert.equal(extractSingleReadPath("find src -name a.ts"), undefined);
    assert.equal(extractSingleReadPath("npm test"), undefined);
  });

  it("白名单命令但缺文件操作数", () => {
    assert.equal(extractSingleReadPath("cat"), undefined);
    assert.equal(extractSingleReadPath("grep foo"), undefined);
  });

  it("多文件参数", () => {
    assert.equal(extractSingleReadPath("cat a.ts b.ts"), undefined);
    assert.equal(extractSingleReadPath("grep foo a.ts b.ts"), undefined);
  });

  it("管道 / 串联 / 命令替换 / 重定向", () => {
    assert.equal(extractSingleReadPath("cat a.ts | head -n 1"), undefined);
    assert.equal(extractSingleReadPath("cat a.ts && cat b.ts"), undefined);
    assert.equal(extractSingleReadPath("cat a.ts > out.txt"), undefined);
    assert.equal(extractSingleReadPath("cat a.ts < in.txt"), undefined);
    assert.equal(extractSingleReadPath("cat $(echo a.ts)"), undefined);
  });

  it("递归读：grep -r / rg -r / 组合短旗标含 r", () => {
    assert.equal(extractSingleReadPath("grep -r foo src/"), undefined);
    assert.equal(extractSingleReadPath("grep -rn foo src/"), undefined);
    assert.equal(extractSingleReadPath("rg -R foo src/"), undefined);
    assert.equal(extractSingleReadPath("rg --recursive foo src/"), undefined);
  });

  it("glob 操作数：展开的是 shell 的词，不是单一具体 path", () => {
    assert.equal(extractSingleReadPath("cat *.ts"), undefined);
    assert.equal(extractSingleReadPath("cat src/*.ts"), undefined);
    assert.equal(extractSingleReadPath("cat a[12].ts"), undefined);
  });

  it("sed 缺少 -n 或脚本形态不匹配", () => {
    assert.equal(extractSingleReadPath("sed '1,10p' a.ts"), undefined);
    assert.equal(extractSingleReadPath("sed -n 's/a/b/' a.ts"), undefined);
  });

  it("sed -n -e <script> 的脚本形态与位置脚本同一判据：非 X,Yp 一律不入账", () => {
    // 真机实测（GNU sed 4.9）：
    //   `sed -n -e d f`        → exit 0、stdout 为空（没有任何内容可看）
    //   `sed -n -e 's/e/E/' f` → exit 0、stdout 也为空（安静模式下无 p 的
    //                            替换不打印任何行）
    // 二者都只凭「有 -e」就被旧判据当成读过 —— 两条都是 exit 0 的空读，
    // 模型什么字节都没看到。故 -e 分支必须与位置脚本分支共用同一个脚本
    // 形态判据。
    assert.equal(extractSingleReadPath("sed -n -e d cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("sed -n -e 's/a/b/' cfg.ts"), undefined);
    // 反向钉住：真正的行范围打印（-e 给脚本）照常入账。
    assert.equal(extractSingleReadPath("sed -n -e '1,2p' cfg.ts"), "cfg.ts");
    assert.equal(
      extractSingleReadPath("sed -n --expression=1,2p cfg.ts"),
      "cfg.ts"
    );
  });

  it("sed 多个脚本源：任何一个不是 X,Yp 即不入账", () => {
    // `sed -e` 可重复；脚本按顺序全部执行。混入 `d`（删除且不自动打印）后
    // 输出被改变 —— 只看「最后一个脚本」或「某个脚本」都会漏网。
    assert.equal(
      extractSingleReadPath("sed -n -e d -e '1,2p' cfg.ts"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("sed -n -e '1,2p' -e d cfg.ts"),
      undefined
    );
  });

  it("sed -e 在场时多出来的位置操作数不放行（`-e` 已占脚本位，余下必须恰一个文件）", () => {
    // 实测 GNU sed 4.9：`sed -n f.ts -e` 报 option requires an argument（exit 1）。
    // `-e` 已把脚本位从位置参数里拿走，此时第二个位置操作数不是文件而是多余
    // 参数 —— 「恰好一个操作数」判据拦住它，不放行。
    assert.equal(
      extractSingleReadPath("sed -n -e '1,2p' a.ts b.ts"),
      undefined
    );
  });

  it("rg --co 不是单字母别名（clap 报 unrecognized flag）→ 不据此拒", () => {
    // vendored rg 15.1.0 实测：`rg --co` 报 `unrecognized flag --co`、exit 2
    // —— clap 的短别名只认**恰好一个**字母。提取器不建模这条语法（本就不该
    // 靠它拦），拦它的是 bash 的 exit != 0 闸；这里钉住别名规则不被过度推广
    // 成「两字母前缀也当短旗标」。
    assert.equal(extractSingleReadPath("rg --co SECRET cfg.ts"), "cfg.ts");
  });

  it("sed -f（脚本文件）不追 → 不入账（脚本内容在盘上别处，不在本次 stdout 判据内）", () => {
    // 实测 GNU sed 4.9：`sed -n -f delete.sed -e 1,2p f` exit 0 且 stdout 为空
    // —— 脚本文件里的 `d` 让 `p` 无行可打印。只看 `-e` 的值会把它误记成
    // 「模型看到了 f 的现态」。脚本文件形态一律 fail-closed。
    assert.equal(extractSingleReadPath("sed -n -f delete.sed f.ts"), undefined);
    assert.equal(
      extractSingleReadPath("sed -n -f delete.sed -e '1,2p' f.ts"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("sed -n --file=delete.sed -e '1,2p' f.ts"),
      undefined
    );
  });

  it("引号不闭合 → 无法可靠归位操作数", () => {
    assert.equal(extractSingleReadPath("cat 'a.ts"), undefined);
  });

  it("脚本文件读（sh script.sh 不在白名单）", () => {
    assert.equal(extractSingleReadPath("bash script.sh"), undefined);
    assert.equal(extractSingleReadPath("sh script.sh"), undefined);
  });

  it("grep 抑制内容输出旗标：exit 0 也看不到文件内容 → 不入账", () => {
    assert.equal(extractSingleReadPath("grep -q SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("grep --quiet SECRET cfg.ts"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("grep --silent SECRET cfg.ts"),
      undefined
    );
    assert.equal(extractSingleReadPath("grep -c SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("grep --count SECRET cfg.ts"),
      undefined
    );
    assert.equal(extractSingleReadPath("grep -l SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("grep --files-with-matches SECRET cfg.ts"),
      undefined
    );
    assert.equal(extractSingleReadPath("grep -L SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("grep --files-without-match SECRET cfg.ts"),
      undefined
    );
    assert.equal(extractSingleReadPath("grep -o SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("grep --only-matching SECRET cfg.ts"),
      undefined
    );
    assert.equal(extractSingleReadPath("egrep -q SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("fgrep -q SECRET cfg.ts"), undefined);
  });

  it("组合短旗标里的抑制旗标也被展开识别（grep -cl / -nq）", () => {
    assert.equal(extractSingleReadPath("grep -cl SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("grep -nq SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("grep -qo SECRET cfg.ts"), undefined);
  });

  it("GNU 长旗标无歧义前缀 = 完整旗标（--qui / --cou / --files-with-match / --only-match）", () => {
    // GNU getopt 接受长旗标的无歧义前缀：`grep --qui` 实际就是 `--quiet`，
    // exit 0 但 stdout 为空 —— 不按前缀展开就会把「没看到内容」记成读过。
    assert.equal(extractSingleReadPath("grep --qui SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("grep --cou SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("grep --files-with-match SECRET cfg.ts"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("grep --files-without SECRET cfg.ts"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("rg --only-match SECRET cfg.ts"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("sed --in-pla -n '1,2p' f.ts"),
      undefined
    );
    // `--flag=value` 形态同样按去尾后的基名展开前缀（sed 真会原地改写）。
    assert.equal(
      extractSingleReadPath("sed --in-pla=.bak -n '1,2p' f.ts"),
      undefined
    );
  });

  it("前缀判据只在无歧义时命中：歧义前缀不整条拒绝，无歧义前缀照旧拒绝", () => {
    // `--files-with` 同时前缀 matches / without-match：GNU 报歧义并 exit 2
    // （bash 的 exit != 0 闸在先，本就不入账）。提取器只做字面量判定，
    // 这里钉的是「不因前缀判据把歧义形态整条拒掉」。
    assert.equal(
      extractSingleReadPath("grep --files-with SECRET cfg.ts"),
      "cfg.ts"
    );
    // 无歧义前缀（唯一指向 --files-without-match）必须拒。
    assert.equal(
      extractSingleReadPath("grep --files-witho SECRET cfg.ts"),
      undefined
    );
  });

  it("-L 在 grep 是 --files-without-match（不入账），在 rg 是 --follow（照常打印内容 → 入账）", () => {
    assert.equal(extractSingleReadPath("grep -L SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg -L needle a.ts"), "a.ts");
    // 双横线形态不改变语义分叉：rg 的 `--L` 仍是 --follow（vendored 15.1.0
    // 实测打印匹配行）→ 入账。
    assert.equal(extractSingleReadPath("rg --L needle a.ts"), "a.ts");
    // grep 的 `--L` 不属于别名语法（GNU 真机 unrecognized、exit 2），故提取器
    // 抽得出 path —— 拦它的是 bash 的 exit 0 闸（stdout 无内容、命令已失败），
    // 不是本模块。别名规则不推广到 GNU 工具正是为了不把两种语法混为一谈。
    assert.equal(extractSingleReadPath("grep --L SECRET cfg.ts"), "cfg.ts");
  });

  it("别名不误伤正向读形态：rg --n（= -n，行号照常打印）仍入账", () => {
    // 实测 vendored rg 15.1.0：`rg --n` = `-n` = --line-number，照常打印
    // 匹配行原文。别名规则只把 token 归一到短旗标再查黑名单，不在黑名单的
    // 旗标一律放行 —— 这是「按语义分叉」而不是「见 --x 就拒」。
    assert.equal(extractSingleReadPath("rg --n needle a.ts"), "a.ts");
    assert.equal(extractSingleReadPath("rg --line-number needle a.ts"), "a.ts");
  });

  it("rg 抑制内容输出旗标：-c / --count-matches / --files → 不入账", () => {
    assert.equal(extractSingleReadPath("rg -c SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("rg --count-matches SECRET cfg.ts"),
      undefined
    );
    assert.equal(extractSingleReadPath("rg --files cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg -l SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg -q SECRET cfg.ts"), undefined);
  });

  it("ripgrep 的单字母双横线别名 = 短旗标（--c / --l / --q 抑制内容 → 不入账）", () => {
    // vendored rg 15.1.0 实测：`rg --c` 只打印条数（`2`）、`--l` 只打印文件
    // 名、`--q` stdout 为空，三者 exit 0。clap 的这条别名语法不是 GNU getopt
    // 的无歧义前缀（`--co` 在 rg 报 unrecognized flag，exit 2），只按前缀
    // 展开建模会整条漏网 —— 账本会记下「模型看到过内容」这个假事实。
    assert.equal(extractSingleReadPath("rg --c SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg --l SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg --q SECRET cfg.ts"), undefined);
  });

  it("别名规则只在 ripgrep 成立：GNU 工具的 --c 真机被拒（exit != 0），不建模为短旗标", () => {
    // 实测 GNU grep 3.12：`--c` ambiguous（--context/--color/--count）、
    // `--l` ambiguous（--label/--line-*）；GNU sed 4.9：`--c` unrecognized。
    // 真机均 exit != 0 → bash 的 exit 0 闸在先，本就不入账，故别名规则不
    // 推广到 GNU 工具（双横线在 GNU 是长旗标前缀表，不是短旗标别名）。
    // `grep --c` 另因唯一前缀 `--count` 走既有前缀判据 → 直接拒。
    assert.equal(extractSingleReadPath("grep --c SECRET cfg.ts"), undefined);
  });

  it("rg --pre COMMAND：跑 `COMMAND <a.txt`、搜其输出而非文件原文 → 不入账", () => {
    // 实测 vendored rg 15.1.0，a.txt 磁盘内容为 `PRECIOUS_DISK_CONTENT`：
    //   `rg --pre rev TNETNOC_KSID_SUOICERP a.txt`   rc=0 stdout=`TNETNOC_KSID_SUOICERP`
    //   `rg --pre=rev TNETNOC_KSID_SUOICERP a.txt`   rc=0 同上（`=` 拼写同形）
    //   `rg --pre cat PRECIOUS_DISK_CONTENT a.txt`   rc=0 stdout=`PRECIOUS_DISK_CONTENT`
    // `cat` 是恒等预处理所以该条 stdout 恰好等同磁盘原文；同一槽位换成 `rev`
    // / `sed s/x/y/` / 任意脚本就得到「伪造视图」 —— 提取器按**形状**拒，
    // 不依赖某次运行时恰好相等。与 `-r`/`--replace` 同一类（打印的不保证是
    // 磁盘现态），比 `-q`（看不到）更危险：模型会以为自己读到了文件。
    // 端到端可利用：先用 `--pre` 看到模型自造文本 → 文件入账 → 随后
    // write_file 放行覆盖一个从未真正读过的非空文件。
    assert.equal(
      extractSingleReadPath("rg --pre rev TNETNOC_KSID a.txt"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("rg --pre=rev TNETNOC_KSID a.txt"),
      undefined
    );
    assert.equal(extractSingleReadPath("rg --pre cat PAT a.txt"), undefined);
  });

  it("rg --pre-glob 单独出现不构成伪造：没有 --pre 时它只是过滤器 → 照常入账", () => {
    // 实测 vendored rg 15.1.0：`rg --pre-glob '*.txt' PRECIOUS_DISK_CONTENT a.txt`
    // rc=0 打印 `PRECIOUS_DISK_CONTENT`（磁盘原文）—— `--pre-glob` 只筛选哪些
    // 文件该经过 `--pre` 的 COMMAND，没有 `--pre` 时无任何预处理发生。
    // 拒它等于把真读形态判成「没看到内容」，是漏记方向的另一张脸。
    assert.equal(
      extractSingleReadPath("rg --pre-glob '*.txt' PRECIOUS a.txt"),
      "a.txt"
    );
    assert.equal(
      extractSingleReadPath("rg --pre-glob '*.txt' a.txt"),
      undefined
    );
  });

  it("rg --pr 不是 --pre 的合法前缀（clap 报 unrecognized flag，exit 2）→ 不据此拒", () => {
    // 实测 vendored rg 15.1.0：`rg --pr rev PAT a.txt` 报
    // `rg: unrecognized flag --pr`、exit 2 —— 拦它的是 bash 的 exit 0 闸，
    // 不是本提取器。钉住前缀判据不被过度推广到 rg 的 clap 语法上（GNU 的
    // 无歧义前缀规则在此不成立，rg 只认 `--pre` / `--pre-glob` / `--pretty`）。
    assert.equal(extractSingleReadPath("rg --pr rev PAT a.txt"), undefined);
  });

  it("rg --crlf 是 boolean（vendored rg 15.1.0 实测：值不被吞，按 pattern 解析）", () => {
    // 真机 `rg --crlf X PAT f.txt` rc=2 stderr `rg: PAT: No such file or directory`
    // —— X 不被吞，而是按 pattern 解析；PAT 是文件路径，没有该文件 → rg 报
    // 找不到（按 `--debug` 日志 rg 实际搜索了 1 个文件）。两文件场景：
    // `rg --crlf MARKER a.txt b.txt` rg 实际读了 2 个文件（debug 日志
    // `number of paths given to search: 2`），与提取器「slice(1) 后恰一个」
    // 的两文件 → undefined 判据天然 fail-closed。
    // 真实读形态 `rg --crlf PAT a.txt` → 必为 `"a.txt"`；旧实现把 `--crlf`
    // 列在 RG_ARG_FLAGS 时会吞 PAT 成 undefined，是漏记方向的另一张脸，
    // 同时 `--crlf MARKER a.txt b.txt` 会因 slice(1) 仅余 `[b.txt]` 而错记
    // 为 `"b.txt"`（rg 实际读了 a.txt + b.txt 两个文件）—— 是错记。
    assert.equal(extractSingleReadPath("rg --crlf PAT a.txt"), "a.txt");
    assert.equal(
      extractSingleReadPath("rg --crlf MARKER a.txt b.txt"),
      undefined
    );
  });

  it("rg --o = -o = --only-matching：实测只打印匹配片段，不是整行 → 不入账", () => {
    // vendored rg 15.1.0 实测（输入 `xxSECRETyy` / `zzSECRETww`）：
    // `rg -o` / `rg --o` / `rg --only-matching` 三者逐字节同输出 —— 只有
    // `SECRET`，没有整行原文。单字母别名不改变旗标语义，故 `--o` 与既有
    // `-o` / `--only-matching` 判据一致（`--o` 在修复前也因唯一前缀
    // `--only-matching` 被拒；别名规则让这条拒因与 `-o` 同源）。
    assert.equal(extractSingleReadPath("rg --o SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg -o SECRET cfg.ts"), undefined);
    assert.equal(
      extractSingleReadPath("rg --only-matching SECRET cfg.ts"),
      undefined
    );
  });

  it("sed 原地改（-i / --in-place 任意形态）：文件被改写，不是读 → 不入账", () => {
    assert.equal(
      extractSingleReadPath("sed -n -i.bak -e 1,2p f.ts"),
      undefined
    );
    assert.equal(extractSingleReadPath("sed -ni '1,2p' f.ts"), undefined);
    assert.equal(extractSingleReadPath("sed -in '1,2p' f.ts"), undefined);
    assert.equal(extractSingleReadPath("sed -n -i '1,2p' f.ts"), undefined);
    assert.equal(
      extractSingleReadPath("sed -n --in-place '1,2p' f.ts"),
      undefined
    );
    assert.equal(
      extractSingleReadPath("sed -n --in-place=.bak '1,2p' f.ts"),
      undefined
    );
  });

  it("正向对照：带行号 / 行范围但仍打印内容的读形态照常入账", () => {
    assert.equal(extractSingleReadPath("grep -n pat f.ts"), "f.ts");
    assert.equal(extractSingleReadPath("rg -n pat f.ts"), "f.ts");
    assert.equal(extractSingleReadPath("sed -n '1,2p' f.ts"), "f.ts");
    // 前缀规则不得误伤非黑名单长旗标（`--line-number` 不前缀任何黑名单项）。
    assert.equal(extractSingleReadPath("grep --line-number pat f.ts"), "f.ts");
  });

  it("零窗口形态按形状入账（判据不是观察到的输出）：head -n 0 / -c 0 仍抽出 path", () => {
    // 判定链是「白名单命令 + 恰好一个具体文件操作数 + 无抑制旗标」，不是
    // 「stdout 里出现了内容」。零窗口（`head -n 0` exit 0、无输出）因此仍入账。
    // 不解析零值：`-n` / `-c` 的值在 head / tail 的带符号语义上分叉
    // （`head -n -0` 打印整份文件、`tail -n -0` 什么都不打印），且同一条命令
    // 里后出现的窗口旗标覆盖先出现的（实测 `head -n 0 -c 5` 打印 5 字节）
    // —— 想按值判「零窗口」就得复刻这套优先级，风险大于收益。此处把该决定
    // 钉在测试里，防止两侧（doctrine 与代码）无声漂移。
    assert.equal(extractSingleReadPath("head -n 0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head -c 0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("tail -n 0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head --lines=0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head --bytes=0 cfg.ts"), "cfg.ts");
    // 同形但真打印内容的形态必须照旧放行（拒零窗口会连它一起误伤）。
    assert.equal(extractSingleReadPath("head -n 0 -c 5 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head -n -0 cfg.ts"), "cfg.ts");
  });
});

/**
 * 簇 A：非读短路旗标 —— 「打印完就退出、根本不碰操作数」。
 *
 * 这类旗标让命令 exit 0 且 stdout 里只有帮助 / 版本文本，操作数**没有被打开**。
 * 只看「余下恰一个操作数」就入账，等于把没读的文件记成读过，随后 `write_file`
 * 会放行覆写未读的非空文件（这正是 spec D1 要拦的形态）。
 *
 * 拒集按命令分，不能共享 —— 同一个拼写在不同命令里语义不同：
 *   - `grep -h` = `--no-filename`（**正常读**，实测打印匹配行）；
 *   - `rg -h` = `--help`（拒）；
 *   - `nl -h` = `--header-numbering`（吞值，`nl -h n a.txt` 正常打印）；
 *   - uutils 的 `cat/head/tail -h` = `--help`（拒，依赖实现）。
 *
 * 注释里的 rc / stdout 均为本机真机实测：uutils coreutils 0.8.0（cat / nl /
 * head / tail）、GNU grep 3.12、GNU sed 4.9、vendored ripgrep 15.1.0（linux-x64）。
 */
describe("extractSingleReadPath — 簇 A：非读短路旗标", () => {
  const NON_READ_CASES: ReadonlyArray<string> = [
    // 实测：cat --help / -h / --version / -V 均 rc=0，stdout 只有帮助或版本文本
    // （`cat -h a.txt` 打印 "Concatenate FILE(s), ..."），不含 a.txt 内容。
    "cat --help a.txt",
    "cat -h a.txt",
    "cat --version a.txt",
    "cat -V a.txt",
    // uutils 同样接受长旗标无歧义前缀：实测 `cat --he a.txt` / `cat --hel a.txt`
    // 都是 rc=0 打印帮助。
    "cat --hel a.txt",
    // nl 实测：--help / --version / -V rc=0 打印帮助 / 版本。`nl -h` rc=1
    // （invalid numbering style），`nl -h n a.txt` 是真读形态（见正向对照）
    // → `-h` 不进 nl 的拒集。
    "nl --help a.txt",
    "nl --version a.txt",
    "nl -V a.txt",
    // head / tail 实测：--help / -h / --version / -V 均 rc=0 且无文件内容；
    // `-v` 是 verbose（实测打印 "==> a.txt <==" 与全文）→ 不进拒集。
    "head --help a.txt",
    "head -h a.txt",
    "head --version a.txt",
    "head -V a.txt",
    "head --he a.txt",
    "tail --help a.txt",
    "tail -h a.txt",
    "tail --version a.txt",
    "tail -V a.txt",
    // grep 实测：`grep -h PAT a.txt` 打印匹配行，与 `grep --no-filename PAT
    // a.txt` 逐字节同输出 → `-h` 绝不能进拒集；打印完即退出的只有
    // --help / --version / -V（三者 stdout 均无匹配行）。
    "grep --help PAT a.txt",
    "grep --version PAT a.txt",
    "grep -V PAT a.txt",
    "grep --hel PAT a.txt",
    // sed 实测：--help / --version rc=0 且无文件内容，且与位置无关
    // （`sed -n 1,2p --help a.txt` rc=0 打印帮助）。`sed -h` / `-V` 真机 rc=1
    // （exit 闸在先）→ 只需列长旗标。
    "sed --help a.txt",
    "sed --version a.txt",
    "sed -n '1,2p' --help a.txt",
    // rg 实测：--help（详细）/ -h（简版）/ --version / -V / --type-list 均
    // rc=0 且 stdout 不含文件内容；`--generate man` 生成 man 页，同样不读操作数。
    "rg --help PAT a.txt",
    "rg -V PAT a.txt",
    "rg --type-list PAT a.txt",
    "rg -V a.txt",
    "rg -h a.txt",
    "rg --type-list a.txt",
    "rg --generate man PAT a.txt",
    // bat / batcat：本机未安装（`which bat` 无输出），**未能实测**；按 bat 的
    // CLI 契约 --help / -h / --version / -V / --list-languages / --list-themes
    // 都是「打印完即退出、不读 FILE」。方向 fail-closed：判错也只是漏记。
    "bat --help a.txt",
    "bat -V a.txt",
    "bat --list-languages a.txt",
    "batcat --help a.txt",
    "batcat --list-themes a.txt",
  ];

  for (const command of NON_READ_CASES) {
    it(`${command} → undefined`, () => {
      assert.equal(extractSingleReadPath(command), undefined);
    });
  }

  it("拒因分层：非读短路与内容抑制是两个独立的拒因，各自单独成立", () => {
    // 「没读」（本簇）与「读了但看不到」（CONTENT_SUPPRESSING_FLAGS）是两条
    // 不同理由，注释与实现都分开写 —— 混成一张表会让人按错的理由增删条目。
    assert.equal(extractSingleReadPath("grep -q SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("cat --help cfg.ts"), undefined);
  });
});

/**
 * 簇 B：ripgrep 单字母双横线别名的归位不对称。
 *
 * rg 走 clap，除 GNU getopt 的无歧义前缀外还接受单字母双横线别名（`--g` 就是
 * `-g`）。原实现只在黑名单侧做别名归一（`canonicalShortAlias` 只被
 * `matchesDeniedFlag` 调用），归位侧 `consumeOperandToken` 查的是**归一前**的
 * 原始 token —— `--g` / `--t` / `--A` … 不在吞值表里，它们的值 token 于是被
 * 当成操作数，计数错位后恰好凑成「一个」→ 错记。
 *
 * 实测（vendored rg 15.1.0）：`rg --X VALUE PAT a.txt` 与 `rg -X VALUE PAT a.txt`
 * 对 X ∈ {g,t,m,j,M,r,f,e,A,B,C,d,E,T} **逐字节同输出** —— 两种拼写语义相同，
 * 裁决必须相同。这也是本簇的判据：parity，而不是「见 --x 就拒」。
 */
describe("extractSingleReadPath — 簇 B：ripgrep 单字母双横线别名归位", () => {
  /** 吞值短旗标的别名 + 一个该旗标的合法值（值本身不是文件）。 */
  const VALUE_TAKING_ALIASES: ReadonlyArray<readonly [string, string]> = [
    ["g", "*.ts"],
    ["t", "ts"],
    ["m", "3"],
    ["j", "4"],
    ["M", "100"],
    ["A", "1"],
    ["B", "1"],
    ["C", "1"],
    ["d", "1"],
    ["E", "utf-8"],
    ["f", "pats.txt"],
    ["e", "PAT"],
    ["r", "X"],
    ["T", "ts"],
  ];

  for (const [letter, value] of VALUE_TAKING_ALIASES) {
    it(`rg --${letter} 与 rg -${letter} 同裁决（值被吞，不参与操作数计数）`, () => {
      assert.equal(
        extractSingleReadPath(`rg --${letter} ${value} PAT a.txt`),
        extractSingleReadPath(`rg -${letter} ${value} PAT a.txt`)
      );
    });
  }

  /**
   * 错记的原始形态：值 token 没被吞 → 计数错位 → 把 pattern 位上的 token
   * 当成文件。这些命令的短旗标都不读 a.txt（值被吞后 a.txt 落在 pattern 位，
   * rg 无文件操作数时去遍历 cwd），必须 undefined。
   */
  const MISCOUNTED_SHAPES: ReadonlyArray<string> = [
    "rg --g '*.ts' a.txt",
    "rg --t ts a.txt",
    "rg --m 3 a.txt",
    "rg --j 4 a.txt",
    "rg --M 100 a.txt",
    "rg --A 1 a.txt",
    "rg --B 1 a.txt",
    "rg --C 1 a.txt",
    "rg --d 1 a.txt",
    "rg --E utf-8 a.txt",
    "rg --T ts a.txt",
    "rg --r X a.txt",
  ];

  for (const command of MISCOUNTED_SHAPES) {
    it(`${command} → undefined（值没被吞时错记的文件其实是 pattern）`, () => {
      assert.equal(extractSingleReadPath(command), undefined);
    });
  }

  it("rg --g '*.ts' package.json → undefined（package.json 落在 pattern 位，不是文件）", () => {
    // 实测：`rg --g '*.ts' package.json` 与 `rg -g '*.ts' package.json` 逐字节
    // 同输出（stdin 关闭时 rc=2 "No files were searched"）—— `-g` 的值是 glob，
    // `package.json` 是 pattern，rg 不会去读它。归一后按「grep 族首操作数是
    // pattern」规则 slice(1) → 0 个操作数 → undefined。
    assert.equal(
      extractSingleReadPath("rg --g '*.ts' package.json"),
      undefined
    );
    assert.equal(extractSingleReadPath("rg -g '*.ts' package.json"), undefined);
  });

  it("rg -f / --f / --file 是 pattern 来源：其后的首个位置参数是路径，不是 pattern", () => {
    // 实测 vendored rg 15.1.0：`rg -f pats.txt PAT a.txt` rc=2 且报
    // `rg: PAT: No such file or directory` —— 证明 `-f` 之后的位置参数全部按
    // 路径解析（两个路径 → 不是「读一个文件」）；`rg -f pats.txt a.txt` rc=0
    // 打印 a.txt 内容（单文件读）。别名 `--f` 与长旗标 `--file` 语义相同。
    assert.equal(extractSingleReadPath("rg --f pats.txt PAT a.txt"), undefined);
    assert.equal(extractSingleReadPath("rg -f pats.txt PAT a.txt"), undefined);
    assert.equal(
      extractSingleReadPath("rg --file pats.txt PAT a.txt"),
      undefined
    );
  });

  it("三 token 形态按实测与短旗标同裁决（清单里的「应 undefined」实测为 credit）", () => {
    // 复用清单的每条拼写，钉住修复后的实际裁决。这些旗标都不抑制内容也不
    // 改写输出（类型 / glob / 上下文 / 计数 / 线程 / 深度 / 编码），而 rg 的
    // 过滤**不作用于显式给出的文件**（实测 `rg -t ts ZZMARK z.txt` rc=0 打印
    // z.txt 内容）→ 值被吞后余下 pattern + 文件，裁决是 credit a.txt。
    // 若改成 undefined，短旗标形态（现状 credit、语义完全相同）就成了新的
    // 「第二张脸」—— 与本簇要修的缺陷同类。
    assert.equal(extractSingleReadPath("rg --t ts PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --m 3 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --j 4 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --M 100 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --A 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --B 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --C 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --d 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --E utf-8 PAT a.txt"), "a.txt");
    // `-r/--replace` 是例外：打印的是把匹配段替换后的行，不是磁盘原文 ——
    // 与 sed 的 `-n -e 's/a/b/p'`、grep 的 `-o` 同一判据（打印的不是整行原文）
    // → 拒。短旗标同样拒，parity 保持。
    assert.equal(extractSingleReadPath("rg --r X PAT a.txt"), undefined);
    assert.equal(extractSingleReadPath("rg -r X PAT a.txt"), undefined);
    assert.equal(extractSingleReadPath("rg --replace X PAT a.txt"), undefined);
  });
});

/**
 * 正向对照：防误伤。上面两张拒集按命令分表，最容易的错法是「见 `--x` 就拒」
 * 或把某个正常读形态的短旗标也塞进拒集 —— 这些拼写必须继续 credit。
 */
describe("extractSingleReadPath — 正向对照（拒集不得误伤真读形态）", () => {
  const STILL_READS: ReadonlyArray<readonly [string, string]> = [
    ["cat -n a.txt", "a.txt"],
    ["head -n 5 a.txt", "a.txt"],
    ["tail -n 2 a.txt", "a.txt"],
    // 实测：head -v / head --verbose / tail -v 都打印 "==> a.txt <==" 与内容
    // （rc=0）—— verbose 不是 help，`-v` 不进拒集。
    ["head -v a.txt", "a.txt"],
    ["head --verbose a.txt", "a.txt"],
    ["tail -v a.txt", "a.txt"],
    // 实测 GNU grep 3.12：grep -h PAT a.txt 打印匹配行（= --no-filename）。
    ["grep -h PAT a.txt", "a.txt"],
    ["grep --no-filename PAT a.txt", "a.txt"],
    // 实测：nl -h 是 --header-numbering（吞值），`nl -h n a.txt` rc=0 打印内容。
    ["nl -h n a.txt", "a.txt"],
    // 实测 GNU sed 4.9：两种脚本来源都打印前两行。
    ["sed -n '1,2p' a.txt", "a.txt"],
    ["sed -n -e '1,2p' a.txt", "a.txt"],
    // 实测 vendored rg 15.1.0：--no-heading / --hidden / -v 照常打印内容。
    ["rg --no-heading PAT a.txt", "a.txt"],
    ["rg --hidden PAT a.txt", "a.txt"],
    ["rg -v PAT a.txt", "a.txt"],
    // 实测：类型 / glob 过滤不作用于显式路径（`rg -t ts ZZMARK z.txt` rc=0
    // 打印 z.txt 内容）→ 这些形态确实读到了文件。
    ["rg -t ts PAT a.txt", "a.txt"],
    ["rg --type ts PAT a.txt", "a.txt"],
    ["rg -A 1 PAT a.txt", "a.txt"],
    ["rg --A 1 PAT a.txt", "a.txt"],
    ["rg -g '*.ts' PAT a.txt", "a.txt"],
    ["rg --g '*.ts' PAT a.txt", "a.txt"],
    // 实测：-f 是 pattern 来源，其后的位置参数是路径（`rg -f pats.txt z.txt`
    // rc=0 打印 z.txt 内容）→ 单文件照常入账。长旗标 `--file` 只因前缀命中
    // `--files` 会被误拒，修复后按「精确旗标优先」放行。
    ["rg -f pats.txt a.txt", "a.txt"],
    ["rg --f pats.txt a.txt", "a.txt"],
    ["rg --file pats.txt a.txt", "a.txt"],
    ["grep -f pats.txt a.txt", "a.txt"],
    // 实测 vendored rg 15.1.0：`rg --pre-glob '*.txt' PRECIOUS a.txt` 是单文件
    // 读（`--debug` 日志 `number of paths given to search: 1`），pattern 是
    // `PRECIOUS`、文件是 `a.txt`。`--pre-glob` 是吞值旗标，未进吞值表时值
    // token 会落进 operands，slice(1) 后变成 2 个操作数 → 漏记方向的假阴性。
    ["rg --pre-glob '*.txt' PRECIOUS a.txt", "a.txt"],
  ];

  for (const [command, expected] of STILL_READS) {
    it(`${command} → ${expected}`, () => {
      assert.equal(extractSingleReadPath(command), expected);
    });
  }

  it("结构不变式：KNOWN_FLAGS[command] 恰为三张表的并集（防漂移锁）", () => {
    // `matchesDeniedFlag` 的消歧判据是「精确命中 KNOWN_FLAGS 就不做无歧义
    // 前缀展开」，而 `KNOWN_FLAGS` 由三张表派生。将来若新增第四张拒表、
    // 或把某张表从派生里摘出去，新增的拒项就会缺这层消歧信息：`--type`
    // （合法吞值）被 `--type-list` 的前缀判据误拒，或反过来该拒的漏拒。
    //
    // 断言取**并集等式**而非单向子集：子集在「表从派生里被摘掉」时仍会
    // 通过（那一项根本不在遍历范围内），等式才会立刻红。新增合法第四张
    // 表时本测试要求同步更新 —— 这正是漂移锁该做的事。
    const {
      ARG_TAKING_FLAGS,
      CONTENT_SUPPRESSING_FLAGS,
      NON_READ_FLAGS,
      KNOWN_FLAGS,
    } = __forTestStructuralInvariant;
    const tables = [
      ["ARG_TAKING_FLAGS", ARG_TAKING_FLAGS],
      ["CONTENT_SUPPRESSING_FLAGS", CONTENT_SUPPRESSING_FLAGS],
      ["NON_READ_FLAGS", NON_READ_FLAGS],
    ] as const;
    const mismatches: string[] = [];
    for (const [command, known] of Object.entries(KNOWN_FLAGS)) {
      const union = new Set<string>();
      for (const [, table] of tables) {
        for (const flag of table[command] ?? []) union.add(flag);
      }
      for (const flag of union) {
        if (!known.has(flag))
          mismatches.push(`${command}: ${flag} 漏进 KNOWN_FLAGS`);
      }
      for (const flag of known) {
        if (!union.has(flag))
          mismatches.push(`${command}: ${flag} 不在任何一张表里`);
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      "KNOWN_FLAGS 必须是三张表的并集：少一项会让精确匹配优先的前缀消歧失效，多一项会让前缀展开被错误抑制"
    );
  });

  it("结构不变式：三个命令族的拒表互不串味（拼写语义按命令分叉）", () => {
    // 同名拼写在 grep / rg 语义相反，表必须按命令分，不能共享实例。
    const { CONTENT_SUPPRESSING_FLAGS, NON_READ_FLAGS, ARG_TAKING_FLAGS } =
      __forTestStructuralInvariant;
    // `-L`：grep 是 --files-without-match（拒），rg 是 --follow（放行）。
    assert.equal(CONTENT_SUPPRESSING_FLAGS.grep?.has("-L"), true);
    assert.equal(CONTENT_SUPPRESSING_FLAGS.rg?.has("-L"), false);
    // `-h`：rg 是 --help（拒），grep 是 --no-filename（放行）。
    assert.equal(NON_READ_FLAGS.rg?.has("-h"), true);
    assert.equal(NON_READ_FLAGS.grep?.has("-h") ?? false, false);
    // `-r`：rg 的 `-r` 是 --replace（拒），表里也在吞值表（值是真值）。
    assert.equal(CONTENT_SUPPRESSING_FLAGS.rg?.has("-r"), true);
    assert.equal(ARG_TAKING_FLAGS.rg?.has("-r"), true);
    assert.equal(CONTENT_SUPPRESSING_FLAGS.grep?.has("-r") ?? false, false);
  });
});
