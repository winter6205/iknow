/**
 * LSP 探针 — spec 251-lsp-tool + spec 302-lsp-multilang（§ probe 参数化，#307）。
 *
 * 职责：语言无关通用壳，通过 ACI 工具工厂 `createLspToolSet` 走**真实栈**
 * （生产 `SERVERS` 按 serverId 选 server → client.ts `getClient` → server.spawn
 * spawn 真实语言 server + vscode-jsonrpc 客户端三件套），对 `PROBE_TARGETS`
 * 夹具表里每个 `--lang` 的目标跑 9 件 operation + lsp_diagnostics 烟测：
 *   - 8 件 position 操作 + 2 件 call-hierarchy 后段 + lsp_diagnostics = 10 件工具。
 *   - 每件 handler 契约 Y1：返回纯字符串；断言非空且 **不是** 无 server 哨兵
 *     `"(no LSP server available for file)"`（该哨兵 = server 未 spawn，探针判 FAIL）。
 *   - lsp_definition 指向夹具位置，断言结果含目标文件名（真实 symbol 命中）。
 *
 * `--lang` 参数化（typescript/python/yaml/json/dockerfile，默认 typescript 保底）：
 *   - server 从生产 `SERVERS` 按 `PROBE_TARGETS[lang].serverId` 选（不硬编码）。
 *   - 目标文件：`PROBE_TARGETS[lang].targetFile`；yaml/python/dockerfile 是夹具
 *     （`fixture` 存在），probe 运行时写入 `.iknow/probe-lsp/<lang>/`（gitignore）
 *     再作为目标 — 不污染 repo 根、不误当真实部署文件。
 *
 * 不再做手工 didOpen：handler 层（client.ensureOpen）已内置 per-file 幂等
 * didOpen，探针只用工具工厂与真实 client 完成全链路校验。
 *
 * **能力裁剪（spec 302 § probe，T6）**：非 TS 语言各有 provider 能力缺口，
 * 直接跑会以 MethodNotFound（`Unhandled method <method>`）失败。本探针用
 * **MethodNotFound-skip** 自适应：每件 op 照常执行；仅当结果是 MethodNotFound
 * 类（server 未实现该方法，如 yaml-language-server 的 references /
 * workspaceSymbol / implementation / callHierarchy）时按「server 能力缺口」
 * 跳过（打印 `skipped`，不计入 passed/total），其余失败（空返回 / no-server
 * 哨兵 / 其他 RPC error）仍判 FAIL。
 *
 * 两条 MethodNotFound 路径同判（spec 251「initialize 能力广告 + 缺方法哨兵」）：
 * 工具层已把 `-32601` / 显式 `false` 转成缺方法哨兵字符串**返回**，safeCall
 * 看到的是 `ok` + 哨兵而非 error detail；探针侧对哨兵（`ok` 分支）与逃逸的
 * `Unhandled method` RPC error（`err` 分支）走同一 skip 语义。判定从 src 侧
 * import（`isMethodNotFoundSentinel` / `isMethodNotFoundError`），不复制文案。
 *
 * 不采用硬编码 skipOps 表（server 升级补实现后失配），也不采用
 * `initialize` capabilities 声明裁剪 —— typescript-language-server 实测
 * **不声明** callHierarchyProvider 却实现了 call hierarchy，纯声明裁剪会
 * 误伤 TS 10/10 保底；MethodNotFound-skip 两者都满足：TS call hierarchy
 * 照常真实执行，非 TS 缺口自动跳过。
 *
 * 退出码：passed === total ? 0 : 1（对照 sandbox-probe.ts）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path, { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLspToolSet,
  isLspFailureSentinel,
  isMethodNotFoundSentinel,
} from "../src/harness/aci/tools/lsp.js";
import type { AciToolDef } from "../src/harness/aci/types.js";
import { isMethodNotFoundError } from "../src/harness/lsp/client.js";
import { SERVERS } from "../src/harness/lsp/server.js";
import { PROBE_TARGETS } from "./lsp-probe-targets.js";

const __filename = fileURLToPath(import.meta.url);

/** `--lang` 可选值 → PROBE_TARGETS key。 */
const LANGS = ["typescript", "python", "yaml", "json", "dockerfile"] as const;
type Lang = (typeof LANGS)[number];

function parseLang(argv: string[]): Lang {
  // 兼容 `--lang=X` 与 `--lang X` 两种透传形式（npm run probe:lsp -- --lang python
  // 会把 `--lang` 与 `python` 作为两个独立 argv；直接调用时常用 `--lang=python`）。
  const eq = argv.find((a) => a.startsWith("--lang="));
  const raw = eq?.slice("--lang=".length);
  let resolved: string | undefined = raw;
  if (resolved === undefined) {
    const idx = argv.indexOf("--lang");
    if (idx !== -1 && idx + 1 < argv.length) resolved = argv[idx + 1];
  }
  if (resolved !== undefined) {
    if (!(LANGS as readonly string[]).includes(resolved)) {
      console.error(
        `✗ unknown --lang "${resolved}" (expected one of: ${LANGS.join(", ")})`
      );
      process.exit(1);
    }
    return resolved as Lang;
  }
  return "typescript"; // 默认 TS 保底（现有契约）。
}

/** 夹具目录根：`.iknow/probe-lsp/<lang>/`（gitignore，不误当部署文件）。 */
function fixtureRoot(ctxDirectory: string, lang: Lang): string {
  return path.join(ctxDirectory, ".iknow", "probe-lsp", lang);
}

/**
 * 解析探针目标：无 `fixture` → 直接返回绝对路径（真实仓库文件）；
 * 有 `fixture` → 写入 `.iknow/probe-lsp/<lang>/`（含 rootMarkers）并返回绝对路径。
 */
async function resolveTargetFile(
  ctxDirectory: string,
  lang: Lang
): Promise<string> {
  const t = PROBE_TARGETS[lang];
  if (t.fixture === undefined) return t.targetFile;
  const dir = fixtureRoot(ctxDirectory, lang);
  await mkdir(dir, { recursive: true });
  for (const marker of t.rootMarkers ?? []) {
    await writeFile(path.join(dir, marker), "");
  }
  await writeFile(path.join(dir, t.targetFile), t.fixture);
  return path.join(dir, t.targetFile);
}

let passed = 0;
let total = 0;

/** 断言 helper：classifyProbeResult 判 pass 的结果 → 计入 passed/total 并打印 ✓。 */
function reportPass(name: string, extra?: string): void {
  total++;
  passed++;
  console.log(`✓ ${name}${extra ? ` (${extra})` : ""}`);
}

/**
 * 断言 helper：判 FAIL 的结果 → 计入 total 并打印 ✗ + 原因。
 *
 * err 分支的 detail 已由 classifyProbeResult 带上 `ERROR: ` 前缀（修复探针
 * 假阳性，#265 回归）：此前 safeCall 包出来的错误消息被当普通字符串判，只要
 * 非空即 ✓ → 真实返回 -32602 等错误被误报为通过。RPC error 必须显式判 FAIL。
 */
function reportFail(name: string, detail: string): void {
  total++;
  console.log(`✗ ${name}${detail ? ` (${detail})` : ""}`);
}

/** safeCall 归一化结果：ok 值 / err detail + 原始 error（能力缺口判定要用）。 */
export type ProbeCallResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | {
      readonly kind: "err";
      readonly detail: string;
      readonly error: unknown;
    };

/** 单件 op 的判定：pass（计入 passed/total）/ skip（能力缺口）/ fail。 */
export type ProbeVerdict =
  | { readonly kind: "pass"; readonly value: unknown }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "fail"; readonly detail: string };

/**
 * 单件 op 的判定核心（纯函数，可单测）—— spec 251「initialize 能力广告 +
 * 缺方法哨兵」的两条 MethodNotFound 路径在此合流：
 *
 *   - **ok + 缺方法哨兵**：工具层已把 `-32601` / 显式 `false` 转成哨兵字符串
 *     **返回**（不再抛错），safeCall 因此把它当成功结果看到 → 同样 skip。
 *   - **err + MethodNotFound**：未走 requestOrMethodNotFoundSentinel 的路径
 *     （或哨兵判定外的逃逸错误）仍以 RPC error 形态出现 → skip。
 *
 * 其余判定不变：ok 需非空字符串且非 no-server 哨兵才是 pass；err 恒 fail。
 * 哨兵判定从 src 侧复用（`isMethodNotFoundSentinel` / `isMethodNotFoundError`），
 * 不复制文案字面量 —— 文案改了探针不会悄悄失配。
 */
export function classifyProbeResult(result: ProbeCallResult): ProbeVerdict {
  if (result.kind === "ok") {
    if (isMethodNotFoundSentinel(result.value)) {
      return {
        kind: "skip",
        reason: "MethodNotFound sentinel — server 未实现该方法",
      };
    }
    if (typeof result.value !== "string") {
      return { kind: "fail", detail: `type=${typeof result.value}` };
    }
    if (result.value.length === 0) {
      return { kind: "fail", detail: "empty result" };
    }
    // 分层失败哨兵（no-server / no-root / spawn-failed，B3）—— 判定从 src 侧
    // 复用，不硬编码单一文案（分层文案演进过，旧字面量会静默漏判成 ✓）。
    if (isLspFailureSentinel(result.value)) {
      return { kind: "fail", detail: "LSP server unavailable" };
    }
    return { kind: "pass", value: result.value };
  }
  // 数字码（-32601）与框架兜底文案（`Unhandled method <m>`）双判；detail 的
  // 前缀检查兜住非 Error 抛出（isMethodNotFoundError 只认对象）。
  if (
    isMethodNotFoundError(result.error) ||
    result.detail.startsWith("Unhandled method ")
  ) {
    return { kind: "skip", reason: "MethodNotFound — server 未实现该方法" };
  }
  return { kind: "fail", detail: `ERROR: ${result.detail}` };
}

/**
 * 统一 report 分发：safeCall 的 ok/err 结果 → pass / fail / MethodNotFound-skip。
 *
 * 每件 op 先**真实执行**再按 classifyProbeResult 分派；skip 不计入 total：
 * 不是检查失败，也不减少应过项数 —— server 能力缺口的 op 不属于探针断言
 * 范围，passed === total 只对**实际检查过的** op 判定。
 *
 * 注：lsp_definition / lsp_hover 的 `extra` 命中断言（含目标文件名）仅在
 * pass 分支生效；skip 的 op 不会走到 extra。
 */
function maybeReport(
  name: string,
  result: ProbeCallResult,
  extra?: (value: unknown) => string | undefined
): void {
  const verdict = classifyProbeResult(result);
  switch (verdict.kind) {
    case "pass":
      reportPass(name, extra?.(verdict.value));
      return;
    case "skip":
      console.log(`- ${name} (skipped: ${verdict.reason})`);
      return;
    case "fail":
      reportFail(name, verdict.detail);
  }
}

/**
 * 包一层 try/catch 把单件操作的 RPC error 归一化为 `{detail, error}`，
 * 让后续判定打印原因（避免 ResponseError 把探针整进程打挂）；原始 error
 * 随结果返回，供能力缺口判定读 `code`（-32601）。
 */
async function safeCall(
  name: string,
  call: () => Promise<unknown>
): Promise<ProbeCallResult> {
  try {
    const v = await call();
    return { kind: "ok", value: v };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: "err",
      detail: msg.split("\n")[0].slice(0, 160),
      error: err,
    };
  }
}

async function run(): Promise<void> {
  const lang = parseLang(process.argv);
  const ctx = {
    directory: resolve(fileURLToPath(new URL("..", import.meta.url))),
  };
  const t = PROBE_TARGETS[lang];
  const server = SERVERS.find((s) => s.id === t.serverId);
  if (!server) {
    console.error(`✗ no SERVERS entry for lang=${lang} serverId=${t.serverId}`);
    process.exit(1);
  }

  console.log(`lsp-probe [--lang ${lang}] server=${t.serverId}`);

  // 夹具目标：yaml/python/dockerfile 运行时生成（.iknow/probe-lsp/），
  // 真实仓库文件（typescript/json）直接用。
  const target = await resolveTargetFile(ctx.directory, lang);
  const { line, char } = t;
  // diagnostics 探针目标：同一目标文件（语言相关；TS 旧探针用 types.ts）。
  const diagFile = target;

  // 生产握手：spawnClient（client.ts）在 initialize 响应后已补发 `initialized`
  // 通知（T6 生产正确性修复，pyright 需要）。探针不再另行补发 —— 否则缓存
  // client（root+id 复用）上会 double-init。
  const tools = createLspToolSet(ctx);
  const byName = new Map(tools.map((x) => [x.name, x]));
  const get = (n: string): AciToolDef => {
    const tool = byName.get(n);
    if (!tool) {
      total++;
      console.log(`✗ ${n} (tool not exported)`);
    }
    return tool as AciToolDef;
  };

  // 1) lsp_definition — 指向夹具位置，断言含目标文件名。
  // 注：不再手工 didOpen；handler 层 ensureOpen 负责打开目标文件建 project。
  const def = await safeCall("lsp_definition", () =>
    get("lsp_definition").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_definition", def, (value) =>
    typeof value === "string" && value.includes(path.basename(target))
      ? `hit ${path.basename(target)}`
      : `no ${path.basename(target)}`
  );

  // 2) lsp_references — 目标符号被引用的位置。
  const refs = await safeCall("lsp_references", () =>
    get("lsp_references").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_references", refs);

  // 3) lsp_hover — 目标符号定义处应返回类型签名。
  const hover = await safeCall("lsp_hover", () =>
    get("lsp_hover").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_hover", hover);

  // 4) lsp_document_symbol — 文件级符号应有返回。
  const docSym = await safeCall("lsp_document_symbol", () =>
    get("lsp_document_symbol").handler({ file: target })
  );
  maybeReport("lsp_document_symbol", docSym);

  // 5) lsp_workspace_symbol — 空 query 拉全量符号。
  const wsSym = await safeCall("lsp_workspace_symbol", () =>
    get("lsp_workspace_symbol").handler({ file: target })
  );
  maybeReport("lsp_workspace_symbol", wsSym);

  // 6) lsp_go_to_implementation — 目标符号应有实现。
  const impl = await safeCall("lsp_go_to_implementation", () =>
    get("lsp_go_to_implementation").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_go_to_implementation", impl);

  // 7) lsp_prepare_call_hierarchy — 目标符号定义处可建调用层级。
  const prep = await safeCall("lsp_prepare_call_hierarchy", () =>
    get("lsp_prepare_call_hierarchy").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_prepare_call_hierarchy", prep);

  // 8) lsp_incoming_calls — 多步：prepare 后 forward incomingCalls。
  const inc = await safeCall("lsp_incoming_calls", () =>
    get("lsp_incoming_calls").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_incoming_calls", inc);

  // 9) lsp_outgoing_calls — 多步：prepare 后 forward outgoingCalls。
  const out = await safeCall("lsp_outgoing_calls", () =>
    get("lsp_outgoing_calls").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_outgoing_calls", out);

  // 10) lsp_diagnostics — 目标文件诊断。部分 server 不实现 pull diagnostics
  //     可能经 publishDiagnostics 推送，也可能返回空 XML — 空 XML 不判失败
  //     （diagnostics 推送是异步通知，探针侧无法保证时序），只排除哨兵。
  const diag = await safeCall("lsp_diagnostics", () =>
    get("lsp_diagnostics").handler({ file: diagFile })
  );
  maybeReport("lsp_diagnostics", diag, (value) =>
    typeof value === "string" && value.includes("<diagnostics")
      ? "diagnostics XML"
      : "empty"
  );

  console.log(
    `\n${passed === total ? "all green" : "failures"} (${passed}/${total})`
  );
  process.exit(passed === total ? 0 : 1);
}

// 只有被当作入口跑时才执行探针 —— 单测 import 本模块取纯函数
// （classifyProbeResult）时不得 spawn 真实 language server。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  run().catch((err) => {
    console.error("lsp-probe crashed:", err);
    process.exit(1);
  });
}
