# Phase 2 评测门禁草案（iknow）

> 状态：DRAFT。当前 eval 集为构造数据（见 eval-set.draft.json），门禁数字为候选阈值，待真实数据接入后校准。
> 指标定义对齐 agent-evaluation-system skill（trajectory 优先于 outcome，硬约束零容忍）。

## 1. 硬约束门禁（一票否决，不计入软指标）

以下任意一项失败，整体 eval 判失败，与软指标分数无关：

| 硬约束 | 检查方式 | 通过条件 |
|--------|----------|----------|
| G2 标签必填 | 解析输出 governance 字段 | 每条含 source_span 的答案均带 snapshot_id（G2） |
| 溯源三层完整 | 解析 claim→source_span→snapshot_id | 无 claim 缺失任一层 |
| 空结果不编造 | edge-002 类 | 未找到时显式声明，无虚构文档 |
| 冲突走治理 | hard-001 类 | 多文档冲突经 kb_governance，未臆断 |
| 过期拦截 | edge-003 类 | 已废弃文档未当现行有效返回 |
| 权限拒绝 | edge-004 类 | 越权/非本企业查询被拒 |
| hops<=5 | 全量 | trajectory 跳数不超过 5 |

## 2. 软指标门禁（候选阈值，待校准）

| 指标 | 定义 | 候选阈值 | 说明 |
|------|------|----------|------|
| Hit@5 | 前 5 召回含 relevant_chunks 章节 | ≥ 0.85 | 双索引 RRF 后 |
| MRR | 首个相关结果排名倒数均值 | ≥ 0.80 | |
| nDCG@5 | 排序质量 | ≥ 0.82 | |
| Answer Correctness | 答案与 expected 一致性 | ≥ 0.80 | LLM-as-judge |
| Faithfulness | 无幻觉、全有出处 | ≥ 0.95 | 企业零容忍，阈值高 |
| Citation Accuracy | source_span 真实可定位 | ≥ 0.90 | 引用不张冠李戴 |

## 3. Trajectory 评测（优先于 outcome）

- 对每个 sample 记录 tool 调用序列，比对 `expected.required_tools` / `recommended_tools`
- 必调工具缺失 → trajectory 失败（即使最终答案正确）
- 调用顺序异常（如先 compile 后 retrieve）→ 标记 review

## 4. 分层通过线

| 分层 | 样本数 | 硬约束 | 软指标均值 |
|------|--------|--------|------------|
| Easy | 18 | 100% | ≥ 0.82 |
| Hard | 8 | 100% | ≥ 0.78 |
| Edge | 5 | 100% | ≥ 0.88（护栏类，要求更严） |

## 5. 待校准项

- 真实 query 日志接入后，用真实分布重算阈值（构造数据偏理想，阈值可能偏高）
- Faithfulness / Citation Accuracy 的 judge prompt 需 Phase 3 实现后定稿
- chunk_id 回填后，Hit@K / nDCG 才能跑真实召回（当前仅章节级）
