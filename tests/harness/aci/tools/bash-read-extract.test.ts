/**
 * Single-file path extractor for whitelisted read-only bash (ADR-0084).
 *
 * Invariant: **anything without a unique extractable path is undefined**
 * (fail-closed). A missed record only costs the model one extra read; a
 * wrong record lets an unread nonempty file be overwritten. Tests pin both
 * sides: whitelist + single file must extract; pipes / redirections /
 * multiple files / recursion / non-whitelisted commands must not.
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
    // Measured (GNU sed 4.9):
    //   `sed -n -e d f`        → exit 0, empty stdout (nothing to see)
    //   `sed -n -e 's/e/E/' f` → exit 0, also empty (in quiet mode a
    //                            substitution without p prints no lines)
    // The old criterion treated both as "read" just because `-e` was
    // present — two exit-0 empty reads where the model saw zero bytes. So
    // the -e branch must share one script-shape criterion with the
    // positional-script branch.
    assert.equal(extractSingleReadPath("sed -n -e d cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("sed -n -e 's/a/b/' cfg.ts"), undefined);
    // Reverse pin: a real line-range print (script given via -e) still gets ledgered.
    assert.equal(extractSingleReadPath("sed -n -e '1,2p' cfg.ts"), "cfg.ts");
    assert.equal(
      extractSingleReadPath("sed -n --expression=1,2p cfg.ts"),
      "cfg.ts"
    );
  });

  it("sed 多个脚本源：任何一个不是 X,Yp 即不入账", () => {
    // `sed -e` may repeat and all scripts run in order; mixing in `d`
    // (delete, no auto-print) changes the output — checking only the last or
    // only some single script would slip through.
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
    // Measured GNU sed 4.9: `sed -n f.ts -e` reports option requires an
    // argument (exit 1). Once `-e` takes the script slot from positional
    // args, a second positional operand is a surplus argument, not a file —
    // the "exactly one operand" criterion blocks it.
    assert.equal(
      extractSingleReadPath("sed -n -e '1,2p' a.ts b.ts"),
      undefined
    );
  });

  it("rg --co 不是单字母别名（clap 报 unrecognized flag）→ 不据此拒", () => {
    // Measured vendored rg 15.1.0: `rg --co` reports `unrecognized flag
    // --co`, exit 2 — clap's short alias accepts exactly **one** letter. The
    // extractor does not model this syntax (it should not gate on it
    // anyway); the bash exit != 0 gate is what rejects it. This pins the
    // alias rule from being over-generalized into "two-letter prefixes also
    // count as short flags".
    assert.equal(extractSingleReadPath("rg --co SECRET cfg.ts"), "cfg.ts");
  });

  it("sed -f（脚本文件）不追 → 不入账（脚本内容在盘上别处，不在本次 stdout 判据内）", () => {
    // Measured GNU sed 4.9: `sed -n -f delete.sed -e 1,2p f` exits 0 with
    // empty stdout — the `d` inside the script file leaves `p` nothing to
    // print. Looking only at the `-e` value would wrongly record "the model
    // saw f's current state". Script-file forms are fail-closed throughout.
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
    // GNU getopt accepts unambiguous long-flag prefixes: `grep --qui` really
    // is `--quiet` — exit 0 with empty stdout. Without prefix expansion,
    // "saw no content" would be recorded as a read.
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
    // `--flag=value` expands the same way on the trimmed base name (sed really does rewrite in place).
    assert.equal(
      extractSingleReadPath("sed --in-pla=.bak -n '1,2p' f.ts"),
      undefined
    );
  });

  it("前缀判据只在无歧义时命中：歧义前缀不整条拒绝，无歧义前缀照旧拒绝", () => {
    // `--files-with` prefixes both matches / without-match: GNU reports
    // ambiguity and exits 2 (the bash exit != 0 gate runs first, so nothing
    // is ledgered anyway). The extractor only does literal-level judgment;
    // this pins that the prefix criterion never rejects the whole ambiguous
    // form.
    assert.equal(
      extractSingleReadPath("grep --files-with SECRET cfg.ts"),
      "cfg.ts"
    );
    // An unambiguous prefix (pointing only at --files-without-match) must be rejected.
    assert.equal(
      extractSingleReadPath("grep --files-witho SECRET cfg.ts"),
      undefined
    );
  });

  it("-L 在 grep 是 --files-without-match（不入账），在 rg 是 --follow（照常打印内容 → 入账）", () => {
    assert.equal(extractSingleReadPath("grep -L SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg -L needle a.ts"), "a.ts");
    // The double-dash form does not change the semantic fork: rg's `--L` is
    // still --follow (measured vendored 15.1.0 prints matching lines) →
    // ledgered.
    assert.equal(extractSingleReadPath("rg --L needle a.ts"), "a.ts");
    // grep's `--L` is not alias syntax (measured GNU: unrecognized, exit 2),
    // so the extractor still extracts a path — what stops that command is
    // the bash exit gate (failed command, empty stdout), not this module.
    // Keeping the alias rule rg-only is exactly so the two syntaxes are
    // never conflated.
    assert.equal(extractSingleReadPath("grep --L SECRET cfg.ts"), "cfg.ts");
  });

  it("别名不误伤正向读形态：rg --n（= -n，行号照常打印）仍入账", () => {
    // Measured vendored rg 15.1.0: `rg --n` = `-n` = --line-number, matching
    // lines printed as usual. The alias rule only canonicalizes the token to
    // a short flag and consults the blacklist; flags off the blacklist pass —
    // a per-semantics fork, not "reject any --x".
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
    // Measured vendored rg 15.1.0: `rg --c` prints only the count (`2`),
    // `--l` only file names, `--q` empty stdout — all exit 0. This clap alias
    // syntax is not GNU getopt's unambiguous-prefix rule (`--co` is
    // unrecognized in rg, exit 2), so modeling prefix expansion alone would
    // miss it entirely and the ledger would record the false fact "the model
    // saw content".
    assert.equal(extractSingleReadPath("rg --c SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg --l SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("rg --q SECRET cfg.ts"), undefined);
  });

  it("别名规则只在 ripgrep 成立：GNU 工具的 --c 真机被拒（exit != 0），不建模为短旗标", () => {
    // Measured GNU grep 3.12: `--c` ambiguous (--context/--color/--count),
    // `--l` ambiguous (--label/--line-*); GNU sed 4.9: `--c` unrecognized.
    // All exit != 0 on real machines → the bash exit gate runs first, so
    // nothing is ledgered; hence the alias rule stays rg-only (double-dash in
    // GNU is the long-flag prefix table, not short-flag aliases).
    // `grep --c` is additionally rejected by the existing prefix criterion
    // via its unique `--count` expansion.
    assert.equal(extractSingleReadPath("grep --c SECRET cfg.ts"), undefined);
  });

  it("rg --pre COMMAND：跑 `COMMAND <a.txt`、搜其输出而非文件原文 → 不入账", () => {
    // Measured vendored rg 15.1.0, on-disk a.txt = `PRECIOUS_DISK_CONTENT`:
    //   `rg --pre rev TNETNOC_KSID_SUOICERP a.txt`   rc=0 stdout=`TNETNOC_KSID_SUOICERP`
    //   `rg --pre=rev TNETNOC_KSID_SUOICERP a.txt`   rc=0 same (the `=` spelling is equivalent)
    //   `rg --pre cat PRECIOUS_DISK_CONTENT a.txt`   rc=0 stdout=`PRECIOUS_DISK_CONTENT`
    // `cat` is an identity preprocessor, so that line's stdout happens to
    // equal the disk text; the same slot with `rev` / `sed s/x/y/` / any
    // script fabricates a view — the extractor rejects by **shape**, not by
    // one run happening to be equal. Same family as `-r`/`--replace` (what
    // prints is not guaranteed to be current disk state), and more dangerous
    // than `-q` (nothing visible): the model believes it read the file.
    // End-to-end exploit: `--pre` shows model-fabricated text → file gets
    // ledgered → write_file then clobbers a nonempty file never really read.
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
    // Measured vendored rg 15.1.0: `rg --pre-glob '*.txt'
    // PRECIOUS_DISK_CONTENT a.txt` exits 0 printing `PRECIOUS_DISK_CONTENT`
    // (the disk text) — `--pre-glob` only selects which files pass through
    // `--pre`'s COMMAND, and with no `--pre` no preprocessing happens.
    // Rejecting it would judge a real read as "saw no content" — the other
    // face of a missed record.
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
    // Measured vendored rg 15.1.0: `rg --pr rev PAT a.txt` reports
    // `rg: unrecognized flag --pr`, exit 2 — the bash exit gate stops it, not
    // this extractor. Pins that the prefix criterion is not
    // over-generalized onto rg's clap syntax (GNU's unambiguous-prefix rule
    // does not hold here; rg only knows `--pre` / `--pre-glob` / `--pretty`).
    assert.equal(extractSingleReadPath("rg --pr rev PAT a.txt"), undefined);
  });

  it("rg --crlf 是 boolean（vendored rg 15.1.0 实测：值不被吞，按 pattern 解析）", () => {
    // Real machine `rg --crlf X PAT f.txt`: rc=2, stderr
    // `rg: PAT: No such file or directory` — X is not swallowed; it parses
    // as the pattern, PAT as a file path, which does not exist (per
    // `--debug` rg searched 1 file). Two-file case
    // `rg --crlf MARKER a.txt b.txt`: rg really reads both (debug:
    // `number of paths given to search: 2`), and the extractor's "exactly
    // one operand after slice(1)" rule gives undefined — naturally
    // fail-closed.
    // The real read form `rg --crlf PAT a.txt` must yield `"a.txt"`; the old
    // implementation listed `--crlf` in RG_ARG_FLAGS, swallowed PAT into
    // undefined (a missed record), and mis-recorded
    // `--crlf MARKER a.txt b.txt` as `"b.txt"` after slice(1) left only
    // `[b.txt]`, while rg had actually read both files (a wrong record).
    assert.equal(extractSingleReadPath("rg --crlf PAT a.txt"), "a.txt");
    assert.equal(
      extractSingleReadPath("rg --crlf MARKER a.txt b.txt"),
      undefined
    );
  });

  it("rg --o = -o = --only-matching：实测只打印匹配片段，不是整行 → 不入账", () => {
    // Measured vendored rg 15.1.0 (inputs `xxSECRETyy` / `zzSECRETww`):
    // `rg -o` / `rg --o` / `rg --only-matching` produce byte-identical
    // output — only `SECRET`, no full lines. A single-letter alias does not
    // change flag semantics, so `--o` follows the existing
    // `-o` / `--only-matching` criterion (before the fix `--o` was also
    // rejected via its unique `--only-matching` prefix; the alias rule makes
    // the rejection share the same source as `-o`).
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
    // The prefix rule must not hit non-blacklisted long flags
    // (`--line-number` prefixes nothing on the blacklist).
    assert.equal(extractSingleReadPath("grep --line-number pat f.ts"), "f.ts");
  });

  it("零窗口形态按形状入账（判据不是观察到的输出）：head -n 0 / -c 0 仍抽出 path", () => {
    // The decision chain is "whitelisted command + exactly one concrete file
    // operand + no suppressing flag", not "content appeared on stdout". So a
    // zero window (`head -n 0`, exit 0, no output) is still ledgered.
    // Zero values are not parsed: `-n` / `-c` semantics fork on sign for
    // head / tail (`head -n -0` prints the whole file, `tail -n -0` prints
    // nothing), and later window flags override earlier ones in the same
    // command (measured: `head -n 0 -c 5` prints 5 bytes) — value-based
    // "zero window" detection would have to replicate that precedence, more
    // risk than gain. This pins the decision in tests so doctrine and code
    // cannot silently drift apart.
    assert.equal(extractSingleReadPath("head -n 0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head -c 0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("tail -n 0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head --lines=0 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head --bytes=0 cfg.ts"), "cfg.ts");
    // Look-alike forms that really print content must still pass (rejecting
    // zero windows would sweep them in).
    assert.equal(extractSingleReadPath("head -n 0 -c 5 cfg.ts"), "cfg.ts");
    assert.equal(extractSingleReadPath("head -n -0 cfg.ts"), "cfg.ts");
  });
});

/**
 * Group A: non-read short-circuit flags — "print and exit, operands never
 * touched".
 *
 * These flags make the command exit 0 with only help / version text on
 * stdout; the operands **are never opened**. Ledgering on "exactly one
 * operand left" alone would record unread files as read, and `write_file`
 * would then allow clobbering unread nonempty files — exactly the shape this
 * gate exists to stop.
 *
 * The reject sets are per-command and must not be shared — the same spelling
 * means different things:
 *   - `grep -h` = `--no-filename` (**normal read**, measured prints matching lines);
 *   - `rg -h` = `--help` (rejected);
 *   - `nl -h` = `--header-numbering` (takes a value; `nl -h n a.txt` prints normally);
 *   - uutils `cat/head/tail -h` = `--help` (rejected, implementation-dependent).
 *
 * All rc / stdout notes below are measured on this machine: uutils coreutils
 * 0.8.0 (cat / nl / head / tail), GNU grep 3.12, GNU sed 4.9, vendored
 * ripgrep 15.1.0 (linux-x64).
 */
describe("extractSingleReadPath — 簇 A：非读短路旗标", () => {
  const NON_READ_CASES: ReadonlyArray<string> = [
    // Measured: cat --help / -h / --version / -V all rc=0 with only help or
    // version text on stdout (`cat -h a.txt` prints "Concatenate FILE(s),
    // ..."), never a.txt's content.
    "cat --help a.txt",
    "cat -h a.txt",
    "cat --version a.txt",
    "cat -V a.txt",
    // uutils accepts unambiguous long-flag prefixes too: measured
    // `cat --he a.txt` / `cat --hel a.txt` both rc=0 printing help.
    "cat --hel a.txt",
    // Measured nl: --help / --version / -V rc=0 printing help / version.
    // `nl -h` alone is rc=1 (invalid numbering style) and `nl -h n a.txt` is
    // a real read (see positive control) → `-h` stays out of nl's reject set.
    "nl --help a.txt",
    "nl --version a.txt",
    "nl -V a.txt",
    // Measured head / tail: --help / -h / --version / -V all rc=0 with no
    // file content; `-v` is verbose (prints "==> a.txt <==" plus the full
    // text) → not rejected.
    "head --help a.txt",
    "head -h a.txt",
    "head --version a.txt",
    "head -V a.txt",
    "head --he a.txt",
    "tail --help a.txt",
    "tail -h a.txt",
    "tail --version a.txt",
    "tail -V a.txt",
    // Measured grep: `grep -h PAT a.txt` prints matching lines, byte-identical
    // to `grep --no-filename PAT a.txt` → `-h` must never enter the reject
    // set; only --help / --version / -V print-and-exit (none emits matching
    // lines).
    "grep --help PAT a.txt",
    "grep --version PAT a.txt",
    "grep -V PAT a.txt",
    "grep --hel PAT a.txt",
    // Measured sed: --help / --version rc=0 with no file content, and
    // position-independent (`sed -n 1,2p --help a.txt` rc=0 prints help).
    // `sed -h` / `-V` are rc=1 on the real machine (exit gate first) → only
    // long flags need listing.
    "sed --help a.txt",
    "sed --version a.txt",
    "sed -n '1,2p' --help a.txt",
    // Measured rg: --help (full) / -h (short) / --version / -V / --type-list
    // all rc=0 without file content; `--generate man` emits a man page and
    // likewise reads no operands.
    "rg --help PAT a.txt",
    "rg -V PAT a.txt",
    "rg --type-list PAT a.txt",
    "rg -V a.txt",
    "rg -h a.txt",
    "rg --type-list a.txt",
    "rg --generate man PAT a.txt",
    // bat / batcat: not installed on this machine (`which bat` empty), **not
    // measured**; per bat's CLI contract --help / -h / --version / -V /
    // --list-languages / --list-themes all print-and-exit without reading
    // FILE. Fail-closed direction: a wrong call only misses a record.
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
    // "Did not read" (this group) and "read but content invisible"
    // (CONTENT_SUPPRESSING_FLAGS) are distinct reasons, kept separate in
    // comments and code — merging them into one table invites adding or
    // removing entries for the wrong reason.
    assert.equal(extractSingleReadPath("grep -q SECRET cfg.ts"), undefined);
    assert.equal(extractSingleReadPath("cat --help cfg.ts"), undefined);
  });
});

/**
 * Group B: canonicalization asymmetry of ripgrep's single-letter double-dash
 * aliases.
 *
 * rg runs on clap, which besides GNU getopt's unambiguous prefixes also
 * accepts single-letter double-dash aliases (`--g` is `-g`). The original
 * implementation canonicalized aliases only on the blacklist side
 * (`canonicalShortAlias` was called only by `matchesDeniedFlag`), while the
 * operand side (`consumeOperandToken`) looked up the **pre-canonical** raw
 * token — `--g` / `--t` / `--A` … were absent from the value-swallowing
 * table, so their value tokens counted as operands, and the miscount could
 * land on exactly "one" → wrong record.
 *
 * Measured (vendored rg 15.1.0): `rg --X VALUE PAT a.txt` and
 * `rg -X VALUE PAT a.txt` are **byte-identical** for
 * X ∈ {g,t,m,j,M,r,f,e,A,B,C,d,E,T} — same semantics for both spellings, so
 * the verdict must match. That is this group's criterion: parity, not
 * "reject any --x".
 */
describe("extractSingleReadPath — 簇 B：ripgrep 单字母双横线别名归位", () => {
  /** Aliases of value-taking short flags + one legal value each (the value itself is not a file). */
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
   * The original wrong-record shape: the value token is not swallowed →
   * miscount → the token in the pattern slot is taken for the file. None of
   * these short-flag forms reads a.txt (once the value is swallowed, a.txt
   * lands in the pattern slot and rg walks the cwd with no file operands),
   * so all must be undefined.
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
    // Measured: `rg --g '*.ts' package.json` and `rg -g '*.ts' package.json`
    // are byte-identical (rc=2 "No files were searched" with stdin closed) —
    // `-g`'s value is the glob and `package.json` is the pattern, which rg
    // never reads. After canonicalization, the grep-family rule "first
    // operand is the pattern" slices it away → 0 operands → undefined.
    assert.equal(
      extractSingleReadPath("rg --g '*.ts' package.json"),
      undefined
    );
    assert.equal(extractSingleReadPath("rg -g '*.ts' package.json"), undefined);
  });

  it("rg -f / --f / --file 是 pattern 来源：其后的首个位置参数是路径，不是 pattern", () => {
    // Measured vendored rg 15.1.0: `rg -f pats.txt PAT a.txt` is rc=2 with
    // `rg: PAT: No such file or directory` — every positional after `-f`
    // resolves as a path (two paths → not "one file read");
    // `rg -f pats.txt a.txt` is rc=0 printing a.txt (single-file read). The
    // alias `--f` and the long flag `--file` mean the same.
    assert.equal(extractSingleReadPath("rg --f pats.txt PAT a.txt"), undefined);
    assert.equal(extractSingleReadPath("rg -f pats.txt PAT a.txt"), undefined);
    assert.equal(
      extractSingleReadPath("rg --file pats.txt PAT a.txt"),
      undefined
    );
  });

  it("三 token 形态按实测与短旗标同裁决（清单里的「应 undefined」实测为 credit）", () => {
    // Reuses every spelling from the list above, pinning the post-fix
    // verdict. None of these flags suppress content or rewrite output (type
    // / glob / context / count / threads / depth / encoding), and rg's
    // filters **do not apply to explicitly given files** (measured
    // `rg -t ts ZZMARK z.txt` rc=0 prints z.txt) → after the value is
    // swallowed, pattern + file remain, so the verdict credits a.txt.
    // Making it undefined would turn the short-flag form (currently credited,
    // identical semantics) into a new "second face" — the very defect class
    // this group fixes.
    assert.equal(extractSingleReadPath("rg --t ts PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --m 3 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --j 4 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --M 100 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --A 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --B 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --C 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --d 1 PAT a.txt"), "a.txt");
    assert.equal(extractSingleReadPath("rg --E utf-8 PAT a.txt"), "a.txt");
    // `-r/--replace` is the exception: it prints lines with matched parts
    // replaced, not disk text — same criterion as sed's `-n -e 's/a/b/p'`
    // and grep's `-o` (printed text is not verbatim full lines) → rejected.
    // The short flag is rejected too; parity holds.
    assert.equal(extractSingleReadPath("rg --r X PAT a.txt"), undefined);
    assert.equal(extractSingleReadPath("rg -r X PAT a.txt"), undefined);
    assert.equal(extractSingleReadPath("rg --replace X PAT a.txt"), undefined);
  });
});

/**
 * Positive controls against over-rejection. The reject tables above are
 * per-command, and the easiest mistake is "reject any `--x`" or sweeping a
 * normal-read short flag into a table — these spellings must keep crediting.
 */
describe("extractSingleReadPath — 正向对照（拒集不得误伤真读形态）", () => {
  const STILL_READS: ReadonlyArray<readonly [string, string]> = [
    ["cat -n a.txt", "a.txt"],
    ["head -n 5 a.txt", "a.txt"],
    ["tail -n 2 a.txt", "a.txt"],
    // Measured: head -v / head --verbose / tail -v all print "==> a.txt <=="
    // plus content (rc=0) — verbose is not help, `-v` stays out of the reject
    // set.
    ["head -v a.txt", "a.txt"],
    ["head --verbose a.txt", "a.txt"],
    ["tail -v a.txt", "a.txt"],
    // Measured GNU grep 3.12: grep -h PAT a.txt prints matching lines (= --no-filename).
    ["grep -h PAT a.txt", "a.txt"],
    ["grep --no-filename PAT a.txt", "a.txt"],
    // Measured: nl -h is --header-numbering (takes a value); `nl -h n a.txt` rc=0 prints content.
    ["nl -h n a.txt", "a.txt"],
    // Measured GNU sed 4.9: both script sources print the first two lines.
    ["sed -n '1,2p' a.txt", "a.txt"],
    ["sed -n -e '1,2p' a.txt", "a.txt"],
    // Measured vendored rg 15.1.0: --no-heading / --hidden / -v print content as usual.
    ["rg --no-heading PAT a.txt", "a.txt"],
    ["rg --hidden PAT a.txt", "a.txt"],
    ["rg -v PAT a.txt", "a.txt"],
    // Measured: type / glob filters do not apply to explicit paths
    // (`rg -t ts ZZMARK z.txt` rc=0 prints z.txt) → these forms really read
    // the file.
    ["rg -t ts PAT a.txt", "a.txt"],
    ["rg --type ts PAT a.txt", "a.txt"],
    ["rg -A 1 PAT a.txt", "a.txt"],
    ["rg --A 1 PAT a.txt", "a.txt"],
    ["rg -g '*.ts' PAT a.txt", "a.txt"],
    ["rg --g '*.ts' PAT a.txt", "a.txt"],
    // Measured: -f supplies patterns, later positionals are paths
    // (`rg -f pats.txt z.txt` rc=0 prints z.txt) → single-file reads still
    // get ledgered. The long flag `--file` was wrongly rejected only because
    // its prefix hits `--files`; after the fix, exact-flag match wins.
    ["rg -f pats.txt a.txt", "a.txt"],
    ["rg --f pats.txt a.txt", "a.txt"],
    ["rg --file pats.txt a.txt", "a.txt"],
    ["grep -f pats.txt a.txt", "a.txt"],
    // Measured vendored rg 15.1.0: `rg --pre-glob '*.txt' PRECIOUS a.txt` is
    // a single-file read (`--debug` log: `number of paths given to search: 1`),
    // pattern `PRECIOUS`, file `a.txt`. `--pre-glob` takes a value; if it is
    // not in the value-swallowing table the value token falls into operands,
    // and slice(1) leaves 2 operands → a false negative in the missed-record
    // direction.
    ["rg --pre-glob '*.txt' PRECIOUS a.txt", "a.txt"],
  ];

  for (const [command, expected] of STILL_READS) {
    it(`${command} → ${expected}`, () => {
      assert.equal(extractSingleReadPath(command), expected);
    });
  }

  it("结构不变式：KNOWN_FLAGS[command] 恰为三张表的并集（防漂移锁）", () => {
    // `matchesDeniedFlag` disambiguates by "exact hit in KNOWN_FLAGS skips
    // unambiguous-prefix expansion", and `KNOWN_FLAGS` is derived from the
    // three tables. If a fourth reject table is added later, or one table is
    // removed from the derivation, the new reject items would lack this
    // disambiguation: `--type` (legal value-taker) wrongly rejected by
    // `--type-list`'s prefix criterion, or vice versa a needed rejection
    // missed.
    //
    // The assert uses a **union equality**, not a one-way subset: a subset
    // still passes when a table is dropped from the derivation (those items
    // leave the traversal entirely); only equality goes red immediately.
    // Adding a legitimate fourth table forces this test to update — exactly
    // what a drift lock is for.
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
    // The same spelling means opposite things in grep / rg; tables must be
    // per-command, never shared instances.
    const { CONTENT_SUPPRESSING_FLAGS, NON_READ_FLAGS, ARG_TAKING_FLAGS } =
      __forTestStructuralInvariant;
    // `-L`: grep means --files-without-match (rejected), rg means --follow (allowed).
    assert.equal(CONTENT_SUPPRESSING_FLAGS.grep?.has("-L"), true);
    assert.equal(CONTENT_SUPPRESSING_FLAGS.rg?.has("-L"), false);
    // `-h`: rg means --help (rejected), grep means --no-filename (allowed).
    assert.equal(NON_READ_FLAGS.rg?.has("-h"), true);
    assert.equal(NON_READ_FLAGS.grep?.has("-h") ?? false, false);
    // `-r`: rg's `-r` is --replace (rejected) and also sits in the
    // value-taking table (its value really is a value).
    assert.equal(CONTENT_SUPPRESSING_FLAGS.rg?.has("-r"), true);
    assert.equal(ARG_TAKING_FLAGS.rg?.has("-r"), true);
    assert.equal(CONTENT_SUPPRESSING_FLAGS.grep?.has("-r") ?? false, false);
  });
});
