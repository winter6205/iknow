# Session Handoff — 会话文件夹归并 T1–T7 全落地（T8 实测性能判定待续）(2026-09-09)

## 当前 live 状态

- **任务**: 会话存储从「`~/.iknow/sessions/<slug>/<id>.jsonl` + 仓库根 `trace/` + 根级 todos」归并为单一两级树 `~/.iknow/projects/<slug>/<conversationId>/`（叶子 = 会话文件夹，`todos.md` / `trace.jsonl` / `blobs/` / `subagents/` / `stderr/` 全部锚进叶子），读侧三工具走两级树，blob content 级粒度，旧存量归档。
- **为什么重要**: 之前 trace 锚点在仓库根 `./trace/`（cwd 相对派生，跨 worktree 同会话漂移）、todos 散在 `<surface>` 层、blob 是整条 message 替换（role 丢失 → `last_assistant_preview` 静默消失）。归并后同 `(projectIdentityRoot, conversationId)` 派生出稳定唯一路径，跨 cwd 启动同一会话文件路径一致（SC6 核心不变式）。
- **spec / plan**: `specs/session-folder-consolidation.md`、`plans/session-folder-consolidation.md`（T1–T7 done，T8 待续）。

## 已固化工件（引用，不复制 inline）

| 类型       | 路径                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 现役 spec  | `specs/session-folder-consolidation.md`（SC1–SC20）                                                                                                                |
| 计划       | `plans/session-folder-consolidation.md`                                                                                                                            |
| 决策记录   | `docs/adr/0071-*.md`（session folder consolidation，7 个 Decision）                                                                                                |
| 布局 SSOT  | `src/session-api/store/session-store.ts`（`resolveProjectSessionDir` / `resolveConversationDir` / `resolveConversationTraceFilePath` / `resolveSubagentTraceDir`） |
| 读侧两级树 | `src/traceserver/session-discovery.ts`（`findConversationTraceFile` / `listConversations`，writer SSOT 不 import 的解耦声明在文件头）                              |

## 本 round 变更（T1–T7, 分支 `worktree-session-folder-consolidation`, 基线 master）

| bullet     | 效果                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| T1         | 布局 `<base>/projects/<slug>/<convId>/{<id>.jsonl, todos.md, ...}`，slug 派生 `resolveProjectSessionDir` |
| T2         | todos 迁入会话文件夹，`<surface>` 层退役                                                                 |
| T3         | trace 锚点迁入会话文件夹（`trace.jsonl`），traceDir 派生 SC6/SC7                                         |
| T4         | blob 唯一化 + content 级粒度 + 删故障回退（SC9–SC13）                                                    |
| T5         | 子代理 per-agent trace 布局（`subagents/agent-<taskId>.jsonl`），随机 UUID 退役（SC8 + L2）              |
| T6         | 读侧三工具走两级树 + query_trace 补 content 解引用（SC14–SC17）                                          |
| T7（本轮） | dist/trace-mcp 重建 + 实跑验收 + 归档（SC18/SC19），见下                                                 |

## T7 本轮细节

### SC18 实跑验收（PASS）

- `npm run build` 重建 `dist/trace-mcp`（tsc EXIT 0，产物 `dist/trace-mcp/main.js` / `dist/traceserver/query-trace-core.js` 时间戳更新）。
- **实跑修复**（SC18 实跑暴露的 SC14 残余）: `query_trace` 的 `first/last_message_preview` 与 `last_assistant_preview` 之前对 blob 引用形态（`{role, content:{sha,bytes}}`）直接 `JSON.stringify`，preview 变 `{"sha":...}` 死预览——SC14「preview 为正文且不含 sha 字面量」在 inline 形态单测下不可见，blob 模式实跑露馅。修法: `src/traceserver/query-trace-core.ts` `projectRecord` 先 `dereferenceTraceMessages` 还原 inline 形态再做 preview（含「缺失 blob 不抛进 turn」EXIT 继承: 失败降级 `messages_count=0`、三 preview 字段缺席，与 empty 边界同形）。
- TDD 证据: 新增 2 用例（`tests/traceserver/query-trace-core.test.ts` blob-mode preview deref describe）先红（stash 修复后 2 failed）后绿（25/25）；全量 `npm test` 452 files / vitest 6552 tests（基线 6550, +2）+ bun 1435 全绿。
- 实跑方法: 一次性脚本 `/home/winner/.claude/jobs/39e870e7/tmp/sc18-live-acceptance.mjs`（不进仓库）spawn `dist/trace-mcp/main.js`（stdio JSON-RPC，`IKNOW_TRACE_OUT=~/.iknow`），会话来自盘上真实 harness 落盘的 `~/.iknow/projects/session-folder-consolidation-b40327c5faa7/<convId>/`，trace 锚点经真实写侧 `createJsonlTraceService`（`seed-trace-anchor.mts`，一次性）写入。
- 实跑判定（原始输出关键段，PASS）:
  - `list_sessions`: `{"sessions":[{"conversation_id":"2b493a05-a0cd-4791-a48f-9afbf14ea989","mtime":1788922600104.503,"size":1966}],"limit":50,"offset":0}`
  - `query_trace` llm_call 行: `first_message_preview="{"role":"user","content":"hello world from SC18 acceptance seed"}"`、`last_assistant_preview` 含完整正文且无 `sha` 字面量、`messages_count=2`、echo `limit=100 offset=0`、6 rows
  - `get_record(detail=messages)` inventory: `parts=[{message_index:0,part_index:0,chars:37,role:"user"},{message_index:1,part_index:0,chars:177,role:"assistant"}]`，window 臂读回 177 chars 与 blob 内容逐字节一致
  - 三工具一致 + preview 正文断言 PASS。

### SC19 归档（PASS）

| 项                       | 值                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 迁移前                   | 仓库根 `/home/winner/projects/iknow/trace/`: 81 jsonl + 19 stderr log = 100 文件 / 351,995,337 bytes (337M) |
| 迁移方式                 | `mv`（同盘 rename 原子）→ `~/.iknow/archive/trace-legacy/`                                                  |
| 迁移后                   | 仓库根无 `trace/`；archive 目录 81 jsonl / 100 文件 / 351,995,337 bytes 逐项相等                            |
| repo `archive/`          | 零新增（`find -newer` 无命中）                                                                              |
| 主 checkout `git status` | `?? spikes/`（既有未跟踪，与本轮无关）；trace/ 本就是 gitignore root-anchored 规则，迁移零 git 变化         |
| git 写操作               | 仅在 worktree 分支 commit；主 checkout 零 git 写操作                                                        |

- 计划写的「82 jsonl」与实测 81 差 1（计数时点差异，盘上只有 81 个 `*.jsonl`；迁移后逐项核对 100/337M 全等）。

### L3 影响面（CHANGELOG 已记）

- 旧布局会话（`~/.iknow/sessions/`、`./trace/`、根级 todos）**全部失效**: `--resume` 续跑不了旧会话、TUI 会话列表清空（旧条目不进两级树枚举）、旧 trace 锚点在 `~/.iknow/archive/trace-legacy/`。
- 新会话由新写侧正常落盘；旧数据无自动迁移（归档即终点，恢复 = 手动 mv 回去按旧代码读）。

## 本 session commit

| commit   | 内容                                                                           |
| -------- | ------------------------------------------------------------------------------ |
| （本轮） | fix(traceserver): SC14 blob 模式 preview 解引用 + docs: CHANGELOG L3 + handoff |

## 后续

- **T8**（独立 bullet，未开工）: 实测扫描性能判定——plan `plans/session-folder-consolidation.md` §T8，扫描性能阈值与判定留给 T8。
- **#950 依赖**: session-folder-consolidation 是 #950 的依赖项；归并落地后 #950 的 session 派生面收敛到 `resolveProjectSessionDir` 单点。
- **spec「后续」清单**: `specs/session-folder-consolidation.md` 尾部。
- **CONTEXT.md 词条**: read unit / session folder / 两级树等候选词等整轮收尾走 `domain-modeling`（同 trace-mcp 拆分轮惯例）。
