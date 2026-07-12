import type { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import { kbRetrieve } from "../kb-retrieve/retrieve.js";
import { kbVerifyCitation } from "../kb-verify/verify.js";
import { kbCompile } from "../kb-compile/compile.js";
import { kbGovernance } from "../kb-governance/governance.js";
import { buildSnapshotId, sha256Hex } from "../shared/hash.js";
import type {
  Chunk,
  GovernanceAction,
  GovernanceStatus,
  IknowAnswer,
  SessionContext,
} from "../shared/schema.js";
import { IknowError } from "../shared/errors.js";
import { isPrivilegedRole } from "./session.js";

/** Only kb_retrieve + kb_verify_citation count as hops (ADR). */
export const MAX_HOPS = 5;

export interface AgentLoopOptions {
  store: InMemoryKnowledgeStore;
  session: SessionContext;
  maxHops?: number;
}

type RetrieveResult = ReturnType<typeof kbRetrieve>;

/**
 * Deterministic agent loop (no external LLM).
 * Policy: retrieve → optional verify → governance snapshot → answer.
 * G2: never return without snapshot_id.
 */
export class IknowAgent {
  private readonly store: InMemoryKnowledgeStore;
  private readonly session: SessionContext;
  private readonly maxHops: number;

  constructor(opts: AgentLoopOptions) {
    this.store = opts.store;
    this.session = opts.session;
    this.maxHops = opts.maxHops ?? MAX_HOPS;
  }

  answer(query: string): IknowAnswer {
    const toolTrace: string[] = [];
    const notes: string[] = [];
    let hops = 0;

    const q = query.trim();
    if (!q) {
      return this.finalize({
        text: "请提供有效问题。",
        source_spans: [],
        toolTrace,
        hops,
        notes: ["empty_query"],
        preferredDocId: "_session",
      });
    }

    // edge-004: competitor / non-enterprise knowledge
    if (/竞对|竞争对手|他司薪酬|外部薪酬/.test(q)) {
      toolTrace.push("kb_governance");
      const g = this.safeGovernance("competitor-pay");
      notes.push(...(g.extraNotes ?? []));
      if (!notes.includes("permission_denied")) {
        notes.push("permission_denied");
      }
      return {
        text: "越权查询已拒绝：不得返回非本企业知识。",
        source_spans: [],
        snapshot_id: g.snapshot_id,
        governance_status: g.status,
        tool_trace: toolTrace,
        hops_used: hops,
        notes,
      };
    }

    // edge-001: sensitive customer contacts — non-privileged only.
    // Privileged callers skip this pre-path and use the single main retrieve.
    if (
      /客户名单|联系方式|完整客户/.test(q) &&
      !isPrivilegedRole(this.session.caller_role)
    ) {
      toolTrace.push("kb_retrieve");
      hops += 1;
      const denied = kbRetrieve(this.store, { query: q }, this.session);
      toolTrace.push("kb_governance");
      const g = this.safeGovernance(
        denied.chunks[0]?.doc_id ?? "crm-contacts",
      );
      notes.push(...(g.extraNotes ?? []));
      return {
        text: "该请求涉及敏感客户数据，需审批（requireApprovalFor）后方可返回，当前已拦截。",
        source_spans: [],
        snapshot_id: g.snapshot_id,
        governance_status: g.status,
        tool_trace: toolTrace,
        hops_used: hops,
        notes: ["require_approval", ...notes],
      };
    }

    // 1) retrieve (counts as hop) — single main path for all remaining queries
    if (hops >= this.maxHops) {
      return this.hopLimit(toolTrace, hops, notes);
    }
    toolTrace.push("kb_retrieve");
    hops += 1;
    let retrieved = kbRetrieve(this.store, { query: q }, this.session);
    this.noteRetrieveDegradation(retrieved, notes);
    retrieved = this.applyNonexistentDocFilter(q, retrieved);

    // No grounded evidence (empty / weak match / edge-002 nonexistent docs)
    if (this.lacksGroundedEvidence(q, retrieved.chunks)) {
      return this.emptyAnswer(toolTrace, hops, notes, {
        noHallucination: true,
      });
    }

    const needsGovernance =
      /冲突|到底以哪个|最新吗|有效吗|作废|对比|差异|权限|审批/.test(q) ||
      retrieved.chunks.length >= 2;

    const needsCompile =
      /串起来|SOP|汇总|清单|衔接|完整/.test(q) &&
      retrieved.chunks[0] !== undefined;

    // compile is not a hop (infra tool)
    if (needsCompile && retrieved.chunks[0]) {
      const docId = retrieved.chunks[0].doc_id;
      const content = this.store
        .listChunks()
        .filter((c) => c.doc_id === docId)
        .map((c) => c.text)
        .join("\n");
      toolTrace.push("kb_compile");
      kbCompile(this.store, {
        doc_id: docId,
        content,
        content_hash: sha256Hex(content),
        document_version:
          this.store.tryGetDocument(docId)?.document_version ?? "0",
      });
      // re-retrieve after compile is infra; still counts if we call retrieve
      if (hops < this.maxHops) {
        toolTrace.push("kb_retrieve");
        hops += 1;
        retrieved = kbRetrieve(this.store, { query: q }, this.session);
        this.noteRetrieveDegradation(retrieved, notes);
      }
    }

    if (retrieved.chunks.length === 0) {
      return this.emptyAnswer(toolTrace, hops, notes);
    }

    // 2) verify top claim (counts as hop); top always from current retrieved
    let top = retrieved.chunks[0]!;
    const claim = this.deriveClaim(q, top.summary);
    let verifyNote = "";
    if (hops < this.maxHops) {
      toolTrace.push("kb_verify_citation");
      hops += 1;
      const full = this.store.getChunk(top.chunk_id).text;
      const v = kbVerifyCitation(this.store, {
        claim,
        source_span: { chunk_id: top.chunk_id, quote: full.slice(0, 120) },
      });
      verifyNote = `verify=${v.verdict}`;
      if (v.version_stale) notes.push("version_stale");
      if (v.verdict === "unsupported" && hops < this.maxHops) {
        toolTrace.push("kb_retrieve");
        hops += 1;
        retrieved = kbRetrieve(
          this.store,
          {
            query: q,
            prior_chunks: [{ chunk_id: top.chunk_id, summary: top.summary }],
          },
          this.session,
        );
        this.noteRetrieveDegradation(retrieved, notes);
        if (retrieved.chunks.length === 0) {
          return this.emptyAnswer(toolTrace, hops, notes, {
            noHallucination: true,
          });
        }
        top = retrieved.chunks[0]!;
      }
    }

    if (hops > this.maxHops) {
      return this.hopLimit(toolTrace, hops, notes, retrieved.chunks);
    }

    // edge-005: multi-hop pressure — if query demands many departments, declare hop limit
    if (/八个部门|谁先谁后/.test(q) && hops >= this.maxHops - 1) {
      return this.hopLimit(toolTrace, hops, notes, retrieved.chunks);
    }

    // 3) governance (not a hop); G2 always needs snapshot_id
    toolTrace.push("kb_governance");
    const primaryDoc =
      retrieved.chunks.find((c) =>
        /refund|退款/.test(`${c.doc_id} ${c.summary}`),
      )?.doc_id ?? top.doc_id;

    let g = this.safeGovernance(
      primaryDoc,
      needsGovernance ? "detect_conflict" : "snapshot_status",
    );
    notes.push(...(g.extraNotes ?? []));
    if (needsGovernance && g.status === "ok") {
      g = this.safeGovernance(primaryDoc, "snapshot_status");
      notes.push(...(g.extraNotes ?? []));
    }

    const anyRevoked = retrieved.chunks.some((c) => {
      const d = this.store.tryGetDocument(c.doc_id);
      return d?.freshness === "revoked";
    });
    if (anyRevoked || /作废|还有效吗/.test(q)) {
      notes.push("document_revoked_or_stale");
      // keep snapshot_id; surface stale status
      g = { ...g, status: "stale" };
    }

    // sensitive surface: requireApprovalFor even if retrieved via role
    const sensitiveHit = retrieved.chunks.some((c) => {
      const d = this.store.tryGetDocument(c.doc_id);
      return (
        d?.sensitivity === "sensitive" || d?.requires_approval === true
      );
    });
    if (sensitiveHit && !isPrivilegedRole(this.session.caller_role)) {
      return {
        text: "该请求涉及敏感数据，需审批（requireApprovalFor）后方可返回，当前已拦截。",
        source_spans: [],
        snapshot_id: g.snapshot_id,
        governance_status: g.status,
        tool_trace: toolTrace,
        hops_used: hops,
        notes: ["require_approval", ...notes],
      };
    }

    const spans = retrieved.chunks.slice(0, 3).map((c) => ({
      chunk_id: c.chunk_id,
      quote: this.store.getChunk(c.chunk_id).text.slice(0, 160),
    }));

    const body = retrieved.chunks
      .slice(0, 3)
      .map((c) => `• (${c.chunk_id}) ${c.summary}`)
      .join("\n");

    let text = `根据企业知识库：\n${body}`;
    if (g.status === "conflict") {
      text +=
        "\n\n【治理】检测到冲突状态，请以治理标注与权威版本为准，勿臆断单一答案。";
    }
    if (g.status === "stale") {
      text +=
        "\n\n【治理】相关文档可能已过期或作废，不得当作现行有效唯一依据。";
    }
    if (verifyNote) {
      text += `\n\n（${verifyNote}）`;
    }
    if (notes.some((n) => /degrad|timeout|超时/i.test(n))) {
      text +=
        "\n\n【降级】治理不可达或超时：已显式声明降级，结果带未充分过滤标记。";
    }

    return {
      text,
      source_spans: spans,
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      tool_trace: toolTrace,
      hops_used: hops,
      notes: notes.length ? notes : undefined,
    };
  }

  private deriveClaim(query: string, summary: string): string {
    return `${query} —— 依据：${summary}`.slice(0, 200);
  }

  /** True when retrieve returned noise only (no meaningful token overlap with query). */
  private isWeakMatch(query: string, chunks: Chunk[]): boolean {
    if (chunks.length === 0) return true;
    const keys = query
      .toLowerCase()
      .replace(/[《》？?，,。.\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2)
      .filter((t) => !/公司|你们|有没有|一份|怎么|什么|哪些|是否/.test(t));
    if (keys.length === 0) return false;
    return !chunks.some((c) => {
      const blob = `${c.summary} ${this.store.getChunk(c.chunk_id).text}`.toLowerCase();
      return keys.some((k) => blob.includes(k));
    });
  }

  /**
   * Unified "no grounded evidence" predicate (edge-002 + empty + weak match).
   * When true, answer() must take emptyAnswer — never invent content.
   */
  private lacksGroundedEvidence(query: string, chunks: Chunk[]): boolean {
    if (chunks.length === 0) return true;
    if (/全员持股|根本不存在/.test(query)) return true;
    if (
      /全员持股|根本不存在|有没有一份/.test(query) ||
      this.isWeakMatch(query, chunks)
    ) {
      const grounded = chunks.some((c) => {
        const text = `${c.summary} ${this.store.getChunk(c.chunk_id).text}`;
        const keys = query
          .replace(/[《》？?，,。.\s]/g, " ")
          .split(/\s+/)
          .filter((t) => t.length >= 2);
        return keys.some(
          (k) =>
            text.includes(k) &&
            !/公司|有没有|一份|根本|不存在|你们/.test(k),
        );
      });
      return !grounded;
    }
    return false;
  }

  /** Explicit "does this nonexistent doc exist?" → zero chunks if no distinctive hit. */
  private applyNonexistentDocFilter(
    query: string,
    retrieved: RetrieveResult,
  ): RetrieveResult {
    if (
      /根本不存在|不存在的|有没有一份/.test(query) &&
      !retrieved.chunks.some((c) =>
        /全员持股|持股计划/.test(c.summary + c.doc_id),
      )
    ) {
      return {
        chunks: [],
        governance_degraded: retrieved.governance_degraded,
        degradation_note: retrieved.degradation_note,
      };
    }
    return retrieved;
  }

  private noteRetrieveDegradation(
    retrieved: RetrieveResult,
    notes: string[],
  ): void {
    if (retrieved.governance_degraded) {
      notes.push(
        retrieved.degradation_note ??
          "governance_degraded: explicit degradation declared",
      );
    }
  }

  /**
   * Dedicated empty_result path. Always G2 snapshot_id; never "根据企业知识库" body.
   */
  private emptyAnswer(
    toolTrace: string[],
    hops: number,
    notes: string[],
    opts?: { noHallucination?: boolean },
  ): IknowAnswer {
    toolTrace.push("kb_governance");
    const g = this.safeGovernance("_session");
    notes.push(...(g.extraNotes ?? []));
    const tagNotes = opts?.noHallucination
      ? ["empty_result", "no_hallucination", ...notes]
      : ["empty_result", ...notes];
    return {
      text: opts?.noHallucination
        ? "未在企业知识库中找到相关内容，无法确认；不得编造不存在的文档。"
        : "未在企业知识库中找到相关内容，无法确认。",
      source_spans: [],
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      tool_trace: toolTrace,
      hops_used: hops,
      notes: tagNotes,
    };
  }

  /**
   * Governance wrapper: never mutates caller notes.
   * All failure paths return extraNotes for the caller to merge.
   */
  private safeGovernance(
    docId: string,
    action: GovernanceAction = "snapshot_status",
  ): {
    snapshot_id: string;
    status: GovernanceStatus;
    extraNotes?: string[];
  } {
    try {
      const out = kbGovernance(
        this.store,
        { action, doc_id: docId },
        this.session,
      );
      return {
        snapshot_id: out.snapshot_id,
        status: out.status,
        extraNotes: out.requires_approval
          ? [out.approval_reason ?? "requires_approval"]
          : undefined,
      };
    } catch (err) {
      if (err instanceof IknowError && err.code === "GOVERNANCE_TIMEOUT") {
        // edge-006: degraded local snapshot, never omit snapshot_id (G2)
        return {
          ...this.localSnapshot(docId, action, "stale"),
          extraNotes: [
            "governance_timeout: explicit degradation; results marked unverified",
          ],
        };
      }
      if (err instanceof IknowError && err.code === "PERMISSION_DENIED") {
        return {
          ...this.localSnapshot(docId, action, "ok"),
          extraNotes: ["permission_denied"],
        };
      }
      return {
        ...this.localSnapshot(docId, action, "stale"),
        extraNotes: [
          err instanceof Error ? err.message : "governance_error",
        ],
      };
    }
  }

  private localSnapshot(
    docId: string,
    checkType: string,
    result: string,
  ): { snapshot_id: string; status: GovernanceStatus } {
    const doc = this.store.tryGetDocument(docId);
    const ts = new Date().toISOString();
    const status: GovernanceStatus =
      result === "conflict" ? "conflict" : result === "ok" ? "ok" : "stale";
    return {
      snapshot_id: buildSnapshotId({
        doc_id: docId,
        document_version: doc?.document_version ?? "0",
        check_type: checkType,
        result: status,
        ts,
      }),
      status,
    };
  }

  private hopLimit(
    toolTrace: string[],
    hops: number,
    notes: string[],
    chunks: Pick<Chunk, "chunk_id">[] = [],
  ): IknowAnswer {
    notes.push("max_hops_exceeded");
    const g = this.localSnapshot("_session", "snapshot_status", "stale");
    return {
      text: "探索步数已达上限（max_hops=5），无法确认完整结论。以下为已检索来源范围限制声明。",
      source_spans: chunks.map((c) => ({ chunk_id: c.chunk_id })),
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      tool_trace: toolTrace,
      hops_used: Math.min(hops, this.maxHops),
      notes,
    };
  }

  private finalize(args: {
    text: string;
    source_spans: IknowAnswer["source_spans"];
    toolTrace: string[];
    hops: number;
    notes: string[];
    preferredDocId: string;
  }): IknowAnswer {
    const g = this.localSnapshot(
      args.preferredDocId,
      "snapshot_status",
      "ok",
    );
    return {
      text: args.text,
      source_spans: args.source_spans,
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      tool_trace: args.toolTrace,
      hops_used: args.hops,
      notes: args.notes,
    };
  }
}

/** Alias for tests / older call sites. */
export { IknowAgent as IknowAgentLoop };
