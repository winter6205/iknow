# thinking-picker 设计文档（编辑器极简风）

> 状态：**定案（双面板版）**。可直接据此实现。
> 输入：`/thinking` 或 `/effort` 回车 → **不直接生效**，弹出浮层面板。
> 语义基线：与现网 `/thinking` 开关 + `/effort` 档位（`thinkingEnabled` / `thinkingEffort` state）**同源同值**，本设计只改交互入口，不触碰 `computeThinkingOverride` 语义。

## 修订记录（双面板版，最终定案）

早期版本（下方 §0–§8 正文）把 `/thinking` 与 `/effort` 合并为**单一三态面板**（off/auto/manual），Enter 提交即关闭、Esc 取消。经用户澄清后**废弃**，最终定案改为**两个独立面板**：

- **`/thinking` = 纯开关面板**（ON/OFF），只影响 `thinkingEnabled`，不碰 `thinkingEffort`。标题 `思考开关`。
- **`/effort` = 纯档位面板**（low/medium/high/xhigh/max 5 档），只影响 `thinkingEffort`（隐式 `thinkingEnabled=true`），不碰开关。标题 `思考强度`。
- 两面板视觉风格一致（design-25：圆角流光边框 + 紫渐变进度条 + 边界水线）。
- **Enter = 选定并固定**：把当前选择固定为面板内已提交值，**面板保持打开**，可继续调（开关面板 Enter 固定当前 ON/OFF 预览、不翻转；档位面板 Enter 把焦点档固定为已提交档）。
- **Esc = 保存退出**：把面板内「已固定」的值写入真实 `thinkingEnabled` / `thinkingEffort`，然后关闭面板。**没有 cancel/放弃路径**。

下方 §0–§8 保留为历史设计过程；键路由与渲染以源码 `src/tui/thinking-picker.tsx` 的 `reduceThinkingSwitchKey` / `reduceThinkingEffortKey` / `ThinkingPicker`（`ThinkingPickerState` 判别联合）为准。

---

## §0 设计基线（代码事实，实现者必读）

- 状态已存在于 `src/tui/app.tsx`（9f8a4e0 引入）：
  - `thinkingEnabled: boolean` — `/thinking` 开关（影响模型请求），初始 `props.defaultThinking?.mode === "adaptive"`，**默认 off**。
  - `thinkingEffort: ThinkingEffortWire` — `"" | "low" | "medium" | "high" | "xhigh" | "max"`，初始 `props.defaultThinking?.effort ?? ""`，**默认 medium**（env `IKNOW_LLM_THINKING_EFFORT` 缺省 `""` → 展示层映射为 `medium`）。
  - 生效路径：`runTurnOnce` → `computeThinkingOverride(defaultThinking, thinkingEnabled, thinkingEffort)` → `bridge.postMessage({ thinking })`。**本设计不修改这个 gate**；picker 只是 `setThinkingEnabled` / `setThinkingEffort` 的新入口。
- 语义（本设计必须维持）：
  - **Auto 开** → `setThinkingEffort("")`；5 档灰显（不可选）。
  - **选某档** → `setThinkingEffort(picked)` + `setThinkingEnabled(true)`（隐式开）；Auto 圆点自动转 ○。
  - **档位默认 medium**（env 默认 `""` → 展示 `medium`；env 显式档位则回显该档）。
  - **Auto 默认 off**。
- 面板触发后**输入框已清空**（`handleSubmit` 开头 `setInputValue("")`），Enter/Esc 后输入框仍空——本设计维持该行为。
- 键位冲突：OpenTUI 全局 `useKeyboard` 是**单通道**（app.tsx 现有 rewind/ask modal 都是"活跃时独占"模式）。picker 用同一纪律：**pickerOpen ≠ null 时，`useKeyboard` 顶部先拦 ←/→/Tab/Space/Enter/Esc/可打印字符**，否则落回既有路由。**必须**在 Shift+Tab / Ctrl+C 分支**之后**、在 rewind picker 分支**之前**插入（优先级：Ctrl 组合 > picker > rewind > 双 Esc > ask modal）。
- 键名：`KeyEvent.name` 的 `space`、`left`、`right`、`tab`、`return`、`escape`（现有代码 `e.name === "return"` 同款）。`e.ctrl` / `e.meta` 组合一律不拦（让给 app 层）。

---

## §1 面板 ASCII 草图

### 静态骨架（打开时，占 5 行）

```
┌──────────────────────────────────────────────┐
│ 思考控制          auto ●           [Esc 取消] │
│                                                │
│  low  medium  high  xhigh  max                 │
│                                                │
│ ←/→ 切档 · Tab/Space 开关 · Enter 生效          │
└──────────────────────────────────────────────┘
```

终端宽 ≥ 40 列；面板**固定 5 行**，不随档位/状态变高。圆点行与档位行之间、档位行与提示行之间各 1 空行（用 `<box flexDirection="column" gap={1}>` 实现，见 §6）。

### 变体 a：auto off + medium 当前档

```
 思考控制          auto ○   [Esc 取消]
                                       ← 提示不换行，整行 dim
  low  medium  high  xhigh  max
                          ↑
                   current 档：BOLD + selected 反白底（50ms 闪后定格）
 ←/→ 切档 · Tab/Space 开关 · Enter 生效
```

### 变体 b：auto off + high 当前档

```
 思考控制          auto ○   [Esc 取消]

  low  medium  high  xhigh  max
                      ↑
           current 档前移：同款 BOLD + 反白底

 ←/→ 切档 · Tab/Space 开关 · Enter 生效
```

### 变体 c：auto on + 5 档 disabled

```
 思考控制          auto ●   [Esc 取消]

  low  medium  high  xhigh  max      ← 5 档全部 DIM，无反白
                        └ 均灰显，当前档不再高亮（无 current）

 ←/→ 切档 · Tab/Space 开关 · Enter 生效
```

### v1/v2 根本差异（对比候选 → 最终选择）

- **候选 1（顶/底各一条 `─` 线框）**：需 `<box borderStyle="single" border={["top","bottom"]}>` 或自定义 `customBorderChars`。OpenTUI 0.5 的 `border` 支持 `BorderSides[]`，可实现，但引入 2 行硬线框，与"零装饰"冲突，且 `border` 数组形态无现成代码先例。
- **候选 2（完全无边框，纯空行分隔 + 标题加粗）**：v2 的"纯空行分隔"需要 panel 自带 margin 才能与输入框拉开视觉距离——面板高 5 行 + 前后空行 = 行账复杂化。
- **候选 3（仅标题行 + 单列）**：单列无法容纳双交互面（Auto 圆点 + 5 档并行），信息密度不足。
- **最终选择：`rounded` 边框 + `borderColor={pal.border}` 灰，`paddingX={1}`，`marginBottom={1}`，标题行**。理由：直接复用 app.tsx 中 **PromptInput 同款圆角灰框**（`chat-view.tsx` banner 也是 `borderColor={pal.border}`）——单色灰、低视觉噪音；`rounded` 是既有测试断言过的行数形态；**色阶克制**由 token 选择保证（不新造色）。与 SelectModal 的关键差异在 §5 列表。顶/底 `─` 分隔线 = **不用**；提示分块 = **用空行**（`gap`）+ 语义色，不用线。

---

## §2 视觉决策表

| 元素                                            | 颜色 token                        | attribute             | 动画                           | 备注                                                                       |
| ----------------------------------------------- | --------------------------------- | --------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| 标题 `思考控制`                                 | `text`                            | BOLD                  | 无                             | 左侧第一 token                                                             |
| 标题行 `[Esc 取消]` 提示                        | `dim`                             | DIM                   | 无                             | 右侧同行为标题，左对齐排布（`justifyContent="space-between"`）             |
| Auto 标签 `auto`                                | auto 开→`running`；auto 关→`text` | auto 开→BOLD；关→NONE | 无                             | 值语义色 + 字重                                                            |
| Auto 圆点 `●`/`○`                               | 开→`running`；关→`text`           | 无                    | **无**（静态）                 | 圆点本身就是状态位                                                         |
| 5 档标签（非当前、auto 关）                     | `text`                            | NONE                  | 无                             | 全部同色，无递进                                                           |
| 当前档标签（auto 关）                           | `accent`                          | BOLD                  | **50ms 反白闪过（inOutQuad）** | 唯一动效，见 §3                                                            |
| 当前档反白底                                    | `selected`（bg）                  | —                     | 同上 50ms                      | 与 BOLD 并存；`<span fg={pal.accent} bg={pal.selected} attributes={BOLD}>` |
| 5 档标签（auto 开 disabled）                    | `dim`                             | DIM                   | 无                             | 灰显，无高亮、无反白                                                       |
| 档位间分隔                                      | 无（用空格）                      | —                     | 无                             | 纯空格 2 列分隔，不用竖线/不用块字符                                       |
| 提示行 `←/→ 切档 · Tab/Space 开关 · Enter 生效` | `dim`                             | DIM                   | 无                             | 固定文案，不随状态变化                                                     |
| 面板边框                                        | `border`（灰）                    | —                     | 无                             | rounded，`paddingX={1}`，`marginBottom={1}`（与 PromptInput 同款）         |
| 面板背景                                        | 无（透明）                        | —                     | 无                             | 不用 `codeBlockBg` 等块底色                                                |

---

## §3 动效（0~1 个，定案：**1 个**）

**原则**：用户操作才有反馈；反馈 <150ms；不接受 loop/alternate/pulse/呼吸；无入场/出场动画（picker 弹出即现、Esc 即隐——极简拒绝装饰性过渡）。

**定案：档位切换时当前档字符 50ms 反白闪过一次。**

- 实现：`useTimeline({ autoplay: false })`（本组件内新建，不全局共享）；`Timeline.add(flashTarget, { duration: 50, ease: "inOutQuad", onUpdate, onComplete })`。
  - `flashTarget` = 一个普通对象 `{ t: 0 }`；`onUpdate(a)` 里把 `a.targets[0].t` 读为 0→1 进度，映射为**反白强度**：`t < 0.5 ? 反白底 on : 反白底 off`（即 50ms 内前半程亮、后半程灭——**无平滑淡出，是硬切换**，符合"闪"）。
  - 或者更简单：`useTimeline` + `add` + `onComplete` 里 `setState` 关掉反白标记。实现者二选一，**禁止**把 `t` 直接映射成不存在的"透明度"。
- 只闪一次；切到新档立即重触发（重置 timeline 或重新 add）。
- **无动画的替代方案拒绝**：纯状态切换会让"当前档"位置变化无可感知（见 §8 风险 1），50ms 硬闪是最低成本的补偿，且严格 <150ms、无 loop。
- **Auto 圆点不闪**、**禁用灰显不闪**：动效预算只给"档位切换"这一个动作。

---

## §4 键盘交互状态机

```
状态空间：
  pickerOpen: null | "thinking" | "effort"     ← 打开源头（/thinking vs /effort）记录，Esc 后可区分
  autoOn: boolean                               ← 面板内暂存（未提交）
  focusedIndex: 0..4                             ← 5 档（low=0 … max=4）；autoOn 时锁定为 -1 语义（不可选中）

初始：/thinking 回车 → { pickerOpen:"thinking", autoOn:thinkingEnabled, focusedIndex:effortToIndex(thinkingEffort) }
      /effort 回车 → { pickerOpen:"effort",  autoOn:thinkingEnabled, focusedIndex:effortToIndex(thinkingEffort) }
      （两者初始 autoOn 相同、focusedIndex 相同——唯一区别是 Esc 后的提示文案，见下）

事件 → 转移（全部在 app.tsx useKeyboard 顶部、pickerOpen≠null 时短路；无 ctrl/meta）：

  LeftArrow  (pickerOpen≠null && !autoOn)  → focusedIndex = max(0, focusedIndex-1)         [重触发闪]
  RightArrow (pickerOpen≠null && !autoOn)  → focusedIndex = min(4, focusedIndex+1)          [重触发闪]
  LeftArrow  (autoOn)                      → no-op（档位 disabled，不可聚焦）
  RightArrow (autoOn)                      → no-op
  Tab        (pickerOpen≠null)             → autoOn = !autoOn    （Tab 与 Space 同效）
  Space      (pickerOpen≠null)             → autoOn = !autoOn    （Tab 与 Space 同效）
  Enter      (pickerOpen≠null)             → commit() → pickerOpen=null
  Escape     (pickerOpen≠null)             → cancel() → pickerOpen=null
  可打印字符 (pickerOpen≠null)             → ignore（不吞键：滚回输入框无副作用；不设 hotkey 直选）
  其余 (up/down/ctrl组合/etc)              → ignore（让给既有路由）

commit() 语义（写入 app.tsx 既有 state，全部与现网一致）：
  if (autoOn)        → setThinkingEffort("");  setThinkingEnabled(true)   ← 维持 Auto 开 = effort ""；不开 thinking 则违背"显示即生效"（/effort 语义隐式 enabled）
  else               → setThinkingEffort(LEVELS[focusedIndex]); setThinkingEnabled(true)
  // 注：picker 无"仅关思考"通道（Auto off 必须选一个 concrete 档）。纯 off 语义走输入框 `/thinking` 旧路？——
  // 定案：**不提供**。picker 是"把思考开 + 选强度"的面板；关思考仍是 `/thinking` 直接切换（现网行为保留）。
  // 该取舍记入 §8 风险 3。

cancel() 语义：
  → 不写 thinkingEnabled / thinkingEffort（面板是预览，Esc 全放弃）
  → pickerOpen=null
  → 若打开源是 /effort 且用户 Esc：不报"已取消"notice（无噪音）；输入框保持空。
  → 若打开源是 /thinking 且用户 Esc：同上。

无状态变化事件：
  Enter 在 autoOn && focusedIndex 无效时 → 仍 commit（autoOn 分支不读 focusedIndex），合法。
  Esc 重复按 → 第二次时 picker 已 null，落回既有双 Esc 路由（不冲突：picker 分支只在 ≠null 时短路）。
```

**边界**：`pickerOpen` 与既有 rewind picker / ask modal 互斥——本设计在 `useKeyboard` 里**先于** rewind 分支拦截，所以二者不可能同时活跃。渲染槽同理互斥（§5 行账 5）。

---

## §5 与现有 modal 的关系

**不要复刻的（SelectModal 特征）**：

- 圆角边框 `borderColor={pal.running}`（金框）→ 换 `pal.border` 灰框。
- 标题 running 色 + BOLD → 换 `text` BOLD。
- `❯ ` 前缀选中光标 → **不用**（极简：当前档用反白底，不用光标前缀）。
- 键位提示行文案风格（`↑↓ 选择 · Enter 确认 · Esc 收起`）→ 换成本面板的 `←/→ 切档 · Tab/Space 开关 · Enter 生效`。

**借鉴的（chat-view.tsx banner 极简）**：

- `borderStyle="rounded"` + `borderColor={pal.border}`（灰棕，低噪音）。
- `paddingX={1}`、`marginBottom={1}`（与输入框/picker 距既有 chrome 同距）。
- 标题靠左（`titleAlignment="left"` 已是 banner 用过的模式）。

**模块归属：独立 `src/tui/thinking-picker.tsx`，不 inline 到 app.tsx。**

- 理由：与 `rewind-picker.tsx` 同构（picker 独立模块 + 宿主持状态）；纯函数 reducer（`reduceThinkingPickerKey`）可单测（现有 rewind/ask 均此纪律）；渲染组件 + 行账函数同文件 SSOT。
- 文件内容：`THINKING_LEVELS`（复用 `ADJUSTABLE_EFFORT_LEVELS`，不重复定义）、`effortToIndex` / `indexToEffort`（SSOT 映射）、`ThinkingPicker` 渲染组件、`reduceThinkingPickerKey` 纯函数、`thinkingPickerRows()` 行账。
- app.tsx 职责：持有 `pickerOpen / autoOn / focusedIndex` state；`useKeyboard` 顶部短路路由；渲染 `{pickerOpen !== null && <ThinkingPicker .../>}`；`commit/cancel` 写既有 `setThinkingEnabled/setThinkingEffort`。

**行账（5 行，不需 wrapModalLines）**：

```
thinkingPickerRows(cols) 恒返回 5：
  行1 标题行（标题 + auto + [Esc 取消]）
  行2 空行（gap 1）
  行3 档位行（5 档）
  行4 空行（gap 1）
  行5 提示行
```

- 不折行（5 档标签定宽，标题 auto 提示定长，最短 40 列足够）；不产 `wrapModalLines` 物理行预测（模态无折行）。
- 但要**计入 chromeReserveRows**：新增 `pickerRows` 参数（与 `modalRows` 同款 `+1` marginBottom 入账），否则 viewport 高度被挤。这是 app.tsx 必须同步改的唯二点（另一个是 useKeyboard 短路）。

---

## §6 OpenTUI 渲染细节

- **边框**：`<box borderStyle="rounded" borderColor={pal.border} paddingX={1} marginBottom={1}>`，**不用** `─` 单线分隔、不用 top/bottom 半框（border 数组形态无先例，且视觉噪音更大）。`rounded` 是既有测试断言行数的形态（modal/input/banner 同款），风险最低。
- **内边距**：`paddingX={1}`（与 PromptInput/banner 同）；行内对齐：标题行 `justifyContent="space-between"`，档位行 `justifyContent="flex-start"`（左对齐，不居中——居中会让档位跳动，极简左对齐更稳）。
- **列宽预算（≥40 列）**：标题 `思考控制`（4 CJK 宽 8） + `auto` + 圆点 + `[Esc 取消]` + 右侧提示 `←/→ 切档 · Tab/Space 开关 · Enter 生效`（~24 列）——40 列内放得下，不需要折行/截断。
- **5 档不递进色**：全部 `text`（auto 关）/ `dim`（auto 开 disabled）；**只有当前档** `fg={pal.accent} bg={pal.selected} attributes={BOLD}`（反白底 = `selected` token，`TextAttributes.REVERSE` 不可用——见下）。
- **TextAttributes.REVERSE 可用性**：`utils.d.ts` 的 `createTextAttributes` 签名里 `inverse` 位存在，但 `types.d.ts` 暴露的 `TextAttributes` 常量**没有 REVERSE**（只有 NONE/BOLD/DIM/ITALIC/UNDERLINE/BLINK/INVERSE/HIDDEN/STRIKETHROUGH）。**定案：用 `bg={pal.selected}` 反白底，不用 `TextAttributes.INVERSE`**（INVERSE 依赖终端反色渲染，跨终端不稳定；显式 bg 确定）。反白底与 BOLD 并存：`<span fg={pal.accent} bg={pal.selected} attributes={TextAttributes.BOLD}>`。
- **档位可视化：纯文字标签，空格分隔**——`low  medium  high  xhigh  max`（2 空格定宽分隔）。**不用** `[low] [medium] …` 方括号（方括号是代码/状态符号约定，档位是值）、**不用** `|` 竖线分隔（竖线是"分隔符"不是"可选值"）。档位间 2 空格 = 最少的装饰性间隔，符合极简。
- **标题 `[思考控制]` vs `── 思考控制 ──`**：定案**`思考控制`（无括号、无线）**。理由：括号 `[思考]` 已是"thinking 折叠行"的既存符号（`message-blocks.tsx THINKING_FOLD_LINE`），面板标题再加 `[思考控制]` 会与消息区折叠行视觉混淆；`── ──` 是装饰线，极简拒绝。标题 = 无装饰、BOLD、text 色。
- **Auto 圆点**：`auto ●` / `auto ○`（fullwidth 点，2 列对齐，`●` U+25CF / `○` U+25CB——窄终端也稳定）。`running` 金当"开"，`text` 白当"关"。**5 档 disabled 时圆点自动为 ●**（autoOn 即 ●），与 §1 变体 c 一致。
- **面板定位**：`render` 在 app.tsx 渲染树的 `ModalHost` 之上、notice 之下（先于输入框的位置，即"输入框正上方"）。用 `<box flexDirection="column">` 按渲染序自然上浮。
- **禁用态档位行**：autoOn=true 时整行 `<text fg={pal.dim} attributes={DIM}>`，无 BOLD、无 bg。

---

## §7 测试矩阵（≥8，设计为纯函数 + 渲染断言，均可直接落 test）

**reducer 单测（`reduceThinkingPickerKey`，`tests/tui/thinking-picker.test.tsx`）**：

| #   | picker 状态                        | 键事件                                | 期望输出                                     |
| --- | ---------------------------------- | ------------------------------------- | -------------------------------------------- |
| 1   | autoOn=false, focusedIndex=2(high) | →                                     | move, index=3（xhigh），闪                   |
| 2   | autoOn=false, focusedIndex=4(max)  | →                                     | move, index=4（clamp 顶）                    |
| 3   | autoOn=false, focusedIndex=0(low)  | ←                                     | move, index=0（clamp 底）                    |
| 4   | autoOn=true, focusedIndex=2        | →                                     | ignore（disabled，不可聚焦）                 |
| 5   | autoOn=false, focusedIndex=1       | Tab                                   | toggle, autoOn=true                          |
| 6   | autoOn=false, focusedIndex=1       | Space                                 | toggle, autoOn=true（与 Tab 同效）           |
| 7   | autoOn=true, focusedIndex=1        | Space                                 | toggle, autoOn=false                         |
| 8   | 任意                               | Enter（autoOn=false, focusedIndex=3） | commit, { autoOn:false, level:xhigh }        |
| 9   | 任意                               | Enter（autoOn=true）                  | commit, { autoOn:true }（不读 focusedIndex） |
| 10  | 任意                               | Esc                                   | cancel（放弃全部）                           |
| 11  | 任意                               | up / down / ctrl+c                    | ignore（让给既有路由）                       |
| 12  | 任意                               | 可打印字符 'a'                        | ignore（不设 hotkey）                        |

**app 层集成（`tests/tui/thinking-picker.test.tsx` 或扩 `app.test.tsx`）**：

| #   | 操作                                       | 期望                                                                                                                              |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 13  | 输入 `/thinking` Enter                     | 输入框清空；面板出现；标题 `思考控制`；auto 显示当前 `thinkingEnabled`（默认 ○）；档位反白 = 当前 effort 映射（默认 medium 反白） |
| 14  | 面板内 Space + Enter                       | thinkingEnabled=true、thinkingEffort="" 写入（Auto 生效）；面板消失                                                               |
| 15  | 面板内 →→ + Enter                          | thinkingEffort=high（从 medium 右移 2）；thinkingEnabled=true；面板消失                                                           |
| 16  | 面板内 Esc                                 | state 不变（thinkingEnabled/Effort 原值）；面板消失                                                                               |
| 17  | 输入 `/effort` Enter                       | 面板打开（同 /thinking 面板）；初始 focusedIndex = 当前档                                                                         |
| 18  | `/effort` 打开后直接 Enter（autoOn=false） | 效果等同 `/effort <当前档>`：写 thinkingEffort=当前档 + thinkingEnabled=true（与现网 notice 语义等价）                            |
| 19  | 打开面板时按 Ctrl+O                        | Ctrl+O 不被吞：折叠态切换仍生效（picker 分支只拦无 ctrl 键）                                                                      |
| 20  | 打开面板时按 Ctrl+C                        | 打断逻辑不因 picker 破坏（ctrl 分支在 picker 前）                                                                                 |

**行账单测（`tests/tui/chrome-budget.test.ts` 增补）**：

| #   | 输入                                    | 期望                            |
| --- | --------------------------------------- | ------------------------------- |
| 21  | thinkingPickerRows(80)                  | 5                               |
| 22  | chromeReserveRows({...}) vs +pickerRows | 差 = 6（5 行 + marginBottom 1） |

---

## §8 风险与权衡（≤5）

1. **无持续视觉反馈，用户不知道"当前档"**：反白只在 50ms 闪一下，之后当前档仅靠 `accent`+`selected` 底色（变体 a/b 中 current 档**常驻反白底**——不是只闪 50ms 就消失，闪是"切换瞬间的强调"，常驻反白是"当前位置"）。若实现者按 §3 只做"闪后消失"，会退回风险 1——**必须在 §2 表里让当前档常驻 `selected` 反白底**（已定案）。
2. **缺少过渡显得突兀**：面板弹出/收起无动画。极简取舍，接受；补偿 = 面板位置固定（输入框正上方）、5 行固定高度，不跳动。
3. **picker 无"关闭思考"通道**：Auto off 必须选 concrete 档（隐含 enabled=true）。需要纯 off 的用例仍走输入框 `/thinking`。若用户期望 picker 也能关思考，属需求缺口——**有意不扩**（拒绝"第二套切换机制"），记入待确认。
4. **Enter 直接提交 = 用户没看面板就改了状态**（`/effort` 直接 Enter 等价旧 `/effort <当前档>`）。风险低：旧语义就是"立即生效"，picker 只是加了预览层；且面板默认反白当前档，Enter 是"确认现状"。
5. **键位抢注风险**：Space 在输入框里是输入字符，但 picker 打开时输入框无焦点（`PromptInput disabled`），全局 useKeyboard 单通道短路——需测试 #20 确认 Ctrl 组合键不被吞（本设计在 Ctrl 分支之后拦截，已规避）。

---

## 一句话总结

本版核心审美特征 = **克制**
