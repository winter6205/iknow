import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type { DocumentRecord } from "../knowledge-store/types.js";
import type {
  CallerRole,
  GovernanceStatus,
  KbGovernanceInput,
  KbGovernanceOutput,
  SessionContext,
} from "../shared/schema.js";
import {
  GovernanceTimeoutError,
  PermissionDeniedError,
  ValidationError,
} from "../shared/errors.js";
import { buildSnapshotId } from "../shared/hash.js";

const ADMIN_ROLE: CallerRole = "admin";
const MANAGER_ROLE: CallerRole = "manager";

function resolveFreshnessStatus(
  doc: DocumentRecord | null | undefined,
): GovernanceStatus {
  if (!doc) return "stale";
  if (doc.freshness === "fresh") return "ok";
  // revoked and stale both surface as governance "stale"
  return "stale";
}

function isPrivilegedCaller(role: CallerRole): boolean {
  return role === ADMIN_ROLE || role === MANAGER_ROLE;
}

/**
 * kb_governance (B-position independent tool).
 * snapshot_id includes document_version.
 */
export function kbGovernance(
  store: InMemoryKnowledgeStore,
  input: KbGovernanceInput,
  session: SessionContext,
): KbGovernanceOutput {
  if (!input.action) {
    throw new ValidationError("action is required");
  }

  if (session.simulate_governance_timeout) {
    throw new GovernanceTimeoutError(
      "governance service timeout",
      { action: input.action },
    );
  }

  const checkedAt = new Date().toISOString();
  let docId = input.doc_id;
  let chunkVersion: string | undefined;
  let documentVersion = "unknown";
  let status: GovernanceStatus = "ok";
  let requiresApproval = false;
  let approvalReason: string | undefined;

  if (input.chunk_id) {
    const { chunk, doc } = store.resolveChunkDocument(input.chunk_id);
    docId = doc.doc_id;
    chunkVersion = chunk.chunk_version;
    documentVersion = doc.document_version;
  } else if (docId) {
    const doc = store.getDocument(docId);
    documentVersion = doc.document_version;
  }

  if (!docId) {
    // global / non-doc action: still emit snapshot for G2
    docId = "_session";
    documentVersion = "0";
  }

  const doc = store.tryGetDocument(docId);

  if (doc?.sensitivity === "competitor_external") {
    throw new PermissionDeniedError(
      "query targets non-enterprise / competitor knowledge; denied",
      { doc_id: docId },
    );
  }

  if (doc?.requires_approval || doc?.sensitivity === "sensitive") {
    if (!isPrivilegedCaller(session.caller_role)) {
      requiresApproval = true;
      approvalReason =
        "requireApprovalFor: sensitive or customer-data surface (§7 assumption)";
    }
  }

  switch (input.action) {
    case "check_freshness": {
      status = resolveFreshnessStatus(doc);
      break;
    }
    case "detect_conflict": {
      // Heuristic: two fresh docs sharing overlapping titles/types mark conflict
      // when query path passes doc_id — compare siblings by type
      if (doc) {
        const siblings = store
          .listDocuments()
          .filter(
            (d) =>
              d.doc_id !== doc.doc_id &&
              d.doc_type === doc.doc_type &&
              d.freshness === "fresh",
          );
        // explicit conflict marker in title/doc_id
        const conflictMarked =
          doc.doc_id.includes("conflict") ||
          siblings.some((s) => s.title.includes("冲突") || s.doc_id.includes("alt"));
        status = conflictMarked ? "conflict" : "ok";
      } else {
        status = "ok";
      }
      break;
    }
    case "snapshot_status": {
      status = resolveFreshnessStatus(doc);
      // also surface conflict if dual refund policies etc.
      if (doc) {
        const refundPeers = store
          .listDocuments()
          .filter(
            (d) =>
              d.doc_type === "policy" &&
              d.freshness === "fresh" &&
              (d.title.includes("退款") || d.doc_id.includes("refund")),
          );
        if (refundPeers.length >= 2) {
          status = "conflict";
        }
      }
      break;
    }
    default: {
      throw new ValidationError(`unknown governance action: ${String(input.action)}`);
    }
  }

  const snapshotId = buildSnapshotId({
    doc_id: docId,
    document_version: documentVersion,
    check_type: input.action,
    result: status,
    ts: checkedAt,
  });

  return {
    status,
    snapshot_id: snapshotId,
    checked_at: checkedAt,
    chunk_version: chunkVersion,
    ...(requiresApproval
      ? { requires_approval: true, approval_reason: approvalReason }
      : {}),
  };
}
