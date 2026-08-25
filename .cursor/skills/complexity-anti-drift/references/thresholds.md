# S5 抗劣化简洁 - 详细规范

## 阈值 (分层: 硬闸 FAIL / 软触发 REVIEW)

### 硬闸 (新增违规 = FAIL)

| 指标       | 阈值       | 工具              |
| ---------- | ---------- | ----------------- |
| 圈复杂度   | <= 10/函数 | ESLint complexity |
| 嵌套深度   | <= 4       | ESLint max-depth  |
| 代码克隆率 | <= 3%      | jscpd CI gate     |

### 软触发 (新增违规 = REVIEW, 不 FAIL)

| 指标     | 阈值   | 工具                          |
| -------- | ------ | ----------------------------- |
| 函数行数 | <= 60  | ESLint max-lines-per-function |
| 文件行数 | <= 500 | ESLint max-lines              |
| 参数数量 | <= 4   | ESLint max-params             |

参数数量不计 `self` / `this`。

这些数字是项目级 **gate**（硬闸 FAIL / 软触发 REVIEW），不是 spec 或 plan 的 Acceptance。plan 写结构契约（沿 **responsibility line** 抽取、单一 factory）；要引用本表，不要把单元格抄进 Acceptance。工具列是 **measurement**。数值只在本文件改。

## 出处

《Clean Code》Ch.3 Functions | JPL Power of Ten Rule 4（约一页 / ~60 行） | Fowler 《Refactoring》2nd ed. Ch.3

## AI 易违反痛点

LLM 单文件补全倾向把多职责塞进同一函数 (一次生成一个完整 use case handler); 复制粘贴相近代码而非抽象。
