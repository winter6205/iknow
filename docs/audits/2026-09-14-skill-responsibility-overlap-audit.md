# Skill 职责重叠审计报告

> **归档：** 2026-09-14。来源 = 本地未跟踪草稿（从未提交，原拟落 `docs/guides/`）。
> 内容含当刻 skill 集合快照与路由建议，非耐久指南；保留为历史参考，不再维护。
> 其中机械层建议已由 `f09e30c4` 部分落地（flowchart Verify 段拆出 input-contract-tests / boundary-testing）。

> **范围：** iknow 仓库 arthurpower 常驻 skill + 关联 persona/agent（`~/.claude/agents/`、`~/.iknow/agents/`）  
> **依据：** `.cursor/skills/*/SKILL.md`、`arthurpower-workflow.mdc`、`global.mdc`、`dimension-semantics.md`、agents README  
> **日期：** 2026-09-14  
> **状态：** 审计结论 + 路由建议（非 ADR；落地前若改 router 需单独评审）

---

## 1. 执行摘要

当前体系在 **「测什么 / 怎么测 / 测够了能否 claim done」** 这条线上叠了 **4～5 层验证**，其中 **有意互补** 与 **文档/命名导致的体感重复** 混在一起。最大问题不是「技能太多」，而是：

1. **收官门禁不唯一** — `verification-before-completion`（VBC）、`test-driven-development-agent`（TDD-A）、`code-review` Spec 轴、`minimal-change-verifier`（S6）都在碰「验收 / 测试 / 范围」。
2. **「边界」一词三义** — S2 输入五类、`boundary-testing` A–E 触发语义、口语「边界测试」未在 router 层强制分流。
3. **Build vs Verify 相位漂移** — flowchart 把 TDD/S2 放在 Implementing，把 `boundary-testing` 放在 Verify，但计划 per-ticket loop 写的是 `tdd → tests → code-review → VBC`，和 phase map 不完全同构。
4. **TDD skill 与 TDD-agent 同名不同责** — 一个是写代码纪律，一个是事后审计，加重「跟确认技能重复」的感受。

**总体判断：** 骨架合理（Plan → Build → Review → Verify → Commit），但 **Verify/Review 槽位需要收敛默认栈**，若干 skill 应标为 **条件触发** 而非默认同跑。

---

## 2. 技能分层（理想模型）

| 相位       | Skill / Agent                                                  | 核心问题                                    |
| ---------- | -------------------------------------------------------------- | ------------------------------------------- |
| **Plan**   | `architecture-change-reviewer`                                 | 计划结构上 5 维是否说得通？（**不测数值**） |
| **Build**  | `test-driven-development`（纪律）+ implementer / test-engineer | 怎么写代码和测试？                          |
| **Review** | `code-review`（Standards + Spec）                              | diff 质量与需求覆盖？                       |
| **Verify** | `boundary-testing`（条件）、S1–S6 agents（条件）、VBC          | 能否 claim done？实测对上 basis？           |
| **Commit** | `minimal-change-verifier`（范围）                              | diff 是否单一任务、hook 是否跑过？          |

`architecture-change-reviewer/references/dimension-semantics.md` 已明确：**ACR = pre-impl 承诺；S1–S6 agent = post-impl 实测**。这一分层本身是好的，重叠主要来自 **Verify 槽未收口** 和 **命名**。

---

## 3. 重叠矩阵（按严重度）

### 3.1 高重叠 — 体感重复、默认同跑成本高

| 组合                                    | 重叠内容                                       | 仍存在的差异                                                                                |
| --------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **VBC ↔ TDD-agent**                     | 「测过了吗」「验收点覆盖了吗」「suite 绿了吗」 | TDD-agent 专查 **过程纪律**（commit 顺序、skip、mock、路径规范）；VBC 查 **basis 逐条交付** |
| **VBC ↔ code-review Spec 轴**           | 对照 spec/plan 的 acceptance                   | Spec reviewer 审 **diff 是否实现需求**；VBC 审 **本轮 basis 每条是否有证据**                |
| **VBC ↔ S6 minimal-change-verifier**    | 「diff 含证明性测试」「pre-commit 跑过」       | S6 还查 drive-by、lockfile、YAGNI；VBC 还查 deferred/missing 清单                           |
| **TDD skill ↔ TDD-agent**               | 同名、同属 S4                                  | skill = **写时纪律**；agent = **事后只读审计**                                              |
| **global：test-engineer ↔ implementer** | 谁写 product tests                             | 路由写 `product-code tests → test-engineer`，implementer 定义又要求自带 TDD                 |

### 3.2 中重叠 — 互补但易混、需 router 澄清

| 组合                                                | 重叠内容                     | 差异                                                                                                              |
| --------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **defensive-contract-validator ↔ boundary-testing** | 中文都叫「边界」、都涉及测试 | S2 = **函数入参五类**；boundary-testing = **hook/detector 触发语义 A–E + 真 FS smoke**（protocol 写明互补不互替） |
| **defensive-contract-validator ↔ TDD-agent**        | 都要求 bug 有复现测          | S2 查五类覆盖 + 覆盖率阈值；TDD-agent 查 Prove-It **commit 顺序** 等                                              |
| **ACR ↔ 各 S\* post-impl agent**                    | 同一五维名字                 | pre = 计划承诺 / post = 实测（**设计如此**，非 bug）                                                              |
| **systematic-debugging ↔ test-engineer**            | bug 场景都写失败测试         | debugging = 找根因再修；test-engineer = **无偏** 先写 repro（Prove-It 子场景）                                    |

### 3.3 低重叠 — 边界清晰

| 组合                                              | 说明                                                  |
| ------------------------------------------------- | ----------------------------------------------------- |
| `code-review` Standards ↔ `complexity-anti-drift` | review 可提 smell；S5 agent 有硬阈值表                |
| `bounded-context-guardian` ↔ ACR S1               | pre/post 配对，非重复                                 |
| `dispatching-parallel-agents` ↔ 各 skill          | 编排层，不抢职责                                      |
| `boundary-testing` ↔ VBC                          | 前者是 **detector 变更采纳门**；后者是 **任务完成门** |

---

## 4. 分簇深读

### 4.1 「确认 / 收官」簇

当前 **claim done** 相关路径：

```
global.mdc（涉及代码改动）:
  code-review → (BLOCKED → repair) → verification-before-completion → commit

plans（per-ticket loop）:
  tdd → typecheck+tests → code-review → VBC

TDD skill Dispatch:
  test-driven-development-agent（软触发，实现后审计 S4）

minimal-change-verifier:
  步骤 4「diff 含证明性测试」+ 步骤 5「pre-commit exit 0」
```

**重叠点：**

- **「测试绿」** — VBC 要贴命令输出；S6 要 pre-commit exit 0；TDD-agent 要「重构后全绿」。
- **「对上 spec」** — VBC 逐条 Acceptance；Spec reviewer 审需求实现；TDD-agent 硬门禁「acceptance points covered」。

**缺口（并非重复，而是没人默认做）：**

- VBC **不审** commit 顺序、`.skip`、mock 滥用 — 只有 TDD-agent 专做。
- code-review **不替代** MCP/TUI 手测 — 靠 VBC 的 evidence 行。

### 4.2 「测试」簇

| 角色                            | 时机              | 写/读                             |
| ------------------------------- | ----------------- | --------------------------------- |
| `test-driven-development` skill | Build             | 纪律（main/implementer 执行）     |
| `test-engineer` persona         | Build（条件）     | **写**测试                        |
| `defensive-contract-validator`  | Build 末 / Verify | 审计 S2 五类                      |
| `boundary-testing`              | Verify（条件）    | 审计 detector/hook + driver smoke |
| `test-driven-development-agent` | Verify（可选）    | 审计 S4 过程                      |

**混乱源：** flowchart 在 **Implementing** 列出 `test-driven-development` 和 `defensive-contract-validator`，但 **未列出** `test-engineer`；`boundary-testing` 只在 phase map Verify，flowchart Verify 段只有 debugging + VBC。

### 4.3 「审查」簇

| 阶段              | 工具             | 问什么                                              |
| ----------------- | ---------------- | --------------------------------------------------- |
| Pre-impl          | ACR              | 5 行 yes/no，**不跑 agent**                         |
| Post-impl         | `code-review`    | Standards（Fowler）+ Spec（需求）                   |
| Post-impl（可选） | S1–S6 各 agent   | 单维硬测（diff-scoped）                             |
| Post-impl         | `/audit` fan-out | security-auditor + test-engineer 并行（persona 层） |

**重叠：** `code-review` Spec 轴 vs VBC 的 basis 对照 — 前者偏 **审查意见**，后者偏 **完成声明**。可串联，不宜都当「唯一收官」。

### 4.4 文档不一致（放大重叠感）

| 位置                                 | 问题                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `flowchart.md` Verify 段             | 只有 `systematic-debugging` + VBC，**缺** `code-review`、`boundary-testing` |
| `arthurpower-workflow.mdc` phase map | Review 与 Verify 分列，但 operator 心智常合并成「合入前」                   |
| `global.mdc`                         | `product-code tests → test-engineer` vs implementer 自带 TDD                |
| 中文「边界测试」                     | plans 里有时指 S2 五类（如 issue-986），有时指 boundary-testing 协议        |

---

## 5. 默认栈 vs 条件栈（建议心智模型）

### 5.1 建议默认栈（每轮代码改动合入）

```
1. implementer（体内 TDD，不默认派 test-engineer）
2. code-review（硬）
3. verification-before-completion（硬）
4. commit（+ S6 范围检查可并入 VBC 证据或 pre-commit hook）
```

### 5.2 条件栈（命中才加，不默认同跑）

| 触发条件                                  | 追加                                 |
| ----------------------------------------- | ------------------------------------ |
| 跨 hook/多状态/多平台/detector            | `boundary-testing`（axis1 ∥ axis2）  |
| 新 public API / PR 缺 S2 类               | `defensive-contract-validator-agent` |
| 怀疑后补测试、skip、mock 过度、要 S4 证据 | `test-driven-development-agent`      |
| 复杂 bug、怕 fix 偏见                     | 第一步 `test-engineer`（Prove-It）   |
| 测试为唯一交付物                          | `test-engineer`（全程）              |
| 多文件计划                                | pre-impl `ACR`（仅一次）             |

---

## 6. 仓库实例对照

### 6.1 `plans/fs-isolation-modes.md`（多文件 / 四入口）

| 阶段   | 实际应走                                                                   |
| ------ | -------------------------------------------------------------------------- |
| Plan   | ACR all-yes（已完成）                                                      |
| Build  | implementer × 模块（TDD + vitest）                                         |
| Verify | `boundary-testing`（跨 sandbox/cli/serve/worker）；S2 五类在 T3/T7 spec 表 |
| Review | code-review                                                                |
| Done   | VBC（含 MCP TUI 表 + vitest 证据）                                         |

**不默认：** test-engineer、TDD-agent。

### 6.2 `plans/todo-write-mode-copy.md`（契约文案）

| 阶段          | 实际应走                                                        |
| ------------- | --------------------------------------------------------------- |
| Build         | implementer「先锁测再改文案」或第一步 test-engineer 只锁 vitest |
| Verify        | defensive-contract-validator negative 类（非法 mode 等）        |
| Review + Done | code-review → VBC                                               |

**不默认：** boundary-testing、TDD-agent。

---

## 7. 意见与建议

### 7.1 总意见

**保留现有 skill 数量，收敛默认执行路径。** 重叠里约 **40% 是有意 pre/post 配对**（ACR ↔ S\*），约 **30% 是 Verify 槽未指定「唯一收官」**（VBC vs TDD-agent vs S6），约 **30% 是命名与 router 歧义**（边界、test-engineer、TDD 同名）。

不建议删掉 TDD-agent 或 boundary-testing — 它们在 **合规章、detector 变更、测试纪律审计** 有独立价值。建议 **降级为条件触发**，并把 VBC 明确为 **唯一 claim-done 收口**。

### 7.2 具体建议（按优先级）

#### P0 — 改 router 文案（低成本、高收益）

1. **`global.mdc` 补默认合入栈：**  
   `默认：code-review → verification-before-completion → commit；test-driven-development-agent 仅在需要 S4 过程审计时追加，不替代 VBC。`

2. **澄清 test-engineer 路由：**  
   `product-code tests → test-engineer` 改为  
   `测试为唯一交付物 / 复杂 bug 无偏复现 / 计划写明「先锁测」→ test-engineer；垂直切片内 TDD 由 implementer 自写。`

3. **「边界」分流一句：**  
   `函数入参五类 → defensive-contract-validator；hook/detector 触发语义 → boundary-testing。`

#### P1 — 减 Verify 重复执行

4. **VBC procedure 增加显式去重：**  
   Spec 覆盖若本轮已 `code-review GATE: PASS` 且 Spec 轴无 High，VBC 对应用 acceptance 行可引用 review 表 + 命令输出，**不重复开 Spec 审查**。

5. **TDD-agent 触发写死为三条之一：**  
   (a) 用户要求 S4 审计；(b) code-review 指出测试纪律问题；(c) 多文件改动且 plan 要求 Prove-It 证据。否则 skip。

6. **S6 与 VBC 分工：**  
   S6 专注 **scope + lockfile + no --no-verify**；「basis 逐条证据」只归 VBC，S6 步骤 4 改为「指向 VBC 测试证据或同轮 vitest 输出引用」。

#### P2 — 文档同构

7. **更新 `flowchart.md` Verify/Review：**  
   Post-impl 序列写全：`code-review → (boundary-testing 若命中) → verification-before-completion`。

8. **TDD skill 与 agent 改名提示（文档层）：**  
   skill 旁注「执行纪律」；agent 旁注「S4 审计员（只读）」— 不必改 id，frontmatter description 可加 disambiguation。

9. **plans 模板统一 per-ticket loop：**  
   与 global 对齐：`implementer(TDD) → code-review → VBC`；边界测试/detector 票另起一行 `[verify:boundary-testing]`。

#### P3 — 可选结构性简化（中长期）

10. **考虑把 TDD-agent 的 3～4 条硬门禁合并进 Spec reviewer checklist**（acceptance covered、no skip、prove-it），TDD-agent 仅保留 **commit 顺序 + mock 滥用** 专科 — 减少一张表。

11. **`/audit` 与 code-review 关系写进 agents README：**  
    `/audit` = 探索性并行（security + coverage）；**合入门禁仍是 code-review + VBC**，避免 operator 用 audit 替代 review。

---

## 8. 结论表

| Skill / Agent                    | 建议定位                  | 与「确认」关系                      |
| -------------------------------- | ------------------------- | ----------------------------------- |
| `verification-before-completion` | **唯一 claim-done 收口**  | 本体                                |
| `code-review`                    | 合入前硬门禁              | VBC 上游，提供 Spec/Standards 输入  |
| `test-driven-development-agent`  | **条件** S4 过程审计      | 不替代 VBC；与 VBC 重叠度高         |
| `minimal-change-verifier`        | scope + hook；与 VBC 串联 | 部分重叠，应收窄步骤 4              |
| `defensive-contract-validator`   | 新 API / S2 五类          | 与 VBC 互补（测什么类）             |
| `boundary-testing`               | detector/hook 变更        | 与 VBC 互补（采纳门 vs 任务门）     |
| `test-driven-development` skill  | Build 纪律                | 不是确认 skill                      |
| `test-engineer`                  | 条件写手                  | 不是确认 skill                      |
| `architecture-change-reviewer`   | Plan 一次性               | 与 post-impl 确认无重叠（pre 承诺） |

---

## 9. 最终意见（一句话）

在已有 `code-review + VBC` 时，再派 `test-driven-development-agent` 多数是 **第三次查「测够没」** — 应把 TDD-agent 从「应当派」降为 **三条触发之一**；把 **VBC 立为唯一 done 声明**；用 router 文案消掉 test-engineer/implementer 和三种「边界」的歧义。**减的是默认同跑次数，不是减能力面。**

---

## 附录 A：决策口诀

```
写功能       → implementer（自带 TDD）
只补测试     → test-engineer
跨 hook/平台/detector → boundary-testing（改完后，axis1∥axis2）
API 入参边界 → defensive-contract-validator
审测试纪律   → test-driven-development-agent（条件，只读）
合入前       → code-review → verification-before-completion
```

## 附录 B：相关 SSOT 指针

- 路由 flowchart：`.cursor/skills/using-agent-skills/references/flowchart.md`
- Phase map：`.cursor/rules/arthurpower-workflow.mdc`
- 全局执行偏好：`~/.cursor/rules/global.mdc`、`~/.claude/CLAUDE.md`
- Pre/post 五维语义：`.cursor/skills/architecture-change-reviewer/references/dimension-semantics.md`
- Persona 编排：`~/.claude/agents/README.md`
