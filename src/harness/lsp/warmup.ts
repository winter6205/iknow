/**
 * LSP warmup layer.
 *
 * **Responsibility**: on the **first** language-server tool call, fire-and-forget
 * prewarming — probe file extensions under `ctx.directory` (≡ sandboxRoot,
 * SSOT in build-engine.ts's assembly comment), pre-spawn every LSP server any
 * extension hits, removing the spawn + initialize cold start (seconds for
 * tsserver) from later `lsp_*` calls of the same family.
 *
 * **Trigger seam**: no warmup / no spawn during assembly; the seam is the
 * `LoopEngineDeps.registry` view wrapped by `withLazyLspWarmup` — assembly
 * only consumes `list()`, while every model tool call must resolve by name
 * through `registry.get(name)` once (wave classification in `loop-engine.ts`
 * + `validateCall` on the executor side). The first hit of a language-server
 * tool name arms it (one-shot latch, once per assembly), fire-and-forget
 * without blocking that call.
 *
 * **Design constraints**:
 *   - **fire-and-forget**: `startLspWarmup` returns synchronously, prewarming
 *     runs serially in the background; a blanket try/catch swallows errors
 *     (stderr trail) and never blocks or breaks the main path.
 *   - **serial, no early exit**: traverse **all** servers with an extension
 *     sample in `SERVERS` declaration order (TS floor first) — in mixed-language
 *     projects (ts+py etc.) each server may carry the first cold start; a
 *     single server failure (undefined / throw) only leaves a trail and
 *     continues to the next.
 *   - **ensureOpen sample**: after getClient succeeds, ensureOpen the sample
 *     file — prewarming server-side project loading (tsserver builds no
 *     project for unopened files), so the first lsp_* call skips project load
 *     too. The sample is what warmup itself scanned (disk state is current);
 *     a single-file failure is try/caught, trailed, and continues.
 *   - No candidate files at all (empty dir / all skipped) → no error, but the
 *     outcome records `skipped` (no human-readable stderr line; the
 *     machine-readable snapshot must be queryable).
 *   - **Observable outcome**: after settle, `getWarmupOutcome()` gives a
 *     read-only snapshot — the human-readable stderr trace stays in place;
 *     the snapshot is the machine-readable increment for callers (root-cause
 *     investigation / diagnostics), ending "failure that looks like success".
 *
 * **Cancellation semantics**: this module only builds connections via
 * `getClient` and never terminates any server subprocess.
 */
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { LspCtx, LspServerInfo } from "./types.js";
import type { RegistryImpl } from "../tools/registry.js";
import { SERVERS } from "./server.js";
import { getClient } from "./client.js";
import { SYMBOL_QUERY_TOOL_NAMES } from "../aci/tools/symbol.js";
import { SYMBOL_MUTATE_TOOL_NAMES } from "../aci/tools/symbol-mutate.js";

/** Directory names skipped by the warmup scan (deps / build output / metadata — never project source samples). */
const WARMUP_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".iknow",
]);

/** Recursion depth cap: 2 levels reach typical top-level sources (src/<file>) while bounding scan cost. */
const WARMUP_MAX_DEPTH = 2;

/**
 * Outcome of the latest warmup.
 *
 * Semantics:
 *   - `ok`: every server with an extension sample had `getClient` succeed and
 *     its sample `ensureOpen` complete — `pinnedSamples` non-empty, `failures`
 *     always empty.
 *   - `partial`: at least one server prewarm failed (spawn failure normalized
 *     to undefined / throw), yet the overall flow finished — `failures`
 *     non-empty, `pinnedSamples` lists the ones that worked.
 *   - `skipped`: nothing to prewarm or the prewarm never finished — no sample
 *     directories, readdir degraded to an empty scan, whole run threw.
 *     `pinnedSamples` always empty, `failures` non-empty.
 */
export type WarmupOutcome = {
  readonly status: "ok" | "partial" | "skipped";
  /** (server, sample file) pairs that truly got a live client and a successful ensureOpen. */
  readonly pinnedSamples: ReadonlyArray<{
    readonly serverId: string;
    readonly file: string;
  }>;
  /** Failure reasons (server id / scan + whole-run failure verbatim). Non-empty whenever not `ok`. */
  readonly failures: ReadonlyArray<string>;
};

/**
 * Snapshot of the latest warmup outcome; `undefined` = not yet settled or
 * warmup never ran in this process. Read-only, never throws — settled is
 * defined as this field first becoming non-`undefined`.
 */
let warmupOutcome: WarmupOutcome | undefined;

/** Read the latest warmup outcome. Never throws; unsettled → `undefined`. */
export function getWarmupOutcome(): WarmupOutcome | undefined {
  return warmupOutcome;
}

/**
 * Start LSP warmup (fire-and-forget). Armed by `withLazyLspWarmup` at the
 * first language-server tool-name resolution, never called during assembly;
 * returns synchronously, running internally async with a blanket catch.
 */
export function startLspWarmup(ctx: LspCtx): void {
  void warmup(ctx);
}

/**
 * The language-server tool-name family: taken directly from the tool-layer
 * SSOT (10 symbol-query + 5 symbol-mutation tools), no local re-listing —
 * every extra copy of a name list is a drift point (a 16th symbol tool would
 * be silently missing from a local copy, so the arm never fires and calls
 * still pay the cold start).
 *
 * No cycle at runtime (verified, not inferred): this module's runtime edges
 * are only `./server.js` and `./client.js` (`./types.js` /
 * `../tools/registry.js` are `import type`, not in the runtime graph);
 * `symbol.ts` / `symbol-mutate.ts`'s runtime closures reach only
 * `aci/tools/lsp.js` / `symbol-resolver.js` / `lsp/client.js` /
 * `lsp/server.js` / `errors.js` / `lsp/language.js`, **not this module**.
 * Neither direction cycles, so this import introduces none. The `lsp_` prefix
 * family (the coordinate surface in `lsp.ts`, instrumented by `probe:lsp`) is
 * matched separately by prefix in `isLanguageServerToolName`, not in these
 * two arrays.
 */
const LANGUAGE_SERVER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...SYMBOL_QUERY_TOOL_NAMES,
  ...SYMBOL_MUTATE_TOOL_NAMES,
]);

/**
 * Whether a name belongs to the language-server tool family: the 15
 * model-facing symbol tools (exact names) + the `lsp_` prefix (the coordinate
 * surface has retired from the model face, but `lsp.ts` remains the real-stack
 * instrument for `probe:lsp` — prefix hit arms it, extra coverage is free).
 */
function isLanguageServerToolName(name: string): boolean {
  return LANGUAGE_SERVER_TOOL_NAMES.has(name) || name.startsWith("lsp_");
}

/**
 * Lazy warmup trigger seam: wraps a Registry view handed to
 * `LoopEngineDeps.registry` and arms warmup once when the **first** `get(name)`
 * hits the language-server tool family.
 *
 * Why this seam (the minimal one):
 *   - assembly only consumes `list()` (prompt tool table / knownToolNames) and
 *     never passes through this function's `get` — no arm at assembly end;
 *   - every model tool call must resolve by name once (`loop-engine.ts` wave
 *     classification + `executor.ts` `validateCall`), so `get` is the sole
 *     mandatory point proving "this kind of call actually happened", and it
 *     naturally carries the tool name — no reachability set reverse-engineered
 *     from handlers / the registry;
 *   - not placed in `client.ts`'s `getClientDetailed`: warmup itself enters
 *     through `getClient` (recursion), and notifier's `invalidate` also uses
 *     `getClient` — a plain `edit_file` write would mis-arm, and that is not a
 *     language-server tool call.
 *
 * `get` is resolved multiple times per call (classification + validation), so
 * the latch is one-shot: each assembly arms at most once. `getValidator`
 * passes through unchanged (`RegistryImpl` structurally compatible).
 */
export function withLazyLspWarmup(
  inner: RegistryImpl,
  ctx: LspCtx
): RegistryImpl {
  let armed = false;
  return Object.freeze({
    list: () => inner.list(),
    get: (name: string) => {
      if (!armed && isLanguageServerToolName(name)) {
        armed = true;
        startLspWarmup(ctx);
      }
      return inner.get(name);
    },
    // Structurally compatible: pass through RegistryImpl's third method
    // unchanged (this seam only cares about `get`).
    getValidator: (name: string) => inner.getValidator(name),
  });
}

async function warmup(ctx: LspCtx): Promise<void> {
  // Keep the two failure classes separate rather than merged then
  // positionally subtracted: server-level failures feed the [lsp-warmup]
  // partial trace, while scan degradation already wrote its own readdir line
  // inside collectSampleFiles — merging would print the same text twice on
  // stderr (the scan failure re-joined by the partial line).
  const serverFailures: string[] = [];
  // Scan degradation already wrote stderr inside collectSampleFiles; declared
  // outside the try so the outer catch's whole-run snapshot can carry it too
  // (otherwise the merged view only exists on the success path).
  let scanFailures: string[] = [];
  const pinnedSamples: Array<{ serverId: string; file: string }> = [];
  try {
    // Scan failure is normalized via collectSampleFiles into empty samples +
    // one failure (same-source stderr trail) — readdir degradation no longer
    // lives only in the human trace; every non-ok snapshot carries failures.
    const scan = await collectSampleFiles(ctx.directory, WARMUP_MAX_DEPTH);
    scanFailures = scan.failures;
    const samples = scan.samples;
    for (const server of SERVERS) {
      const sample = samples.find((file) => matchesServer(server, file));
      if (!sample) continue; // no extension sample for this server in this project → skip
      try {
        // Prewarm every hit server serially (no early exit): in mixed-language
        // projects (ts+py etc.) each server may carry the first lsp_* call's
        // cold start. After getClient succeeds, ensureOpen the sample —
        // prewarming server-side project loading; the sample is a disk file
        // warmup itself scanned, so didOpen reads current disk state.
        const client = await getClient(ctx, sample, { server });
        // EXIT: getClient normalizes spawn failure to undefined (no throw).
        // This branch used to continue silently — a prime candidate for
        // "warmup looked successful but pinned nothing"; now record a failure
        // before continuing.
        if (!client) {
          serverFailures.push(`${server.id}: no client available`);
          continue;
        }
        await client.ensureOpen(sample);
        pinnedSamples.push({ serverId: server.id, file: sample });
      } catch (err) {
        // EXIT: a single server's spawn/ensureOpen throw → record in failures
        // and continue to the next; getClient already normalized spawn failure
        // to undefined, so this guards unexpected throws.
        serverFailures.push(
          `${server.id}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    settleOutcome(serverFailures, scanFailures, pinnedSamples, ctx.directory);
  } catch (err) {
    // EXIT: whole prewarm failed (unreadable dir etc.) → one stderr line +
    // snapshot, no throw; the first lsp_* call self-heals via normal getClient.
    const msg = err instanceof Error ? err.message : String(err);
    settle({
      status: "skipped",
      pinnedSamples,
      failures: [...serverFailures, ...scanFailures, msg],
    });
    process.stderr.write(`[lsp-warmup] skipped: ${msg}\n`);
  }
}

/** Write the outcome snapshot: the sole settle point (settled = first non-undefined). */
function settle(outcome: WarmupOutcome): void {
  warmupOutcome = outcome;
}

/**
 * Settle the outcome: derive status, add the "no samples in the directory at
 * all" failure (snapshot contract: non-ok always has failures), and write the
 * human-readable partial trace line. Extracted from warmup's body to keep
 * branch density down.
 *
 * The two failure classes arrive as separate params (not merged then
 * subtracted): the snapshot wants everything, but the partial trace should
 * only carry server-level failures — scan degradation already wrote its own
 * stderr line in collectSampleFiles, and joining it again in the partial line
 * would duplicate the same text.
 */
function settleOutcome(
  serverFailures: string[],
  scanFailures: string[],
  pinnedSamples: WarmupOutcome["pinnedSamples"],
  directory: string
): void {
  const failures = [...serverFailures, ...scanFailures];
  if (pinnedSamples.length === 0 && failures.length === 0) {
    failures.push(
      `no sample files matched any configured server under ${directory}`
    );
  }
  settle({
    // ok = no failures and at least one pinned sample; failures but some
    // samples still pinned = partial (some servers didn't come up);
    // everything else (no samples / all failed) = skipped.
    status:
      failures.length === 0 && pinnedSamples.length > 0
        ? "ok"
        : pinnedSamples.length > 0
          ? "partial"
          : "skipped",
    pinnedSamples,
    failures,
  });
  // Human trace: written whenever a server attempt failed (the pre-change
  // semantics, including the all-failed branch); scan-degradation / no-sample
  // failures only enter the snapshot, not a duplicated stderr write.
  if (serverFailures.length > 0) {
    process.stderr.write(
      `[lsp-warmup] partial: ${serverFailures.join("; ")}\n`
    );
  }
}

/**
 * Collect candidate sample files: readdir withFileTypes, recurse at most
 * `depth` levels, skip WARMUP_SKIP_DIRS and hidden directories. A readdir
 * failure is treated as an empty directory (degradation, no throw) — the
 * degradation reason returns alongside the samples for the outcome snapshot
 * to name it (stderr still written).
 */
async function collectSampleFiles(
  dir: string,
  depth: number
): Promise<{ samples: string[]; failures: string[] }> {
  // Explicit Dirent (default name generic string): ReturnType<typeof readdir>
  // would pick readdir's Buffer overload, mismatching the
  // `{ withFileTypes: true }` argument used here.
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // EXIT: readdir failed (unreadable / deleted dir) → degrade to "no
    // candidate samples" (no throw), but report the reason as a failure so
    // the snapshot yields a non-ok outcome; the [lsp-warmup] readdir failed
    // line is also written for humans reading logs. The first lsp_* call
    // self-heals through the normal getClient path.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[lsp-warmup] readdir failed for ${dir}: ${msg}\n`);
    return { samples: [], failures: [`readdir failed for ${dir}: ${msg}`] };
  }
  const samples: string[] = [];
  const failures: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (WARMUP_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      if (depth > 0) {
        const nested = await collectSampleFiles(full, depth - 1);
        samples.push(...nested.samples);
        failures.push(...nested.failures);
      }
    } else if (entry.isFile()) {
      samples.push(full);
    }
  }
  return { samples, failures };
}

/** File extension (extension-less falls back to full filename, same semantics as server.ts resolveServer). */
function matchesServer(server: LspServerInfo, file: string): boolean {
  const ext = path.extname(file) || path.basename(file);
  return server.extensions.includes(ext);
}
