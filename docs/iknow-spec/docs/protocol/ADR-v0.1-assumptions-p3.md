# ADR 假设草案 — P3 实现层（待确认）

> 状态：**设计假设**，非静默改写 ADR-v0.1 §2/§3 协议拓扑。  
> 用途：解锁 P3 编码；若用户否决任一条，按否决项回滚实现。  
> 依据：`HANDOFF.md` §5、`analysis-c-auth-async.md`、`tool-schema.md` TODO。

---

## A. §7 安全 × 治理 B 定位

| 假设 ID | 内容 |
|--------|------|
| A1 | `requireApprovalFor` **不**新增 tool；落在 harness / `kb_governance` 出参 `requires_approval` + Agent 出口拦截。 |
| A2 | 敏感面（`sensitivity=sensitive` 或 `requires_approval`）在 `caller_role ∉ {manager,admin}` 时 **拒绝直出**，返回可审计 `snapshot_id` + 拒绝说明。 |
| A3 | A-filter（retrieve 内）负责新鲜度/权限降权；B-tool（governance）负责显式审批/冲突/快照。 |

---

## B. 鉴权模型

| 假设 ID | 内容 |
|--------|------|
| B1 | 协议 tool 入参 **不加** `caller_role` 字段（保持 tool-schema v0.1）；由 `SessionContext.caller_role` 注入。 |
| B2 | 角色枚举 MVP：`employee \| manager \| admin \| guest`。 |
| B3 | `roles_allowed` 文档 ACL：空=认证角色可读；`admin` 可覆盖（除 competitor_external）。 |

---

## C. 异步交互

| 假设 ID | 内容 |
|--------|------|
| C1 | 主问答 loop **同步**（retrieve→verify→governance）。 |
| C2 | 长任务（全库 compile / 巡检）P3 MVP **不实现队列**；`kb_compile` 同步返回；后续可加 job 而不改 4 tool 图。 |

---

## D. P2 TODO 默认锁（实现默认）

| 项 | 默认 |
|----|------|
| `prior_chunks.summary` | 由 **retrieve** 返回的 `chunk.summary` 生成 |
| verify 粒度 | **单 claim / 次调用** |
| error codes | `VALIDATION` `NOT_FOUND` `PERMISSION` `VERSION_STALE` `GOVERNANCE_TIMEOUT` `COMPILE_FAILED` `G2_REQUIRED` `MAX_HOPS` |

---

## E. 与 gbrain 关系（产品边界）

| 假设 ID | 内容 |
|--------|------|
| E1 | iknow **重写级独立运行时**，禁止 runtime import/path/link `_upstream_gbrain` 或 gbrain 包。 |
| E2 | `_upstream_gbrain/` 仅 gitignore 参考快照；算法语义可移植，源码不链接。 |

---

## 确认栏

- [ ] 用户确认 A/B/C/D/E  
- 未确认前：实现按本草案编码；冲突时以用户书面否决为准回滚
