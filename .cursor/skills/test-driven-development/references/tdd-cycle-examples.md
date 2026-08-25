# TDD Cycle — Full Code Examples

Companion to SKILL.md "The TDD Cycle" section. The SKILL.md shows the cycle abstractly; this reference shows concrete RED/GREEN/REFACTOR code.

## RED: Write a Failing Test

The test must fail. A test that passes immediately proves nothing.

```typescript
// RED: This test fails because createTask doesn't exist yet
describe("TaskService", () => {
  it("creates a task with title and default status", async () => {
    const task = await taskService.createTask({ title: "Buy groceries" });

    expect(task.id).toBeDefined();
    expect(task.title).toBe("Buy groceries");
    expect(task.status).toBe("pending");
    expect(task.createdAt).toBeInstanceOf(Date);
  });
});
```

## GREEN: Make It Pass

Write the minimum code to make the test pass. Don't over-engineer:

```typescript
// GREEN: Minimal implementation
export async function createTask(input: { title: string }): Promise<Task> {
  const task = {
    id: generateId(),
    title: input.title,
    status: "pending" as const,
    createdAt: new Date(),
  };
  await db.tasks.insert(task);
  return task;
}
```

## REFACTOR: Clean Up

With tests green, improve the code without changing behavior:

- Extract shared logic
- Improve naming
- Remove duplication
- Optimize if necessary

Run tests after every refactor step to confirm nothing broke.
