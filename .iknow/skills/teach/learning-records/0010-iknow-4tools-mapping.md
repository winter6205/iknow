---
id: 0010
type: lesson-recap
date: 2026-07-20
---

# 0010 · iknow 4-tool 架构认知锚定

## 用户状态修正

- 用户明确 mission 不是"开发 gbrain"，而是"准备 AI 应用开发面试 + iknow 作为面试项目"。
- 用户基线比预期更低：Python 基础 + RAG 概念 qualified；TypeScript 基本不懂；Next.js / Vercel AI SDK / Shadcn / Zustand / TanStack Query 零基础。
- 课型优先级：面试导向 > 代码导读 > 技术栈。

## 决策

- 首课不写代码、不讲新框架——做认知锚定：把 iknow 4 tool 映射到用户已学的 RAG 五阶段（0001-0007）。
- 不重复讲 chunking / embedding / 检索 / rerank——这些已合格。直接用它们作"已知坐标"。
- 课内引用的所有代码事实都标 file:line（遵守 NOTES.md 新增的纪律）：
  - `kb_retrieve` 双臂 + RRF：`src/kb-retrieve/retrieve.ts:65-265` / `rrf.ts:13-37`
  - `kb_verify_citation` 三态阈值：`src/kb-verify/verify.ts:79-134`
  - `kb_compile` content_hash 去重：`src/kb-compile/compile.ts:55-170`
  - `kb_governance` 三 action：`src/kb-governance/governance.ts:37-161`
  - `MAX_HOPS=5` + agent loop 流程：`src/agent-loop/loop.ts:23` / `loop.ts:60-367`
  - G2 信封构造：`src/agent-loop/loop.ts:369-388`
- 提供 30 秒面试稿模板（含 Q&A 示范）——让用户课后能直接拿去当面试素材。

## 产出

- `lessons/0008-iknow-4tools-rag-mapping.html`：5.7KB 锚定课，6 个代码段带 TS 注解，3 题 quiz，2 段面试稿示范。
- 用 `assets/base.css` 共享样式 + `assets/quiz.js` 复用组件。
- 复用模式修正：`quiz.js` 实际用的是 `data-correct` + `data-feedback` 属性，不是 `quizInit()` 函数。已修正。

## ZPD 影响

- 用户从"RAG 概念 qualified / 项目零认知"推进到"RAG 概念 qualified / 项目架构能讲清 4 tool + G2 + max_hops=5"。
- **下一步最该补**（按用户优先级排序）：
  1. **面试 Q&A 演练**（最高优先）：用本课的 30 秒稿做 5 轮模拟追问，覆盖"为什么这么设计"类追问。
  2. **代码导读课 0009**：带用户读 `src/agent-loop/loop.ts:60-367` 完整一遍，让他能讲清 loop 里每段 if 在做什么。
  3. **技术栈课**（低优先）：从 Vercel AI SDK 的 `useChat` 开始，因为这是用户接下来真要写 web 的第一个工具。

## 关联

- 0001-readiness-recap、0007-minimal-rag-cli（RAG 基础合格）
- 0009-mission-correction（mission 修正）
- MISSION.md / NOTES.md（本 session 重写）
