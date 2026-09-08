# 0055. 用户钩子是同进程 hook router，内置钩子与用户钩子两条装配路径

Date: 2026-09-08
Status: accepted

引擎内用户钩子收成 `src/harness/hooks/` 的 **同进程 router**（对齐 ADR-0045：工厂返回纯函数，不 fork、不起 daemon、不走 Unix socket），挂回既有 permission 5 步链第 1/5 步，不新增链步。**内置钩子（builtin hooks）** 仍由代码装配（secrets-guard 兼容路径、TUI Post、violation 观察者等），禁止写入 `settings.hooks`，`hooks.enabled` 卸不掉；**用户钩子（user hooks）** 才是 `settings.hooks`（缺席=关）上的声明式 deny-only。不把 isolation / hard-wall / secrets roundtrip / auto-memory 吞进单一 Policy server；那些产品开关与钩子总闸正交。V1 不扫描 `~/.iknow/hooks/`（文件源是后续贡献接口，目录落盘不自动执行）。

## Why not

- **OS / IPC hook server**：Pre 必须同步 fail-closed（#126 D3）；IPC 超时会把热路径变成全工具拒绝。
- **一个 Policy 巨兽**：四套 SSOT 与失败语义不同，焊在一起会让改 isolation 碰到用户规则。
- **用户钩子与 `/memory` 共用 enable**：关 hooks 会误关自动记忆。
