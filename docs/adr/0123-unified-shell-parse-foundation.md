# 0123. 统一 shell 解析地基：tree-sitter 原生绑定 + 同步决策接缝

Date: 2026-09-24
Status: accepted

## Context

权限系统的 spawn 前意图过滤（hard-wall，ADR-0068）至今靠裸子串扫描与手写字符遍历：五类危险模式、两套独立切分器（`hard-walls.ts` `splitShellSegments` / `declarative.ts` `splitCommandSegments`），全部引号盲——引号内数据被当命令替换误拒（#1132），`echo "rm -rf /"` 类字符串字面量同样命中危险子串。ADR-0068 曾把"语义 shell AST"排除在范围外，那是起步期决策；项目后期手搓面已繁殖超出一个正规解析器的复杂度，排除项的前提失效。wayfinder map `unified-shell-parsing` 的 usp-1 实测调研（`docs/wayfinder/research/usp-1-parser-survey.md`，Node v24 / linux-x64）收窄了可选形态，usp-3 定案本 ADR。

## Decision

权限系统引入统一**解析地基**：采用 tree-sitter **原生绑定**（`tree-sitter@0.25.1` + `tree-sitter-bash@0.25.1`，N-API，随包 vendored 六平台 prebuild；非 WASM），单一全同步入口 `parseForSecurity(command)`（新模块 `shell-parse.ts`）。policy 层与 bash handler 层的两道门经由按命令字符串的**有界缓存**共享同一次解析；初始化**惰性**（首次 bash 权限检查时，一次性约 10 ms）；每条命令**新建 Parser 实例**（实测约 0 ms/次）。公共导出 `findDangerousPattern` / `isDangerousCommand` / `commandContainsSensitivePath` 签名不变，内脏迁移为 AST 驱动；旁路同步消费者（如 `scripts/sandbox-probe-subagent.ts`）无感。

理由：`HardRuleSpec.match` 的同步纯函数契约（`src/harness/permission/types.ts`）零改动；原生绑定的 `setTimeoutMicros` 是实测中唯一能确定性掐死对抗性输入（80k 语句 / 20k 深嵌套，5 ms 预算返回 `null`）的形态——不可覆盖硬墙必须 fail-closed 可区分；仓库 `engines.node >= 20`、纯 npm 分发、无 musl/32 位 ARM 目标，原生 prebuild 缺口咬不到。

## Why not

- **WASM 形态（web-tree-sitter）**：启动路径多一次 `await Parser.init()`；无真超时，仅协作式 `progressCallback`，实测同一预算下一次返回 `null`、一次返回完整树（不确定）；vendored wasm 存在 ABI 漂移风险（runtime 升级后旧动态链接格式加载失败，上游 README 自述）。
- **sh-syntax（mvdan/sh→WASM）**：AST 类型最强，但 `parse()` 仅 Promise 形态，与同步决策层冲突；对抗性输入直接 WASM `memory access out of bounds` trap，无超时旋钮。
- **bash-parser**：引号类型丢失、heredoc 不建模（体被解析成命令）、`<(...)` 抛异常、2023-08 后无发布——正是要替换的缺陷类。
- **shell-quote（词法基线）**：fail-open——坏输入从不报错、`${...}` 静默抹成空串，"没看懂"与"看懂且无害"不可区分，对 deny 门是致命属性。

## Consequences

**正面 / Applied:**

- 引号内数据与真实语法可区分，#1132 的"文档被当代码"整类误拒在地基层消失；五类墙与两套切分器获得同一份语法事实，不再各自手搓。
- 同步纯函数契约不变：`HardRuleSpec.match`、`checkPermission`、旁路脚本零签名改动。
- 对抗性输入有确定性预算（`setTimeoutMicros` → `null`），"解析中止"可与"解析器未加载""解析出结构"三态区分（契约细节归 usp-2）。

**负面 / Trade-offs:**

- 引入原生二进制依赖：grammar 包 unpacked 约 20 MB（六平台 prebuild + 静态库）；平台不在 prebuild 列表（musl / 32 位 ARM）时退化为源码编译，需要工具链——当前分发形态不触及，若未来发布形态变化（单文件打包、Alpine 容器）需重审本 ADR。
- npm `allowScripts` 严格策略会对 `node-gyp-build` 安装脚本告警（vendored prebuild 下加载仍成功）；CI/安装文档需注明。
- 每命令新建 Parser 实例换取状态残留归零，是一次性 4.4 ms `setLanguage` 之外的常数开销（实测循环内约 0 ms，可接受）。
- tree-sitter-bash 语法与真实 bash 存在边缘分歧（grammar 无已声明的 limitations 清单）；解析前置字符级检查与旧子串扫描第二层的去留由 usp-2 / usp-5 定，本 ADR 不预设。

## 已知隐患与对策

超时取消后复用同一 Parser 实例会对合法输入产出假 `ERROR`（实测，`reset()` 后恢复）——对策即"每命令新建实例"，把状态残留整类排除。

## 与 ADR-0068 的关系

本 ADR 退役 ADR-0068 的 **"Why not a semantic shell AST"** 排除项。0068 的 hard-wall vs closed-world 职责划分**本身不变**：硬墙仍是 spawn 前意图过滤器，不是第二套沙箱；解析地基只供给语法事实，deny 政策仍归各墙。

## 边界（本 ADR 未定，仍在 wayfinder map `unified-shell-parsing` 上）

解析结果三态契约与 fail-closed 归宿（usp-2）、替换类语法终局策略（usp-4）、迁移顺序与影子期（usp-5）。

## Evidence pointers

- 选型实测：`docs/wayfinder/research/usp-1-parser-survey.md`（单次未预热运行，量级参考）。
- 决策过程：`docs/wayfinder/tickets/usp-3-parse-timing-sync-seam.md`、map `docs/wayfinder/unified-shell-parsing.md`。
- 入口症状：winter6205/iknow#1132。
