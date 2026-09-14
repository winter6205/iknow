# Spec: todo_write 模型面 mode 说明书

> 下游 plan：`plans/todo-write-mode-copy.md`。
> 操作员实测（2026-09-14）：五条路径走通；两次首跳猜错（`mode: "delete"`、`replace` + 单数 `item`）。
> **Amends** `agent-control-surface.md` Slice C 的**模型可见文案**，不改三件事语义。
> **Amends** `docs/guides/prompt-development.md` 黄金名册 `todo_write` 行（登记缺口，不补轨迹集）。

## ASSUMPTIONS（上一轮方案已裁；不重开）

1. 栈仍 TypeScript + vitest；零新依赖。
2. 不新增 `mode: "delete"`；删除仍是 `mode: "update"` + `delete: true` + `id`（ADR-0085）。
3. `replace` 仍只收 `items` 数组（G2 / ADR-0046 逃生口）；不给 `item` 别名。
4. 不上 `oneOf` / 按 mode 拆 JSON Schema（spawn 面已弃 `oneOf`+`const`）。
5. 不改 `formatAjvError` / executor：非法 `mode` 已列 enum 合法值；delete 怎么写靠 description 与字段 description。
6. 不进 soul / usage / system 前缀。
7. 无工具选型分歧 → 不补 `todo_write` 轨迹集；改 description 走「登记缺口」。
8. D9 正面句仍有效：description 不含 NEGATIVE_PHRASES。

→ 以上视为已确认。

## Objective

让主代理第一次调 `todo_write` 时能从 **tool description + inputSchema 字段 description** 读出四条 mode 各自的字段，尤其是「删行」和「整表替换」不跟 `add` 的 `item` 混。成功 = 硬闸语义不变、说明书不再平铺成「delete 也是 mode」。使用者是主代理；操作员用 D9 / handler 锁验收，不靠再开一轮真模型当完成条件。

## Boundaries

- **Does:**
  - 重写 `todo_write` description：四条 mode 分述；删除写成 `mode=update` 且带 `id` 与 `delete:true`；`add` 写明 `item`（一条）或 `items`（多条）；`replace` 写明 `items` 数组。
  - 给 schema 上 `item` / `items` / `id` / `subject` / `status` / `delete` 加短 `description`（模型读得到的那一层）。
  - D9 STATIC 锁：四 mode 名仍在；`delete` 与 `update` 同句或同段绑定；`replace` 点名 `items`；无 `mode=delete` / 退役 `mode=check` / `mode=list`。
  - 锁 `replace` + `item` 的既有 typed 拒绝文案（handler，非 ajv）。
  - 黄金名册 `tool description` 行登记：`todo_write` 本轮改文案、无轨迹集、理由同 `grep` 缺口（无新分支 / 无选工具分歧）。
- **Confirms with human:** (none)
- **Out of this spec:**
  - 第五个 mode、`replace` 收单数 `item`、JSON Schema `oneOf`。
  - 改 executor / 全局 ajv 文案、soul / usage、状态栏投影、ledger 文件语法、worker `add` 禁令。
  - `npm run test:real-llm` 黄金集。

## Success Criteria

- **SC1（四 mode）**：`TODO_WRITE_MODES` 仍仅为 `read | add | update | replace`。`npx vitest run tests/harness/aci/tools/todo-write.test.ts` 退出 0。
- **SC2（删除不是 mode）**：description 含 `update` 与 `delete:true`（或等价 `delete: true`）且二者可被同一段读出；不含 `mode=delete`。D9 块有断言。
- **SC3（replace 用 items）**：description 在 replace 分述里点名 `items`；`mode: "replace"` + `item` 仍 typed 失败，文案含 `does not accept item`。
- **SC4（schema 地图）**：`inputSchema.properties` 里 `item` / `items` / `delete` 各有非空 `description`；`item` 的说明绑定 `add`，`delete` 的说明绑定 `update`，`items` 的说明覆盖 `add` 与 `replace`。
- **SC5（D9）**：既有 NEGATIVE_PHRASES 闸仍绿；SKIP_CLAUSE 仍在。
- **SC6（名册）**：`docs/guides/prompt-development.md` 名册写明本轮 `todo_write` 登记缺口（无轨迹集 + 理由）。
- **SC7（回归）**：上列 vitest 文件退出 0。不把离线绿当轨迹集绿。

## Open Questions

(none)

## Inherits / Changes

**Quotes（CONTEXT / ADR，不新词）：**

- ADR-0085：主路径三件事（添加 / 按 id 更新含删除 / 读取）；`replace` 是整表逃生口。
- ADR-0046：replace + `items`；快照纪律不变。
- G2：`add` 收 `item` 或 `items`（追加）；`replace` 不是写下计划的主路径。
- `docs/guides/prompt-development.md`：说明书不是闸；硬闸先于软分；无集则补集或登记缺口。

**Inherits：** Slice C 账本语义、D9 正面引导、`formatAjvError` 对 enum 已列合法值。

**Changes：** 仅模型可见说明书与 schema 字段 description + 名册登记。mode 枚举与 per-mode 字段互斥表不扩。

**待写入：** (空)

## architecture-change-reviewer

```
bounded-context-guardian: yes — 只动 ACI todo_write 说明书/schema 与 prompt 名册；不新开 context。
defensive-contract-validator: yes — negative：非法 mode 仍 ajv 拒；replace+item 仍 handler 拒；empty/overflow/concurrent 本轮不改行为、沿用既有套件。
error-handling-enforcer: yes — 不改失败 kind；不吞错；不把 delete 放进 enum 再 handler 拒。
complexity-anti-drift: yes — 文案与字段 description，不拆 mode、不加 oneOf。
minimal-change-verifier: yes — 单一逻辑任务：todo_write 模型面契约可读；不动 executor / soul / ledger IO。
```

**affects:** `src/harness/aci/tools/todo-write.ts` `tests/harness/aci/tools/todo-write.test.ts` `docs/guides/prompt-development.md` `specs/todo-write-mode-copy.md` `plans/todo-write-mode-copy.md` `specs/README.md`
