# 代码质量（iknow）

通用原则（复杂度、错误处理、不顺手重构、不提前抽象、查重复）以用户体系为准，这里只写本仓事实和红线。

## 红线

1. **TUI 单向依赖**（import 方向和自检命令见 `AGENTS.md` 硬边界第 13 条）：会话、工具调用、模型调用、持久化逻辑不写进 TUI 渲染或输入处理代码。
2. **TUI 运行时不写 stdout**：产品代码不直接 `console.log` 或写 stdout/stderr，诊断走 `src/harness/trace/`。
3. **类型**：不新增 `any`、`@ts-ignore`；外部数据（模型输出、工具参数、读入的 JSONL）先当 `unknown`，校验后再收窄；确需抑制用 `@ts-expect-error` 并在同行写原因。
4. **存储格式改动先问**：`SessionStore` 和 trace 的 JSONL 结构可以改，不用兼容旧记录，也不写迁移；但动手前必须先停下来问用户，用户批准了才能改；改完要在完成汇报里写明改了哪些字段。

## 本仓事实

- 模块地图（即 context map）是 `docs/architecture.md` 的「Capability modules」表；新代码放进对应现有模块，新建模块或改职责先给计划，确认后同步更新该表。
- `src/shared`、`src/util` 是既有模块，不再新增同类目录；往里加文件前先确认没有更合适的业务模块，加了要在汇报里列出。
- 配置统一经 `src/config/` 读取，新代码不直接读 `process.env`；新配置项要有默认值或缺失时明确报错。
- 本仓不依赖 iknow-memory，不新增对它的 import 或运行时依赖。
- `scripts/perf/` 下的脚本是测量工具，不是门禁：不设阈值，退出码不是结论，数字只能作证据，并要连同环境（迭代数、机器负载、fence / bwrap 版本）一起引用。改动这类脚本要把它纳入某个 typecheck 程序（当前 `tsconfig.json`、`tsconfig.test.json` 的 include 都不含 `scripts/`），别让工具悄悄腐化。

## 错误与检查

- 新代码不抛通用 `Error`，用类型化异常；fallback 和例外分别用 `// EXIT:`、`// S5-EXEMPT:` 注释写明原因。存量代码不追溯。
- 新增和改动的代码要通过 `npm run typecheck` 和 `npm run lint:s5`（只比较本次碰到的函数，不变差就算通过）；`lint:s5:all` 列出的老问题只写进汇报，不在本任务里修。
- 门禁命令要对将要落地的那棵树跑。`npm run lint:s5` 走 `scripts/lint-s5.sh --changed`，以 `HEAD` 为基线比工作区；分支已提交、工作区干净时它恒为 no-op（输出 `s5-complexity: no changed code files; skip`，退出 0），给的是假绿。要卡本次增量必须带基线：`S5_CHECK="$ARTHURPOWER_PLUGIN_ROOT/scripts/s5-complexity/check.mjs" sh scripts/lint-s5.sh --changed --base master`。输出是 no-op 的这一条按 `Not run: S5 <no-op 原因>` 报，不算通过。
- 要拆分函数或改任务范围外的代码才能通过时，先问用户；用户同意后，被搬动的代码要先有特征测试（没有就报测试缺口，不拆），修复和拆分分成两个提交。
- 完成汇报里写 S5 改动前后的违规数，并单独列出为通过 S5 做的改动。
