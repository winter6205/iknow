---
id: 0009
type: mission-correction
date: 2026-07-20
---

# Mission 修正 · 从"求职面试"到"讲清 iknow 项目"

## 背景

用户发起 /teach 会话，表达核心痛点：「随着开发，我已经越来越不知道在干什么了，一些技术细节我也完全不懂」。同时给出从其他智能体调研得到的技术栈清单（Next.js 15 / Vercel AI SDK / Shadcn / Zustand / TanStack Query），明确表示"我基本上什么都不懂，我只会基础的 Python"。

## 诊断

- 旧 MISSION.md 是"AI 应用开发求职面试"导向，PDF 知识卡 01-16 按求职模块排。
- 上一个智能体产出了 7 节 RAG 原理课（0001-0007），质量尚可，但**没有接回 iknow 项目**——用户学了"最小 RAG"玩具，但 iknow 是真实代码（双引擎、MCP、OAuth、SSRF…），他读不懂也讲不清。
- 用户不是"学得少"，是**学的没接回项目**，且项目代码他写不动也读不懂。

## 修正后的 Mission

- **主轴不变**：依然是 AI 应用开发求职面试。
- **手段变了**：iknow 仓库 = 面试项目。核心任务从"学 RAG 概念"变成"把 iknow 从 AI 写的代码变成我能向面试官讲清的项目"。
- **课型排序**（用户明确）：面试导向 > 代码导读 > 技术栈。
- **基线修正**：TypeScript 基本不懂；Next.js / Vercel AI SDK / Shadcn / Zustand / TanStack Query 零基础；gbrain 上游没读源码；RAG 概念已 qualified。

## ZPD 决策

第一课不写代码、不讲新框架。先做**认知锚定**：把 iknow 的 4 tool（kb_retrieve / kb_verify_citation / kb_compile / kb_governance）逐一映射到用户已学的 RAG 五阶段（0001 课），让他看到"你学的不是白学——iknow 就是这些概念的工程实现"。这是从"概念层"到"项目层"的桥。

## 关联

- 0001-readiness-recap（RAG 维度 junior→qualified）
- 0007-minimal-rag-cli（手搭 RAG CLI 实证）
- MISSION.md（本次重写）
- NOTES.md（基线修正 + 教学纪律）
