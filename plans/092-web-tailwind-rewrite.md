# 092 — web UI Tailwind 重写实施计划（Variant A「软光 · 圆滑」）

- **来源**：issue #92 讨论结论（comment 5135170423，2026-07-30 wayfinder grilling）
- **基线**：origin/master（含 PR #90 Session API 迁移 + PR #93），worktree 分支 `worktree-092-web-tailwind-rewrite`
- **交付边界（决策 #1）**：组件 + 样式重写；数据管道保留不动
- **设计参照（决策 #2）**：PR #21 throwaway 原型 Variant A（分支 `worktree-web-prototype-variants` @ `5796a73`）

---

## 0. 范围裁决（leader 决策，必读）

#92 决策 #13-16（证据投影 source_spans / governance_status / snapshot_id / hops_used / notes）
与决策 #1（数据管道保留，`api/types.ts` 明列不动）存在**事实矛盾**：

- 后端 wire 真相（`src/session-api/contract.ts:18-22` + `hub.ts:363-369`）：
  `TurnAnswerDto = { finalText, stopReason, turnCount }`，spec 022（SC6/SC8，PR #90 已合并）
  已将 G2 envelope 整体退役，wire 不携带任何证据字段。
- `src/shared/schema.ts` 的 `snapshot_id` 是 KB governance 模块内部 hash payload，**不是** Session API wire 字段。

**裁决**：组件结构**完整实现**证据投影能力（忠实 #13-16 渲染方式，复用 Variant A 原型结构），
通过**可选 props** 接入；但数据管道（`api/types.ts` / `api/client.ts` / `useSessionChat.ts`）
与后端 wire **一律不改**。G2 当前不在 wire，证据 UI 当前不触发（props 传 undefined）——
组件能力预留，未来 G2 重新上 wire 由**单独 ticket** 处理（需翻转 spec 022 Q1，超出本 ticket 范围）。

依据：(a) #1 是顶层交付约束；(b) #19 已立「预留接口不实现」先例（renderBody）；
(c) 渲染须先改后端，超出「组件+样式重写」，且会翻转已合并 spec 022（高风险契约变更，须单独授权）。

---

## 1. 样式方案（决策 #3）：Tailwind v4 + @tailwindcss/vite

- 装包（web workspace，改根 lockfile）：`tailwindcss@^4` + `@tailwindcss/vite@^4`
- `web/vite.config.ts`：`plugins: [react(), tailwindcss()]`
- `web/src/styles/global.css` 顶部：`@import "tailwindcss";`（在字体 @import 之前）
- 设计值进 `tokens.css` 的 `@theme { }` 块（Tailwind v4 CSS-first 配置，无需 tailwind.config/postcss.config）
- 字体（决策 #2）：新增 `@fontsource-variable/outfit`，sans 栈 = `"Outfit Variable", "IBM Plex Sans", system-ui`；mono 保留 IBM Plex Mono
- 退役 forest cockpit 暗色：删 global.css 的噪点 `body::before` + 辉光 `body::after`，换 Variant A 暖米白底

### 1.1 设计 token → Tailwind @theme 映射（SSOT，所有组件共用）

```css
@theme {
  --color-bg: #f6f3ec; /* 暖米白页面底 */
  --color-surface: #fffdf8; /* AgentCard 卡面 */
  --color-user: #eef0e6; /* 用户气泡 */
  --color-ink: #23281f; /* 主文本 */
  --color-ink-2: rgba(35, 40, 31, 0.62); /* 次文本 */
  --color-ink-3: rgba(35, 40, 31, 0.52); /* meta */
  --color-accent: #3e6b52; /* 松绿（唯一强调） */
  --color-accent-soft: rgba(62, 107, 82, 0.12);
  --color-line: rgba(35, 40, 31, 0.09); /* 默认边框 */
  --color-ok: #3e6b52;
  --color-warn: #a3781f;
  --color-danger: #b04a3a;
  --color-warn-soft: rgba(163, 120, 31, 0.12);
  --color-danger-soft: rgba(176, 74, 58, 0.11);

  --radius-card: 20px; /* 气泡/卡片软圆角 */
  --radius-panel: 12px; /* quote/展开面板 */
  --radius-pill: 999px; /* chip/badge */

  --shadow-bubble:
    0 1px 2px rgba(35, 40, 31, 0.04), 0 5px 14px rgba(35, 40, 31, 0.04);
  --shadow-card:
    0 1px 2px rgba(35, 40, 31, 0.05), 0 8px 24px rgba(35, 40, 31, 0.07);
  --shadow-chip: 0 4px 9px rgba(35, 40, 31, 0.09);

  --font-sans: "Outfit Variable", "IBM Plex Sans", system-ui, sans-serif;
  --font-mono:
    "IBM Plex Mono", ui-monospace, "Cascadia Code", Consolas, monospace;

  --ease-soft: cubic-bezier(0.22, 1, 0.36, 1);
}
```

工具类命名（v4 自动生成）：`bg-bg` `bg-surface` `bg-user` `text-ink` `text-ink-2` `text-accent`
`border-line` `rounded-card` `rounded-pill` `shadow-card` `font-mono` 等。

### 1.2 动画（决策 #20）

- 消息入场 stagger：`messageIn 460ms var(--ease-soft) both; animation-delay: calc(var(--i)*70ms)`
  （user `--i = idx*2`，agent `--i = idx*2+1`）
- 证据面板展开：grid-template-rows `0fr→1fr` + opacity，220ms
- chip hover：translateY(-1px) + shadow-chip，160ms；active scale(.97)
- 侧栏展开收起：宽度过渡 220ms var(--ease-soft)
- 发送中 loading 反馈（Composer sending 态）
- 全局 `prefers-reduced-motion` 降级（保留 global.css 现有段）

---

## 2. 组件接口契约（并行化依据，不得擅改签名）

数据管道不动：`useSessionChat()` 返回的 `ChatUiMessage`（user/agent 判别联合）、
`SessionChatApi`、`api/client.ts`、`api/types.ts` **全部保持现签名**。

### 2.1 证据投影类型（新增，组件层，可选）

```ts
// web/src/components/evidence.ts（新文件，纯类型 + 常量，无数据管道依赖）
export type GovernanceStatus = "ok" | "stale" | "conflict";
export interface SourceSpanView {
  chunk_id: string;
  quote?: string;
  doc_id?: string; // KB 内部，仅调试
  source_ref?: string;
}
export interface EvidenceProjection {
  sourceSpans?: SourceSpanView[];
  governanceStatus?: GovernanceStatus;
  snapshotId?: string;
  hopsUsed?: number;
  notes?: string[];
}
export const GOV_LABEL: Record<GovernanceStatus, string> = {
  ok: "已核验",
  stale: "已过期",
  conflict: "存在冲突",
};
export function shortSnap(id: string, n = 8): string; // 去 snap_ 前缀取 n 字符
```

### 2.2 组件 props（重写后）

| 组件             | props                                                                                                                | 决策点                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppShell`       | `{ header; side; main; footer? }`（ReactNode 槽，签名不变）                                                          | #6 左栏+中列，无右面板                                                                                                                           |
| `ChatHeader`     | `{ phase: ChatPhase; healthLabel: string \| null }`                                                                  | #9 只留品牌+连接状态；**删 onReset / onNewSession / session**                                                                                    |
| `StateBlock`     | `{ kind; title; detail?; onRetry?; retryLabel? }`（不变）                                                            | Variant A 化                                                                                                                                     |
| `Composer`       | `{ disabled?; sending?; onSend; placeholder? }`（不变）                                                              | #12 圆角+右发送钮+自动增高(8-10行封顶内滚)+Enter发/Shift+Enter换行，无字数提示                                                                   |
| `UserMessage`    | `{ text; staggerIndex? }`                                                                                            | #11 右对齐气泡，无角色标签                                                                                                                       |
| `AgentCard`      | `{ text; answer?: TurnAnswerDto; evidence?: EvidenceProjection; renderBody?: (t:string)=>ReactNode; staggerIndex? }` | #11 全宽卡片；#13-16 证据结构（可选）；#15 snapshot+hops 底部 mono；#19 renderBody 预留（默认纯文本）；#17 不渲染 tool_calls；#18 无 JSON toggle |
| `MessageList`    | `{ messages: ChatUiMessage[]; emptyHint? }`（不变）                                                                  | #11 按 Turn 渲染 UserMessage/AgentCard；#20 stagger                                                                                              |
| `SessionSidebar` | `{ currentConversationId; onSelect; collapsed: boolean; onToggleCollapsed: () => void; onNewSession: () => void }`   | #7 常驻+可收起+窄屏自动收；#8 顶部新会话钮+列表（保留 #90 排序/摘要/高亮/刷新）                                                                  |
| `ErrorBoundary`  | class 组件不变                                                                                                       | StateBlock 化                                                                                                                                    |

> `MessageBubble.tsx` 退役，拆为 `UserMessage.tsx` + `AgentCard.tsx`。
> 侧栏收起状态（collapsed）由 `App.tsx` 持有并下发；窄屏自动收起用 CSS media query + matchMedia。

---

## 3. 实施分层（按编译耦合，下游依赖上游产物）

```
Stage 1 [串行·地基]  Tailwind 接入（增量，不破坏旧 UI）+ @theme tokens + 字体 + evidence.ts 类型
                     文件: web/package.json, 根 package-lock.json, web/vite.config.ts,
                           web/src/styles/{global,tokens}.css, web/src/components/evidence.ts
                     增量策略: tokens.css 保留旧 :root 变量（forest cockpit legacy，标注 Stage 3 删）
                              + 追加 @theme 块；global.css 仅加 @import "tailwindcss" + outfit 字体，
                              不动 body 背景/噪点/辉光。→ commit 2 时旧 UI 仍完整（shippable）
                     产出: 可用 token 工具类 + 类型契约  ← 所有组件依赖
        ↓
Stage 2 [并行·组件]  4 个 agent，各自独立文件，无共享写冲突（不装包、不改 App.tsx）
        ├─ A: Composer.tsx + StateBlock.tsx（叶子）
        ├─ B: UserMessage.tsx + AgentCard.tsx(+EvidencePanel) + MessageList.tsx（Turn 结构 + 证据投影）
        ├─ C: SessionSidebar.tsx（自取数，最复杂）
        └─ D: ChatHeader.tsx + AppShell.tsx + ErrorBoundary.tsx
        ↓
Stage 3 [串行·组装]  App.tsx 重写（持 useSessionChat + collapsed 态，删 reset #10）
                     + 删旧 .module.css（7 个）+ 删 MessageBubble.tsx
                     + tokens.css 删旧 :root 变量 + global.css 切亮色底/删噪点辉光 + 集成联调
        ↓
Stage 4 [验证]       web:typecheck → web:build → npm test → .evals/run.sh
```

**并行安全**：Stage 2 各 agent 只写自己的 `.tsx`（+ 删自己的 `.module.css`），
token 命名由 Stage 1 锁定，接口签名由 §2 锁定。`App.tsx` 只在 Stage 3 写。
npm install 只在 Stage 1 跑（避免 lockfile 竞争）。

---

## 4. spec 翻转记录（实现前待办，决策 #5）

- **主落点**：`docs/design/frontend-stack-upgrade-v1.md` 增「Decision Flip (issue #92)」段，
  翻转 §3 Style 行(L47) / Not chosen(L56) / §6 forest cockpit 整节(L152-167) /
  §8 Non-goals Tailwind(L199) / §9 Light theme(L216)。
- **辅落点**：`docs/adr/0002-web-ui-variant-a-tailwind.md`（三条判据全满足：
  难逆转 + 无上下文会困惑 + 真实权衡）。记录 #92 结论 + Why not 保持 forest cockpit +
  Tailwind dev 依赖的 A8 精神评估 + 范围裁决（§0）+ G2 wire 矛盾。
- UI 栈仍为 Vite（方案 B 路线，不采 Next.js 方案 A）。

---

## 5. 验证矩阵（A10 精神，不引入前端测试框架）

| 命令                    | 验证                                                  |
| ----------------------- | ----------------------------------------------------- |
| `npm run web:typecheck` | tsc --noEmit 严格模式通过                             |
| `npm run web:build`     | tsc + vite build 产物成功                             |
| `npm test`              | vitest 根套件不回归                                   |
| `bash .evals/run.sh`    | fast tier 烟雾回归                                    |
| dev server 肉眼冒烟     | 发消息 / 刷新恢复 / 新建会话 / 切换历史（A10 四场景） |

**不破坏功能清单**：发消息、刷新恢复（localStorage `iknow:conversation_id`）、
新建会话、切换历史、侧栏排序/摘要/高亮/刷新、404 丢弃重建、失败保留草稿。

---

## 6. Commit 计划（1 commit = 1 task，Conventional Commits）

1. `docs(092): spec 翻转记录 — forest cockpit→Variant A, CSS Modules→Tailwind (ADR-0002 + v1 doc)`
2. `feat(web): Tailwind v4 地基 + Variant A 设计 token`（含根 lockfile）
3. `feat(web): 重写聊天组件为 Variant A Turn 结构（UserMessage/AgentCard/MessageList/Composer/StateBlock/Header）`
4. `feat(web): 重写 SessionSidebar + AppShell 组装 + 退役旧样式`

push：用户已授权。分支 `worktree-092-web-tailwind-rewrite`。
