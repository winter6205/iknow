# Plan: serve workspace 子目录探测 + Sidebar 按工作空间分组 + Picker UX 收紧 + Popover

**Goal:** WebUI 的 workspace picker 支持 WSL 默认 base 根目录下探测子目录; 左侧会话按各自 `workspaceRoot` 归类为可折叠组, 每组内可直接 "+" 创建会话; picker 二级折叠(工作空间名 → 路径), 列表统一去除 `rounded-pill`; **T8** chip 显示当前 active session 的工作空间名, picker 改 popover 不挤消息区。

**Approach:** 在现有 serve-workspace spec 的基础上做增量 — (a) 后端 `GET /workspaces/browse` 子目录探测端点; (b) 后端 `SessionListEntry` 透出 `workspaceRoot`; (c) 前端 picker 内嵌分步下钻浏览器 + 二级折叠; (d) 前端 sidebar 分组 + 自管折叠态 + 组内 "+" 按钮; (e) Picker 触发规则收紧 (仅首次 / 显式); (f) 列表统一去除 `rounded-pill`; **(g) T8** chip 上下文感知 (active 优先) + picker 改 popover (Esc / outside-click / 焦点回 trigger)。**不**改 trust 语义(规则 1:recents 仍落 home)、**不**改 schema(workspaceRoot 已存在)、**不**引入新依赖。

**Spec link:** `specs/serve-workspace.md`(本计划在 §Commands 1-5 之上扩展 §6 folder browse / §7 sidebar grouping / §8 picker tightening / §9 chip awareness + popover, 留待 spec 增补)

**ACR(本计划派发前自评, 由 main agent 推断):**

- bounded-context-guardian: yes — 仅触及 `session-api/store`、`session-api/http`、`session-api/contract` 与 `web/src/api`、`web/src/components`、`web/src/lib` 既有 bounded context, 无新模块越界。
- defensive-contract-validator: yes — browse 端点覆盖 5 类边界(空目录 / 隐藏目录 / 不存在 / 非绝对 / 无权限); `workspaceRoot` 字段 additive(旧 client 不破坏); picker 触发收紧覆盖已绑定 / 未绑定两种态; popover 关闭覆盖 Esc / outside-click / 选中 / 再次点击 chip。
- error-handling-enforcer: yes — browse / bind 失败走 typed `validation` / `internal` kind, 与现有 `WorkspaceRootError` 映射对齐, 无静默 swallow。
- complexity-anti-drift: yes — 新增 1 个 browse 纯函数、1 个分组纯函数、1 个 storage 模块、1 个 popover shell; 既有模块增量小, 无圈复杂度 / 嵌套深化。
- minimal-change-verifier: yes — 无新依赖; `workspaceRoot` 是 additive schema 字段; `SessionListItem` 增 optional 字段不破坏旧 client。

**Per-ticket loop(所有 bullet, 用户 2026-08-20 调整):** tdd → typecheck+tests → verification-before-completion → 一个 commit on the ticket branch。**跳过 in-loop code-review**, 在 T6 落地后跑 arthurpower:code-review **整链集中 review**(覆盖 T1-T6 全量 diff), 后续 bullet 仍按 per-ticket loop 跑(每次跑一次 verification-before-completion, 不再跑集中 review)。

---

## Tasks(ordered by dependency)

### T1 ✅ — 后端 `SessionListEntry` 与 wire DTO 暴露 `workspaceRoot`

- commit `8a82676a`; 3 files (+175/-2); 144/144 vitest pass; 596/596 full-suite pass。

### T2 ✅ — `GET /api/v1/workspaces/browse` 子目录探测端点

- commit `74449e12`; 3 files (+522); 14/14 + 50/50 regression pass; live curl 6/7 happy。

### T3 ✅ — WorkspacePicker 改造 — base 默认 + 内嵌子目录浏览器

- commit `ebc88a40`; 7 files (+380/-3); 27/27 + 271/271 regression pass; Playwright 验证 picker 全流程。

### T4 ✅ — Sidebar 按 workspace 分组 + 自管折叠态

- commit `35110adb`; 6 files (+1042/-13); 287/287 vitest pass; Playwright 验证 3 组 + active 置顶 + 折叠 + localStorage 持久化。
- 已知小债: `web/src/lib/workspace-groups.ts:25` 用了 deprecated `unescape`, 留待最终 review 修。

### T5 — Picker UX 收紧(二级折叠 + 列表样式) — tag: `[implementation]`

- commit `48d66432` ✅; 3 files +280/-68; 23/23 + 293/293 web regression pass; Playwright 4 场景验证。

### T6 — Sidebar 组 "+" 按钮 + 新会话默认路径 — tag: `[implementation]`

- commit `682d8c37` ✅; 4 files +51 net (含新增 sidebar-plus.ts); 8/8 sidebar-plus + 310/310 web regression; Playwright 验证组内 + 按钮 → 新会话落入该 workspace。

### T7a ✅ — 组件提取 (review H1+H2+H3+M4+M5+M6)

- commit `28a3935`; 18 files +2094/-1293; thresholds all green (SessionSidebar 174 / WorkspacePicker() 30 / WorkspaceBrowser() 28 / ChatApp 195 / prop drilling ≤3)。

### T7b ✅ — 类型/dead code/logic 清理 (M1+M2+M3+L1+L3+L5 + Spec Low)

- commit `d9080594`; 15 files +347/-216; tests 314/314 (web) + 4120/4121 (full; 1 pre-existing flake)。

### T8 ✅ — WorkspaceChip 上下文感知 + Picker 改 Popover — tag: `[implementation]`

- commit `<待落>`; ...

---

### T9 — 进站默认新会话 + iknow 默认工作空间 — tag: `[implementation]`

- **Inherits:** 用户 2026-08-20 反馈 "创建新会话的时候会默认在一个就会话里面, 但是状态是卡有点错乱的" / "进去的时候要默认是一个新会话的" / "默认路径这方面你有什么建议吗" → 用户拍板 "放在一个 iknow 默认的会话目录下"; T5 auto-open picker 后续被 auto-bind 干掉 (dead code, 一并删)。
- **Surface (T9a — backend):**
  - 新 `src/session-api/default-workspace.ts`: 纯常量 `DEFAULT_SESSION_WORKSPACE = join(homedir(), ".iknow", "default")` + `ensureDefaultWorkspace()` eager mkdir helper (sync, recursive, no-op if exists)。
  - 改 `src/session-api/serve.ts`: 在 hub 构造后, 如果 `workspaceRoot === undefined`, 调 `ensureDefaultWorkspace()` + `hub.bindWorkspace(DEFAULT_SESSION_WORKSPACE, { confirmTrust: true })`。显式 `--workspace-root` / `IKNOW_WORKSPACE_ROOT` 仍走原 path (用户偏好优先)。
- **Surface (T9b — frontend):**
  - 改 `web/src/hooks/useSessionChat.ts`: 删 `STORAGE_KEY` / `readStoredSessionId` / `writeStoredSessionId` 三件套; `bootstrap()` 简化为 health → `createAndAdopt`; 删 404 fallback 路径; `adoptSession` 仍保留 (sidebar 切旧会话用)。
  - 删 `web/src/hooks/use-workspace-actions.ts` 内的 `autoOpenedRef` + 一次性 `useEffect` (T5 dead code, auto-bind 后 ws.bound 永远 truthy)。
- **Acceptance (yes/no):**
  1. **进站行为**: `iknow serve` (无 flag/env) → 浏览器打开 → 立刻是空新会话 (chip 显示 "default"); 不读 `localStorage`; 不显示历史消息。
  2. **新会话 workspaceRoot**: SessionFileV1 `workspaceRoot === "/home/<user>/.iknow/default"` (绝对路径)。
  3. **目录存在**: 第一次 serve 后 `~/.iknow/default/` 已 mkdir, 可 `ls` 看见。
  4. **recents 写入**: `~/.iknow/workspaces.json` 的 `recents` 列表包含 `~/.iknow/default`。
  5. **显式 flag 优先**: `iknow serve --workspace-root /some/path` → 新会话 `workspaceRoot === "/some/path"`, 不是 default。
  6. **chat / tui / ask 不动**: 只动 serve 入口; chat/tui/ask 继续走 cwd 默认。
  7. **postMessage 不再报 "unbound"**: 因 auto-bind 已就位, 没业务中断。
  8. **既有 vitest 全绿**: web 314+/314+; typecheck 双绿; full suite 通过。
  9. **不引入新依赖 / 不引入新 hex / spacing**。
  10. **零 div onClick / span onClick** (a11y 红线 — 无 UI 改动, 不回归)。
  11. **不修改 `localStorage` 任何 key** (frontend 干净)。

- **Validation:**
  - vitest backend: 新 `tests/session-api/default-workspace.test.ts` 验证 (a) 常量解析到绝对路径 (b) `ensureDefaultWorkspace` 幂等 mkdir (c) serve.ts 在 workspaceRoot 缺席时调 bindWorkspace(default) (d) 显式 flag 优先 (用 mock bindWorkspace 验证调用顺序)。
  - vitest web: 现有 `use-session-chat.test.tsx` 补 (a) mount 不读 localStorage 断言 (mock localStorage.getItem 验证未调用) (b) bootstrap 路径直接 createAndAdopt (c) 404 fallback 已删除。
  - Playwright: (a) 清空浏览器 localStorage → 开 serve → 立刻新空会话 (b) chip 显示 "default" (c) 关浏览器重开 → 仍新空会话 (localStorage 不再 restore)。

- **out-of-scope (T9)**:
  - 自定义 default 路径 (settings.json 注入) — 当前固定 `~/.iknow/default`, 用户未要求。
  - chat/tui/ask 入口的 default 行为 — 保持 cwd, 用户没要。
  - localStorage 清除迁移提示 — 旧 key 自然过期, 不主动清。

## Out of scope

- git worktree 隔离、多根可写、云端 clone(spec §Architectural Constraints "v1 不做")
- trust 名单 / recents 写回策略(spec §Tech Stack 已落 `~/.iknow/workspaces.json`, 本计划不重写)
- WSL ↔ Windows 路径互转(`\\wsl$\Ubuntu\home\winner\...` ↔ `/home/winner/...`) — picker 仅识别"在 WSL 下默认填 `/home/winner`", 不做双向翻译
- 已有 `SessionSidebar` 的折叠态(整个侧栏收 / 展)与本次工作空间组折叠态互不干扰
- 已有 `SessionListView`(T4 已删除)不复活; 分组是唯一模式
- custom workspace name 字段(目前只用 `basename(root)` 派生名; 用户未要求)

---

## Commit chain 现状(主分支基线 `857f9fbc`)

```
8a82676a  T1   expose workspaceRoot on session list
74449e12  T2   GET /workspaces/browse endpoint
ebc88a40  T3   Picker base + subdir browser
35110adb  T4   Sidebar group-by-workspace + collapse
48d66432  T5   Picker tighten + list style
682d8c37  T6   Sidebar +button + new-session default path
28a39353  T7a  组件提取 (review H/M/L 集中 fix 第 1 步)
d9080594  T7b  类型/dead code/logic 清理 (review H/M/L 集中 fix 第 2 步)
<T8 待落>      WorkspaceChip 上下文感知 + Picker 改 Popover
```
