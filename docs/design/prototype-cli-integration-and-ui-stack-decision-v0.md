# Prototype ↔ CLI 接入 + 产品 UI 栈决策 v0

> 状态：**接入已实现**（`iknow-prototype` 消费真实 Session HTTP API）；**UI 栈方向为「提案」，待人工批准**。
> 对齐：`session-http-api-v0.md`（契约真值）、`frontend-stack-upgrade-v1.md`（既有 Vite `web/` 决策）、`docs/handoff/2026-07-21-web-mvp-prototype.md`（本任务来源）。
> 原则：不改 4 tool 协议；不改 Session API v0 契约；G2 信封字段不得在展示层丢弃。

---

## 1. 已落地：原型接入 CLI（替换 mock）

`iknow-prototype` 前端已从离线 mock 切到真实 `iknow serve` 后端，端到端跑通「问答 → G2 信封渲染」。

| 变更 | 位置 |
|------|------|
| Session API 客户端（typed DTO + 错误信封 + 降级） | `src/lib/iknow-api.ts` |
| 非流式聊天 hook（懒建会话、假流式打字机、abort、reset、命令） | `src/hooks/use-iknow-chat.ts` |
| 共享会话上下文（侧栏与聊天同一 live 会话） | `src/components/chat-provider.tsx` |
| G2 机器面板（治理徽标 / snapshot / 工具轨迹 / 引用来源 / hops / notes） | `src/components/answer-meta.tsx` |
| 消息渲染改为消费 `UiMessage`（含错误态与 pending 态） | `src/components/message.tsx` |
| 角色（employee/manager/admin）+ 模式（deterministic/llm）→ Session `/commands` | `src/store/ui-store.ts`、`src/components/sidebar.tsx` |
| 同源代理（`/api/v1/*` → `IKNOW_API_PROXY_TARGET`，默认 `127.0.0.1:8787`） | `next.config.mjs` |
| E2E 对真实 `iknow serve` 冒烟（Playwright 双 webServer） | `playwright.config.ts`、`e2e/chat.spec.ts` |

**协议表面对齐**：Session API v0 为**非流式**，每轮返回完整 G2 `IknowAnswer`。前端一次性拿到完整 `answer`，机器面板立即渲染；仅对 `answer.text` 做 host 侧「假流式」分块显示，**不依赖** SSE。`GET …/events`（501）视为「暂未支持」。

**降级**：空 `text` → 400、未知会话 → 404、后端不可达 → 合成 0 状态，前端分别给出可读提示（见 `degradeMessage`）。发送按钮在输入为空时禁用，避免误发空消息。

**移除**：`ai` / `@ai-sdk/react` / `zod` 依赖及 `serverExternalPackages:["zod"]` 变通（原本仅服务于 mock）；删除 `mock-model.ts`、`api/chat/route.ts`、`weather-card.tsx`。

**设计约束保持**：亮色白底、无 emoji；治理状态新增 3 个受控语义色变量（`--ok`/`--warn`/`--danger`），不引入 Tailwind 全量调色板。

---

## 2. 决策点：产品 UI 栈归一（A / B）

现状是**两套 UI 栈并存**：
- `web/`：Vite 6 + React 19 SPA（`frontend-stack-upgrade-v1.md` 已批准的产品线，`iknow serve` 已托管 `web/dist`）。
- `iknow-prototype/`：Next.js 15 App Router（本原型，观感更完整，已接真实 API）。

长期只应保留一套。

### 方案 A：原型升为产品 UI（Next 静态导出，`iknow serve` 同源托管）

- 关键前提**现已满足**：移除 mock 后，原型是**纯客户端**（只经 `fetch` 调 `/api/v1`），不再依赖 Route Handler / SSR。
- 落地：`next.config` 加 `output: "export"` → 产出静态 `out/`；由 `iknow serve` 同源托管（免 CORS、生产免代理，dev 仍可用 rewrites）。
- 代价：**取代**既有 `web/`（推翻 `frontend-stack-upgrade-v1` 的 Vite 选型）；`serve` 静态根需指向 Next 导出目录；`next/font`、图片等需按 export 约束校准；团队维护 Next 工具链。

### 方案 B：把原型观感迁回 `web/`（Vite 仍为产品线）

- 落地：将本原型的视觉语言（亮色令牌、`AnswerMeta` G2 面板、角色/模式控件、聊天壳）移植进 `web/`；Next 原型降级为**设计参考**。
- 代价：`AnswerMeta` / hook / 客户端需在 Vite 侧重写一遍（约中等工作量）；短期仍是两套代码，直到原型归档。

---

## 3. 建议（提案，待批准）

**建议采用方案 A**，理由：

1. **一致性**：现在跑通并通过 E2E 的正是这套 Next 原型；A 让「已验证的实现」直接成为产品，降低二次移植引入的回归面。
2. **低摩擦静态化**：mock 已移除，原型无 SSR/Route Handler 依赖，`output: "export"` 改动小；`iknow serve` 同源托管天然免 CORS，删去生产代理。
3. **完成度**：原型的编辑化亮色主题 + G2 机器面板比现有 `web/` 更完整、更贴合「可追溯、非 AI 化」的产品语气。

**关键待批分歧（必须人工拍板，勿静默定稿）**：方案 A 与已批准的 `frontend-stack-upgrade-v1.md`（Vite `web/`）**直接冲突**。若团队坚持既有 Vite 决策，则应选 **方案 B**。在批准前，两套栈保持并存，本原型继续以 `iknow-prototype/` 独立目录承载。

### 若批准 A 的迁移清单
- [ ] `next.config`：`output: "export"`；生产去除 `/api/v1` rewrites，客户端走同源相对路径。
- [ ] `iknow serve` 静态根优先级增加 Next 导出目录（保留 `web/dist` 回退直至下线）。
- [ ] 校准 `next/font`、`next/image`（export 约束）与缓存头。
- [ ] `web/`（Vite）标记弃用并排期下线；文档与 CHANGELOG 同步。

### 若批准 B 的迁移清单
- [ ] 在 `web/` 复刻 `AnswerMeta` 与 Session API 客户端（复用 DTO 形状）。
- [ ] 迁移亮色令牌 + 角色/模式控件 + 聊天壳观感。
- [ ] `iknow-prototype/` 归档为设计参考（README 标注）。

---

## 4. 复跑（接入验证）

```bash
# 终端 1：真实后端
npx tsx src/cli.ts serve --port 8787 --mode deterministic

# 终端 2：原型（同源代理到 8787）
cd iknow-prototype
npm install
npm run dev            # 或 npm run build && npm run start
# 指向远端后端：设 NEXT_PUBLIC_IKNOW_API_BASE=http://host:port（客户端直连，跳过代理）

# E2E（自动拉起 serve + next start 两个 webServer）
npm run test:e2e
```

验收（对应 handoff §5.4）：建会话+发消息渲染出 `snapshot_id` 与 `governance_status`；空 text→400 / 未知会话→404 前端降级正确；不依赖 SSE（501=暂不支持）；UI 栈 A/B 有书面决策（本文）；`build` / `test:e2e` / 根 `typecheck` 全绿。
