# Prove-It Pattern — Full Example

Companion to SKILL.md "The Prove-It Pattern (Bug Fixes)" section.

## Flow

```
Bug report arrives
       │
       ▼
  Write a test that demonstrates the bug
       │
       ▼
  Test FAILS (confirming the bug exists)
       │
       ▼
  Implement the fix
       │
       ▼
  Test PASSES (proving the fix works)
       │
       ▼
  Run full test suite (no regressions)
```

## Worked Example

```typescript
// Bug: "Completing a task doesn't update the completedAt timestamp"

// Step 1: Write the reproduction test (it should FAIL)
it("sets completedAt when task is completed", async () => {
  const task = await taskService.createTask({ title: "Test" });
  const completed = await taskService.completeTask(task.id);

  expect(completed.status).toBe("completed");
  expect(completed.completedAt).toBeInstanceOf(Date); // This fails → bug confirmed
});

// Step 2: Fix the bug
export async function completeTask(id: string): Promise<Task> {
  return db.tasks.update(id, {
    status: "completed",
    completedAt: new Date(), // This was missing
  });
}

// Step 3: Test passes → bug fixed, regression guarded
```

The reproduction test now serves as a permanent regression guard. If anyone removes `completedAt: new Date()` in the future, the test fails immediately.
