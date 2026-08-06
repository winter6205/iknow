import { InMemoryKnowledgeStore } from "../knowledge-store/memory-store.js";
import type { ChunkRecord, DocumentRecord } from "../knowledge-store/types.js";

interface AddDocOpts {
  readonly store: InMemoryKnowledgeStore;
  readonly doc: DocumentRecord;
  readonly chunks: Omit<ChunkRecord, "doc_id">[];
}

function addDoc(opts: AddDocOpts): void {
  const { store, doc, chunks } = opts;
  store.upsertDocument(doc);
  for (const c of chunks) {
    store.upsertChunk({ ...c, doc_id: doc.doc_id });
  }
}

/**
 * Seed enterprise sample KB covering eval-set.draft.json scenarios.
 * Chinese keywords in summary/text are chosen to match eval inputs.
 */
export function seedEnterpriseKb(store: InMemoryKnowledgeStore): void {
  // hard-001: dual refund policies (30d vs 60d conflict)
  addDoc({
    store,
    doc: {
      doc_id: "refund-v2026",
      document_version: "2026.1",
      doc_type: "policy",
      title: "退款政策2026",
      freshness: "fresh",
      sensitivity: "normal",
      effective_at: "2026-03-01",
    },
    chunks: [
      {
        chunk_id: "chunk-refund-30",
        chunk_version: "2026.1@1",
        text: "公司的退款政策：客户可在收货后30天内申请全额退款。自购买之日起30天内可申请全额退款。退款流程走售后工单，财务在5个工作日内打款。",
        summary: "退款政策 30天 全额退款 售后 收货",
        source_ref: "refund-v2026#L1-L3",
        fact_keywords: ["退款", "30天", "全额退款"],
      },
      {
        chunk_id: "chunk-refund-30-flow",
        chunk_version: "2026.1@2",
        text: "售后退款：建单→审核→财务打款。与客户投诉单号关联后触发打款。",
        summary: "售后退款 流程 财务打款",
        source_ref: "refund-v2026#L4",
      },
    ],
  });

  addDoc({
    store,
    doc: {
      doc_id: "refund-alt",
      document_version: "2026.1-alt",
      doc_type: "policy",
      title: "退款政策旧版冲突",
      freshness: "fresh",
      sensitivity: "normal",
      effective_at: "2026-01-15",
    },
    chunks: [
      {
        chunk_id: "chunk-refund-60",
        chunk_version: "2026.1-alt@1",
        text: "文档B：退款期限为收货后60天。该条款与2026.1版存在冲突，治理层应标注 conflict。",
        summary: "退款 60天 冲突 文档B 政策",
        source_ref: "refund-alt#L1",
        fact_keywords: ["退款", "60天"],
      },
    ],
  });

  // easy: onboarding / probation / contract renew
  addDoc({
    store,
    doc: {
      doc_id: "hr-onboarding",
      document_version: "2026.1",
      doc_type: "hr",
      title: "新员工入职指南",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-onboard",
        chunk_version: "2026.1@1",
        text: "新员工入职需要准备：身份证复印件、学历证明、银行卡、体检报告、一寸照片。试用期为3个月。劳动合同到期前30天启动续签流程。",
        summary: "入职 材料 试用期 续签 劳动合同 准备",
        source_ref: "hr-onboarding#L1",
        fact_keywords: ["试用期", "3个月", "入职材料"],
      },
    ],
  });

  // easy: annual leave / overtime / time-off
  addDoc({
    store,
    doc: {
      doc_id: "hr-leave",
      document_version: "2026.2",
      doc_type: "hr",
      title: "年假与调休",
      freshness: "fresh",
      sensitivity: "normal",
      effective_at: "2026-06-01",
    },
    chunks: [
      {
        chunk_id: "chunk-leave",
        chunk_version: "2026.2@1",
        text: "年假天数：工龄满1年不满10年享5天；满10年不满20年10天；满20年15天。调休：加班可申请调休，需主管审批。加班费按劳动法平日1.5倍、休息日2倍、法定3倍计算。",
        summary: "年假 天数 调休 加班费 申请",
        source_ref: "hr-leave#L1",
        fact_keywords: ["年假", "调休", "加班费"],
      },
    ],
  });

  // hard-002: earlier-2026 leave version for diff (stale vs mid-year)
  addDoc({
    store,
    doc: {
      doc_id: "hr-leave-2026-old",
      document_version: "2026.1-old",
      doc_type: "hr",
      title: "2026年1月版员工手册年假",
      freshness: "stale",
      sensitivity: "normal",
      effective_at: "2026-01-10",
    },
    chunks: [
      {
        chunk_id: "chunk-leave-2026-old",
        chunk_version: "2026.1-old@1",
        text: "2026年1月版员工手册：年假统一为带薪年休假最低法定天数，未按工龄分档细化。",
        summary: "2026年1月 年假 员工手册 旧版 差异",
        source_ref: "hr-leave-2026-old#L1",
      },
    ],
  });

  // easy: expense / travel allowance / invoice
  addDoc({
    store,
    doc: {
      doc_id: "fin-expense",
      document_version: "2026.1",
      doc_type: "finance",
      title: "报销与出差",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-expense",
        chunk_version: "2026.1@1",
        text: "报销流程：提交票据→部门经理审批→财务复核→打款。出差补贴：一线城市200元/天，二线150元/天，含餐补不含交通。公司开票信息：名称示例科技有限公司，税号TAX-ID-PLACEHOLDER，开户行EXAMPLE-BANK。",
        summary: "报销 流程 出差 补贴 开票信息",
        source_ref: "fin-expense#L1",
        fact_keywords: ["报销", "出差补贴", "开票"],
      },
    ],
  });

  // hard-004: approval thresholds
  addDoc({
    store,
    doc: {
      doc_id: "fin-approval",
      document_version: "2026.1",
      doc_type: "finance",
      title: "财务审批权限表",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-approval",
        chunk_version: "2026.1@1",
        text: "财务审批权限：5万及以下部门负责人批；5万至50万需财务总监批；50万以上需CEO批。",
        summary: "审批 权限 5万 50万 财务",
        source_ref: "fin-approval#L1",
      },
    ],
  });

  // easy: email reset / VPN / Feishu / warranty / meal card
  addDoc({
    store,
    doc: {
      doc_id: "it-access",
      document_version: "2026.1",
      doc_type: "it",
      title: "邮箱VPN与协作平台",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-it",
        chunk_version: "2026.1@1",
        text: "公司邮箱密码重置：登录SSO门户→忘记密码→短信验证。公司VPN：使用公司客户端连接 vpn.example.invalid，需二次认证。统一办公协作平台为飞书。统一采购笔记本保修期3年。食堂饭卡可在行政前台或APP充值。",
        summary: "邮箱 密码 重置 VPN 飞书 办公协作 保修 饭卡 充值",
        source_ref: "it-access#L1",
      },
    ],
  });

  // easy: physical exam / social insurance
  addDoc({
    store,
    doc: {
      doc_id: "hr-benefits",
      document_version: "2026.1",
      doc_type: "hr",
      title: "体检与社保",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-benefits",
        chunk_version: "2026.1@1",
        text: "员工体检每年一次，入职满6个月可约。社保缴纳记录可在人力资源系统或当地社保APP查询。",
        summary: "体检 每年 社保 缴纳 记录 查询",
        source_ref: "hr-benefits#L1",
      },
    ],
  });

  // easy: NDA template
  addDoc({
    store,
    doc: {
      doc_id: "legal-nda",
      document_version: "2026.1",
      doc_type: "legal",
      title: "保密协议",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-nda",
        chunk_version: "2026.1@1",
        text: "保密协议模板下载：法务门户→模板中心→NDA-标准版.docx。",
        summary: "保密协议 模板 下载",
        source_ref: "legal-nda#L1",
      },
    ],
  });

  // hard-003: complaint + refund SOP
  addDoc({
    store,
    doc: {
      doc_id: "ops-sop",
      document_version: "2026.1",
      doc_type: "ops",
      title: "客诉与售后退款SOP",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-complaint",
        chunk_version: "2026.1@1",
        text: "客户投诉处理：接待→建单→根因→补偿方案→闭环。售后退款流程与投诉单号关联，完成后触发财务打款。",
        summary: "客户投诉 处理 售后退款 SOP 流程",
        source_ref: "ops-sop#L1",
      },
    ],
  });

  // hard-005: retention + deletion
  addDoc({
    store,
    doc: {
      doc_id: "compliance-data",
      document_version: "2026.1",
      doc_type: "compliance",
      title: "数据留存与删除",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-retention",
        chunk_version: "2026.1@1",
        text: "合规：业务数据留存期限一般为3年；到期后走删除流程：申请→法务确认→IT执行硬删除→审计留痕。",
        summary: "数据 留存 期限 删除 流程 合规",
        source_ref: "compliance-data#L1",
      },
    ],
  });

  // hard-006: cross-team tools
  addDoc({
    store,
    doc: {
      doc_id: "pm-tools",
      document_version: "2026.1",
      doc_type: "process",
      title: "跨部门协作工具",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-pm",
        chunk_version: "2026.1@1",
        text: "研发使用Jira，产品使用飞书项目。跨团队协作：需求在飞书立项，任务同步Jira，周会统一状态。",
        summary: "研发 产品 项目管理 协作 工具 跨团队",
        source_ref: "pm-tools#L1",
      },
    ],
  });

  // hard-007: security remediation
  addDoc({
    store,
    doc: {
      doc_id: "sec-incidents",
      document_version: "2026.1",
      doc_type: "security",
      title: "安全事件复盘汇总",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-sec",
        chunk_version: "2026.1@1",
        text: "过去一年安全事件整改项：强制MFA、日志留存180天、第三方SDK清单评审、漏洞SLA 7天。",
        summary: "安全事件 整改项 复盘 汇总 清单",
        source_ref: "sec-incidents#L1",
      },
    ],
  });

  // hard-008: vendor qualification shared docs
  addDoc({
    store,
    doc: {
      doc_id: "procurement",
      document_version: "2026.1",
      doc_type: "finance",
      title: "供应商准入与付款",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-vendor",
        chunk_version: "2026.1@1",
        text: "供应商准入与采购付款共用资质文件：营业执照、银行账户证明、合规声明。准入通过后付款节点复用同一份资质档案。",
        summary: "供应商 准入 付款 资质 采购",
        source_ref: "procurement#L1",
      },
    ],
  });

  // edge-003: revoked/stale policy (dates inside 2026 H1 window)
  addDoc({
    store,
    doc: {
      doc_id: "policy-revoked",
      document_version: "2026.1-revoked",
      doc_type: "policy",
      title: "已作废旧制度",
      freshness: "revoked",
      sensitivity: "normal",
      effective_at: "2026-01-05",
    },
    chunks: [
      {
        chunk_id: "chunk-revoked",
        chunk_version: "2026.1-revoked@1",
        text: "本制度已于2026-03-01作废，不得当作现行有效执行。该制度文档现已失效。",
        summary: "作废制度 失效日期 治理 无效",
        source_ref: "policy-revoked#L1",
      },
    ],
  });

  // edge-001: sensitive customer contacts (requireApprovalFor)
  addDoc({
    store,
    doc: {
      doc_id: "crm-contacts",
      document_version: "2026.1",
      doc_type: "customer-data",
      title: "客户名单与联系方式",
      freshness: "fresh",
      sensitivity: "sensitive",
      requires_approval: true,
    },
    chunks: [
      {
        chunk_id: "chunk-contacts",
        chunk_version: "2026.1@1",
        text: "客户名单（敏感）：示例客户A 电话138****0000。完整客户联系方式导出需审批。",
        summary: "客户名单 联系方式 敏感 完整 项目",
        source_ref: "crm-contacts#L1",
      },
    ],
  });

  // edge-004: competitor external salary (competitor_external sensitivity)
  addDoc({
    store,
    doc: {
      doc_id: "competitor-pay",
      document_version: "2026.1",
      doc_type: "external",
      title: "竞对薪酬结构（外部）",
      freshness: "fresh",
      sensitivity: "competitor_external",
    },
    chunks: [
      {
        chunk_id: "chunk-competitor",
        chunk_version: "2026.1@1",
        text: "竞对公司内部薪酬结构（非本企业知识，禁止对普通员工返回）。",
        summary: "竞对 竞争对手 薪酬 外部 内部",
        source_ref: "competitor-pay#L1",
      },
    ],
  });

  // edge-005: multi-department resolutions (hop pressure)
  addDoc({
    store,
    doc: {
      doc_id: "dept-resolutions",
      document_version: "2026.1",
      doc_type: "process",
      title: "多部门历史决议",
      freshness: "fresh",
      sensitivity: "normal",
    },
    chunks: [
      {
        chunk_id: "chunk-res-1",
        chunk_version: "2026.1@1",
        text: "决议涉及研发、产品、销售、财务、法务、人力、运营、安全八个部门的先后顺序需多跳检索。",
        summary: "多部门 历史决议 流程顺序",
        source_ref: "dept-resolutions#L1",
      },
      {
        chunk_id: "chunk-res-2",
        chunk_version: "2026.1@2",
        text: "顺序约定：法务合规先行，财务预算次之，研发与产品并行，销售落地，人力与运营支撑，安全终审。",
        summary: "部门 决议 先后 顺序",
        source_ref: "dept-resolutions#L2",
      },
    ],
  });
}

/** Create a fresh in-memory store with enterprise seed data. */
export function createSeededStore(): InMemoryKnowledgeStore {
  const store = new InMemoryKnowledgeStore();
  seedEnterpriseKb(store);
  return store;
}

/** Alias used by tests / older call sites. */
export function seedDemoKnowledge(): InMemoryKnowledgeStore {
  return createSeededStore();
}
