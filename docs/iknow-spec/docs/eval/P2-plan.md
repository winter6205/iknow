# P2 评测体系计划（iknow）

> 分支：`phase-2-eval`（从 `main` baseline `15e929c` 切出，不污染 main）
> 阶段：Phase 2（评测体系），P1 协议层已锁，本计划只规划 + 建 eval 资产，不写实现代码
> 纪律来源：`agent-evaluation-system` skill（eval-first、trajectory 优先 outcome、真实数据 ≥30 条）

## 0. 目标

验证 P1 协议的正确性，而非纸面推演（../protocol/walkthrough-b-test.md 的 6 构造 query 已标"禁入真实 eval 集"）。首轮用 agent 构造数据建回归基线，待真实 query 日志接入后替换并校准门禁：

- 验证 retrieve → verify → governance 调用顺序
- 验证 6 原则硬约束：双索引只排序 / 溯源三层 / G2 标签必填 / max_hops=5 / 治理实时检查 / chunk+fact 同 version
- 验证 4 tool 协议在真实 query 下的 trajectory 合理性
- 产出可回归的 eval 集 + 门禁草案，供 Phase 3 实现后持续跑

## 1. 交付物

### 1.1 Eval 集（≥30 条 QA，首轮为构造数据）
- **来源**：真实用户查询日志 或 主会话 agent 人工撰写（基于 ../reference/ref-enterprise-kb.md 场景构造；当前首轮为 agent 构造数据，待真实 query 日志接入后替换）
- **分层**：Easy 60% / Hard 25% / Edge 15%
  - Easy：单 tool、意图明确（如"退款政策是什么"）
  - Hard：多跳、需跨文档拼接（如"对比 A 文档和 B 文档的退款期限差异"）
  - Edge：负向护栏 case（见 §3）、模糊意图需澄清、过期/冲突文档
- **每条 schema**：
  ```yaml
  - id: qa-xxx
    category: easy|hard|edge
    input: "用户原话"
    expected:
      required_tools: [kb_retrieve]          # 必须调用
      recommended_tools: [kb_verify_citation] # 应调用
      optional_tools: [kb_governance]
      output_properties: [必须含 source_span, 必须含 snapshot_id]
      policies: [G2 必填, hops<=5]
    max_steps: 10
  ```
- **规模红线**：<30 条无统计意义；生产级需 ≥100。本阶段先建 ≥30 条回归基线。

### 1.2 Trajectory Eval 设计
- **不只 outcome**：评工具调用序列 + 顺序 + policy 合规
- **评分**（key tool coverage，非严格序列匹配）：
  ```
  trajectory = (required_coverage*0.6 + recommended_coverage*0.3 + efficiency*0.1) * outcome_match
  ```
- **必检 policy**：G2 缺失率=0（缺失不返回用户）、hops 违规率=0（>5 强制"无法确认"）、双索引 fact 不进最终证据

### 1.3 质量门禁草案（待真实 eval 回填，不预设数字）
- 检索层：Hit@5 / MRR / nDCG@5（对标 P1 预期 Hit@5≥0.78，但**以实测为准不锁**）
- 生成层：Answer Correctness / Faithfulness / Citation Coverage / Citation Accuracy
- 协议层：G2 必填率=100%、hops 违规率=0、双索引 fact 零泄漏
- Sprint 1 门槛（skill）：outcome≥70%、trajectory≥60%；生产：outcome≥95%、trajectory≥85%

### 1.4 环境依赖（Phase 2 需先确定，不写代码）
- LLM 接入：标准 `tool_calls` + `messages` 历史（ADR §1 已定，不绑模型）
- gbrain 检索 API：是否可调用真实索引（决定 eval 跑真还是 mock）
- 向量库 / 重排器：影响 retrieve 层 baseline 搭建
- **本计划不填具体模型名 / 成本数字**（ADR §5 标 Phase 2/3 待决）

## 2. 首周时间盒

| 天 | 动作 | 产出 |
|----|------|------|
| D1-2 | 收集真实 query + 人工标注（多跳/负向/模糊各覆盖） | ≥30 条 QA 草稿 |
| D3-4 | 建 retrieval eval set，跑 retrieve 层 baseline（Hit@K/MRR/nDCG） | 检索层指标 |
| D5-6 | 跑全链路 trajectory eval（retrieve→verify→governance） | trajectory 评分 + policy 违规清单 |
| D7 | 复盘：修 ADR/tool-schema 细节（若有协议缺陷） | P2 复盘 note |

## 3. P1 两脆点复盘（必须含对抗 case，不遗忘）

来自 P1 逻辑校验，列为 P2 协议韧性验证子项：

1. **隐性治理依赖降级**：`kb_retrieve` 的 A filter 在线治理检查（C 退预计算）实际要求 retrieve 运行时调用 governance 能力——这是协议拓扑隐性依赖。ADR 只标了 Phase 3 降级路径，**未标"在线检查超时即降级到无过滤"的默认行为**。P2 纸面推演补此 failure mode，eval 集含"治理服务超时"对抗 case。
2. **护栏负面 case 缺失**：walkthrough 只验 happy path + 基础多跳，未验两项硬约束负面路径：
   - G2 缺失时强制不返回用户
   - hops>5 强制"无法确认"
   P2 eval 集 Edge 层必须含这两条对抗 case。

## 4. 边界（不做什么）

- 不读 gbrain 源码、不写实现代码（Phase 3）
- 不预设门禁具体数字（实测后回填）
- 不回 main 改 P1 文件（P1 已锁，补充走本分支）
- 不把 walkthrough 构造 query 当真实 eval 数据

## 5. 完成判据

- [x] ≥30 条 QA（首轮为 agent 构造数据，分层达标含 §3 两条对抗 case；待真实 query 日志接入后替换）
- [ ] trajectory eval 跑通，policy 违规清单产出（依赖 Phase 3 实现或 mock 后端）
- [x] 门禁草案成文（见 eval-gate.draft.md，候选阈值待真实数据校准）
- [ ] P1 两脆点复盘结论（协议改 or 标 Phase 3，依赖实现后验证）
- [ ] 若有协议缺陷 → 提 ADR/tool-schema 修订（仍在 phase-2-eval 分支）
