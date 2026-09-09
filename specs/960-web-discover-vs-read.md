# Spec: web_search 发现 vs web_fetch 阅读（#960）

## Objective

操作员说「用网络搜索」时，模型先走发现（`web_search`），需要读某一页且 URL 已在手里时才走阅读（`web_fetch`）。两职不是备用关系：搜空了换查询，不猜 URL 去抓。

成功：黄金集锁住首工具；工具 description 与 **ACI network surface** 同向；不靠加长 soul / usage。

## Boundaries

- **Does:**
  - 重写 `web_search` / `web_fetch` 的模型可见 description，正向触发（D9），拆掉「搜完每个结果都 fetch」。
  - 黄金集（golden set）：固定输入 + 可判定首工具。夹具跟 ACI web 工具测试放，不另开总柜。
  - 评估 ADR-0043 退场序是否放大「只看见 fetch」；仅当黄金集在真模型上仍失败才改序。
- **Confirms with human:** 真模型夹具仍失败时，退场改为「两件同退」还是「fetch 先于 search 退」。未失败则保持现行序。
- **Out of this spec:** Exa / 其它厂商适配（`aci-web-backend.md`）；沙箱代理（#959）；第 9 件网络工具；运行时硬拦「没搜过不准 fetch」；加长 system / usage 禁令；chat REPL 当验收面。

## Success Criteria

- **SC1** 无现成 URL、要求网络搜索（含新闻类）→ 首工具是 `web_search`。
- **SC2** 用户已给出 http(s) URL、要求读该页 → 允许首工具 `web_fetch`。
- **SC3** 搜索零结果不是改走 `web_fetch` 的信号（夹具：搜空后下一步不是猜 URL 抓取）。
- **SC4** description 不再把 search 写成 fetch 的前置作业；D9 guard（`d9-description-guard`）仍绿。
- **SC5** 无夹具不准合 description。真模型：`npm run test:real-llm` 跑同一集；缺 key → Not run，LLM 裁判不能单独放行。
- **SC6** 本票不改 handler 成功/失败语义（零结果仍是既有 `ToolExecutionError`）。
- **SC7** 未改 TUI / 会话活环 → 不要求 aiterm；本票地面是 vitest +（有 key 时）real-llm。

## Open Questions

(none) — 退场改法留在 Boundaries「Confirms with human」，用 T3 决策票承接，不阻塞 T1/T2。

## Inherits / Changes

- **ACI network surface**（`docs/CONTEXT.md`）：发现 = `web_search`，阅读 = `web_fetch`。
- `docs/guides/prompt-development.md`：先夹具再文案；说明书不是闸；D9 正向触发。
- ADR-0043：`DEFERRABLE_BUILTIN_RETIRE_ORDER` 现为 trace 三件 → `web_search` → `web_fetch`。默认不重开；仅 SC5 真模型失败后才评估。
- `aci-web-backend.md`：后端/厂商形状不在本 spec 改。
- #440 / D9：`tests/harness/aci/tools/d9-description-guard.test.ts`。
- 测试命令：`npm test`（含 d9）；LLM 触点另加 `npm run test:real-llm`。
