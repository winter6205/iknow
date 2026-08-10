# minimal_rag.py — 最简 RAG CLI，亲手验证 chunk 大小 / overlap / 重排序对召回的影响
# 教学约定：embedding 用词重叠近似真实余弦；重排序用主题关键字筛选近似 cross-encoder。
# 生产环境替换为：sentence-transformers / OpenAI-Embedding + cross-encoder reranker。
import re, math

# =================== 配置 ===================
CHUNK_SIZE = 15        # 每块字符数（按字符切，模拟 Dify 默认）
OVERLAP    = 3          # 重叠字符数
RERANK_ON  = True       # 是否启用重排序
TOP_K      = 5          # 向量粗召回数
TOP_K_AFTER = 2         # 重排序后最终返回数
# ============================================

# ── 语料 ──
FAQ_CORPUS = """问：退款多久到账？
答：退款将在3个工作日内原路返回。
问：退货需要什么条件？
答：需保持包装完整，吊牌未拆。
问：如何申请退款？
答：联系客服提供订单号即可申请。
问：会员有什么特权？
答：会员可享受免运费特权。
问：运费险怎么理赔？
答：运费险在退款成功后自动理赔。
问：订单号怎么查？
答：在我的订单页面顶部可复制订单号。"""

KEYWORDS = {  # 主题关键词表（模拟 cross-encoder）
    "退款流程": ["退款", "退货", "到账", "返回", "包装", "吊牌", "客服", "订单号", "申请"],
    "会员":     ["会员", "特权", "免运费"],
    "运费险":   ["运费险", "理赔"],
}

# ── 词重叠近似余弦 ──
def vec_sim(q, t):
    s = set(t.lower())
    if not q or not s: return 0
    hits = sum(1 for c in q.lower() if c in s)
    return hits / len(q)

# ── 切分 ──
def chunk_text(text, size, overlap):
    lines = [l for l in text.split('\n') if l.strip()]
    result = []
    for line in lines:
        i = 0
        while i < len(line):
            end = min(i + size, len(line))
            result.append(line[i:end])
            next_start = i + size - overlap
            if next_start <= i: break   # overlap 不小于 size 时死循环保护
            i = next_start
    return result

# ── 检索 ──
def retrieve(query, chunks, top_k):
    scored = [(chunks[i], vec_sim(query, chunks[i]), i) for i in range(len(chunks))]
    scored.sort(key=lambda x: -x[1])
    return scored[:top_k]

# ── 重排序 ──
def guess_topic(query):
    for topic, words in KEYWORDS.items():
        if any(w in query for w in words):
            return topic
    return None

def topic_relevance(chunk, topic):
    if not topic: return 1.0
    words = KEYWORDS.get(topic, [])
    if not words: return 1.0
    hits = sum(1 for w in words if w in chunk)
    return hits / len(words)

def rerank(results, query):
    topic = guess_topic(query)
    detailed = []
    for text, score, idx in results:
        rel = topic_relevance(text, topic)
        adjusted = score * (rel if rel > 0 else 0.2)
        detailed.append((text, score, rel, adjusted, idx))
    detailed.sort(key=lambda x: -x[3])
    return detailed

# ── 打印 ──
def show_results(phase, items, show_cols=2):
    print(f"\n  {'─'*40}")
    print(f"  {phase}")
    print(f"  {'─'*40}")
    for item in items:
        text = item[0]
        score = item[1]
        rest = " · ".join(f"{v:.2f}" for v in item[2:2+show_cols]) if len(item)>3 else ""
        mark = " ◆ 保留" if rest else ""
        print(f"  [{score:.2f}] {text}{'  → adj '+rest if rest else ''}{mark}")

# ── 主流程 ──
def main():
    print(f"\n{'='*50}")
    print(f"  最简 RAG · CHUNK_SIZE={CHUNK_SIZE}  OVERLAP={OVERLAP}  RERANK={'ON' if RERANK_ON else 'OFF'}")
    print(f"{'='*50}")

    chunks = chunk_text(FAQ_CORPUS, CHUNK_SIZE, OVERLAP)
    print(f"\n  文档被切成 {len(chunks)} 个 chunk：")
    for i, c in enumerate(chunks):
        print(f"    [{i}] {repr(c)}")
    print(f"  (注意半截句——字符硬切，不管句子边界)")

    query = "退款流程"
    print(f"\n  查询：{repr(query)}")

    # 阶段① 向量粗召回
    stage1 = retrieve(query, chunks, TOP_K)
    show_results("① 向量粗召回 Top-3", stage1)

    # 阶段② 重排序
    if RERANK_ON:
        stage2 = rerank(stage1, query)
        retained = [(t, s, r, a, i) for t,s,r,a,i in stage2[:TOP_K_AFTER]]
        print(f"\n  判断主题：{guess_topic(query)}")
        show_results("② 重排序精筛（主题匹配 > 0 的保留）", retained, show_cols=2)
    else:
        print("\n  ⚠️ 重排序已关闭——运费险类噪声块不会被过滤")

    print(f"\n  —— 修改 CHUNK_SIZE/OVERLAP/RERANK_ON 再跑一次看变化 ——")

if __name__ == "__main__":
    main()
