/**
 * LSP probe fixture table — consumed by lsp-probe.ts (spec 251-lsp-tool).
 *
 * One entry per language; the probe walks the table against real language
 * servers. An entry is either:
 *  - a **real repo file** (typescript / json): `targetFile` is an absolute path,
 *    `line`/`char` point at a real symbol inside it; or
 *  - a **runtime-generated fixture project** (python / yaml / dockerfile):
 *    `fixtureFiles` are written into `.iknow/probe-lsp/<lang>/` (gitignored)
 *    before probing, so no fixture is ever mistaken for a deployment file.
 *
 * Every fixture is now a **project**, not a lone file: python gets a real
 * `pyproject.toml`, a real `.venv` (`venv: true`) and two source files with a
 * genuine cross-file import, so definition / hover / cross-file references and
 * diagnostics can be asserted against actual content instead of "some
 * non-empty string".
 *
 * Assertions are decisive, not advisory: `expectDefinition`, `expectHover`,
 * `expectReferences` and `expectDiagnostics` say what the answer must contain,
 * and a missing expectation is a counted FAIL. `requiredOps` lists the
 * operations that may never be skipped — a MethodNotFound on one of them fails
 * the run instead of shrinking `total`.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (= worktree root); real-repo target paths resolve from here. */
const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** One file of a generated fixture project, relative to the fixture root. */
export interface ProbeFixtureFile {
  /** Path relative to the fixture root; parent directories are created. */
  readonly path: string;
  readonly content: string;
}

export interface ProbeTarget {
  /** Server id in production `SERVERS`; the probe selects the server by it. */
  readonly serverId: string;
  /**
   * Absolute path to a real repo file, or a fixture-relative path (when
   * `fixtureFiles` is set).
   */
  readonly targetFile: string;
  /** 1-based line (converted to 0-based at the handler layer). */
  readonly line: number;
  /** 0-based character. */
  readonly char: number;
  /** Fixture project files, written under `.iknow/probe-lsp/<lang>/`. */
  readonly fixtureFiles?: readonly ProbeFixtureFile[];
  /**
   * Root markers the fixture project must contain, so the server's own root
   * resolution lands on the fixture directory (pyright walks up for
   * pyproject.toml / setup.py / …). The probe verifies each one was written.
   */
  readonly rootMarkers?: readonly string[];
  /**
   * Create a real virtualenv at `<fixture root>/.venv` before probing, so the
   * server resolves a project interpreter (`pythonPath`) instead of a system
   * one. Requires `python3`; when it is missing the probe FAILS loudly rather
   * than silently probing without the project environment.
   */
  readonly venv?: boolean;
  /** Operations that may never be skipped (MethodNotFound → run fails). */
  readonly requiredOps?: readonly string[];
  /**
   * Files the probe loads into the server's program **before** the position
   * operations, through a real tool call.
   *
   * Measured: a language server only searches files it has loaded, so anchoring
   * on a call site whose target file was never opened yields an unresolved
   * import (`hover` read `import languageIdFor`) and a definition pointing back
   * at the import statement. Loading the defining file first makes the same
   * answer real (`(alias) languageIdFor(file: string): string`).
   */
  readonly warmupFiles?: readonly string[];
  /** `lsp_definition` at (line, char) must resolve to this file and symbol. */
  readonly expectDefinition?: {
    /** Basename of the expected definition file (a cross-file hit). */
    readonly file: string;
    readonly symbol: string;
  };
  /** `lsp_hover` at (line, char) must contain these substrings. */
  readonly expectHover?: { readonly contains: readonly string[] };
  /**
   * `lsp_references` anchored at this position must report a hit in
   * `expectFile` — a different file from the anchor, so the assertion is
   * genuinely cross-file.
   */
  readonly expectReferences?: {
    readonly file: string;
    readonly line: number;
    readonly char: number;
    readonly expectFile: string;
    readonly expectSymbol: string;
  };
  /**
   * `lsp_diagnostics` on `file` must contain these substrings. Deliberately a
   * different file from the operation target: a server that publishes only on
   * the first didOpen answers an empty set for a file an earlier operation
   * already opened and closed.
   */
  readonly expectDiagnostics?: {
    readonly file: string;
    readonly contains: readonly string[];
  };
}

/** The four acceptance operations, required for the TS / Python targets. */
const REQUIRED_OPS = [
  "lsp_definition",
  "lsp_hover",
  "lsp_references",
  "lsp_diagnostics",
] as const;

export const PROBE_TARGETS: Record<string, ProbeTarget> = {
  typescript: {
    serverId: "typescript",
    targetFile: "probe_app.ts",
    line: 4,
    char: 9,
    requiredOps: REQUIRED_OPS,
    rootMarkers: ["package-lock.json", "tsconfig.json"],
    warmupFiles: ["probe_lib.ts"],
    // A real TypeScript project with its own tsconfig, so tsserver loads exactly
    // this program: cross-file definition and references are then deterministic
    // instead of depending on which repository file the server happened to load
    // (measured: an anchor inside the repository program returned only the
    // anchor's own location, because the referencing file was never loaded).
    fixtureFiles: [
      {
        // Root marker: without a lockfile the server root resolves to the
        // repository, the fixture's tsconfig is never loaded, and the files
        // fall into an inferred project where `./probe_lib.js` does not resolve
        // (measured: hover read `import languageIdFor`, i.e. unresolved).
        path: "package-lock.json",
        content: '{\n  "name": "iknow-lsp-probe",\n  "lockfileVersion": 3\n}\n',
      },
      {
        path: "tsconfig.json",
        content:
          '{\n  "compilerOptions": {\n    "strict": true,\n    "module": "NodeNext",\n    "moduleResolution": "NodeNext",\n    "target": "ES2022",\n    "noEmit": true\n  },\n  "include": ["*.ts"]\n}\n',
      },
      {
        path: "probe_lib.ts",
        content:
          "export function languageIdFor(file: string): string {\n" +
          '  const ext = file.split(".").pop() ?? file;\n' +
          '  return ext.length > 0 ? ext : "typescript";\n' +
          "}\n",
      },
      {
        path: "probe_app.ts",
        content:
          'import { languageIdFor } from "./probe_lib.js";\n' +
          "\n" +
          "export function probeAnchor(file: string): string {\n" +
          "  return languageIdFor(file);\n" +
          "}\n",
      },
      {
        // Intentional type error, asserted by content, in its own file so no
        // earlier operation has opened it. The fixture sits outside the
        // repository tsconfig's `include` (`src/**`), so `npm run typecheck` is
        // unaffected.
        path: "probe_diagnostics.ts",
        content:
          "export function probeValue(): number {\n" +
          '  const bad: number = "not a number";\n' +
          "  return bad;\n" +
          "}\n",
      },
    ],
    expectDefinition: { file: "probe_lib.ts", symbol: "languageIdFor" },
    expectHover: { contains: ["languageIdFor", "file: string"] },
    expectReferences: {
      file: "probe_app.ts",
      line: 4,
      char: 9,
      expectFile: "probe_lib.ts",
      expectSymbol: "languageIdFor",
    },
    expectDiagnostics: {
      file: "probe_diagnostics.ts",
      contains: ["error", "not assignable to type", "'number'"],
    },
  },
  python: {
    serverId: "pyright",
    targetFile: "probe.py",
    line: 5,
    char: 11,
    venv: true,
    rootMarkers: ["pyproject.toml"],
    requiredOps: REQUIRED_OPS,
    fixtureFiles: [
      {
        path: "pyproject.toml",
        content:
          '[project]\nname = "iknow-lsp-probe"\nversion = "0.0.0"\nrequires-python = ">=3.10"\n',
      },
      { path: "probe_pkg/__init__.py", content: "" },
      {
        path: "probe_pkg/offset.py",
        content:
          "def compute_offset(base: int, step: int = 1) -> int:\n    return base + step\n",
      },
      {
        // Cross-file import + usage: definition must land in offset.py and
        // references must include a hit outside this file.
        path: "probe.py",
        content:
          "from probe_pkg.offset import compute_offset\n" +
          "\n" +
          "\n" +
          "def main() -> int:\n" +
          "    return compute_offset(1)\n",
      },
      {
        // Intentional type error, asserted by content on a file no other
        // operation opens.
        path: "probe_broken.py",
        content:
          "def broken() -> None:\n" +
          '    value: int = "not an int"\n' +
          "    print(value)\n",
      },
    ],
    expectDefinition: { file: "offset.py", symbol: "compute_offset" },
    expectHover: { contains: ["compute_offset", "-> int"] },
    expectReferences: {
      file: "probe.py",
      line: 5,
      char: 11,
      expectFile: "offset.py",
      expectSymbol: "compute_offset",
    },
    expectDiagnostics: {
      file: "probe_broken.py",
      contains: ["reportAssignmentType", "not assignable to declared type"],
    },
  },
  yaml: {
    serverId: "yaml-language-server",
    targetFile: "probe.yml",
    line: 5,
    char: 9,
    // definition/hover came back empty for real .github/workflows/*.yml files
    // (no resolvable anchor), so yaml uses a runtime fixture like python /
    // dockerfile: the anchor reference `*defaults` (line 5, char 9) verifiably
    // resolves to the anchor declaration (`&defaults`) instead.
    fixtureFiles: [
      {
        path: "probe.yml",
        content:
          "defaults: &defaults\n" +
          "  runs-on: ubuntu-latest\n" +
          "jobs:\n" +
          "  build:\n" +
          "    <<: *defaults\n",
      },
    ],
  },
  json: {
    serverId: "json-language-server",
    targetFile: resolve(REPO_ROOT, "tsconfig.json"),
    line: 2,
    char: 1,
  },
  dockerfile: {
    serverId: "dockerfile-language-server-nodejs",
    targetFile: "Dockerfile",
    line: 1,
    char: 5,
    // This server returns null for FROM image names and ARG references, but
    // definition on the variable NAME of `ARG BASE_VERSION=20` (line 1, chars
    // 4-16) is non-empty (self range) and hover returns the value
    // (`{"contents":"20"}`). The fixture therefore combines an ARG reference
    // with a variable-name target so definition/hover are truly non-empty;
    // references / implementation / workspaceSymbol / callHierarchy have no
    // provider on this server (see the probe's capability-trimming log).
    fixtureFiles: [
      {
        path: "Dockerfile",
        content:
          "ARG BASE_VERSION=20\n" +
          "FROM node:${BASE_VERSION}-alpine\n" +
          'RUN echo "hello" && echo "world"\n',
      },
    ],
  },
};
