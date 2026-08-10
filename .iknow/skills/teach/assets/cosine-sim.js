/* cosine-sim.js — reusable simulator: drag two 2D vectors, watch
   angle θ and cosine similarity update live. Used by lessons that
   need the "vectors + similarity" intuition (embedding, rerank, hybrid).
   Mount with: <div id="sim"></div>
                <script src="../assets/cosine-sim.js"></script>
                <script>mountCosineSim('sim')</script> */
(function () {
  function mountCosineSim(mountId) {
    const mount = document.getElementById(mountId);
    if (!mount) return;
    mount.classList.add("cosine-sim");
    const O = 160,
      R = 110; // origin + max vector length in svg units
    const svgId = mountId + "-svg";
    mount.innerHTML = `
<style>
.cosine-sim{max-width:420px;margin:1.4em 0;font-family:inherit}
.cs-stage{background:#fff;border:1px solid var(--rule);border-radius:10px;padding:8px}
.cs-stage svg{width:100%;height:auto;display:block;touch-action:none}
.cs-vec{cursor:grab}
.cs-vec:active{cursor:grabbing}
.cs-readout{display:flex;gap:18px;margin:10px 2px;font-size:.92em}
.cs-readout b{color:var(--accent)}
.cs-presets{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.cs-presets button{font:inherit;font-size:.82em;padding:5px 10px;border:1px solid var(--rule);
  background:#f6f3ee;border-radius:6px;cursor:pointer}
.cs-presets button:hover{border-color:var(--accent)}
.cs-note{font-size:.78em;color:var(--muted);margin:6px 2px 0}
</style>
<div class="cs-stage">
  <svg id="${svgId}" viewBox="0 0 320 320">
    <line x1="20" y1="160" x2="300" y2="160" stroke="#e3ded5"/>
    <line x1="160" y1="20" x2="160" y2="300" stroke="#e3ded5"/>
    <line id="${svgId}-a" stroke="#b5482e" stroke-width="3"/>
    <line id="${svgId}-b" stroke="#2e6fb5" stroke-width="3"/>
    <circle id="${svgId}-ah" class="cs-vec" r="8" fill="#b5482e"/>
    <circle id="${svgId}-bh" class="cs-vec" r="8" fill="#2e6fb5"/>
  </svg>
</div>
<div class="cs-readout">
  <div>夹角 θ = <b id="${svgId}-ang">--</b>°</div>
  <div>余弦相似度 = <b id="${svgId}-cos">--</b></div>
</div>
<div class="cs-presets">
  <button data-a="0.92,0.39" data-b="0.85,0.52">猫 ↔ 狗（高相似）</button>
  <button data-a="0.92,0.39" data-b="-0.35,0.94">猫 ↔ 汽车（低相似）</button>
  <button data-a="0.92,0.39" data-b="0.92,0.39">完全相同</button>
  <button data-a="0.92,0.39" data-b="-0.92,-0.39">几乎相反</button>
</div>
<p class="cs-note">示意向量，仅用于理解几何关系，非真实 embedding 数值。</p>`;

    const svg = document.getElementById(svgId);
    const aLine = document.getElementById(svgId + "-a");
    const bLine = document.getElementById(svgId + "-b");
    const aH = document.getElementById(svgId + "-ah");
    const bH = document.getElementById(svgId + "-bh");
    const angEl = document.getElementById(svgId + "-ang");
    const cosEl = document.getElementById(svgId + "-cos");

    // vector stored as unit-ish {x,y} from origin; rendered scaled by R
    let va = { x: 0.92, y: 0.39 };
    let vb = { x: 0.85, y: 0.52 };

    function render() {
      aLine.setAttribute("x1", O);
      aLine.setAttribute("y1", O);
      aLine.setAttribute("x2", O + va.x * R);
      aLine.setAttribute("y2", O - va.y * R);
      aH.setAttribute("cx", O + va.x * R);
      aH.setAttribute("cy", O - va.y * R);
      bLine.setAttribute("x1", O);
      bLine.setAttribute("y1", O);
      bLine.setAttribute("x2", O + vb.x * R);
      bLine.setAttribute("y2", O - vb.y * R);
      bH.setAttribute("cx", O + vb.x * R);
      bH.setAttribute("cy", O - vb.y * R);
      const dot = va.x * vb.x + va.y * vb.y;
      const ma = Math.hypot(va.x, va.y),
        mb = Math.hypot(vb.x, vb.y);
      let cos = ma && mb ? dot / (ma * mb) : 0;
      cos = Math.max(-1, Math.min(1, cos));
      const deg = (Math.acos(cos) * 180) / Math.PI;
      angEl.textContent = deg.toFixed(0);
      cosEl.textContent = cos.toFixed(3);
    }

    function svgPoint(evt) {
      const pt = svg.createSVGPoint();
      const src = evt.touches ? evt.touches[0] : evt;
      pt.x = src.clientX;
      pt.y = src.clientY;
      return pt.matrixTransform(svg.getScreenCTM().inverse());
    }
    function drag(which) {
      return function (evt) {
        evt.preventDefault();
        const p = svgPoint(evt);
        let x = (p.x - O) / R,
          y = (O - p.y) / R;
        const len = Math.hypot(x, y) || 1;
        x /= len;
        y /= len; // normalize so only direction (angle) matters
        if (which === "a") va = { x, y };
        else vb = { x, y };
        render();
      };
    }
    function endDrag() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", endDrag);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", endDrag);
    }
    let onMove = null;
    function start(which) {
      return function (evt) {
        evt.preventDefault();
        onMove = drag(which);
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", endDrag);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", endDrag);
      };
    }
    aH.addEventListener("mousedown", start("a"));
    bH.addEventListener("mousedown", start("b"));
    aH.addEventListener("touchstart", start("a"), { passive: false });
    bH.addEventListener("touchstart", start("b"), { passive: false });

    mount.querySelectorAll(".cs-presets button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const a = btn.dataset.a.split(",").map(Number);
        const b = btn.dataset.b.split(",").map(Number);
        va = { x: a[0], y: a[1] };
        vb = { x: b[0], y: b[1] };
        render();
      });
    });

    render();
  }
  window.mountCosineSim = mountCosineSim;
})();
