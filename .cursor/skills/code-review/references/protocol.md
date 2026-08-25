# Code Review Protocol

> **定位**: 代码评审的判定标准 (SSOT for "what counts as good code"). 双轴: **Standards** (硬规则 + 异味) + **Spec** (需求忠实度). 执行入口归 `arthurpower:code-review` skill, 本 rule 只立判定标准, 不重复执行步骤.
>
> **关系**: rule = SSOT 判定标准 (怎么算好代码); skill = 执行入口 (怎么跑审查). skill body 引用本 rule, 不重复.

---

## 1. 双轴审查

| 轴            | 关注点          | 失败模式                        | 处置                  |
| ------------- | --------------- | ------------------------------- | --------------------- |
| **Standards** | 编码规范 + 异味 | 违反硬规则 / 出现 Fowler smell  | 改到满足为止 (可量化) |
| **Spec**      | 需求忠实度      | 需求缺失 / scope creep / 假实现 | 改回 spec 或扩 spec   |

**Standards 轴**: 硬规则违反或归类为 High 的异味 = 必修, 阻断 commit; Medium / Low 按 §4 verdict 处置. **Spec 轴是 semantic gate**: 偏离 spec 需 spec 侧先确认 (扩 / 改 / 撤回).

---

## 2. Standards 轴 (硬规则 + 异味)

### 2.1 硬规则 (与 S1-S6 互补)

S5 阈值 (圈复杂度 / 函数行数 / 文件行数 / 嵌套深度 / 参数数量 / 代码克隆率) 见 [complexity-anti-drift/references/thresholds.md](../../complexity-anti-drift/references/thresholds.md). S3 空 catch / null 代替抛错见 [error-handling-enforcer/references/criteria.md](../../error-handling-enforcer/references/criteria.md).

本 rule 独有硬规则:

| 类别                       | 来源     | 阈值                   |
| -------------------------- | -------- | ---------------------- |
| 凭印象命名                 | S1       | 0 (先 grep 限界上下文) |
| API Key / Token / 密码明文 | 凭据安全 | 0 (只引环境变量名)     |

### 2.2 Fowler 12 项异味 (Fowler Ch.3, 跟 `arthurpower:code-review` skill body 对齐)

| #   | 英文名                   | 中文           |
| --- | ------------------------ | -------------- |
| 1   | Mysterious Name          | 神秘命名       |
| 2   | Duplicated Code          | 重复代码       |
| 3   | Feature Envy             | 依恋情结       |
| 4   | Data Clumps              | 数据泥团       |
| 5   | Primitive Obsession      | 基本类型偏执   |
| 6   | Repeated Switches        | 重复 switch    |
| 7   | Shotgun Surgery          | 散弹式修改     |
| 8   | Divergent Change         | 发散式变化     |
| 9   | Speculative Generativity | 夸夸其谈未来性 |
| 10  | Message Chains           | 消息链         |
| 11  | Middle Man               | 中间人         |
| 12  | Refused Bequest          | 拒绝遗赠       |

### 2.3 跟 S1-S6 的关系

S1 = 异味 1/3/7/8 模块级 | S2 = 异味 6/12 测试覆盖 | S3 = 异味 5/10 错误路径 | S4 = Spec 轴立约 | S5 = Standards 轴阈值 | S6 = diff scope = 任务 scope

---

## 3. Spec 轴 (需求忠实度)

### 3.1 三类失败

| 失败            | 表现                                   | 处置                                |
| --------------- | -------------------------------------- | ----------------------------------- |
| **需求缺失**    | spec 写了 X, 实现没做 X                | 补 X (跟 spec)                      |
| **Scope creep** | spec 没写 Y, 实现加了 Y                | 拆成独立 ticket, 跟主任务解耦       |
| **假实现**      | spec 写了 X, 实现做了 X' (X' 不等价 X) | 改回 X, 或写 ADR 显式声明 X 改为 X' |

### 3.2 跟 S4 "测试即规约" 立约

测试失败报告"功能缺失"而非"拼写错误"; 测试覆盖 spec 全部验收点. 详见 [test-driven-development/references/spec-as-test.md](../../test-driven-development/references/spec-as-test.md).

---

## 4. Verdict 处置 (跟 skill verdict 解析对齐)

| Verdict    | 含义                                       | 处置                       |
| ---------- | ------------------------------------------ | -------------------------- |
| **High**   | 必修 (硬规则违反 / 严重异味 / 假实现)      | 阻断 commit, 必改          |
| **Medium** | 应修 (软规则违反 / 轻度异味 / scope creep) | 改或写 ticket 推后, 不阻断 |
| **Low**    | 选改 (风格 / 注释 / 微优化)                | 不阻断, 维护者自行决定     |

---

## 5. 跟 skill / 其他规则的关系

- rule = 判定标准; skill (`arthurpower:code-review`) = 执行入口 (description trigger: "审代码/审 PR"). skill body 引用本 rule, 不重复 CLI 步骤.
- S1-S6 阈值真源在各自 `s{1-6}-*.md`; 本 rule 不重复量化阈值.
- boundary-testing-protocol / testing / git-workflow / agent-workflow 互补, 本 rule 不重复.

---

## 6. 触发与边界

**适用**: 任何非平凡改动的改后预 commit 审查 (跨文件 / 新功能 / 架构变更 / Bug fix).

**不适用**: 1 行 typo fix / 操作员明确指定"就改这一处文件" / 文档/注释/配置等无运行时表面的改动 (走 git-workflow.md).

**跟其他 review 资产的关系** (时点 + 作用域分工):

- 改前 plan gate 走 ACR (`architecture-change-reviewer` skill)
- 改后预 commit 通用审查走 `arthurpower:code-review` skill (本 rule 立标准)
- 改后预 commit S1-S6 审计走 `arthurpower-audit-agent` (限 plugin 自身改动)
- pre-merge 第三段 S1-S6 审查走 `maintainability-reviewer` (通用项目)
