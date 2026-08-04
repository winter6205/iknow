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
- 测试：tests/tui/ 8 文件 85 项（状态机转换表 / slash 词表 / ask-user
  fail-closed / tool-summary 配对 / hub-bridge lazy create / Q6 TUI 半边
  cross-entry / renderToString 多宽度冒烟 / ink render 假 TTY 流端到端）

## 实际运行的验证及结果

| 验证                                                   | 结果                                       |
| ------------------------------------------------------ | ------------------------------------------ |
| `npm run typecheck`                                    | exit 0                                     |
| `npm run build`                                        | exit 0                                     |
| `npm test`                                             | **885/885 全绿**（800 既有 + 85 新增 TUI） |
| pre-commit hook（lint-staged + typecheck + 全量 test） | 两 commit 均通过                           |

### 手工验证（真实 TTY，pty 驱动 + 真实 LLM turn，key 仅运行时 env）

| 场景                            | 结果                                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `iknow tui` 启动                | banner（智慧之眼 braille）+ 输入框渲染正常                                                            |
| 非 TTY 守卫                     | `iknow tui`（管道）报错退出，提示用 ask                                                               |
| 中文输入 + Enter 提交           | lazy create 建档，turn 运行 spinner                                                                   |
| 真实 LLM turn                   | 回复渲染（markdown），落盘 turnCount=1，summary=首条 user 前 80 字符                                  |
| `/sessions` 列表                | summary + 相对时间 + `+ 新建会话` 伪条目，↑↓+Enter，Esc 返回                                          |
| `/quit` 退出                    | exit code 0 干净退出                                                                                  |
| Ctrl+C（turn 运行中）           | 打断前台 turn，提示「已打断当前 turn（未落盘）」；落盘文件 turnCount=0（DROP_REASONS=cancelled 生效） |
| `iknow tui <session-id>` resume | 历史 messages 渲染（你好 + 收到），可续跑                                                             |

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

## 关联

- PR #186（draft）；上游 specs/146-tui.md + specs/120-session-persistence.md；
  分票 #147（流式）；banner 视觉 #154/#171 定案（原型分支 worktree-tui-design-prototype）。
