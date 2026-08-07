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
 * 退出码：passed === total ? 0 : 1（对照 sandbox-probe.ts）。
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createLspToolSet } from "../src/harness/aci/tools/lsp.js";
import { getClient } from "../src/harness/lsp/client.js";
import type { AciToolDef } from "../src/harness/aci/types.js";

/** 无可用 LSP server 时 handler 返回的哨兵纯字符串（探针据此判 FAIL）。 */
const NO_SERVER = "(no LSP server available for file)";

/** 真实 TS 目标文件（本仓 src/harness/lsp/client.ts 的 getClient 定义处）。 */
const TARGET_FILE = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "src/harness/lsp/client.ts"
);
/** 定义探针：getClient 在 client.ts 第 63 行（1-based），character 指向 getClient 标识符。 */
const TARGET_LINE = 63;
const TARGET_CHAR = 21;
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

  // 0) 打开目标文件（textDocument/didOpen）：tsserver 需先有打开文件才建 project，
  //    否则 workspace/symbol 抛 "No Project."。走真实 getClient 层发 didOpen。
  const opened = await getClient(ctx, TARGET_FILE);
  if (opened) {
    await opened.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(TARGET_FILE).href,
        languageId: "typescript",
        version: 1,
        text: await readFile(TARGET_FILE, "utf8"),
      },
    });
  }

  // 1) lsp_definition — 指向真实函数 getClient，断言含目标文件路径。
  const def = await safeCall("lsp_definition", () =>
    get("lsp_definition").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  if (def.kind === "ok") {
    checkString(
      "lsp_definition",
      def.value,
      typeof def.value === "string" && def.value.includes("client.ts")
        ? "hit client.ts"
        : "no client.ts"
    );
  } else {
    checkString("lsp_definition", def.detail);
  }

  // 2) lsp_references — getClient 被 handler 层引用。
  const refs = await safeCall("lsp_references", () =>
    get("lsp_references").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  if (refs.kind === "ok") checkString("lsp_references", refs.value);
  else checkString("lsp_references", refs.detail);

  // 3) lsp_hover — getClient 定义处应返回类型签名。
  const hover = await safeCall("lsp_hover", () =>
    get("lsp_hover").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  if (hover.kind === "ok") checkString("lsp_hover", hover.value);
  else checkString("lsp_hover", hover.detail);

  // 4) lsp_document_symbol — 文件级符号应有返回。
  const docSym = await safeCall("lsp_document_symbol", () =>
    get("lsp_document_symbol").handler({ file: TARGET_FILE })
  );
  if (docSym.kind === "ok") checkString("lsp_document_symbol", docSym.value);
  else checkString("lsp_document_symbol", docSym.detail);

  // 5) lsp_workspace_symbol — 空 query 拉全量符号。
  const wsSym = await safeCall("lsp_workspace_symbol", () =>
    get("lsp_workspace_symbol").handler({ file: TARGET_FILE })
  );
  if (wsSym.kind === "ok") checkString("lsp_workspace_symbol", wsSym.value);
  else checkString("lsp_workspace_symbol", wsSym.detail);

  // 6) lsp_go_to_implementation — getClient 应有实现。
  const impl = await safeCall("lsp_go_to_implementation", () =>
    get("lsp_go_to_implementation").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  if (impl.kind === "ok") checkString("lsp_go_to_implementation", impl.value);
  else checkString("lsp_go_to_implementation", impl.detail);

  // 7) lsp_prepare_call_hierarchy — 函数定义处可建调用层级。
  const prep = await safeCall("lsp_prepare_call_hierarchy", () =>
    get("lsp_prepare_call_hierarchy").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  if (prep.kind === "ok") checkString("lsp_prepare_call_hierarchy", prep.value);
  else checkString("lsp_prepare_call_hierarchy", prep.detail);

  // 8) lsp_incoming_calls — 多步：prepare 后 forward incomingCalls。
  const inc = await safeCall("lsp_incoming_calls", () =>
    get("lsp_incoming_calls").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  if (inc.kind === "ok") checkString("lsp_incoming_calls", inc.value);
  else checkString("lsp_incoming_calls", inc.detail);

  // 9) lsp_outgoing_calls — 多步：prepare 后 forward outgoingCalls。
  const out = await safeCall("lsp_outgoing_calls", () =>
    get("lsp_outgoing_calls").handler({
      file: TARGET_FILE,
      line: TARGET_LINE,
      character: TARGET_CHAR,
    })
  );
  if (out.kind === "ok") checkString("lsp_outgoing_calls", out.value);
  else checkString("lsp_outgoing_calls", out.detail);

  // 10) lsp_diagnostics — 真实文件诊断。tsserver 层经 typescript-language-server
  //     可能不实现 pull-diagnostics（Error -32601 Unhandled method），
  //     safeCall 会把该错误归为 FAIL 并打印原因。
  const diag = await safeCall("lsp_diagnostics", () =>
    get("lsp_diagnostics").handler({ file: DIAG_FILE })
  );
  if (diag.kind === "ok") {
    checkString(
      "lsp_diagnostics",
      diag.value,
      typeof diag.value === "string" && diag.value.includes("<diagnostics")
        ? "diagnostics XML"
        : "empty"
    );
  } else {
    checkString("lsp_diagnostics", diag.detail);
  }

  console.log(
    `\n${passed === total ? "all green" : "failures"} (${passed}/${total})`
  );
  process.exit(passed === total ? 0 : 1);
}

run().catch((err) => {
  console.error("lsp-probe crashed:", err);
  process.exit(1);
});
