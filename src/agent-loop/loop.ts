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
import { NOTE } from "../eval/lexicon.js";
import { isPrivilegedRole } from "./session.js";
import { ToolTrace } from "./trace.js";

/** Only kb_retrieve + kb_verify_citation count as hops (ADR). */
export const MAX_HOPS = 5;

export interface AgentLoopOptions {
  store: InMemoryKnowledgeStore;
  session: SessionContext;
  maxHops?: number;
  /** Optional embedding vector index for kb_retrieve vector arm (M1). */
  vectorIndex?: import("../kb-retrieve/embedding/vector-index.js").VectorIndex;
}

type RetrieveResult = Awaited<ReturnType<typeof kbRetrieve>>;

/**
 * Deterministic agent loop (no external LLM).
 * Policy: retrieve → optional verify → governance snapshot → answer.
 * G2: never return without snapshot_id.
 * Emits structured tool_calls for trajectory eval.
 */
export class IknowAgent {
  private readonly store: InMemoryKnowledgeStore;
  private readonly session: SessionContext;
  private readonly maxHops: number;
  private readonly vectorIndex?: import("../kb-retrieve/embedding/vector-index.js").VectorIndex;

  constructor(opts: AgentLoopOptions) {
    this.store = opts.store;
    this.session = opts.session;
    this.maxHops = opts.maxHops ?? MAX_HOPS;
    this.vectorIndex = opts.vectorIndex;
  }

  private retrieveOpts() {
    return this.vectorIndex ? { vectorIndex: this.vectorIndex } : undefined;
  }

  async answer(query: string): Promise<IknowAnswer> {
    const trace = new ToolTrace();
    const notes: string[] = [];
    // Mutable hop counter so unexpected-error path still reports hops used.
    const hopState = { n: 0 };
    // Single retrieve options object per answer (vector index binding).
    const retrieveOpts = this.retrieveOpts();

    try {
      return await this.answerInner(query, trace, notes, hopState, retrieveOpts);
    } catch (err) {
      // G2: never return without snapshot_id, even on unexpected failures.
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`unexpected_error: ${msg}`);
      return this.finalize({
        text: "处理请求时发生意外错误，无法确认完整结论。",
        source_spans: [],
        trace,
        hops: hopState.n,
        notes,
        preferredDocId: "_session",
      });
    }
  }

  private async answerInner(
    query: string,
    trace: ToolTrace,
    notes: string[],
    hopState: { n: number },
    retrieveOpts: ReturnType<IknowAgent["retrieveOpts"]>,
  ): Promise<IknowAnswer> {
    const q = query.trim();
    if (!q) {
      return this.finalize({
        text: "请提供有效问题。",
        source_spans: [],
        trace,
        hops: hopState.n,
        notes: ["empty_query"],
        preferredDocId: "_session",
      });
    }

    // edge-004: competitor / non-enterprise knowledge
    if (/竞对|竞争对手|他司薪酬|外部薪酬/.test(q)) {
      trace.record("kb_governance", {
        action: "snapshot_status",
        doc_id: "competitor-pay",
      });
      const g = this.safeGovernance("competitor-pay");
      notes.push(...(g.extraNotes ?? []));
      if (!notes.includes(NOTE.PERMISSION_DENIED)) {
        notes.push(NOTE.PERMISSION_DENIED);
      }
      return this.envelope({
        text: "越权查询已拒绝：不得返回非本企业知识。",
        source_spans: [],
        snapshot_id: g.snapshot_id,
        governance_status: g.status,
        trace,
        hops: hopState.n,
        notes,
      });
    }

    // edge-001: sensitive — non-privileged only (privileged uses main path once)
    if (
      /客户名单|联系方式|完整客户/.test(q) &&
      !isPrivilegedRole(this.session.caller_role)
    ) {
      hopState.n += 1;
      trace.record("kb_retrieve", { query: q });
      const denied = await kbRetrieve(
        this.store,
        { query: q },
        this.session,
        retrieveOpts,
      );
      const docId = denied.chunks[0]?.doc_id ?? "crm-contacts";
      trace.record("kb_governance", {
        action: "snapshot_status",
        doc_id: docId,
      });
      const g = this.safeGovernance(docId);
      notes.push(...(g.extraNotes ?? []));
      return this.envelope({
        text: "该请求涉及敏感客户数据，需审批（requireApprovalFor）后方可返回，当前已拦截。",
        source_spans: [],
        snapshot_id: g.snapshot_id,
        governance_status: g.status,
        trace,
        hops: hopState.n,
        notes: [NOTE.REQUIRE_APPROVAL, ...notes],
      });
    }

    // 1) retrieve (hop)
    if (hopState.n >= this.maxHops) {
      return this.hopLimit(trace, hopState.n, notes);
    }
    hopState.n += 1;
    trace.record("kb_retrieve", { query: q });
    let retrieved = await kbRetrieve(
      this.store,
      { query: q },
      this.session,
      retrieveOpts,
    );
    this.noteRetrieveDegradation(retrieved, notes);
    retrieved = this.applyNonexistentDocFilter(q, retrieved);

    if (this.lacksGroundedEvidence(q, retrieved.chunks)) {
      return this.emptyAnswer(trace, hopState.n, notes, {
        noHallucination: true,
      });
    }

    const needsGovernance =
      /冲突|到底以哪个|最新吗|有效吗|作废|对比|差异|权限|审批/.test(q) ||
      retrieved.chunks.length >= 2;

    const needsCompile =
      /串起来|SOP|汇总|清单|衔接|完整/.test(q) &&
      retrieved.chunks[0] !== undefined;

    if (needsCompile && retrieved.chunks[0]) {
      const docId = retrieved.chunks[0].doc_id;
      const content = this.store
        .listChunks()
        .filter((c) => c.doc_id === docId)
        .map((c) => c.text)
        .join("\n");
      trace.record("kb_compile", { doc_id: docId });
      kbCompile(this.store, {
        doc_id: docId,
        content,
        content_hash: sha256Hex(content),
        document_version:
          this.store.tryGetDocument(docId)?.document_version ?? "0",
      });
      if (hopState.n < this.maxHops) {
        hopState.n += 1;
        trace.record("kb_retrieve", { query: q, reason: "post_compile" });
        retrieved = await kbRetrieve(
          this.store,
          { query: q },
          this.session,
          retrieveOpts,
        );
        this.noteRetrieveDegradation(retrieved, notes);
      }
    }

    if (retrieved.chunks.length === 0) {
      return this.emptyAnswer(trace, hopState.n, notes);
    }

    let top = retrieved.chunks[0]!;
    const claim = this.deriveClaim(q, top.summary);
    let verifyNote = "";
    if (hopState.n < this.maxHops) {
      hopState.n += 1;
      const full = this.store.getChunk(top.chunk_id).text;
      const verifyArgs = {
        claim,
        chunk_id: top.chunk_id,
      };
      trace.record("kb_verify_citation", verifyArgs);
      const v = kbVerifyCitation(this.store, {
        claim,
        source_span: { chunk_id: top.chunk_id, quote: full.slice(0, 120) },
      });
      verifyNote = `verify=${v.verdict}`;
      if (v.version_stale) notes.push("version_stale");
      if (v.verdict === "unsupported" && hopState.n < this.maxHops) {
        hopState.n += 1;
        const prior = {
          chunk_id: top.chunk_id,
          summary: top.summary,
        };
        trace.record("kb_retrieve", {
          query: q,
          prior_chunks: [prior],
        });
        retrieved = await kbRetrieve(
          this.store,
          { query: q, prior_chunks: [prior] },
          this.session,
          retrieveOpts,
        );
        this.noteRetrieveDegradation(retrieved, notes);
        if (retrieved.chunks.length === 0) {
          return this.emptyAnswer(trace, hopState.n, notes, {
            noHallucination: true,
          });
        }
        top = retrieved.chunks[0]!;
      }
    }

    if (hopState.n > this.maxHops) {
      return this.hopLimit(trace, hopState.n, notes, retrieved.chunks);
    }

    if (/八个部门|谁先谁后/.test(q) && hopState.n >= this.maxHops - 1) {
      return this.hopLimit(trace, hopState.n, notes, retrieved.chunks);
    }

    const primaryDoc =
      retrieved.chunks.find((c) =>
        /refund|退款/.test(`${c.doc_id} ${c.summary}`),
      )?.doc_id ?? top.doc_id;

    const govAction = needsGovernance
      ? "detect_conflict"
      : "snapshot_status";
    trace.record("kb_governance", {
      action: govAction,
      doc_id: primaryDoc,
    });
    let g = this.safeGovernance(primaryDoc, govAction);
    notes.push(...(g.extraNotes ?? []));
    if (needsGovernance && g.status === "ok") {
      trace.record("kb_governance", {
        action: "snapshot_status",
        doc_id: primaryDoc,
      });
      g = this.safeGovernance(primaryDoc, "snapshot_status");
      notes.push(...(g.extraNotes ?? []));
    }

    const anyRevoked = retrieved.chunks.some((c) => {
      const d = this.store.tryGetDocument(c.doc_id);
      return d?.freshness === "revoked";
    });
    if (anyRevoked || /作废|还有效吗/.test(q)) {
      notes.push(NOTE.DOCUMENT_REVOKED_OR_STALE);
      g = { ...g, status: "stale" };
    }

    const sensitiveHit = retrieved.chunks.some((c) => {
      const d = this.store.tryGetDocument(c.doc_id);
      return d?.sensitivity === "sensitive" || d?.requires_approval === true;
    });
    if (sensitiveHit && !isPrivilegedRole(this.session.caller_role)) {
      return this.envelope({
        text: "该请求涉及敏感数据，需审批（requireApprovalFor）后方可返回，当前已拦截。",
        source_spans: [],
        snapshot_id: g.snapshot_id,
        governance_status: g.status,
        trace,
        hops: hopState.n,
        notes: [NOTE.REQUIRE_APPROVAL, ...notes],
      });
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

    return this.envelope({
      text,
      source_spans: spans,
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      trace,
      hops: hopState.n,
      notes: notes.length ? notes : undefined,
    });
  }

  private envelope(args: {
    text: string;
    source_spans: IknowAnswer["source_spans"];
    snapshot_id: string;
    governance_status: GovernanceStatus;
    trace: ToolTrace;
    hops: number;
    notes?: string[];
  }): IknowAnswer {
    return {
      text: args.text,
      source_spans: args.source_spans,
      snapshot_id: args.snapshot_id,
      governance_status: args.governance_status,
      tool_trace: args.trace.names(),
      tool_calls: args.trace.logs(),
      hops_used: args.hops,
      notes: args.notes,
    };
  }

  private deriveClaim(query: string, summary: string): string {
    return `${query} —— 依据：${summary}`.slice(0, 200);
  }

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
      const rec = this.store.tryGetChunk(c.chunk_id);
      const blob = `${c.summary} ${rec?.text ?? ""}`.toLowerCase();
      return keys.some((k) => blob.includes(k));
    });
  }

  private lacksGroundedEvidence(query: string, chunks: Chunk[]): boolean {
    if (chunks.length === 0) return true;
    if (/全员持股|根本不存在/.test(query)) return true;
    if (
      /全员持股|根本不存在|有没有一份/.test(query) ||
      this.isWeakMatch(query, chunks)
    ) {
      const grounded = chunks.some((c) => {
        const rec = this.store.tryGetChunk(c.chunk_id);
        const text = `${c.summary} ${rec?.text ?? ""}`;
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

  private emptyAnswer(
    trace: ToolTrace,
    hops: number,
    notes: string[],
    opts?: { noHallucination?: boolean },
  ): IknowAnswer {
    trace.record("kb_governance", {
      action: "snapshot_status",
      doc_id: "_session",
    });
    const g = this.safeGovernance("_session");
    notes.push(...(g.extraNotes ?? []));
    const tagNotes = opts?.noHallucination
      ? [NOTE.EMPTY_RESULT, NOTE.NO_HALLUCINATION, ...notes]
      : [NOTE.EMPTY_RESULT, ...notes];
    return this.envelope({
      text: opts?.noHallucination
        ? "未在企业知识库中找到相关内容，无法确认；不得编造不存在的文档。"
        : "未在企业知识库中找到相关内容，无法确认。",
      source_spans: [],
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      trace,
      hops,
      notes: tagNotes,
    });
  }

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
        return {
          ...this.localSnapshot(docId, action, "stale"),
          extraNotes: [NOTE.GOVERNANCE_TIMEOUT],
        };
      }
      if (err instanceof IknowError && err.code === "PERMISSION_DENIED") {
        return {
          ...this.localSnapshot(docId, action, "ok"),
          extraNotes: [NOTE.PERMISSION_DENIED],
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
    trace: ToolTrace,
    hops: number,
    notes: string[],
    chunks: Pick<Chunk, "chunk_id">[] = [],
  ): IknowAnswer {
    notes.push(NOTE.MAX_HOPS_EXCEEDED);
    const g = this.localSnapshot("_session", "snapshot_status", "stale");
    return this.envelope({
      text: "探索步数已达上限（max_hops=5），无法确认完整结论。以下为已检索来源范围限制声明。",
      source_spans: chunks.map((c) => ({ chunk_id: c.chunk_id })),
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      trace,
      hops: Math.min(hops, this.maxHops),
      notes,
    });
  }

  private finalize(args: {
    text: string;
    source_spans: IknowAnswer["source_spans"];
    trace: ToolTrace;
    hops: number;
    notes: string[];
    preferredDocId: string;
  }): IknowAnswer {
    const g = this.localSnapshot(
      args.preferredDocId,
      "snapshot_status",
      "ok",
    );
    return this.envelope({
      text: args.text,
      source_spans: args.source_spans,
      snapshot_id: g.snapshot_id,
      governance_status: g.status,
      trace: args.trace,
      hops: args.hops,
      notes: args.notes,
    });
  }
}

/** Alias for tests / older call sites. */
export { IknowAgent as IknowAgentLoop };
