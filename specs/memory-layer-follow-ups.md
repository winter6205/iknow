# Spec: memory-layer-follow-ups（recall 过滤 · type 枚举 · 全局 AGENTS 根）

> 在已合入的自动记忆（ADR-0031 / `specs/auto-memory.md`，默认 OFF）之上，兑现会话已确认的三处缺口。不重开抽取/四态/GC 设计。

## Objective

chat / tui / serve 的记忆层：作废条目不再进入模型检索视野；事实 `type` 为短封闭枚举（手动 `memory_save` 与自动 ingest 同一套）；用户级 `AGENTS.md`（及用户 `rules/`）与 `user.md` 同根于 `~/.iknow/`，对所有项目生效，项目 `AGENTS.md` 叠在其上且项目优先。

成功标准见下；`ask` 记忆层保持全 opt-out（ADR-0010 D3）。

## Boundaries

- **Does:**
  - `memory_recall` 打分前丢弃 `disabled: true` 的条目；自动抽取找邻居已跳过 disabled 的，保持一致、补测钉住。
  - `type` 合法值仅 `convention` | `decision` | `gotcha` | `constraint` | `note`。枚举只在**写路径**收口：`memory_save` 入参与自动 persist / ingest 的抽取 JSON，非法或空 → `note`，不因此 fail 整次写入。
  - 读路径不收口（Decision Packet / T2 决定：write-path-only）：手改或既有落盘 frontmatter 里的 `type`（含 `preference` 等历史值）既不被拒绝、也不被改写成 `note`；`sanitizeMemoryFile` 原样带回已存的 `type`，不 fail 会话。与 `tests/harness/memory/schema.test.ts` 里钉住的「leaves the stored frontmatter type untouched (write-path-only scope)」往返用例同一口径。
  - 用户级静态层发现根 = `userHome`（测试缝同 `user.md`）：`~/.iknow/AGENTS.md` 与 `~/.iknow/rules/*.md`。装配顺序不变：user 层 → 项目优先声明 → 项目 `AGENTS.md` / 项目 rules。
- **Confirms with human:** （本契约假设门已确认，无未决项）
- **Out of this spec:** dream/LLM 离线合并；中文 BM25 / n-gram；默认 TTL；硬删 `.md`；跨项目事实库；改 store cap；改 `autoExtract` 默认；改 `user.md` 落点（ADR-0025 已锁）；安装主目录「子项目 ID 总控」。

## Success Criteria

1. 库中同时有 `disabled: true` 与现行条目时，`memory_recall` 的返回文本不含该 disabled 条的 `title`/`body`（vitest）。
2. `memory_save` / 自动 persist 对 `type: "nope"` 或省略 `type` 落盘为 `note`，且退出码/工具结果为成功路径（vitest）。
3. `assembleSystemPrompt`（或 discovery 测）在 `userHome` 放全局 AGENTS、`cwd` 放项目 AGENTS 时，输出含两份正文且含项目优先声明；`workspaceRoot` 下的 `.iknow/AGENTS.md` **不**再被当作用户级层读入（vitest）。
4. `ask` 表面仍不注册 `memory_recall` / `memory_save`（既有测保持绿）。
5. `npx vitest run tests/harness/memory/` EXIT 0。

## Open Questions

(none)

## Inherits / Changes

- Inherits: ADR-0009（双通道、肯定句、项目 > user 声明）、ADR-0010（ask opt-out）、ADR-0025（`user.md` @ `~/.iknow/user.md`）、ADR-0031（自动记忆默认 OFF、软禁不删）、`specs/auto-memory.md`。
- Changes: 用户级 AGENTS/rules 物理根从「装配时常用的 workspaceRoot」收回 `userHome`，与画像同根；`type` 从自由串改为封闭枚举 + `note` 兜底；recall 读侧过滤 `disabled`。
- Test command: `npx vitest run tests/harness/memory/` plus targeted assembly/settings tests named in SC.
- Surfaces: chat / tui / serve only.

## ACR

```
bounded-context-guardian: yes — 改动留在 harness/memory（recall/save/ingest/discovery/assembly）；不新建顶层模块；ask opt-out 不动
defensive-contract-validator: yes — SC 覆盖 empty（无 AGENTS 文件 / 空库）、negative（非法 type → note）、overflow（recall limit 仍封顶）、concurrent（save 与 recall 仍原子文件）、exception（缺文件跳过不抛）
error-handling-enforcer: yes — 非法 type 不 throw；缺全局 AGENTS 视为该层空，不 fail 会话；无空 catch
complexity-anti-drift: yes — 三刀分文件：recall 过滤、type 规范化、discovery userRoot；不把抽取 prompt 塞进 loop-engine
minimal-change-verifier: yes — 一个契约；落地按三 commit（recall / type / user-AGENTS 根）分任务，禁止与 dream 或 BM25 中文切词混提
```

## 待写入

清单已清空。ADR-0009 Decision 1 已写用户层 `~/.iknow/AGENTS.md`——不另开 ADR，只把实现从 workspace 根收回该句；CONTEXT 已落 `user-level AGENTS.md` 与 `memory_type`。
