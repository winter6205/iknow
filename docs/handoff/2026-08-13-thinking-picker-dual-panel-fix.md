# Session Handoff — thinking-picker 双面板视觉/交互修复 (2026-08-13)

## 当前 live 状态

- **任务**: 修复 thinking-picker 双面板的 3 个缺陷——开关面板不该有进度条、`/effort` 无参也要打开面板、面板不要占满屏宽（靠左/居中）。
- **为什么重要**: 上一轮把「单一三态面板」拆成 `/thinking` 开关面板 + `/effort` 档位面板（commit `929f07a`），但视觉细节与一个入口行为不符用户预期，用户明确点名要修。
- **operator 显式指令**: 「你都没做好不知道为什么，叫你思考开关风格一致没叫你把进度条也做进去，还有effor为什么还是没有显示面板，而且我建议两个都不要占满屏幕放左边或者中间,交接到下个会话修」

## 已固化工件（引用，不复制 inline）

| 类型                                | 路径 / URL                                                      |
| ----------------------------------- | --------------------------------------------------------------- |
| 设计文档（双面板版定案 + 修订记录） | `docs/design/thinking-picker.md`                                |
| 落盘计划                            | `plans/thinking-picker-design25.md`                             |
| 视觉基线                            | `src/tui/designs/design-25-flow-edge.tsx`                       |
| 语义红线 gate                       | `src/tui/thinking-gate.ts`（`computeThinkingOverride`，不许动） |
| 面板实现（本轮改）                  | `src/tui/thinking-picker.tsx`                                   |
| 键路由/状态（本轮改）               | `src/tui/app.tsx`                                               |

## 本 session 变更

| 变更（文件路径）                                                                           | 一行效果                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `src/tui/thinking-picker.tsx`                                                              | 拆成两面板：`reduceThinkingSwitchKey` / `reduceThinkingEffortKey` + `ThinkingPicker` 判别联合（`{kind:"thinking"}` | `{kind:"effort"}`）                                                                                           |
| `src/tui/app.tsx`                                                                          | 键路由按 `thinkingPickerOpen === "thinking"                                                                        | "effort"` 分派；`switchPreview`/`effortFocusIndex`/`effortFixedIndex` 三状态；Enter 固定不退出 / Esc 保存退出 |
| `src/tui/modal.tsx`                                                                        | 仅注释更新（`reduceThinkingSwitchKey`/`reduceThinkingEffortKey` 键位切片）                                         |
| `tests/tui/thinking-picker.test.tsx`                                                       | 重写 reducer 单测 + 渲染 smoke + 集成（Enter 固定不退出 / Esc 保存退出），36 pass                                  |
| `tests/tui/app.test.tsx`、`tests/tui/keyboard.test.tsx`、`tests/tui/chrome-budget.test.ts` | 同步双面板语义断言                                                                                                 |
| `docs/design/thinking-picker.md`、`plans/thinking-picker-design25.md`                      | 增补「双面板版」修订记录 + 语义红线                                                                                |

> 均已 commit：`929f07a`（9 files，+913/−496）。工作树干净（仅 `node_modules`/`node_modules-empty/` 未跟踪 symlink，非本轮产物）。

## 已验证状态

```
~/.bun/bin/bun run node_modules/.bin/tsc --noEmit
=> exit 0（0 错误）

node_modules/.bin/prettier --check <7 src + 2 docs>
=> exit 0（All matched files use Prettier code style）

~/.bun/bin/bun test tests/tui/thinking-picker.test.tsx tests/tui/app.test.tsx tests/tui/keyboard.test.tsx tests/tui/chrome-budget.test.ts
=> 82 pass / 0 fail（exit 0）

~/.bun/bin/bun test tests/tui/
=> 507 pass / 2 fail（2 个 pre-existing 环境失败：Q6 hub 共享池 + run-errors 无 TTY，base 041702b 已确认同款，非本轮引入）
```

## Open blockers + next steps

**[NEXT] 修 `src/tui/thinking-picker.tsx`：删除开关面板分支里的进度条（`barCells` 循环 + `<text wrapMode="none">{barCells}</text>`，约 338-348 行生成 + 约 376 行渲染），开关面板只保留「标题 + ON/OFF 状态行 + 键位提示」3 行内容（面板总行数从 7 降为 5，同步改 `thinkingPickerRows` 返回值与 `tests/tui/chrome-budget.test.ts` 行账断言），并保持档位面板的进度条不动。**

- 让 `/effort` 无参也打开档位面板：`src/tui/app.tsx` 的 `case "effort"` 里，`parseEffortLevel(text)` 返回 `undefined` 时不再走 notice，改为 `setThinkingPickerOpen("effort")` + `setEffortFocusIndex(effortToDisplayIndex(thinkingEffort))` + `setEffortFixedIndex(effortToDisplayIndex(thinkingEffort))`（seed 当前已提交档）；仅当用户输入了非法 concrete 档（如 `/effort auto`）才走 notice 提示可用档位。同步改 `tests/tui/keyboard.test.tsx` 里 `/effort` 无参用例与 `tests/tui/thinking-picker.test.tsx` 集成断言。
- 面板不要占满屏宽：`ThinkingPicker` 两个 `<box ... width={Math.max(1, cols)}>` 改为靠左或居中收窄（建议固定内容宽或 `alignSelf="flex-start"`，视觉对齐参照 `design-25-flow-edge.tsx` 的 gallery 布局）。需确认 `thinkingPickerRows` 行账与宽度解耦后，`chromeReserveRows` 的 picker 入账仍正确。
- 跑 `~/.bun/bin/bun test tests/tui/` 全量 + `tsc --noEmit` + `prettier --check` 确认绿，再 commit（1 commit = 1 logical task）。

## Suggested skills（下个 agent 建议 invoke）

- `arthurpower:test-driven-development` — 每处修复先写失败测试再改实现（`/effort` 无参打开面板、开关面板无进度条、窄宽布局）。
- `arthurpower:code-review` — 改动后 commit 前跑 Standards + Spec 双轴审查。
- `arthurpower:verification-before-completion` — 收尾前真值自检（tsc/测试/prettier 全量输出，非记忆）。
- `playwright-cli` / 手动 `iknow chat` — 真实终端目视面板宽度与无进度条观感（测试只能断言文本帧，无法断言视觉占宽）。

## 脱敏

- 无 API key / token / password / credential 值出现。
- 凭据一律用环境变量名（`ANTHROPIC_AUTH_TOKEN`、`IKNOW_LLM_API_KEY_ENV`），不写值。
