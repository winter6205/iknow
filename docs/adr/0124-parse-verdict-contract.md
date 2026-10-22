# 0124. 解析判定契约：六档分类与 fail-closed 归宿

Date: 2026-09-24
Status: accepted; superseded-by ADR-0127 §Decisions 1–2 for security-relevant uncertainty only

ADR-0127 governs security-relevant uncertainty in an `ok` tree or `unknown-syntax` result, including its `full_auto` disposition. The other parse verdicts and their existing destinations remain in force.

## Context

ADR-0123 定了统一解析地基（tree-sitter 原生绑定、同步 `parseForSecurity`）。地基与各墙之间需要一份共同输入契约：一条命令的解析结果分几档、每档在权限系统里走到哪。没有这份契约，各墙会退回各自扫裸文本。本 ADR 记录 wayfinder map `unified-shell-parsing` usp-2 的定案；`full_auto` 下不撞硬墙即放行（`policy.ts` 步骤 3）是既有事实，本契约的"ask 归宿"以其为基准平价设计。

## Decision

`parseForSecurity` 输出**六档判定**，消费规则如下：

1. **ok**（树完整且结构全部已建模）：墙检查树中**每一个命令节点**（循环体内、替换括号内的都算；替换语法的具体政策归 spec/usp-4）。命中危险 id → deny；未命中 → 现有分层规则/模式流程，与今天同构。
2. **unknown-syntax**（解析成功，但含未建模的节点类型）：落正常权限流 **ask**，reason 注明"含未识别语法结构"；full_auto 下与现状平价放行。依据：未知 ≠ 危险，硬墙只管危险意图（ADR-0117 精神）；grammar 升级新增句式时不至于大面积误拒。
3. **malformed**（树带 ERROR，如引号不闭合）：**硬拒**。bash 对其行为不可预期，ERROR 也可能是解析分歧的表现。
4. **aborted**（超时预算 → null，或 READY 后任何意外异常）：**硬拒**。可被对抗性输入刻意触发，必须 fail-closed。
5. **over-cap**（超过调用侧长度上限，不进解析器）：**硬拒**，reason 写明"过长无法分析"。上限取值从宽（64KB 量级，精确值归 spec），保住 heredoc 写文档类正当长命令。
6. **parser-unavailable**（**初始加载失败**）：降级旧裸子串扫描 + 醒目日志 + **TUI 输入框区域红字警示**（降级不许静默）。这是**唯一**的降级路径：UNAVAILABLE 为进程内终态、不重试；加载成功（READY）后的任何运行时故障一律归第 4 档硬拒；旧扫描自身抛异常 → 硬拒该条命令（兜底）。

**前置否决（分档之前）**：命令含**解析分歧字符**——控制字符（豁免 `\t\n\r`）、Unicode 空白/零宽（NBSP、ZWSP、BOM 等）、反斜杠+空白——连解析都不做，直接**硬拒**，reason 写明字符类别。依据：这些形状使"分析器所见 token ≠ bash 所见 token"，契约的信任基础失效；零宽字符人眼不可见，ask 等于让人盲签。清单住 `shell-parse.ts`、登记进 spec，每发现一个新分歧登记一条（`echo\ test` 类合法惯用法的误拒由 reason 提示改写为引号形式）。

> **2026-10-04 修正（不删除上文）：** 上句列出的「反斜杠+空白」作为**无条件成员**的读法，连同括号里的 `echo\ test` 改写提示，**已被下方 Amendment (2026-10-04) 收窄取代**。控制字符（豁免 `\t\n\r`）与 Unicode 空白/零宽两项成员不变。新名册是「按词边界、引号语境与转义奇偶逐点判定」，不是一刀切；下文原句保留作该条被取代前的历史契约。

## Consequences

**正面 / Applied:**

- 六档判定是所有墙的唯一解析输入；新增墙只定义"在 ok 树上查什么"，不再触碰分档语义。
- "坏了降级"与"坏了硬拒"的区分零运行时诊断：一个初始化时设置一次的三态标志（UNINITIALIZED → READY / UNAVAILABLE）+ 一个 try/catch，约五行代码。
- unknown-syntax 与现状平价，grammar/依赖升级不引发误拒风暴。

**负面 / Trade-offs:**

- full_auto + 未知句式 = 自动放行（与今天相同，未收紧）；更严选项（未知 → 硬拒）被明确放弃，代价是升级期误拒。
- 反斜杠+空白入前置否决清单，`echo\ test` 被拒（reason 给改写提示）。**（2026-10-04 修正：此条代价声明描述的是被取代前的名册——`echo\ test` 现属受支持拼写，改写提示也已移除。见下方 Amendment (2026-10-04)。）**
- malformed / over-cap 比现状更严（今天落正常流程）；误拒成本低：bash 自己多半报语法错、模型可自纠。
- 旧扫描器必须永久保留为降级层（预答 usp-5"旧扫描器去留"的一半）；红字警示的呈现形态（sticky notice 还是一次性）归 spec。

## Evidence pointers

- 决策过程：`docs/wayfinder/tickets/usp-2-tristate-fail-closed-contract.md`（map `unified-shell-parsing`）。
- 超时确定性 / stale-state / 解析分歧字符实测：`docs/wayfinder/research/usp-1-parser-survey.md`。
- 地基形态：ADR-0123；硬墙职责划分：ADR-0068（经 ADR-0123 修正）。

## Amendment (2026-09-27): commandless operator bodies

The Stage 3 bare-metachar work adds one narrow exception to the `ok` /
`malformed` pair (Decision items 1 and 3): a tree that carries `ERROR` is
graded `ok` when it names no command anywhere — the root is `program` or
`ERROR`, and every node is the root itself, an `ERROR` wrapping only
bare-operator tokens from a closed whitelist (`;`, `;;`, `&&`, `||`, `|`,
`&`, `>`, `>>`, `<`), or one of those leaf tokens itself
(`commandlessOperatorBody`, `src/harness/permission/shell-parse.ts`). Such
input is a syntax error bash rejects at parse time rather than a command
whose execution behavior is unpredictable, so item 3's stated reason does
not reach it. The roster rule stands unchanged: `ERROR`/`MISSING` never
enter `MODELLED_NODE_TYPES`, and any tree naming a word or command node
still lands `malformed` → hard deny. Because the carve-out is decided
inside `verdictOfTree` — before any wall reads the tree — walls see an
`ok` tree with zero command nodes rather than a new verdict state.

Evidence: SC-S3-1 execution record in `specs/hard-wall-ast-migration.md`;
`tests/harness/permission/bare-metachar-hard-wall.test.ts` and
`tests/harness/permission/shell-parse.test.ts`.

## Amendment (2026-10-04): the backslash-plus-whitespace roster, narrowed by measurement

This amendment **supersedes** the Decision section's blanket membership of
"反斜杠+空白" in the pre-parse roster (the clause reconciled above at
Decision item 「前置否决字符」 and its Consequences trade-off bullet), and it
**removes** the rewrite compensation those two sentences granted
(`echo\ test`-shaped false positives were answered with a rewrite hint to the
quoted form). It narrows one roster entry. Everything else in this ADR —
the six-verdict set, the destinations in Decision items 1–6, the
`parser-unavailable` degrade seam as the **only** degrade path, and the
terminal-`UNAVAILABLE` state — is unchanged, and ADR-0127's Decisions 1–2
remain as recorded at the top of this file.

**The amendment is measurement-driven, not preference-driven.** The pinned
parser-versus-real-Bash table in
`docs/evidence/1188-backslash-whitespace-investigation.md:43-54` shows that
`\[ \t\n\r\f\v]` conflates shapes with **different** Bash behavior: unquoted
`a\ b` is one argument `a b` (facade agrees), and separator `a \` LF ` b` is
two arguments `a`, `b` (facade agrees), while mid-word `a\` LF `b` is the
single argument `ab` (facade reports two words), `"x\` LF `y"` is `xy`
(facade's static value still holds backslash and LF), and unquoted
backslash+TAB is one argument containing a TAB (facade reports two words).
A predicate that refuses all five refuses two proven agreements to catch
three measured disagreements. The unavailable-parser counterexample at
`docs/evidence/1188-backslash-whitespace-investigation.md:58-67` is the
second measurement: the legacy scan answers `null` for `rm ` + backslash +
LF + ` -rf /tmp/x` while denying plain `rm -rf /tmp/x`, so a newly supported
spelling must not reach the degrade path.

### Supported (admitted to ordinary permission flow)

Two shapes, and both only under the stated conditions:

1. **backslash + U+0020** inside an ordinary unquoted argv word, and inside a
   standalone single- or double-quoted word, when the word's static
   `WordFact.value` is complete **and** the word is a maximal lexical word —
   the characters immediately before and after its span are word separators
   or string bounds.
2. **unquoted backslash + LF used as a word separator**, when the character
   before the backslash run is U+0020, the character after the LF is U+0020,
   the site is inside no quoted span and no word span, and the LF is absent
   from `bareNewlineOffsets` after the fact-layer parity fix below.

An `ok` parse does not by itself grant execution: a supported spelling
reaches the same permission flow as its unescaped equivalent and is judged
by the existing rules there.

### Retained as `vetoed` / class `backslash-whitespace` (hard deny, not overridable)

Unquoted backslash+TAB; backslash+CR and CRLF; mid-word LF continuations;
double-quoted LF continuations; **any candidate whose parse is not `ok`**;
**any candidate whose affected lexical site has an incomplete static value**
(a missing `WordFact.value` is not evidence of agreement, and the unchanged
AST without `ERROR` does not establish completeness); and **any site whose
backslash run has EVEN parity** — there the whitespace is not escaped by that
run, so the shape is unproven and keeps today's denial.

**Class precedence is pinned, not incidental.** Backslash+FF and
backslash+VT stay denied, but they return class `control-character`, because
`control-character` is ordered ahead of `backslash-whitespace` and owns U+000C
and U+000B (`src/harness/permission/shell-parse.ts:538`, order at
`src/harness/permission/shell-parse.ts:635-641`). The roster therefore does
not require every retained backslash shape to answer `backslash-whitespace`;
requiring it would contradict the ordered rule table.

### The parser-unavailable qualification

The exemptions are gated on an available parse foundation. When the binding
never loaded, every newly supported spelling returns `vetoed` /
`backslash-whitespace` — it does **not** fall through to the legacy
allowance, because the measured counterexample shows that route misses
split destructive flags. After READY, a runtime fault remains `aborted`. The
terminal `UNAVAILABLE` state, its one-time warning, and the existing legacy
route for commands outside this exemption surface are unchanged.

### The rewrite compensation is removed

The model-visible retained reason names the character class and the retained
fidelity limitation, and **suggests no reconstructed command**. The former
`quotedRewrite` helper produced a rewrite that could split one argument or
turn a pipeline or redirection into literal text
(`docs/evidence/1188-backslash-whitespace-investigation.md:16`), so it
suggested a command that was not the command being denied. A bounded
limitation statement replaces it; a general shell rewriter is not required.

### Fact-layer consequence

`bareNewlineOffsets` / `bareCarriageReturnOffsets` are escape-parity aware: a
`\n` / `\r` preceded by an odd-parity backslash run is an escaped line break,
not a bare statement separator, and is therefore absent from both lists
(`src/harness/permission/shell-parse.ts:1878`). The comment that previously
assumed escaped line breaks never reach that scan (`…:1673-1677` at
`2523c1497`) has been replaced by the parity rule.

Unchanged by this amendment: the verdict union, `VetoClass` identity, the
synchronous single entry, the 64 KiB byte cap, exact-original-command cache
keys, source spans, terminal binding-load failure, and the
parser-unavailable-only legacy fallback. No new permission destination, no
new domain term, and no dependency, lockfile, or settings change.

Evidence: `docs/evidence/1188-backslash-whitespace-investigation.md:43-54`
(pinned parser-versus-real-Bash table), `:58-67` (unavailable-parser
counterexample), `:73-79` (rejected shortcuts, including the recorded
`bash -n`-is-not-a-fidelity-oracle result that keeps mid-word denied);
contract and criteria in `specs/backslash-whitespace-veto-repair.md`; glossary
alignment at `docs/CONTEXT.md` (解析分歧字符); consumer and fact
documentation at `docs/shell-parse-non-ok-consumer-contracts.md`.
