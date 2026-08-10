# 0007 · 手搭最简 RAG CLI，切分/重排序 真实验证

- 日期：2026-07-19
- 类型：动手课（原理→代码跃迁）
- 背景：0001-0005 原理链（chunking/embedding/检索/重排序）完成后，用户进入动手阶段。0006 课提供 ~100 行 Python 脚本 minimal_rag.py，用户修改 CHUNK_SIZE/OVERLAP/RERANK_ON 跑 3 个实验，观察召回变化。
- 决策：教学约定——embedding 用字符重叠近似余弦（标清非真实），重排序用主题关键词乘子近似 cross-encoder（标清非真实）。真实场景需替换为 embedding API + cross-encoder reranker。脚本写入 lessons/ 目录而非独立 project 目录，保持教学工作区自包含。
- 关键工具：chunk_text() 函数（字符滑动窗口切分，含死循环保护），vec_sim()（词重叠近似余弦），rerank()（主题关键词匹配降权噪声块）。
- 验证逻辑：① RERANK_ON=False 时召回含“运费险”噪声；② RERANK_ON=True 时噪声被降权踢出；③ OVERLAP 变化影响 chunk 列表结构和召回完整度；④ CHUNK_SIZE=30/OVERLAP=0 时每个 chunk 包含完整句子，召回更准。
- ZPD 评估：用户完成此课后，RAG 领域已从“junior（调过 Dify）”推进到“qualified（能讲清原理+亲手写过全链路）”。next step：① 评测（如何评估 RAG 质量——忠实度/答案召回率/精确度）；② 引用溯源（chunk→回答→源文号，用户要求的"溯源"）。
- 关联：minimal_rag.py、0003-chunking、0005-retrieval-rerank、reference/05-rag.html
