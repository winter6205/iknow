/**
 * ADR-0127 Security-review requirement — C2-a behavior pins.
 *
 * One home for the five requirement faces of this step:
 *   1. the positive inertness proof (proven roster; everything else that
 *      looks dangerous is a requirement, never an automatic allow),
 *   2. nested-deny priority (a confirmed inner denial outranks the outer
 *      review, including at the substitution depth caps),
 *   3. heredoc receiver attribution (one parse-derived owner rule feeding
 *      both the destructive and the sensitive-path walls),
 *   4. the sensitive-path judgments staying distinct from destructive-text
 *      inertness,
 *   5. the input/failure contract (typed invalid / fault / aborted arms).
 * Plus the gate placement (deny > review > grants > mode allowance, plan
 * deny intact) and the executor's per-call review gate.
 *
 * Hostile payloads are hand-built in the SC19 style of
 * substitution-matrix.test.ts: the crafted-shape arms of the input contract
 * are properties of the scanner over its declared input type, not of the
 * parser, and the parser cannot be made to emit them.
 */

import { describe, expect, it, vi } from "vitest";
import {
  analyzeSecurityReview,
  securityReviewForParse,
} from "../../../src/harness/permission/hard-walls.js";
import type { SecurityReviewScan } from "../../../src/harness/permission/hard-walls.js";
import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
import type {
  CommandFact,
  FactSpan,
  HeredocFact,
  SecurityParseOk,
  SubstitutionFact,
  WordFact,
} from "../../../src/harness/permission/shell-parse.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/permission/policy.js";
import { createSessionGrants } from "../../../src/harness/permission/session-grants.js";
import { createPermissionExecutor } from "../../../src/harness/permission/permission-executor.js";
import {
  SECURITY_REVIEW_DENY_PREFIX,
  SECURITY_REVIEW_OPTION,
  type SecurityReviewRequest,
  type SecurityReviewRoute,
} from "../../../src/harness/permission/security-review.js";
import type { PermissionMode } from "../../../src/harness/permission/modes.js";
import type {
  AskUser,
  PermissionOutcome,
} from "../../../src/harness/permission/types.js";
import type {
  AciCategory,
  AciToolDef,
} from "../../../src/harness/aci/types.js";
import type {
  Executor,
  ToolCall,
  ToolExecutionResult,
  ToolDef,
} from "../../../src/harness/tools/types.js";

/* ------------------------------------------------------------------ */
/* shared helpers                                                      */
/* ------------------------------------------------------------------ */

function makeTool(name: string, category: AciCategory): AciToolDef {
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
  });
}

const BASH = makeTool("bash", "execute");

function outcome(
  input: unknown,
  mode?: PermissionMode,
  sessionAllowAll = false
): PermissionOutcome {
  const session = createSessionGrants();
  if (sessionAllowAll) {
    session.add({
      id: "session-allow-all",
      match: () => true,
      decision: "allow",
      reason: "session allows everything",
    });
  }
  const policy = createPermissionPolicy({
    ...(mode !== undefined ? { mode } : {}),
    ...(sessionAllowAll ? { session } : {}),
  });
  return checkPermission({
    def: BASH,
    input,
    sources: policy.sources,
    hardWalls: policy.hardWalls,
    defaultByCategory: policy.defaultByCategory,
    mode: policy.mode,
  });
}

const REVIEW_COMMAND = "chroot /srv rm -rf /tmp/x";

/* ------------------------------------------------------------------ */
/* 1. the positive inertness proof                                     */
/* ------------------------------------------------------------------ */

describe("ADR-0127 SC-S2-9 — positive inertness proof, not roster complement", () => {
  const PROVEN = [
    "echo",
    "cat",
    "test",
    "head",
    "grep",
    "printf",
    "ls",
    "notify-send",
  ] as const;

  it.each(PROVEN)(
    "`%s rm -rf /tmp/x` is positively proven inert: no review, ordinary flow",
    (name) => {
      const command = `${name} rm -rf /tmp/x`;
      expect(analyzeSecurityReview(command).verdict, command).toBe("clean");
      const plain = outcome({ command });
      expect(plain.decision).toBe("ask");
      expect(plain.securityReview).toBeUndefined();
      // full_auto may answer the ordinary ask — the proof's whole point.
      const auto = outcome({ command }, "full_auto");
      expect(auto.decision).toBe("allow");
      expect(auto.securityReview).toBeUndefined();
    }
  );

  it("`echo rmdir` and `grep rm -rf /tmp/x` stay relaxed", () => {
    for (const command of ["echo rmdir", "grep rm -rf /tmp/x"]) {
      expect(analyzeSecurityReview(command).verdict, command).toBe("clean");
      expect(outcome({ command }).securityReview, command).toBeUndefined();
    }
  });

  it("awk is NOT proven inert: its program operand can call system()", () => {
    const command = `awk 'BEGIN{system("rm -rf /tmp/x")}'`;
    const scan = analyzeSecurityReview(command);
    expect(scan.verdict).toBe("review");
    if (scan.verdict === "review") {
      expect(scan.requirement.cause).toBe("execution-unresolved");
    }
    const out = outcome({ command });
    expect(out.decision).toBe("ask");
    expect(out.securityReview?.cause).toBe("execution-unresolved");
    // full_auto may not price this as data either.
    const auto = outcome({ command }, "full_auto");
    expect(auto.decision).toBe("ask");
    expect(auto.securityReview?.cause).toBe("execution-unresolved");
  });

  it("`chroot /srv rm -rf /tmp/x` is not classified inert (cross-word operand)", () => {
    const scan = analyzeSecurityReview(REVIEW_COMMAND);
    expect(scan.verdict).toBe("review");
    if (scan.verdict === "review") {
      expect(scan.requirement.cause).toBe("execution-unresolved");
      expect(scan.requirement.span).toEqual({ start: 0, end: 25 });
      expect(scan.requirement.detail.length).toBeGreaterThan(0);
    }
    expect(outcome({ command: REVIEW_COMMAND }).decision).toBe("ask");
    expect(outcome({ command: REVIEW_COMMAND }, "full_auto").decision).toBe(
      "ask"
    );
  });

  it("an unknown head with no security-relevant pattern stays clean", () => {
    expect(analyzeSecurityReview("chroot /srv ls -la").verdict).toBe("clean");
    expect(outcome({ command: "chroot /srv ls -la" }).securityReview).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 2. nested-deny priority                                             */
/* ------------------------------------------------------------------ */

describe("ADR-0127 — a confirmed inner denial outranks the outer review", () => {
  it("`chroot /srv $(rm -rf /)`: outer review is owed, inner deny wins", () => {
    const command = "chroot /srv $(rm -rf /)";
    // The review scanner by itself WOULD ask about the outer chroot node…
    expect(analyzeSecurityReview(command).verdict).toBe("review");
    // …but the policy's deny tier speaks first, in every mode.
    for (const mode of ["default", "plan", "full_auto"] as PermissionMode[]) {
      const out = outcome({ command }, mode);
      expect(out.decision, `${command} in ${mode}`).toBe("deny");
      expect(out.reason).toContain("[hard_wall]");
      expect(out.securityReview).toBeUndefined();
    }
  });

  it("depth-cap descents: a confirmed denial below the cap still denies", () => {
    // The inner `rm -rf /` sits three substitution levels deep, past the
    // analysis budget; the deny-only descent at the cap reports it.
    for (const command of [
      "chroot /srv $($(($(rm -rf /))))",
      "echo $($(($(rm -rf /))))",
    ]) {
      for (const mode of ["default", "plan", "full_auto"] as PermissionMode[]) {
        const out = outcome({ command }, mode);
        expect(out.decision, `${command} in ${mode}`).toBe("deny");
        expect(out.reason).toContain("[hard_wall]");
      }
    }
  });

  it("budget exhaustion WITH relevant content is the review's, not an ordinary ask", () => {
    // A substitution site the parse attaches to no command node: the walk
    // is out of budget, the content is security-relevant. Crafted payload,
    // SC19-style.
    const parse = dollarParenOk({
      commands: [BENIGN_COMMAND],
      substitutions: [
        {
          kind: "dollar-paren",
          span: span(5, 16),
          innerCommandIndex: null,
          ownerCommandIndex: 0,
        },
      ],
    });
    const scan = securityReviewForParse(parse);
    expect(scan.verdict).toBe("review");
    if (scan.verdict === "review") {
      expect(scan.requirement.cause).toBe("bounded-analysis-exhausted");
      expect(scan.requirement.span).toEqual({ start: 5, end: 16 });
      expect(scan.requirement.detail.length).toBeGreaterThan(0);
    }
  });

  it("content-free budget exhaustion keeps today's ordinary ask flow", () => {
    const command = "echo $($(($(true))))";
    expect(analyzeSecurityReview(command).verdict).toBe("clean");
    const out = outcome({ command });
    expect(out.decision).toBe("ask");
    expect(out.reason).toContain("substitution ask:");
    expect(out.securityReview).toBeUndefined();
    // The proof it is an ordinary ask and not a review: full_auto answers it.
    expect(outcome({ command }, "full_auto").decision).toBe("allow");
  });
});

/* ------------------------------------------------------------------ */
/* 3. heredoc receiver attribution                                     */
/* ------------------------------------------------------------------ */

describe("ADR-0127 — heredoc receiver attribution in a multi-command segment", () => {
  it("`cd /tmp && bash <<'EOF'` attributes the redirect to bash, parse-derived", () => {
    const parse = parseForSecurity("cd /tmp && bash <<'EOF'\nrm -rf /\nEOF\n");
    expect(parse.kind).toBe("ok");
    if (parse.kind !== "ok") return;
    expect(parse.heredocs.length).toBe(1);
    const heredoc = parse.heredocs[0]!;
    expect(heredoc.delimiterQuoted).toBe(true);
    expect(heredoc.receiverCommandIndex).toBe(1);
    const receiver = parse.commands.find((c) => c.index === 1);
    expect(receiver?.argv[0]?.text).toBe("bash");
  });

  it("an attributed code receiver + destructive body is a confirmed deny", () => {
    const command = "cd /tmp && bash <<'EOF'\nrm -rf /\nEOF\n";
    for (const mode of ["default", "plan", "full_auto"] as PermissionMode[]) {
      const out = outcome({ command }, mode);
      expect(out.decision, `${mode}`).toBe("deny");
      expect(out.reason).toContain("destructive-rm");
    }
  });

  it("an attributed proven-inert receiver + dangerous body is priced as data", () => {
    const command = "cd /tmp && cat <<'EOF'\nrm -rf /\nEOF\n";
    expect(analyzeSecurityReview(command).verdict).toBe("clean");
    const out = outcome({ command });
    expect(out.decision).toBe("ask");
    expect(out.securityReview).toBeUndefined();
    expect(outcome({ command }, "full_auto").decision).toBe("allow");
  });

  it("a missing receiver + dangerous quoted body → receiver-unresolved review", () => {
    const command = "while read x; do :; done <<'EOF'\nrm -rf /\nEOF\n";
    const out = outcome({ command });
    expect(out.decision).toBe("ask");
    expect(out.securityReview?.cause).toBe("receiver-unresolved");
    // Never priced as data: full_auto still must not allow.
    const auto = outcome({ command }, "full_auto");
    expect(auto.decision).toBe("ask");
    expect(auto.securityReview?.cause).toBe("receiver-unresolved");
  });

  it("a named-but-unclassified receiver + relevant body → data-ownership review, never an allow", () => {
    const command = "cd /tmp && git apply <<'EOF'\n~/.ssh/id_rsa\nEOF\n";
    const out = outcome({ command });
    expect(out.decision).toBe("ask");
    expect(out.securityReview?.cause).toBe("data-ownership-unresolved");
    expect(outcome({ command }, "full_auto").securityReview?.cause).toBe(
      "data-ownership-unresolved"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 4. sensitive-path judgments stay distinct                           */
/* ------------------------------------------------------------------ */

describe("ADR-0127 SC-S2-7 — operand/redirect judgments distinct from inertness", () => {
  it("a proven-inert head does not excise a sensitive redirect target", () => {
    const command = "echo secret >> /home/u/.ssh/id_rsa";
    for (const mode of ["default", "plan", "full_auto"] as PermissionMode[]) {
      const out = outcome({ command }, mode);
      expect(out.decision, `${mode}`).toBe("deny");
      expect(out.reason).toContain("sensitive path");
    }
  });

  it("a single-quoted sensitive operand is judged, not excised", () => {
    const command = `cat '.ssh/id_rsa'`;
    const out = outcome({ command });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("sensitive path");
  });

  it("a code receiver's quoted body is judged whole for sensitive paths too", () => {
    const command = "cd /tmp && bash <<'EOF'\ncat ~/.ssh/id_rsa\nEOF\n";
    const out = outcome({ command });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("sensitive path");
  });

  it("the review-priced receiver gap does not become a sensitive-path deny", () => {
    // The same body under an unclassified receiver: the sensitive wall
    // excises (its match belongs to the review), and the review prices it.
    const command = "cd /tmp && git apply <<'EOF'\n~/.ssh/id_rsa\nEOF\n";
    expect(outcome({ command }).decision).toBe("ask");
    expect(outcome({ command }).reason).not.toContain("[hard_wall]");
  });
});

/* ------------------------------------------------------------------ */
/* 5. input and failure contract                                       */
/* ------------------------------------------------------------------ */

describe("ADR-0127 — the input/failure contract", () => {
  it("the empty valid command asks nobody anything", () => {
    expect(analyzeSecurityReview("").verdict).toBe("clean");
    const out = outcome({ command: "" });
    expect(out.securityReview).toBeUndefined();
    expect(out.decision).toBe("ask");
    expect(outcome({ command: "" }, "full_auto").decision).toBe("allow");
  });

  it("a non-string command is a typed invalid deny with a non-empty reason", () => {
    for (const bad of [42, null, {}, true]) {
      const scan = analyzeSecurityReview(bad);
      expect(scan.verdict, JSON.stringify(bad)).toBe("invalid");
      if (scan.verdict === "invalid") {
        expect(scan.reason.length).toBeGreaterThan(0);
      }
      const out = outcome({ command: bad });
      expect(out.decision).toBe("deny");
      // Review M-pin: the policy invalid deny carries the bracketed SSOT
      // prefix shape ([security_review_input_invalid] in prefixes.ts).
      expect(out.reason).toContain("[security_review_input_invalid]");
      expect(out.reason.length).toBeGreaterThan(
        "[security_review_input_invalid]".length
      );
    }
  });

  it("an absent command field is the schema layer's, not an invalid deny", () => {
    const out = outcome({});
    expect(out.decision).toBe("ask");
    expect(out.reason).not.toContain("security review");
  });

  it("a negative command span is a typed invalid verdict", () => {
    const parse = okWith({
      text: REVIEW_COMMAND,
      commands: [
        {
          index: 0,
          argv: [
            word("chroot"),
            word("/srv"),
            word("rm"),
            word("-rf"),
            word("/tmp/x"),
          ],
          span: { start: -5, end: 25 },
          depth: 0,
        },
      ],
    });
    const scan = securityReviewForParse(parse);
    expect(scan.verdict).toBe("invalid");
    if (scan.verdict === "invalid") {
      expect(scan.reason).toContain("span");
      expect(scan.reason.length).toBeGreaterThan(0);
    }
    // And the policy turns an invalid scan into a typed deny (same rendering
    // as the non-string arm): asserted through the string-level entry's use
    // of the same scanner.
  });

  it("an out-of-bounds heredoc bodySpan is a typed invalid verdict", () => {
    const parse = heredocOk({
      receiverCommandIndex: 1,
      bodySpan: { start: 16, end: 999 },
    });
    const scan = securityReviewForParse(parse);
    expect(scan.verdict).toBe("invalid");
    if (scan.verdict === "invalid") {
      expect(scan.reason.length).toBeGreaterThan(0);
    }
  });

  it("a relevant heredoc receiver with no command word is a typed invalid verdict", () => {
    const wordless: CommandFact = {
      index: 1,
      argv: [],
      span: span(8, 15),
      depth: 0,
    };
    const parse = heredocOk({ receiverCommandIndex: 1, commands: [wordless] });
    const scan = securityReviewForParse(parse);
    expect(scan.verdict).toBe("invalid");
    if (scan.verdict === "invalid") {
      expect(scan.reason).toContain("command word");
    }
  });

  it("an attribution-evaluator throw is a typed fault verdict, never a rethrow", () => {
    const base = okWith({});
    const throwing = {
      ...base,
    } as SecurityParseOk & { commands: unknown };
    Object.defineProperty(throwing, "commands", {
      get() {
        throw new TypeError("hostile fact graph");
      },
    });
    const scan = securityReviewForParse(throwing as unknown as SecurityParseOk);
    expect(scan.verdict).toBe("fault");
    if (scan.verdict === "fault") {
      expect(scan.reason).toContain("attribution analysis threw (TypeError)");
    }
  });

  it("the scan is total: no verdict but the four, and it never throws", () => {
    const junk = [
      "if",
      "((",
      "<<<",
      "echo $( cat <<'EOF'\n rm -rf / \nEOF\n ) | sh",
      "\u0000rm -rf /",
      "rm -rf /".repeat(200),
    ];
    for (const command of junk) {
      let scan: SecurityReviewScan | undefined;
      expect(() => {
        scan = analyzeSecurityReview(command);
      }, JSON.stringify(command)).not.toThrow();
      expect(["clean", "review", "invalid", "fault"]).toContain(scan!.verdict);
    }
  });

  it("a non-`ok` parse keeps the parse tier's own typed answers", () => {
    // `if` parses malformed: the review layer has nothing to ask, and the
    // parse tier's handling (never an automatic allow) stands.
    expect(analyzeSecurityReview("if").verdict).toBe("clean");
    const out = outcome({ command: "if" });
    expect(out.decision).not.toBe("allow");
    expect(out.securityReview).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* gate placement: deny > review > grants > mode allowance             */
/* ------------------------------------------------------------------ */

describe("ADR-0127 SC-GATES-5 — review placement in checkPermission", () => {
  it("a session grant cannot answer a review requirement", () => {
    const out = outcome({ command: REVIEW_COMMAND }, undefined, true);
    expect(out.decision).toBe("ask");
    expect(out.securityReview?.cause).toBe("execution-unresolved");
    expect(out.reason).toContain("security review required");
  });

  it("full_auto cannot answer a review requirement either", () => {
    const out = outcome({ command: REVIEW_COMMAND }, "full_auto");
    expect(out.decision).toBe("ask");
    expect(out.securityReview).not.toBeUndefined();
  });

  it("plan mode's mutating deny stays a deny", () => {
    const out = outcome({ command: REVIEW_COMMAND }, "plan");
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("plan blocks mutating tools");
    // The review must not turn it into an approvable ask.
    expect(out.securityReview).toBeUndefined();
  });

  it("a clean command in full_auto is still auto-allowed", () => {
    for (const command of ["ls -la", "git status", "echo rm -rf /tmp/x"]) {
      const out = outcome({ command }, "full_auto");
      expect(out.decision, command).toBe("allow");
      expect(out.securityReview, command).toBeUndefined();
    }
  });

  it("the requirement is carried additively: decision + reason + span, cause typed", () => {
    const out = outcome({ command: REVIEW_COMMAND });
    expect(out.decision).toBe("ask");
    const requirement = out.securityReview;
    expect(requirement).not.toBeUndefined();
    expect([
      "execution-unresolved",
      "data-ownership-unresolved",
      "receiver-unresolved",
      "bounded-analysis-exhausted",
    ]).toContain(requirement!.cause);
    expect(requirement!.span.start).toBe(0);
    expect(requirement!.span.end).toBe(25);
    expect(requirement!.detail.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* executor: the per-call review gate                                  */
/* ------------------------------------------------------------------ */

interface InnerSpy {
  readonly executor: Executor;
  readonly calls: ToolCall[][];
}

function makeInner(): InnerSpy {
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

function makeRegistry(defs: AciToolDef[]) {
  const all: ToolDef[] = defs;
  return Object.freeze({
    list: () => all,
    get: (name: string) => all.find((t) => t.name === name),
  });
}

function makeExecutor(opts: {
  readonly mode?: PermissionMode;
  readonly askUser: AskUser;
  readonly route?: SecurityReviewRoute;
  readonly inner: InnerSpy;
}) {
  const policy = createPermissionPolicy({
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
  });
  return createPermissionExecutor({
    inner: opts.inner.executor,
    registry: makeRegistry([BASH]),
    policy,
    askUser: opts.askUser,
    ...(opts.route !== undefined
      ? { [SECURITY_REVIEW_OPTION]: opts.route }
      : {}),
  });
}

function bashCall(id: string, command: string): ToolCall {
  return { id, name: "bash", input: { command } };
}

describe("ADR-0127 — the executor's per-call review gate", () => {
  it("the route option name is the frozen contract's", () => {
    expect(SECURITY_REVIEW_OPTION).toBe("securityReview");
  });

  it("no route: typed deny naming cause and span; the ordinary ask is NOT called", async () => {
    const ask = vi.fn(() => true);
    const inner = makeInner();
    const ex = makeExecutor({
      askUser: ask as unknown as AskUser,
      inner,
    });
    const result = await ex.executeAll([bashCall("u1", REVIEW_COMMAND)]);
    const r = result[0]!;
    expect(r.kind).toBe("execution_failed");
    if (r.kind === "execution_failed") {
      expect(r.message.startsWith(SECURITY_REVIEW_DENY_PREFIX)).toBe(true);
      expect(r.message).toContain("cause=execution-unresolved");
      expect(r.message).toContain("span=0-25");
      expect(r.message).toContain("(bash)");
    }
    expect(ask).not.toHaveBeenCalled();
    expect(inner.calls.length).toBe(0);
  });

  it("default mode: the route is asked exactly once per call, fresh ids", async () => {
    const requests: SecurityReviewRequest[] = [];
    const route: SecurityReviewRoute = {
      interactive: true,
      request: async (req) => {
        requests.push(req);
        return true;
      },
    };
    const ask = vi.fn(() => true);
    const inner = makeInner();
    const ex = makeExecutor({
      askUser: ask as unknown as AskUser,
      route,
      inner,
    });
    const result = await ex.executeAll([
      bashCall("u1", REVIEW_COMMAND),
      bashCall("u2", REVIEW_COMMAND),
    ]);
    expect(result.map((r) => r.kind)).toEqual(["ok", "ok"]);
    expect(requests.length).toBe(2);
    expect(new Set(requests.map((q) => q.requestId)).size).toBe(2);
    expect(requests[0]!.requestId).toContain("u1");
    expect(requests[1]!.requestId).toContain("u2");
    expect(requests[0]!.requirement.cause).toBe("execution-unresolved");
    // The ordinary inlet is never the answer to a review.
    expect(ask).not.toHaveBeenCalled();
    expect(inner.calls.length).toBe(2);
  });

  it("full_auto mode: a review is STILL put to the route, once, per call", async () => {
    const requests: SecurityReviewRequest[] = [];
    const route: SecurityReviewRoute = {
      interactive: true,
      request: async (req) => {
        requests.push(req);
        return true;
      },
    };
    const inner = makeInner();
    const ex = makeExecutor({
      mode: "full_auto",
      askUser: (async () => false) as AskUser,
      route,
      inner,
    });
    const first = await ex.executeAll([bashCall("u1", REVIEW_COMMAND)]);
    expect(first[0]!.kind).toBe("ok");
    // Second call of the SAME command: the first approval does not persist.
    const second = await ex.executeAll([bashCall("u2", REVIEW_COMMAND)]);
    expect(second[0]!.kind).toBe("ok");
    expect(requests.length).toBe(2);
    expect(new Set(requests.map((q) => q.requestId)).size).toBe(2);
  });

  it("route answers false → deny with the recorded cause; inner never called", async () => {
    const route: SecurityReviewRoute = {
      interactive: true,
      request: async () => false,
    };
    const inner = makeInner();
    const ex = makeExecutor({
      askUser: (async () => true) as AskUser,
      route,
      inner,
    });
    const result = await ex.executeAll([bashCall("u1", REVIEW_COMMAND)]);
    const r = result[0]!;
    expect(r.kind).toBe("execution_failed");
    if (r.kind === "execution_failed") {
      expect(r.message.startsWith(SECURITY_REVIEW_DENY_PREFIX)).toBe(true);
      expect(r.message).toContain("cause=execution-unresolved");
    }
    expect(inner.calls.length).toBe(0);
  });

  it("route throws → typed deny with the cause, never a fall-through to the ask", async () => {
    const ask = vi.fn(() => true);
    const route: SecurityReviewRoute = {
      interactive: true,
      request: async () => {
        throw new Error("disconnected");
      },
    };
    const inner = makeInner();
    const ex = makeExecutor({
      askUser: ask as unknown as AskUser,
      route,
      inner,
    });
    const result = await ex.executeAll([bashCall("u1", REVIEW_COMMAND)]);
    expect(result[0]!.kind).toBe("execution_failed");
    expect(ask).not.toHaveBeenCalled();
    expect(inner.calls.length).toBe(0);
  });

  it("a clean command in full_auto never reaches the route", async () => {
    const request = vi.fn(async () => true);
    const route: SecurityReviewRoute = { interactive: true, request };
    const inner = makeInner();
    const ex = makeExecutor({
      mode: "full_auto",
      askUser: (async () => false) as AskUser,
      route,
      inner,
    });
    const result = await ex.executeAll([bashCall("u1", "ls -la")]);
    expect(result[0]!.kind).toBe("ok");
    expect(request).not.toHaveBeenCalled();
  });

  it("a proven-inert command follows the ordinary ask flow through the executor", async () => {
    const request = vi.fn(async () => false);
    const route: SecurityReviewRoute = { interactive: true, request };
    const ask = vi.fn(async () => true);
    const inner = makeInner();
    const ex = makeExecutor({
      askUser: ask as unknown as AskUser,
      route,
      inner,
    });
    const result = await ex.executeAll([bashCall("u1", "echo rm -rf /tmp/x")]);
    // The route's refusal must not touch this call: the ordinary inlet
    // answers it, and approve wins.
    expect(result[0]!.kind).toBe("ok");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    expect(inner.calls.length).toBe(1);
  });

  it("a hard-wall denial outranks even a route that would approve", async () => {
    const request = vi.fn(async () => true);
    const route: SecurityReviewRoute = { interactive: true, request };
    const inner = makeInner();
    const ex = makeExecutor({
      askUser: (async () => true) as AskUser,
      route,
      inner,
    });
    const result = await ex.executeAll([bashCall("u1", "rm -rf /")]);
    expect(result[0]!.kind).toBe("execution_failed");
    if (result[0]!.kind === "execution_failed") {
      expect(result[0]!.message).toContain("[permission_denied]");
    }
    expect(request).not.toHaveBeenCalled();
    expect(inner.calls.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* hand-built SecurityParseOk payloads (SC19 idiom, local copy)        */
/* ------------------------------------------------------------------ */

function word(text: string): WordFact {
  return { text, quoteKind: "none", span: { start: 0, end: text.length } };
}

function span(start: number, end: number): FactSpan {
  return { start, end };
}

const BENIGN_COMMAND: CommandFact = {
  index: 0,
  argv: [word("echo"), word("hi")],
  span: span(0, 7),
  depth: 0,
};

const DOLLAR_PAREN_SITE: SubstitutionFact = {
  kind: "dollar-paren",
  span: span(5, 16),
  innerCommandIndex: 1,
  ownerCommandIndex: 0,
};

const INNER_RM: CommandFact = {
  index: 1,
  argv: [word("rm"), word("-rf"), word("/")],
  span: span(7, 15),
  parentId: 0,
  depth: 1,
};

function okWith(overrides: Record<string, unknown>): SecurityParseOk {
  return {
    kind: "ok",
    text: "echo hi",
    nodeTypes: { command: 1 },
    words: [word("echo"), word("hi")],
    commands: [BENIGN_COMMAND],
    substitutions: [],
    expansions: [],
    redirects: [],
    heredocs: [],
    inert: [],
    ...overrides,
  } as unknown as SecurityParseOk;
}

/** `echo $(rm -rf /)` in payload form. */
function dollarParenOk(
  overrides: Record<string, unknown> = {}
): SecurityParseOk {
  return okWith({
    text: "echo $(rm -rf /)",
    commands: [BENIGN_COMMAND, INNER_RM],
    substitutions: [DOLLAR_PAREN_SITE],
    ...overrides,
  });
}

/**
 * `echo hi <<'EOF'` + a `rm -rf /` body: the receiver command (index 1,
 * argv head overridable) is `git` — a named, unclassified receiver — so the
 * baseline payload answers the data-ownership review. Arms below mutate one
 * field at a time.
 */
function heredocOk(
  overrides: Partial<{
    receiverCommandIndex: number | null;
    bodySpan: FactSpan;
    commands: readonly CommandFact[];
    delimiterQuoted: boolean;
  }> = {}
): SecurityParseOk {
  const text = "echo hi <<'EOF'\nrm -rf /\nEOF\n";
  const bodySpan = overrides.bodySpan ?? span(16, 24);
  const receiverCommandIndex = overrides.receiverCommandIndex ?? 1;
  const commands =
    overrides.commands ??
    ([
      { ...BENIGN_COMMAND },
      { index: 1, argv: [word("git")], span: span(0, 7), depth: 0 },
    ] as readonly CommandFact[]);
  const heredoc: HeredocFact = {
    bodySpan,
    delimiterQuoted: overrides.delimiterQuoted ?? true,
    receiverCommandIndex,
  };
  return okWith({ text, commands, heredocs: [heredoc] });
}
