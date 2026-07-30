import type { CallerRole, SessionContext } from "../shared/schema.js";

/** Default employee session (no governance timeout simulation). */
export function createSession(
  role: CallerRole = "employee",
  opts?: { simulate_governance_timeout?: boolean }
): SessionContext {
  return {
    caller_role: role,
    simulate_governance_timeout: opts?.simulate_governance_timeout ?? false,
  };
}

/** Manager session (can pass requireApprovalFor on sensitive surfaces). */
export function createManagerSession(opts?: {
  simulate_governance_timeout?: boolean;
}): SessionContext {
  return createSession("manager", opts);
}

/** Admin session (competitor_external readable when roles_allowed includes admin). */
export function createAdminSession(opts?: {
  simulate_governance_timeout?: boolean;
}): SessionContext {
  return createSession("admin", opts);
}

/** Session that forces governance timeout path (edge-006 degraded snapshot). */
export function createDegradedSession(
  role: CallerRole = "employee"
): SessionContext {
  return createSession(role, { simulate_governance_timeout: true });
}

export function isPrivilegedRole(role: CallerRole): boolean {
  return role === "admin" || role === "manager";
}

export function withRole(
  session: SessionContext,
  role: CallerRole
): SessionContext {
  return { ...session, caller_role: role };
}
