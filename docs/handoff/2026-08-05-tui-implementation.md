# 2026-08-05 — iknow tui 子命令实施（#146 tracer bullet）

## 改了什么

- 新增 `src/tui/` 模块（14 文件）：app.tsx（根组件 + 三态状态机编排）/
  chat-view / list-view / components（Spinner + PromptInput）/ markdown /
  banner + banner-art（智慧之眼 braille，原型分支搬入）/ session-state /
  slash / hub-bridge / ask-user / deps / tool-summary / version / run.tsx（入口）
- `src/cli/parse-args.ts`：CliCommand 加 `"tui"` + `sessionId` 可选位置参数；
  `src/cli/usage.ts`：usage 加 tui 行；`src/cli.ts`：runTui 分支（动态 import）
- `src/session-api/store/schema.ts`：**附带缺陷修复**——isValidContentBlock
  增加 thinking / redacted_thinking block 形状校验（#151 thinking 启用后，
  真实 LLM turn 的 assistant 消息含 thinking block，原校验拒绝导致含
  thinking 的会话 load 全部 schema_invalid；TUI/serve 双入口受影响）
- 构建配置：tsconfig.json `jsx: react-jsx` + include .tsx；vitest include .test.tsx
- 依赖：ink ^7.1.1 + react ^19.2 + @types/react（操作员授权 lockfile）
- 测试：tests/tui/ 8 文件 86 项（状态机转换表 / slash 词表 / ask-user
  fail-closed / tool-summary 配对 / hub-bridge lazy create / Q6 TUI 半边
  cross-entry / renderToString 多宽度冒烟 / ink render 假 TTY 流端到端，
  含 SC5 切走→running-bg→落盘集成项）

## 实际运行的验证及结果

| 验证                                                   | 结果                                       |
| ------------------------------------------------------ | ------------------------------------------ |
| `npm run typecheck`                                    | exit 0                                     |
| `npm run build`                                        | exit 0                                     |
| `npm test`                                             | **886/886 全绿**（800 既有 + 86 新增 TUI） |
| pre-commit hook（lint-staged + typecheck + 全量 test） | 各 commit 均通过                           |

### 手工验证（真实 TTY，pty 驱动 + 真实 LLM turn，key 仅运行时 env）

| 场景                            | 结果                                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `iknow tui` 启动                | banner（智慧之眼 braille）+ 输入框渲染正常                                                                                                    |
| 非 TTY 守卫                     | `iknow tui`（管道）报错退出，提示用 ask                                                                                                       |
| 中文输入 + Enter 提交           | lazy create 建档，turn 运行 spinner                                                                                                           |
| 真实 LLM turn                   | 回复渲染（markdown），落盘 turnCount=1，summary=首条 user 前 80 字符                                                                          |
| `/sessions` 列表                | summary + 相对时间 + `+ 新建会话` 伪条目，↑↓+Enter，Esc 返回                                                                                  |
| `/quit` 退出                    | exit code 0 干净退出                                                                                                                          |
| Ctrl+C（turn 运行中）           | 打断前台 turn，提示「已打断当前 turn（未落盘）」；落盘文件 turnCount=0（DROP_REASONS=cancelled 生效）                                         |
| 中途切走 → 后台完成 → 切回      | stub 慢 turn 起跑后 /sessions 切走：B 转 running-bg、状态栏 `后台运行中`、后台跑完落盘（turnCount=1）；自动化见 tests/tui/app.test.tsx SC5 项 |
| `iknow tui <session-id>` resume | 历史 messages 渲染（你好 + 收到），可续跑                                                                                                     |

## 未验证内容及原因

- **真实终端 resize**：pty 冒烟未模拟 resize 事件；`useWindowSize` 已有
  renderToString 多宽度冒烟覆盖（40/80/120 列无溢出），真实 resize 留操作员手工确认。
- **WSL2 终端兼容性**：冒烟在 python pty 层（Linux 侧），Windows Terminal /
  WSL2 前端渲染（truecolor / braille 字形）留操作员确认。
- **跨进程并发写**（决策 4=9a 本期不做）：TUI + serve 双进程同时写同一会话
  未测，已知边界另立 issue。
- **askUser 交互授权**：单测覆盖 fail-closed 纪律；真实 TTY 弹授权框未冒烟
  （需触发 ask 决策的工具调用路径）。

## 决策与已知边界

1. **工具摘要行时机**：`createAciExecutor` 原生 `hooks.postToolUse`（事后、
   per-call、observability-only）——比自装饰 Executor 更贴官方接缝；v1 无
   start 事件（摘要行完成即现）。
2. **askUser**：自建 ink 桥接（queue-based fail-closed，仿 serve）；readline
   与 ink raw mode 冲突，不能用 createTtyAskUser。
3. **测试基建**：ink render + 假 TTY 流（PassThrough + isTTY/columns/rows/
   setRawMode/ref/unref 假面 + kittyKeyboard disabled + 逐字符让出事件循环）；
   不引入 ink-testing-library。
4. **流式**：#147 独立票，渲染层整段返回 + spinner，turn 完成回调即未来增量挂载点。
5. **已知 flake**：`tests/harness/aci/interrupt-routing.test.ts` SC13（真实
   spawn + 150ms abort 时序）在高负载下偶发失败——预存问题（master 同样失败），
   与本改动无关（隔离跑 20/20 全绿）。

## Code review 整改（双轴审查后）

双轴审查（spec 轴 + standards 轴，pinned diff master...HEAD）= 0 High / 9 Medium
/ 11 Low；v-code-review 二进制本机不可用（无 fork 仓库 + 无 go 工具链），按技能
规则报告不可用并改派 spec-reviewer / standards-reviewer 等价双轴。

已整改（Medium）：

1. SC5「切走 → running-bg 后台跑完落盘」补端到端集成测试（tests/tui/app.test.tsx）
   - handoff 手工表补行（原仅状态机纯函数覆盖）。
2. spec「banner 纯 ASCII」与 #154/#171 定案冲突 → 按 OQ4 纪律回填
   specs/146-tui.md（Code Style / Always / OQ1 三处）+ 搬入落档
   docs/design/DESIGN-BANNER.md（banner.ts / banner-art.ts 引用路径同步修正）。
3. 刷新会话失败卡死 running-fg（aborter 已移除 → Ctrl+C 无效 + 发送被护栏挡）
   → catch 路径同样 turnFinished 落回 idle。
4. sendTurn 85 行混职责 → 异步主体拆为 runTurnOnce，sendTurn 只做状态编排。
5. markdown.tsx Markdown() 141 行 / CC≈20 → parseBlocks（判别式块 AST，纯函数
   可单测）+ renderBlock 分离，各块解析独立函数；渲染行为不变。
6. version.ts readVersion 与 cli/usage.ts getVersion 重复（fallback 还不一致）
   → 复用 getVersion（SSOT）。
7. 三处截断重复（app.tsx / tool-summary.ts / list-view.tsx）→ 收敛
   src/tui/text.ts clipOneLine。
8. tui-cross-entry.test.ts 手拼会话目录名 → 改用 store 导出的
   resolveProjectSessionDir（命名策略不在测试里复制）。

一并 Low 整改：tuiPalette Object.freeze（仓库共享常量纪律）；list-view 删
lastFinalText 数据回退（ACR ⑦ 用 summary 字段，空则占位「(空)」）；
hub-bridge.test 失败路径断言升级为 kind=not_found（原 rejects.toBeTruthy）；
useTick 增加禁用档（periodMs<=0 不挂定时器）；根 tick 仅在 askUser pending
时挂载（idle 不再 10Hz 整树重渲染）；重复 import 合并；未用 import 删除。

不整改（评估后排除）：TuiApp 组件整体拆 hook（大重构超本次范围，runTurnOnce
拆分已收敛主要变更面）；banner SHORT 档接线（#154 高度自适应后续票，文档已说明）；
handoff 中「真实 TTY 切走-切回」手工项由自动化 SC5 项等价覆盖。

## 关联

- PR #186（draft）；上游 specs/146-tui.md + specs/120-session-persistence.md；
  分票 #147（流式）；banner 视觉 #154/#171 定案（原型分支 worktree-tui-design-prototype）。
