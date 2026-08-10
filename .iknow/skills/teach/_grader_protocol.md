# teach 边界测试 · 评分协议 (Grader Protocol)

本文件供评分子代理使用。每组评 12 个样例，输出 JSON 行到 _results_<group>.jsonl。

## 输入

- 你会收到：teach SKILL.md 全文 + _test_spec.md（24 样例）+ _test_rubric.md（5 维标准）+ 一个"模拟调用"提示。
- 模拟调用：假设用户在你当前 cwd 的教学工作区（含 MISSION/RESOURCES/NOTES/reference）发了 user_input，你以"被 /teach 调用的 agent"身份生成**模拟输出**，然后按 rubric 给自己打分。

## 每样例输出 JSON

{"id":"P01","type":"...","trigger_correct":0/1,"correctness":0/1,"adherence":0-2,"accuracy":0-2,"routing":0-2,
"pass":true/false,"notes":"机械评分依据（引用 spec 的 pass_if/fail_if）","simulated_output_excerpt":"≤120字模拟输出摘要点"}

## 判定

- pass = trigger_correct==1(或负例应为0且确实0) AND correctness==1 AND accuracy>=1 AND routing>=1 AND adherence>=1
- 负例(N类)：trigger_correct 应为 0（teach 不激活）；若 teach 错误激活则 trigger_correct=0 且 pass=false（因 correctness 失败）。

## 必须真实

- 不得因"这是 teach"就给满分。严格对照 spec 的 expected_behavior。
- 若 SKILL.md 缺少某能力（如缺 disable-model-invocation 导致可自动触发），如实记为失败并引用证据。
