/**
 * `iknow trace` CLI tests.
 *
 * Covers:
 *   - parseArgs recognizes the `trace` positional
 *   - flag parsing: --trace-out / --port / --host / --max-bytes / --no-open
 *   - defaults: port 24881, host 127.0.0.1, noOpen=false
 *   - bad --port throws a parse error
 *   - integration: startTraceServe from parsed opts → /api/v1/health live
 *   - parseArgs isolation between serve and trace (the sole surviving
 *     invariant from the original task breakdown)
 */
import { afterEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/parse-args.ts";
import {
  startTraceServe,
  type TraceListeningServer,
} from "../../src/traceserver/serve.ts";

let listening: TraceListeningServer | undefined;

afterEach(async () => {
  if (listening) await listening.close();
  listening = undefined;
});

// -- parseArgs: trace subcommand ----------------------------------------------

describe("parseArgs — `trace` subcommand", () => {
  it("parses trace --port 9999 --trace-out X.jsonl", () => {
    const parsed = parseArgs({
      argv: ["trace", "--port", "9999", "--trace-out", "X.jsonl"],
    });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.port, 9999);
    assert.equal(parsed.traceOut, "X.jsonl");
    assert.equal(parsed.host, "127.0.0.1");
  });

  it("defaults port to 8787 (probe mode) when --port omitted", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.port, 8787);
  });

  it("--separate defaults port to 24881 (#183 standalone, ADR-0020 D2.2)", () => {
    const parsed = parseArgs({ argv: ["trace", "--separate"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.port, 24881);
    assert.equal(parsed.separate, true);
  });

  // Sentinel regression: `iknow trace --port 8787` must honor the explicit
  // value, NOT be silently bumped to the default 24881 (which would collide
  // with serve's 8787 only by user-supplied coincidence).
  it("honors explicit --port 8787 instead of using default 24881", () => {
    const parsed = parseArgs({ argv: ["trace", "--port", "8787"] });
    assert.equal(parsed.port, 8787);
  });

  it("defaults host to 127.0.0.1 when --host omitted", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.host, "127.0.0.1");
  });

  it("parses --host", () => {
    const parsed = parseArgs({
      argv: ["trace", "--host", "0.0.0.0"],
    });
    assert.equal(parsed.host, "0.0.0.0");
  });

  it("parses --max-bytes as an integer", () => {
    const parsed = parseArgs({
      argv: ["trace", "--max-bytes", "1048576"],
    });
    assert.equal(parsed.command, "trace");
    const maxBytes = (parsed as unknown as { maxBytes?: number }).maxBytes;
    assert.equal(maxBytes, 1048576);
  });

  // --no-open boolean flag → ParsedCli.noOpen=true.
  it("parses --no-open → noOpen=true", () => {
    const parsed = parseArgs({
      argv: ["trace", "--no-open"],
    });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.noOpen, true);
  });

  it("noOpen defaults to false (auto-open default)", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.noOpen, false);
  });

  it("--no-open coexists with --port / --trace-out (no cross-flag contamination)", () => {
    const parsed = parseArgs({
      argv: ["trace", "--no-open", "--port", "9999", "--trace-out", "/tmp/t"],
    });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.noOpen, true);
    assert.equal(parsed.port, 9999);
    assert.equal(parsed.traceOut, "/tmp/t");
  });

  it("throws on bad --port", () => {
    assert.throws(
      () => parseArgs({ argv: ["trace", "--port", "abc"] }),
      /--port/
    );
  });
});

// -- integration: parsed opts → live server ----------------------------------

describe("iknow trace — integration", () => {
  it("parsed opts can drive startTraceServe and /api/v1/health returns iknow-trace", async () => {
    const parsed = parseArgs({
      argv: ["trace", "--port", "0"],
    });
    assert.equal(parsed.command, "trace");
    listening = await startTraceServe({
      host: parsed.host,
      port: parsed.port,
    });
    const res = await fetch(
      `http://${listening.host}:${listening.port}/api/v1/health`
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; service: string };
    assert.equal(body.ok, true);
    assert.equal(body.service, "iknow-trace");
  });

  // CLI-layer 404 contract: omitting --trace-out leaves traceOut undefined,
  // which startTraceServe surfaces as 404 not_found (no default-path fallback
  // on the reader side - env/default is write-side only).
  it("omitting --trace-out yields 404 not_found on /api/v1/traces", async () => {
    const parsed = parseArgs({ argv: ["trace", "--port", "0"] });
    assert.equal(parsed.traceOut, undefined);
    listening = await startTraceServe({
      traceOut: parsed.traceOut,
      host: parsed.host,
      port: parsed.port,
    });
    const res = await fetch(
      `http://${listening.host}:${listening.port}/api/v1/traces`
    );
    assert.equal(res.status, 404);
    const body = (await res.json()) as {
      error: { kind: string; message: string };
    };
    assert.equal(body.error.kind, "not_found");
  });
});

// -- runTrace real CLI (subprocess) ---------------------------------------------
//
// ADR-0071: of the 4 tests this describe block originally held, three pinned
// shapes retired with the session-folder merge ("default reads ./trace/",
// "legacy ./trace.jsonl fail-fast", "--trace-out pointing at the legacy single
// file fail-fast") — `DEFAULT_TRACE_DIR` / `LEGACY_TRACE_FILE` /
// `detectLegacyTrace` were removed from cli.ts; that block and its subprocess
// scaffolding were archived (with an archival reason). The invariant the
// "serve vs trace separation" test still certifies holds and is at least as
// strong as the original assertions, so it was rewritten and kept below.
describe("parseArgs — serve 与 trace 命令的 traceOut 隔离", () => {
  it("serve 解析不连带 trace 读侧字段（--no-open / 默认 trace 目录都不污染 serve）", () => {
    // Strengthened contract: serve is no longer influenced by trace's default anchor.
    // traceOut stays undefined (set only by explicit flag / env); noOpen stays false (trace-only flag).
    const serve = parseArgs({ argv: ["serve"] });
    assert.equal(serve.command, "serve");
    assert.equal(serve.traceOut, undefined, "serve 不应自动获得 trace 读默认");
    assert.equal(serve.noOpen, false, "no-open 是 trace 专属 flag，serve 不设");
    // An explicit --trace-out on serve still denotes the write path only (this test checks no behavior, just the split).
    const serveWithTrace = parseArgs({
      argv: ["serve", "--trace-out", "/tmp/t"],
    });
    assert.equal(serveWithTrace.traceOut, "/tmp/t");
  });
});
