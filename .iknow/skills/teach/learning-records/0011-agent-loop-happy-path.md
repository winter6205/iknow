---
id: 0011
type: lesson-recap
date: 2026-07-20
---

# 0011 · Agent Loop 代码导读 (happy path)

## 用户决策

用户说"这 3 个东西并不冲突。面试是在项目开发好并且理解项目的前提下进行的"——意思是 3 条线（面试 / 代码导读 / 技术栈）不分开走，理解项目是上游、面试是下游。

## 决策

- 不再单独开"面试 Q&A 演练"课——把面试素材融进每节代码导读课里（每节都带 2-3 个 Q&A 示范）。
- 下一节直接是代码导读：读 `src/agent-loop/loop.ts` 的 happy path。
- 同时承担三个目标：读懂代码（代码导读）+ 能向面试官讲清 loop（面试）+ 学 TS 语法（技术栈基础）。

## 产出

- `lessons/0009-agent-loop-happy-path.html`：4 个 step + 完整流程图 + 3 题 quiz + 3 段面试 Q&A。
- 每段代码都带 TS 语法注解（async/await / interface / let vs const / 展开运算符 / 非空断言 / 箭头函数返回对象 / 三元表达式），目标："看到 TS 不慌"。
- 所有代码引用都标 file:line（loop.ts:60-92 / 170-184 / 232-273 / 288-304 / 331-388）。

## ZPD 影响

- 用户从"知道 4 tool 是什么"推进到"能讲清一个问题的完整生命周期 + 知道为什么这样设计"。
- **关键概念已建立**：
  - hop 预算机制（loop.ts:23 注释 + hopState 模式）
  - G2 铁律（never return without snapshot_id）
  - 轮内 prior_chunks 用途（verify 失败后换一块）
  - governance 不计 hop 的理由（盖章 vs 探索）
- **下一步最该补**：
  1. **边界情况导读**（loop.ts:114-168）：竞对拦截、敏感数据 requireApproval、empty_answer 防幻觉。
  2. **safeGovernance 降级路径**（loop.ts:494-535）：超时/权限拒绝时如何降级返回本地 snapshot。
  3. **Vercel AI SDK useChat**（用户优先级第 3）：开始补 web 技术栈。

## 关联

- 0008-iknow-4tools-rag-mapping（认知锚定）
- 0001-0007 RAG 原理链
- 0010-iknow-4tools-mapping（评估）
