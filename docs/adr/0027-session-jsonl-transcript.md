# 0027. 会话权威历史改为单文件 JSONL

Date: 2026-08-22
Status: accepted

Context: 第一轮把会话做成整份 JSON + tmp/rename，并写明「本期不迁 JSONL」（声称的 ADR-0007 未落文件）。那是可落地的脚手架，不是与 Claude Code 分叉。后续 grilling 要把崩溃续跑和 rewind 留分支做上，线性 `messages[]` 做不到 fork。

Decision: 会话权威历史是带 id/parent 的单文件 append-only JSONL；进程内工作副本跟落盘的 rewind head。trace JSONL 仍只做观测。旧 SessionFileV1 可 load，下一次 save 迁走。不把续跑状态塞进 `CheckpointRecord`。

Why: Claude Code 用 JSONL 流水账才能边写边留分支；整文件覆盖加截断 rewind 会丢掉半截 turn 和退回去的历史。任何入口读同一份盘的约束仍成立，只换文件形态。

## Consequences

- 2026-08-22：save 双写 `<id>.jsonl` 权威 + `<id>.json` 兼容镜像；load 按扩展名优先 JSONL。这是 expand 阶段的临时形态。
- 2026-08-23：save 删 `.json` 写镜像。load 仍保留 `.json` fallback（迁移窗口）。list / delete 双 shape 路径保留到一次性迁移脚本把 legacy-only `.json` 跑 load+save 后再下刀。
- 758 个 legacy-only `<id>.json` 仍依赖 fallback 才可见；本票删写镜像**不会丢数据**（首次 save 即迁移），但读 fallback 不能同步删 —— 必须等迁移脚本先收尾。
- 测试面：删除了 `jsonl.test.ts` 的镜像断言、`jsonl-migration.test.ts` 的 dual-write 块、`rewind.test.ts` 的 mirror-reflects 测；直读 `.json` 的测试迁去读 `<id>.jsonl` 头记录或 `store.load()`。
- 2026-09-08（ADR-0071）：transcript **位置**从 `<baseDir>/sessions/<basename(cwd)>-<sha1(cwd)[:12]>/` 移入**会话文件夹** `<baseDir>/projects/<项目 slug>/<conversationId>/`，分组键从 `cwd` 换成 **`projectIdentityRoot`**（跨 session worktree rebind 不变）——原键名不副实：`resolveProjectSessionDir` 自称 "Project namespace" 而实际按 cwd 分组，导致同一项目的会话被 worktree 劈成 N 个平级目录（实测 127 个目录里 5 个属同一项目的不同 worktree）。**记录形状一字不改**：仍是带 `id`/`parent` 的 append-only JSONL + rewind head 投影，`<id>.json` 兼容镜像照旧缺席。同目录新增兄弟 `todos.md` / `trace.jsonl` / `blobs/` / `subagents/`（见 ADR-0071）。
- 2026-09-08（ADR-0071 Decision 7）：本 ADR 上面那条「758 个 legacy-only `<id>.json` 仍依赖 fallback 才可见 …… 必须等迁移脚本先收尾」的 follow-up 就此终结**——ADR-0071 明确**不做旧存量兼容**，758 个 legacy-only `.json` 与 127 个旧会话目录一并弃用（`--resume` 对旧会话失效、TUI 会话列表清空，操作员已授权）。因此 `.json` 读 fallback **可以退役**，不再需要先写一次性迁移脚本。仓库根 337MB 旧 `trace/` 归档至 `~/.iknow/archive/trace-legacy/`（不进仓库 `archive/`：实测该目录未被 gitignore）。
