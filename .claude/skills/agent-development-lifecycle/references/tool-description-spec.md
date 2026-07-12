# Tool Description Spec

## Good vs Bad Examples

| Field | Good | Bad |
|---|---|---|
| Name | `search_customer_by_id` | `search` |
| Description | "Returns customer master data and last 10 orders; 404 if not found" | "Get customer data" |
| Input Schema | `{"customer_id": {"pattern": "^CUS-\\d{6}$"}}` | `{"id": "string"}` |
| Output format | "Max 5KB JSON" | unspecified |
| Latency | "<200ms" | unspecified |
| Failure mode | "Timeout returns `{\"error\":\"TIMEOUT\",\"retry_after_ms\":1000}`" | unspecified |

## Why This Matters

Tool descriptions are loaded into agent context and directly guide behavior. Poor descriptions = poor agent decisions.

From Anthropic "Writing effective tools for agents":
- Description IS the prompt that guides agent behavior
- Include: when to use, parameter semantics, expected return format, edge cases
- Prompt engineer tool descriptions as carefully as system prompts
