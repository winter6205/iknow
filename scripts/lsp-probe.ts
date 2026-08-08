/**
 * LSP 探针 — spec 251-lsp-tool 真实 tsserver 烟测（对照 scripts/sandbox-probe.ts）。
 *
 * 职责：通过 ACI 工具工厂 `createLspToolSet` 走**真实栈**（typescript-language-server
 * spawn tsserver + vscode-jsonrpc 客户端三件套），烟测 9 件 operation + lsp_diagnostics：
 *   - 8 件 position 操作 + 2 件 call-hierarchy 后段 + lsp_diagnostics = 10 件工具。
 *   - 每件 handler 契约 Y1：返回纯字符串；断言非空且 **不是** 无 server 哨兵
 *     `"(no LSP server available for file)"`（该哨兵 = tsserver 未 spawn，探针判 FAIL）。
 *   - lsp_definition 指向本仓真实函数 `getClient`，断言结果含目标文件路径。
 *
 * 不再做手工 didOpen：handler 层（client.ensureOpen）已内置 per-file 幂等
 * didOpen，探针只用工具工厂与真实 client 完成全链路校验。
 *
 * 退出码：passed === total ? 0 : 1（对照 sandbox-probe.ts）。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createLspToolSet } from "../src/harness/aci/tools/lsp.js";
import type { AciToolDef } from "../src/harness/aci/types.js";

/** 无可用 LSP server 时 handler 返回的哨兵纯字符串（探针据此判 FAIL）。 */
const NO_SERVER = "(no LSP server available for file)";

/** 真实 TS 目标文件（本仓 src/harness/lsp/client.ts 的 getClient 定义处）。 */
const TARGET_FILE = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "src/harness/lsp/client.ts"
);
/**
 * 定义探针：`getClient` 函数定义在 client.ts 第 85 行（1-based）,
 * `export async function getClient(`,character 指向 `getClient` 标识符起始。
 */
const TARGET_LINE = 85;
const TARGET_CHAR = 23;
/** diagnostics 探针目标：本仓真实 TS 文件。 */
const DIAG_FILE = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "src/harness/lsp/types.ts"
);

let passed = 0;
let total = 0;

/** 断言 helper：handler 返回字符串、非空、非无-server 哨兵。 */
function checkString(name: string, result: unknown, extra?: string): void {
  total++;
  const ok =
    typeof result === "string" && result.length > 0 && result !== NO_SERVER;
  if (ok) passed++;
  const detail =
    typeof result !== "string"
      ? `type=${typeof result}`
      : result === NO_SERVER
        ? "no LSP server available"
        : (extra ?? "");
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
}

/**
 * 断言 helper：RPC error 归一化的 detail 字符串 → **恒 FAIL**。
 *
 * 修复探针假阳性（#265 回归）：此前 `else checkString(name, def.detail)` 把
 * safeCall 包出来的错误消息当普通字符串判，而 checkString 只认「非空 + 非
 * 哨兵」即 pass → 真实返回 -32602 等错误被误报为 ✓。RPC error 必须显式判
 * FAIL，否则探针无法捕获「请求实际失败」。
 */
function checkError(name: string, detail: string): void {
  total++;
  console.log(`✗ ${name} (ERROR: ${detail})`);
}

/**
 * 统一 report 分发：safeCall 的 ok/err 结果 → checkString / checkError。
 * 消除 10 处重复的 `if (x.kind === "ok") checkString(...) else checkError(...)`。
 */
function report(
  name: string,
  result: { kind: "ok"; value: unknown } | { kind: "err"; detail: string },
  extra?: (value: unknown) => string | undefined
): void {
  if (result.kind === "ok")
    checkString(name, result.value, extra?.(result.value));
  else checkError(name, result.detail);
}

/**
 * 包一层 try/catch 把单件操作的 RPC error 归一化为哨兵字符串，
 * 让后续 checkString 判 FAIL 并打印原因（避免 ResponseError 把探针整进程打挂）。
 */
async function safeCall(
  name: string,
  call: () => Promise<unknown>
): Promise<{ kind: "ok"; value: unknown } | { kind: "err"; detail: string }> {
  try {
    const v = await call();
    return { kind: "ok", value: v };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "err",
      detail: msg.split("\n")[0].slice(0, 160),
    };
  }
}

async function run(): Promise<void> {
  console.log("lsp-probe");
  const ctx = {
    directory: resolve(fileURLToPath(new URL("..", import.meta.url))),
  };
  const tools = createLspToolSet(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const get = (n: string): AciToolDef => {
    const t = byName.get(n);
    if (!t) {
      total++;
      console.log(`✗ ${n} (tool not exported)`);
    }
    return t as AciToolDef;
  };

  // 1) lsp_definition — 指向真实函数 getClient，断言含目标文件路径。
  // 注：不再手工 didOpen；handler 层 ensureOpen 负责打开目标文件建 project。
  const def = await safeCall("lsp_definition", () =>
    get("lsp_definition").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  report("lsp_definition", def, (value) =>
    typeof value === "string" && value.includes("client.ts")
      ? "hit client.ts"
      : "no client.ts"
  );

  // 2) lsp_references — getClient 被 handler 层引用。
  const refs = await safeCall("lsp_references", () =>
    get("lsp_references").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  report("lsp_references", refs);

  // 3) lsp_hover — getClient 定义处应返回类型签名。
  const hover = await safeCall("lsp_hover", () =>
    get("lsp_hover").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  report("lsp_hover", hover);

  // 4) lsp_document_symbol — 文件级符号应有返回。
  const docSym = await safeCall("lsp_document_symbol", () =>
    get("lsp_document_symbol").handler({ file: TARGET_FILE })
  );
  report("lsp_document_symbol", docSym);

  // 5) lsp_workspace_symbol — 空 query 拉全量符号。
  const wsSym = await safeCall("lsp_workspace_symbol", () =>
    get("lsp_workspace_symbol").handler({ file: TARGET_FILE })
  );
  report("lsp_workspace_symbol", wsSym);

  // 6) lsp_go_to_implementation — getClient 应有实现。
  const impl = await safeCall("lsp_go_to_implementation", () =>
    get("lsp_go_to_implementation").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  report("lsp_go_to_implementation", impl);

  // 7) lsp_prepare_call_hierarchy — 函数定义处可建调用层级。
  const prep = await safeCall("lsp_prepare_call_hierarchy", () =>
    get("lsp_prepare_call_hierarchy").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  report("lsp_prepare_call_hierarchy", prep);

  // 8) lsp_incoming_calls — 多步：prepare 后 forward incomingCalls。
  const inc = await safeCall("lsp_incoming_calls", () =>
    get("lsp_incoming_calls").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  report("lsp_incoming_calls", inc);

  // 9) lsp_outgoing_calls — 多步：prepare 后 forward outgoingCalls。
  const out = await safeCall("lsp_outgoing_calls", () =>
    get("lsp_outgoing_calls").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  report("lsp_outgoing_calls", out);

  // 10) lsp_diagnostics — 真实文件诊断。tsserver 层经 typescript-language-server
  //     可能不实现 pull-diagnostics（Error -32601 Unhandled method），
  //     safeCall 会把该错误归为 FAIL 并打印原因。
  const diag = await safeCall("lsp_diagnostics", () =>
    get("lsp_diagnostics").handler({ file: DIAG_FILE })
  );
  report("lsp_diagnostics", diag, (value) =>
    typeof value === "string" && value.includes("<diagnostics")
      ? "diagnostics XML"
      : "empty"
  );

  console.log(
    `\n${passed === total ? "all green" : "failures"} (${passed}/${total})`
  );
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error("lsp-probe crashed:", err);
  process.exit(1);
});
