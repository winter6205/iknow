/**
 * LSP probe — end-to-end smoke test for spec 251-lsp-tool: walks the
 * PROBE_TARGETS fixture table against real language servers through the
 * production stack.
 *
 * Responsibility: a language-agnostic shell that goes through the ACI tool
 * factory `createLspToolSet` and the real path (production `SERVERS` picks the
 * server by serverId → `getClient` in client.ts → server.spawn launches the
 * real language server + vscode-jsonrpc client trio), running the 9 ops +
 * lsp_diagnostics per `--lang` target:
 *   - 8 position ops + 2 call-hierarchy ops + lsp_diagnostics = 10 tools.
 *   - Handler contract: every result is a plain string; assert non-empty and
 *     NOT the no-server sentinel
 *     `"(no LSP server available for file)"` (that sentinel = the server never
 *     spawned → probe FAIL).
 *   - lsp_definition targets the fixture position and must name the target
 *     file (a real symbol hit).
 *
 * `--lang` parameterization (typescript/python/yaml/json/dockerfile;
 * typescript default):
 *   - server picked from production `SERVERS` via
 *     `PROBE_TARGETS[lang].serverId` (never hardcoded).
 *   - target from `PROBE_TARGETS[lang].targetFile`; yaml/python/dockerfile are
 *     fixtures (`fixture` present) written at runtime into
 *     `.iknow/probe-lsp/<lang>/` (gitignored) — no repo-root pollution, no
 *     mistaking them for deployment files.
 *
 * No manual didOpen: the handler layer (client.ensureOpen) already does
 * per-file idempotent didOpen; the probe exercises only the tool factory and
 * real client end to end.
 *
 * Capability trimming: non-TS languages have provider gaps; running every op
 * blindly would fail with MethodNotFound (`Unhandled method <method>`). The
 * probe self-adapts with MethodNotFound-skip: each op still executes; only
 * results that are MethodNotFound (server lacks the method — e.g.
 * yaml-language-server's references / workspaceSymbol / implementation /
 * callHierarchy) are skipped as capability gaps (printed `skipped`, excluded
 * from passed/total). All other failures (empty return / no-server sentinel /
 * other RPC errors) still FAIL.
 *
 * Both MethodNotFound paths are treated alike (spec 251-lsp-tool: initialize
 * capability advertisement + missing-method sentinel): the tool layer converts
 * `-32601` / explicit `false` into a sentinel string it RETURNS, so safeCall
 * sees `ok` + sentinel rather than an error; the probe applies the same skip
 * semantics to the sentinel (`ok` branch) and to escaped `Unhandled method`
 * RPC errors (`err` branch). Detection is imported from src
 * (`isMethodNotFoundSentinel` / `isMethodNotFoundError`) — never copy the
 * wording here.
 *
 * Rejected alternatives: a hardcoded skipOps table (rots once a server upgrade
 * adds the method) and trimming by `initialize` capability declarations
 * (typescript-language-server was measured to NOT declare
 * callHierarchyProvider yet implements call hierarchy — declaration-based
 * trimming would break the TS 10/10 baseline; MethodNotFound-skip satisfies
 * both: TS call hierarchy really runs, non-TS gaps auto-skip).
 *
 * Exit code: passed === total ? 0 : 1 (mirrors sandbox-probe.ts).
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

/** Accepted `--lang` values → PROBE_TARGETS keys. */
const LANGS = ["typescript", "python", "yaml", "json", "dockerfile"] as const;
type Lang = (typeof LANGS)[number];

function parseLang(argv: string[]): Lang {
  // Accept both `--lang=X` and `--lang X`: `npm run probe:lsp -- --lang python`
  // passes them as two separate argv entries; direct calls usually use --lang=python.
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
  return "typescript"; // TS default preserves the pre-existing contract.
}

/** Fixture root: `.iknow/probe-lsp/<lang>/` (gitignored, never mistaken for deployment files). */
function fixtureRoot(ctxDirectory: string, lang: Lang): string {
  return path.join(ctxDirectory, ".iknow", "probe-lsp", lang);
}

/**
 * Resolve the probe target: no `fixture` → return the absolute path directly
 * (real repo file); with `fixture` → write it (plus rootMarkers) into
 * `.iknow/probe-lsp/<lang>/` and return the absolute path.
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

/** Assert helper: a verdict classified as pass → count into passed/total and print ✓. */
function reportPass(name: string, extra?: string): void {
  total++;
  passed++;
  console.log(`✓ ${name}${extra ? ` (${extra})` : ""}`);
}

/**
 * Assert helper: a FAIL verdict → count into total, print ✗ + reason.
 *
 * The err branch's detail already carries the `ERROR: ` prefix from
 * classifyProbeResult (fix for probe false positives): previously an error
 * message wrapped by safeCall was judged as an ordinary string, so anything
 * non-empty passed ✓ and real -32602-style errors were misreported as
 * passes. RPC errors must FAIL explicitly.
 */
function reportFail(name: string, detail: string): void {
  total++;
  console.log(`✗ ${name}${detail ? ` (${detail})` : ""}`);
}

/** Normalized safeCall result: ok value / err detail + raw error (needed for capability-gap detection). */
export type ProbeCallResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | {
      readonly kind: "err";
      readonly detail: string;
      readonly error: unknown;
    };

/** Verdict for one op: pass (counts toward passed/total) / skip (capability gap) / fail. */
export type ProbeVerdict =
  | { readonly kind: "pass"; readonly value: unknown }
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "fail"; readonly detail: string };

/**
 * Core per-op verdict (pure function, unit-testable) — the two MethodNotFound
 * paths of spec 251-lsp-tool (capability advertisement + missing-method
 * sentinel) converge here:
 *
 *   - **ok + missing-method sentinel**: the tool layer turned `-32601` /
 *     explicit `false` into a sentinel string it RETURNS (no throw), so
 *     safeCall sees it as a success value → skip as well.
 *   - **err + MethodNotFound**: paths that bypassed
 *     requestOrMethodNotFoundSentinel (or errors escaping the sentinel check)
 *     still surface as RPC errors → skip.
 *
 * Everything else unchanged: ok passes only if it is a non-empty string and
 * not the no-server sentinel; err always fails. Sentinel detection is reused
 * from src (`isMethodNotFoundSentinel` / `isMethodNotFoundError`) instead of
 * copying literals — if the wording changes, the probe can't silently drift.
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
    // Layered failure sentinels (no-server / no-root / spawn-failed): judged
    // via the src-side helper, not one hardcoded string — the sentinel wording
    // has evolved and a stale literal would silently misjudge as ✓.
    if (isLspFailureSentinel(result.value)) {
      return { kind: "fail", detail: "LSP server unavailable" };
    }
    return { kind: "pass", value: result.value };
  }
  // Match both the numeric code (-32601) and the framework fallback text
  // (`Unhandled method <m>`); the detail prefix check also covers non-Error
  // throws (isMethodNotFoundError only recognizes objects).
  if (
    isMethodNotFoundError(result.error) ||
    result.detail.startsWith("Unhandled method ")
  ) {
    return { kind: "skip", reason: "MethodNotFound — server 未实现该方法" };
  }
  return { kind: "fail", detail: `ERROR: ${result.detail}` };
}

/**
 * Unified reporting: safeCall ok/err result → pass / fail / MethodNotFound-skip.
 *
 * Every op really executes, then dispatches via classifyProbeResult; skip is
 * excluded from total: it is neither a failed check nor a reduction of what
 * should pass — ops outside the server's capability are not part of the
 * probe's assertions, and passed === total judges only ops actually checked.
 *
 * Note: the `extra` hit-assertion for lsp_definition / lsp_hover (result must
 * name the target file) applies only on the pass branch; skipped ops never
 * reach it.
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
 * Wrap one call in try/catch, normalizing RPC errors into `{detail, error}` so
 * later reporting can print the reason (a raw ResponseError would take down
 * the whole probe); the raw error travels with the result so capability
 * detection can read `code` (-32601).
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

  // Fixture targets (yaml/python/dockerfile) are generated at runtime into
  // .iknow/probe-lsp/; real repo files (typescript/json) are used directly.
  const target = await resolveTargetFile(ctx.directory, lang);
  const { line, char } = t;
  // Diagnostics target: same file as the op target (language-dependent; the
  // old TS-only probe used types.ts).
  const diagFile = target;

  // Production handshake: spawnClient (client.ts) already sends the
  // `initialized` notification after the initialize response (pyright requires
  // it). The probe must not send it again — on a cached client (root+id reuse)
  // that would double-init.
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

  // 1) lsp_definition — points at the fixture position; assert the result names the target file.
  // No manual didOpen: handler-level ensureOpen opens the file and builds the project.
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

  // 2) lsp_references — locations referencing the target symbol.
  const refs = await safeCall("lsp_references", () =>
    get("lsp_references").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_references", refs);

  // 3) lsp_hover — hover at the target symbol should return a type signature.
  const hover = await safeCall("lsp_hover", () =>
    get("lsp_hover").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_hover", hover);

  // 4) lsp_document_symbol — file-level symbols should be returned.
  const docSym = await safeCall("lsp_document_symbol", () =>
    get("lsp_document_symbol").handler({ file: target })
  );
  maybeReport("lsp_document_symbol", docSym);

  // 5) lsp_workspace_symbol — empty query pulls the full symbol list.
  const wsSym = await safeCall("lsp_workspace_symbol", () =>
    get("lsp_workspace_symbol").handler({ file: target })
  );
  maybeReport("lsp_workspace_symbol", wsSym);

  // 6) lsp_go_to_implementation — target symbol should have an implementation.
  const impl = await safeCall("lsp_go_to_implementation", () =>
    get("lsp_go_to_implementation").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_go_to_implementation", impl);

  // 7) lsp_prepare_call_hierarchy — call hierarchy can be prepared at the target's definition site.
  const prep = await safeCall("lsp_prepare_call_hierarchy", () =>
    get("lsp_prepare_call_hierarchy").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_prepare_call_hierarchy", prep);

  // 8) lsp_incoming_calls — multi-step: prepare then forward incomingCalls.
  const inc = await safeCall("lsp_incoming_calls", () =>
    get("lsp_incoming_calls").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_incoming_calls", inc);

  // 9) lsp_outgoing_calls — multi-step: prepare then forward outgoingCalls.
  const out = await safeCall("lsp_outgoing_calls", () =>
    get("lsp_outgoing_calls").handler({
      file: target,
      line,
      character: char,
    })
  );
  maybeReport("lsp_outgoing_calls", out);

  // 10) lsp_diagnostics — some servers skip pull diagnostics and push via
  //     publishDiagnostics, or return empty XML; empty XML is not a failure
  //     (push timing cannot be guaranteed from the probe side), only sentinels
  //     are excluded.
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

// Run the probe only as an entry point — unit tests import this module for the
// pure functions (classifyProbeResult) and must not spawn real language servers.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  run().catch((err) => {
    console.error("lsp-probe crashed:", err);
    process.exit(1);
  });
}
