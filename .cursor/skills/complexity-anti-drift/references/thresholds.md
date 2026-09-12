# S5 抗劣化简洁 - 详细规范

## 阈值 (分层: 硬闸 FAIL / 软触发 REVIEW)

### 硬闸 (新增违规 = FAIL)

| 指标       | 阈值       | 工具              |
| ---------- | ---------- | ----------------- |
| 圈复杂度   | <= 10/函数 | ESLint complexity |
| 嵌套深度   | <= 4       | ESLint max-depth  |
| 代码克隆率 | <= 3%      | jscpd CI gate     |

### 软触发 (新增违规 = REVIEW, 不 FAIL)

| 指标     | 阈值    | 工具                          |
| -------- | ------- | ----------------------------- |
| 函数行数 | <= 60   | ESLint max-lines-per-function |
| 文件行数 | <= 1000 | ESLint max-lines              |
| 参数数量 | <= 4    | ESLint max-params             |

参数数量不计 `self` / `this`。

文件行数是最弱的一档：JPL / Clean Code 卡的是**函数**约一页，不是整文件。Sonar「Files should not have too many lines」默认约 1000。500 会把状态机 / TUI / adapter 正常模块刷成警告。god-file 靠职责（ACR），不靠把 500 当硬味道。

这些数字是项目级 **gate**（硬闸 FAIL / 软触发 REVIEW），不是 spec 或 plan 的 Acceptance。plan 写结构契约（沿 **responsibility line** 抽取、单一 factory）；要引用本表，不要把单元格抄进 Acceptance。工具列是 **measurement**。数值只在本文件改。跑测量用插件脚本 `scripts/s5-complexity/check.mjs`（见仓库 README「S5 complexity check」）：落地 / hook 用 `--changed`（只扫改动的代码文件）；债图用路径（默认 `src`）。硬闸 error / 软闸 warn。

## 出处

《Clean Code》Ch.3 Functions | JPL Power of Ten Rule 4（约一页 / ~60 行） | Fowler 《Refactoring》2nd ed. Ch.3（Long Function / Large Class = 内聚，不是固定 500 行） | Sonar file-LOC default ~1000

## AI 易违反痛点

LLM 单文件补全倾向把多职责塞进同一函数 (一次生成一个完整 use case handler); 复制粘贴相近代码而非抽象。
