# iknow

企业知识库问答 Agent 的设计方案与评测集。当前为协议层与评测设计阶段，实现（Phase 3）未启动。

## Phase 状态

| Phase | 内容 | 状态 |
|-------|------|------|
| P1 | 协议层：ADR、tool 契约、架构、鉴权/异步分析、gbrain 适配映射 | ✅ 闭环 |
| P2 | 评测：eval 集、门禁草案、P1 脆点复盘、trajectory 规格 | ✅ 文档侧闭环 |
| P3 | 实现：agent 代码、gbrain 后端接入、trajectory 实跑 | ⏳ 未启动 |

## 目录

| 文件 | 用途 |
|------|------|
| `docs/protocol/ADR-v0.1-iknow.md` | 架构决策记录（v0.1） |
| `docs/protocol/architecture.md` | 系统架构与模块边界 |
| `docs/protocol/tool-schema.md` | 4 个 tool 的接口契约 |
| `docs/protocol/analysis-c-auth-async.md` | 鉴权与异步调用影响分析 |
| `docs/protocol/mapping-iknow-to-gbrain.md` | iknow 与 gbrain 后端的适配映射 |
| `docs/protocol/mapping-ref-to-adr.md` | 参考文档到 ADR 的溯源映射 |
| `docs/reference/ref-enterprise-kb.md` | 企业知识库场景参考素材 |
| `docs/reference/ref-agent-harness-production-guide.md` | Agent 生产化参考指南 |
| `docs/protocol/walkthrough-b-test.md` | 协议层纸面推演与测试记录 |
| `docs/eval/P2-plan.md` | Phase 2 评测计划与完成判据 |
| `docs/eval/eval-set.draft.json` | 评测集（32 条构造数据：easy18/hard8/edge6） |
| `docs/eval/eval-gate.draft.md` | 发布门禁草案（硬约束 + 软指标候选阈值） |
| `docs/eval/p1-fragility-review.md` | P1 两脆点复盘 |
| `docs/eval/trajectory-eval-spec.md` | trajectory 评分规格 |
| `HANDOFF.md` | 跨阶段交接记录 |

## 评测集使用

`docs/eval/eval-set.draft.json` 为**构造数据**，基于 `docs/reference/ref-enterprise-kb.md` 场景人工撰写，非真实企业日志。接入真实 query 后：

1. 替换 `samples` 中的构造 query 为真实 query
2. 回填 `chunk_id`（待 gbrain 真实索引建立）
3. 用真实数据校准 `docs/eval/eval-gate.draft.md` 的候选阈值

## 验证

- eval 集结构：ad-hoc 校验通过（32 条、无重复 ID、字段齐全、edge-006 覆盖 P1 脆点1 对抗路径）
- trajectory 实跑、门禁阈值校准：依赖 gbrain/mock 后端与真实数据，留 Phase 3

## 分支

- `main`：基线
- `phase-2-eval`：当前工作分支（P2 文档资产）
