// Retrieval-stage visualizer. Mounts into <div id="retviz">.
// Demonstrates WHY naive vector Top-K returns distractors, and how a
// rerank stage fixes it. Cosine is STAND-IN (char-overlap), rerank uses a
// simplified topic-relevance multiplier — both clearly labeled as示意.
(function () {
  "use strict";
  // Demo corpus: a refund FAQ + distractors. topic tags are manually set
  // for teaching (a real reranker learns this, we hardcode it here).
  var CORPUS = [
    { t: "退款需保持包装完整，吊牌未拆。", topic: "退款流程" },
    { t: "退款将在3个工作日内原路返回。", topic: "退款流程" },
    { t: "会员可享受免运费特权。", topic: "会员" },
    { t: "退款请联系客服并提供订单号。", topic: "退款流程" },
    { t: "运费险会在退款成功后自动理赔。", topic: "运费险" },
    { t: "客服团队7x24小时为您服务。", topic: "客服" },
  ];
  var QUERY_TOPIC = "退款流程";

  function overlap(q, s) {
    if (!q) return 0;
    var set = {};
    s.split("").forEach(function (c) {
      set[c] = true;
    });
    var hit = 0;
    q.split("").forEach(function (c) {
      if (set[c]) hit++;
    });
    return hit / q.length;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m];
    });
  }

  function render() {
    var root = document.getElementById("retviz");
    if (!root) return;
    var q =
      (root.querySelector("#rv-query").value || "").trim() || "如何申请退款";
    // Stage 1: vector (coarse) — char-overlap stand-in for cosine.
    var stage1 = CORPUS.map(function (c, i) {
      return { i: i, text: c.t, topic: c.topic, v: overlap(q, c.t) };
    }).sort(function (a, b) {
      return b.v - a.v;
    });
    var top5 = stage1.slice(0, 5);
    var s1 = root.querySelector("#rv-stage1");
    s1.innerHTML = top5
      .map(function (r) {
        return (
          '<div class="rg-chunk"><b>' +
          r.text +
          '</b><br><span class="rv-meta">向量分 ' +
          r.v.toFixed(2) +
          " · 主题 " +
          r.topic +
          "</span></div>"
        );
      })
      .join("");
    // Stage 2: rerank — multiply by topic match (stand-in for cross-encoder).
    var stage2 = top5
      .map(function (r) {
        var adj = r.v * (r.topic === QUERY_TOPIC ? 1 : 0.25);
        return { text: r.text, topic: r.topic, v: r.v, adj: adj };
      })
      .sort(function (a, b) {
        return b.adj - a.adj;
      });
    var top3 = stage2.slice(0, 3);
    var s2 = root.querySelector("#rv-stage2");
    s2.innerHTML = top3
      .map(function (r) {
        var drift =
          r.topic !== QUERY_TOPIC ? " ⚠️被重排序降权（主题不符）" : "";
        return (
          '<div class="rg-chunk rg-hit"><b>' +
          r.text +
          '</b><br><span class="rv-meta">调整后 ' +
          r.adj.toFixed(2) +
          " · 主题 " +
          r.topic +
          drift +
          "</span></div>"
        );
      })
      .join("");
  }

  document.addEventListener("DOMContentLoaded", function () {
    var root = document.getElementById("retviz");
    if (!root) return;
    root.querySelector("#rv-run").addEventListener("click", render);
    render();
  });
})();
