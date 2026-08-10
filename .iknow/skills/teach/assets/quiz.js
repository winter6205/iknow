// Reusable MC quiz widget. Renders nothing on its own; the lesson supplies
// markup. Each .q block: options are <button class="q-opt" data-correct="1">,
// a .q-check button reveals feedback from data-feedback on the .q block.
(function () {
  "use strict";
  function initQuiz(root) {
    root.querySelectorAll(".q").forEach(function (q) {
      var btn = q.querySelector(".q-check");
      var opts = q.querySelectorAll(".q-opt");
      if (!btn) return;
      btn.addEventListener("click", function () {
        opts.forEach(function (o) {
          o.classList.add("answered");
          if (o.dataset.correct === "1") o.classList.add("correct");
          else o.classList.add("wrong");
        });
        var fb = q.querySelector(".q-fb");
        if (fb) {
          fb.textContent = q.dataset.feedback || "";
          fb.style.display = "block";
        }
        btn.disabled = true;
      });
    });
  }
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll(".quiz").forEach(initQuiz);
  });
})();
