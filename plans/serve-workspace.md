# Plan: serve/Web 工作空间制度（禁止自动 cwd）

**Goal:** WebUI 未显式选定工作空间不得发 turn；绑定后三锚合一；CLI chat/tui/ask 的 cwd 默认不变。
**Architecture:** serve 表面 default = unbound（ADR-0023 例外 ADR-0019 D1.1）。Hub 按 `workspaceRoot` 缓存 `BuiltEngine`；session 文件加性字段绑根；SPA picker + recents/trust 在 home。换根只开新会话。
**Tech Stack:** 既有 session-api + vitest + React SPA；无新 npm 依赖。
**Spec link:** `specs/serve-workspace.md`

**Tracker**: GitHub（gh 已登录，origin = `winter6205/iknow.git`，main path，非 fallback）。

| Bullet | Issue                                          |
| ------ | ---------------------------------------------- |
| spec   | https://github.com/winter6205/iknow/issues/531 |
| D1     | https://github.com/winter6205/iknow/issues/532 |
| T1     | https://github.com/winter6205/iknow/issues/533 |
| T2     | https://github.com/winter6205/iknow/issues/534 |
| T3     | https://github.com/winter6205/iknow/issues/535 |
| T4     | https://github.com/winter6205/iknow/issues/536 |
| T5     | https://github.com/winter6205/iknow/issues/537 |
| T6     | https://github.com/winter6205/iknow/issues/538 |

**Spec / contracts consumed:**

- ADR-0009 / 0010 / 0015 — memory 层序、assembly 槽、`home` 全局配置锚不位移。
- ADR-0019 — `workspaceRoot` 仍是 per-root 状态锚。
  > Contradicts ADR-0019 D1.1 **仅对 serve**：D1.1 default = `process.cwd()`。长驻 serve 的 cwd ≠ 用户项目根。由 D1 落 ADR-0023 作为表面例外，不改 chat/tui/ask。
- `specs/120-session-persistence.md` — session JSON 加性字段 + sanitize 不回填 cwd。

操作员已同意（2026-08-19）四条，D1 原文锁定：

1. 无 flag/env 的 serve → **必须等 SPA 选择**（禁止 loopback 偷偷用 cwd）。
2. 换根 → **只开新会话**（不 PATCH 旧会话根）。
3. 新绝对路径 → **确认信任**；recents 已信任。
4. v1 = 单根 + recents + 三锚合一；worktree / 多根只读 **推迟**。

---

## Status of ACR cross-check (PASS — hand to writing-plans)

Re-verify 2026-08-19 (pinned ownership + EXIT + 5-class):

```
bounded-context-guardian: yes — recents 钉在 src/config/workspaces-recents.ts（home 配置面）；HTTP/绑定留在 session-api；SPA 只消费 DTO；不从 session-api import tui；harness 仍只收 cwd/workspaceRoot/sandboxRoot 同值
defensive-contract-validator: yes — T1 empty/negative/overflow(>MAX_WORKSPACE_ROOT_CHARS)/exception；T2 unbound + concurrent 两根 Map；T3 PUT empty/relative/not_found/overflow/缺 confirmTrust + recents concurrent merge + corrupt JSON exception
error-handling-enforcer: yes — EXIT: unbound → ValidationError field=workspaceRoot HTTP 400 kind=validation；WorkspaceRootError 在 sendError 先于 store not_found 映射 400 kind=validation field=path；recents parse_failed 422 / io_error 500 / concurrent_write 409；schema 非法根 422 schema_invalid；永不 cwd fallback
complexity-anti-drift: yes — 声明结构：resolver 复用既有；hub 增加 Map 查找而非把 serve.ts 变成装配器；SPA picker 独立组件；无「一个函数同时解析根+跑 loop+画 UI」
minimal-change-verifier: yes — 计划按 tracer bullet 1 commit；不改 TUI/chat cwd 默认；不顺手做 worktree
OVERALL: PASS — hand to writing-plans
```

---

## Tasks (ordered by dependency)

1. **D1 ADR-0023 + CONTEXT 术语** — affects: `docs/adr/0023-serve-workspace-explicit.md`, `docs/CONTEXT.md`
   - Tag: `[decision]`
   - Acceptance: 文件存在且含四条锁定裁决；CONTEXT 有 **workspace（serve 主根）** / **unbound**，并写明 serve default ≠ cwd。`test -f docs/adr/0023-serve-workspace-explicit.md`
   - Commit: 1 commit = 本决策落盘（domain-modeling 写主权）
   - Status: [ ] pending

2. **T1 SessionFile 加性 `workspaceRoot`** — affects: `src/session-api/store/schema.ts`, `tests/session-api/` 对应 sanitize 测
   - Tag: `[implementation]`
   - Acceptance: `npx vitest run tests/session-api/` 含：缺字段不填 cwd；非法非绝对路径 schema_invalid 或 sanitize 丢弃为缺席；旧文件 load 不崩
   - [blocks: D1]
   - Status: [ ] pending
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

3. **T2 Hub 按根缓存 engine + unbound 拒消息** — affects: `src/session-api/hub.ts`, `tests/session-api/workspace-bind.test.ts` (new)
   - Tag: `[implementation]`
   - Acceptance: `npx vitest run tests/session-api/workspace-bind.test.ts` exit 0：unbound `postMessage` 400；绑定后注入的 cwd/workspaceRoot/sandboxRoot 三等；两不同根两份 engine，无串根
   - [blocks: T1]
   - Status: [ ] pending
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

4. **T3 HTTP workspace + recents/trust** — affects: `src/session-api/http.ts`, `src/session-api/contract.ts`, recents 模块（`src/session-api/` 或 `src/config/` 下小文件）, `tests/session-api/http.test.ts`
   - Tag: `[implementation]`
   - Acceptance: `npx vitest run tests/session-api/http.test.ts`：`GET /api/v1/workspace` unbound 200 `{ bound:false }`；`PUT` 空/相对/不存在 → 400；信任确认字段缺席 → 400；recents `GET /api/v1/workspaces` 只含已信任根；`createSession` 写入当前绑定根
   - [blocks: T2]
   - Status: [ ] pending
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

5. **T4 serve 入口：无自动 cwd，flag/env 仅预绑** — affects: `src/session-api/serve.ts`, 对应 serve 测
   - Tag: `[implementation]`
   - [parallel]
   - Acceptance: 无 flag/env 启动后 hub unbound（断言不把 `process.cwd()` 传入 `workspaceRoot`）；`--workspace-root <abs>` 启动即 bound。`npx vitest run` 覆盖 serve 装配测 exit 0
   - [blocks: T3]
   - Status: [ ] pending
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

6. **T5 SPA picker + chip + 未绑定禁用发送** — affects: `web/src/App.tsx`, `web/src/api/client.ts`, `web/src/api/types.ts`, picker 组件, `tests/web/workspace-picker.test.ts` (new)
   - Tag: `[implementation]`
   - [parallel]
   - Acceptance: `npx vitest run tests/web/workspace-picker.test.ts`：未绑定 CTA；绑定后 chip 含 basename；slash `/workspace` 打开同一 picker。`npx tsc --noEmit -p web` exit 0
   - [blocks: T3]
   - Status: [ ] pending
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

7. **T6 入口文档（非 CONTEXT）** — affects: `docs/architecture.md`, `CHANGELOG.md`, `specs/README.md`
   - Tag: `[implementation]`
   - Acceptance: `rg -n "unbound|ADR-0023" docs/architecture.md CHANGELOG.md specs/README.md` 三处均命中；architecture 写明 serve ≠ cwd
   - [blocks: T4, T5]
   - Status: [ ] pending
   - **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

---

## Cross-references

- architecture-change-reviewer verdict: 5/5 yes（见上块）
- affected S1-S6: S1 bounded-context, S2 defensive-contract, S3 error-handling, S6 minimal-change
- parallelization surface: T4 ∥ T5 after T3；D1 必须先于一切实现
- eval: `.evals/tasks/510-serve-workspace-plan.yaml`

#### D1. `[decision]` ADR-0023 serve workspace is explicit

- **Affects**: `docs/adr/0023-serve-workspace-explicit.md`, `docs/CONTEXT.md`
- **Acceptance**: ADR + CONTEXT 术语落盘；四条操作员裁决原文进 ADR Decision
- 执行时走 `domain-modeling`（唯一可写 CONTEXT/ADR）

#### T1. `[implementation]` SessionFile 加性 workspaceRoot

- **Affects**: `src/session-api/store/schema.ts` + sanitize 测试
- **Acceptance**: 缺字段 ≠ cwd；`npx vitest run tests/session-api/` 相关测 exit 0
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T2. `[implementation]` Hub Map + unbound 拒消息

- **Affects**: `src/session-api/hub.ts`, `tests/session-api/workspace-bind.test.ts`
- **Acceptance**: 见 Tasks §3
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T3. `[implementation]` HTTP workspace + recents/trust

- **Affects**: `src/session-api/http.ts`, `contract.ts`, recents 小模块, http 测试
- **Acceptance**: 见 Tasks §4
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T4. `[implementation]` serve 无自动 cwd

- **Affects**: `src/session-api/serve.ts`
- **Acceptance**: 见 Tasks §5
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T5. `[implementation]` SPA picker/chip

- **Affects**: `web/src/**` workspace UI + `tests/web/workspace-picker.test.ts`
- **Acceptance**: 见 Tasks §6
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch

#### T6. `[implementation]` architecture + CHANGELOG + specs 索引

- **Affects**: `docs/architecture.md`, `CHANGELOG.md`, `specs/README.md`
- **Acceptance**: 见 Tasks §7
- **Per-ticket loop**: tdd → typecheck+tests → code-review → verification-before-completion → commit on ticket branch
