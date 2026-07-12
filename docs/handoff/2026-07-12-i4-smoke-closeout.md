# Handoff — I4 真机交互冒烟 closeout

## Outcomes

- 四路并行冒烟：deterministic / embeddings / llm / HTTP session  
- 产物目录：`docs/handoff/i4-smoke/`  
- LLM 客户端：`parseLlmResponseJson` + `stream:false`（修复 SSE trailer 解析失败）  
- LLM 冒烟用 9router `apiKeys.name=iknow`（进程注入，未入库明文）

## Results

| Suite | Pass |
|-------|------|
| deterministic CLI | yes |
| embeddings CLI | yes |
| llm CLI | yes（hops=5, tool_calls=8 on ask） |
| HTTP + web dist | yes |

## Ops note

`.env.local` 的 `NINE_ROUTER_API_KEY` 当前对 **chat** 401；请与 9router UI 中 `iknow` key 对齐。  
脚本：`scripts/i4-llm-smoke-with-router-key.ts`、`scripts/i4-probe-llm.ts`。

## Validation

```text
npm test            # includes llm-client-parse
npm run typecheck
```

## Next

- 同步 shell env key  
- I5 多轮 trajectory eval（可选）  
- 消息持久化 / message_id  
