/**
 * Frontend trace API base resolution (#183 R4).
 *
 * The web client may target a different host/port for the trace API
 * (e.g. `iknow trace --port 24881`) via the Vite env var
 * VITE_TRACE_API_BASE. Default falls back to `/api/v1/traces` so the
 * `iknow serve` / API gateway path works without env wiring.
 *
 * The pure helper is exported from web/src/api/client.ts for testability.
 */
import { describe, it, expect } from "vitest";
import { resolveTraceApiBase } from "../../web/src/api/client.ts";

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
