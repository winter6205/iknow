# Security boundaries — secret 处理生命周期（#406 收敛）

> 安全护栏完整 spec = `specs/security-guardrails.md`（权限三层 / 沙箱 / 中断超时）。
> 本文件只承载「密钥生命周期」一张表（#406 单层 roundtrip mask + 兜底），避免重复堆叠。
> 密钥形态 SSOT = `src/harness/secret-roundtrip/patterns.ts`（`DEFAULT_SECRET_PATTERNS`）。

## 密钥生命周期（#406：一层 + 兜底）

| 阶段                | 处理                       | 文件                                             | 说明                                                          |
| ------------------- | -------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| 用户文本进 LLM 前   | 识别 + 占位符替换          | `secret-roundtrip/recognize.ts`                  | 密钥形态 → `<<<SECRET_N>>>`（per-engine registry，in-memory） |
| bash spawn 前       | 占位符还原                 | `secret-roundtrip/registry.ts` `restore()`       | 真值回填，仅此刻物理存在                                      |
| 输出 / 落盘 / trace | 值匹配 + registry 兜底遮蔽 | `sandbox/env-isolation.ts` `currentSecretValues` | registry 值并入遮蔽集                                         |
| 沙箱 env 边界       | env 白名单                 | `sandbox/env-isolation.ts` filter                | 正交职责，不并入 roundtrip                                    |

- **旧（#126）**：三层割裂补丁——① input guard（deny-only 拦截）② sandbox env 隔离 ③ output mask（值匹配）。deny-only 让 key 真值永远到不了 bash（反人类）。
- **新（#406 默认）**：单层 roundtrip mask（识别 → 占位符 → bash 还原）+ 输出 mask 兜底 registry 值；`settings.secrets.mode = "block"` 保留旧 guard 兼容路径（向后兼容）。
- **输出边界红线（SC20）**：已知密钥值（env + settings 字面 + registry 值）在 chat / ask JSON / trace 落盘前替换为 `***`。
