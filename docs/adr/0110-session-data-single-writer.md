# 0110. 会话数据文件单写者契约：一文件一宿主进程写者，进程内串行队列是唯一锁层

Date: 2026-09-20
Status: accepted

## Context

会话数据文件（主会话 `session.jsonl` / 工人 `transcript`、`skill-index.json` 等 ledger）的追加都是 read-modify-write：读全文件 → 算下一状态（event id / 名集）→ 写回。store 层刻意不提供文件锁（架构纪律：「锁在装配边界」，`session-store.ts` `appendEvents` 的 JSDoc 已要求调用方处于 hub serialize queue 之下）。

worker transcript 曾缺这层装配点串行化：worker loop 的并发 `flushPrefix` 重入时两批读到同一 head → 重复 event id → `schema_invalid` → worker exit 2。修复时在 `src/cli/worker-transcript.ts` 内联了一份 serialize，与 `src/harness/skill/index-ledger.ts` 的私有 `createSerialQueue` 逐字节同构——同一纪律两处手写，漂移只是时间问题。

反面教材是通用形态：把全局状态与多个会话写进同一共享文件、靠 OS 层重试躲 `EBUSY`，正是「同文件多宿主写者」的坑——OS 文件锁不是本契约的替代层。

## Decision

**会话数据文件单写者契约：**

1. **每个会话数据文件恰有一个宿主进程写者。** transcript/ledger/session 文件归属于一个宿主进程（主会话 = session-api hub；工人 transcript = 该 worker 进程），不存在第二个进程同时写的支持面。
2. **进程内串行队列是唯一的锁层。** 写路径必须在装配边界经一个 `createSerialQueue()`（`src/util/serial-queue.ts`，SSOT）收敛：严格 FIFO、前序 reject 只回给该调用方且不卡链。store 层不引入文件锁 / advisory lock / 重试。
3. **跨进程同开同一会话不在支持面。** 不做检测、不做恢复、不承诺行为（两个进程各持自己的内存真值交错整写会互为覆盖）。若未来要支持，须另立 ADR 且不得 silently 扩本合同。
4. **收敛重复实现。** 装配点不得再手写 Promise 链 serialize；`worker-transcript`（cli）与 `index-ledger`（harness）共用 `src/util/serial-queue.ts`。harness→util 是中立底层依赖，不触 Gate B（Gate B 只禁 harness 可执行面 import session-api）。

## Why not

- **store 层加文件锁：** 与「无状态 store、锁在装配边界」纪律冲突；且跨进程锁需要 OS lock 原语，回到 EBUSY 重试泥潭。拒。
- **每处继续私有实现：** 两份同构代码已经出现过，第三处只会更快漂移出语义差异（如 reject 卡链）。拒。
- **支持跨进程同开：** 需要引入锁 + 冲突合并 + 内存真值失效协议，产品面没有这个需求。拒（登记为不支持，而非未定义）。

## Consequences

- `src/util/serial-queue.ts` 成为新消费点的唯一入口；新增会话数据文件写路径时必须显式经装配点队列。
- 队列只保证「不交叠」：任务内 await 同队列的后续任务会死锁，头注释与单元测试（`tests/util/serial-queue.test.ts`）钉死该边界。
- 既有测试 `tests/cli/worker-transcript.test.ts`、`tests/skill/index-ledger.test.ts` 继续作为行为等价证明。

## Evidence pointers

- worker transcript 竞态修复（本 worktree `fix-worker-transcript-race` 的装配点 serialize）。
- `src/session-api/store/session-store.ts` `appendEvents` JSDoc（hub serialize queue 纪律）。
- ADR-0102（subagent continue-after-complete，工人 transcript IO 注入缝）。
- 同文件多宿主写者的 OS 级 `EBUSY` 重试教训（操作员口述对照，不点名产品）。
