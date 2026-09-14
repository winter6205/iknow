# Testing Patterns — Full Code Examples

Companion to `references/test-shape.md` (writing rules). Each example shows the principle applied to real code.

## Test State, Not Interactions

```typescript
// Good: Tests what the function does (state-based)
it("returns tasks sorted by creation date, newest first", async () => {
  const tasks = await listTasks({ sortBy: "createdAt", sortOrder: "desc" });
  expect(tasks[0].createdAt.getTime()).toBeGreaterThan(
    tasks[1].createdAt.getTime()
  );
});

// Bad: Tests how the function works internally (interaction-based)
it("calls db.query with ORDER BY created_at DESC", async () => {
  await listTasks({ sortBy: "createdAt", sortOrder: "desc" });
  expect(db.query).toHaveBeenCalledWith(
    expect.stringContaining("ORDER BY created_at DESC")
  );
});
```

## DAMP Over DRY

```typescript
// DAMP: Each test is self-contained and readable
it("rejects tasks with empty titles", () => {
  const input = { title: "", assignee: "user-1" };
  expect(() => createTask(input)).toThrow("Title is required");
});

it("trims whitespace from titles", () => {
  const input = { title: "  Buy groceries  ", assignee: "user-1" };
  const task = createTask(input);
  expect(task.title).toBe("Buy groceries");
});

// Over-DRY: Shared setup obscures what each test actually verifies
// (Don't do this just to avoid repeating the input shape)
```

Duplication in tests is acceptable when it makes each test independently understandable.

## Mock Usage Boundary

**Use mocks only when:** the real implementation is too slow, non-deterministic, or has side effects you can't control (external APIs, email sending). Over-mocking creates tests that pass while production breaks.

```
Preference order:
1. Real implementation → Highest confidence, catches real bugs
2. Fake               → In-memory version of dependency (e.g., fake DB)
3. Stub               → Returns canned data, no behavior
4. Mock (interaction) → Verifies method calls — use sparingly
```

## One Assertion Per Concept

```typescript
// Good: Each test verifies one behavior
it('rejects empty titles', () => { ... });
it('trims whitespace from titles', () => { ... });
it('enforces maximum title length', () => { ... });

// Bad: Everything in one test
it('validates titles correctly', () => {
  expect(() => createTask({ title: '' })).toThrow();
  expect(createTask({ title: '  hello  ' }).title).toBe('hello');
  expect(() => createTask({ title: 'a'.repeat(256) })).toThrow();
});
```

## Name Tests Descriptively

```typescript
// Good: Reads like a specification
describe('TaskService.completeTask', () => {
  it('sets status to completed and records timestamp', ...);
  it('throws NotFoundError for non-existent task', ...);
  it('is idempotent — completing an already-completed task is a no-op', ...);
  it('sends notification to task assignee', ...);
});

// Bad: Vague names
describe('TaskService', () => {
  it('works', ...);
  it('handles errors', ...);
  it('test 3', ...);
});
```
