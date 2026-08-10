---
id: 0004
type: learning-record
date: 2026-07-18
topic: Chunking 切分原理
trigger: 用户确认"先这样进行下一步" → 推进原理系列第三课
---

# 学习记录 · 第三课 Chunking

## 已建立的原理

1. chunk 大小 = 语义精度 vs 上下文完整 的权衡（大 chunk 稀释语义方向、小 chunk 丢上下文）。
2. overlap 解决"边界切分导致语义断裂"——相邻 chunk 共享文本提升召回率，代价是存储/检索量膨胀 10-20%。
3. 三种策略：固定长度（baseline）/ 语义切割（结构清晰文档）/ 递归切分（混合长度）。
4. chunk 大小无绝对最优，必须靠 200 条评测集 + Recall@k 曲线来选（工程实验，不是配置项）。

## 外部信源（补缺，已验证）

- LlamaIndex 官方 blog：chunk_size=1024 在响应时间/忠实度/相关性上最优平衡。
- Reddit r/LocalLLaMA 实证：数百页政策文档 chunk=2000/overlap=500 + 重排有效；短代码查表用小 chunk。
- 社区共识：overlap = chunk 长度 10-20%。
- 注：web_extract(Tavily) 本次失败(Bad Request)，web_search 提供足够社区实证，与 PDF 知识卡无冲突。

## 可复用组件

- 新建 `assets/chunk-viz.js`：chunk 大小 + overlap 滑块驱动的句子级召回可视化。
- 验证：`node --check` lint status: ok。

## 用户 ZPD 风险提示

- 用户在 Q1/Q3（lesson 0002）暴露"名词层"问题（余弦≠距离、记反管线时序）。chunking 是另一个高频踩坑点（"越大越好/越细越好"误区），后续需在其自测中逼出"为什么"。
- 用户主动追问训练原理/向量空间，说明已具备原理好奇心，可适度加深但不越级。

## 下一步

- 第四课：手搭最简 RAG CLI（~100 行），把 embedding+chunking+检索+生成串成管线，亲手验证 chunk_size 影响。
