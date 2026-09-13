# onetime-probes

一次性裁决探针，结论已固化，仅留档。各脚本在对应 ticket 的决策中完成使命后已无人接线（不在 package.json scripts、不被现役 tests/src import、不被 README 引用）；`closed-world-inventory-probe.ts` 的纯逻辑契约随其归档测试一并留档。

| 归档脚本                          | Ticket    | 用途                                                                 | 结论固化处                                                                |
| --------------------------------- | --------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `otui-capability-probe.ts`        | #343 (D3) | OpenTUI 能力探针（stickyScroll / CJK selection / 剪贴板通道），3×yes | `plans/321-tui-opentui-migration.md`                                      |
| `otui-perf-probe.ts`              | #343 (T8) | OpenTUI 性能探针（帧统计），结论 3×yes                               | `docs/handoff/2026-08-10-343-tui-opentui-migration.md`                    |
| `mcp-schema-probe.ts`             | #337 (D1) | ajv strict × MCP inputSchema 兼容性探针，ALL PASS → T7 直连          | `plans/337-skill-mcp-extension.md`                                        |
| `subagent-envelope-probe.ts`      | #356 (D1) | worker 协议信封冻结探针，PASS                                        | `plans/356-subagent-v1.md`                                                |
| `closed-world-inventory-probe.ts` | 闭世界    | 闭世界断链盘点（无 writable home bind 的假设 argv），16 条 BREAK     | `docs/adr/0037-worktree-isolation-on-mutate.md` §9；ADR-0092 退役默认姿态 |
