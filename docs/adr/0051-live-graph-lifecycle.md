# 0051. 活图随第一次交节点而建；关 overlay 不销毁；reset / 会话结束才扔掉

Date: 2026-09-08
Status: accepted

人打开 graph mode 且模型第一次提交节点时才建立活图。空开 overlay 不建账本。关掉 graph mode 只让 `run_graph` 继续被 handler 拒绝，活图保留，再开可续。`/reset` 与会话结束销毁。compact 不扔活图。没有 pending 时账本可留到 reset。#935。
