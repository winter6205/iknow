import { ToolExecutionError } from "../errors.js";
import { VIOLATION_PREFIXES } from "../permission/prefixes.js";

export const STATIC_NETWORK_WHITELIST: ReadonlySet<string> = Object.freeze(
  new Set(["github.com", "registry.npmjs.org", "pypi.org"])
);

export interface NetworkPolicy {
  assertDomain(host: string): void;
  whitelist(): ReadonlySet<string>;
}

export interface NetworkViolationOptions {
  readonly host: string;
  readonly message?: string;
}

export class NetworkViolationError extends ToolExecutionError {
  readonly host: string;

  constructor(opts: NetworkViolationOptions) {
    super(
      opts.message ??
        `${VIOLATION_PREFIXES.networkDenied} domain not in whitelist: ${opts.host}`
    );
    this.host = opts.host;
  }
}

export function createNetworkPolicy(): NetworkPolicy {
  const assertDomain = (host: string): void => {
    const normalized = host.trim().toLowerCase();
    if (!STATIC_NETWORK_WHITELIST.has(normalized)) {
      throw new NetworkViolationError({ host });
    }
  };
  const whitelist = (): ReadonlySet<string> => STATIC_NETWORK_WHITELIST;
  return Object.freeze({ assertDomain, whitelist });
}
