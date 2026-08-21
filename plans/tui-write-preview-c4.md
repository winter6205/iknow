# Plan: write 完成态预览接 c4 CodeBlock

**Goal:** `write_file` 新文件折叠预览与助手消息围栏代码块同一套 c4 渲染（深灰底 + 语法高亮），不再裸 `<text>`。
**Approach:** 导出并复用 `src/tui/markdown.tsx` 的 `CodeBlock`；`CompletedToolPreviewView` 的 `kind === "code"` 走它。`kind === "diff"` 仍用 `DiffView`。行账与渲染物理行对齐。
**Spec link:** `docs/design/codeblock-preview.md`（c4）；承接 `plans/tui-write-fold-preview.md`（该计划曾把围栏 CodeBlock 标为 out of scope）。
**ACR:** all-yes（见下）。

## Affected files

- `src/tui/markdown.tsx`（导出 `CodeBlock`；可选 compact 去掉块间 margin，避免工具卡多 2 空行）
- `src/tui/completed-tool-preview-view.tsx`
- `tests/tui/live-tool-preview.test.tsx` 和/或新 `tests/tui/completed-tool-preview-view.test.tsx`
- 本文件

## 5-line verdict

bounded-context-guardian: yes — 只动 `src/tui/` 展示层；数据仍来自 `completedToolPreview`，不把 markdown lexer 当工具 input 权威源。
defensive-contract-validator: yes — empty 仍不渲染；code 走 c4（bg + keyword/string）；overflow 仍 dim 文本；diff 路径不变；parity 行账。
error-handling-enforcer: yes — 不新增 catch；empty → null。
complexity-anti-drift: yes — 不复制 tokenize；视图映射到已有 `CodeBlock`。
minimal-change-verifier: yes — 1 逻辑任务：完成态 code 预览接 c4。

**OVERALL: PASS**

## Settled

- `kind === "code"` 必须使用 markdown 的 `CodeBlock` / `CodeBlockLine`（同一 `codeBlockBg` + `tokenizeCodeLine`），禁止再手写无底色 `<text>{line}</text>`。
- lang：c4 不画 lang 标签；tokenize 对非 diff 不依赖 lang → 传 `""` 即可。
- 垂直 margin：工具卡用 compact（无 marginTop/Bottom），左右 padding + 底色与围栏块一致，以免 live 行账多 2 行。
- `kind === "diff"` 不改。
- 溢出「还有 N 行」仍在块外 dim 文本。
