# State Machine Pattern

```python
from enum import Enum
from typing import Optional

class AgentState(Enum):
    IDLE = "idle"
    PLANNING = "planning"
    EXECUTING = "executing"
    WAITING_APPROVAL = "waiting_approval"
    EVALUATING = "evaluating"
    COMPLETED = "completed"
    FAILED = "failed"

class AgentStateMachine:
    def __init__(self):
        self.state = AgentState.IDLE
        self.context = {}
    
    def transition(self, new_state: AgentState, condition: bool = True):
        if condition:
            old_state = self.state
            self.state = new_state
            print(f"State transition: {old_state.value} → {new_state.value}")
    
    def execute(self, task: str):
        self.transition(AgentState.PLANNING)
        # Planning logic
        self.transition(AgentState.EXECUTING)
        # Execution logic
        if self.needs_approval():
            self.transition(AgentState.WAITING_APPROVAL)
            # Wait for human approval
        self.transition(AgentState.EVALUATING)
        # Evaluation logic
        if self.success():
            self.transition(AgentState.COMPLETED)
        else:
            self.transition(AgentState.FAILED)
```

## State Definitions

- **IDLE**: Waiting for task
- **PLANNING**: Decomposing task, selecting tools
- **EXECUTING**: Running tool calls
- **WAITING_APPROVAL**: Paused for human approval
- **EVALUATING**: Checking result quality
- **COMPLETED**: Task finished successfully
- **FAILED**: Task failed (error or step limit)
