# Plan: shift+tab 切换 auto 权限模式（W2·扩展）

> 上游：#146 TUI 骨架 + W2 权限模式（`specs/security-guardrails.md` §A1 模式枚举）。
> 参考实现：upstream-openharness `PermissionMode`（`default | plan | full_auto`，UI label `full_auto → "Auto"`，
> `[Z`/Tab 在 TUI 打开 mode picker 注解见 `upstream-openharness/src/openharness/commands/registry.py:2441`）。
> 本计划新增 TUI / REPL 两条交互入口的「快捷切换 mode」，不改动 mode 枚举与 hard-wall 语义。

## Goal

让 TUI 与 REPL 操作员按 **shift+tab** 即可在 `default ↔ full_auto`（显示标签 `"Auto"`）之间循环翻转当前权限模式。
`plan` 模式保留但**不进 shift+tab 序列**（避免误触让 mutating 工具被静默拒绝）——plan 仅走 `/permissions plan` 命令。

## Background — 当前形态

- `src/harness/permission/modes.ts:28`：`PERMISSION_MODES = ["default", "plan", "full_auto"] as const`。
- `src/harness/permission/policy.ts:139-147`：`full_auto` 已对所有非 hard-wall 工具返回 `allow`。
- `src/tui/deps.ts:93`：`const policy = createPermissionPolicy();` 未传 mode → mode 永远是引擎装配时的静态值（`default`），**无 context 引用**。
- `src/cli.ts:163-191`：`runChat` 创建 `createPermissionModeContext(...)` 并透传到 `buildHarnessEngine` + `runChatSession`。
- `src/cli/chat-session.ts:226-263`：REPL 已有 `/permissions [mode]` 命令。
- `src/tui/components.tsx:124-129`：PromptInput 的 `useInput` 中 `if (key.tab)` 直接 return，**会吞掉 shift+tab**——需要在 PromptInput 让出 shift+tab。
- ink 的 `Key` 接口（`node_modules/ink/build/hooks/use-input.d.ts`）无 `shiftTab` 字段；
  shift+tab 在 pty 发 CSI `Z`（`\x1b[Z`），ink 解析为 `key.tab && key.shift`。

## Design

### 1. 切换序列（推荐，待 operator 拍板）

- shift+tab **循环翻转**：`default → full_auto → default → …`；从 `plan` 按 shift+tab → 直达 `full_auto`。
- 显示标签（对齐 openharness UI protocol 的 `_MODE_LABELS`）：
  - `default` → `"Default"`
  - `plan` → `"Plan Mode"`（不进 shift+tab 序列）
  - `full_auto` → `"Auto"`
- 不为 `full_auto` 加 `auto` 别名（避免污染 env 解析 `IKNOW_PERMISSION_MODE`）—— 显示层做映射。

### 2. TUI 接线

- `src/tui/run.tsx`：创建 `permissionMode = createPermissionModeContext(...)`，传给 `<TuiApp>` 与 `buildTuiDeps`。
- `src/tui/deps.ts`：新增 `BuildTuiDepsOptions.permissionMode?: PermissionModeContext`；构造 policy 时 `mode: opts.permissionMode`。
- `src/tui/app.tsx`：
  - `TuiAppProps.permissionMode: PermissionModeContext` 透传到 `buildTuiDeps`。
  - 全局 `useInput`（已存在，line 820）增加分支：
    - `if (key.tab && key.shift)`（且 `!key.ctrl && !key.meta`）→ `permissionMode.set(next)` + `setNotice({ lines: ["mode: Auto" | "mode: Default"] })`。
    - 放在 `isSgrMouseSequence` 守卫之后、`Ctrl+C` 守卫之前；与 view 无关（list 视图也生效，方便从列表态切 mode）。
- `src/tui/components.tsx:124` PromptInput 调整：
  - `if (key.tab && !key.shift)` → 走原补全路径；
  - `if (key.tab && key.shift)` → **不 return**（继续往下到 `key.ctrl/meta/escape` 的 return 路径），让全局 app.tsx useInput 捕获。
- 状态指示：app.tsx 在输入框上方右对齐显示一行 dim 模式标签：
  - 仅 chat 视图挂载；窄列（cols < 40）降级为 `[auto]` / `[def]` 简短形态。
  - mode 从 `permissionMode.get()` 取；通过 `useTick(100)` 触发状态轮询，保持 mode 翻转时即时刷新。

### 3. REPL 接线

- `src/cli/chat-session.ts:runInteractive`：在创建 `rl` 之后挂 `keypress` 监听 shift+tab：
  - 守卫 `key.shift && !key.ctrl && !key.meta`；
  - 通过 `opts.ctx.permissionMode`（chat-session.ts:71 已透传）翻 mode；
  - `writeErr` 单行提示当前 mode；
  - `rl.prompt(true)` 重绘 prompt。
- `runPiped` 不挂——非 TTY 没 keypress。
- `/permissions` 命令本身不动。

### 4. 显示层 helper

新增 `src/harness/permission/modes.ts` 的伴生 `modeLabel(mode)`：

- 接受 `PermissionMode`，返回 `"Default" | "Plan Mode" | "Auto"`。
- 导出供 TUI / REPL / 后续 web 复用。
- 单元测试：`tests/harness/permission/modes.test.ts` 追加断言。

## Files expected to change

| 文件                                     | 变更摘要                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| `src/harness/permission/modes.ts`        | 新增 `modeLabel()` helper（导出）                                        |
| `src/tui/deps.ts`                        | `BuildTuiDepsOptions.permissionMode` + 构造 policy 透传                  |
| `src/tui/run.tsx`                        | 创建 `permissionMode` context，传给 `<TuiApp>` + `buildTuiDeps`          |
| `src/tui/app.tsx`                        | `TuiAppProps.permissionMode`；全局 useInput shift+tab 分支；模式指示 row |
| `src/tui/components.tsx`                 | PromptInput useInput 让出 `key.tab && key.shift`（不 return）            |
| `src/cli/chat-session.ts`                | `runInteractive` 加 keypress 监听 shift+tab                              |
| `tests/harness/permission/modes.test.ts` | `modeLabel()` 单测                                                       |
| `tests/tui/app.test.tsx`                 | 新增 shift+tab 用例：mode 翻 full_auto / default、模式标签可见           |
| `tests/cli/cli-session.test.ts`          | 新增用例：mock keypress `tab + shift` → mode 翻转 + stderr 输出          |
| `CHANGELOG.md`                           | W2 扩展：shift+tab 切换 auto / Auto 显示标签                             |

不动：`ask` / `serve` 入口；modes.ts 枚举；policy.ts 决策；hard-walls；`/permissions` 命令。

## Validation

```bash
npm run typecheck              # tsc --noEmit 全绿
npm test                       # vitest run：modes.test / app.test / cli-session.test 全绿
npm run build                  # tsc -p tsconfig.json 全绿
# 手工验证（TTY）：
npm run dev -- tui             # 启动 TUI，按 Shift+Tab → 右上角"mode: Auto"；再按 → "mode: Default"
npm run dev -- chat            # 启动 REPL，按 Shift+Tab → stderr 行 "权限模式: Auto"
```

边界用例（必须覆盖）：

1. mode = plan 时按 shift+tab → 跳到 full_auto（不入 default）。
2. TUI list 视图按 shift+tab → 仍生效。
3. running-fg 状态按 shift+tab → 仅翻 mode 不打断 turn。
4. ask / serve 入口无 mode context → 守卫短路，零回归。
5. PromptInput 在 hint 候选态按 shift+tab → 不补全、不动 hint cursor；app 层 useInput 拿到 shift+tab 翻 mode。

## Risks & Rollback

- **ink useInput 广播 + PromptInput 顺序**：若未来 PromptInput 改回 return 全部 key.tab → shift+tab 失效。缓解：components.tsx 加注释 + 单测断言。
- **readline keypress 与 PromptInput 概念碰撞**：REPL 用 readline，无 PromptInput；独立路径，零干扰。
- **TTY 兼容性**：WSL2 + iTerm2 + GNOME Terminal 均发 CSI `Z` for shift+tab。
- **回滚**：所有变更可拆单 commit revert。

## Out of scope（明示不做）

- 不新增 mode 枚举。
- 不动 hard-wall 决策。
- 不为 `auto` 加 env 别名。
- 不改 web UI 模式控件。
- 不改 session 持久化（mode 不入 session file；进程级，与 openharness 一致）。
