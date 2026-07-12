#!/usr/bin/env node
/**
 * CLI: npx tsx src/cli.ts "query"
 * Optional: --role employee|manager|admin
 * Optional: --governance-timeout  (edge-006 degrade path)
 */
import { createSeededStore } from "./fixtures/seed-kb.js";
import { IknowAgent } from "./agent-loop/loop.js";
import {
  CALLER_ROLES,
  parseCallerRole,
  type CallerRole,
} from "./shared/schema.js";

function parseArgs(argv: string[]): {
  query: string;
  role: CallerRole;
  degrade: boolean;
} {
  let role: CallerRole = "employee";
  let degrade = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--role") {
      const raw = argv[++i];
      if (raw === undefined) {
        throw new Error(
          `Missing value for --role; expected one of: ${CALLER_ROLES.join("|")}`,
        );
      }
      role = parseCallerRole(raw);
    } else if (a === "--governance-timeout") {
      degrade = true;
    } else {
      rest.push(a);
    }
  }
  return {
    query: rest.join(" ").trim() || "公司的退款政策是什么？",
    role,
    degrade,
  };
}

const { query, role, degrade } = parseArgs(process.argv.slice(2));
const store = createSeededStore();
const agent = new IknowAgent({
  store,
  session: {
    caller_role: role,
    simulate_governance_timeout: degrade,
  },
});
const answer = agent.answer(query);
console.log(JSON.stringify(answer, null, 2));
