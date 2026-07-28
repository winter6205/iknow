/**
 * T1 skeleton smoke: src/harness/ exports the type spine declared in
 * specs/minimum-sequential-agent-loop.md. The test deliberately does not
 * exercise runtime behavior (T1 only ships the Foundation skeleton).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RegistryConstructionError,
  ProtocolError,
  ToolExecutionError,
} from "../../src/harness/errors.ts";

describe("harness skeleton (T1)", () => {
  it("exports three Foundation error classes", () => {
    for (const Ctor of [
      RegistryConstructionError,
      ProtocolError,
      ToolExecutionError,
    ]) {
      assert.equal(typeof Ctor, "function");
      const e = new Ctor("x");
      assert.ok(e instanceof Error, `${Ctor.name} must extend Error`);
      assert.equal(e.message, "x");
      assert.equal(e.name, Ctor.name);
    }
  });

  it("Foundation error classes are mutually distinguishable", () => {
    const a = new RegistryConstructionError("r");
    const b = new ProtocolError("p");
    const c = new ToolExecutionError("t");
    assert.ok(a instanceof RegistryConstructionError);
    assert.ok(!(a instanceof ProtocolError));
    assert.ok(!(a instanceof ToolExecutionError));
    assert.ok(b instanceof ProtocolError);
    assert.ok(!(b instanceof RegistryConstructionError));
    assert.ok(c instanceof ToolExecutionError);
    assert.ok(!(c instanceof ProtocolError));
  });
});