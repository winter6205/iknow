---
paths:
  - "src/harness/trace/**"
  - "src/session-api/**"
  - "tests/**/*{session,trace}*"
  - "tests/**/*.jsonl"
---

# SessionStore 与 trace 的测试证据

红线在 `test.md`，这里只写做法。

- 改持久化、replay、resume、listing 时，用真实的 SessionStore 和文件系统，每个用例用新的 `conversationId`。证明已持久化，要用新构造的 store 读回，或直接检查落盘的 JSONL；要证明跨进程持久化，另起一个进程读回（同一台机器、同一临时目录），只在本进程里重新构造 store 不足以证明进程重启后读得到。
- 中途故障：写到一半被打断（进程被杀、JSONL 截断、只写头不写尾）后，读回必须能区分「已持久化」和「半截记录」；半截记录不得被当成可用会话，读时要有确定的失败而不是静默丢数据。
- 改 trace 时，用生产的 writer / reader 读写临时文件；会话内的 trace 写在会话目录的 `trace.jsonl`。fixture 用组件实际消费的格式（session-store JSONL、`llm_call` / `tool_call` / `turn`、trace-server 的 `session` 记录）；合法记录用生产 serializer 生成。
- 断言可观测数据：消息内容、head 关系、记录顺序、ID、parent ID、状态、list / resume 的结果。
- 本场景不得 mock：SessionStore、文件系统、trace writer。

## 数据边界

- 每个用例新建临时目录，例如 `await fs.mkdtemp(path.join(os.tmpdir(), "iknow-test-"))`，用例结束后删除。
- 存储根目录一律注入，不落到默认的 `~/.iknow`：SessionStore 用构造参数 `new SessionStore(<临时目录>, …)`（`src/session-api/store/session-store.ts`），CLI 用 `--data-dir`，trace 用 `IKNOW_TRACE_OUT` 或工具的 `traceDir`。
- 写入前断言目标路径在临时目录下：`expect(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true)`。
- fixture 只用合成内容，不复制真实会话或 trace。

## 密钥不落盘

- 至少保留一条测试：在用户消息、工具参数或 `llm_call` 请求头里放假 token（如 `Authorization: Bearer test-only-not-a-secret-<随机串>`），经生产 writer 写入会话和 trace 后读落盘文件，断言假 token 原文不存在、出现了打码标记。
- 生产 writer（`src/harness/trace/jsonl.ts`）写入前打码，占位符是 `<<<SECRET_N>>>`（`src/harness/secret-roundtrip/registry.ts`）。这条测试失败就是缺陷，报告给用户，不得改成 skip 或放宽断言。

## trace 产物

- 测试生成的会话和 trace 文件只留在临时目录，不提交。提交前用 `git status --porcelain --untracked-files=all | rg '\.jsonl$'` 检查新增的 `.jsonl`，逐个确认是合成 fixture。
