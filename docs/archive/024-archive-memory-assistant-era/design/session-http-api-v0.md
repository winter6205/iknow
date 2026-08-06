# Session HTTP API v0（host 交互接口）

> 状态：**implemented** with in-memory sessions  
> 范围：HTTP 会话表面，**不改** 4 tool 协议  
> 对齐：`interaction-surface-v0.md` + `ConversationState`  
> 入口：`iknow serve [--port 8787] ~~[--mode …] [--role …] [--embeddings]~~`（`--mode` / `--role` / `--embeddings` 已退役 — harness 通用 agent，授权由 ACI 装饰层承接）

---

## 1. 设计原则

| 原则        | 含义                                                                                 |
| ----------- | ------------------------------------------------------------------------------------ |
| 信封优先    | 每条 user message → 一次完整 `IknowAnswer`（G2）                                     |
| 会话在 host | `conversation_id` / turns / priors 不进 tool schema                                  |
| 双视图      | 响应始终含 G2；可选 `human_text` 投影                                                |
| 同源 UI     | 静态页由同一进程提供，避免 CORS 复杂度                                               |
| Fail-closed | ~~非法 mode~~ / 空消息 → 4xx + typed JSON error（`role` 已退役，不再作为输入校验项） |

---

## 2. 公共类型

### 2.1 Error envelope

```json
{
  "error": "validation|not_found|permission_denied|…|error",
  "message": "human-readable",
  "details": {}
}
```

HTTP 映射：`VALIDATION`→400，`NOT_FOUND`→404，其余 500（或业务码）。

### 2.2 Session summary

```ts
type SessionSummary = {
  conversation_id: string;
  // caller_role: "employee" | "manager" | "admin";  // 已退役（022 Q2-G4）：harness 路径不再携带
  // mode: "deterministic" | "llm";  // 已退役：AgentMode 双模式概念已移除，仅保留 LLM 路径
  json_mode: boolean;
  turn_count: number;
  prior_count: number;
  // embeddings: boolean;  // 已退役（023 + 旧 loop 残留清理）：无向量检索臂
};
```

### 2.3 Turn DTO（API 投影）

```ts
type TurnDto = {
  query: string;
  answer: IknowAnswer; // full G2
  human_text?: string; // host projection when json_mode=false
};
```

---

## 3. Routes

### `GET /api/v1/health`

```json
{ "ok": true, "service": "iknow-session-api", "version": "0.1.0" }
```

### `POST /api/v1/sessions`

Request:

```json
{
  "json_mode": false
}
```

> `role` / `embeddings` 字段已退役（022 Q2-G4 + 023）：`CreateSessionRequest` 现仅接受 `mode` / `json_mode`。

All fields optional (server defaults from CLI/env).

Response `201`:

```json
{
  "session": SessionSummary,
  "turns": []
}
```

### `GET /api/v1/sessions/:id`

Response `200`:

```json
{
  "session": SessionSummary,
  "turns": TurnDto[]
}
```

`404` if unknown id.

### `POST /api/v1/sessions/:id/messages`

Request:

```json
{ "text": "公司的退款政策是什么？" }
```

Constraints: `text` non-empty after trim; max length **8000** code units.

Response `200`:

```json
{
  "session": SessionSummary,
  "turn": TurnDto
}
```

### `POST /api/v1/sessions/:id/commands`

Request:

```json
{ "command": "mode", "args": ["deterministic"] }
```

> ~~`mode` command~~ — 已退役，保留此示例仅作历史记录。

Supported commands (slash body without leading `/`):  
`help` | `status` | `json` | ~~`role`~~ | ~~`mode`~~ | `reset` | `quit`（HTTP 上 quit = no-op info）  
（`role` / `mode` 已退役 — CLI 不再有 mode 概念，caller_role 随旧 loop 移除）

Response `200`:

```json
{
  "session": SessionSummary,
  "effect": "help|info|error|mode_change|reset|quit",
  "message": "string"
}
```

### `POST /api/v1/sessions/:id/reset`

Request (optional):

```json
{ "new_id": false }
```

Response `200`: session summary after reset (`turns` cleared).

### Static UI

| Path     | File             |
| -------- | ---------------- |
| `/`      | `web/index.html` |
| `/web/*` | `web/*`          |

---

## 4. Reserved / future (not implemented)

| Path / field                            | Purpose           |
| --------------------------------------- | ----------------- |
| `GET /api/v1/sessions/:id/events` (SSE) | token streaming   |
| `Authorization` header                  | production auth   |
| `POST .../messages` `stream: true`      | stream flag       |
| Multi-instance session store            | Redis / DB        |
| `prior_chunks` client override          | host-only for now |

Frontend may call reserved paths and must treat **404/501** as “not yet”; v0 UI does not depend on them.

---

## 5. Process model

- One Node process: shared in-memory KB store + N conversation bags
- Restart wipes sessions (documented)
- Default bind: `127.0.0.1:8787` (override `--port` / `IKNOW_SERVE_PORT`)

---

## 6. Acceptance

- [x] Contract doc exists
- [x] Create + message returns `answer.snapshot_id`
- [x] UI never drops G2 fields in machine panel
- [x] Empty text → 400
- [x] Unknown session → 404
