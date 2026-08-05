/**
 * `iknow trace` CLI tests (spec #183 R2).
 *
 * Covers:
 *   - parseArgs recognizes the `trace` positional
 *   - flag parsing: --trace-out / --port / --host / --max-bytes
 *   - defaults: port 24881, host 127.0.0.1
 *   - bad --port throws a parse error
 *   - integration: startTraceServe from parsed opts → /api/v1/health live
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

  it("defaults port to 24881 when --port omitted", () => {
    const parsed = parseArgs({ argv: ["trace"] });
    assert.equal(parsed.command, "trace");
    assert.equal(parsed.port, 24881);
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
