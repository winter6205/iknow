// Sliding-window and sentence-split visualizer.
// Mounts into <div id="slideviz">.
// Part A: given text + chunk_size + overlap, show each window with cursor.
// Part B: given text, show where sentence boundaries land.
(function () {
  "use strict";
  var SAMPLE = "退款将在3个工作日内原路返回。会员可享受免运费特权。";
  var SENT_REGEX = /[。？！.!?]/g;

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (m) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m];
    });
  }

  // ── Part A: sliding window ──
  function renderSliding(text, size, overlap) {
    var out = [],
      i = 0;
    while (i < text.length) {
      var end = Math.min(i + size, text.length);
      out.push({ start: i, end: end, text: text.slice(i, end) });
      var next = i + (size - overlap);
      if (next <= i) break;
      i = next;
    }
    return out;
  }

  function drawSliding(fragment, text) {
    var el = document.getElementById("sv-sliding");
    if (!el) return;
    var size = +document.getElementById("sv-size").value || 10;
    var overlap = +document.getElementById("sv-overlap").value || 2;
    if (overlap >= size) overlap = size - 1;
    if (overlap < 0) overlap = 0;
    var chunks = renderSliding(text, size, overlap);
    var html =
      '<p class="rg-note">文本（' +
      text.length +
      "字）：<code>" +
      escapeHtml(text) +
      "</code></p>";
    html +=
      "<p>chunk_size=" +
      size +
      "，overlap=" +
      overlap +
      " —— " +
      chunks.length +
      " 个块</p>";
    html +=
      '<p class="rg-note">公式：<code>下一块起始位置 = 当前起始位置 + (chunk_size − overlap)</code></p>';
    chunks.forEach(function (c, idx) {
      var pre = text.slice(0, c.start);
      var hit = text.slice(c.start, c.end);
      var post = text.slice(c.end);
      html += '<div class="sv-block">';
      html += '<span class="sv-idx">[' + idx + "]</span> ";
      html += '<span class="sv-pre">' + escapeHtml(pre) + "</span>";
      html += '<span class="sv-hit">' + escapeHtml(hit) + "</span>";
      html += '<span class="sv-post">' + escapeHtml(post) + "</span>";
      html +=
        ' <span class="sv-pos">(' + c.start + "–" + (c.end - 1) + "字)</span>";
      html += "</div>";
    });
    el.innerHTML = html;
  }

  // ── Part B: sentence iterator ──
  function drawSentence(text) {
    var el = document.getElementById("sv-sentence");
    if (!el) return;
    // Find all sentence-boundary positions
    var matches = [],
      m;
    var re = new RegExp(SENT_REGEX.source, "g");
    while ((m = re.exec(text)) !== null) matches.push(m.index);

    var html =
      '<p class="rg-note">文本：<code>' + escapeHtml(text) + "</code></p>";
    html += '<div class="sv-ruler">';
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var cls = matches.indexOf(i) >= 0 ? "sv-boundary" : "";
      if (cls) ch += "│";
      html +=
        '<span class="sv-char ' +
        cls +
        '">' +
        (ch === " " ? "&nbsp;" : escapeHtml(ch)) +
        "</span>";
    }
    html += "</div>";
    html +=
      '<p class="rg-note">蓝色高亮位置是句尾标点（。？！!?），正则 <code>(?<=[。？！.!?])\\s*</code> 在这后面切。</p>';

    // Now show the result of splitting
    var parts = text
      .split(SENT_REGEX)
      .filter(Boolean)
      .map(function (s) {
        return s.trim();
      });
    html += "<p>按句切后得到 <strong>" + parts.length + "</strong> 个块：</p>";
    parts.forEach(function (p, i) {
      html +=
        '<div class="sv-block"><span class="sv-idx">[' +
        i +
        "]</span> " +
        escapeHtml(p) +
        "</div>";
    });
    el.innerHTML = html;
  }

  // ── Init ──
  document.addEventListener("DOMContentLoaded", function () {
    var root = document.getElementById("slideviz");
    if (!root) return;
    // Sliding controls
    var sizeIn = document.getElementById("sv-size");
    var overlapIn = document.getElementById("sv-overlap");
    function onSlidingChange() {
      drawSliding(null, SAMPLE);
    }
    sizeIn.addEventListener("input", onSlidingChange);
    overlapIn.addEventListener("input", onSlidingChange);
    // Dropdown presets
    document.getElementById("sv-apply").addEventListener("click", function () {
      drawSliding(null, SAMPLE);
    });
    // Sentence tab
    document
      .getElementById("sv-sent-tab")
      .addEventListener("click", function () {
        document.getElementById("sv-sliding-area").style.display = "none";
        document.getElementById("sv-sent-area").style.display = "block";
        drawSentence(SAMPLE);
      });
    document
      .getElementById("sv-slide-tab")
      .addEventListener("click", function () {
        document.getElementById("sv-sliding-area").style.display = "block";
        document.getElementById("sv-sent-area").style.display = "none";
        drawSliding(null, SAMPLE);
      });
    // Default: sliding
    onSlidingChange();
  });
})();
