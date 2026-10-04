/**
 * Saved state must not be able to carry a permission decision.
 *
 * A recovered session is supposed to run under the permission rules that are in
 * force *now*, with the human asked again. That is only true as long as no
 * process-memory grant can reach durable storage, so the property is locked at
 * three levels that fail independently:
 *
 *   - value space: the port's own maximal instance has a closed key set, so
 *     there is no field to put a rule, a secret value, or a credential in.
 *   - source: the port names none of the excluded state, so the exclusion is
 *     not a per-call-site promise but a property of the contract.
 *   - behavior: a grant never reaches the serialized payload, and a runtime
 *     whose store holds no rule re-asks through the current chain instead of
 *     answering the call; a placeholder pasted into a message stays inert
 *     because its value never left the process.
 *
 * The value-space proof is an exhaustive allowlist rather than a denylist on
 * purpose. A denylist only says the names that were thought of; an allowlist
 * also rejects a new field that nobody thought of. The denylist on the
 * serialized text is kept as a second, independent net, because a maximal
 * instance only pins the fields this file happens to populate.
 *
 * Scan scope, stated because a source guard is only as good as its scope: the
 * static case reads `src/shared/runtime-persistence.ts` alone, and compares
 * code against comments so that the module doc — which must keep *naming* the
 * excluded state — is not itself the violation. That file carries no string
 * literal holding a `//` or a `/*`, so the strip cannot eat code.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createPermissionRuntime,
  type PermissionRuntime,
} from "../../../src/harness/permission/permission-executor.js";
import {
  checkPermission,
  createPermissionPolicy,
  type CheckPermissionInput,
} from "../../../src/harness/permission/policy.js";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import {
  createSecretRegistry,
  restore,
} from "../../../src/harness/secret-roundtrip/registry.js";
import type {
  AciCategory,
  AciToolDef,
} from "../../../src/harness/aci/types.js";
import type {
  Executor,
  Registry,
  ToolCall,
  ToolExecutionResult,
  ToolDef,
} from "../../../src/harness/tools/types.js";
import type {
  AskUser,
  NormalRuleSpec,
} from "../../../src/harness/permission/types.js";
import type {
  RuntimeGraphNodeFact,
  RuntimeSavedStateRequest,
  RuntimeToolResultFact,
  RuntimeWorkerFact,
} from "../../../src/shared/runtime-persistence.js";

// -- 1. value space: the port's own maximal instance --------------------------

const PORT_FILE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "src",
  "shared",
  "runtime-persistence.ts"
);

/** A credential-shaped canary: a leak of it into a payload is visible by text. */
const SECRET_CANARY = "sk-live-7f3a91c4-do-not-persist";

/** The id hub.resolveAsk stamps on the rule an `always-allow` leaves behind. */
const GRANT_ID = "session-allow-demo_write";

function maximalRequest(secretText: string): RuntimeSavedStateRequest<string> {
  return {
    boundary: "terminal_turn",
    turnId: "turn-7",
    messages: [
      `${secretText} was pasted by the operator`,
      { role: "assistant", content: "writing" },
    ] as unknown as ReadonlyArray<string>,
    assembly: {
      // The MAXIMAL instance of what the contract declares today. Fields the
      // contract once carried and no producer ever filled (`skillIndexSeen`,
      // `pendingContinuation`, `executionMode`) were removed rather than left
      // declared-and-dead, so this fixture must not keep naming them: a
      // maximal instance whose roster lists a field the port does not declare
      // would prove a closed key set over a key set that is not the real one.
      systemPrefix: "frozen prefix",
    },
    terminal: { stopReason: "end_turn", supplierDetail: "supplier said stop" },
  };
}

function maximalToolResultFact(): RuntimeToolResultFact<string> {
  return {
    kind: "tool_result",
    toolUseId: "toolu_01",
    turnId: "turn-7",
    batchPosition: 0,
    batchSize: 1,
    resultMessage: "wrote 1 file",
    files: [
      {
        relPath: "notes.txt",
        rootIdentity: "/repo",
        absentBefore: true,
        preimageSha: "sha-pre",
        postimageSha: "sha-post",
        published: true,
      },
    ],
  };
}

function maximalGraphNodeFact(): RuntimeGraphNodeFact {
  return {
    kind: "graph_node",
    nodeId: "node-2",
    status: "failed",
    output: "partial output",
    error: "spawn refused",
  };
}

function maximalWorkerFact(): RuntimeWorkerFact {
  return {
    kind: "worker_progress",
    taskId: "task-9",
    ownership: "background",
    state: "stopped",
    process: { pid: 4242, startTime: 99 },
    transcriptPath: "/repo/.iknow/task-9.jsonl",
    toolUseId: "toolu_02",
  };
}

/**
 * Message bodies are the opaque `M`: the port carries them without claiming
 * their shape, so the roster below pins the harness's own declared fields and
 * stops at the opaque leaf. What travels inside a message is covered instead
 * by the serialized-text denylist below and by the reopen test.
 */
const OPAQUE_FIELDS: ReadonlySet<string> = new Set([
  "messages",
  "resultMessage",
]);

/**
 * Every object key in a parsed JSON value, dotted, arrays folded to `[]`. Each
 * element is walked: the three fact kinds differ, so reading only the head of
 * the list would report a key set smaller than what is actually persisted.
 */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  const record = value as Record<string, unknown>;
  return Object.keys(record).flatMap((k) => {
    const here = `${prefix}${prefix ? "." : ""}${k}`;
    if (OPAQUE_FIELDS.has(k)) return [here];
    return [here, ...keyPaths(record[k], here)];
  });
}

/** Leaf key names, ignoring the path, so an allowlist reads as one roster. */
function leafKeys(value: unknown): string[] {
  return [
    ...new Set(keyPaths(value).map((p) => p.slice(p.lastIndexOf(".") + 1))),
  ].sort();
}

describe("saved state carries no permission decision — value space", () => {
  // Built the way the harness would build it: the value goes through the
  // roundtrip registry first, so the message carries the placeholder. Asserting
  // the canary's absence is only meaningful once the canary is in play.
  const masked = createSecretRegistry().register(SECRET_CANARY);
  const payload = {
    state: maximalRequest(masked),
    facts: [
      maximalToolResultFact(),
      maximalGraphNodeFact(),
      maximalWorkerFact(),
    ],
  };
  const text = JSON.stringify(payload);

  it("the maximal request's key set is closed and carries nothing excluded", () => {
    // The roster is the assertion: a new field has to be written down here
    // before it can be persisted, which is the point of the review it forces.
    assert.deepEqual(leafKeys(JSON.parse(text)), [
      "absentBefore",
      "assembly",
      "batchPosition",
      "batchSize",
      "boundary",
      "error",
      "facts",
      "files",
      "kind",
      "messages",
      "nodeId",
      "output",
      "ownership",
      "pid",
      "postimageSha",
      "preimageSha",
      "process",
      "published",
      "relPath",
      "resultMessage",
      "rootIdentity",
      "startTime",
      "state",
      "status",
      "stopReason",
      "supplierDetail",
      "systemPrefix",
      "taskId",
      "terminal",
      "toolUseId",
      "transcriptPath",
      "turnId",
    ]);
  });

  it("no excluded vocabulary and no secret literal reaches the payload", () => {
    // Independent of the roster above: names the roster might later absorb are
    // still rejected here by text, so the two nets cannot both miss at once.
    // `secret` and `value` are deliberately absent from the list — the mask
    // placeholder is `<<<SECRET_N>>>` and is *supposed* to travel in a
    // message, so a substring ban on those words would forbid the feature and
    // teach nothing. The canary assertion below is the real value check.
    for (const forbidden of [
      "decision",
      "rules",
      "match",
      "grant",
      "allow-once",
      "always-allow",
      "SecretRegistry",
      "credential",
      "apiKey",
      "askUser",
    ]) {
      assert.equal(
        text.toLowerCase().includes(forbidden.toLowerCase()),
        false,
        `serialized saved state must not mention ${forbidden}`
      );
    }
    assert.equal(text.includes(masked), true);
    assert.equal(text.includes(SECRET_CANARY), false);
  });

  it("no field of the maximal request can hold a function that survives JSON", () => {
    // Every payload field the port declares is a JSON primitive, so a grant's
    // predicate cannot be smuggled in as a function the way a live object could.
    const seen: string[] = [];
    JSON.stringify(payload, (_key, value: unknown) => {
      if (typeof value === "function") seen.push(String(value));
      return value;
    });
    assert.deepEqual(seen, []);
  });
});

// -- 2. source: the contract itself names none of the excluded state ----------

/** Drop block and line comments so a doc that must name the state is not a hit. */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("saved state carries no permission decision — contract source", () => {
  const source = readFileSync(PORT_FILE, "utf8");
  const code = codeOf(source);

  it("the scan reads the real port file, comments excluded", () => {
    // Non-vacuity. Without this, a rename of the file would make every
    // assertion below pass by scanning nothing.
    assert.equal(source.includes("RuntimeSavedStateRequest"), true);
    assert.ok(
      code.length > 0 && code.length < source.length,
      "comment stripping must leave a smaller, non-empty body"
    );
    assert.equal(code.includes("Deliberately absent"), false);
  });

  it("the port imports nothing, so no store type can ride in on an import", () => {
    // The module doc's own claim: src/shared/ is the neutral layer, and a
    // dependency is how a project type (a grant store, a credential) would
    // first become reachable from a payload.
    assert.deepEqual(
      code.split("\n").filter((l) => /^\s*import\b/.test(l)),
      []
    );
  });

  it("the port names no grant store, secret registry, or credential", () => {
    for (const forbidden of [
      "SessionGrants",
      "createSessionGrants",
      "sessionGrants",
      "SecretRegistry",
      "createSecretRegistry",
      "resolveAsk",
      "apiKey",
      "isolation-credentials",
      "settings.llm",
      "allow-once",
      "permission",
      "grant",
      "secret",
      "credential",
    ]) {
      assert.equal(
        code.includes(forbidden),
        false,
        `the persistence port must not name ${forbidden}`
      );
    }
  });
});

// -- 3. the exposure that is one accessor away -------------------------------

describe("a grants snapshot is plain data; the store object is not", () => {
  function rule(
    id: string,
    decision: NormalRuleSpec["decision"]
  ): NormalRuleSpec {
    return {
      id,
      match: ({ tool }) => tool === "demo_write",
      decision,
      reason: `always-allow from session: demo_write`,
    };
  }

  it("the store object stringifies to nothing, its snapshot stringifies to a grant", () => {
    const grants = createSessionGrants();
    grants.add(rule(GRANT_ID, "allow"));

    // The store keeps its rules in a closure Map and hands out only
    // functions, so the object a host spreads into engine options survives
    // JSON as its layer tag and nothing else — no rule id, no decision.
    assert.deepEqual(JSON.parse(JSON.stringify(grants)), { kind: "session" });

    // The snapshot is the opposite: { id, decision, reason } are ordinary
    // values, so any code that reflects a grant snapshot into a payload would
    // write a standing allow into durable storage. Only `match` is lost.
    const snapshot = JSON.parse(
      JSON.stringify(grants.rules())
    ) as ReadonlyArray<Record<string, unknown>>;
    assert.deepEqual(snapshot, [
      {
        id: GRANT_ID,
        decision: "allow",
        reason: "always-allow from session: demo_write",
      },
    ]);
    assert.equal("match" in snapshot[0]!, false);
  });

  it("a rule restored from that snapshot cannot answer a call", () => {
    // Losing the predicate is the only thing standing between a persisted grant
    // and a permission escalation, and it fails loud: layerRuleOutcome calls
    // rule.match(ctx) unguarded, so the call throws rather than proceeding.
    const grants = createSessionGrants();
    grants.add(rule(GRANT_ID, "allow"));
    const revived = JSON.parse(
      JSON.stringify(grants.rules())
    ) as ReadonlyArray<NormalRuleSpec>;
    const policy = createPermissionPolicy();
    const input: CheckPermissionInput = {
      def: aciTool("demo_write", "write"),
      input: { path: "notes.txt" },
      sources: {
        ...policy.sources,
        session: { kind: "session", rules: () => revived },
      },
      hardWalls: policy.hardWalls,
      defaultByCategory: policy.defaultByCategory,
      mode: policy.mode,
    };
    assert.throws(() => checkPermission(input), /match is not a function/);
  });
});

// -- 4. behavior: a runtime that holds no rule re-asks ------------------------

function aciTool(name: string, category: AciCategory): AciToolDef {
  return Object.freeze({
    name,
    description: `test ${name}`,
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: Object.freeze({
      category,
      isConcurrencySafe: category === "read-only",
      interruptBehavior:
        category === "write" ? ("block" as const) : ("cancel" as const),
      timeoutTier: "default" as const,
    }),
  }) as AciToolDef;
}

function registryOf(defs: ReadonlyArray<AciToolDef>): Registry {
  const all: ReadonlyArray<ToolDef> = defs;
  return Object.freeze({
    list: () => all,
    get: (name: string) => all.find((t) => t.name === name),
  });
}

function innerSpy(): { executor: Executor; calls: ToolCall[][] } {
  const calls: ToolCall[][] = [];
  const executor: Executor = Object.freeze({
    executeAll: async (
      batch: ReadonlyArray<ToolCall>
    ): Promise<ReadonlyArray<ToolExecutionResult>> => {
      calls.push([...batch]);
      return batch.map((c) => ({
        kind: "ok" as const,
        toolUseId: c.id,
        payload: [{ type: "text" as const, text: `executed:${c.name}` }],
      }));
    },
  });
  return { executor, calls };
}

/** The runtime a host builds for a session that holds these grants. */
function runtimeFor(session: ReturnType<typeof createSessionGrants>): {
  runtime: PermissionRuntime;
  asked: string[];
  inner: ReturnType<typeof innerSpy>;
} {
  const asked: string[] = [];
  const askUser: AskUser = async (ctx) => {
    asked.push(ctx.tool);
    return false; // a human who declines
  };
  const inner = innerSpy();
  const policy = createPermissionPolicy({ session });
  const runtime = createPermissionRuntime({
    inner: inner.executor,
    registry: registryOf([aciTool("demo_write", "write")]),
    policy,
    askUser,
  });
  return { runtime, asked, inner };
}

const DEMO_CALL: ToolCall = Object.freeze({
  id: "toolu_01",
  name: "demo_write",
  input: { path: "notes.txt", content: "x" },
});

// Not proven here: SC18's reopen half. Nothing below writes durable state, kills
// a process, or reads a store back — the cases build the runtime and the payload
// directly, so they pin the re-ask rule and the payload's closed value space.
// The fresh-process reopen SC18/ SC25 ask for is the session host's (plan A)
// evidence; this layer proves only what a recovered runtime may not inherit.
describe("a runtime holding no stored rule asks again under current rules", () => {
  it("the grant holds in the live process and cannot reach the payload", async () => {
    const secrets = createSecretRegistry();
    const placeholder = secrets.register(SECRET_CANARY);

    const grants = createSessionGrants();
    grants.add({
      id: GRANT_ID,
      match: ({ tool }) => tool === "demo_write",
      decision: "allow",
      reason: "always-allow from session: demo_write",
    });
    const live = runtimeFor(grants);
    const gate = await live.runtime.gateOne(DEMO_CALL);
    // Baseline: the grant is genuinely in force, so the assertions below are
    // about a grant that existed rather than about one that never did.
    assert.equal(gate.kind, "proceed");
    assert.deepEqual(live.asked, []);

    const published: RuntimeSavedStateRequest<string>[] = [];
    const facts: unknown[] = [];
    const sink = {
      publishSavedState: async (r: RuntimeSavedStateRequest<string>) => {
        published.push(r);
      },
      appendOperationFact: async (f: unknown) => {
        facts.push(f);
      },
    };
    await sink.publishSavedState({
      ...maximalRequest(placeholder),
      messages: [`operator pasted ${placeholder} earlier`],
    });
    await sink.appendOperationFact(maximalToolResultFact());
    await sink.appendOperationFact(maximalGraphNodeFact());
    await sink.appendOperationFact(maximalWorkerFact());
    const durable = JSON.stringify({ published, facts });

    assert.equal(durable.includes(GRANT_ID), false);
    assert.equal(durable.includes("always-allow"), false);
    assert.equal(durable.includes(SECRET_CANARY), false);
    // The masked text is what travels; the value stays in process memory.
    assert.equal(durable.includes(placeholder), true);
  });

  it("a runtime built on an empty grant store re-asks, and a decline blocks the call", async () => {
    const noStoredRules = runtimeFor(createSessionGrants());
    const gate = await noStoredRules.runtime.gateOne(DEMO_CALL);

    // The load-bearing assertion: reaching askUser at all. A `deny` here would
    // mean a stored rule or a hard wall answered the call, and neither is what
    // a runtime without rules is allowed to do.
    assert.deepEqual(noStoredRules.asked, ["demo_write"]);
    assert.equal(gate.kind, "blocked");
    if (gate.kind === "blocked") {
      assert.equal(gate.result.kind, "execution_failed");
      assert.match(
        (gate.result as { message: string }).message,
        /^\[user_denied\] user declined tool call: demo_write$/
      );
    }
    assert.deepEqual(noStoredRules.inner.calls, []);
  });

  it("a fresh decision is what unblocks the call, and the secret stays inert", async () => {
    const approvals: string[] = [];
    const approving: AskUser = async (ctx) => {
      approvals.push(ctx.tool);
      return true;
    };
    const policy = createPermissionPolicy({ session: createSessionGrants() });
    const runtime = createPermissionRuntime({
      inner: innerSpy().executor,
      registry: registryOf([aciTool("demo_write", "write")]),
      policy,
      askUser: approving,
    });
    assert.equal((await runtime.gateOne(DEMO_CALL)).kind, "proceed");
    assert.deepEqual(approvals, ["demo_write"]);

    const fresh = createSecretRegistry();
    assert.equal(fresh.size, 0);
    assert.equal(fresh.resolve("<<<SECRET_1>>>"), undefined);
    assert.equal(
      restore("paste <<<SECRET_1>>> to continue", fresh),
      "paste <<<SECRET_1>>> to continue"
    );
  });
});
