# Boundary Testing Protocol

> **定位**: 跨多文件 / 多 hook / 多状态 / 多平台改动时的可复用 SOP. 找出 silent bug、边界条件、跨平台差异、子代理覆盖盲区, 在生产前拦截.
>
> **关系**: rule = SSOT 判定标准 (怎么算边界测试通过); skill = 执行入口 (怎么跑 6 步流程). skill body 引用本 rule, 不重复.
>
> **触发词**: 边界测试 / boundary test / 跨文件改动 / 跨 hook 状态 / 子代理报告 / 钩子边界 / hook boundary / 实施前验证 / 端到端验证 / E2E boundary
>
> **不适用**: 单行 typo fix / 用户明确说"就改这一处" / 单字段插入式修改（已在外科式 edit 范畴内）

## 1. 5 类常见真实漏洞 (5 类拦截点)

| #   | 类别                                                           | 拦截点                                         |
| --- | -------------------------------------------------------------- | ---------------------------------------------- |
| A   | 子代理 smoke 不充分 (用理想数据, 不触发真实 FS 边界)           | 主 agent 驱动器级 FS smoke                     |
| B   | 跨平台精度差 (NTFS 100ns vs POSIX; int vs float mtime)         | 10ms 容差或单位对齐                            |
| C   | 状态 key 不对齐 (driver tmpdir cwd vs hook process.cwd)        | driver 注入 tmp_root 重写 state                |
| D   | 整文件重写带 secret 配置文件 (Edit 改写整文件)                 | 外科式 insert / patch; 不整文件重写            |
| E   | detector 出口码语义反 (ground-truth 有漂移却 exit 0 + warning) | detector 进程 exit 1 = 真漂移; exit 0 = 无漂移 |

> D 类项目 delta + 外科式 edit 纪律见项目 `.claude/rules/boundary-testing-protocol.md`.

## 2. 6 步流程骨架

| Step | 标题                    | 一句话                                                                           |
| ---- | ----------------------- | -------------------------------------------------------------------------------- |
| 1    | 定义成功标准            | 把 TP/FP/regression 写成 machine-assertable 指标 (rate 阈值, 不写"应该对")       |
| 2    | 准备 10-30 样例         | 5 类别各 ≥ 2: A 正向 / B 否定 / C 歧义多候选 / D 域外 / E 反向语义               |
| 3    | 子代理起草 + smoke      | 子代理**必须**自己跑 smoke; **但子代理 smoke 不算验收** (理想数据, 不触真实边界) |
| 4    | 主 agent 驱动器级 smoke | 真 FS (`tempfile` + `Path.stat`) / 真 JSON (`json.loads`) / 真 cwd; 不可跳       |
| 5    | A/B 对比 + Step 5 gate  | 候选 TP 升 + FP 降 + 必需行为不退化 = 采纳; 退化则拒, 即使 FP 改善               |
| 6    | 变更记录                | 列出 created / modified / NOT changed (out of scope) + bug 根因 + case 改善      |

## 3. Detector exit-code contract (Step 4 补充)

| Detector 状态       | 进程 exit | stdout 期望                                                                 |
| ------------------- | --------- | --------------------------------------------------------------------------- |
| Ground-truth 有漂移 | `exit 1`  | 列出 `[FAIL] <item>:<check> <path>` (valid detection signal, **不是** FAIL) |
| 无漂移              | `exit 0`  | 静默 (silent is correct)                                                    |

`exit 0` + stdout warning 是反例 — 颠倒的语义信号, 视为 FAIL. 捕获 exit 时用 `python <driver>; echo exit=$?` 直接跑, 不用 `python <driver> | tail` (pipe 丢真 exit).

## 4. 与其他流程关系

| 流程                                              | 关系                                                                                                                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| subagent smoke                                    | 快速 sanity, 必要但不充分                                                                                                                                                        |
| driver-level smoke                                | 严格验收, 必跑不可跳; 出口码 contract 见 §3                                                                                                                                      |
| Step 5 gate                                       | 改动采纳门槛                                                                                                                                                                     |
| `input-contract-tests` (入参契约)                 | **互补不冲突** — 入参契约覆盖 public 入口 5 类输入 (empty/invalid/overflow/concurrent/exception); 本协议覆盖 5 类触发语义 (A-E); 不可互替；编排上本协议 axis1→axis2 **先后**派发 |
| 项目 `.claude/rules/boundary-testing-protocol.md` | 项目特定 delta (外科式 edit 纪律 / Case 3 历史), 互补不冲突                                                                                                                      |

## 5. Terminology

流程规则保留英文工程 token (`machine-assertable`, `assert`, `ground truth`, `pass` / `fail`, `boundary`, `contract`), 不造中文硬译; 中文可 gloss 一次, 判定用 token 保持英文.

## 6. 完整 case 库 + YAML 样例模板

5 类别完整模板 / A1-E2 案例骨架 / Case 1/2/3 长篇叙事 / 触发模板 / 经验启示 6 条 → 见 `cases.md` (同目录, on-demand Read).
