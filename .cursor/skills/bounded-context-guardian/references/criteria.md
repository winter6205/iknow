# S1 限界上下文 - 详细规范

## 二元判据 (任一未通过 = FAIL)

- [ ] 顶层目录不含 `controllers/` `services/` `repositories/` `models/` (按业务能力切片)
- [ ] 跨模块调用无反向依赖到实现细节
- [ ] 模块间无循环 import
- [ ] 多于 1 个有界上下文时, `docs/context-map.md` 存在

## 出处

Parnas 1972 CACM | Simon Brown C4 + Modular Monoliths | Eric Evans DDD Bounded Contexts

## AI 易违反痛点

LLM 默认按"输入->处理->输出"流程切分文件 (`controller/service/repository`), 暴露实现细节给调用方, 后续需求变更引发链式修改。
