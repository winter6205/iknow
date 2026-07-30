/**
 * schema.ts direct unit tests (022 SC21 coverage gate).
 *
 * Why a dedicated file: validateSessionFile branches are not fully exercised
 * by session-store.test.ts (which only hits schemaVersion + messages cases
 * via load()). The 6 field-validation branches must each be covered to clear
 * the 80/70 gate. Each invalid field surfaces the field name in the error,
 * which is what hub.ts → http.ts → wire uses to build the schema_invalid body.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  CURRENT_SCHEMA_VERSION,
  isSessionFileV1,
  validateSessionFile,
} from "../../../src/session-api/store/index.ts";
import type { SessionFileV1 } from "../../../src/session-api/store/index.ts";

const valid: SessionFileV1 = {
  schemaVersion: 1,
  conversation_id: "abc",
  messages: [],
  jsonMode: false,
  turnCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// -- happy path --------------------------------------------------------------

describe("validateSessionFile — happy path", () => {
  it("returns null for a fully-valid SessionFileV1 shape", () => {
    assert.equal(validateSessionFile(valid), null);
  });

  it("accepts the canonical CURRENT_SCHEMA_VERSION literal (1)", () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 1);
    assert.equal(validateSessionFile({ ...valid }), null);
  });
});

// -- root-level guards -------------------------------------------------------

describe("validateSessionFile — root guard", () => {
  it("returns 'root' for null", () => {
    assert.equal(validateSessionFile(null), "root");
  });

  it("returns 'root' for a primitive (non-object)", () => {
    assert.equal(validateSessionFile("a string"), "root");
    assert.equal(validateSessionFile(42), "root");
    assert.equal(validateSessionFile(true), "root");
    assert.equal(validateSessionFile(undefined), "root");
  });
});

// -- per-field invalid branches ---------------------------------------------

describe("validateSessionFile — per-field rejection", () => {
  it("rejects wrong schemaVersion → 'schemaVersion'", () => {
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: 2 }),
      "schemaVersion"
    );
    assert.equal(
      validateSessionFile({ ...valid, schemaVersion: "1" }),
      "schemaVersion"
    );
    // Missing key entirely
    const { schemaVersion: _omit, ...without } = valid;
    assert.equal(validateSessionFile(without), "schemaVersion");
  });

  it("rejects non-string conversation_id → 'conversation_id'", () => {
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: 123 }),
      "conversation_id"
    );
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: null }),
      "conversation_id"
    );
    assert.equal(
      validateSessionFile({ ...valid, conversation_id: true }),
      "conversation_id"
    );
  });

  it("rejects non-array messages → 'messages'", () => {
    assert.equal(
      validateSessionFile({ ...valid, messages: "not-an-array" }),
      "messages"
    );
    assert.equal(validateSessionFile({ ...valid, messages: {} }), "messages");
    assert.equal(validateSessionFile({ ...valid, messages: null }), "messages");
  });

  it("rejects non-boolean jsonMode → 'jsonMode'", () => {
    assert.equal(
      validateSessionFile({ ...valid, jsonMode: "true" }),
      "jsonMode"
    );
    assert.equal(validateSessionFile({ ...valid, jsonMode: 0 }), "jsonMode");
    assert.equal(validateSessionFile({ ...valid, jsonMode: null }), "jsonMode");
  });

  it("rejects non-number turnCount → 'turnCount'", () => {
    assert.equal(
      validateSessionFile({ ...valid, turnCount: "0" }),
      "turnCount"
    );
    assert.equal(
      validateSessionFile({ ...valid, turnCount: null }),
      "turnCount"
    );
    assert.equal(
      validateSessionFile({ ...valid, turnCount: true }),
      "turnCount"
    );
  });

  it("rejects non-string updatedAt → 'updatedAt'", () => {
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: 1234567890 }),
      "updatedAt"
    );
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: null }),
      "updatedAt"
    );
    assert.equal(
      validateSessionFile({ ...valid, updatedAt: true }),
      "updatedAt"
    );
  });
});

// -- type guard companion ----------------------------------------------------

describe("isSessionFileV1 — type guard companion", () => {
  it("returns true when validateSessionFile returns null", () => {
    assert.equal(isSessionFileV1(valid), true);
  });

  it("returns false for any rejected value", () => {
    assert.equal(isSessionFileV1(null), false);
    assert.equal(isSessionFileV1({ ...valid, schemaVersion: 2 }), false);
    assert.equal(isSessionFileV1({ ...valid, turnCount: "x" }), false);
  });
});
