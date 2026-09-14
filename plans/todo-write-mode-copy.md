# Plan: todo_write 模型面 mode 说明书

**Goal:** 模型从 description + schema 字段 description 读出四条 mode 的字段；删除与 replace 不再被读成第五 mode / 单数 item。
**Approach:** 硬闸与 mode 集合不动。先锁 STATIC 与 handler 拒绝文案（红），再改说明书与字段 description，最后在黄金名册登记缺口。不改 executor、不上 oneOf、不补轨迹集。少于三颗子弹：这是同一把工具的说明书任务，没有第二行为面。
**Spec link:** `specs/todo-write-mode-copy.md`
**ACR:** all-yes（见下方；与 spec 文末同文）
**Tracker:** 本地 markdown
**Worktree:** `.iknow/worktrees/todo-write-mode-copy` on `feat/todo-write-mode-copy`
**Per-ticket loop (all bullets):** tdd → typecheck+tests → code-review → (GATE BLOCKED → review-report-repair) → verification-before-completion（landing grain: operator global commit section）

```
bounded-context-guardian: yes — 只动 ACI todo_write 说明书/schema 与 prompt 名册；不新开 context。
defensive-contract-validator: yes — negative：非法 mode 仍 ajv 拒；replace+item 仍 handler 拒；empty/overflow/concurrent 本轮不改行为、沿用既有套件。
error-handling-enforcer: yes — 不改失败 kind；不吞错；不把 delete 放进 enum 再 handler 拒。
complexity-anti-drift: yes — 文案与字段 description，不拆 mode、不加 oneOf。
minimal-change-verifier: yes — 单一逻辑任务：todo_write 模型面契约可读；不动 executor / soul / ledger IO。
```

**affects:** `src/harness/aci/tools/todo-write.ts` `tests/harness/aci/tools/todo-write.test.ts` `docs/guides/prompt-development.md` `specs/todo-write-mode-copy.md` `plans/todo-write-mode-copy.md` `specs/README.md`

## 待写入

（空）

## Tasks (ordered by dependency)

1. **说明书与 schema 地图（先锁测再改文案）** — tag: `[implementation]`
   - **Inherits:** spec SC1–SC5；ADR-0085 删除是 update；G2 `add` 的 `item`/`items`、`replace` 只收 `items`；D9 无负面禁令；`TODO_WRITE_SKIP_CLAUSE` 仍拼接。prompt-development「先写夹具，再动文案」。
   - **Surface:** harness ACI（`todo_write`）
   - **Acceptance:** D9 断言 description 分述四 mode、删除绑定 `mode=update` + `delete:true`、replace 点名 `items`、无 `mode=delete`；`inputSchema` 上 `item` / `items` / `delete` 各有非空 description 且绑定关系符合 SC4；`replace` + `item` 仍报 `does not accept item`；`TODO_WRITE_MODES` 仍四值。`npx vitest run tests/harness/aci/tools/todo-write.test.ts` 退出 0。
   - Status: [x] done

2. **黄金名册登记缺口** — tag: `[implementation]`
   - **Inherits:** spec SC6；指南「无集的面补集或登记缺口」；与 `grep` 已登记缺口同类（无新分支 / 无选工具分歧，轨迹集成本不抵收益）。
   - **Surface:** `docs/guides/prompt-development.md` 名册
   - **Acceptance:** `tool description` 行写明 `todo_write` 本轮改文案已登记缺口（无轨迹集 + 理由）；不得只记 Not run。
   - Status: [x] done
   - [blocks: T1]

## 收尾

整轮 code review 对照 spec；`npx vitest run tests/harness/aci/tools/todo-write.test.ts`。不跑 `test:real-llm` 当完成条件。不把 soul / executor / `mode: "delete"` 混进本 diff。
