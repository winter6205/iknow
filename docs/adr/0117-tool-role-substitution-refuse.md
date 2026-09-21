# 0117. 工具职分不可替代，替岗拒绝

Date: 2026-09-21
Status: accepted

## Context

`bash`、ACI `grep` 与 **符号工具面** 在同一张 ACI 表上同等可调用，职分却不是同一件事（进程 / 搜正文 / 程序结构）。usage 写了「代码结构先符号工具」，能力面没有对等边界；预训练又偏向最泛的 sink（bash）。`68f3aacc` 全程 bash grep/sed 扫源码、符号工具 0 次。操作员要求：政策按职分拒绝；实施在 worktree 用黄金集验收；可另开一棵对照树比效果，但那不是第二套产品政策。

## Decision

1. **政策：** 按职分 fail-closed（**替岗拒绝**），不按谁更高级排序，不加长 usage，不进 **hard-wall**（ADR-0068）。bash 扮演 grep 族 / `rg` → 拒绝并指向 ACI `grep` 或 `find_symbol`；ACI `grep` 扮演代码结构查询且本会话没有 usage 三类回退证据 → 拒绝并指向 `find_symbol`。`sed`/`cat`/`nl` 行窗仍是读（last-read）。证据认轨迹不认自觉。
2. **验收（实施必做）：** 在 worktree 落地；soul/usage **轨迹集**（黄金集）锁「问源码结构 → 首工具 ∈ 符号工具面」，含 bash 替岗必须失败。无集不得声称完成（`docs/guides/prompt-development.md` 名册缺口行一并补）。
3. **对照树（记下的实验边界，不是第二产品政策）：** 允许第二棵 worktree 只做「bash 替岗拒绝、ACI `grep` 不闸」，与树 A **同一黄金集** 比首工具服从和误伤。比完只合入树 A 政策。禁止把源码扩展名启发式、soft 警告、只加长 usage 当成对照方案。

本 ADR 不实施代码。

**Why not 只加长 usage：** 说明书不是闸（`docs/guides/prompt-development.md` 原则 1；ADR-0014 同一课）。  
**Why not 源码扩展名拦 bash：** argv 启发式会漏 `grep -r` / 无扩展名路径，且 ACI `grep` 仍可替岗。  
**Why not 塞进 hard-wall：** 硬墙是危险意图，不是工具职分。  
**Why E3 认单次失败哨兵、不按轨迹数重试：** usage 类三的「先重试一次」是对模型的指引，且 LSP 客户端可能在**单次调用内部**重试；闸只认轨迹，看不进一次调用内部，按 tool_use 计数会把内部重试误判为「未重试」而拒绝合法回退。单次可读失败哨兵已证明本会话语言服务器确实没答上来——这就是类三事实。  
**Why 结构形 ≠ 结构意图：** 闸认的是冻结定义语法表（关键字 `function`/`class`/`def`/`impl`/`export`…、行首 `^` 绑 ident+`(`、修饰组 `(async)?`/`(public|private)*`），不是「这个 pattern 可能在找定义」。未锚定 `ident(`（`\bload\s*\(`、`console.log(`）留作正文面，避免把调用点搜索当替岗。

## Consequences

**正面 / Applied:** 能力面与 usage 三类回退对齐；bash 不再是搜代码的合法逃生口。  
**负面 / Trade-offs:** 关键字形（`class Foo`）在源码里当字符串搜、且本会话尚无符号工具轨迹时会被拒；对照树 B 量化误伤，比完不留第二政策。  
**接受面（登记，不在本政策加启发式堵）：**

- bash：只查段首 token，且段边界用 `splitShellSegments` 的 `;` / `&&` / `||` / `|`——**换行不算本闸的段边界**（与 ADR-0068 危险扫描那道墙的按行分岔语义不同，两道墙各用各的），故 `printf x\ngrep …` 一类换行后置的 grep 可穿过；`git grep` 放行；`find … | xargs grep`、`$(which grep)` 一类间接调用可穿过。
- ACI grep：未锚定 ident+`(`；表外定义关键字（如 Go `func`、Rust `fn`）在未叠加 `^`/修饰组时当正文。
- 语言：不按扩展名封搜；无 LSP 时走 E3 后结构形 grep 仍合法。
