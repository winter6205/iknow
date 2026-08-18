# Spec: serve/Web 工作空间制度（显式主根，禁止自动 cwd）

> 来源：操作员 2026-08-19 同意的 4 条二元裁决（见 D1）。本 spec 只覆盖 **serve / product SPA**。`iknow chat` / `tui` / `ask` 的 cwd 默认不变（ADR-0019 D1.1 对 CLI 对话面仍成立）。

## Objective

让 WebUI **不再**把 `process.cwd()` 当成项目根。工作空间是一等公民：未选定则禁止发 turn；选定后 `workspaceRoot === cwd === sandboxRoot`；会话创建时绑死该根；换根只开新会话。对齐 IDE/Web agent（Cursor Open Folder、Codex App 显式 Local），而不是 CLI「先 cd 再启动」。

成功 = 无 `--workspace-root` 的 `iknow serve` 上，未 PUT workspace 时 `POST /messages` 失败且磁盘无错写；选定绝对目录后三锚合一；旧 session 缺 `workspaceRoot` 字段打开时进 picker，**禁止**回填 cwd。

## Glossary（CONTEXT.md 将增补，不与 CLI cwd 混名）

- **home**：`~/.iknow` — 全局配置、host-init、**workspaces recents/trust 名单**。
- **workspace（serve 主根）**：用户选定的已存在绝对目录。Web 上唯一项目锚。
- **unbound**：serve hub 尚未绑定主根。此时不得 `buildHarnessEngine` 用进程 cwd，不得 `postMessage`。
- **session↔workspace 绑定**：会话创建时写入 `workspaceRoot`；打开旧会话用文件里的根，不用「当前 picker」。
- **三锚合一**：绑定后 `workspaceRoot === cwd === sandboxRoot`。
- **surface split** / **iknow serve** / **product SPA**：沿用 CONTEXT 既有条目。

_Avoid_: 用 bash 最后一次 `cd` 回写 workspace；serve 缺省 `process.cwd()`；一个会话中途换根不重建。

## Architectural Constraints

- **ADR-0019**：`workspaceRoot` 仍是 per-root 状态锚；`home` 仍是 global。
  > Contradicts ADR-0019 D1.1 **仅对 serve 表面** — D1.1 写 default = `process.cwd()`。Web 长驻进程的 cwd ≠ 用户项目根（`build-engine.ts` 已记录）。本 spec 用 **ADR-0023** 给 serve 加表面例外：default = unbound，不是改 TUI/chat。
- **ADR-0009 / 0010 / 0015**：memory 层序、assembly 槽、settings merge 的 `home` 不位移。三锚合一后 project `AGENTS.md` / skill 扫描跟主根，不再单独读服务器 cwd。
- **#120 / schema**：`workspaceRoot` 为 SessionFile **加性**字段；缺席 = unbound（sanitize 不填 cwd）。
- **v1 不做**：git worktree 隔离、多根可写、云端 clone。附加只读根为 v2。

## Tech Stack

- 无新 npm 依赖。Recents 落 `~/.iknow/workspaces.json`（home）。
- Hub：`Map<workspaceRoot, BuiltEngine>`（同根多会话共享装配）；换 SPA 当前根 = 下次 `createSession` 用新根，不 PATCH 旧会话。
- HTTP：`GET/PUT /api/v1/workspace`、`GET /api/v1/workspaces`；`POST /messages` 在 unbound 或会话根缺失时 400 typed。
- SPA：空态 picker + 顶栏 chip；未绑定 Composer disabled。

## Commands / Success Criteria

```bash
npx vitest run tests/session-api/workspace-bind.test.ts tests/web/workspace-picker.test.ts
```

1. serve 无 flag/env → hub unbound；`POST /messages` → 400，kind 非 silent cwd。
2. `PUT /api/v1/workspace` 相对路径 / 空串 / 不存在路径 → 400，复用 `WorkspaceRootError` 映射。
3. 绑定后 `buildHarnessEngine` 的 cwd、workspaceRoot、sandboxRoot 三值相等。
4. 旧 session 无 `workspaceRoot` → GET 仍 200，但发消息 400 直至用户为该会话开新会话并绑根（不回填 cwd）。
5. `--workspace-root <abs>` / `IKNOW_WORKSPACE_ROOT` → 启动即预绑（显式，非自动 cwd）。
6. chat/tui 无本 spec 行为变化（cwd 默认仍成立）。
