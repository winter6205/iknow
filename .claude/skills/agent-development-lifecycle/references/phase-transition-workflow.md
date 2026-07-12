# Phase 2 → Phase 3 Transition Workflow

This document captures the concrete workflow for transitioning from architecture design (Phase 2) to tool implementation (Phase 3).

## Overview

Phase 2 produces: architecture document, state machine design, layer definitions
Phase 3 produces: working tools, eval dataset, integration tests

The transition requires filling architecture gaps and preparing eval-first validation.

## Step 1: Architecture Gap Audit

**Goal**: Identify missing pieces that block tool implementation.

**Standard checklist** (from OpenHarness fork compliance review):

1. **Interface compatibility declaration**
   - List all framework interfaces that must remain compatible
   - Specify wrapper vs replacement strategy for each
   - Define hook trigger timing (PreToolUse/PostToolUse)

2. **Tool set definition**
   - Define 2-8 MVP tools (cognitive load threshold)
   - Each tool: name, description, risk level, parameters, returns, error responses
   - Naming convention: `{service}_{resource}_{action}`
   - Affordance-oriented (not API wrappers)

3. **Permission system mapping**
   - Map tool risk levels to framework permission modes
   - Define escalation paths (auto → human approval)

4. **Development discipline**
   - Commit conventions
   - CI checks (test + lint)
   - Subsystem pruning list

5. **Branch management strategy**
   - Baseline branch structure
   - Upstream sync strategy (accept/reject lists)

**Output**: Updated architecture document (e.g., `ARCHITECTURE_V2.md`)

## Step 2: Tool Spec Generation

**Goal**: Produce machine-readable tool definitions.

**JSON Schema structure per tool**:
```json
{
  "name": "string",
  "description": "string (prompt engineering - when to use, params, returns, edge cases)",
  "risk_level": "L0-L5",
  "parameters": {
    "type": "object",
    "properties": {...},
    "required": [...]
  },
  "returns": {
    "type": "object",
    "properties": {...}
  },
  "error_responses": [
    {"code": "string", "message": "string", "suggestion": "string"}
  ]
}
```

**Quality criteria**:
- Description IS the prompt (guides agent behavior)
- Error responses are specific and actionable
- Risk levels map to permission checks
- Parameters have clear semantics

**Output**: `TOOL_SPEC.json`

## Step 3: Eval Dataset Design

**Goal**: Create eval-first validation suite (≥30 tasks).

**5 task types** (7 tasks each = 35 total):

1. **Baseline** (single-tool, read-only)
   - Examples: grep for bug, read file, check status
   - Tests: tool invocation accuracy

2. **Chain** (multi-tool sequential)
   - Examples: read → edit → test → commit
   - Tests: tool chaining, state management
   - Must include 3+ tool calls

3. **Routing** (tool selection)
   - Examples: bug fix vs feature addition (different paths)
   - Tests: decision-making, conditional logic
   - Must include branch decision points

4. **Error handling** (ambiguous input)
   - Examples: "this function is slow", non-existent file, permission denied
   - Tests: error recovery, graceful degradation
   - Must test agent's error handling capability

5. **Loop** (iterative feedback)
   - Examples: test fails → fix → retest → fix again
   - Tests: iteration control, convergence
   - Must include 2+ iteration rounds

**Task JSON structure**:
```json
{
  "id": "eval_001",
  "type": "baseline|chain|routing|error_handling|loop",
  "difficulty": "easy|medium|hard",
  "prompt": "natural language user input",
  "context": {
    "repo_type": "python|node|go",
    "repo_state": "clean|dirty|has_failing_tests",
    "files_present": ["src/main.py", "tests/test_main.py"]
  },
  "expected_tool_calls": [
    {"tool": "tool_name", "purpose": "why this tool"}
  ],
  "success_criteria": "what constitutes success",
  "failure_modes": ["possible failure scenarios"]
}
```

**Quality criteria**:
- Prompts are natural language (what users actually say)
- Expected tool calls reference MVP tool set
- Difficulty distribution: easy/medium/hard within each type
- No duplicate prompts
- All required fields present

**Output**: `EVAL_DATASET.json`

## Step 4: Review & Validation

**Goal**: Cross-validate architecture, tool spec, and eval dataset.

**Review checklist**:

1. **Interface compatibility**
   - All framework interfaces declared?
   - Wrapper strategy clear?
   - Hook timing defined?

2. **Tool spec quality**
   - 2-8 tools defined?
   - Affordance-oriented (not API wrappers)?
   - Error responses actionable?
   - Risk levels mapped to permissions?

3. **Eval dataset coverage**
   - ≥30 tasks?
   - 5 types evenly distributed?
   - Tool names match spec?
   - Difficulty distribution balanced?

4. **Consistency checks**
   - Eval tool names match tool spec?
   - Tool risk levels match architecture?
   - Eval scenarios cover architecture use cases?

**Output**: `REVIEW_LOG.md` with scores and improvement suggestions

## Multi-Agent Workflow Pattern

For complex transitions, use 3-agent pattern:

**Agent A (Spec Architect)**:
- Reads original architecture
- Fills Phase 2 gaps
- Generates tool spec JSON
- Output: `ARCHITECTURE_V2.md` + `TOOL_SPEC.json`

**Agent B (Eval Engineer)**:
- Designs eval dataset
- Ensures 5-type coverage
- Validates task quality
- Output: `EVAL_DATASET.json`

**Agent C (Reviewer)**:
- Cross-validates A and B outputs
- Scores quality (0-10)
- Identifies P0/P1/P2 issues
- Output: `REVIEW_LOG.md`

**Parallelization**: A and B run in parallel, C runs after both complete.

## Common Pitfalls

1. **Skipping architecture gap audit** → tool implementation blocks on undefined interfaces
2. **Tool names inconsistent between spec and eval** → eval cannot run
3. **Eval dataset <30 tasks** → insufficient coverage
4. **Eval types unevenly distributed** → blind spots in testing
5. **Tool descriptions not prompt-engineered** → agent makes poor tool choices
6. **Missing error responses** → agent cannot recover from failures
7. **Risk levels not mapped to permissions** → security gaps

## Success Criteria

Phase 2 → Phase 3 transition is complete when:

- [ ] Architecture document has all 5 gap areas filled
- [ ] Tool spec defines 2-8 tools with complete JSON schema
- [ ] Eval dataset has ≥30 tasks covering 5 types
- [ ] Review log scores ≥8/10 overall
- [ ] All P0 issues resolved
- [ ] Eval can run at least 1 task successfully

## Example: Arthur Project (OpenHarness Fork)

**Phase 2 gaps filled**:
1. Interface compatibility: ToolRegistry.get(), BaseTool.execute(), PermissionChecker.evaluate(), HookExecutor.execute()
2. Tool set: 6 MVP tools (repo_inspect_state, code_apply_edit, test_run_verification, commit_verified_changes, trace_record_event, context_recall_memory)
3. Permission mapping: L0-L5 → read-only/normal/restricted
4. Development discipline: [HARDFORK] commit prefix, pytest + ruff checks
5. Branch management: hardfork-v1 baseline, upstream sync strategy

**Eval dataset**: 35 tasks (7 per type)
- Baseline: grep, read file, check status
- Chain: read → edit → test → commit
- Routing: bug fix vs feature addition
- Error handling: ambiguous input, missing files
- Loop: test fails → fix → retest

**Review score**: 8.7/10
- P0 issues: tool name inconsistency (fixed), missing read/search tools (added)
- P1 issues: naming convention inconsistency, verbose descriptions
- P2 issues: permission flow diagram, discipline checklist
