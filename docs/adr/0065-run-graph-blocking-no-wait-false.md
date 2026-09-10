# 0065. run_graph 跑着时父代理不能做别的事；最多主进程静默等待。TUI 进度不进本图 spec

Date: 2026-09-08
Status: accepted

一段 `run_graph` 在跑时，父代理不得并行干别的工具或对话回合。没有图上的 `wait:false`。允许的上限是主进程（host）卡住等这张图 settle 或取消。TUI 格子进度另说，不进阶段 1/2 spec。

> **Amendment 2026-09-10**（ADR-0076）：本图雾里的 wait:false / 节点唤醒 / mailbox 划出 Destination，不并入 #815 / #727。#975。
