# S3 显式错误处理 - 详细规范

## 二元判据 (任一违反 = FAIL)

- [ ] 无空 catch (PostToolUse hook 物理拦截)
- [ ] 失败不返回 null/-1/"" 而抛类型化异常
- [ ] 错误码为类型化异常, 非魔法字符串/数字
- [ ] 任何 fallback 分支必含 `// EXIT:` 注释标明退出条件

## 出处

《Clean Code》Ch.7 | 《Code Complete》Ch.8 | Amazon Builders' Library "Avoiding Fallback"

## AI 易违反痛点

LLM 大量生成空 catch 吞异常, 用返回 null/-1 代替抛错, 为降复杂度擅自加 fallback 分支 (分支几乎不可被生产测试覆盖)。
