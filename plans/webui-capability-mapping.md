# WebUI 能力映射对齐 TUI（slash + host 扩展面）

## Intent

WebUI 不再使用「核心 5 子集」裁剪。slash 词表、skill 混显、`/mcp` 看板、`/rewind`、`/info`、`/sessions` 映射到已有 SPA 面；SessionHub 把 TUI `TuiExtensions` 同源装配经 HTTP 透出（SPA 不能读进程内 catalog）。

## Affected files

- `src/session-api/contract.ts`, `hub.ts`, `http.ts`
- `web/src/lib/slash.ts`, `rewind-targets.ts`, `session-info.ts`
- `web/src/api/{types,client}.ts`, `web/src/hooks/useSessionChat.ts`
- `web/src/components/{Composer,SlashCommandMenu,McpPanel,RewindPicker}.tsx`
- `web/src/App.tsx`
- tests: `tests/web/slash.test.ts`, `tests/web/rewind-targets.test.ts`, `tests/session-api/*`

## ACR verdict

- bounded-context-guardian: yes — HTTP 面留在 session-api；SPA 只消费 DTO；不从 session-api import tui
- defensive-contract-validator: yes — empty skills/mcp；keepTurns 负/缺/非整数；未知会话 rewind；skill 缺名 404
- error-handling-enforcer: yes — ValidationError / store typed 404；装配缺席 → 空清单非 500
- complexity-anti-drift: yes — slash/rewind-targets/McpPanel/RewindPicker 分文件；hub 方法镜像 compactSession
- minimal-change-verifier: yes — 1 逻辑任务：Web 能力面映射；不改 TUI 词表与 assemble 流水线
