/* chunk-viz.js — reusable widget: visualize how chunk size affects
   semantic focus vs context loss. Two sliders (chunk size, overlap)
   drive a mock document of sentences; shows which sentence the query
   will likely retrieve. Used by the Chunking lesson (and any later
   lesson that needs the "chunk tradeoff" intuition).
   Mount: <div id="chunkdemo"></div>
          <script src="../assets/chunk-viz.js"></script>
          <script>mountChunkViz('chunkdemo')</script> */
(function () {
  const DOC = [
    "产品支持 7 天无理由退货。",
    "退货需保持商品原包装完整。",
    "退款将在 3 个工作日内原路返回。",
    "会员可享受免运费特权。",
    "会员等级根据年度消费金额计算。",
    "企业客户请联系专属客户经理。",
    "发票可在订单完成后申请开具。",
    "客服工作时间为每日 9:00-21:00。",
  ];
  function mountChunkViz(mountId) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    mount.classList.add("chunk-viz");
    mount.innerHTML = `
<style>
.chunk-viz{max-width:560px;margin:1.4em 0;font-family:inherit}
.cv-controls{display:flex;gap:18px;flex-wrap:wrap;margin:8px 0}
.cv-controls label{font-size:.88em;display:flex;flex-direction:column;gap:4px}
.cv-controls input[type=range]{width:160px}
.cv-doc{margin:.6em 0;line-height:2.2}
.cv-sent{padding:2px 6px;border-radius:5px;transition:background .15s}
.cv-sent.in{border:1px solid var(--accent);background:#f6efe2}
.cv-sent.q{border:1px solid #2e6fb5;background:#e5ecf3}
.cv-readout{font-size:.85em;color:var(--muted);margin:6px 0}
.cv-readout b{color:var(--accent)}
.cv-note{font-size:.78em;color:var(--muted);margin-top:6px}
</style>
<div class="cv-controls">
  <label>Chunk 大小 = <b id="${mountId}-csz">3</b> 句/块
    <input type="range" id="${mountId}-cszr" min="1" max="8" value="3"></label>
  <label>Overlap = <b id="${mountId}-ovl">1</b> 句
    <input type="range" id="${mountId}-ovlr" min="0" max="3" value="1"></label>
</div>
<div class="cv-readout">假设用户查询命中第 <b id="${mountId}-q">3</b> 句 → 该句所属 chunk 会被召回。</div>
<div class="cv-doc" id="${mountId}-doc"></div>
<p class="cv-note">示意：真实系统按 token/字符切，不是按句；此处按句只为直观看到"chunk 包住哪几句话"。</p>`;

    const cszr = document.getElementById(mountId + "-cszr");
    const ovlr = document.getElementById(mountId + "-ovlr");
    const cszEl = document.getElementById(mountId + "-csz");
    const ovlEl = document.getElementById(mountId + "-ovl");
    const docEl = document.getElementById(mountId + "-doc");
    const qEl = document.getElementById(mountId + "-q");

    function render() {
      const size = +cszr.value;
      const ovl = Math.min(+ovlr.value, size - 1);
      cszEl.textContent = size;
      ovlEl.textContent = ovl;
      // build chunks by sliding window (size, overlap)
      const chunks = [];
      let i = 0;
      while (i < DOC.length) {
        chunks.push(DOC.slice(i, i + size));
        if (size - ovl <= 0) break;
        i += size - ovl;
      }
      // query targets sentence index 2 (0-based) — "退款将在3个工作日..."
      const q = 2;
      // find chunk(s) containing q
      let hitChunks = new Set();
      chunks.forEach((c, ci) => {
        const start = chunks.length > 1 ? ci * (size - ovl) : 0;
        // recompute start precisely:
      });
      // precise start positions
      const starts = [];
      let p = 0;
      while (p < DOC.length) {
        starts.push(p);
        p += size - ovl;
      }
      const hit = starts.filter((s) => q >= s && q < s + size);
      const html = DOC.map((s, idx) => {
        const inChunk = hit.some((h) => idx >= h && idx < h + size);
        const cls = inChunk ? "in" : "";
        const qcls = idx === q ? " q" : "";
        return `<span class="cv-sent ${cls}${qcls}" title="句 ${idx + 1}">${s}</span> `;
      }).join("");
      docEl.innerHTML = html;
      const extra = hit.length
        ? hit[0] + size - 1 - (hit[0] + size - 1 < DOC.length ? 0 : 0)
        : 0;
      // readout: how many extra sentences ride along with the answer sentence
      const extraCount = hit.length
        ? Math.min(hit[0] + size, DOC.length) - hit[0] - 1
        : 0;
      qEl.textContent = q + 1;
      const ro = docEl.previousElementSibling;
      ro.innerHTML = `假设用户查询命中第 <b>${q + 1}</b> 句 → 召回的 chunk 还额外带进了 <b>${extraCount}</b> 句无关/相关上下文`;
    }
    cszr.addEventListener("input", render);
    ovlr.addEventListener("input", render);
    render();
  }
  window.mountChunkViz = mountChunkViz;
})();
