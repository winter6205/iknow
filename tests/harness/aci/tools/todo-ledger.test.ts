/**
 * ADR-0085 / specs/agent-control-surface.md Slice C: pure ledger helpers.
 *
 * Invariants pinned here (the tool tests pin the IO side):
 *   - line grammar `- [mark] [tN] subject` round-trips for the three statuses;
 *   - legacy lines without an id are readable and get deterministic synthesized
 *     ids in file order, never colliding with an explicit marker already in the
 *     file;
 *   - ids continue after the table max, so deleting a middle item never frees
 *     its number for a later add, and a reload yields the same ids;
 *   - update patches change subject / status / delete by id, unknown id → null
 *     (the tool turns that into a typed error).
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  appendSubjects,
  applyUpdate,
  formatLedgerLine,
  OPEN_PREFIX,
  parseLedger,
  pendingItemsFromSubjects,
  serializeLedger,
  TODO_ITEM_STATUSES,
  type TodoItem,
} from "../../../../src/harness/aci/tools/todo-ledger.ts";

describe("todo-ledger — line grammar", () => {
  it("serializes the three statuses with their checkbox marker", () => {
    assert.equal(
      formatLedgerLine({ id: "t5", status: "pending", subject: "a" }),
      "- [ ] [t5] a\n"
    );
    assert.equal(
      formatLedgerLine({ id: "t5", status: "in_progress", subject: "a" }),
      "- [~] [t5] a\n"
    );
    assert.equal(
      formatLedgerLine({ id: "t5", status: "completed", subject: "a" }),
      "- [x] [t5] a\n"
    );
  });

  it("pending prefix is the status-bar anchor OPEN_PREFIX (bar projection survives ids)", () => {
    assert.equal(OPEN_PREFIX, "- [ ] ");
    assert.ok(
      formatLedgerLine({
        id: "t1",
        status: "pending",
        subject: "x",
      }).startsWith(OPEN_PREFIX)
    );
  });

  it("round-trips a serialized table (id / status / subject preserved)", () => {
    const items: ReadonlyArray<TodoItem> = [
      { id: "t1", status: "pending", subject: "first" },
      { id: "t2", status: "in_progress", subject: "second" },
      { id: "t3", status: "completed", subject: "third" },
    ];
    assert.deepEqual(parseLedger(serializeLedger(items)), items);
  });

  it("empty table → empty string; empty string parses to no items", () => {
    assert.equal(serializeLedger([]), "");
    assert.deepEqual(parseLedger(""), []);
  });

  it("subject text is the remainder of the line, kept verbatim (spaces, CJK, emoji)", () => {
    const subject = "  中文 task — with  spaces 👨‍👩‍👧";
    const parsed = parseLedger(
      serializeLedger([{ id: "t1", status: "pending", subject }])
    );
    assert.equal(parsed[0]!.subject, subject);
  });

  it("a subject that itself starts with a marker-like token keeps its text after the real id", () => {
    const subject = "[t9] nested looking text";
    const parsed = parseLedger(
      serializeLedger([{ id: "t1", status: "pending", subject }])
    );
    assert.deepEqual(parsed, [{ id: "t1", status: "pending", subject }]);
  });

  it("non-item lines (blank / prose / malformed checkbox) are skipped, not items", () => {
    const content = [
      "# notes",
      "",
      "- [ ] [t1] real item",
      "- no checkbox here",
      "- [y] [t2] unknown marker",
      "trailing prose",
      "",
    ].join("\n");
    assert.deepEqual(parseLedger(content), [
      { id: "t1", status: "pending", subject: "real item" },
    ]);
  });
});

describe("todo-ledger — legacy lines without ids", () => {
  it("synthesizes deterministic ids in file order", () => {
    const parsed = parseLedger("- [ ] first\n- [x] second\n- [~] third\n");
    assert.deepEqual(parsed, [
      { id: "t1", status: "pending", subject: "first" },
      { id: "t2", status: "completed", subject: "second" },
      { id: "t3", status: "in_progress", subject: "third" },
    ]);
  });

  it("synthesized ids skip numbers already claimed by explicit markers in the file", () => {
    // File order: explicit t1, legacy, explicit t3 → the legacy line must get
    // a free serial (t2), never a colliding t1.
    const parsed = parseLedger("- [ ] [t1] a\n- [ ] b\n- [ ] [t3] c\n");
    assert.deepEqual(parsed, [
      { id: "t1", status: "pending", subject: "a" },
      { id: "t2", status: "pending", subject: "b" },
      { id: "t3", status: "pending", subject: "c" },
    ]);
  });

  it("a duplicate explicit marker from a hand-edited file is re-issued, ids stay unique", () => {
    const parsed = parseLedger("- [ ] [t1] a\n- [ ] [t1] b\n");
    assert.equal(parsed.length, 2);
    assert.notEqual(parsed[0]!.id, parsed[1]!.id);
    assert.equal(parsed[1]!.subject, "b");
  });

  it("mixed legacy + explicit keeps file order and all ids unique", () => {
    const parsed = parseLedger(
      "- [ ] [t7] seven\n- [ ] legacy\n- [ ] [t2] two\n"
    );
    assert.deepEqual(
      parsed.map((i) => i.id),
      ["t7", "t8", "t2"]
    );
    assert.equal(new Set(parsed.map((i) => i.id)).size, 3);
  });

  it("parse → serialize persists synthesized ids (next mutating write)", () => {
    const persisted = serializeLedger(parseLedger("- [ ] legacy one\n"));
    assert.equal(persisted, "- [ ] [t1] legacy one\n");
  });
});

describe("todo-ledger — id assignment", () => {
  it("appendSubjects allocates from t1 on an empty table (id rule = max + 1)", () => {
    const { added } = appendSubjects([], ["first"]);
    assert.deepEqual(added, [
      { id: "t1", status: "pending", subject: "first" },
    ]);
    // max numeric suffix + 1: t2..t9 present → next is t10 (not t3).
    const { added: afterNine } = appendSubjects(
      parseLedger("- [ ] [t2] a\n- [ ] [t9] b\n"),
      ["next"]
    );
    assert.equal(afterNine[0]!.id, "t10");
  });

  it("appendSubjects continues after the max and reports the added items", () => {
    const current: ReadonlyArray<TodoItem> = [
      { id: "t1", status: "pending", subject: "a" },
      { id: "t4", status: "completed", subject: "b" },
    ];
    const { items, added } = appendSubjects(current, ["c", "d"]);
    assert.deepEqual(
      added.map((i) => i.id),
      ["t5", "t6"]
    );
    assert.deepEqual(
      items.map((i) => i.id),
      ["t1", "t4", "t5", "t6"]
    );
    // Existing items untouched, new ones pending.
    assert.deepEqual(items[0], current[0]);
    assert.deepEqual(
      added.map((i) => i.status),
      ["pending", "pending"]
    );
  });

  it("appendSubjects on a legacy file persists synthesized ids before the new ones", () => {
    const current = parseLedger("- [ ] legacy\n");
    const { items, added } = appendSubjects(current, ["fresh"]);
    assert.deepEqual(
      items.map((i) => i.id),
      ["t1", "t2"]
    );
    assert.equal(added[0]!.id, "t2");
    assert.equal(
      serializeLedger(items),
      "- [ ] [t1] legacy\n- [ ] [t2] fresh\n"
    );
  });

  it("deleting a middle item does not free its number: the next add continues after the max", () => {
    const items = parseLedger("- [ ] [t1] a\n- [ ] [t2] b\n- [ ] [t3] c\n");
    const afterDelete = applyUpdate(items, { id: "t2", delete: true })!;
    const { items: afterAdd, added } = appendSubjects(afterDelete, ["d"]);
    assert.deepEqual(
      afterDelete.map((i) => i.id),
      ["t1", "t3"]
    );
    assert.equal(added[0]!.id, "t4", "t2 must not be reused");
    assert.deepEqual(
      afterAdd.map((i) => i.id),
      ["t1", "t3", "t4"]
    );
  });

  it("ids are stable across reload (serialize → parse yields the same ids)", () => {
    const items = parseLedger("- [ ] [t1] a\n- [ ] [t5] b\n");
    const { items: afterAdd } = appendSubjects(items, ["c"]);
    const reloaded = parseLedger(serializeLedger(afterAdd));
    assert.deepEqual(reloaded, afterAdd);
    assert.deepEqual(
      reloaded.map((i) => i.id),
      ["t1", "t5", "t6"]
    );
  });

  it("pendingItemsFromSubjects numbers from t1 (whole-table replace)", () => {
    const items = pendingItemsFromSubjects(["a", "b"]);
    assert.deepEqual(items, [
      { id: "t1", status: "pending", subject: "a" },
      { id: "t2", status: "pending", subject: "b" },
    ]);
    assert.deepEqual(pendingItemsFromSubjects([]), []);
  });
});

describe("todo-ledger — applyUpdate", () => {
  const base: ReadonlyArray<TodoItem> = [
    { id: "t1", status: "pending", subject: "a" },
    { id: "t2", status: "pending", subject: "b" },
  ];

  it("status only → subject and other items untouched", () => {
    const next = applyUpdate(base, { id: "t2", status: "completed" })!;
    assert.deepEqual(next, [
      { id: "t1", status: "pending", subject: "a" },
      { id: "t2", status: "completed", subject: "b" },
    ]);
    assert.deepEqual(
      base,
      [
        { id: "t1", status: "pending", subject: "a" },
        { id: "t2", status: "pending", subject: "b" },
      ],
      "input table is not mutated"
    );
  });

  it("subject only → status kept", () => {
    const next = applyUpdate(base, { id: "t1", subject: "renamed" })!;
    assert.deepEqual(next[0], {
      id: "t1",
      status: "pending",
      subject: "renamed",
    });
  });

  it("subject + status together in one patch", () => {
    const next = applyUpdate(base, {
      id: "t1",
      subject: "renamed",
      status: "in_progress",
    })!;
    assert.deepEqual(next[0], {
      id: "t1",
      status: "in_progress",
      subject: "renamed",
    });
  });

  it("delete removes exactly that line and keeps order of the rest", () => {
    const next = applyUpdate(base, { id: "t1", delete: true })!;
    assert.deepEqual(next, [{ id: "t2", status: "pending", subject: "b" }]);
  });

  it("unknown id → null (no partial table)", () => {
    assert.equal(applyUpdate(base, { id: "t9", status: "completed" }), null);
  });

  it("delete is not a fourth status — status enum carries the three real states", () => {
    assert.deepEqual(
      [...TODO_ITEM_STATUSES],
      ["pending", "in_progress", "completed"]
    );
  });
});
