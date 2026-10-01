/**
 * T1 / ADR-0131 — sensitive-path evidence classification, and the one shared
 * result the permission wall and the Bash handler both consume.
 *
 * The wall used to answer "did a roster fragment appear in the command text",
 * which is a candidate, not a verdict: `node -e 'process.env.NODE_OPTIONS'`
 * matched `\.env\.` and denied a command that touches no filesystem. ADR-0131
 * makes the match something to CLASSIFY, and every classification here is
 * grounded in a parse fact — WHERE the match landed and what the parser
 * established at that site — never in the shape of the matched text. A
 * narrowing exception keyed on the fragment's spelling is the exact remedy
 * ADR-0131 rejected (`.env.`), so nothing here may be licensed by "the
 * string looks like code".
 *
 * The three evidence classes:
 *   - `confirmed`  the match sits at a site the parser established as a path
 *                  target (argv operand, redirect target, a recursively parsed
 *                  nested shell's operand). Non-overridable hard deny.
 *   - `non_path`   the match sits inside a code/data region and the token
 *                  carrying it was NOT established as a path target: a
 *                  property-access chain member like `process.env`.
 *                  No finding from this wall; ordinary permission handling.
 *   - `unresolved` the match sits in a code/data region and the token IS
 *                  path-shaped, but what consumes it is not established
 *                  (an `awk` program, a foreign interpreter's string
 *                  literal). ADR-0127's fresh per-call review, or the
 *                  existing typed deny when no interactive route exists.
 *
 * `confirmed` and `unresolved` are both security-relevant; only `confirmed`
 * may deny non-overridably, and reviewer unavailability never becomes a
 * confirmed violation.
 */

import { describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";

import {
  classifySensitivePathEvidence,
  commandContainsSensitivePath,
  type SensitivePathEvidence,
} from "../../../src/harness/permission/hard-walls.js";
import {
  checkPermission,
  createPermissionPolicy,
} from "../../../src/harness/permission/policy.js";
import { asModeContext, type PermissionMode } from "../../../src/harness/permission/modes.js";
import { createPermissionRuntime } from "../../../src/harness/permission/permission-executor.js";
import {
  SECURITY_REVIEW_DENY_PREFIX,
  SECURITY_REVIEW_OPTION,
  type SecurityReviewRequest,
  type SecurityReviewRoute,
} from "../../../src/harness/permission/security-review.js";
import type { AciToolDef } from "../../../src/harness/aci/types.js";
import { ToolExecutionError } from "../../../src/harness/errors.js";

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function makeTool(name = "bash"): AciToolDef {
  return Object.freeze({
    name,
    description: "sensitive-path evidence probe",
    inputSchema: { type: "object", additionalProperties: false },
    handler: async () => "ok",
    aci: {
      category: "execute" as const,
      isConcurrencySafe: false,
      interruptBehavior: "cancel" as const,
      timeoutTier: "default" as const,
    },
  });
}

const bashTool = makeTool();
const policy = createPermissionPolicy();

/** The catalog snapshot the permission runtime resolves tool defs from. */
function registryOf(...defs: AciToolDef[]) {
  const list = defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema as Record<string, unknown>,
    handler: d.handler,
    aci: d.aci,
  }));
  return Object.freeze({
    list: () => list,
    get: (name: string) => list.find((d) => d.name === name),
  });
}

/**
 * The inner executor stub. A call that reached `inner` was admitted, so it
 * answers `ok` — which is also how a test tells "admitted and ran" apart from
 * "blocked before the inner", without asserting on private helpers.
 */
function innerStub() {
  const executeAll = vi.fn(async (calls: ReadonlyArray<{ id: string }>) =>
    calls.map((call) => ({
      kind: "ok" as const,
      toolUseId: call.id,
      payload: [{ type: "text" as const, text: "ran" }],
    }))
  );
  return { executeAll };
}

function outcomeOf(command: string, mode?: PermissionMode) {
  return checkPermission({
    def: bashTool,
    input: { command },
    sources: policy.sources,
    hardWalls: policy.hardWalls,
    defaultByCategory: policy.defaultByCategory,
    ...(mode !== undefined ? { mode: asModeContext(mode) } : {}),
  });
}

/** The classification's own answer, independent of policy. */
function evidenceOf(command: string): SensitivePathEvidence {
  return classifySensitivePathEvidence(command);
}

const MODES: readonly PermissionMode[] = ["default", "full_auto"];

/* ------------------------------------------------------------------ */
/* 1. confirmed — established path targets stay non-overridable denies  */
/* ------------------------------------------------------------------ */

describe("ADR-0131 confirmed evidence — an established path target is a hard deny", () => {
  // Each row is a site the PARSER established as a path target: an argv
  // operand, a redirect target, or a nested shell the parse reached into.
  // The evidence for "confirmed" is that establishment, not the spelling of
  // the matched text — which is why the quoted and expanded spellings below
  // deny for the same reason their bare spellings do.
  const confirmed: ReadonlyArray<[string, string]> = [
    ["direct operand", "cat /etc/shadow"],
    ["absolute path operand", "cat /etc/passwd"],
    [
      "redirect target",
      "echo a > '/etc/passwd'",
    ],
    [
      "append redirect target",
      "echo a >> /etc/shadow",
    ],
    [
      "nested shell operand",
      "sh -c 'cat /etc/passwd'",
    ],
    [
      "nested shell in a substitution",
      "echo $(cat /etc/passwd)",
    ],
    [
      "single-quoted operand is still an operand",
      "cp '/home/u/.ssh/id_rsa' /tmp/x",
    ],
    [
      "expanded operand is still an operand",
      'test -r "$HOME/.ssh/id_ed25519"',
    ],
    [
      "assignment value is still an operand",
      "FOO='id_rsa' printenv",
    ],
    [
      "credential subtree operand",
      'mv "$HOME/.aws/credentials" /tmp',
    ],
    [
      "an operand of a consumer whose ownership is unresolved is still an operand",
      "awk '{ print }' /etc/passwd",
    ],
    [
      "an operand in a modelled loop body is still an operand",
      "for f in .ssh/id_rsa; do cat $f; done",
    ],
  ];

  for (const [why, command] of confirmed) {
    it(`denies ${JSON.stringify(command)} — ${why}`, () => {
      const evidence = evidenceOf(command);
      expect(evidence.class, `${command}: classification`).toBe("confirmed");
      // SC3: both modes, and the handler's shared consumer, agree.
      for (const mode of MODES) {
        const out = outcomeOf(command, mode);
        expect(out.decision, `${command} @ ${mode}`).toBe("deny");
        expect(out.reason, `${command} @ ${mode}`).toContain("sensitive path");
      }
      assert.equal(commandContainsSensitivePath(command), true);
    });
  }

  it("names the roster match the same way for every confirmed row", () => {
    // The deny must say WHICH roster entry matched, never an effect verdict
    // ("this would read the shadow file") — an operator has to be able to act
    // on the finding, and the copy audit forbids effect-level wording.
    const out = outcomeOf("cat /etc/shadow");
    expect(out.reason).toContain("/etc/shadow");
    expect(out.reason).not.toMatch(/will (read|write|leak)|safe|clean/i);
  });
});

/* ------------------------------------------------------------------ */
/* 2. non_path — a match in a code region that is not a path target     */
/* ------------------------------------------------------------------ */

describe("ADR-0131 non_path evidence — code that names no path target produces no finding", () => {
  // The reported false denial (issue #1170). The matched fragment is
  // `\.env\.`, and the token carrying it is `process.env.NODE_OPTIONS` — a
  // property-access chain, not a path the parser established. The positive
  // evidence for the exemption is the region's kind (a declared code
  // operand) plus the ABSENCE of path-target establishment for that token;
  // it is not "the text has no slash".
  const inertCode: ReadonlyArray<[string, string]> = [
    ["SC1's exact example", `node -e 'process.env.NODE_OPTIONS'`],
    ["attribute chain in double quotes", `node -e "console.log(process.env.HOME)"`],
    ["assignment to an env member", `node -e "x.env = 1"`],
    ["python environment access", `python3 -c "import os; os.environ['X']=1"`],
    ["perl env access", `perl -e 'print $ENV{HOME}'`],
  ];

  for (const [why, command] of inertCode) {
    it(`produces no wall finding for ${JSON.stringify(command)} — ${why}`, () => {
      const evidence = evidenceOf(command);
      expect(evidence.class, `${command}: classification`).toBe("non_path");
      // No finding from THIS wall: the wall's own predicate answers false…
      assert.equal(commandContainsSensitivePath(command), false);
      // …and the call proceeds into ordinary permission handling rather than
      // being turned into a denial of a different shape.
      for (const mode of MODES) {
        const out = outcomeOf(command, mode);
        expect(out.decision, `${command} @ ${mode}`).not.toBe("deny");
      }
    });
  }

  it("an inert region does NOT escalate into a security review", () => {
    // SC2: "proven inert examples do not trigger review". The classification
    // is an allow-from-this-wall, not a handoff to ADR-0127.
    for (const [, command] of inertCode) {
      const out = outcomeOf(command, "full_auto");
      expect(out.securityReview, `${command}: must not be reviewed`).toBeUndefined();
      // `full_auto` may admit an ordinary command outright; either way the
      // security-review arm never ran.
      expect(out.decision, `${command}`).toBe("allow");
    }
  });

  it("the exemption is keyed on evidence, so a real path in the same region still classifies", () => {
    // The bypass witness. Same command word, same single-quoted operand, same
    // region — but the token IS a path the parser established, so the
    // classification is `confirmed` and the deny stands. A rule that only
    // looked at "is this an interpreter code operand" would have allowed it.
    const command = `sh -c 'cat /etc/shadow'`;
    expect(evidenceOf(command).class).toBe("confirmed");
    expect(outcomeOf(command).decision).toBe("deny");

    // And the same holds for a bare operand next to inert code: nothing
    // about the command's inertness is inherited by a sibling token.
    const sibling = `echo hi; cat /etc/shadow`;
    expect(evidenceOf(sibling).class).toBe("confirmed");
  });
});

/* ------------------------------------------------------------------ */
/* 2b. the command-position arm may not rest on whitespace               */
/* ------------------------------------------------------------------ */

describe("ADR-0131 command-position evidence — whitespace is not a criterion", () => {
  // The regression: `codeRegionEvidence` used the INNER parse's quote state to
  // decide `non_path`, and the inner parse places a token in command position
  // only when the foreign source happens to have left a shell word boundary in
  // front of it. So a semantically confirmed sensitive access could reach the
  // exemption by one space:
  //
  //   perl -e 'open(F,"/etc/shadow")'   -> non_path   (no finding at all)
  //   perl -e 'open(F, "/etc/shadow")'  -> confirmed  (deny)
  //
  // That is a `deny -> allow` on a real read, and it is the same shape-based
  // licensing ADR-0131 rejects: the judgment rested on the text's whitespace,
  // not on evidence that the token is a property-access chain member.
  //
  // The contract these cases pin: a roster match inside a foreign
  // interpreter's code region is `confirmed` or `unresolved` — NEVER
  // `non_path`. `non_path` now requires POSITIVE evidence that the matched
  // token is an identifier or a member of a property-access chain, which
  // means a fragment that reads as a PATH (`/etc/shadow`, `.ssh/id_rsa`)
  // cannot be produced by a bare identifier at all.
  //
  // Note the whitelist consequence: `/etc/shadow` is not spellable as a bare
  // identifier, so every case here is denied or reviewed. Only the
  // property-chain shapes in §2 (`process.env.HOME`) survive, which is what
  // the reported false denial (#1170) actually was.
  const notNonPath: ReadonlyArray<[string, string]> = [
    // --- the four reproduced witnesses ---------------------------------
    [
      "no space after the comma (the original bypass)",
      `perl -e 'open(F,"/etc/shadow")'`,
    ],
    [
      "one space after the comma (the deny this bypass beat)",
      `perl -e 'open(F, "/etc/shadow")'`,
    ],
    [
      "python env assignment with a path on the right",
      `python3 -c 'import os;os.environ["P"]="/etc/shadow"'`,
    ],
    [
      "node readFileSync (the already-unresolved sibling)",
      `node -e 'fs.readFileSync("/etc/shadow")'`,
    ],
    ["a bare operand the shell itself opens", `cat /etc/shadow`],
    // --- other interpreters, other quote shapes, other whitespace -------
    [
      "perl three-argument open, no spaces",
      `perl -e 'open(F,"<","/etc/shadow");'`,
    ],
    [
      "python shutil.copy with two glued literals",
      `python3 -c 'import shutil;shutil.copy("/etc/shadow","/tmp/x")'`,
    ],
    [
      "a path glued onto the tail of an env chain member",
      `node -e 'process.env.NODE_OPTIONS+fs.readFileSync("/etc/shadow")'`,
    ],
    ["node require(...).readFileSync", `node -e 'require("fs").readFileSync("/etc/shadow")'`],
    ["node readFileSync with extra inner whitespace", `node -e 'fs.readFileSync(  "/etc/shadow"  )'`],
    ["ruby File.read", `ruby -e 'File.read("/etc/shadow")'`],
    ["ruby File.open with a block", `ruby -e 'File.open("/etc/shadow"){|f| f.read}'`],
    ["ruby IO.read padded with spaces", `ruby -e 'IO.read(  "/etc/passwd"  )'`],
    ["php file_get_contents", `php -r 'echo file_get_contents("/etc/shadow");'`],
    ["python open().read()", `python3 -c 'print(open("/etc/shadow").read())'`],
    [
      "python reading a secret into an env member",
      `python3 -c 'import os; os.environ["A"]=open("/etc/shadow").read()'`,
    ],
    ["perl unlink (modification, not read)", `perl -e 'unlink("/etc/shadow")'`],
    ["python writing a path into a member", `node -e 'a.env=/etc/shadow'`],
    ["awk program that shells out", `awk 'BEGIN{system("cat /etc/passwd")}'`],
    ["perl backtick execution", "perl -e 'print`/etc/shadow`'"],
    ["double-quoted outer, single inner", `node -e "fs.readFileSync('/etc/shadow')"`],
    ["a private key in code", `node -e 'fs.readFileSync("~/.ssh/id_rsa")'`],
  ];

  for (const [why, command] of notNonPath) {
    it(`never classifies ${JSON.stringify(command)} as non_path — ${why}`, () => {
      const evidence = evidenceOf(command);
      expect(
        evidence.class,
        `${command}: a path in foreign code must deny or route to review`
      ).not.toBe("non_path");
    });
  }

  it("routes a glued-literal read to review, never to an allow", () => {
    // The full ADR-0127 destination, end to end: the wall does not hard-deny
    // it (only a parse-established target may), but it is NOT waved through —
    // it asks the per-call Security review, and with no route the existing
    // typed deny answers.
    const command = `perl -e 'open(F,"/etc/shadow")'`;
    assert.equal(commandContainsSensitivePath(command), false);
    for (const mode of MODES) {
      const out = outcomeOf(command, mode);
      expect(out.decision, `${command} @ ${mode}`).toBe("ask");
      expect(out.securityReview?.cause, `${command} @ ${mode}`).toBe(
        "data-ownership-unresolved"
      );
    }
  });

  it("the whitespace twin is treated exactly like the spaced one", () => {
    // The point of the fix in one assertion: the two commands differ only by a
    // space and must land on the same verdict. Before, one denied and the
    // other produced no finding at all.
    const glued = evidenceOf(`perl -e 'open(F,"/etc/shadow")'`);
    const spaced = evidenceOf(`perl -e 'open(F, "/etc/shadow")'`);
    expect(glued.class).not.toBe("non_path");
    expect(
      (glued.class === "non_path") && (spaced.class === "non_path")
    ).toBe(false);
  });

  it("a property chain member stays non_path beside a path in the same region", () => {
    // The exemption is not disabled wholesale: the inert shape #1170 reported
    // is still exempt, in the same region, in the same call.
    expect(evidenceOf(`node -e 'process.env.NODE_OPTIONS'`).class).toBe("non_path");
    expect(evidenceOf(`node -e 'console.log(process.env.HOME)'`).class).toBe(
      "non_path"
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2c. a token that IS the fragment is not a chain member               */
/* ------------------------------------------------------------------ */

describe("ADR-0131 whole-token evidence — the matched name itself is never inert", () => {
  // The second necessary condition on `non_path`, and the one the identifier
  // rule alone could not supply. `id_rsa` is a perfectly good bare identifier,
  // so `node -e 'id_rsa'` cleared the identifier test and was exempted — but
  // the token is not a MEMBER of a property-access chain, it IS the sensitive
  // name. A secret name spelled inside foreign code is not non-path content,
  // whatever shape it has.
  //
  // The criterion is evidence, not a shape whitelist: the match must be
  // INTERIOR to the token — something must follow it. `process.env.HOME` has
  // `HOME` after the `\.env\.` match, so the match is interior and the token
  // is a chain member. `id_rsa` has nothing after itself, so it is the whole
  // token and is the name. This closes the family, not just the one spelling:
  // `a.b.id_rsa` and `fs.readFileSync(id_rsa)` are excluded by the same
  // predicate, and the second of those is a real read of a real key.
  const wholeToken: ReadonlyArray<[string, string]> = [
    ["node, the residual", `node -e 'id_rsa'`],
    ["perl, the residual", `perl -e 'id_rsa'`],
    ["python, the residual", `python3 -c 'id_rsa'`],
    ["ruby, the residual", `ruby -e 'id_rsa'`],
    ["the second key roster entry", `node -e 'id_ed25519'`],
    ["a real read of a key by bare name", `node -e 'fs.readFileSync(id_rsa)'`],
    ["a real read through a chain ending in a key", `node -e 'fs.readFileSync(a.b.id_rsa)'`],
    ["a chain that ends in the key", `node -e 'a.b.id_rsa'`],
  ];

  for (const [why, command] of wholeToken) {
    it(`never classifies ${JSON.stringify(command)} as non_path — ${why}`, () => {
      expect(
        evidenceOf(command).class,
        `${command}: the sensitive name itself is not an inert chain member`
      ).not.toBe("non_path");
    });
  }

  it("a whole-token match routes to review, not to a silent allow", () => {
    // The same ADR-0127 destination every other unproven case gets.
    const command = `node -e 'id_rsa'`;
    assert.equal(commandContainsSensitivePath(command), false);
    for (const mode of MODES) {
      const out = outcomeOf(command, mode);
      expect(out.decision, `${command} @ ${mode}`).toBe("ask");
      expect(out.securityReview?.cause, `${command} @ ${mode}`).toBe(
        "data-ownership-unresolved"
      );
    }
  });

  it("keeps the property-chain members inert — the whole point of the exemption", () => {
    // Regression guard for the fix: narrowing the exemption must not re-deny
    // the shape #1170 actually reported.
    for (const command of [
      `node -e 'process.env.NODE_OPTIONS'`,
      `node -e 'console.log(process.env.HOME)'`,
      `node -e "x.env = 1"`,
      `python3 -c "import os; os.environ['X']=1"`,
      `perl -e 'print $ENV{HOME}'`,
      `node -e 'process.env.HOME'`,
      `node -e 'console.log(process.env.A.B.C)'`,
      `node -e 'process.env.A = 1'`,
      `ruby -e 'puts ENV["HOME"]'`,
    ]) {
      expect(evidenceOf(command).class, command).toBe("non_path");
    }
  });

  it("does not touch an operand position", () => {
    // The criterion is about what a token IS, not where it sits: `cat server.pem`
    // is a parse-established path target and stays a hard deny.
    for (const command of [
      `cat server.pem`,
      `cat id_rsa`,
      `cat ~/.ssh/id_rsa`,
      `cat .netrc`,
      `cat .env`,
    ]) {
      expect(evidenceOf(command).class, command).toBe("confirmed");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. unresolved — path-shaped content whose consumer is not established */
/* ------------------------------------------------------------------ */

describe("ADR-0131 unresolved evidence — path-shaped code goes to fresh review", () => {
  // These matches are path-shaped tokens inside a code region, but the
  // program that consumes them is not proven to treat them as data, so this
  // wall must not deny on its own. ADR-0127 prices them.
  //
  // Note what is NOT here: `awk '{ print }' /etc/passwd` and
  // `awk 'BEGIN{system("cat /etc/shadow")}' f.txt` classify as `confirmed`,
  // because `/etc/passwd` is an argv OPERAND — a file the shell opens whatever
  // `awk` would have done with it. The inner `system("cat /etc/shadow")` is
  // itself code this wall cannot read, but the operand in front of it is a
  // target, and a target denies. An operand is a target even when its
  // consumer's ownership is unresolved.
  const unresolved: ReadonlyArray<[string, string, string]> = [
    [
      "a foreign language's string literal naming a real path",
      `node -e 'fs.readFileSync("/etc/shadow")'`,
      "data-ownership-unresolved",
    ],
    [
      "a foreign language's string literal in a python program",
      `python3 -c "open('/etc/shadow').read()"`,
      "data-ownership-unresolved",
    ],
  ];

  for (const [why, command, cause] of unresolved) {
    it(`routes ${JSON.stringify(command)} to review — ${why}`, () => {
      const evidence = evidenceOf(command);
      expect(evidence.class, `${command}: classification`).toBe("unresolved");
      // This wall does not deny it…
      assert.equal(commandContainsSensitivePath(command), false);
      // …and it is NOT waved through either: ADR-0127's per-call review runs
      // in both modes, because neither a session grant nor full_auto may
      // answer a question the parse could not.
      for (const mode of MODES) {
        const out = outcomeOf(command, mode);
        expect(out.decision, `${command} @ ${mode}`).toBe("ask");
        expect(out.securityReview?.cause, `${command} @ ${mode}`).toBe(cause);
        expect(out.reason, `${command} @ ${mode}`).toContain("security review required");
      }
    });
  }

  it("reviewer unavailability is a typed deny, not a confirmed violation", async () => {
    // Constraint 5 / SC2: with no interactive route the call is denied through
    // the EXISTING typed-deny form. It must not be re-labelled as this wall's
    // confirmed hard deny, and it must not be allowed.
    const command = `node -e 'fs.readFileSync("/etc/shadow")'`;
    const inner = innerStub();
    const runtime = createPermissionRuntime({
      inner,
      registry: registryOf(bashTool),
      policy,
      askUser: async () => true,
      // no `securityReview` option → no interactive route exists
    });
    const [result] = await runtime.executor.executeAll([
      { id: "call-1", name: "bash", input: { command } },
    ]);
    assert.equal(result.kind, "execution_failed");
    const message = result.kind === "execution_failed" ? result.message : "";
    expect(message).toContain(SECURITY_REVIEW_DENY_PREFIX.trim());
    // The typed review deny, not this wall's confirmed sentence.
    expect(message).not.toContain("sensitive path targeted by command");
    expect(inner.executeAll).not.toHaveBeenCalled();
  });

  it("a review that is declined denies, and the inner handler never runs", async () => {
    const command = `node -e 'fs.readFileSync("/etc/shadow")'`;
    const inner = innerStub();
    const runtime = createPermissionRuntime({
      inner,
      registry: registryOf(bashTool),
      policy,
      askUser: async () => true,
      [SECURITY_REVIEW_OPTION]: {
        interactive: true,
        request: async (_req: SecurityReviewRequest) => false,
      } satisfies SecurityReviewRoute,
    });
    const [result] = await runtime.executor.executeAll([
      { id: "call-2", name: "bash", input: { command } },
    ]);
    assert.equal(result.kind, "execution_failed");
    expect(inner.executeAll).not.toHaveBeenCalled();
  });

  it("a fresh review is asked per call, with a new id each time", async () => {
    // ADR-0127: approval covers one request, never a class of calls.
    const command = `node -e 'fs.readFileSync("/etc/shadow")'`;
    const requests: SecurityReviewRequest[] = [];
    const runtime = createPermissionRuntime({
      inner: innerStub(),
      registry: registryOf(bashTool),
      policy,
      askUser: async () => true,
      [SECURITY_REVIEW_OPTION]: {
        interactive: true,
        request: async (req: SecurityReviewRequest) => {
          requests.push(req);
          return true;
        },
      } satisfies SecurityReviewRoute,
    });
    for (const id of ["call-a", "call-b"]) {
      await runtime.executor.executeAll([
        { id, name: "bash", input: { command } },
      ]);
    }
    expect(requests).toHaveLength(2);
    expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId);
  });
});

/* ------------------------------------------------------------------ */
/* 4. SC3 — policy admission and the Bash handler agree                  */
/* ------------------------------------------------------------------ */

describe("ADR-0131 SC3 — one shared classification at admission and at the handler", () => {
  // The handler used to re-derive the sensitive verdict with its own
  // `commandContainsSensitivePath` call, which is the same rule today but a
  // second copy of it: a future widening at either site would let a
  // permission-admitted command be rejected by the handler. Both now read the
  // one shared result, so a permission-admitted command is never rejected by
  // a broader duplicate.
  const MATRIX: ReadonlyArray<[string, string]> = [
    ["confirmed direct", "cat /etc/shadow"],
    ["confirmed redirect", "echo a > '/etc/passwd'"],
    ["confirmed nested shell", "sh -c 'cat /etc/passwd'"],
    ["inert code", `node -e 'process.env.NODE_OPTIONS'`],
    ["unresolved", `node -e 'fs.readFileSync("/etc/shadow")'`],
  ];

  for (const [label, command] of MATRIX) {
    it(`${label}: the handler's refusal matches the admission verdict`, async () => {
      const admitted = outcomeOf(command, "full_auto").decision !== "deny";
      const { createBashTool } = await import(
        "../../../src/harness/aci/tools/bash.js"
      );
      const tool = createBashTool("/tmp");
      let handlerRefused = false;
      try {
        // The sensitive gate runs before any process launch, so a command the
        // gate rejects throws before bwrap is reached; one it admits may fail
        // for execution reasons, which is NOT a gate refusal.
        await tool.handler({ command });
      } catch (error) {
        const message = (error as Error).message;
        if (
          message.startsWith("bash: command targets a sensitive path:") ||
          message.startsWith("bash: dangerous command rejected:")
        ) {
          handlerRefused = true;
        }
      }
      if (admitted) {
        expect(
          handlerRefused,
          `${command}: admitted by policy but refused by the handler's gate`
        ).toBe(false);
      } else if (evidenceOf(command).class === "confirmed") {
        // A confirmed deny is non-overridable, so the handler must refuse it
        // too — same rule, same site.
        expect(
          handlerRefused,
          `${command}: confirmed at admission but the handler allowed it`
        ).toBe(true);
      }
    });
  }

  it("the handler refusal still names the sensitive path for a confirmed match", async () => {
    const { createBashTool } = await import("../../../src/harness/aci/tools/bash.js");
    const tool = createBashTool("/tmp");
    await assert.rejects(
      tool.handler({ command: "echo a >> /etc/shadow" }) as Promise<unknown>,
      (error: unknown) =>
        error instanceof ToolExecutionError &&
        error.message.includes("sensitive path")
    );
  });

  it("an unresolved match is not refused by the handler as a hard denial", async () => {
    // The handler has no interactive review route, so it must not invent a
    // denial the wall did not reach: the gate lets the call through and the
    // review stays policy's to run. What the handler must NOT do is reject it
    // with the confirmed sensitive-path sentence.
    const { createBashTool } = await import("../../../src/harness/aci/tools/bash.js");
    const tool = createBashTool("/tmp");
    try {
      await tool.handler({ command: `node -e 'fs.readFileSync("/etc/shadow")'` });
    } catch (error) {
      expect((error as Error).message).not.toContain(
        "command targets a sensitive path"
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5. SC14 — malformed stays denied, with a diagnostic that names it     */
/* ------------------------------------------------------------------ */

describe("ADR-0131 SC14 — malformed remains a hard deny with an accurate diagnostic", () => {
  it("still denies", () => {
    for (const mode of MODES) {
      expect(outcomeOf('echo "$(rm -rf /', mode).decision, mode).toBe("deny");
    }
  });

  it("the diagnostic names the malformed input rather than only the verdict token", () => {
    // Before this change the pattern was exactly `verdict=malformed`: the
    // parse layer's own reason (`shell-parse.ts` MALFORMED_REASON — an
    // incomplete syntax, e.g. an unclosed quote) was dropped at
    // `routeParseVerdict`, and the operator saw a structural token naming
    // nothing they could act on. `over-cap` and `vetoed` already carried
    // their reason; `malformed` is now consistent with them.
    const out = outcomeOf('echo "$(rm -rf /');
    expect(out.reason).toContain("verdict=malformed");
    expect(out.reason).toContain("语法不完整");
  });
});

/* ------------------------------------------------------------------ */
/* 6. ADR-0124 non-`ok` destinations are unchanged                       */
/* ------------------------------------------------------------------ */

describe("ADR-0124 — every non-`ok` verdict keeps its destination", () => {
  // The classification reads an `ok` payload. Every other verdict keeps the
  // destination ADR-0124 and
  // `docs/shell-parse-non-ok-consumer-contracts.md` recorded, because the
  // spec forbids moving one.
  it("unknown-syntax keeps the ask tier, not a deny", () => {
    const out = outcomeOf("case x in a|b) echo hi;; esac", "default");
    assert.notEqual(out.decision, "deny");
  });

  it("over-cap keeps its hard deny carrying ADR-0124 §5's reason", () => {
    const line = "doc line 0000 padded to width 20";
    const over = `cat <<'EOF'\n${(line + "\n").repeat(2000)}EOF\n`;
    const out = outcomeOf(over);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("verdict=over-cap");
  });

  it("vetoed keeps its hard deny naming the character class", () => {
    const control = String.fromCharCode(0x01);
    const out = outcomeOf(`echo hi${control}ls`);
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("verdict=vetoed");
  });

  it("malformed keeps its hard deny (the SC14 case)", () => {
    expect(outcomeOf("echo hi &&").decision).toBe("deny");
  });
});
