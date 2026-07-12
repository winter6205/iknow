# (c) 鉴权 / 异步影响分析

> 阶段：Phase 1 协议层收尾后的影响评估。本文**只做分类判断，不修改 ADR tool 协议**。
> 输入：ADR-v0.1-iknow.md §2（4 tool 协议）、§5（已知缺口已列鉴权/异步）。
> 结论性质：识别 Phase 3 需处理的点，确认当前同步 loop 模型不被破坏。

---

## 1. 鉴权（caller_role）

### 现状
ADR §2 四个 tool 的入参均未含调用者角色。§5 已知缺口已标注："当前 4 tool 协议未含调用者角色；tool 预留 role 上下文入口，模型 Phase 3 定义"。

### 影响分析
- **是否改协议拓扑**：否。鉴权是"每个 tool 调用时附带的上下文维度"，不是新 tool、不是新链路。加 `caller_role` 入参（或统一从 session context 注入）不改变 retrieve→verify→governance 的调用图。
- **与 §7 安全衔接**：原文档 `../reference/ref-enterprise-kb.md` §7.2 的 `requireApprovalFor`（price/customer-data 需审批）与 ADR 治理 B 定位（`kb_governance` 独立 tool）的衔接，需在 Phase 3 明确：审批判定是落在 `kb_retrieve` 的 `filter` 层（A filter 在线检查）还是 `kb_governance` 的 `requireApprovalFor` 动作。ADR §5.1 已留痕，此处不决。
- **实现层归属**：Phase 3 在 tool 封装层（harness 拦截器）统一注入 `caller_role`，而非每个 tool 内部重复判断。协议层保持干净。

### 结论
鉴权是 **Phase 3 实现层增强**，不影响 Phase 1 协议自洽性。当前协议无需为鉴权增加 tool 或改变调用顺序。

---

## 2. 异步交互

### 现状
ADR §2 隐含同步请求-响应 loop：agent 调 `kb_retrieve` → 等结果 → 调 `kb_verify_citation` → 等结果 → 生成。§5 已知缺口已标注："当前 Agent Loop 为同步请求响应；企业可能需异步任务/通知，Phase 3 评估"。

### 影响分析
- **主问答链路（retrieve→verify→governance）**：短任务，同步模型成立。用户问→agent 多跳（hops≤5）→返回带引用答案，全程秒级，无异步必要。
- **长任务场景**：
  - `kb_compile` 后台 pipeline（全库重编译、增量索引）——ADR §2.3 已定义为"后台 pipeline 补编"，天然异步，不阻塞主 loop。
  - `kb_governance` 批量扫描（全库冲突/过期巡检）——可异步跑，结果写回元数据层，agent 主链路只读"已治理好的干净索引"（C 定位退预计算缓存，ADR §3 原则 3）。
- **阻塞风险点**：若企业要求"用户提交一个问题，agent 触发全库重编译后回答"，同步 loop 会卡住。但这是**任务编排层**问题，不是协议层问题——应在 Phase 3 用"后台 job + 完成通知"机制隔离，不进主 retrieve→verify 同步链。

### 结论
异步需求**不破坏当前协议拓扑**。同步 loop 覆盖主问答；长任务走独立后台 job + 通知，与 agent 主链路解耦。Phase 3 评估具体异步框架（如任务队列、webhook 回调），不在当前 loop 模型内。

---

## 3. 综合结论

| 维度 | 是否改 ADR 协议 | Phase 3 动作 |
|------|----------------|-------------|
| 鉴权 caller_role | 否（实现层注入） | tool 封装层统一注入 role；§7 与 B 定位衔接决策 |
| 异步交互 | 否（独立后台 job） | 长任务走队列/通知，不进主同步链 |

**当前 Phase 1 协议层自洽，鉴权与异步均为 Phase 3 实现层增强，不引入新 tool、不改变调用图。可安全进入 Phase 2 eval 体系。**
