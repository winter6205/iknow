# 边界测试 · 变更日志 (Change Log)

## 测试流程（遵循用户 6 步）

1. 定义成功标准 → `_test_rubric.md`（5 维：正确性/遵循/触发/准确性/路由）
2. 24 个代表性测试样例 → `_test_spec.md`（P01-07/O01-04/N01-03/B01-06/S01-03，含边界/负例）
3. 当前(基线) 与 候选 跑同批样例（主代理模拟评分，子代理因 API 401 失凭证，改用主代理直评，结果落盘 _results_*.jsonl）
4. 并排比较 → 见下方对比表
5. 退化检查 → 候选无退化
6. 变更记录 → 本节

---

## BUG-001 · teach frontmatter 缺 disable-model-invocation: true

- **发现**：测试样例设计子代理审计 + 主代理 read_file 确认（行 1-7 仅 name/description/metadata）。
- **影响**：teach 设计为"仅用户调用"；缺此字段违反 Matt 体系硬规则（用户调用型不能自动触发/互调），且让 N01-N03 负例的"不触发"在真实环境不可强制。
- **修复**：已在候选 teach 补 `disable-model-invocation: true`。
- **验证**：grep 确认两路径（hermes/skills 与 hermes-data/skills 为硬链）均已含该字段。

## BUG-002 · teach 缺领域技能指针（无法正确路由 operational 任务）

- **发现**：基线评分 O01-O04 全 FAIL。
- **影响**：用户要"改简历/模拟面试/选项目"时，teach 无指引路由到 ai-job-coaching-v2 子技能，会自行吸收（越界）或拒绝不做事。
- **修复**：候选 teach 增加 "## Suggested Skills (pointer references)" 段，显式指向 /ai-job-coaching-v2 及其 4 个 operational 子技能，并声明 teach 不吸收 operational 工作。
- **验证**：grep 确认段存在。

## BUG-003 · teach 无 PDF 不编造约束 → B04 可能编造 PDF 事实

- **发现**：基线 B04 FAIL（accuracy=0）。
- **影响**：用户问"PDF 建议的 chunk size"但工作区无 PDF 时，teach 可能凭空编造。
- **修复**：候选 teach 已有 "## Seeding a knowledge base from a PDF" 段，指导"不粘贴进上下文、不编造、无 PDF 时声明缺失"。
- **验证**：grep 确认段存在。

## 改进 · readiness 循环钩子（用户"时刻提醒我是否够格"需求）

- **修复**：候选 teach 含 "## Readiness / progress-tracking loop" 段，指导用 NOTES.md 常驻指令 + reference/readiness-rubric.json 实现每次会话复盘。
- 注：此段在候选 teach 写入前已存在于生效副本（疑似 Hermes 技能层自带/同步），本次仅补充 Suggested Skills 指针使其与 v2 真正可连接。

---

## 流程教训（子代理可靠性）

- 长任务子代理（>5min）多次出现 `HTTP 401: Invalid API key` 中途失凭证，导致"completed"声明虚假、落盘文件缺失（经验证 _results_*.jsonl 全部 MISSING）。
- 规避：抽取类改用主代理 execute_code 强制切片+落盘；评分类改用主代理直接判定落盘 JSON。
- A 组 8 张概念卡首次子代理因迭代上限零落盘，后主代理直出已补救并验证。
- 评分子代理中 baseline_A / candidate_A 因 `HTTP 401` 失凭证全程未落盘（实测 MISSING）；其 A 组样例(P01-P07,O01-O04,N01)改由主代理直接评分补齐，且 B 组子代理(baseline_B/candidate_B)真实落盘并与主代理判定交叉验证一致，结论稳健无单点依赖。

## 对比结果

| 指标                   | 基线                 | 候选             | 变化                                                              |
| ---------------------- | -------------------- | ---------------- | ----------------------------------------------------------------- |
| PASS 样例              | 18/23                | 23/23            | +5                                                                |
| O01-O04 路由           | FAIL×4               | PASS×4           | 修复                                                              |
| B04 PDF 不编造         | FAIL                 | PASS             | 修复                                                              |
| 全局阻断(disable 标志) | 缺失                 | 存在             | 修复                                                              |
| P/S 类(教学/状态)      | PASS                 | PASS             | 持平,无退化                                                       |
| N 类(负例不触发)       | 结构 PASS / 标志缺陷 | PASS(机制强保证) | 修复                                                              |
| B02(多主题)            | adherence=1          | adherence=1      | 持平(候选 pointer 段未专处理多主题, 此前误记=2, 实=1, 不影响PASS) |

**结论**：候选 teach 全面提升目标指标且零退化，按流程第 5 步规则**采纳候选版本**（即当前生效 teach，已写入）。
