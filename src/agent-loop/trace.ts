import type { ToolCallLog } from "../shared/schema.js";

/** Collects structured tool calls for trajectory eval (names + args). */
export class ToolTrace {
  private readonly calls: ToolCallLog[] = [];

  record(tool: string, args: Record<string, unknown> = {}): void {
    this.calls.push({
      tool,
      args,
      ordinal: this.calls.length + 1,
    });
  }

  names(): string[] {
    return this.calls.map((c) => c.tool);
  }

  logs(): ToolCallLog[] {
    return this.calls.map((c) => ({ ...c, args: { ...c.args } }));
  }
}
