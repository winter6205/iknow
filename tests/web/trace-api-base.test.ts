/**
 * Frontend trace API base resolution (#183 R4 + ADR-0020 D1.6).
 *
 * The web client may target a different host/port for the trace API
 * (e.g. `iknow trace --separate --port 24881`) via the Vite env var
 * VITE_TRACE_API_BASE. Default falls back to `/api/v1/traces` so the
 * `iknow serve` mounted path (ADR-0020) works without env wiring.
 *
 * ADR-0020 D1.6: trace sessions live under the traces prefix —
 * `${TRACE_API}/sessions` (not the chat `/api/v1/sessions`).
 *
 * The pure helpers are exported from web/src/api/client.ts for testability.
 */
import { describe, it, expect } from "vitest";
import {
  resolveTraceApiBase,
  resolveTraceSessionsBase,
} from "../../web/src/api/client.ts";

describe("resolveTraceApiBase", () => {
  it("defaults to /api/v1/traces when env is undefined", () => {
    expect(resolveTraceApiBase(undefined)).toBe("/api/v1/traces");
  });

  it("defaults to /api/v1/traces when env is empty string", () => {
    expect(resolveTraceApiBase("")).toBe("/api/v1/traces");
  });

  it("uses VITE_TRACE_API_BASE when set", () => {
    expect(resolveTraceApiBase("http://127.0.0.1:24881")).toBe(
      "http://127.0.0.1:24881"
    );
  });

  it("uses VITE_TRACE_API_BASE with a path prefix", () => {
    expect(
      resolveTraceApiBase("https://trace.example.com/iknow/api/v1/traces")
    ).toBe("https://trace.example.com/iknow/api/v1/traces");
  });
});

describe("resolveTraceSessionsBase (ADR-0020 D1.6)", () => {
  it("appends /sessions to the default TRACE_API", () => {
    expect(resolveTraceSessionsBase("/api/v1/traces")).toBe(
      "/api/v1/traces/sessions"
    );
  });

  it("appends /sessions to an origin-override TRACE_API", () => {
    expect(
      resolveTraceSessionsBase("http://127.0.0.1:24881/api/v1/traces")
    ).toBe("http://127.0.0.1:24881/api/v1/traces/sessions");
  });

  it("never targets the chat sessions route", () => {
    const base = resolveTraceSessionsBase("/api/v1/traces");
    expect(base).not.toBe("/api/v1/sessions");
  });
});
