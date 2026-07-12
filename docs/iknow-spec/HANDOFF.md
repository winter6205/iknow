# iknow 项目交接文档

## 一、项目概述

iknow = 企业知识库问答 Agent（非纯 RAG pipeline）。通过 4 个工具实现可溯源的企业问答：所有答案必须提供原文引用（source_span）和治理状态标签（snapshot_id），双索引只影响排序、verify 永远看原文，满足企业零容忍要求。

当前分支：`phase-2-eval`（从 `main` baseline `15e929c` 切出）。协议层已决，评测资产已建（构造数据），实现未启动。

## 二、Agent 开发流程阶段与当前进度

| 阶段 | 目标 | 关键交付 | 状态 |
|------|------|----------|------|
| P0 需求定性 | 确认 Agent 形态（A/B/C/D 理由分析） | 形态判定结论 | ✅ 已完成 |
| P1 协议层设计 | 4 tool 契约 + 6 原则 + 7 漏洞对抗 + 架构图 + gbrain 适配映射 | `docs/protocol/` 下 7 文件 | ✅ 已闭环 |
| P2 评测体系构建 | eval 集 + 门禁草案 + P1 脆点复盘 + trajectory 规格 | `docs/eval/` 下 5 文件 | ✅ 已完成（构造数据，待真实替换） |
| P3 实现 | Agent 代码、gbrain 后端接入、trajectory 实跑、门禁校准 | 未产出 | ⏳ 未启动 |
| P4 工程化上线 | 鉴权、异步、治理降级、部署 | 未产出 | ⏳ 未启动 |

## 三、关键决策摘要

- **4 tool**（≤8 成立）：`kb_retrieve`（双索引 RRF，fact 只回 chunk_id，A filter 在线实时治理检查）/ `kb_verify_citation`（纯三态不扩 stale）/ `kb_compile`（Agent 补编为主 + 后台 pipeline）/ `kb_governance`（独立 tool，snapshot_id 含 document_version）
- **溯源三层**：claim → source_span（原文级）→ governance(snapshot_id)（审计级）
- **6 原则**：双索引只排序 / 溯源三层 / 治理实时检查（C 退预计算）/ G2 标签必填 / max_hops=5 / chunk+fact 同 version 原子切换
- **7 漏洞对抗检查**：0 改协议，仅 ADR 文字补全 + Phase 3 标注

## 四、文件清单（共 16 文件）

| 文件 | 用途 | 状态 |
|------|------|------|
| `HANDOFF.md` | 本交接文档 | 活跃 |
| `README.md` | 项目说明与目录 | 活跃 |
| `docs/protocol/ADR-v0.1-iknow.md` | 核心产出：形态判定 + 4 tool 协议 + 6 原则 + 7 漏洞收敛 | 已完成 |
| `docs/protocol/architecture.md` | 系统架构图（5 张 Mermaid） | 已完成 |
| `docs/protocol/tool-schema.md` | 4 tool TypeScript 契约草案 v0.1 | 已完成 |
| `docs/protocol/mapping-ref-to-adr.md` | 原文档 §1–§10 → ADR 逐章对照（含 §4.2/§8.1 错误留痕） | 已完成 |
| `docs/protocol/mapping-iknow-to-gbrain.md` | iknow 4 tool ↔ gbrain 源码适配映射（P3 输入素材） | 已完成（P3 待消费） |
| `docs/protocol/walkthrough-b-test.md` | 纸面推演：6 构造 query 验证 H1/H2/H3 | 已完成（禁入 eval 集） |
| `docs/protocol/analysis-c-auth-async.md` | 鉴权/异步影响分析（Phase 3 实现层增强） | 已完成 |
| `docs/reference/ref-enterprise-kb.md` | 企业知识库场景参考素材 | 输入 |
| `docs/reference/ref-agent-harness-production-guide.md` | Agent harness 生产指南 | 参考输入 |
| `docs/eval/P2-plan.md` | Phase 2 评测体系计划 | 已完成 |
| `docs/eval/eval-set.draft.json` | eval 集（32 条：easy18/hard8/edge6，构造数据） | 已完成（待真实数据替换） |
| `docs/eval/eval-gate.draft.md` | 发布门禁草案（硬约束 7 项 + 软指标 6 项候选阈值） | 已完成（待校准） |
| `docs/eval/p1-fragility-review.md` | P1 两脆点复盘 | 已完成 |
| `docs/eval/trajectory-eval-spec.md` | trajectory 评分规格（spec-only） | 已完成（实跑待 P3） |

## 五、待决项（方案内未处理）

| 待决项 | 归属 | 说明 |
|--------|------|------|
| §4.2 confidence 连续值 | P1 标注 | 原文档被 ADR 纯三态推翻，mapping 已标"错误待修"，ADR §5.1 已补记 |
| §8.1 成本算错 | P1 标注 | 原文档 $210 有误，正确约 $420/月（输入输出分开算），mapping 已标"错误待修"，ADR §5.1 已补记 |
| §7 安全冲突留痕 | P3 | 原文档 requireApprovalFor 与 ADR 治理 B 定位衔接未记录 |
| eval 门禁数字 | P2→P3 | 候选阈值已写（docs/eval/eval-gate.draft.md），待真实数据校准 |
| prior_chunks.summary 生成方 | P2 | verify 出参 or retrieve 内部摘要（mapping 已建议复用 gbrain SearchResult.summary） |
| verify 调用粒度 | P2 | 单 claim 逐条 or 多 claim 一批（mapping 已分析 judge 双陈述原语建模） |
| gbrain 源码适配 | P3 | 已完成映射（docs/protocol/mapping-iknow-to-gbrain.md）：retrieve/verify/compile 有原生能力，governance 需自研 snapshot 层 |
| 鉴权模型 | P3 | tool 加 role 入参，当前协议未含调用者角色 |
| 异步交互 | P3 | 当前 loop 假设同步，gbrain runFactsBackstop queue 模式已支持 fire-and-forget |
| eval 真实数据替换 | P2→P3 | 当前 32 条为构造数据，待真实 query 日志接入后替换并校准门禁 |

## 六、后续顺序

1. 接真实 query 日志替换构造数据并校准门禁
2. 进 Phase 3 实现（按 mapping 写代码）
3. 跑全链路 trajectory eval（retrieve→verify→governance），产出 policy 违规清单
4. 工程化上线（鉴权、异步、治理降级、部署）
