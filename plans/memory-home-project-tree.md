# Plan: 项目记忆落 home 项目树

**Goal:** 项目记忆库与会话文件夹、`tasks/` 共用同一 `projects/<slug>/` 归类，叶子为 `memory/`。
**Approach:** 路径公式对齐 `resolveTasksDir`；三入口把已解析的 `memoryDir` 注入 `buildHarnessEngine`；缺省池根仍是 `<userHome>/.iknow`。不自动迁移工作区存量。
**Spec link:** ADR-0088（home 项目树）+ 本计划 ACR；落盘 ADR-0099。
**ACR:** all-yes

```
bounded-context-guardian: yes — 公式在 harness/memory + shared 目录名/slug；harness 不 import session-api
input-contract-tests: yes — empty / relative / overflow(>255) / typed SessionRootError；纯函数 concurrent N/A
error-handling-enforcer: yes — 缺根/相对 fail-closed SessionRootError，不静默回退 cwd
complexity-anti-drift: yes — 与 resolveTasksDir 同形 join；装配抽出 select helper
minimal-change-verifier: yes — 只改项目记忆落点；不改 user-level AGENTS、不改 settings 写回、不做存量搬运
```

**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion

## 待写入

- CONTEXT：`home 项目树` 增 `memory/`；`workspaceRoot` 不再列 memory
- ADR-0099 + 0019/0088/0037/0009/0087/0025 amendment

## Tasks (ordered by dependency)

1. **合同：项目记忆跟会话项目树** — tag: `[decision]`
   - **Inherits:** home 项目树 slug = `projectIdentityRoot`；池根 = 显式 `--data-dir` 否则 `~/.iknow`；throwaway `--workspace-root` 不再隔离项目记忆；工作区 `.iknow/memory/<slug>` 存量不自动迁
   - **Surface:** docs/adr, docs/CONTEXT.md
   - **Acceptance:** ADR-0099 accepted；home 项目树词条含同级 `memory/`
   - Status: [ ] pending

2. **resolveProjectMemoryDir 落 `<pool>/projects/<slug>/memory`** — tag: `[implementation]`
   - **Inherits:** T1；fail-closed 同 `resolveTasksDir`
   - **Surface:** harness/memory, shared
   - **Acceptance:** 跨函数等式 `join(resolveProjectSessionDir(pool, root), "memory")`；换 workspaceRoot 不改路径
   - [blocks: T1]

3. **三入口与 build-engine 接线** — tag: `[implementation]`
   - **Inherits:** host 注入优先；缺席回退 `<userHome>/.iknow`
   - **Surface:** build-engine, cli, tui/deps, session-api hub
   - **Acceptance:** 装配层缺省路径钉在 userHome 池根；host 注入优先；换 workspaceRoot 不换 memoryDir
   - [blocks: T2]
