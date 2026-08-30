import { statSync } from "node:fs";
import { resolve } from "node:path";

export class LspMcpRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspMcpRootError";
  }
}

export function parseLspMcpArgs(argv: readonly string[]): {
  readonly root?: string;
} {
  const eq = argv.find((a) => a.startsWith("--root="));
  if (eq !== undefined) {
    const value = eq.slice("--root=".length);
    if (value.trim().length === 0) {
      throw new LspMcpRootError("--root must not be empty");
    }
    return { root: value };
  }
  const idx = argv.indexOf("--root");
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (value === undefined || value.trim().length === 0) {
      throw new LspMcpRootError("--root must not be empty");
    }
    return { root: value };
  }
  return {};
}

export function resolveLspRoot(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd()
): string {
  const parsed = parseLspMcpArgs(argv);
  if (parsed.root !== undefined) return parsed.root;
  const fromEnv = env.IKNOW_LSP_ROOT;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv;
  return cwd;
}

export function validateLspRoot(root: string): string {
  const abs = resolve(root);
  let st;
  try {
    st = statSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new LspMcpRootError(`LSP root directory does not exist: ${abs}`);
    }
    throw err;
  }
  if (!st.isDirectory()) {
    throw new LspMcpRootError(`LSP root is not a directory: ${abs}`);
  }
  return abs;
}
