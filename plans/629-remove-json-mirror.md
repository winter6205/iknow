# Plan: #629 移除 `.json` 兼容双写镜像

**Goal:** `SessionStore.save()` / `persistHeadMove()` 不再写 `<id>.json` 兼容镜像；单文件 JSONL 成为会话历史唯一权威形态。`load()` 仍保留 `.json` fallback 作为迁移窗口（#619 T2 的 758 个 legacy-only session 一次性迁移脚本未跑前不能下刀）。
**Approach:** 只删**写路径**；读 fallback + `list()` dedupe + `delete()` 两条路径全部保留。B1/B2 是核心代码改动，B3-B6 同步注释 / 测试 / 文档，B7 收尾 3 个测试因前置假设失误而失败的修复，B8 跑全量验证，B9 commit + PR。
**Spec link:** `specs/session-jsonl-resume.md`（D7）；`docs/adr/0027-session-jsonl-transcript.md`
**Tracker:** [GitHub #629](https://github.com/winter6205/iknow/issues/629)
**Per-bullet loop:** tdd → typecheck+tests → verification-before-completion → one commit on the ticket branch
**End-of-round code-review:** arthurpower:code-review 整轮改完再跑

## ACR

bounded-context-guardian: yes — 改动只在 `session-api/store` 内部；hub / serve / tui / trace 入口不动
defensive-contract-validator: yes — 删除写镜像后 load fallback 仍覆盖 empty / negative / overflow / concurrent / exception（保留 legacy fixture 用例）
error-handling-enforcer: yes — typed-error 契约不变（`readJsonlLog` 的 `legacyIsWriteFailed` 仍抛 `write_failed`）
complexity-anti-drift: yes — `save()` 缩短 ~5 行（净减）；`persistHeadMove()` 同步缩短
minimal-change-verifier: yes — 1 commit = 1 逻辑任务；依赖变更 = 0；lockfile 不动

## Tasks (ordered by dependency)

1. **删 `save()` 的 `.json` 镜像写** — tag: `[implementation]`
   - **Inherits:** `specs/session-jsonl-resume.md` D7 — load 保留 `.json` fallback；save 不再写
   - **Surface:** `src/session-api/store/session-store.ts` `save()`
   - **Acceptance:** `save()` 体内只调 `writeFile(jsonlTmp, plan.jsonl)` + `rename(jsonlTmp, jsonlPath)` 两个 syscall；`jsonPath / jsonTmp` 两个变量从函数体消失；文件头注释删 `expand-phase compat` / `mirror is KEPT` 措辞，改写为「save 权威 JSONL 形态，load fallback 仅迁移窗口」。
   - Status: [x] done

2. **删 `persistHeadMove()` 的 `.json` 镜像刷新** — tag: `[implementation]`
   - **Inherits:** B1 — 写镜像路径从 `save()` 已撤
   - **Surface:** `src/session-api/store/session-store.ts` `persistHeadMove()`
   - **Acceptance:** `persistHeadMove()` 只写 JSONL 头刷新 + 一条 head 记录；不再有 `jsonPath / jsonTmp` 局部变量；`mirror` 局部变量改为 `projected`（语义：从 JSONL head 投影，不再写盘）。
   - Status: [x] done

3. **同步 src 内嵌注释** — tag: `[implementation]`
   - **Inherits:** B1/B2 — 行为已落，注释同步
   - **Surface:** `src/session-api/hub.ts`（L1823 `appendSessionEvents` 注释）、`src/cli/chat-session.ts`（L824 seedResumeMessages 失败语义、L1147 resume 分支）、`src/cli/slash.ts`（L29 REPL session-pool 文件名）
   - **Acceptance:** 措辞从 `<id>.json` / `T1 save 双写形态` 改为 `<id>.jsonl` / `save 权威 JSONL 形态`。
   - Status: [x] done

4. **改造镜像契约测试** — tag: `[implementation]`
   - **Inherits:** B1/B2 — 写镜像不存在
   - **Surface:** `tests/session-api/store/jsonl.test.ts`、`tests/session-api/store/jsonl-migration.test.ts`、`tests/session-api/store/rewind.test.ts`、`tests/session-api/store/list-exposes-workspace-root.test.ts`
   - **Acceptance:**
     - `jsonl.test.ts`：删 `still writes the legacy <id>.json mirror (expand-phase compat)` 用例；删「`delete()` 写两个文件」断言中的 `await stat(jsonPath)` 与 `await assert.rejects(stat(jsonPath))`；「detects shape by extension」用例改为「手写 divergent legacy `.json`」（不再是「overwrite the legacy mirror」措辞）；「loads from .jsonl alone when the .json mirror is deleted」改名为「save writes only JSONL; load returns from the JSONL authority」并去掉 `rm(jsonPath)` 调用。
     - `jsonl-migration.test.ts`：v5 fixture 用例改名为「mirror NOT written」；删 `readFile(jsonPath(...))` + deepEqual 段；改成 `assert.rejects(stat(jsonPath(...)))`——**前提**是 `writeLegacyJson` 之后 save 之前先 `rm(jsonPath)`（或同等手段），使测试断言「save 不写新 mirror」与原 legacy 残留解耦。
     - `rewind.test.ts`：`mirror reflects the rewound projection` 用例改名为「rewind → load sees the rewound head; legacy `.json` is NOT refreshed」；改为先 `save` + 手工 `writeFile(jsonPath)` 注入 stale `.json`，再 `rewindToAnchor` + `store.load` 验证；「`save` derives anchorEventId」用例的「mirror carries the derived anchor too」断言改为 `assert.rejects(stat(jsonPath))` + 读 JSONL 头记录验证 anchor。
     - `list-exposes-workspace-root.test.ts`：`surfaces workspaceRoot when the file carries it` 用例的注释改写（去掉 `.json mirror` 措辞）；其他用例保留。
   - Status: [x] done

5. **改造直读 `.json` 的测试用例** — tag: `[implementation]`
   - **Inherits:** B1/B2 — `.json` 不再被 save 写
   - **Surface:** `tests/session-api/http.test.ts`、`tests/session-api/cross-entry-consistency.test.ts`、`tests/session-api/hub.test.ts`、`tests/session-api/serve.test.ts`、`tests/tui/tui-cross-entry.test.ts`、`tests/cli/chat-session-resume.test.ts`（注释同步）
   - **Acceptance:**
     - `http.test.ts` L1001：「createSession writes the bound root」由直读 `<id>.json` 改为读 `<id>.jsonl` 头记录。
     - `cross-entry-consistency.test.ts` L88-94：`readDisk` helper 改读 `<id>.jsonl`，用 `parseSessionJsonl` 还原 header + messages（让 `diskAfterA["messages"]` 长度断言继续成立）。
     - `hub.test.ts` L165-179「writes v2 metadata to disk」由直读 `.json` 改用 `store.load(session.conversation_id)` 验证；L854-870「recomputes title」改为先 `writeFile(<id>.jsonl, ...)` 注入脏 title（手改 header 行），再 postMessage + `store.load` 验证。
     - `serve.test.ts` L221-233「readSessionWorkspaceRoot」helper 改读 `<id>.jsonl` 头记录。
     - `tui-cross-entry.test.ts` L70-83 改为读 `<id>.jsonl` 头记录。
     - `chat-session-resume.test.ts` 头注 + L366 + L430 注释措辞同步为 `<id>.jsonl`。
   - Status: [x] done

6. **同步 spec / ADR / plan / CHANGELOG** — tag: `[implementation]`
   - **Inherits:** B1/B2 — 行为已落
   - **Surface:** `plans/session-jsonl-resume.md`、`specs/session-jsonl-resume.md`、`docs/adr/0027-session-jsonl-transcript.md`、`CHANGELOG.md`
   - **Acceptance:**
     - `plans/session-jsonl-resume.md` L31 改写「.json 镜像保留，移除见 #629」→「镜像已删除（#629 落）」；L61 follow-up 行改为「~~#629~~ 已落；#629.1 follow-up: 删 load fallback 待 758 个 legacy-only 一次性迁移后再下刀」。
     - `specs/session-jsonl-resume.md` D7 加一句「Save 不再写 `.json` 兼容镜像（#629 已落）」。
     - `docs/adr/0027-session-jsonl-transcript.md` 末尾补 §Consequences 段，记录「2026-08-23 #629 删写镜像；load fallback 仍保留待迁移脚本收尾」。
     - `CHANGELOG.md` 新增 `### Chore` 段，记录本次变更。
   - Status: [x] done

7. **修复 B4 留下的 3 个失败测试** — tag: `[implementation]`
   - **Inherits:** B4 — 镜像契约改造已部分落，但 3 处用例因「save 后 `.json` 一定不存在」假设失误而失败
   - **Surface:** `tests/session-api/store/jsonl-migration.test.ts`、`tests/session-api/store/jsonl.test.ts`、`tests/session-api/store/list-exposes-workspace-root.test.ts`
   - **Acceptance:**
     - `jsonl-migration.test.ts` v5 fixture（L115-167）：在 `writeLegacyJson("t2-v5", legacy)` 之后 `await store.save(...)` 之前，先 `await rm(jsonPath("t2-v5"))`（移除前置 legacy），再断言「save 不写新 mirror」：`assert.rejects(stat(jsonPath("t2-v5")))`。reload 走 JSONL 仍 deep-equal。
     - `jsonl.test.ts` 「save writes only JSONL」（L492）：删除 `await rm(jsonPath("jl-no-mirror"))` 行（save 本来就不写 `.json`，rm 抛 ENOENT 是预期外的）。
     - `list-exposes-workspace-root.test.ts` 「surfaces workspaceRoot from a legacy-only」（L105-128）：改为 `await writeFile(jsonPath, JSON.stringify(...), "utf8")` 手工写 legacy `.json`（不再依赖 save 写镜像），`await rm(jsonlPath)` 删除 JSONL，再 `store.list()` 验证 legacy load 路径。
   - Status: [x] done

8. **全量验证** — tag: `[implementation]`
   - **Inherits:** B1-B7
   - **Surface:** 项目根
   - **Acceptance:** `npx tsc --noEmit` 0 错误；`npx vitest run tests/session-api/store/ tests/session-api/ tests/tui/ tests/cli/` 全绿（开 loop-engine / traceserver 视变更面定）；按需 `npm run test:changed` 跑 git-tracked 变更相关的窄矩阵。
   - Status: [x] done

9. **commit + 开 PR** — tag: `[implementation]`
   - **Inherits:** B1-B8
   - **Surface:** 当前 worktree branch `worktree-worktree-629-remove-json-mirror`
   - **Acceptance:** 1 commit message = `chore(session-api): 移除 .json 兼容双写镜像`，body 摘 spec D7 / ADR-0027 / #629；按规则**不开 push**（除非用户显式授权），但 `gh pr create --draft --base master` 开 PR。
   - Status: [x] done — commit message `chore(session-api): 移除 .json 兼容双写镜像`；待用户授权 push + gh pr create --draft

## Open / 待写入

无新领域词；无 ADR 需 reopen。
