// Two-stage RAG pipeline visualizer. Mounts into <div id="ragpipe">.
// Stage A (offline, ingest): you configure the splitter — sentence vs char.
// Stage B (online, retrieve): query -> vector -> cosine vs chunks -> return best.
// The key teaching point: retrieval NEVER reads text; completeness is decided
// offline at split time. Char-overlap is used as a STAND-IN for real embedding
// cosine similarity, clearly labeled as such.
(function () {
  "use strict";
  var DOC =
    "Q: 退款多久到账？A: 退款将在3个工作日内原路返回。Q: 会员有什么特权？A: 会员可享受免运费特权。";

  function splitSentence(text) {
    var parts = text.split(/(?<=[。？！])/);
    return parts
      .map(function (s) {
        return s.trim();
      })
      .filter(function (s) {
        return s.length > 0;
      });
  }
  function splitChar(text, n) {
    var res = [];
    for (var i = 0; i < text.length; i += n) res.push(text.slice(i, i + n));
    return res;
  }
  // Rough similarity stand-in: shared-character ratio (NOT real cosine).
  function score(query, chunk) {
    if (!query) return 0;
    var set = {};
    chunk.split("").forEach(function (c) {
      set[c] = true;
    });
    var hit = 0;
    query.split("").forEach(function (c) {
      if (set[c]) hit++;
    });
    return hit / query.length;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m];
    });
  }
  function chunksFor(mode) {
    return mode === "sent" ? splitSentence(DOC) : splitChar(DOC, 8);
  }

  function render() {
    var root = document.getElementById("ragpipe");
    if (!root) return;
    var mode = root.querySelector('input[name="rg-mode"]:checked').value;
    var chunks = chunksFor(mode);
    var a = root.querySelector("#rg-chunks");
    a.innerHTML = "";
    chunks.forEach(function (c, i) {
      var d = document.createElement("div");
      d.className = "rg-chunk";
      d.dataset.idx = i;
      d.textContent = c;
      a.appendChild(d);
    });
    root.querySelector("#rg-modecap").textContent =
      mode === "sent"
        ? "按句切：切分器只在句号/问号后切 → 每个 chunk 是完整句子。这一步“知道句子”是你给的静态规则（离线一次性）。"
        : "按字符切（每8字）：不管句子边界硬切 → chunk 可能是半截句。这是 Dify/Coze/LangChain 的默认行为。";
    root.querySelector("#rg-result").innerHTML =
      '<p class="rg-hint">点“示例提问”看检索如何工作（不读文字，只算向量）。</p>';
  }

  function query() {
    var root = document.getElementById("ragpipe");
    var mode = root.querySelector('input[name="rg-mode"]:checked').value;
    var chunks = chunksFor(mode);
    var q =
      (root.querySelector("#rg-query").value || "").trim() || "退款几天到？";
    var best = -1,
      bestS = -1;
    chunks.forEach(function (c, i) {
      var s = score(q, c);
      if (s > bestS) {
        bestS = s;
        best = i;
      }
    });
    root.querySelectorAll(".rg-chunk").forEach(function (el) {
      el.classList.remove("rg-hit");
      if (+el.dataset.idx === best) el.classList.add("rg-hit");
    });
    var complete = /\S[。？！]$/.test(chunks[best]);
    root.querySelector("#rg-result").innerHTML =
      '<p class="rg-step">① query 变向量 → ② 和 ' +
      chunks.length +
      " 个 chunk 向量算余弦 → ③ 返回最像的块（高亮）。</p>" +
      '<p class="rg-returned"><b>召回的 chunk：</b>' +
      escapeHtml(chunks[best]) +
      "</p>" +
      '<p class="rg-note">（此处用字重叠近似真实 embedding 余弦，仅作示意。）系统没“读”这个 chunk 的文字，只算向量。' +
      "它完整吗？" +
      (complete
        ? "是 —— 因为离线切分时这一刀落在句末。"
        : "否 —— 它是半截句，因为离线按字符硬切把它腰斩了。") +
      " 完不完整是<b>切分（离线）决定的</b>，检索阶段从不判断。</p>";
  }

  document.addEventListener("DOMContentLoaded", function () {
    var root = document.getElementById("ragpipe");
    if (!root) return;
    root.querySelectorAll('input[name="rg-mode"]').forEach(function (r) {
      r.addEventListener("change", render);
    });
    root.querySelector("#rg-ask").addEventListener("click", query);
    render();
  });
})();
