---
id: 0001
type: readiness-recap
date: 2026-07-18
---

# Readiness 复盘 · 第一课

## 用户目标

搭建"企业知识库 + 向量检索增强 + LLM 对话辅助"系统 = RAG 全管线 + 工程落地。

## 对标 readiness-rubric

- **所处位置**：RAG 维度 junior 线（用 Dify/Coze 调通过流程，知道 embedding→向量库→问答 轮廓），但未亲手搭全链路，缺底层深度。
- **qualified 信号缺口**：讲清切分/embedding/向量库/重排序/引用溯源；能建离线评测集量化 Recall@k；独立部署真实管线。
- **强项**：已有 Dify/Coze 工程直觉，理解 RAG 的"存在意义"，能快速接手框架层。
- **弱项**：封装黑盒依赖（不会手搭）、无评测闭环、面试讲不到第二层（chunk 策略/rerank 位置/指标）。

## ZPD 决策

首课不写代码，先给"目标反解地图"（5 阶段 × 2 深度），建立全局心智模型；
下一课再动手手搭最简 RAG CLI（~100 行），揭开框架封装，建立第一手经验。

## 引用

- 参考卡片 05-RAG 技术 [原文 P54-85]
- readiness-rubric.json · 维度"RAG 全流程"
