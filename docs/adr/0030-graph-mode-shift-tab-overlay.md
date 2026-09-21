# 0030. graph mode 是 Shift+Tab 编排 overlay，装配快照在 run() 边界

Date: 2026-08-27
Status: accepted

D-α 产品入口：Shift+Tab 进入 graph mode（编排 overlay），不把 Graph 塞进 `PermissionMode`。三态轮 `Default → Auto → Graph → Default`；`/graph` 是非 TTY 对等物，settings 一项作新会话默认（默认关）。进 Graph 冻结当时 permission（ask/auto 不变）。编排段与 `run_graph` 只在**下一次 `run()` 装配**时注入/露出——切好模式后模型开始跑再生效。过程中切换不拦、不中途重装配、不为此加防抖。override 父图 #540 先前「Shift+Tab 仍是权限模式、不占用」。进图任务数 N **不锁**——不是「≥2 就必须走图」；N 与 prompt 建议时机留给实施时真任务实测。#545。

## Why not

- **Graph 做成第四种 PermissionMode**：编排轴与授权轴缠在一起，污染 policy / `/permission-mode`，D-β coordinator 更难拆。
- **env gate 才注入 prompt+工具**：ADR-0014 已否（测试矩阵翻倍、不可发现）。会话里人按的可逆 overlay 不是进程启动隐式 gate。
- **切模式当下 round 热替换工具面 / 防过程中误触**：切好再跑才注入；过程中防不住也没必要防（operator 2026-08-27）。

> 2026-09-04 修订：模型面**表达方式**——`run_graph` 条件装配改常驻注册 + handler gate，编排段撤出 system 改为 messages 尾部追加切换提示。本 ADR 的产品语义（三态轮、下一次 `run()` 装配生效、过程不拦）不变。
