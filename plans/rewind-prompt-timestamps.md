# Plan: rewind picker 显示普通 user prompt 的时间戳

## Background

`src/tui/rewind-picker.tsx:anchoredAtFor(file, turnIndex)`（master 当前实现）只从
`file.checkpoints[].interruptedAt` 取时间戳——只有被中断的 turn 才有；普通
user prompt 在 picker 里**没有时间戳**。`anchoredAt = ""` 时 `fmtAnchored` 返回
空串，picker 那行就只有用户消息文本，UX 不连贯。

PR #624 (`worktree-624-rewind-head`) 引入 `src/session-api/store/rewind-targets.ts`
用 JSONL `userEvents` 派生 rewind targets，仍然走同一个 `anchoredAtFor` 逻辑，
**未合到 master**。本工单补这一缺口。

## Goal

每个 user prompt 在 rewind picker 里都有时间戳——优先 checkpoint `interruptedAt`，
fallback 到 user prompt 入账时刻。

## Non-goals

- 不引入 100 cap / 30 天 GC（违反 append-only 设计承诺）
- 不实现文件快照层（架构不匹配，独立工单）
- 不改 `AnthropicNativeMessage`（wire-format 类型，加字段会污染向 Anthropic 的序列化）
- 不动 `rewind-targets.ts`（#624 未合，等 #624 合后由其落地本逻辑——见 Open questions）

## Design

### 数据来源

`AnthropicNativeMessage` / `LoopState.messages` 都没有 timestamp（wire-format
限制）。新增时间戳的合适位置是 **JSONL `SessionEventRecord`**——append-only
事件链的天然粒度，跨 save / load 持久化，且与现有的 `CheckpointRecord.interruptedAt`
语义对齐（事件级时间戳）。

### Schema 变更

#### 1. `SessionEventRecord`（`src/session-api/store/jsonl.ts`）

加可选字段：

```ts
export interface SessionEventRecord {
  readonly type: "message";
  readonly id: string;
  readonly parent: string | null;
  readonly message: AnthropicNativeMessage;
  readonly createdAt?: string; // ISO; 缺席 = 旧文件 / 投影时无法补
}
```

**Optional for 兼容旧 JSONL 文件**——`parseSessionJsonl` 不做严格校验（spread 纪律），
缺这个字段不会 fail validation。

#### 2. `SessionFileV1`（`src/session-api/store/schema.ts`）

加可选并行数组（不污染 `messages[]` 内的 wire-format 类型）：

```ts
export interface SessionFileV1 {
  // ... 既有字段
  /** 与 messages 一一对应的 createdAt；undefined = 旧文件 / 无时间戳 */
  readonly messageCreatedAt?: ReadonlyArray<string | undefined>;
}
```

#### 3. `SessionHeaderRecord`（`src/session-api/store/jsonl.ts`）

无需改动——header 不带 per-message metadata。

### 写侧

`SessionStore.appendEvents`（`src/session-api/store/session-store.ts:243`）每条
event 写盘前 stamp：

```ts
const createdAt = new Date().toISOString();
const record = {
  type: "message",
  id: eventId,
  parent,
  message,
  createdAt,
};
```

`save()` 路径经 `planSessionSave` 重写 header 时，旧 event records 按原样保留
（`planSessionSave` 的 `appended` 不动旧 event），`createdAt` 跟着存活。

### 读侧

`projectSessionLog`（`src/session-api/store/jsonl.ts:213`）沿 head chain 收集
events 时，并行收集 `createdAt`：

```ts
const messages: AnthropicNativeMessage[] = [];
const createdAtList: (string | undefined)[] = [];
// ... while cur !== null loop:
//   messages.push(event.message);
//   createdAtList.push(event.createdAt);
// messages.reverse(); createdAtList.reverse();
return sanitizeSessionFile({
  ...meta,
  messages,
  messageCreatedAt: createdAtList,
});
```

### UI 消费

`rewind-picker.tsx:anchoredAtFor` 改成两段 fallback：

```ts
function anchoredAtFor(
  file: SessionFileV1,
  turnIndex: number,
  messageIndex: number
): string {
  const record = (file.checkpoints ?? []).find(
    (c) => c.turnIndex === turnIndex
  );
  if (record?.interruptedAt) return record.interruptedAt;
  return file.messageCreatedAt?.[messageIndex] ?? "";
}
```

`buildRewindTargets` 已有 `slices[i].start`（message 索引），传入即可。

`fmtAnchored` 不变——已经能正确处理 ISO 字符串 / 空串。

### Migration

- **已有 JSONL 文件**（master 写入过的）：event records 无 `createdAt` →
  `messageCreatedAt[i] = undefined` → picker 显示空串（同现状）→ 行为不变
- **新写入的 JSONL 文件**：从下一条 `appendEvents` 开始自动带 `createdAt`
- **不需要数据迁移脚本**——`messageCreatedAt` 是 optional，旧数据自然降级

### 与 #624 的交互

#624 合到 master 后，`anchoredAtFor` 会被搬到
`src/session-api/store/rewind-targets.ts`，并改成按 JSONL `userEvents` 派生。
**本工单不动 #624 的代码**，等 #624 合后再把同样的 fallback 加到
`rewind-targets.ts:anchoredAtFor`——成本 < 5 行，逻辑同构。

如果用户希望在 #624 之上做这个改动（避免 merge conflict），可以：

- (a) 等 #624 合后再开 PR（推荐——本工单 master 上的 commit 干净，未来 rebase 简单）
- (b) 现在 rebase 到 `origin/worktree-624-rewind-head`（需要用户授权 git reset --hard）

**默认走 (a)**：本 PR 基于 master；#624 合后开一个小 follow-up 把同样逻辑落到
`rewind-targets.ts`。

## File changes

| 文件                                              | 改动                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/session-api/store/jsonl.ts`                  | `SessionEventRecord.createdAt?: string`；`projectSessionLog` 收集 `messageCreatedAt`                        |
| `src/session-api/store/schema.ts`                 | `SessionFileV1.messageCreatedAt?: ReadonlyArray<string \| undefined>` + sanitize 透传                       |
| `src/session-api/store/session-store.ts`          | `appendEvents` 给每条 event stamp `createdAt`                                                               |
| `src/tui/rewind-picker.tsx`                       | `anchoredAtFor(file, turnIndex, messageIndex)` 改成两段 fallback；`buildRewindTargets` 传 `slices[i].start` |
| `tests/session-api/store/jsonl.test.ts`（或同级） | `parseSessionJsonl` 容忍无 `createdAt`；`projectSessionLog` 输出 `messageCreatedAt`                         |
| `tests/session-api/store/session-store.test.ts`   | `appendEvents` 写出带 `createdAt` 的 events；旧文件 load 时 `messageCreatedAt[i]` 是 undefined              |
| `tests/tui/rewind.test.ts`                        | `buildRewindTargets` 对非-checkpoint prompt 在 `messageCreatedAt` 有值时显示时间戳                          |

## Tests 覆盖

1. **正常路径**：append 一条 user message → load → `messageCreatedAt[0]` 是 ISO 字符串
2. **失败路径**：JSONL 旧文件无 `createdAt` → load 成功，`messageCreatedAt[0] === undefined`，picker 显示空串（不退化）
3. **边界条件**：同时有 checkpoint 和 `createdAt` → 优先 `interruptedAt`（checkpoint 优先）
4. **picker 显示**：`buildRewindTargets` 在 `messageCreatedAt` 有值时返回非空 `anchoredAt`
5. **空输入**：messageCreatedAt 缺席 → `anchoredAt = ""`（与现状一致）

按 `test.md` 要求加 e2e + 边界 + 正常 + 异常 5 类至少各 1 用例。

## Validation

- `npm test` 全绿（既有测试不退化）
- `npm run test:changed` 窄矩阵过（pre-commit 必跑）
- `npx tsc --noEmit` 无新 type error
- 手测：起 TUI 跑两步 turn，第二步 turn 的 picker 行有时间戳

## Open questions

1. **#624 合后是否要回头改 `rewind-targets.ts`**：建议合并 #624 后开 ~3 行
   follow-up，逻辑与本 PR `anchoredAtFor` 同构
2. **`save` 路径下旧 event 的 `createdAt` 是否需要 backfill**：不需要。
   `planSessionSave` 对未变 events 是 verbatim 保留（`appended` 不动它们），
   只有 header 重写时 `createdAt` 跟着存活
3. **T3 commit pattern（#620）下的精度**：每条 message 在它自己的 `appendEvents`
   调用里被 stamp，user / assistant / tool 各自的时间戳彼此接近但可分辨——足够
   picker 区分，不需要更细粒度

## Risks

- **Schema 向后兼容**：`SessionEventRecord.createdAt` 是 optional，parser 不
  破坏旧文件——已验证
- **wire-format 污染**：明确不在 `AnthropicNativeMessage` 上加字段——避免 Anthropic
  API 序列化问题
- **回退成本**：本工单改 4 个生产文件 + 3 个测试文件，全部有 schema / 行为级测试，
  出问题易回滚

## Follow-up

合并 #624 后开 ~3 行小 PR，把本逻辑镜像到 `src/session-api/store/rewind-targets.ts:anchoredAtFor`。
