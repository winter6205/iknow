# Spec: symbol-primary-aci — 符号主路径（查找 + 改代码）

> 输入 = 操作员确认：代码的找与改以符号身份为准；旧坐标工具面不符合智能体主路径则重构并归档；使用规则为 `identity/` 下独立文件，不进 soul；对人输出格式仍在 soul Vibe。合同以本对话决议为准，不引用外部产品对照。
> 落地 = 本 spec → ACR → `plans/symbol-primary-aci.md`。本文件不含实施代码。

## Assumptions (confirmed)

1. 目的地是 iknow **ACI** 给本机智能体用：可分析代码默认走符号工具（找 + 改），不是只升查找。
2. `grep` / `read_file` / `edit_file` 保留；grep 只作三类回退：非代码（注释、字符串、配置、文档）、还不知道符号名、语言服务器不可用时重试一次仍失败。
3. 现行模型面 10 件 `lsp_*`（文件 + 行列）不能当主 API：智能体仍要先搜到一行才能问。该面退役；客户端与多语言 dispatch（spec 302）留下当实现。
4. 旧工具达不到主路径要求则直接改或换掉，不长期双暴露坐标面和符号面。
5. 使用规则：新文件（建议 `src/harness/identity/usage.ts`）与 `identity.ts` / `soul.ts` 并列；装配段名 `usage`，插在 soul 之后、user_profile 之前。chat / tui / serve / **ask** 都注入。不进 soul，不进 identity 卡片。
6. 对人说话的 Markdown / 分段格式继续只住 soul Vibe，本 spec 不改那段。
7. 模型看不到目录名。身份卡片、人格、使用规则是三段不同正文。
8. 用户/项目 AGENTS 与 rules 只能加严或补充，不能当这条纪律的唯一来源。
9. 只读 worker 的 tool constraints 段必须与使用规则同一套优先级，禁止再把 grep 与符号工具并列成「随便用」。
10. 契约 X / model-facing 纯字符串 / executor 截断 / permission 装饰 / `edit_file` 写盘后 LSP invalidate 继承现状。
11. spec 302 的按扩展名选语言服务器仍有效；其中「`lsp.ts` 不动、工具数锁在旧 10 件」由本 spec 覆盖。
12. `specs/lsp-mcp-server.md` 现行「恰好 10 件只读 `lsp_*`」在实施收口时必须改成与 ACI **查询**符号面同构；MCP 写类符号工具本 spec 不强制（仍可只读）。
13. 调用图能力保留（prepare + incoming + outgoing），改成跟符号身份同一套提问方式，不因「旧工具叫 lsp_*」而删。
14. 本批文档不把对照来源写进 spec / plan / ADR 正文。

## Objective

把智能体在代码上的默认动作从「全文搜索 + 光标坐标」改成 **符号主路径**：按符号身份查找（声明、引用、实现、大纲、悬停、诊断、调用图），并按符号改（跨文件改名、替换某个符号的定义体、在符号前后插入、确认无引用再删）。

使用者是 iknow 四入口上的编码智能体。成功时：不知道行列也能按名字办事；grep 不再是查代码结构的第一跳；旧坐标 10 件不再出现在模型可调工具表里。

## Boundaries

- **Does:** 模型面符号查询工具 + 符号改工具；使用规则段与装配顺序；身份/只读约束文案与工具 description 对齐；expand → migrate → 从模型面拿掉 `lsp_*`；归档 `specs/251-lsp-tool.md`；同步 TUI tool summary、注册表 Gate 3、子代理声明面、LSP MCP 查询面；语言服务器不可用时的失败字符串与重试纪律；若薄封装达不到「按名字命中」则改 handler/索引，不保留坐标公共 API。
- **Confirms with human:** 无（本轮已确认落点与目的地）。
- **Out of this spec:** 改 soul Vibe 输出格式；把使用规则写进 AGENTS 当唯一来源；独立发包的语言服务器；Go/Rust 语言服务器二期；记忆工具；把 `identity/` 目录改名；MCP 上的符号级写入（查询同构即可）；非代码文件的语义索引。

## Model-facing tool set

查询（替换旧 10 件的职责，名字对智能体直陈动作）：

- `find_symbol` — 按符号身份（及可选路径）查找。
- `find_declaration` — 声明/定义。
- `find_referencing_symbols` — 引用。
- `find_implementations` — 实现。
- `get_symbols_overview` — 单文件大纲。
- `get_hover` — 类型/签名/文档。
- `get_diagnostics_for_file` — 文件诊断。
- `prepare_call_hierarchy` / `list_incoming_calls` / `list_outgoing_calls` — 调用图。

改：

- `rename_symbol` — 全项目按符号改名。
- `replace_symbol_body` — 替换该符号定义体（含签名行，范围以语言服务器为准）。
- `insert_before_symbol` / `insert_after_symbol` — 在符号定义前后插入。
- `safe_delete_symbol` — 无引用才删，否则返回引用列表且不删。

符号身份：文件内符号树路径（如 `ClassName/methodName`）+ 相对项目根的文件路径。尚不知名字时用大纲或 `find_symbol` 的子串/模式，而不是先 grep 源码。声明在调用点、只有一段源码时，允许用带捕获组的模式在文件内锁定名字再跳转。

禁止把「第几行第几列」当作这些工具的主入参。实现内部可把符号身份译成 LSP position，但不得逼模型先读到某一行。

`workspace/symbol` 现行空 query 行为不得再作为工作区查找的产品语义；工作区查找必须能按名字（或模式）命中。

无语言服务器：与今日相同，返回可读失败（现有 `"(no LSP server available for file)"` 一类），使用规则要求重试一次再 grep。

## 使用规则段

英文正文、独立标题（建议 `# Usage rules`），与 identity / soul 标题并列。要点必须包含：

- 代码结构与符号级改动用上列符号工具，不要用 grep 开场。
- grep / read_file 仅三类回退（见 Assumptions 2）。
- `edit_file` 留给不是单一符号的文本补丁，或符号工具无法应用时。

soul 不重复这份细则。工具 description 写配对与入参，不替代本段优先级。

## Success Criteria

1. `IKNOW_ASSEMBLY_ORDER` 含 `usage`，且顺序为 identity → soul → usage → user_profile → bootstrap → memory_layer；`ask` 在关掉 memory_layer 时仍注入 usage。可用现有 identity 装配测试夹具断言段顺序与 ask 在场。
2. 收口后 `ACI_TOOLSET_NAMES`（及 MCP `tools/list` 查询面）不含 `lsp_definition`、`lsp_references`、`lsp_hover`、`lsp_document_symbol`、`lsp_workspace_symbol`、`lsp_go_to_implementation`、`lsp_prepare_call_hierarchy`、`lsp_incoming_calls`、`lsp_outgoing_calls`、`lsp_diagnostics`。
3. 存在单测：只给符号身份与文件路径、不给 line/character，`find_symbol` 或 `find_declaration` 能对夹具符号返回命中（或明确的无服务器失败串），不得要求调用方先填行列。
4. `grep`、`edit_file` 仍在默认注册表。
5. `src/harness/identity/soul.ts` 的 Vibe 仍承担对人输出格式；usage 文件不含「用 Markdown 分段」类排版纪律。
6. 符号公共 API 的测试覆盖空输入、非法路径/身份、过大结果（截断或拒绝）、并发/inflight 与现有客户端语义一致、语言服务器缺席或抛错为可读失败而非空 catch。`npm test` 在实施收口 PR 退出 0。
7. `specs/README.md` 活跃表列本 spec；`251-lsp-tool.md` 已移入归档目录并在「已归档」段标明 superseded by 本 spec。
8. 只读 worker 约束段出现符号工具优先、grep 为回退的措辞，不再把旧 `lsp_*` 名单与 grep 并列成同等首选。

## Open Questions

(none)

## Inherits / Changes

**Inherits**

- **ACI tool set**（`docs/CONTEXT.md`）：单一注册表 `createDefaultAciRegistry`，入口不得手写第二份名单。
- **plain-string tool output** / **executor truncation authority** / **observability side-channel**：model-facing 仍是字符串。
- **deps.system injection seam**：只经 `identity/assemble.ts` 拼 system。
- **surface split (identity vs memory)**：ask 不挂 memory_layer；本 spec 把 usage 划进与 identity/soul 相同的恒在层。
- spec 302：`resolveServer(file)`、NearestRoot、多语言 spawn。
- spec 196 A13：identity 卡片 ≠ soul；输出风格在 soul Vibe。
- ADR-0004：permission、契约 X、`edit_file`/`write_file` 文本补丁仍在；**仅**「代码发现必须 grep → read」被 ADR-0038 覆盖。
- LSP 客户端三件套缓存、cancel 不杀 server、`edit_file` 成功 invalidate。
- spec `lsp-mcp-server.md`：stdio MCP 与 ACI 共用客户端语义；本 spec 改其工具名单与查询入参，不改 SDK 选型。

**Changes**

- 新增术语：符号主路径、符号身份、使用规则（见 CONTEXT）。
- ADR-0038：代码主路径为符号工具；装配增加 usage 段。
- spec 196 的「5 段 LOCKED」对顺序而言被插入 usage 修订（实施改 `IKNOW_ASSEMBLY_ORDER`，不另开身份识别语义）。
- spec 251 模型面合同 superseded；文件归档。
- spec 302「工具集仍 10 件坐标工具 / lsp.ts 不动」superseded。
- spec `lsp-mcp-server.md`「恰好 10 件 `lsp_*`」在符号主路径收口时必须修订（可另 commit，须在计划内）。

## ACR

bounded-context-guardian: yes — 使用规则落在既有 identity 装配缝；工具仍在 aci；语言服务器仍在 lsp；MCP 仍在 lsp-mcp；不新建技术分层目录。
defensive-contract-validator: yes — SC6 要求符号公共 API 覆盖 empty / negative / overflow / concurrent / exception。
error-handling-enforcer: yes — 无 client、改名冲突、safe_delete 仍有引用须非空失败路径，禁止空 catch。
complexity-anti-drift: yes — 查询与改分工具或分工厂；禁止单 handler 塞满协议。
minimal-change-verifier: yes — 实施按 `plans/symbol-primary-aci.md` 分 commit；本合同文档单独落地。
