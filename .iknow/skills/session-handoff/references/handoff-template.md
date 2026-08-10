# Handoff Template

> 交接文件 = **轻量指针**，不是第二份 CONTEXT / plan / ticket。
> 凡已固化在 spec / plan / ADR / issue / commit / CONTEXT.md / map / ticket 的内容，**只写路径引用，不 inline 复制**。
> 目标：新 agent 8 分钟内能接手；全文控制在 300 行内，超了就往回推到引用工件。
> 复制本骨架，删掉所有 `<...>` 占位与提示行后写入 `docs/handoff/YYYY-MM-DD-<slug>.md`。

---

# Session Handoff — <任务名> (<YYYY-MM-DD>)

## 当前 live 状态

- **任务**: <一句话目标>
- **为什么重要**: <业务或技术理由，1-2 句>
- **operator 显式指令**: <用户本 session 的原话要求；无则删本行>

## 已固化工件（引用，不复制 inline）

| 类型         | 路径 / URL                               |
| ------------ | ---------------------------------------- |
| 领域词汇     | `docs/CONTEXT.md`                        |
| 决策记录     | `docs/adr/NNNN-slug.md`                  |
| 计划         | `plans/<feature>.md`                     |
| map / ticket | `docs/handoff/wayfinder-tickets/<id>.md` |
| issue / 外部 | <原始 URL>                               |

> 只列**本任务相关**的工件路径。wayfinder / domain-modeling 会自己读 CONTEXT、map、ticket、plan —— 这里给指针即可，不要抄内容。

## 本 session 变更

| 变更（文件路径） | 一行效果 |
| ---------------- | -------- |
| `<path>`         | <效果>   |

> 已 commit 的写 commit SHA；未 commit 的注明「工作树，未 commit」。

## 已验证状态

```
<跑过的命令>
=> <exit code / output marker>
```

> 至少一条命令或测试结果 + exit marker。没跑过的不要写进来。

## Open blockers + next steps

**[NEXT] <下个 agent 的第一个具体动作>** — 必须 concrete、一个 session 内可执行。

- <其余 next step，每条是具体动作不是模糊意图>

> 全文**恰好一个** `[NEXT]`。

## Suggested skills（下个 agent 建议 invoke）

- `<skill-name>` — <为什么>

## 脱敏

- 无 API key / token / password / credential 值出现
- 凭据一律用环境变量名（`GITHUB_TOKEN`、`MINIMAX_API_KEY`），不写值
