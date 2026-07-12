# Agent Loop Minimal Implementation

```python
def agent_loop(task: str, tools: dict, max_steps: int = 10):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": task},
    ]
    for step in range(max_steps):
        response = llm.chat(messages, tools=list(tools.values()))
        if response.tool_calls:
            for call in response.tool_calls:
                result = tools[call.name].execute(call.arguments)
                messages.append({"role": "tool", "name": call.name, "content": result})
            continue
        return response.content
    raise RuntimeError(f"Agent did not finish within {max_steps} steps")
```

## Key Points

- **max_steps**: Hard limit to prevent infinite loops (default 10)
- **Tool execution**: Deterministic code executes tool calls, not LLM
- **Context accumulation**: Each tool result appended to messages
- **Termination**: Returns when LLM produces final response without tool calls
