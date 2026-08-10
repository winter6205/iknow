# Markdown 围栏代码块渲染候选 · c4 定稿

> 任务：#321 logo 重设计支线——TUI 围栏代码块（fenced code block）从 ink
> 期 baseline → 5 个候选 → c4 定稿。**正式实现**：PR #360 合并（commit
> `30df69d`）。本档是探索过程的存档，防回退。
>
> 关联：`docs/design/DESIGN-BANNER.md`（同批 banner 重设计收口）、
> `docs/design/DESIGN-BANNER-GRADIENT.md`（同批渐变定稿）。

## 定案一句话

围栏代码块 = **c4**：深灰底 `#1e1e1e`（VSCode dark+ 编辑区同款）+ 默认
字色 `#d4d4d4` + 4 色语法高亮（关键字紫 `#c586c0` / 字符串橙 `#ce9178` /
数字浅青 `#b5cea8` / 注释绿 `#6a9955` + DIM + ITALIC）+ 行内 codespan 保留
`#66b8ae` 不变 + **无边框 + 无 lang 标签**。

## 5 个候选

5 候选由 `scripts/codeblock-preview/c1.tsx` ~ `c5.tsx` 跑出（脚本已随
worktree 删除，本档记录决策过程）。每个候选对应一个真 TUI 截图，操作员
按视觉感受选。

### c1 现状 baseline

- 形态：box border single（顶 / 底 / 左右单线边框）+ 顶框内嵌居中 title
  `<lang>` 标签
- 配色：整块单色 `#66b8ae`（沿用行内 codespan 同款）
- 问题：
  - 顶框 + lang 标签把代码块读成「面板」，不像 inline content
  - 单色 = 没有 token 区分，缩进 / 引号 / 关键字视觉权重一致，扫读
    困难
  - border 在 scrollbox 内视觉过重

### c2 淡灰底 + 无边框

- 形态：去 border，去 title，整块底色 `#2b2f36`
- 配色：整块单色 `#e6e4dc`（warm off-white）
- 优点：去框后代码块融入正文，无视觉冲击
- 问题：
  - 单色问题同上（无 token 区分）
  - 淡灰底在深色主题下边缘对比弱，边界不清晰

### c3 淡灰底 + 正则语法高亮

- 形态：同 c2（淡灰底 `#2b2f36` + 无边框）
- 配色：手写正则 tokenize，4 色语法高亮：
  - 关键字紫 `#c586c0`
  - 字符串橙 `#ce9178`
  - 数字浅青 `#b5cea8`
  - 注释绿（c3 试过加 DIM + ITALIC）
- 默认字色： `#e6e4dc`（沿用 c2）
- 优点：扫读性明显提升
- 问题：
  - 淡灰底 `#2b2f36` 与品牌暗色不够贴，调研决定再深一档
  - 行内 codespan 与代码块字色撞（都走 warm 系），inline 上下文衔接弱

### **c4（定稿）**

- 形态：去 border，去 title，深灰底 `#1e1e1e`（VSCode dark+ 编辑区同款）
- 配色：
  - 整块底色 `#1e1e1e`
  - 默认字色 `#d4d4d4`（VSCode dark+ 默认前背景）
  - 关键字紫 `#c586c0` / 字符串橙 `#ce9178` / 数字浅青 `#b5cea8` /
    注释绿 `#6a9955` + DIM + ITALIC
- 行内 codespan：**保留** `#66b8ae` 不动（与围栏代码块差异化）
- 几何：
  - 超宽不折行 `wrapMode="none"`
  - 空行铺底不塌缩（每行 bg 仍铺 `#1e1e1e`）
  - 块间 marginTop/Bottom = 1
- diff 围栏：首字符 `+` / `-` 行整行绿红底色遮罩（`#2ea043` / `#d73a49`
  fg + `#1f3d2b` / `#3d1f24` bg，与 theme.ts `add`/`del`/`bgAdd`/`bgDel`
  4 token 对齐）
- 优点：
  - VSCode dark+ 编辑区同款 → 用户认知零成本
  - 4 色语法高亮 + 注释 DIM/ITALIC = 扫读性最大化
  - 行内 codespan 与块内字色差异化（`#66b8ae` vs `#d4d4d4`），inline 上下文
    衔接自然
  - 无边框让代码块读作正文流的一部分，不抢戏
- 选定理由（操作员 2026-08-11 决策）：「**VSCode 风格一眼对，深灰底贴产品
  暗主题，无边框 + 无 lang 让代码块像 markdown 一部分**」

### c5 c3 + 首行前置语言标签

- 形态：c3 基础上首行前置 `ts │` 标签（行内、非边框）
- 问题：
  - c4 已证明「无 lang 标签」是更优解，c5 改回加标签走回头路
  - 前置标签与 markdown 文本流不连贯（首行多一列特殊字符）

## 产品实现（PR #360 commit `30df69d`）

### theme.ts 新增 6 token

```ts
codeBlockBg: "#1e1e1e",   // VSCode dark+ 编辑区
codeDefault: "#d4d4d4",   // plain 文本（未匹配语法 token）
syntaxComment: "#6a9955", // 注释（+ DIM + ITALIC）
syntaxString: "#ce9178",  // 字符串
syntaxNumber: "#b5cea8",  // 数字
syntaxKeyword: "#c586c0", // 关键字
```

`code: "#66b8ae"` 字段保留，**只**给行内 codespan 用，与代码块差异化。

### markdown.tsx 重写

- `tokenizeCodeLine(line: string): CodeToken[]` **导出**纯函数——拆分是为
  单测正则 / 捕获组逻辑时不必渲染 JSX（直接断言 `CodeToken[]`）。返回
  类型 `CodeToken { kind: CodeTokenKind, text: string }`，
  `CodeTokenKind = "plain" | "comment" | "string" | "number" | "keyword"`。
- `CodeBlock` 容器 + `CodeBlockLine` 行渲染器重写：
  - `CodeBlock` 外层 `<box backgroundColor={codeBlockBg}>`，无 border 无
    title
  - `CodeBlockLine` 每行 `<text bg={codeBlockBg} wrapMode="none">`，
    按 `tokenizeCodeLine` 切分后逐 token 嵌 `<span fg={对应色}>`，其中
    `comment` token 同时挂 `attributes={DIM | ITALIC}`
- 其它 markdown 元素（heading / paragraph / list / quote / table / html /
  行内 codespan）零改动。

### 测试

`tests/tui/markdown.test.tsx`：

- 删 1 旧测试（lang 标签在边框行，c4 已无）
- 新增 11 个 c4 契约断言（`codeBlockBg` 背景色 / 4 类 syntax token 着色 /
  plain 着色 / 无边框字符 / 无 lang 标签 / diff `+` / `-` 行 / 空行不塌缩）
- 4 个 `tokenizeCodeLine` 单元测试（关键字 / 字符串 / 数字 / 注释切分）

## 验证记录

- `tests/tui/markdown.test.tsx`：上述 11 c4 + 4 tokenize 单测全绿
- 真 TTY 冒烟：`npm run dev:tui` 真实终端代码块渲染贴 VSCode dark+ 视觉
  （`docs/handoff/2026-08-10-tui-321-regression-fixes.md` 验收清单）

## 引用

| 类型                     | 路径 / 引用                                                       |
| ------------------------ | ----------------------------------------------------------------- |
| 产品实现（PR #360 合并） | commit `30df69d` feat(tui): markdown 代码块改 c4 形态             |
| theme 6 token SSOT       | `src/tui/theme.ts:42-53`（注释 + 值 86-91）                       |
| CodeBlock 重写           | `src/tui/markdown.tsx:158-` `CodeToken` 类型 + `tokenizeCodeLine` |
| 单元测试                 | `tests/tui/markdown.test.tsx`                                     |
| 关联                     | `docs/design/DESIGN-BANNER.md`（同批 banner 重设计）              |
| 关联                     | `docs/design/DESIGN-BANNER-GRADIENT.md`（同批渐变定稿）           |
