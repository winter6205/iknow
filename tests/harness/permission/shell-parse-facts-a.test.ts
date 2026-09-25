/**
 * The `ok` payload's per-site facts, part A: `words[]`, `commands[]`,
 * `substitutions[]` and `expansions[]`.
 *
 * Two rules shape every case here. First, each field is pinned on an input that
 * actually populates it — a quote state, a command node, a substitution site, an
 * expanded name — so no case can be satisfied by an empty array. Second, every
 * span is read as a JS string index into the verbatim `text`: each asserted fact
 * is checked through `text.slice(span.start, span.end)`, so an implementation
 * that stores byte offsets, or that re-derives a fact by re-reading `text`,
 * fails a pin instead of slipping through it.
 *
 * Verdict arms other than `ok`, and the payload's redirect / heredoc / inert
 * views, are pinned by the sibling fact files.
 */

import { describe, it, expect } from "vitest";

import { parseForSecurity } from "../../../src/harness/permission/shell-parse.js";
import type {
  CommandFact,
  ExpansionFact,
  SecurityParseOk,
  SubstitutionFact,
  WordFact,
} from "../../../src/harness/permission/shell-parse.js";

interface SpanLike {
  readonly start: number;
  readonly end: number;
}

const QUOTE_KINDS = ["none", "single", "double", "ansi-c"] as const;
const SUBSTITUTION_KINDS = [
  "dollar-paren",
  "backtick",
  "procsub-in",
  "procsub-out",
] as const;

function okPayload(command: string): SecurityParseOk {
  const result = parseForSecurity(command);
  if (result.kind !== "ok") {
    throw new Error(
      `expected an ok verdict for ${JSON.stringify(command)}, got ${result.kind}`
    );
  }
  return result;
}

function wordFacts(ok: SecurityParseOk): readonly WordFact[] {
  const facts: readonly WordFact[] | undefined = ok.words;
  if (facts === undefined) {
    throw new Error("the ok payload publishes no words[] field");
  }
  return facts;
}

function commandFacts(ok: SecurityParseOk): readonly CommandFact[] {
  const facts: readonly CommandFact[] | undefined = ok.commands;
  if (facts === undefined) {
    throw new Error("the ok payload publishes no commands[] field");
  }
  return facts;
}

function substitutionFacts(ok: SecurityParseOk): readonly SubstitutionFact[] {
  const facts: readonly SubstitutionFact[] | undefined = ok.substitutions;
  if (facts === undefined) {
    throw new Error("the ok payload publishes no substitutions[] field");
  }
  return facts;
}

function expansionFacts(ok: SecurityParseOk): readonly ExpansionFact[] {
  const facts: readonly ExpansionFact[] | undefined = ok.expansions;
  if (facts === undefined) {
    throw new Error("the ok payload publishes no expansions[] field");
  }
  return facts;
}

function spanText(ok: SecurityParseOk, span: SpanLike): string {
  return ok.text.slice(span.start, span.end);
}

/** The command node at an index carried by another fact, null included. */
function commandByIndex(
  ok: SecurityParseOk,
  index: number | null | undefined,
  label: string
): CommandFact {
  if (index === null || index === undefined) {
    throw new Error(`${label} carries no owning command index`);
  }
  const found = commandFacts(ok).find((command) => command.index === index);
  if (found === undefined) {
    throw new Error(
      `${label} names command index ${index}, which commands[] does not hold`
    );
  }
  return found;
}

function commandNamed(ok: SecurityParseOk, word: string): CommandFact {
  const found = commandFacts(ok).find(
    (command) => commandWord(command) === word
  );
  if (found === undefined) {
    throw new Error(
      `no command node in commands[] has ${JSON.stringify(word)} as its command word`
    );
  }
  return found;
}

function commandWord(command: CommandFact): string {
  const head: WordFact | undefined = command.argv[0];
  return head === undefined ? "<no argv>" : head.text;
}

/** The site found by what its span covers, so the span is the lookup key. */
function substitutionCovering(
  ok: SecurityParseOk,
  site: string
): SubstitutionFact {
  const found = substitutionFacts(ok).find(
    (substitution) => spanText(ok, substitution.span) === site
  );
  if (found === undefined) {
    throw new Error(
      `no substitutions[] entry covers ${JSON.stringify(site)} at its span`
    );
  }
  return found;
}

function expansionNamed(ok: SecurityParseOk, name: string): ExpansionFact {
  const found = expansionFacts(ok).find((expansion) => expansion.name === name);
  if (found === undefined) {
    throw new Error(`no expansions[] entry carries the name ${name}`);
  }
  return found;
}

function expandedName(expansion: ExpansionFact, label: string): string {
  if (expansion.name === null) {
    throw new Error(`${label} reports no identifier where one is expected`);
  }
  return expansion.name;
}

function sortedNames(ok: SecurityParseOk): (string | null)[] {
  return expansionFacts(ok)
    .map((expansion) => expansion.name)
    .sort();
}

describe("words[] quote state and folded literal", () => {
  it("reports the quote state of every word when one command mixes all four kinds", () => {
    const command = "echo plain 'sin gle' \"dou ble\" $'ansi'";
    const ok = okPayload(command);
    const words = wordFacts(ok);

    expect(words.map((word) => word.text)).toEqual([
      "echo",
      "plain",
      "'sin gle'",
      '"dou ble"',
      "$'ansi'",
    ]);
    expect(words.map((word) => word.quoteKind)).toEqual([
      "none",
      "none",
      "single",
      "double",
      "ansi-c",
    ]);
    expect(words.map((word) => word.value)).toEqual([
      "echo",
      "plain",
      "sin gle",
      "dou ble",
      "ansi",
    ]);
    for (const word of words) {
      expect(spanText(ok, word.span)).toBe(word.text);
    }
  });

  it("folds a backslash escape outside quotes into the literal, keeping the word text verbatim", () => {
    const command = "r\\m -rf /tmp/x";
    const ok = okPayload(command);
    const words = wordFacts(ok);

    expect(ok.text).toBe(command);
    expect(words.map((word) => word.text)).toEqual(["r\\m", "-rf", "/tmp/x"]);
    expect(words.map((word) => word.value)).toEqual(["rm", "-rf", "/tmp/x"]);
    expect(words[0].quoteKind).toBe("none");
    expect(spanText(ok, words[0].span)).toBe("r\\m");
    expect(commandWord(commandNamed(ok, "r\\m"))).toBe("r\\m");
  });

  it("keeps the backslashes a double quote protects and the quotes in the word text", () => {
    const command = 'echo "a\\nb"';
    const ok = okPayload(command);
    const words = wordFacts(ok);

    expect(words[1].text).toBe('"a\\nb"');
    expect(words[1].quoteKind).toBe("double");
    expect(words[1].value).toBe("a\\nb");
    expect(spanText(ok, words[1].span)).toBe('"a\\nb"');
  });

  it("reports a single-quoted word's payload verbatim as its value, substitution glyphs and all", () => {
    const command = "echo 'a $(whoami) b'";
    const ok = okPayload(command);
    const words = wordFacts(ok);

    expect(words[1].text).toBe("'a $(whoami) b'");
    expect(words[1].quoteKind).toBe("single");
    expect(words[1].value).toBe("a $(whoami) b");
    expect(spanText(ok, words[1].span)).toBe("'a $(whoami) b'");
    expect(substitutionFacts(ok)).toEqual([]);
  });

  it("leaves no static value for a word that carries a command substitution", () => {
    const command = 'echo "x$(true)y"';
    const ok = okPayload(command);
    const words = wordFacts(ok);

    expect(words[0].value).toBe("echo");
    expect(words[1].text).toBe('"x$(true)y"');
    expect(words[1].quoteKind).toBe("double");
    expect(words[1].value).toBeUndefined();
    expect(spanText(ok, words[1].span)).toBe('"x$(true)y"');
  });
});

describe("commands[] source order, argv and nesting", () => {
  it("lists every command of an && chain and a pipeline in source order at depth zero", () => {
    const command = "echo a && ls | grep b";
    const ok = okPayload(command);
    const commands = commandFacts(ok);

    expect(commands.map((node) => node.index)).toEqual([0, 1, 2]);
    expect(commands.map((node) => node.argv.map((word) => word.text))).toEqual([
      ["echo", "a"],
      ["ls"],
      ["grep", "b"],
    ]);
    expect(commands.map((node) => node.depth)).toEqual([0, 0, 0]);
    expect(commands.map((node) => node.parentId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(commands.map((node) => spanText(ok, node.span))).toEqual([
      "echo a",
      "ls",
      "grep b",
    ]);
  });

  it("records the command inside a substitution as its own node one level deeper, parented to the substituting command", () => {
    const command = "echo $(true)";
    const ok = okPayload(command);
    const commands = commandFacts(ok);
    const outer = commandNamed(ok, "echo");
    const inner = commandNamed(ok, "true");

    expect(commands).toHaveLength(2);
    expect(outer.index).toBe(0);
    expect(outer.depth).toBe(0);
    expect(outer.parentId).toBeUndefined();
    expect(spanText(ok, outer.span)).toBe("echo $(true)");
    expect(inner.index).toBe(1);
    expect(inner.depth).toBe(1);
    expect(inner.parentId).toBe(outer.index);
    expect(spanText(ok, inner.span)).toBe("true");
    expect(inner.argv.map((word) => word.text)).toEqual(["true"]);
  });

  it("adds one depth per substitution level down a chain and threads the parent indexes", () => {
    const command = "echo $(echo $(echo deep))";
    const ok = okPayload(command);
    const commands = commandFacts(ok);

    expect(commands.map((node) => node.depth)).toEqual([0, 1, 2]);
    expect(commands.map((node) => node.parentId)).toEqual([undefined, 0, 1]);
    expect(commands.map((node) => spanText(ok, node.span))).toEqual([
      "echo $(echo $(echo deep))",
      "echo $(echo deep)",
      "echo deep",
    ]);
  });

  it("carries loop and branch bodies one level below a top-level command", () => {
    const nested: readonly {
      readonly command: string;
      readonly bodies: readonly {
        readonly word: string;
        readonly depth: number;
        readonly covered: string;
      }[];
    }[] = [
      {
        command: 'echo a; for f in x; do cat "$f"; done',
        bodies: [
          { word: "echo", depth: 0, covered: "echo a" },
          { word: "cat", depth: 1, covered: 'cat "$f"' },
        ],
      },
      {
        command: 'while read line; do echo "$line"; done',
        bodies: [
          { word: "read", depth: 1, covered: "read line" },
          { word: "echo", depth: 1, covered: 'echo "$line"' },
        ],
      },
      {
        command: "if test -f x; then cat y; fi",
        bodies: [
          { word: "test", depth: 1, covered: "test -f x" },
          { word: "cat", depth: 1, covered: "cat y" },
        ],
      },
    ];

    for (const testCase of nested) {
      const ok = okPayload(testCase.command);
      for (const body of testCase.bodies) {
        const node = commandNamed(ok, body.word);
        expect(node.depth).toBe(body.depth);
        expect(spanText(ok, node.span)).toBe(body.covered);
        for (const word of node.argv) {
          expect(spanText(ok, word.span)).toBe(word.text);
        }
      }
    }
  });

  it("keeps index, parent and depth agreeing with the tree for every command node a substitution reaches", () => {
    const command = "echo $(date) `id` && diff <(sort a) >(tee b)";
    const ok = okPayload(command);
    const commands = commandFacts(ok);

    expect(commands).toHaveLength(6);
    expect(commands.map((node) => node.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(commands.map(commandWord)).toEqual([
      "echo",
      "date",
      "id",
      "diff",
      "sort",
      "tee",
    ]);
    expect(commands.map((node) => node.depth)).toEqual([0, 1, 1, 0, 1, 1]);
    expect(commands.map((node) => node.parentId)).toEqual([
      undefined,
      0,
      0,
      undefined,
      3,
      3,
    ]);

    for (const node of commands) {
      const covered = spanText(ok, node.span);
      expect(covered.length).toBeGreaterThan(0);
      for (const word of node.argv) {
        expect(spanText(ok, word.span)).toBe(word.text);
      }
      if (node.parentId !== undefined) {
        const parent = commandByIndex(ok, node.parentId, commandWord(node));
        expect(parent.index).toBeLessThan(node.index);
        expect(parent.depth + 1).toBe(node.depth);
        expect(parent.span.start).toBeLessThanOrEqual(node.span.start);
        expect(node.span.end).toBeLessThanOrEqual(parent.span.end);
      }
    }
  });
});

describe("substitutions[] sites", () => {
  it("names the construct the parse actually saw for all four substitution kinds", () => {
    const command = "echo $(date) `id` && diff <(sort a) >(tee b)";
    const ok = okPayload(command);
    const substitutions = substitutionFacts(ok);

    expect(substitutions).toHaveLength(4);
    expect(
      substitutions.map((site) => [site.kind, spanText(ok, site.span)])
    ).toEqual([
      ["dollar-paren", "$(date)"],
      ["backtick", "`id`"],
      ["procsub-in", "<(sort a)"],
      ["procsub-out", ">(tee b)"],
    ]);
  });

  it("points innerCommandIndex at the command inside the site and ownerCommandIndex at the command hosting its word", () => {
    const command = "echo $(date) `id` && diff <(sort a) >(tee b)";
    const ok = okPayload(command);
    const sites: readonly {
      readonly covered: string;
      readonly inner: string;
      readonly owner: string;
    }[] = [
      { covered: "$(date)", inner: "date", owner: "echo" },
      { covered: "`id`", inner: "id", owner: "echo" },
      { covered: "<(sort a)", inner: "sort", owner: "diff" },
      { covered: ">(tee b)", inner: "tee", owner: "diff" },
    ];

    for (const site of sites) {
      const fact = substitutionCovering(ok, site.covered);
      expect(
        commandByIndex(ok, fact.innerCommandIndex, site.covered).argv[0]
      ).toBeDefined();
      expect(
        commandWord(commandByIndex(ok, fact.innerCommandIndex, site.covered))
      ).toBe(site.inner);
      expect(
        commandWord(commandByIndex(ok, fact.ownerCommandIndex, site.covered))
      ).toBe(site.owner);
      expect(
        commandByIndex(ok, fact.ownerCommandIndex, site.covered).depth
      ).toBe(0);
      expect(
        commandByIndex(ok, fact.innerCommandIndex, site.covered).depth
      ).toBe(1);
    }

    // Both process substitutions sit in one command's words, so one owner
    // index answers for both, and the inner nodes are the distinct pair.
    expect(substitutionCovering(ok, "<(sort a)").ownerCommandIndex).toBe(
      substitutionCovering(ok, ">(tee b)").ownerCommandIndex
    );
    expect(substitutionCovering(ok, "<(sort a)").innerCommandIndex).not.toBe(
      substitutionCovering(ok, ">(tee b)").innerCommandIndex
    );
  });

  it("records a substitution hidden in an arithmetic operand as a site, though arithmetic itself is no kind", () => {
    const command = "echo $((A+$(rm x)))";
    const ok = okPayload(command);

    expect(
      substitutionFacts(ok).map((site) => [site.kind, spanText(ok, site.span)])
    ).toEqual([["dollar-paren", "$(rm x)"]]);
    const site = substitutionCovering(ok, "$(rm x)");
    expect(
      commandWord(commandByIndex(ok, site.innerCommandIndex, "$(rm x)"))
    ).toBe("rm");
    expect(
      commandWord(commandByIndex(ok, site.ownerCommandIndex, "$(rm x)"))
    ).toBe("echo");
    expect(expansionFacts(ok).map((expansion) => expansion.name)).toEqual([
      "A",
    ]);
  });

  it("reports a substitution written inside an array subscript as its own site", () => {
    const command = "echo ${arr[$(rm x)]}";
    const ok = okPayload(command);

    expect(
      substitutionFacts(ok).map((site) => [site.kind, spanText(ok, site.span)])
    ).toEqual([["dollar-paren", "$(rm x)"]]);
    const site = substitutionCovering(ok, "$(rm x)");
    const subscriptOwner = commandByIndex(
      ok,
      site.ownerCommandIndex,
      "$(rm x)"
    );
    expect(commandWord(subscriptOwner)).toBe("echo");
    expect(spanText(ok, expansionNamed(ok, "arr").span)).toBe(
      "${arr[$(rm x)]}"
    );
    expect(site.span.start).toBeGreaterThanOrEqual(
      expansionNamed(ok, "arr").span.start
    );
    expect(site.span.end).toBeLessThanOrEqual(
      expansionNamed(ok, "arr").span.end
    );
  });
});

describe("expansions[] expanded names", () => {
  it("reads the name of a bare $VAR site and of a braced ${VAR} site", () => {
    const plain = okPayload("echo $HOME");
    const braced = okPayload("echo ${API_KEY}");

    expect(expansionFacts(plain).map((e) => e.name)).toEqual(["HOME"]);
    expect(spanText(plain, expansionNamed(plain, "HOME").span)).toBe("$HOME");
    expect(
      commandWord(
        commandByIndex(
          plain,
          expansionNamed(plain, "HOME").ownerCommandIndex,
          "$HOME"
        )
      )
    ).toBe("echo");

    expect(expansionFacts(braced).map((e) => e.name)).toEqual(["API_KEY"]);
    expect(spanText(braced, expansionNamed(braced, "API_KEY").span)).toBe(
      "${API_KEY}"
    );
    expect(
      commandWord(
        commandByIndex(
          braced,
          expansionNamed(braced, "API_KEY").ownerCommandIndex,
          "${API_KEY}"
        )
      )
    ).toBe("echo");
  });

  it("reports one entry per name of a multi-name site, each carrying that site's span", () => {
    const sum = okPayload("echo $((A+B))");
    const alternate = okPayload("echo ${A:-$B}");

    expect(expansionFacts(sum).map((e) => e.name)).toEqual(["A", "B"]);
    expect(expansionFacts(sum).map((e) => spanText(sum, e.span))).toEqual([
      "$((A+B))",
      "$((A+B))",
    ]);

    expect(sortedNames(alternate)).toEqual(["A", "B"]);
    for (const expansion of expansionFacts(alternate)) {
      const name = expandedName(expansion, "${A:-$B}");
      expect(spanText(alternate, expansion.span)).toContain(name);
    }
  });

  it("names the array a subscripted expansion expands, never the subscript's own identifier", () => {
    const ok = okPayload("echo ${arr[i]}");

    expect(expansionFacts(ok).map((e) => e.name)).toEqual(["arr"]);
    expect(spanText(ok, expansionNamed(ok, "arr").span)).toBe("${arr[i]}");
  });

  it("names the variable behind a length prefix", () => {
    const ok = okPayload("echo ${#VAR}");

    expect(expansionFacts(ok).map((e) => e.name)).toEqual(["VAR"]);
    expect(spanText(ok, expansionNamed(ok, "VAR").span)).toBe("${#VAR}");
  });

  it("reports a site with no identifier at all under a null name", () => {
    const literals = okPayload("echo $((1+2))");
    const empty = okPayload("echo ${}");

    expect(expansionFacts(literals).map((e) => e.name)).toEqual([null]);
    expect(spanText(literals, expansionFacts(literals)[0].span)).toBe(
      "$((1+2))"
    );
    expect(
      commandWord(
        commandByIndex(
          literals,
          expansionFacts(literals)[0].ownerCommandIndex,
          "$((1+2))"
        )
      )
    ).toBe("echo");

    expect(expansionFacts(empty).map((e) => e.name)).toEqual([null]);
    expect(spanText(empty, expansionFacts(empty)[0].span)).toBe("${}");
  });

  it("carries the outer name in expansions[] and the inner command in substitutions[] for one nested site", () => {
    const command = "echo ${X:-$(curl y)}";
    const ok = okPayload(command);
    const outer = expansionNamed(ok, "X");
    const inner = substitutionCovering(ok, "$(curl y)");

    expect(expansionFacts(ok).map((e) => e.name)).toEqual(["X"]);
    expect(substitutionFacts(ok).map((s) => s.kind)).toEqual(["dollar-paren"]);
    expect(spanText(ok, outer.span)).toBe("${X:-$(curl y)}");
    expect(outer.span.start).toBeLessThanOrEqual(inner.span.start);
    expect(inner.span.end).toBeLessThanOrEqual(outer.span.end);
    expect(commandWord(commandByIndex(ok, outer.ownerCommandIndex, "X"))).toBe(
      "echo"
    );
    expect(
      commandWord(commandByIndex(ok, inner.ownerCommandIndex, "$(curl y)"))
    ).toBe("echo");
    expect(
      commandWord(commandByIndex(ok, inner.innerCommandIndex, "$(curl y)"))
    ).toBe("curl");
    expect(commandByIndex(ok, inner.innerCommandIndex, "$(curl y)").depth).toBe(
      1
    );
  });

  it("gives every expansion shape in one command its own entry and no duplicate", () => {
    const command = "echo $((A+B)) ${X:-$Y} ${#Z} ${arr[q]}";
    const ok = okPayload(command);

    expect(sortedNames(ok)).toEqual(["A", "B", "X", "Y", "Z", "arr"]);
    for (const expansion of expansionFacts(ok)) {
      const name = expandedName(expansion, command);
      const covered = spanText(ok, expansion.span);
      expect(covered).toContain(name);
      expect(
        commandWord(commandByIndex(ok, expansion.ownerCommandIndex, name))
      ).toBe("echo");
    }
  });
});

describe("reading published facts", () => {
  const HOSTILE_BUT_CLEAN: readonly string[] = [
    "echo 'unbalanced-looking (( \" quotes'",
    "echo $(echo $(echo deep))",
    "cat <<'EOF'\nrm -rf /\nEOF",
    'cat <<< "a$b"',
    "echo a>b",
    "echo ${arr[$(rm x)]}",
  ];

  function walkEveryFact(ok: SecurityParseOk): void {
    for (const word of wordFacts(ok)) {
      expect(QUOTE_KINDS).toContain(word.quoteKind);
      expect(typeof word.value === "string" || word.value === undefined).toBe(
        true
      );
      expect(spanText(ok, word.span)).toBe(word.text);
      expect(word.span.start).toBeGreaterThanOrEqual(0);
      expect(word.span.end).toBeLessThanOrEqual(ok.text.length);
    }

    for (const node of commandFacts(ok)) {
      expect(Number.isInteger(node.index)).toBe(true);
      expect(Number.isInteger(node.depth)).toBe(true);
      expect(node.depth).toBeGreaterThanOrEqual(0);
      expect(node.argv.length).toBeGreaterThanOrEqual(1);
      expect(spanText(ok, node.span).length).toBeGreaterThan(0);
      if (node.parentId !== undefined) {
        expect(commandByIndex(ok, node.parentId, commandWord(node)).index).toBe(
          node.parentId
        );
      }
    }

    for (const site of substitutionFacts(ok)) {
      expect(SUBSTITUTION_KINDS).toContain(site.kind);
      expect(spanText(ok, site.span).length).toBeGreaterThan(0);
      expect(commandByIndex(ok, site.innerCommandIndex, site.kind).index).toBe(
        site.innerCommandIndex
      );
      if (site.ownerCommandIndex !== null) {
        expect(
          commandByIndex(ok, site.ownerCommandIndex, site.kind).index
        ).toBe(site.ownerCommandIndex);
      }
    }

    for (const expansion of expansionFacts(ok)) {
      expect(
        typeof expansion.name === "string" || expansion.name === null
      ).toBe(true);
      expect(spanText(ok, expansion.span).length).toBeGreaterThan(0);
      if (expansion.ownerCommandIndex !== null) {
        expect(
          commandByIndex(
            ok,
            expansion.ownerCommandIndex,
            String(expansion.name)
          ).index
        ).toBe(expansion.ownerCommandIndex);
      }
    }
  }

  for (const command of HOSTILE_BUT_CLEAN) {
    it(`reads every published fact of ${JSON.stringify(command)} without throwing`, () => {
      const ok = okPayload(command);
      expect(ok.text).toBe(command);
      expect(() => walkEveryFact(ok)).not.toThrow();
    });
  }
});
