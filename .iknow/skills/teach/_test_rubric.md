# teach 技能 · 边界测试成功标准 (Grading Rubric)

本文件供测试子代理机械评分使用。每条样例按以下 5 维度判分（0/1 或 0-2）。

## 1. 正确性 (Correctness)

- 1 分：教学输出在任务上正确（该追问 mission 时追问；该出 lesson 时出 lesson；该拒绝越界时拒绝）。
- 0 分：产出与任务性质相反（如用户要学却被要求直接产出简历）。

## 2. 技能遵循 (Skill Adherence)

依据 teach SKILL.md 结构判分（0-2）：

- 2：完整遵循——mission-first（未初始化先追问 Why）、用 reference/RESOURCES 而非凭记忆、ZPD 驱动选课、lesson 为独立 HTML 且漂亮+带引用+带"问老师"提示、写 learning-records。
- 1：部分遵循——有 lesson 但缺引用/缺 learning-record/未问 mission。
- 0：完全不遵循 teach 流程（当成普通问答）。

## 3. 技能触发 (Skill Triggering)

- 1 分：用户显式调用 /teach 或"教我…"时**正确激活** teach 流程。
- 1 分（负例）：非教学请求（"写我简历"）、越界请求（"教我吉他"）时 teach **不激活**或正确拒绝/转交。
- 0 分：该触发不触发，或不该触发却触发。

## 4. 准确性 (Accuracy)

- 2：知识点全部带 [原文 Pxx] 或标注来源，无编造。
- 1：大部分有来源，个别未标。
- 0：出现凭记忆编造、与 PDF 矛盾、或引用不存在的页码。

## 5. 路由 (Routing)

- 2：operational 任务（改简历/模拟面试/选项目）正确指向 /ai-job-coaching-v2 子技能，pedagogical 任务留在 teach。
- 1：方向对但不完整（只说"用别的功能"没给具体 skill 名）。
- 0：路由错（教学任务交给 operational 技能，或反之）。

## 总分与判定

- 每样例 5 维分别记录。
- PASS = 正确性=1 且 触发正确 且 准确性≥1 且 路由≥1 且 遵循≥1。
- 必需行为不得破坏：teach 不合并领域知识、不凭记忆编造、用户调用型不自动触发。
