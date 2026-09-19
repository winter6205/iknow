# Spec: interrupt frozen prefix keep

**Status:** ready for plan  
**Surface:** `src/shared` (freeze 切刀), `src/harness` (in-flight closeout), `src/session-api` (persist 对齐), `src/tui` (Markdown 改为调用方；settle 仍画 store)

## Goal

Esc **前台打断** 时，实时生成里已经钉住的完整块留在权威历史与墙上；只丢掉还在长的那一块。三面（打断当下 / 重开 / 下一句 prior）同一形状。

## Settled invariants

1. **粒度 = streaming block freeze**（ADR-0108）：`prefixRaw` 进本轮 assistant；`tailRaw` 丢弃。无 prefix → 不落 assistant，cancelled 仍写 **interrupt system message**。
2. **SSOT 在 closeout，不在 TUI overlay。** 累积流式正文必须是 harness/host 在 abort 时能读到的缓冲（与墙上 draft 同源字节）。settle 卸 overlay 之后只画这份历史。
3. **切刀模块**落在 harness 已能 import 的层（`src/shared` 缝）。TUI 只调用。禁止 `src/harness` import `src/tui`。
4. **工具在途**不改：已 append 的 assistant 留下；在途 tool → `execution_failed` `"cancelled"`。已闭合 `tool_use`、尚未执行 → 既有 cancelled 回填。
5. **timeout** 同一把 keep 刀；不加 `Interrupted by user.`。
6. **`/continue`** 仍只从本次 prior 去掉末尾 interrupt；freeze 前缀留在盘上与 prior。
7. **顺序：** split →（有 prefix 则 append assistant 并 commit）→ cancelled 则 append interrupt 并 commit。assistant commit 失败则走既有 **MessageCommitError**，不得只留下 interrupt、假装前缀已进史。
8. 非字符串累积 → 切刀既有 typed 失败（与现行 freeze 入参契约一致），不得空 catch。

## Out of scope

- 改 Esc / Ctrl+C 键位
- 流过的 token 全留（未选的粒度）
- timeout 专用产品文案
- 落定态留/收/点名着色
- iknow-memory / dream / GC
- 改 `transport-continue-persist.md` 的 continue / retry 合同（仅 interrupt keep 与之叠加）

## Input-contract classes (public surfaces)

| Surface                     | empty                                                         | invalid/negative                               | overflow                                                     | concurrent                                                | exception                                                              |
| --------------------------- | ------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| freeze split                | `""` → prefix 空、tail 空、boundary 0                         | 非 string → typed throw，不 keep               | 超长 markdown 仍按同一刀切；不另发明截断上限                 | 与现行 freeze 单测「重入 / 边界只前进」同纪律             | lexer 失败不得空 catch                                                 |
| `run()` cancelled，模型在途 | 无累积或无 prefix → messages = user + interrupt，无 assistant | 切刀 typed throw → 不得写成成功 cancelled 假史 | 有 prefix 则整段 prefix 进 assistant（体积跟既有消息上限走） | abort 已发生时不再等完整 model step；不双写两份 assistant | `commitMessages` 抛 → **MessageCommitError**；不 append 孤儿 interrupt |
| `run()` timeout，模型在途   | 同 keep 刀；无 interrupt 句                                   | 同左                                           | 同左                                                         | 钟 abort 不得标成 user cancel（既有 ADR-0091）            | 同 commit 失败                                                         |
| persist / load              | 无 prefix 的 cancelled 盘面 = user + interrupt                | 不把失败半截 assistant 当 protocolError keep   | N/A                                                          | N/A                                                       | save 失败按既有 commit 失败冒泡                                        |
| TUI settle                  | overlay 空、store 有 prefix → 墙画 store                      | 不得用 overlay 残稿覆盖 store                  | N/A                                                          | `finally` 卸 draft 早于 `turnFinished` 换快照：以快照为准 | N/A                                                                    |

## Success criteria

- SC1: 模型在途、累积正文能切出非空 `prefixRaw` 时，cancelled 后 `result.messages` 含该 prefix 的 assistant，随后 `Interrupted by user.`。
- SC2: 仅 `tailRaw`（无 prefix）时 cancelled 后无本轮 assistant，仍有 user + interrupt。
- SC3: 重开/load 与 SC1/SC2 同形状。
- SC4: 普通下一句 prior 含 freeze 前缀与 interrupt；`/continue` 本次 prior 可去掉末尾 interrupt、前缀仍在。
- SC5: timeout 模型在途 keep 同 SC1/SC2 的 prefix 规则，无 interrupt 句。
- SC6: harness 源码无 `from "../tui/`（或等价 tui import）。
- SC7: 工具在途 cancelled 既有四条消息形状（user / assistant / tool_result / interrupt）不回退。

## Measured / out-of-band

操作员 TUI 真按 Esc 的观感不作为本 spec 落地 CI 闸；SC1–SC7 由单测锁。
