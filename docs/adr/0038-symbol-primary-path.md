# 0038. 符号主路径：代码的找与改以符号身份为准

Date: 2026-08-30

Status: accepted

对可分析代码，智能体的默认发现与符号级修改走符号工具（符号身份 + 文件路径），而不是先 grep 再对行列调用语言服务器。`grep` / `read_file` / `edit_file` 留下给非代码、未知名字、语言服务器不可用，以及不是单一符号的文本补丁。产品使用规则是 `deps.system` 上独立于 identity 卡片和 soul 的一段代码锁死正文，四入口都注入（含 ask）。

ADR-0004 仍管辖工具名、permission、契约 X 与文本编辑工具；其中「工作流语义：grep/glob 发现 → read_file 精读」对**可分析代码**不再适用，由本 ADR 覆盖。非代码与大文件精读纪律不变。

**Why not keep coordinate `lsp_*` as the model API:** 主入参是光标位置，智能体仍然要先用全文搜索找到那一行，符号层形同虚设。

**Why not put the routing text in soul or AGENTS only:** soul 管人格与对人输出格式；AGENTS/rules 在 ask 上缺席且用户可删。使用规则必须是恒在系统段。
